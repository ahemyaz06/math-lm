"""Math Notebook local web server. Serves the page and reads PDFs on this computer only."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import mimetypes
import os
import sys
import urllib.parse
import webbrowser

import attachments
import braille
import notebook_core as core
import settings as app_settings
import spelling

WEB = core.ROOT / 'web'
SOUND = core.ROOT.parent / 'sound-lab' / 'public'
PORT = int(os.environ.get('MATH_NOTEBOOK_PORT', '4190'))
def _library():
    """The folder whose PDFs the start page lists: MATH_NOTEBOOK_LIBRARY, or "pdf_folder" in
    ../local-paths.json (this computer's own, not shared), or Documents\\Math Notebook PDFs."""
    if os.environ.get('MATH_NOTEBOOK_LIBRARY'):
        return Path(os.environ['MATH_NOTEBOOK_LIBRARY'])
    try:
        folder = json.loads((core.ROOT.parent / 'local-paths.json').read_text(encoding='utf-8')).get('pdf_folder')
        if isinstance(folder, str) and folder:
            return Path(folder)
    except (OSError, ValueError, AttributeError):
        pass
    return Path.home() / 'Documents' / 'Math Notebook PDFs'


LIBRARY = _library()
MAX_UPLOAD = 100 * 1024 * 1024
mimetypes.add_type('text/javascript', '.mjs')
mimetypes.add_type('font/woff2', '.woff2')


def installed_models():
    """Reading models whose files are on this computer, plus the ones already chosen."""
    if not app_settings.AI:
        return []  # the AI add-on is not installed
    try:
        import vlm_helper
        names = [name for name in vlm_helper.PROFILES if vlm_helper.is_vlm_installed(name)]
    except Exception:
        names = []
    s = app_settings.load()
    return list(dict.fromkeys(names + [s['reading_model']] + ([s['second_model']] if s['second_model'] else [])))


def settings_payload():
    return {'values': app_settings.load(), 'defaults': app_settings.defaults(), 'models': installed_models(),
            'ai': app_settings.ai_enabled(), 'ai_installed': app_settings.AI}


class Handler(BaseHTTPRequestHandler):
    server_version = 'MathNotebook/0.1'

    def log_message(self, fmt, *args):
        pass

    # Only this computer's own pages may talk to the server.
    def _allowed(self):
        port = self.server.server_address[1]
        hosts = {f'127.0.0.1:{port}', f'localhost:{port}'}
        if self.headers.get('Host') not in hosts:
            return False
        origin = self.headers.get('Origin')
        return origin is None or origin in {f'http://{h}' for h in hosts}

    def _send(self, code, body, kind='application/json; charset=utf-8'):
        data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(data)

    def _error(self, code, message):
        self._send(code, {'error': message})

    def do_GET(self):
        if not self._allowed():
            return self._error(403, 'Not allowed.')
        url = urllib.parse.urlparse(self.path)
        parts = [p for p in url.path.split('/') if p]
        try:
            if parts[:1] == ['api']:
                return self._api_get(parts[1:])
            return self._static(url.path)
        except (ValueError, FileNotFoundError) as exc:
            return self._error(404, str(exc) or 'Not found.')

    def _static(self, path):
        # Sound Lab's engine and math are shared, not copied: /sound/ is its public folder.
        base, rest = (SOUND, path[len('/sound/'):]) if path.startswith('/sound/') else (WEB, path.lstrip('/'))
        target = (base / ('index.html' if path in ('', '/') else rest)).resolve()
        if base.resolve() not in target.parents:
            raise FileNotFoundError('Not found.')
        if not target.is_file():
            raise FileNotFoundError('Not found.')
        kind = mimetypes.guess_type(target.name)[0] or 'application/octet-stream'
        if kind.startswith('text/'):
            kind += '; charset=utf-8'
        self._send(200, target.read_bytes(), kind)

    def _api_get(self, parts):
        if parts == ['settings']:
            return self._send(200, settings_payload())
        if parts == ['library']:
            course = []
            if LIBRARY.is_dir():
                course = [{'name': p.name, 'path': str(p)} for p in sorted(LIBRARY.glob('*.pdf'))]
            return self._send(200, {'folder': str(LIBRARY), 'course': course, 'recent': core.list_documents()})
        if len(parts) == 2 and parts[0] == 'doc':
            doc_id = parts[1]
            meta = core.load_meta(doc_id)
            pages = [core.load_page(doc_id, n) for n in range(1, meta['pages'] + 1)]
            return self._send(200, {'meta': meta, 'status': self.server.reader.snapshot(doc_id),
                                    'pages': [p for p in pages if p]})
        if len(parts) == 4 and parts[0] == 'doc' and parts[2] == 'image':
            name = parts[3]
            if not (name.endswith('.png') and '/' not in name and '\\' not in name and '..' not in name):
                raise FileNotFoundError('Not found.')
            target = core.document_dir(parts[1]) / 'pages' / name
            return self._send(200, target.read_bytes(), 'image/png')
        raise FileNotFoundError('Not found.')

    def do_POST(self):
        if not self._allowed():
            return self._error(403, 'Not allowed.')
        try:
            length = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            length = -1
        if length < 0:
            return self._error(400, 'The request was not understood.')
        if length > MAX_UPLOAD:
            return self._error(413, 'This file is larger than 100 MB.')
        body = self.rfile.read(length)
        parts = [p for p in urllib.parse.urlparse(self.path).path.split('/') if p]
        if parts == ['api', 'warm']:
            # Start loading the reading model while the person is still choosing a file.
            core.warm_model()
            return self._send(200, {'warming': True})
        if parts == ['api', 'settings']:
            try:
                changes = json.loads(body.decode('utf-8') or '{}')
                app_settings.save(changes, installed_models())
            except (ValueError, UnicodeDecodeError) as exc:
                return self._error(400, str(exc) or 'The settings were not understood.')
            return self._send(200, settings_payload())
        if parts == ['api', 'settings', 'reset']:
            app_settings.reset()
            return self._send(200, settings_payload())
        if parts in (['api', 'spell'], ['api', 'spell', 'add']):
            # Spelling (F7): the Windows spell checker, the one the red underlines use.
            try:
                request = json.loads(body.decode('utf-8') or '{}')
                if parts[-1] == 'add':
                    word = str(request['word']).strip()
                    if not word or len(word) > 100 or any(c.isspace() for c in word):
                        return self._error(400, 'Add one word at a time.')
                    spelling.add(word)
                    return self._send(200, {'added': word})
                texts = request['texts']
                if not isinstance(texts, list) or not all(isinstance(t, str) for t in texts):
                    return self._error(400, 'The request was not understood.')
                return self._send(200, {'results': spelling.check(texts)})
            except (ValueError, UnicodeDecodeError, KeyError):
                return self._error(400, 'The request was not understood.')
            except OSError as exc:
                return self._error(503, str(exc) or 'The Windows spell checker is not available.')
        try:
            if parts == ['api', 'attach']:
                # An exported PDF gets its notebook attached (a standard PDF attachment).
                request = json.loads(body.decode('utf-8'))
                path = Path(request['path'])
                notebook = request['notebook']
                if path.suffix.lower() != '.pdf' or not path.is_file() or json.loads(notebook).get('format') != 'math-notebook':
                    return self._error(400, 'Only a Math Notebook document can be attached to a PDF.')
                path.write_bytes(attachments.attach(path.read_bytes(), notebook))
                return self._send(200, {'attached': True})
            if parts == ['api', 'braille']:
                # Braille (.brf) of the document, made by BrailleBlaster (braille.py).
                request = json.loads(body.decode('utf-8'))
                path = Path(request['path'])
                if path.suffix.lower() != '.brf' or not isinstance(request.get('page'), str):
                    return self._error(400, 'Braille is written to a .brf file.')
                try:
                    used = braille.export(request['page'], path)
                except LookupError as exc:
                    return self._error(503, str(exc))
                except RuntimeError as exc:
                    return self._error(500, str(exc))
                return self._send(200, {'path': str(path), 'standard': used, 'nemeth': used == braille.NEMETH,
                                        'not_six_dot': braille.not_six_dot(path)})
            if parts == ['api', 'open-path']:
                path = Path(json.loads(body.decode('utf-8'))['path'])
                if path.suffix.lower() != '.pdf' or not path.is_file():
                    return self._error(400, 'Choose a PDF file.')
                data = path.read_bytes()
                # A PDF made by this notebook carries the exact document: no reading needed.
                inside = attachments.read(data)
                if inside:
                    return self._send(200, {'notebook': inside, 'name': path.name})
                meta = core.add_document(data, path.name)
            elif parts == ['api', 'upload']:
                name = urllib.parse.unquote(self.headers.get('X-File-Name') or 'document.pdf')
                if not body:
                    return self._error(400, 'The file is empty.')
                meta = core.add_document(body, name)
            elif len(parts) == 4 and parts[:2] == ['api', 'doc'] and parts[3] == 'read':
                meta = core.load_meta(parts[2])
            else:
                return self._error(404, 'Not found.')
        except ValueError as exc:
            return self._error(400, str(exc))
        except (KeyError, json.JSONDecodeError):
            return self._error(400, 'The request was not understood.')
        except FileNotFoundError:
            return self._error(404, 'This document is not in the notebook any more. Import the PDF again.')
        self.server.reader.request(meta['id'])
        return self._send(200, {'meta': meta})


def main():
    server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    server.reader = core.Reader()
    url = f'http://127.0.0.1:{server.server_address[1]}/'
    print(f'Math Notebook ready: {url}', flush=True)
    if '--open' in sys.argv:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
