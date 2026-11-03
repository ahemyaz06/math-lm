"""Isolated, page-checkpointed PDF job; uploaded text is source data only."""
from pathlib import Path
import argparse
import hashlib
import json
import time
import traceback

from pdf_inspector import PdfInspector, MAX_CANDIDATES
from pdf_plan import inspect_pdf


def write_json(path, value):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False), encoding='utf-8')
    for attempt in range(6):
        try:
            temp.replace(path)
            return
        except PermissionError:
            if attempt == 5:
                raise
            time.sleep(.025 * (2 ** attempt))


def _read_region(folder, pdf, index, candidate, gid, options, ocr, read_graph, attach_ai_description):
    record = {'id': gid, 'pdf_page': index+1, **candidate}
    try:
        initial_size = candidate.get('native_max_side') or 1400
        raw = pdf.png(index, candidate['bbox_points'], max_side=initial_size)
        result = read_graph(raw, ocr, use_vlm=False)
        attempts = [{'max_side': initial_size, 'status': result['reading']['status']}]
        if options['quality'] == 'accurate' and result['reading']['status'] != 'estimated_coordinates':
            alternate_size = 1000 if initial_size != 1000 else 1400
            alternate_raw = pdf.png(index, candidate['bbox_points'], max_side=alternate_size)
            alternate = read_graph(alternate_raw, ocr, use_vlm=False)
            attempts.append({'max_side': alternate_size, 'status': alternate['reading']['status']})
            if alternate['reading']['status'] == 'estimated_coordinates':
                raw, result = alternate_raw, alternate
        rotation = pdf.rotation(index) if hasattr(pdf, 'rotation') else 0
        if rotation and result['reading']['status'] != 'estimated_coordinates':
            # A rotated page shows its graph sideways, so tick labels cannot be
            # read. Turn the crop upright (undo the page's clockwise rotation).
            import io
            from PIL import Image
            with Image.open(io.BytesIO(raw)) as shown:
                upright = shown.rotate(rotation, expand=True)
                buffer = io.BytesIO()
                upright.save(buffer, format='PNG')
            upright_raw = buffer.getvalue()
            upright_result = read_graph(upright_raw, ocr, use_vlm=False)
            attempts.append({'max_side': attempts[-1]['max_side'], 'rotation_undone': rotation,
                             'status': upright_result['reading']['status']})
            if upright_result['reading']['status'] == 'estimated_coordinates':
                raw, result = upright_raw, upright_result
                result['reading']['notes'].append(f'This PDF page is displayed rotated by {rotation} degrees; the graph was read after turning it upright.')
        if options['use_vlm']:
            try:
                from decision_referee import triage_candidate
                verdict = triage_candidate(candidate, result)
                record['referee_verdict'] = {'viable': verdict.is_viable_graph, 'category': verdict.category, 'reason': verdict.reason}
                if not verdict.skip_vlm:
                    result = attach_ai_description(result, raw)
                else:
                    result['reading']['notes'].append(f'Decision referee: {verdict.reason}')
            except Exception:
                result = attach_ai_description(result, raw)
        record['reading_attempts'] = attempts
        (folder/f'graph-{gid}.png').write_bytes(raw)
        result['pdf_source'] = {'page': index+1, **candidate, 'reading_attempts': attempts}
        result['reading']['notes'].extend(candidate.get('warnings', []))
        result['reading']['notes'].append('PDF inspection does not verify coordinates, recover exact equations, or guarantee that every graph was found.')
        write_json(folder/f'graph-{gid}.json', result)
        record.update({'recognition': result['reading']['status'],
                       'summary': result['reading']['verbal_summary'] or 'No description available.'})
    except Exception as exc:
        traceback.print_exc()
        # Our own ValueErrors carry a user-readable reason ("Image is too small
        # to inspect reliably."). Other exceptions keep only their type name.
        reason = str(exc) if isinstance(exc, ValueError) and str(exc) else type(exc).__name__
        record.update({'recognition': 'error', 'summary': f'Region could not be read: {reason.rstrip(".")}.'})
    return record


def run(folder):
    # An orphaned worker may outlive its app server. A second worker must never
    # publish into the same checkpoint/assets, even after an app restart.
    from local_lock import FileLock
    folder = Path(folder)
    with FileLock(folder/'worker.lock'):
        _run(folder)


def _run(folder):
    folder = Path(folder)
    options = json.loads((folder/'options.json').read_text(encoding='utf-8'))
    start = time.monotonic()
    previous_elapsed = 0
    state = {'id': options['id'], 'version': '0.7.0', 'state': 'running', 'stage': 'Opening PDF',
             'pages_total': 0, 'pages_done': 0, 'pages': [], 'graphs': [], 'warnings': [],
             'use_vlm': options['use_vlm'], 'quality': options['quality'],
             'batches': [], 'needs_review': False, 'processing_errors': 0,
             'layout_model': 'docling-project/docling-layout-heron-101' if options['quality'] == 'accurate' else None}

    def save():
        state['elapsed_seconds'] = round(previous_elapsed+time.monotonic()-start, 1)
        write_json(folder/'manifest.json', state)

    def cancelled():
        if not (folder/'cancel.flag').exists():
            return False
        state.update(state='cancelled', stage='Stopped. Completed pages are saved.', needs_review=True)
        save()
        return True

    try:
        if options.get('resume'):
            state = json.loads((folder/'manifest.json').read_text(encoding='utf-8'))
            previous_elapsed = float(state.get('elapsed_seconds', 0))
            if state.get('id') != options['id'] or 'next_page' not in state:
                raise ValueError('This PDF job has no compatible page checkpoint to resume.')
            state.update({'version': '0.7.0', 'state': 'running', 'stage': 'Opening PDF'})
            for key in ('error', 'worker_exit_code', 'diagnostics'):
                state.pop(key, None)
        # PDFium alone opens/counts/validates before importing either model.
        plan = inspect_pdf(folder/'source.pdf', options.get('first_page', 1),
                           options.get('last_page'), options.get('batch_pages', 100))
        digest = hashlib.sha256((folder/'source.pdf').read_bytes()).hexdigest()
        if options.get('resume'):
            empty_checkpoint = (state.get('pages_done', 0) == 0 and not state.get('pages') and not state.get('graphs'))
            if not state.get('source_sha256') and empty_checkpoint:
                # A saved import whose process never started has no completed
                # artifacts to bind to an older source. Validate it as a fresh
                # job; never use this path for any completed page or graph.
                state.update({'source_sha256': digest, 'next_page': plan['first_page'],
                              'quality': options['quality'], 'use_vlm': options['use_vlm']})
                state.update({k: plan[k] for k in ('first_page', 'last_page', 'document_pages')})
            if state.get('source_sha256') != digest:
                raise ValueError('The PDF source changed. Start a new upload instead of resuming.')
            if any(state.get(k) != plan[k] for k in ('first_page', 'last_page', 'document_pages')):
                raise ValueError('The selected PDF range changed. Start a new upload instead of resuming.')
            if state.get('quality') != options['quality'] or state.get('use_vlm') != options['use_vlm']:
                raise ValueError('Keep the original inspection options when resuming this PDF.')
            if empty_checkpoint and not state.get('batch'):
                # The manager's preflight seed contains planned batch ranges,
                # not parser lifetimes that have actually been started.
                state['batches'] = []
        else:
            state.update({'source_sha256': digest, 'next_page': plan['first_page']})
            for key in ('name', 'created_at'):
                if key in options:
                    state[key] = options[key]
        state.update({k: plan[k] for k in ('document_pages', 'first_page', 'last_page', 'pages_total', 'batch_pages')})
        state['planned_batches'] = plan['batches']
        state.setdefault('batches', [])
        state.setdefault('processing_errors', 0)
        state.setdefault('needs_review', False)
        state.setdefault('layout_model', 'docling-project/docling-layout-heron-101' if options['quality'] == 'accurate' else None)
        first, last = plan['first_page'], plan['last_page']
        next_page = state['next_page']
        if not first <= next_page <= last+1:
            raise ValueError('The saved PDF page checkpoint is invalid.')
        save()
        if cancelled():
            return
        if next_page <= last:
            layout = None
            if options['quality'] == 'accurate':
                state['stage'] = 'Loading layout model'
                save()
                from layout_detector import LayoutDetector
                layout = LayoutDetector()
            if cancelled():
                return
            from detector import OCR
            from reader import read_graph, attach_ai_description
            ocr = OCR()
            # A batch is a parser lifetime, not a document-wide truncation cap.
            # Models stay warm while PDFium/pdfplumber caches are released.
            while next_page <= last:
                active = state.get('batch') or {}
                continuing = (options.get('resume') and 'index' in active and
                              active.get('first_page', next_page) <= next_page <= active.get('last_page', 0) and
                              active.get('candidate_count', 0) < MAX_CANDIDATES)
                if continuing:
                    batch = dict(active)
                else:
                    batch = {'index': len(state['batches'])+1, 'first_page': next_page,
                             'last_page': min(last, next_page+plan['batch_pages']-1),
                             'pages_done': 0, 'pages_total': min(plan['batch_pages'], last-next_page+1),
                             'candidate_count': 0}
                    state['batches'].append(batch)
                state['batch'] = batch
                state['batches'][batch['index']-1] = batch
                options['resume'] = False
                save()
                with PdfInspector(folder/'source.pdf', layout=layout) as pdf:
                    while next_page <= batch['last_page']:
                        if cancelled():
                            return
                        index = next_page-1
                        state['stage'] = f'Finding graphs on page {next_page}'
                        save()
                        try:
                            page = pdf.inspect_page(index)
                            candidates = page.pop('candidates')
                            if len(candidates) > MAX_CANDIDATES:
                                raise ValueError('A single page exceeds the per-batch graph candidate budget.')
                            if batch['candidate_count'] + len(candidates) > MAX_CANDIDATES:
                                # Re-open the parser and process this same page in
                                # a new batch. Nothing from the page is published.
                                batch['last_page'] = next_page-1
                                batch['pages_total'] = batch['pages_done']
                                save()
                                break
                            page['candidate_count'] = len(candidates)
                            page_graphs = []
                            for candidate in candidates:
                                if cancelled():
                                    return
                                gid = len(state['graphs'])+len(page_graphs)+1
                                state['stage'] = f'Describing graph {gid} on page {next_page}'
                                save()
                                record = _read_region(folder, pdf, index, candidate, gid, options, ocr, read_graph, attach_ai_description)
                                page_graphs.append(record)
                            if cancelled():
                                return
                            errors = sum(r['recognition'] == 'error' for r in page_graphs)
                            if errors:
                                state['warnings'].append(f'Page {next_page}: {errors} region(s) could not be read. Review this page.')
                                state['processing_errors'] += errors
                            # Commit graph IDs, page text and next_page together.
                            # Interrupted in-flight assets are overwritten on resume.
                            state['graphs'].extend(page_graphs)
                            state['pages'].append(page)
                            batch['candidate_count'] += len(candidates)
                            if candidates or page.get('warnings'):
                                state['needs_review'] = True
                        except Exception as exc:
                            traceback.print_exc()
                            reason = str(exc) if isinstance(exc, ValueError) and str(exc) else type(exc).__name__
                            state['warnings'].append(f'PDF page {next_page} failed: {reason.rstrip(".")}. Review this page; other pages were retained.')
                            state['pages'].append({'pdf_page': next_page, 'text': '', 'warnings': ['Page inspection failed. Review required.'],
                                                   'inspection_error': type(exc).__name__, 'candidate_count': 0})
                            state['processing_errors'] += 1
                            state['needs_review'] = True
                        state['pages_done'] += 1
                        batch['pages_done'] += 1
                        next_page += 1
                        state['next_page'] = next_page
                        save()
        state['state'] = 'partial' if state['processing_errors'] else 'complete'
        state['stage'] = 'Finished; some pages need review' if state['processing_errors'] else 'Finished'
    except Exception as exc:
        traceback.print_exc()
        state['state'] = 'failed'
        state['stage'] = 'PDF processing failed'
        state['needs_review'] = True
        state['error'] = str(exc) if isinstance(exc, ValueError) else 'Could not open or process this PDF. Completed pages remain available.'
    finally:
        save()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('folder', type=Path)
    run(parser.parse_args().folder)
