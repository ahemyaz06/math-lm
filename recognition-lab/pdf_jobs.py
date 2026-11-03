"""One PDF worker with preflight, durable checkpoints and readable reports."""
from datetime import datetime, timezone
from pathlib import Path
import html
import json
import re
import secrets
import subprocess
import sys
import tempfile
import threading
import time
import hashlib
import os
from pdf_inspector import MAX_PDF_BYTES, dependencies_available
from pdf_worker import write_json
from local_lock import is_locked


def describe_file_type(raw):
    """Best-effort name for common non-PDF uploads, from their leading bytes."""
    head=raw[:64]
    signatures=((b'\x89PNG','a PNG image'),(b'\xff\xd8\xff','a JPEG image'),(b'GIF8','a GIF image'),
        (b'RIFF','a WebP image or WAV/AVI media file'),(b'II*\x00','a TIFF image'),(b'MM\x00*','a TIFF image'),
        (b'PK\x03\x04','a ZIP archive or Word/PowerPoint/Excel document'),(b'\xd0\xcf\x11\xe0','an older Microsoft Office document'),
        (b'ID3','an MP3 audio file'),(b'OggS','an Ogg audio/video file'),(b'fLaC','a FLAC audio file'),
        (b'\x1aE\xdf\xa3','a WebM/MKV video'),(b'MZ','a Windows program'),(b'{\\rtf','an RTF document'))
    for magic,name in signatures:
        if head.startswith(magic):return name
    if head[4:8]==b'ftyp':return 'an MP4/MOV video or HEIC photo'
    stripped=head.lstrip().lower()
    if stripped.startswith((b'<!doctype html',b'<html')):return 'a web page'
    if stripped.startswith(b'<svg') or stripped.startswith(b'<?xml'):return 'an SVG/XML file'
    try:
        raw[:2048].decode('utf-8')
        return 'a plain text file'
    except UnicodeDecodeError:
        return None


class PdfJobs:
    def __init__(self, root=None):
        self.temp=tempfile.TemporaryDirectory(prefix='recognition-lab-pdf-') if root is None else None
        self.root=Path(self.temp.name if self.temp else root)
        self.root.mkdir(parents=True,exist_ok=True)
        self.jobs={};self.lock=threading.RLock();self.closed=threading.Event()
        if not self.temp:
            for folder in self.root.iterdir():
                if not folder.is_dir() or not re.fullmatch(r'[a-f0-9]{32}',folder.name) or folder.resolve().parent!=self.root.resolve():continue
                if not (folder/'options.json').is_file() or not (folder/'source.pdf').is_file():continue
                job=self._record(folder);self.jobs[folder.name]=job
                state=self._read(job)
                if state['state']=='running' and not is_locked(folder/'worker.lock'):
                    state.update(state='interrupted',stage='Processing interrupted. Resume from the last completed page.')
                    write_json(folder/'manifest.json',state);job['last_state']=state
        self.watchdog=threading.Thread(target=self._watch,daemon=True);self.watchdog.start()

    @staticmethod
    def _record(folder):
        return {'folder':folder,'process':None,'started':0,'batch_started':0,'batch_key':None,'override':None,'last_state':None}

    def _watch(self):
        while not self.closed.wait(2):
            try:self.active()
            except OSError:pass  # A transient local file error must not stop supervision.

    @staticmethod
    def _valid_state(state):
        if not isinstance(state,dict) or state.get('state') not in ('running','complete','partial','failed','cancelled','interrupted'):return False
        if any(not isinstance(state.get(k),list) for k in ('graphs','pages','warnings')):return False
        if any(not isinstance(w,str) for w in state['warnings']):return False
        for key in ('pages_done','pages_total','first_page','last_page','next_page','document_pages'):
            if key in state and (type(state[key]) is not int or not 0<=state[key]<=2001):return False
        if state.get('pages_done',0)>state.get('pages_total',2000):return False
        if any(not isinstance(g,dict) or type(g.get('id')) is not int or g['id']<1 or
               ('pdf_page' in g and (type(g['pdf_page']) is not int or g['pdf_page']<1)) or
               any(k in g and not isinstance(g[k],str) for k in ('summary','recognition','extraction','nearby_text')) for g in state['graphs']):return False
        if any(not isinstance(p,dict) or type(p.get('pdf_page')) is not int or p['pdf_page']<1 or
               ('text' in p and not isinstance(p['text'],str)) or
               ('warnings' in p and (not isinstance(p['warnings'],list) or any(not isinstance(w,str) for w in p['warnings']))) for p in state['pages']):return False
        batch=state.get('batch')
        if batch is not None and (not isinstance(batch,dict) or any(type(v) is not int or v<0 for v in batch.values())):return False
        if any(k in state and not isinstance(state[k],str) for k in ('name','created_at')):return False
        return True

    def _read(self,job):
        path=job['folder']/'manifest.json'
        state=job.get('last_state') or {'id':job['folder'].name,'state':'running','stage':'Opening PDF',
            'pages_done':0,'pages_total':0,'graphs':[],'pages':[],'warnings':[]}
        if path.exists():
            try:
                parsed=json.loads(path.read_text(encoding='utf-8'))
                if not self._valid_state(parsed):
                    raise ValueError('Invalid PDF manifest')
                state=parsed;job['last_state']=state;job['manifest_error']=None
            except (OSError,ValueError) as exc:job['manifest_error']=type(exc).__name__
        return dict(state)

    def _refresh(self,job):
        process=job['process']
        if process is None or process.poll() is not None:return
        batch=self._read(job).get('batch') or {}
        key=(batch.get('index'),batch.get('first_page'))
        if batch and key!=job.get('batch_key'):
            job['batch_key']=key;job['batch_started']=time.monotonic()
        if time.monotonic()-job.get('batch_started',job['started'])>900:
            self._stop_worker(job)
            job['override']=('failed','This batch reached the 15-minute limit. Completed pages are saved; resume to continue.')
            self._persist_override(job)

    def active(self):
        with self.lock:
            for job in self.jobs.values():self._refresh(job)
            return any((j['process'] is not None and j['process'].poll() is None) or
                       is_locked(j['folder']/'worker.lock') for j in self.jobs.values())

    @staticmethod
    def _stop_worker(job):
        process=job['process']
        (job['folder']/'cancel.flag').write_text('cancel',encoding='utf-8')
        if process is None or process.poll() is not None:return
        try:process.wait(timeout=.35)
        except subprocess.TimeoutExpired:
            # The Windows venv launcher has a real Python child. Terminating
            # only its parent would leave the import running after Cancel.
            if os.name=='nt':
                subprocess.run(['taskkill','/PID',str(process.pid),'/T','/F'],stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                    creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0),timeout=10)
            else:process.terminate()
            process.wait(timeout=10)

    def inspect(self,raw,first_page=1,last_page=None,batch_pages=100,max_bytes=MAX_PDF_BYTES):
        if not dependencies_available():raise ValueError('PDF support is not installed. Image reading remains available.')
        if not raw:raise ValueError('This file is empty (0 bytes). Choose another file.')
        if len(raw)>max_bytes:
            raise ValueError(f'This PDF is larger than the {max_bytes//(1024*1024)} MB limit. Raise the limit in Settings, or split the PDF.')
        # PDF readers accept a short prefix (a byte-order mark, a mail header)
        # before %PDF- within the first 1024 bytes; so does PDFium.
        if b'%PDF-' not in raw[:1024]:
            kind=describe_file_type(raw)
            raise ValueError(f'This file is not a PDF{f" (it looks like {kind})" if kind else ""}. '
                             'Choose a PDF, or use Image for PNG/JPEG pictures.')
        from pdf_plan import inspect_pdf
        with self.lock,tempfile.TemporaryDirectory(prefix='inspect-',dir=self.root) as folder:
            path=Path(folder)/'source.pdf';path.write_bytes(raw)
            return inspect_pdf(path,first_page,last_page,batch_pages)

    def _launch(self,job):
        (job['folder']/'cancel.flag').unlink(missing_ok=True)
        flags=getattr(subprocess,'CREATE_NO_WINDOW',0)
        with (job['folder']/'worker.log').open('ab') as log:
            process=subprocess.Popen([sys.executable,'-B',str(Path(__file__).with_name('pdf_worker.py')),str(job['folder'])],
                stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,creationflags=flags)
        job.update(process=process,started=time.monotonic(),batch_started=time.monotonic(),batch_key=None,override=None)

    def submit(self,raw,first_page=1,last_page=None,use_vlm=False,quality='accurate',batch_pages=100,max_bytes=MAX_PDF_BYTES,name='PDF'):
        if self.closed.is_set():raise ValueError('The PDF processor has stopped. Restart Recognition Lab.')
        if quality not in ('accurate','basic'):raise ValueError('Unknown PDF inspection method.')
        with self.lock:
            if self.active():raise RuntimeError('A PDF is processing. Wait or cancel it before starting another.')
            plan=self.inspect(raw,first_page,last_page,batch_pages,max_bytes)
            if quality=='accurate':
                from layout_detector import available
                if not available():raise ValueError('Quality inspection is unavailable. Install its local model or choose Basic in Options.')
            jid=secrets.token_hex(16);folder=self.root/jid;folder.mkdir()
            (folder/'source.pdf').write_bytes(raw)
            name=str(name).replace('\\','/').split('/')[-1][:180] or 'PDF'
            options={'id':jid,'name':name,'created_at':datetime.now(timezone.utc).isoformat(),
                'first_page':plan['first_page'],'last_page':plan['last_page'],'document_pages':plan['document_pages'],
                'use_vlm':bool(use_vlm),'quality':quality,'batch_pages':batch_pages,'resume':False}
            write_json(folder/'options.json',options)
            state={'id':jid,'version':'0.6.0','name':name,'created_at':options['created_at'],'state':'running','stage':'Opening PDF',
                **plan,'next_page':plan['first_page'],'pages_done':0,'pages':[],'graphs':[],'warnings':[],
                'source_sha256':hashlib.sha256(raw).hexdigest(),'quality':quality,'use_vlm':bool(use_vlm)}
            write_json(folder/'manifest.json',state)
            job=self._record(folder);job['last_state']=state;self.jobs[jid]=job
            try:self._launch(job)
            except OSError:
                job['override']=('failed','The PDF worker could not start. Resume to try again.');self._persist_override(job)
                raise RuntimeError('The worker could not start. The import was saved; resume from Recent PDFs.')
            return jid

    def _job(self,jid):
        if not re.fullmatch(r'[a-f0-9]{32}',jid) or jid not in self.jobs:
            raise KeyError('PDF import not found. Choose it from Recent PDFs or upload it again.')
        return self.jobs[jid]

    def _persist_override(self,job):
        state=self._read(job)
        if job['override']:state['state'],state['stage']=job['override']
        write_json(job['folder']/'manifest.json',state);job['last_state']=state

    def status(self,jid):
        with self.lock:
            job=self._job(jid);self._refresh(job);state=self._read(job)
            process=job['process'];exit_code=process.poll() if process else None
            worker_active=is_locked(job['folder']/'worker.lock')
            if job['override']:state['state'],state['stage']=job['override']
            elif process is None and state['state']=='running' and not is_locked(job['folder']/'worker.lock'):
                state.update(state='interrupted',stage='Processing interrupted. Resume to continue.')
            elif worker_active and (process is None or exit_code is not None):
                state.update(state='running',stage=state.get('stage','Finishing the current PDF page'))
            elif process is not None and exit_code is not None and (state['state']=='running' or exit_code!=0 or job.get('manifest_error')):
                state.update(state='failed',stage='PDF processing stopped',error=f'Worker stopped (exit code {exit_code}). Completed pages are saved; resume to continue.')
            elif process is not None and exit_code is None and state['state']!='running':state.update(state='running',stage='Finishing PDF processing')
            if process is not None and exit_code is not None:
                state['worker_exit_code']=exit_code
                try:
                    log=job['folder']/'worker.log'
                    with log.open('rb') as stream:
                        stream.seek(max(0,log.stat().st_size-8000));tail=stream.read().decode('utf-8',errors='replace')
                except OSError:tail=''
                state['diagnostics']={'log_tail':tail,'manifest_error':job.get('manifest_error')}
            try:
                options=json.loads((job['folder']/'options.json').read_text(encoding='utf-8'))
                if not isinstance(options,dict):raise ValueError('Invalid saved import options')
            except (OSError,ValueError):options={}
            state.setdefault('name',options.get('name','PDF'));state.setdefault('created_at',options.get('created_at',''))
            state['can_resume']=state['state'] in ('cancelled','failed','interrupted','partial') and state.get('next_page',1)<=state.get('last_page',0)
            return state

    def history(self):
        with self.lock:
            fields=('id','name','state','document_pages','first_page','last_page','pages_done','pages_total','created_at','can_resume')
            items=[{k:s.get(k) for k in fields} for s in (self.status(jid) for jid in self.jobs)]
            return {'jobs':sorted(items,key=lambda s:s.get('created_at') or '',reverse=True)}

    def asset(self,jid,gid,kind):
        with self.lock:
            job=self._job(jid);state=self.status(jid)
            if not any(g['id']==gid for g in state['graphs']):raise KeyError('Graph not found.')
            path=job['folder']/f'graph-{gid}.{kind}'
            if kind not in ('json','png') or not path.is_file():raise KeyError('This region has no saved reading.')
            return path.read_bytes()

    def cancel(self,jid,state='cancelled'):
        with self.lock:
            job=self._job(jid);process=job['process']
            if process is not None and process.poll() is None:
                self._stop_worker(job)
                job['override']=(state,'Stopped. Completed pages are saved. Resume to continue.')
                self._persist_override(job)
            elif is_locked(job['folder']/'worker.lock'):
                (job['folder']/'cancel.flag').write_text('cancel',encoding='utf-8')
            return self.status(jid)

    def resume(self,jid):
        with self.lock:
            if self.closed.is_set():raise ValueError('Restart Recognition Lab to resume this import.')
            if self.active():raise RuntimeError('A PDF is processing. Wait or cancel it before resuming another.')
            if not dependencies_available():raise ValueError('PDF support is not installed. Restore PDF support before resuming.')
            job=self._job(jid);state=self.status(jid)
            if not state.get('can_resume'):raise ValueError('This import has no unfinished pages to resume.')
            try:
                options=json.loads((job['folder']/'options.json').read_text(encoding='utf-8'))
                if not isinstance(options,dict) or options.get('quality') not in ('accurate','basic'):raise ValueError('Invalid options')
            except (OSError,ValueError):raise ValueError('Saved import options could not be read. Upload this PDF again.')
            if options['quality']=='accurate':
                from layout_detector import available
                if not available():raise ValueError('This import requires its original local layout model. Restore the model before resuming.')
            options['resume']=True
            write_json(job['folder']/'options.json',options)
            state.update(state='running',stage='Resuming PDF processing');state.pop('error',None)
            write_json(job['folder']/'manifest.json',state);job['last_state']=state
            try:self._launch(job)
            except OSError:
                job['override']=('failed','The PDF worker could not start. Completed pages remain saved; resume to try again.')
                self._persist_override(job);raise RuntimeError('The worker could not start. Completed pages remain saved.')
            return jid

    def report(self,jid):
        state=self.status(jid);esc=lambda value:html.escape(str(value),quote=True)
        name=state.get('name','PDF');parts=[f'<!doctype html><html lang="en"><meta charset="utf-8"><title>{esc(name)} descriptions</title><main>',
            f'<h1>{esc(name)}</h1>',f'<p>{state["pages_done"]} of {state["pages_total"]} selected pages processed. Status: {esc(state["state"])}.</p>',
            '<p>Descriptions may omit or misinterpret features. Numerical coordinates and equations are estimates.</p>']
        for page in state.get('pages',[]):
            number=page['pdf_page'];parts.append(f'<section><h2>PDF page {number}</h2>')
            graphs=[g for g in state['graphs'] if g['pdf_page']==number]
            if page.get('inspection_error'):parts.append('<p>Page inspection failed. This page needs review; absence of results does not mean it contains no graphs.</p>')
            elif not graphs:parts.append('<p>No separate graph candidates were located on this page.</p>')
            if page.get('warnings'):parts.append('<p>'+esc(' '.join(page['warnings']))+'</p>')
            for graph in graphs:
                label='Whole-page review' if graph.get('extraction')=='page_fallback' else f'Graph candidate {graph["id"]}'
                parts.append(f'<article><h3>{esc(label)}</h3><p>{esc(graph.get("summary","No description available."))}</p>')
                if graph.get('extraction')=='page_fallback':parts.append('<p>No separate graph was located; this is a whole-page fallback.</p>')
                if graph.get('nearby_text'):parts.append(f'<details><summary>Nearby source text; association unverified</summary><p>{esc(graph["nearby_text"])}</p></details>')
                parts.append('</article>')
            if page.get('text'):parts.append(f'<details><summary>Extracted page text; may contain errors</summary><pre>{esc(page["text"])}</pre></details>')
            parts.append('</section>')
        if state.get('warnings'):parts.append('<details><summary>Processing notes</summary><ul>'+''.join(f'<li>{esc(w)}</li>' for w in state['warnings'])+'</ul></details>')
        parts.append('</main></html>');return '\n'.join(parts).encode('utf-8')

    def close(self):
        self.closed.set()
        with self.lock:
            for jid in self.jobs:self.cancel(jid,state='interrupted')
            if self.temp:self.temp.cleanup()
