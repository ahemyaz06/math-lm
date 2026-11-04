"""Loopback-only image/PDF interface; inference and document files stay local."""
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
import json
import os
import re
import secrets
import threading
import webbrowser
from urllib.parse import unquote

from detector import OCR
from reader import read_graph
from pdf_jobs import PdfJobs
from pdf_inspector import dependencies_available, MAX_PDF_BYTES
from settings import AppSettings, data_directory
from local_lock import FileLock, LockBusy

ROOT = Path(__file__).parent
VERSION = '0.7.0'
TOKEN = secrets.token_urlsafe(24)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, status, data, mime='application/json'):
        self.send_response(status)
        for name, value in {
            'Content-Type': mime, 'Content-Length': str(len(data)), 'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'self'; img-src 'self' blob:; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'",
        }.items():
            self.send_header(name, value)
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def error(self, status, message):
        self.send(status, json.dumps({'error': message}).encode())

    def valid_host(self):
        return self.headers.get('Host') == f'127.0.0.1:{self.server.server_port}'

    def authorized(self, require_origin=False):
        origin = f'http://127.0.0.1:{self.server.server_port}'
        return (self.valid_host() and self.headers.get('X-Local-Token') == TOKEN
                and (self.headers.get('Origin') == origin if require_origin else self.headers.get('Origin') in (None, origin)))

    def do_GET(self):
        if not self.valid_host():
            return self.error(403, 'Local page authorization required.')
        if self.path == '/token':
            return self.send(200, json.dumps({'token': TOKEN}).encode())
        if self.path == '/health':
            from vlm_helper import is_vlm_installed
            from layout_detector import available
            return self.send(200, json.dumps({'app': 'recognition-lab', 'version': VERSION,
                'vlm_installed': is_vlm_installed(), 'pdf_available': dependencies_available(), 'layout_available': available()}).encode())
        if self.path in ('/settings','/pdf-jobs'):
            if not self.authorized():return self.error(403,'Local page authorization required.')
            value=self.server.settings.snapshot() if self.path=='/settings' else self.server.pdf_jobs.history()
            return self.send(200,json.dumps(value).encode())
        report=re.fullmatch(r'/pdf-jobs/([a-f0-9]{32})/report\.html',self.path)
        if report:
            if not self.authorized():return self.error(403,'Local page authorization required.')
            try:return self.send(200,self.server.pdf_jobs.report(report[1]),'text/html; charset=utf-8')
            except KeyError as exc:return self.error(404,str(exc))
        match = re.fullmatch(r'/pdf-jobs/([a-f0-9]{32})(?:/graphs/([1-9][0-9]*)\.(json|png))?', self.path)
        if match:
            if not self.authorized():
                return self.error(403, 'Local page authorization required.')
            try:
                jid, gid, kind = match.groups()
                if gid:
                    return self.send(200, self.server.pdf_jobs.asset(jid, int(gid), kind), 'image/png' if kind == 'png' else 'application/json')
                return self.send(200, json.dumps(self.server.pdf_jobs.status(jid)).encode())
            except KeyError as exc:
                return self.error(404, str(exc))
        files = {'/': ('index.html', 'text/html; charset=utf-8'), '/app.js': ('app.js', 'text/javascript; charset=utf-8'),
                 '/pdf.js': ('pdf.js', 'text/javascript; charset=utf-8'), '/style.css': ('style.css', 'text/css; charset=utf-8')}
        if self.path not in files:
            return self.error(404, 'Not found.')
        name, mime = files[self.path]
        self.send(200, (ROOT/'web'/name).read_bytes(), mime)

    def body(self, limit):
        self.connection.settimeout(45)
        try:
            size = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            raise ValueError('Invalid upload size.')
        if size <= 0:
            raise ValueError('This file is empty (0 bytes). Choose another file.')
        if size > limit:
            raise ValueError(f'Choose a file up to {limit//(1024*1024)} MB.')
        raw = self.rfile.read(size)
        if len(raw) != size:
            raise ValueError('Upload was interrupted. Choose the file again.')
        return raw

    def do_POST(self):
        if not self.authorized(require_origin=True):
            return self.error(403, 'Local page authorization required.')
        if self.path=='/settings':
            if self.server.pdf_jobs.active():return self.error(409,'Wait for PDF processing to finish or cancel it before changing Settings.')
            try:
                values=json.loads(self.body(4096).decode('utf-8'))
                return self.send(200,json.dumps(self.server.settings.update(values)).encode())
            except (ValueError,UnicodeError) as exc:return self.error(400,str(exc))
            except OSError:return self.error(500,'Settings could not be saved. Your previous settings are unchanged.')
        resume=re.fullmatch(r'/pdf-jobs/([a-f0-9]{32})/resume',self.path)
        if resume:
            if not self.server.reader_lock.acquire(blocking=False):return self.error(409,'Wait for the current reading to finish.')
            # Release the lock before replying: a client may send its next
            # request the moment it reads this response.
            try:outcome=(202,{'id':self.server.pdf_jobs.resume(resume[1])})
            except KeyError as exc:outcome=(404,{'error':str(exc)})
            except ValueError as exc:outcome=(400,{'error':str(exc)})
            except RuntimeError as exc:outcome=(409,{'error':str(exc)})
            finally:self.server.reader_lock.release()
            return self.send(outcome[0],json.dumps(outcome[1]).encode())
        cancel = re.fullmatch(r'/pdf-jobs/([a-f0-9]{32})/cancel', self.path)
        if cancel:
            try:
                return self.send(200, json.dumps(self.server.pdf_jobs.cancel(cancel[1])).encode())
            except KeyError as exc:
                return self.error(404, str(exc))
        if self.path == '/stop':
            self.server.pdf_jobs.close()
            try:
                from vlm_helper import stop_vlm_server
                stop_vlm_server()
            except Exception:
                pass
            self.send(200, b'{"stopped":true}')
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        if self.path not in ('/detect', '/vlm', '/pdf-jobs','/pdf-inspect'):
            return self.error(404, 'Not found.')
        if not self.server.reader_lock.acquire(blocking=False):
            return self.error(409, 'Another image is being read. Wait before starting another inspection.')
        # The response is sent only after the lock is released. Replying while
        # still holding it let a fast follow-up request (for example the page
        # asking for an AI description right after a reading) get a false 409.
        try:
            status, payload, mime = self._locked_post()
        finally:
            self.server.reader_lock.release()
        self.send(status, payload, mime)

    def _locked_post(self):
        def failure(status, message):
            return status, json.dumps({'error': message}).encode(), 'application/json'
        raw = b''
        try:
            if self.server.pdf_jobs.active() and self.path!='/pdf-inspect':
                return failure(409, 'A PDF is processing. Cancel it or wait before starting another inspection.')
            if self.path in ('/pdf-jobs','/pdf-inspect'):
                settings=self.server.settings.snapshot()
                max_bytes=settings['upload_limit_mb']*1024*1024
                raw = self.body(max_bytes)
                try:
                    first = int(self.headers.get('X-PDF-First-Page', '1'))
                    last = self.headers.get('X-PDF-Last-Page', '')
                    last=int(last) if last else None
                except ValueError:
                    raise ValueError('Page numbers must be whole numbers, such as 1 or 25.') from None
                if self.path=='/pdf-inspect':
                    plan=self.server.pdf_jobs.inspect(raw,first,last,settings['batch_pages'],max_bytes)
                    return 200, json.dumps(plan).encode(), 'application/json'
                jid = self.server.pdf_jobs.submit(raw, first, last, self.headers.get('X-Use-VLM') == '1', self.headers.get('X-PDF-Quality', 'accurate'),
                    batch_pages=settings['batch_pages'],max_bytes=max_bytes,name=unquote(self.headers.get('X-PDF-Name','PDF')))
                return 202, json.dumps({'id': jid}).encode(), 'application/json'
            raw = self.body(10*1024*1024)
            if self.path == '/vlm':
                from vlm_helper import query_vlm
                result = query_vlm(raw, custom_prompt=self.headers.get('X-VLM-Prompt') or None)
            else:
                result = read_graph(raw, self.server.ocr, use_vlm=self.headers.get('X-Use-VLM') == '1')
            return 200, json.dumps(result).encode(), 'application/json'
        except ValueError as exc:
            return failure(400, str(exc))
        except RuntimeError as exc:
            return failure(409, str(exc))
        except Exception:
            if self.path in ('/detect','/vlm') and raw:
                if b'%PDF-' in raw[:1024]:
                    return failure(400, 'This is a PDF. Choose PDF as the file type to read it.')
                from pdf_jobs import describe_file_type
                kind=describe_file_type(raw)
                return failure(400, f'Could not read this file as an image{f" (it looks like {kind})" if kind else ""}. Choose a PNG or JPEG picture of a graph.')
            return failure(400, 'Could not inspect this file. Choose a valid supported PDF, PNG, or JPEG.')


class LocalServer(ThreadingHTTPServer):
    def server_close(self):
        try:super().server_close()
        finally:
            if getattr(self,'library_lock',None):self.library_lock.release();self.library_lock=None


def create_server(port=0, ocr=None, data_dir=None):
    root=Path(data_dir) if data_dir is not None else data_directory()
    library_lock=FileLock(root/'library.lock').acquire()
    server=None
    try:
        server = LocalServer(('127.0.0.1', port), Handler)
        server.library_lock=library_lock;server.data_dir=root;server.daemon_threads=True
        server.ocr=ocr or OCR();server.reader_lock=threading.Lock()
        server.settings=AppSettings(root);server.pdf_jobs=PdfJobs(root/'documents')
        return server
    except Exception:
        if server:server.server_close()
        else:library_lock.release()
        raise


if __name__ == '__main__':
    try:server = create_server(int(os.environ.get('PORT', '0')))
    except LockBusy:
        # A second launch should reuse the running local app and its library.
        import urllib.request
        try:
            info=json.loads((data_directory()/'server.json').read_text(encoding='utf-8'))
            url=info['url']
            if not re.fullmatch(r'http://127\.0\.0\.1:[1-9][0-9]{0,4}/',url):raise ValueError('Invalid local URL')
            with urllib.request.urlopen(url+'health',timeout=2) as response:
                health=json.load(response)
            if health.get('app')!='recognition-lab':raise ValueError('Different local application')
            print(url,flush=True)
            if '--open' in __import__('sys').argv:webbrowser.open(url)
            raise SystemExit(0)
        except (OSError,ValueError,KeyError):
            raise SystemExit('Recognition Lab is already using this saved library. Use its existing window or wait for it to close.')
    url = f'http://127.0.0.1:{server.server_port}/'
    print(url, flush=True)
    from pdf_worker import write_json
    write_json(server.data_dir/'server.json',{'url':url})
    if '--open' in __import__('sys').argv:
        threading.Timer(.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.pdf_jobs.close()
        server.server_close()
