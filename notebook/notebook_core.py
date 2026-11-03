"""Turn a course PDF into readable pages: Markdown with LaTeX math, checked against
the PDF's own text, with figures sent to Recognition Lab's graph reader.

Uses Recognition Lab's Python environment, model files and AI server launcher.
Everything runs on this computer; documents are never uploaded anywhere.
"""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import hashlib
import json
import os
import re
import sys
import threading
import time
import urllib.request

ROOT = Path(__file__).resolve().parent
RECOGNITION = ROOT.parent / 'recognition-lab'
if str(RECOGNITION) not in sys.path:
    sys.path.append(str(RECOGNITION))  # last, so this folder's own modules win

import pypdfium2 as pdfium  # noqa: E402

import checker  # noqa: E402
import pdf_text_reader  # noqa: E402
import settings as app_settings  # noqa: E402

DATA_DIR = Path(os.environ.get('MATH_NOTEBOOK_DATA') or
                Path(os.environ.get('LOCALAPPDATA') or Path.home()) / 'MathNotebook')


def models():
    """The reading model, then the optional second model (Settings > Reading PDFs). The
    second re-reads only pages where the checker found differences and the closer copy
    is kept; it is off by default because swapping models makes reading slower."""
    s = app_settings.load()
    second = s['second_model'] if s['second_model'] and s['second_model'] != s['reading_model'] else None
    return [s['reading_model']] + ([second] if second else [])


MODEL = models()[0]  # the default model; each request names its own, as threads read side by side
# Pages read at the same time (default; Settings can change it). Two share the AI's work
# (8 pages: 58.5 s -> 48.7 s, same checker results); the AI server has one request slot
# per page (vlm_helper profile).
WORKERS = max(1, int(os.environ.get('MATH_NOTEBOOK_WORKERS', '2')))
PDF_LOCK = threading.Lock()
PAGE_LOCK = threading.RLock()  # page records are rewritten when a picture's description arrives
# Without a maths font, a page whose formulas are drawn as shapes (OpenStax) has far more
# small drawn shapes than this: 149 to 422 on ten sampled textbook pages, 0 to 67 on
# course pages made with LaTeX (which have maths fonts anyway).
DRAWN_MATH_SHAPES = 40
# Picture descriptions and graph-number estimates started early (see _start_figure_work).
FIGURE_POOL = ThreadPoolExecutor(4, thread_name_prefix='figure')
# Long side of the page picture sent to the model. The AI server caps image
# detail at 1,024 tokens, so larger pictures do not add detail.
PAGE_PIXELS = int(os.environ.get('MATH_NOTEBOOK_PAGE_PIXELS', '1024'))
PROMPT_VERSION = 2
PROMPT = (
    "Transcribe this math course page exactly into Markdown. "
    "Write every mathematical expression in LaTeX, using $...$ inline and $$...$$ on their own lines for display math. "
    "Keep problem numbers, example numbers and part letters such as (a) exactly as printed, and copy every part. "
    "Copy the text; do not solve, explain, correct or add anything. "
    "Only for an actual picture, graph or table, write the line [FIGURE type=TYPE] by itself, where TYPE is one of "
    "coordinate_graph, table, diagram, number_line, other. On the next lines write a short plain-language description, "
    "then a blank line. Write a table as a Markdown table on those lines. "
    "Leave out page numbers."
)
MAX_TOKENS = 2000
FIGURE_TYPES = {'coordinate_graph', 'table', 'diagram', 'number_line', 'other'}


# ---------- documents ----------

def document_dir(doc_id):
    if not re.fullmatch(r'[0-9a-f]{64}', doc_id or ''):
        raise ValueError('Unknown document.')
    return DATA_DIR / 'documents' / doc_id


def add_document(pdf_bytes, name):
    """Store a PDF once by its fingerprint and return its id and page count."""
    if b'%PDF-' not in pdf_bytes[:1024]:
        raise ValueError('This file is not a PDF.')
    doc_id = hashlib.sha256(pdf_bytes).hexdigest()
    folder = document_dir(doc_id)
    (folder / 'pages').mkdir(parents=True, exist_ok=True)
    source = folder / 'source.pdf'
    if not source.exists():
        source.write_bytes(pdf_bytes)
    try:
        pdf = pdfium.PdfDocument(str(source))
    except pdfium.PdfiumError as exc:
        raise ValueError('This PDF could not be opened. It may be damaged or password-protected.') from exc
    pages = len(pdf)
    pdf.close()
    meta = {'id': doc_id, 'name': Path(name).name or 'document.pdf', 'pages': pages,
            'opened': time.strftime('%Y-%m-%d %H:%M')}
    (folder / 'meta.json').write_text(json.dumps(meta, indent=1), encoding='utf-8')
    return meta


def list_documents():
    out = []
    for meta in (DATA_DIR / 'documents').glob('*/meta.json'):
        try:
            out.append(json.loads(meta.read_text(encoding='utf-8')))
        except (OSError, ValueError):
            continue
    return sorted(out, key=lambda m: m.get('opened', ''), reverse=True)


def load_meta(doc_id):
    return json.loads((document_dir(doc_id) / 'meta.json').read_text(encoding='utf-8'))


def page_path(doc_id, number):
    return document_dir(doc_id) / 'pages' / f'{number}.json'


def load_page(doc_id, number):
    p = page_path(doc_id, number)
    if not p.exists():
        return None
    page = json.loads(p.read_text(encoding='utf-8'))
    if page.get('blank'):
        return page  # found blank without the AI; nothing to check
    if not still_valid(page):
        return None  # made another way than Settings now asks, or with an older reader: read again
    if 'pdf_text' in page:
        # Checking needs no AI, so it is redone each time and checker fixes apply at once.
        page['check'] = page_check(page)
    return page


def still_valid(page):
    method = app_settings.get('reading_method')
    if page.get('method') == 'text':
        if page.get('needs_ai'):
            return method == 'text'  # "only the AI can read it": read it once the AI is allowed
        return method != 'ai' and page.get('reader_version') == pdf_text_reader.VERSION
    if page.get('prompt_version') != PROMPT_VERSION or page.get('model') not in models():
        return False
    # In automatic mode an AI copy is kept only for a page the text reader cannot read.
    return method == 'ai' or bool(page.get('ai_reason'))


def check_page(pdf_text, markdown, math_fonts=None):
    check = checker.compare(pdf_text, markdown, math_fonts=math_fonts)
    for flag in check['flags']:
        flag['message'] = checker.describe(flag)
    return check


def page_check(page):
    if page.get('method') != 'text':
        return check_page(page['pdf_text'], page['markdown'], page.get('math_fonts'))
    # Text taken from the PDF itself cannot have copying errors, and comparing it with the
    # PDF's plain text only finds orderings (lim before or after x->a). The reader's own
    # notes say where it was unsure.
    flags = [{'line': line, 'math': True, 'message': f'The text reader was unsure here: {note}. Compare with the PDF.'}
             for line, note in page.get('reader_notes') or []]
    return {'checked': True, 'agreement': None, 'flags': flags, 'math_checked': True, 'by': 'text reader'}


# ---------- one page ----------

def native_text(pdf, index, skip_boxes=()):
    """The PDF's own text for a page, leaving out text inside the given boxes
    (x0, top, x1, bottom in points from the top-left), such as graph tick labels."""
    page = pdf[index]
    textpage = page.get_textpage()
    try:
        if not skip_boxes:
            return textpage.get_text_range()
        height = page.get_height()
        kept = []
        for i in range(textpage.count_chars()):
            left, bottom, right, top = textpage.get_charbox(i)
            cx, cy = (left + right) / 2, height - (bottom + top) / 2
            if right > left and any(b[0] <= cx <= b[2] and b[1] <= cy <= b[3] for b in skip_boxes):
                continue
            kept.append(textpage.get_text_range(i, 1))
        return ''.join(kept)
    finally:
        textpage.close()


def render_page(pdf, index, out_path, long_side=PAGE_PIXELS):
    page = pdf[index]
    width, height = page.get_size()
    scale = long_side / max(width, height)
    page.render(scale=scale).to_pil().convert('RGB').save(out_path)


def find_figures(source, index, folder):
    """Graphs and pictures on a page, top to bottom, found by Recognition Lab's PDF
    inspector (embedded pictures and vector drawings). Drawn graphs with numbered
    axes are read exactly from the PDF's drawing instructions."""
    import pdf_inspector
    import vector_graph
    found = []
    with pdf_inspector.PdfInspector(source) as inspector:
        page = inspector.inspect_page(index)
        height = page['size_points'][1] or 1
        plumber = inspector.text_pdf.pages[index]
        pictures = embedded_picture_boxes(inspector.pdf, index)
        boxes = []
        for cand in page['candidates']:
            if cand.get('extraction') == 'page_fallback':
                continue
            bbox = list(cand['bbox_points'])
            try:
                exact = vector_graph.read_vector_graph(plumber, bbox)
            except Exception:
                exact = {'status': 'error'}
            exact = exact if exact.get('status') == 'exact' else None
            inside = [p for p in pictures if _contains(bbox, p)]
            if not exact and inside:
                # A box around text and a picture: describe the picture, not the text.
                for p in inside:
                    boxes.append((p, None))
                    pictures.remove(p)
                continue
            boxes.append((bbox, exact))
        boxes.extend((p, None) for p in pictures if not any(_contains(b, p) for b, _ in boxes))
        placed = [p for p in embedded_picture_boxes(inspector.pdf, index)]
        for n, (bbox, exact) in enumerate(sorted(boxes, key=lambda b: b[0][1]), 1):
            picture = folder / f'figure-{index + 1}-{n}.png'
            picture.write_bytes(inspector.png(index, bbox))
            found.append({'bbox': bbox, 'picture': picture,
                          'position': (bbox[1] + bbox[3]) / 2 / height, 'exact': exact,
                          'embedded': any(_contains(bbox, p) for p in placed)})
    return found


def embedded_picture_boxes(pdf, index, min_side=40):
    """Bounds of pictures placed in the page, as (x0, top, x1, bottom) from the top-left."""
    import pypdfium2.raw as pdfium_c
    page = pdf[index]
    height = page.get_height()
    out = []
    for obj in page.get_objects(filter=[pdfium_c.FPDF_PAGEOBJ_IMAGE], max_depth=3):
        left, bottom, right, top = obj.get_bounds()
        if right - left >= min_side and top - bottom >= min_side:
            out.append([left - 4, height - top - 4, right + 4, height - bottom + 4])
    return out


def _contains(outer, inner):
    cx, cy = (inner[0] + inner[2]) / 2, (inner[1] + inner[3]) / 2
    return outer[0] <= cx <= outer[2] and outer[1] <= cy <= outer[3]


def clean_transcription(text):
    text = re.sub(r'<think>.*?</think>', '', text or '', flags=re.S).strip()
    fenced = re.fullmatch(r'```[a-zA-Z]*\s*\n(.*?)\n?```', text, flags=re.S)
    text = (fenced.group(1) if fenced else text).strip()
    # Seen on real pages: "<!-- Image (173, 95, 824, 506) -->" placeholders and stray
    # ```latex fences around display math. A math page never needs either.
    text = re.sub(r'<!--.*?-->', '', text, flags=re.S)
    text = re.sub(r'^[ \t]*```[a-zA-Z]*[ \t]*$\n?', '', text, flags=re.M)
    return re.sub(r'\n{3,}', '\n\n', text).strip()


FIGURE_PROMPT = (
    "This is a graph or picture from a calculus lecture, described for a blind student. Say only what is drawn, briefly. "
    "First list the text labels exactly as printed. Then, in at most six sentences: each curve or line with its label and "
    "how it behaves from left to right, including any gaps, jumps or holes; each marked dot; and what the dashed lines and "
    "arrows connect. Do not explain the mathematics. No LaTeX. Do not repeat yourself."
)


def repeating_tail(text, min_unit=15, max_unit=400, times=4, min_span=200):
    """Length of a piece of text repeated `times` times in a row at the very end (a
    generation loop), or 0. Short repeats such as empty table rows are not counted."""
    for unit in range(min_unit, max_unit + 1):
        span = unit * times
        if span > len(text):
            break
        if span >= min_span and text[-span:] == text[-unit:] * times:
            return unit
    return 0


# Anti-repetition sampling (llama.cpp's DRY), used only to re-read a page that looped.
NO_LOOP_SAMPLING = {'dry_multiplier': 0.8, 'dry_base': 1.75, 'dry_allowed_length': 3}


def _chat(image_path, prompt, max_tokens, long_side, sampling=None, model=None):
    """One request to the local AI server. Returns (text, finish_reason); finish_reason
    is 'loop' when the answer was stopped because it began repeating itself."""
    import vlm_helper
    profile = vlm_helper.get_vlm_profile(model or MODEL)
    payload = {
        'messages': [{'role': 'user', 'content': [
            {'type': 'image_url', 'image_url': {'url': vlm_helper._encode_image_for_vlm(str(image_path), max_side=long_side)}},
            {'type': 'text', 'text': prompt}]}],
        # A small repetition penalty stops the model looping on one sentence.
        'temperature': 0.0, 'max_tokens': max_tokens, 'repeat_penalty': 1.1,
        # Streamed so a loop is noticed at once; one looped page used to waste 90 s.
        'stream': True, **(sampling or {}),
    }
    if not profile.enable_thinking:
        payload['chat_template_kwargs'] = {'enable_thinking': False}
    request = urllib.request.Request(f'{vlm_helper.VLM_URL}/v1/chat/completions',
                                     data=json.dumps(payload).encode('utf-8'),
                                     headers={'Content-Type': 'application/json'}, method='POST')
    parts, finish, checked = [], None, 0
    with urllib.request.urlopen(request, timeout=300) as response:
        for raw in response:  # closing the connection early makes the server stop
            line = raw.decode('utf-8').strip()
            if not line.startswith('data:') or line == 'data: [DONE]':
                continue
            choice = (json.loads(line[5:]).get('choices') or [{}])[0]
            parts.append((choice.get('delta') or {}).get('content') or '')
            finish = choice.get('finish_reason') or finish
            size = sum(map(len, parts))
            if size - checked >= 100:
                checked = size
                if repeating_tail(''.join(parts)):
                    return ''.join(parts), 'loop'
    return ''.join(parts), finish


def drop_repeated_lines(text):
    """Remove lines the model repeated word for word."""
    seen, kept = set(), []
    for line in text.splitlines():
        key = line.strip().casefold()
        if key and len(key) > 12 and key in seen:
            continue
        seen.add(key)
        kept.append(line)
    return '\n'.join(kept).strip()


def drop_loops(text, limit=3):
    """Cut a line the model repeated three or more times in a row (a generation loop).
    Repeats far apart are kept: two problems can share a line."""
    kept, run = [], 0
    for line in text.splitlines():
        if kept and line.strip() and line.strip() == kept[-1].strip():
            run += 1
            if run >= limit - 1:
                continue
        else:
            run = 0
        kept.append(line)
    return '\n'.join(kept).strip()


def describe_figure(image_path, model=None):
    """A focused description of one picture. Always unverified."""
    import vlm_helper
    model = model or MODEL
    if not vlm_helper.ensure_vlm_server(profile_name=model):
        return None
    text, _finish = _chat(image_path, FIGURE_PROMPT, 450, 1024, model=model)
    return drop_repeated_lines(clean_transcription(text))


def transcribe(image_path, model=None):
    """Ask the local vision model for Markdown + LaTeX. Returns (markdown, seconds)."""
    import vlm_helper
    started = time.perf_counter()
    model = model or MODEL
    if not vlm_helper.is_vlm_installed(model):
        raise RuntimeError(f'The local reading model {model} is not installed.')
    if vlm_helper.ensure_vlm_server(profile_name=model):
        text, finish = _chat(image_path, PROMPT, MAX_TOKENS, PAGE_PIXELS, model=model)
        if finish in ('loop', 'length'):
            # Read once more with anti-repetition sampling; keep the copy that did not loop.
            again, finish_again = _chat(image_path, PROMPT, MAX_TOKENS, PAGE_PIXELS, NO_LOOP_SAMPLING, model=model)
            if finish_again not in ('loop', 'length'):
                text, finish = again, finish_again
        if finish == 'loop':
            text = text[:len(text) - 3 * repeating_tail(text)]  # keep one copy of the repeat
            text += ('\n\n[FIGURE type=other]\n'
                     'The reader started repeating itself here; the rest of the page may be missing.\n')
        elif finish == 'length':
            text += ('\n\n[FIGURE type=other]\n'
                     'The reader ran out of space on this page; the rest of the page is missing.\n')
    else:
        result = vlm_helper._query_via_cli(str(image_path), custom_prompt=PROMPT, max_tokens=MAX_TOKENS,
                                           temperature=0.0, profile_name=model)
        if not result.get('available') and not result.get('raw_text'):
            raise RuntimeError(result.get('error') or 'The local reading model did not answer.')
        text = result.get('raw_text') or ''
    return drop_loops(clean_transcription(text)), round(time.perf_counter() - started, 1)


# The model sometimes adds attributes: [FIGURE type=table description="..."].
_FIGURE_LINE = re.compile(r'^\s*\[FIGURE(?:\s+type="?([a-z_]+)"?)?[^\]]*\]', re.I)


def figure_blocks(markdown):
    """(line number, type) for each figure block the model wrote."""
    out = []
    for n, line in enumerate(markdown.splitlines()):
        m = _FIGURE_LINE.match(line)
        if m:
            kind = (m.group(1) or 'other').lower()
            out.append((n, kind if kind in FIGURE_TYPES else 'other'))
    return out


_OCR = None
_OCR_LOCK = threading.Lock()


def read_graph_numbers(image_path):
    """Run Recognition Lab's numerical graph reader. Returns a short summary or None."""
    global _OCR
    import detector
    import reader
    with _OCR_LOCK:
        if _OCR is None:
            _OCR = detector.OCR()
        result = reader.read_graph(str(image_path), ocr=_OCR)
    reading = result.get('reading') or {}
    if reading.get('status') != 'estimated_coordinates':
        return {'status': 'no_numbers',
                'message': 'No numbered scale was found on this graph, so no coordinates were read. Graphs labelled only with letters, such as a or L, have none.'}
    equations = []
    for path in reading.get('paths') or []:
        estimate = path.get('curve_estimate') or {}
        if estimate.get('equation'):
            equations.append(estimate['equation'])
    points = [p['coordinate'] for p in reading.get('marked_points') or [] if p.get('coordinate')]
    span = reading.get('axis_span') or {}
    return {'status': 'estimated',
            'summary': reading.get('verbal_summary') or '',
            'equations': equations[:6],
            'points': points[:12],
            'axis_span': span,
            'message': 'Read from the picture: these numbers are estimates, not exact values.'}


def _start_figure_work(found, model):
    """Start the AI description and the numbers estimate of every pasted picture as soon
    as the picture is found, so they run while the page itself is being transcribed
    instead of after it. Results are used only if the transcription pairs the picture."""
    for f in found:
        if not f['exact']:
            f['description_job'] = FIGURE_POOL.submit(describe_figure, f['picture'], model)
            f['numbers_job'] = FIGURE_POOL.submit(read_graph_numbers, f['picture'])


def _read_figure(figure, found, on_stage, model=None):
    figure['picture'] = found['picture'].name
    if found['exact']:
        # Exact values from the PDF itself; no AI description that could contradict them.
        figure['type'] = 'coordinate_graph'
        figure['numbers'] = {'status': 'exact', 'message': found['exact']['message'],
                             'summary': found['exact']['summary'], 'graph': found['exact']}
        return figure
    if on_stage:
        on_stage('figure')
    try:
        job = found.get('description_job')
        figure['description'] = job.result() if job else describe_figure(found['picture'], model)
    except Exception:
        figure['description'] = None  # the page-level description remains
    if figure['type'] == 'coordinate_graph':
        if on_stage:
            on_stage('graph')
        try:
            job = found.get('numbers_job')
            figure['numbers'] = job.result() if job else read_graph_numbers(found['picture'])
        except Exception as exc:  # the description still stands without numbers
            figure['numbers'] = {'status': 'error', 'message': f'The graph reader failed: {exc}'}
    return figure


def text_reader_can_read(source, index, pdf_text, math_fonts, found):
    """(True, None) when the page's own text holds its maths; otherwise (False, reason)."""
    if not checker.strip_page_numbers(pdf_text or '').strip():
        return False, 'no text'  # a scan or a picture of a page
    if math_fonts:
        return True, None
    import pdfplumber
    with pdfplumber.open(str(source), pages=[index + 1]) as pdf:
        page = pdf.pages[0]
        shapes = [c for c in page.curves if c['bottom'] - c['top'] < 14 and c['x1'] - c['x0'] < 40
                  and not any(_contains(f['bbox'], [c['x0'], c['top'], c['x1'], c['bottom']]) for f in found)]
    if len(shapes) >= DRAWN_MATH_SHAPES:
        return False, 'drawn maths'  # formulas drawn as shapes (OpenStax)
    return True, None


def _mostly_text(page, bbox):
    """A drawing that is really text: a framed theorem, or a ruled table (straight lines
    only, no curves), which the text reader turns into a real table."""
    def within(o):
        return bbox[0] - 2 <= (o['x0'] + o['x1']) / 2 <= bbox[2] + 2 and bbox[1] - 2 <= (o['top'] + o['bottom']) / 2 <= bbox[3] + 2
    inside = [c for c in page.chars if within(c)]
    if len(inside) > 40:
        return True
    lines = [o for o in list(page.lines) + list(page.rects) if within(o)]
    upright = [o for o in lines if o['x1'] - o['x0'] <= 1.5]
    flat = [o for o in lines if o['bottom'] - o['top'] <= 1.5]
    curves = [o for o in page.curves if within(o)]
    return len(inside) >= 4 and len(upright) >= 2 and len(flat) >= 2 and not curves


def read_by_text(source, number, found, pdf_text, math_fonts):
    """The page rebuilt from the PDF's own characters (pdf_text_reader), no AI. Pictures get
    their place marked and wait in the picture queue; exactly read graphs are filled in now."""
    import pdfplumber
    started = time.perf_counter()
    with pdfplumber.open(str(source), pages=[number]) as pdf:
        page = pdf.pages[0]
        keep = [f for f in found if f['exact'] or f.get('embedded') or not _mostly_text(page, f['bbox'])]
        marks = [{'bbox': f['bbox'], 'marker': '[FIGURE type=coordinate_graph]' if f['exact'] else '[FIGURE type=other]'}
                 for f in keep]
        result = pdf_text_reader.read_page(page, marks)
    before = result['markdown'].split('\n')
    markdown = drop_page_number(result['markdown'], pdf_text)
    after = markdown.split('\n')
    shift = before.index(after[0]) if after and after[0] in before else 0  # a page number dropped from the top
    order = [n for n, _line in sorted(result['figure_lines'].items(), key=lambda item: item[1])]
    figures = []
    for (line, kind), n in zip(figure_blocks(markdown), order):
        figure = {'line': line, 'type': kind}
        if keep[n]['exact']:
            figures.append(_read_figure(figure, keep[n], None))
        else:
            figure['picture'] = keep[n]['picture'].name
            figure['pending'] = True  # described later by the picture queue; its place is kept
            figures.append(figure)
    notes = [(line - shift, note) for line, note in result['notes'] if 0 <= line - shift < len(after)]
    record = {'page': number, 'markdown': markdown, 'pdf_text': pdf_text, 'figures': figures,
              'method': 'text', 'reader_version': pdf_text_reader.VERSION, 'reader_notes': notes,
              'model': None, 'prompt_version': PROMPT_VERSION, 'has_text_layer': True, 'math_fonts': math_fonts,
              'seconds': round(time.perf_counter() - started, 2)}
    record['check'] = page_check(record)
    return record


def process_page(doc_id, number, on_stage=None, model=None, save=True, method=None):
    """Read one page (1-based) and save the result. Returns the page record."""
    if save:
        cached = load_page(doc_id, number)
        if cached:
            return cached
    method = method or app_settings.get('reading_method')
    if not app_settings.ai_enabled():
        method = 'text'  # without the AI add-on (or with it switched off) no model is ever called
    model = model or models()[0]
    folder = document_dir(doc_id)
    index = number - 1
    with PDF_LOCK:  # PDFium is not thread-safe; only the AI requests run side by side
        try:
            found = find_figures(folder / 'source.pdf', index, folder / 'pages')
        except Exception:
            found = []  # without the inspector the page text is still read
        pdf = pdfium.PdfDocument(str(folder / 'source.pdf'))
        try:
            # Tick labels inside exactly-read graphs are checked by the graph reader instead.
            pdf_text = native_text(pdf, index, [f['exact']['text_box'] for f in found if f['exact']])
            image = folder / 'pages' / f'{number}.png'
            render_page(pdf, index, image)
        finally:
            pdf.close()
        math_fonts = page_has_math_fonts(folder / 'source.pdf', index)
    if is_blank_page(pdf_text, found, image):
        # Asked about a blank page, the model invents mathematics (seen on a real page),
        # and with no text in the PDF the checker cannot catch it. Skip the AI.
        record = {'page': number, 'markdown': 'This page is blank.', 'pdf_text': pdf_text, 'figures': [],
                  'check': {'checked': True, 'agreement': None, 'flags': [], 'reason': 'blank page'},
                  'model': None, 'prompt_version': PROMPT_VERSION, 'seconds': 0, 'has_text_layer': bool(pdf_text.strip()),
                  'blank': True}
        if save:
            save_page(doc_id, record)
        return record
    ai_reason = None
    if method != 'ai':
        if on_stage:
            on_stage('reading')
        usable, ai_reason = text_reader_can_read(folder / 'source.pdf', index, pdf_text, math_fonts, found)
        if usable:
            record = read_by_text(folder / 'source.pdf', number, found, pdf_text, math_fonts)
            if save:
                save_page(doc_id, record)
            return record
        if method == 'text':
            why = ('This page has no text in the PDF (it is a scan or a picture)' if ai_reason == 'no text'
                   else "This page's formulas are drawn as shapes in the PDF")
            how = ai_missing_reason() or ('To have it read, choose "Automatic" or "AI reads every page" in Settings, '
                                          'Reading PDFs, and import the PDF again.')
            record = {'page': number, 'pdf_text': pdf_text, 'figures': [], 'method': 'text', 'needs_ai': True,
                      'reader_version': pdf_text_reader.VERSION, 'reader_notes': [], 'model': None,
                      'prompt_version': PROMPT_VERSION, 'has_text_layer': ai_reason != 'no text', 'seconds': 0,
                      'markdown': f'{why}, so only the AI can read it. {how}'}
            record['check'] = {'checked': True, 'agreement': None, 'flags': [], 'math_checked': True}
            if save:
                save_page(doc_id, record)
            return record
    _start_figure_work(found, model)
    if on_stage:
        on_stage('reading')
    markdown, seconds = transcribe(image, model)
    markdown = drop_page_number(markdown, pdf_text)
    check = check_page(pdf_text, markdown, math_fonts)

    # Pair the model's figure blocks with the figures found on the page by position.
    lines = max(1, len(markdown.splitlines()))
    unused = list(found)
    figures = []
    blocks = figure_blocks(markdown)
    in_order = len(blocks) == len(found)  # same count: the reading order pairs them
    for line, kind in blocks:
        figure = {'line': line, 'type': kind}
        if in_order:
            figures.append(_read_figure(figure, unused.pop(0), on_stage, model))
            continue
        if unused:
            best = min(unused, key=lambda f: (abs(f['position'] - line / lines), kind == 'coordinate_graph' and not f['exact']))
            if abs(best['position'] - line / lines) < .4:
                unused.remove(best)
                figures.append(_read_figure(figure, best, on_stage, model))
                continue
        figures.append(figure)
    # A numbered graph the model did not mention is still worth reporting.
    for f in unused:
        if f['exact']:
            figures.append(_read_figure({'line': None, 'type': 'coordinate_graph', 'unmentioned': True}, f, on_stage, model))
    record = {'page': number, 'markdown': markdown, 'pdf_text': pdf_text, 'check': check, 'figures': figures,
              'model': model, 'prompt_version': PROMPT_VERSION, 'seconds': seconds,
              'has_text_layer': check['checked'], 'math_fonts': math_fonts, 'method': 'ai', 'ai_reason': ai_reason}
    if save:
        save_page(doc_id, record)
    return record


def save_page(doc_id, record):
    target = page_path(doc_id, record['page'])
    tmp = target.with_suffix('.tmp')
    tmp.write_text(json.dumps(record, ensure_ascii=False, indent=1), encoding='utf-8')
    os.replace(tmp, target)


def _score(record):
    return (len(record['check']['flags']), -(record['check'].get('agreement') or 0))


def second_opinion(doc_id, number, on_stage=None):
    """Re-read a page that has differences with the other model; keep the better copy."""
    page = load_page(doc_id, number)
    names = models()
    if (not page or page.get('method') != 'ai' or not page['check']['flags'] or page.get('second_opinion')
            or len(names) < 2):
        return page
    import vlm_helper
    other = next(m for m in names if m != page['model'])
    if not vlm_helper.is_vlm_installed(other):
        return page
    if on_stage:
        on_stage('second')
    alternative = process_page(doc_id, number, model=other, save=False, method='ai')
    winner, loser = (alternative, page) if _score(alternative) < _score(page) else (page, alternative)
    winner['second_opinion'] = {'models': [page['model'], other], 'chosen': winner['model'],
                                'differences': {page['model']: len(page['check']['flags']),
                                                other: len(alternative['check']['flags'])}}
    save_page(doc_id, winner)
    return winner


def page_has_math_fonts(pdf_path, index):
    """Whether the page's text uses a maths font; None if the fonts cannot be read.
    Without one (OpenStax books draw formulas as shapes) the checker sees no maths."""
    try:
        import pdfplumber
        with pdfplumber.open(str(pdf_path), pages=[index + 1]) as pdf:
            return checker.has_math_fonts({c.get('fontname') for c in pdf.pages[0].chars})
    except Exception:
        return None


BLANK_INK = 0.0001  # share of dark pixels; blank course page 0.0022 %, sparsest real page 0.043 %


def is_blank_page(pdf_text, found, image_path):
    """True for a page with nothing on it but a page number: no text in the PDF besides
    that number, no pictures or drawings found, and almost no ink in the rendered image.
    Scanned pages have no text either but plenty of ink, so they are still read."""
    if found or checker.strip_page_numbers(pdf_text or '').strip():
        return False
    from PIL import Image
    import numpy as np
    gray = np.asarray(Image.open(image_path).convert('L'))
    return float((gray < 160).mean()) < BLANK_INK


_LONE_NUMBER = re.compile(r'\s*(?:page\s*)?(\d{1,4})\s*', re.I)


def drop_page_number(markdown, pdf_text):
    """The model sometimes copies the printed page number although told not to. Drop a
    bare number on the first or last line, but only one that the PDF's own text has
    alone on its first or last line (its page number), so real content is never lost."""
    pdf_lines = [l for l in (pdf_text or '').strip().splitlines() if l.strip()]
    numbers = {m.group(1) for l in pdf_lines[:1] + pdf_lines[-1:] if (m := _LONE_NUMBER.fullmatch(l))}
    lines = markdown.strip().splitlines()
    for end in (-1, 0):
        if lines and (m := _LONE_NUMBER.fullmatch(lines[end])) and m.group(1) in numbers:
            lines.pop(end)
    return '\n'.join(lines).strip()


def ai_missing_reason(pictures=False):
    """Why the AI cannot help here, in words for the document; None when it can."""
    what = 'pictures are not described' if pictures else 'it cannot read such pages'
    if not app_settings.AI:
        return f'the AI add-on is not installed, so {what}.' if pictures else f'The AI add-on is not installed, so {what}.'
    if not app_settings.get('use_ai'):
        text = f'the AI add-on is switched off in Settings, so {what}.'
        return text if pictures else text[0].upper() + text[1:]
    return None


def warm_model():
    """Start the reading model in the background (about 10 s) so the first page does not
    wait for it. Harmless if it is already running; it sleeps again when idle."""
    if not app_settings.ai_enabled():
        return  # no model and no OCR to start without the AI add-on
    import vlm_helper
    s = app_settings.load()
    # Reading by text needs the AI only for pictures; it is started then, not before.
    needs_ai = s['reading_method'] == 'ai' or s['describe_pictures']
    if needs_ai and vlm_helper.is_vlm_installed(s['reading_model']):
        threading.Thread(target=vlm_helper.ensure_vlm_server, kwargs={'profile_name': s['reading_model']}, daemon=True).start()
    threading.Thread(target=_load_graph_reader, daemon=True).start()


def _load_graph_reader():
    """The first pasted graph picture used to wait ~4 s for the OCR engine to load."""
    global _OCR
    try:
        import detector
        import reader  # noqa: F401  (heavy imports, loaded once)
        with _OCR_LOCK:
            if _OCR is None:
                _OCR = detector.OCR()
    except Exception:
        pass  # read_graph_numbers will try again and report its own error


# ---------- pictures, described after their page is in the document ----------

def fill_figure(doc_id, number, line):
    """Describe one waiting picture and write the result into its page. The page is
    already in the document with the picture's place marked; the editor fills it in."""
    s = app_settings.load()
    path = page_path(doc_id, number)
    with PAGE_LOCK:
        record = json.loads(path.read_text(encoding='utf-8'))
    figure = next((f for f in record.get('figures', []) if f.get('line') == line and f.get('pending')), None)
    if not figure:
        return
    picture = document_dir(doc_id) / 'pages' / figure['picture']
    result = {}
    ai = app_settings.ai_enabled()
    if ai and s['describe_pictures']:
        try:
            result['description'] = describe_figure(picture, s['reading_model'])
        except Exception:
            result['description'] = None
    elif not ai:
        result['skipped'] = ai_missing_reason(pictures=True)
    else:
        result['skipped'] = 'AI picture descriptions are turned off in Settings.'
    if ai and s['estimate_graph_numbers']:  # the numbers reader's OCR is part of the AI add-on
        try:
            numbers = read_graph_numbers(picture)
        except Exception as exc:
            numbers = {'status': 'error', 'message': f'The graph reader failed: {exc}'}
        result['numbers'] = numbers
        if numbers.get('status') == 'estimated':
            result['type'] = 'coordinate_graph'
    with PAGE_LOCK:  # re-read: the page may have been saved again meanwhile
        record = json.loads(path.read_text(encoding='utf-8'))
        for f in record.get('figures', []):
            if f.get('line') == line and f.get('pending'):
                f.update(result)
                f['pending'] = False
        save_page(doc_id, record)


class FigureQueue:
    """Pictures waiting for the AI, in the order their pages were read. Two are described
    at a time (the AI server has two request slots); each page's text never waits."""

    def __init__(self, workers=2):
        self.cond = threading.Condition()
        self.jobs = []      # (doc_id, page, line)
        self.running = []
        for _ in range(workers):
            threading.Thread(target=self._work, daemon=True).start()

    def add(self, doc_id, record):
        with self.cond:
            for f in (record or {}).get('figures', []):
                job = (doc_id, record['page'], f.get('line'))
                if f.get('pending') and job not in self.jobs and job not in self.running:
                    self.jobs.append(job)
            self.cond.notify_all()

    def waiting(self, doc_id):
        with self.cond:
            return sum(1 for job in self.jobs + self.running if job[0] == doc_id)

    def _work(self):
        while True:
            with self.cond:
                while not self.jobs:
                    self.cond.wait()
                job = self.jobs.pop(0)
                self.running.append(job)
            try:
                fill_figure(*job)
            except Exception:
                pass  # the placeholder stays; the page itself is unaffected
            finally:
                with self.cond:
                    self.running.remove(job)


# ---------- background reading, one document at a time ----------

class Reader:
    def __init__(self):
        self.lock = threading.Lock()
        self.queue = []
        self.status = {}  # doc_id -> {'state', 'page', 'stage', 'error', 'done'}
        self.wake = threading.Event()
        self.figures = FigureQueue()
        threading.Thread(target=self._run, daemon=True).start()

    def request(self, doc_id):
        meta = load_meta(doc_id)
        with self.lock:
            loaded = {n: load_page(doc_id, n) for n in range(1, meta['pages'] + 1)}
            done = [n for n, p in loaded.items() if p]
            for p in loaded.values():
                self.figures.add(doc_id, p)  # pictures left waiting when the app was closed
            unchecked = any(p['check']['flags'] and p.get('method') == 'ai' and not p.get('second_opinion')
                            for p in loaded.values() if p)
            if len(done) == meta['pages'] and (not unchecked or len(models()) < 2):
                self.status[doc_id] = {'state': 'done', 'done': done, 'page': None, 'stage': None, 'errors': {}}
            elif doc_id not in self.queue:
                self.queue.append(doc_id)
                # Pages read another way than Settings now asks are read again.
                self.status[doc_id] = {'state': 'waiting', 'done': done, 'page': None, 'stage': None, 'errors': {}}
        self.wake.set()

    def snapshot(self, doc_id):
        with self.lock:
            status = json.loads(json.dumps(self.status.get(doc_id) or {'state': 'idle', 'done': [], 'errors': {}}))
        status['figures_waiting'] = self.figures.waiting(doc_id)
        return status

    def _run(self):
        while True:
            self.wake.wait()
            with self.lock:
                doc_id = self.queue[0] if self.queue else None
                if not doc_id:
                    self.wake.clear()
                    continue
                status = self.status[doc_id]
                status['state'] = 'reading'
            try:
                pages = load_meta(doc_id)['pages']

                def read(number):
                    with self.lock:
                        status['page'], status['stage'] = number, 'preparing'

                    def stage(name):
                        with self.lock:
                            status['stage'] = name
                    try:
                        record = process_page(doc_id, number, on_stage=stage)
                        self.figures.add(doc_id, record)
                        with self.lock:
                            status['done'].append(number)
                            status['errors'].pop(str(number), None)
                    except Exception as exc:
                        with self.lock:
                            status['errors'][str(number)] = str(exc) or exc.__class__.__name__
                with self.lock:
                    todo = [n for n in range(1, pages + 1) if n not in status['done']]
                # Pages are taken in order, a few at a time; the editor adds them in order.
                with ThreadPoolExecutor(max(1, app_settings.get('pages_at_once'))) as pool:
                    list(pool.map(read, todo))
                # Second pass: only pages with differences, so the model is swapped once.
                for number in range(1, pages + 1):
                    with self.lock:
                        if number not in status['done']:
                            continue
                        status['page'], status['stage'] = number, 'second'
                    try:
                        second_opinion(doc_id, number)
                    except Exception:
                        pass  # the first reading stands
                with self.lock:
                    status['state'] = 'done' if not status['errors'] else 'done_with_errors'
                    status['page'] = status['stage'] = None
            except Exception as exc:
                # One unreadable document (its files deleted or damaged) must not stop the
                # reader for every document after it.
                with self.lock:
                    status['errors']['document'] = str(exc) or exc.__class__.__name__
                    status['state'] = 'done_with_errors'
                    status['page'] = status['stage'] = None
            finally:
                with self.lock:
                    if self.queue and self.queue[0] == doc_id:
                        self.queue.pop(0)
