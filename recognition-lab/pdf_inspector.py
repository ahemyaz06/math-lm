"""PDF page inspection and graph candidate crops, independent of graph recognition.

Coordinates in records are PDF points, measured from the displayed page's top left.
Neither candidate detection nor proximity to text establishes mathematical meaning.
"""
from __future__ import annotations

import io
import math
from pathlib import Path

import cv2
import numpy as np

MAX_PDF_BYTES = 20 * 1024 * 1024
MAX_SELECTED_PAGES = 100
MAX_CANDIDATES_PER_PAGE = 12
MAX_CANDIDATES = 150


def dependencies_available():
    import importlib.util
    return all(importlib.util.find_spec(m) for m in ('pypdfium2', 'pdfplumber'))


def _intersects(a, b, gap=0):
    return a[0] <= b[2] + gap and b[0] <= a[2] + gap and a[1] <= b[3] + gap and b[1] <= a[3] + gap


def _union(a, b):
    return [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])]


def _area(box):
    return max(0, box[2]-box[0]) * max(0, box[3]-box[1])


def _coverage(box, other):
    """Fraction of other covered by box; touching borders are not evidence."""
    overlap = [max(box[0], other[0]), max(box[1], other[1]),
               min(box[2], other[2]), min(box[3], other[3])]
    return _area(overlap) / max(1, _area(other))


def _fuse_geometry(native_boxes, raster_boxes):
    # A native background, enclosing frame or large curve bound can surround
    # several genuinely separate axis components. Never use it to join them.
    boxes = list(raster_boxes)
    for box in native_boxes:
        contained = [b for b in raster_boxes if _coverage(box, b) >= .65]
        if len(contained) > 1:
            continue
        if contained and _area(box) > 2.5 * _area(contained[0]):
            continue
        boxes.append(box)
    return _merge_boxes(boxes, gap=3)


def _panel_padding(box, padded, boxes):
    """Share clear gutters between adjacent panels instead of cropping a sibling."""
    clipped = list(padded)
    for other in boxes:
        if other is box:
            continue
        overlap_y = min(box[3], other[3]) - max(box[1], other[1])
        overlap_x = min(box[2], other[2]) - max(box[0], other[0])
        if overlap_y > .5 * min(box[3]-box[1], other[3]-other[1]):
            if other[2] <= box[0]:
                clipped[0] = max(clipped[0], (other[2]+box[0])/2)
            elif box[2] <= other[0]:
                clipped[2] = min(clipped[2], (box[2]+other[0])/2)
        if overlap_x > .5 * min(box[2]-box[0], other[2]-other[0]):
            if other[3] <= box[1]:
                clipped[1] = max(clipped[1], (other[3]+box[1])/2)
            elif box[3] <= other[1]:
                clipped[3] = min(clipped[3], (box[3]+other[1])/2)
    return clipped


def _prose_only_box(box, words, image, width, height):
    """Reject a dense native-text enclosure only without interior axis evidence.

    Short tick/axis labels and unnumbered diagrams do not meet the prose test.
    Raster-only scans remain candidates: lack of native text is not rejection.
    """
    inside = [w for w in words if _coverage(box, [w['x0'], w['top'], w['x1'], w['bottom']]) >= .8]
    prose = [w for w in inside if sum(c.isalpha() for c in w['text']) >= 5]
    if len(prose) < 2 or sum(len(w['text']) for w in prose) < 28 or len(inside) < 10:
        return False
    if len({round(float(w['top'])/10) for w in inside}) < 3:
        return False
    x0, y0 = max(0, int(box[0]*image.width/width)), max(0, int(box[1]*image.height/height))
    x1, y1 = min(image.width, math.ceil(box[2]*image.width/width)), min(image.height, math.ceil(box[3]*image.height/height))
    if x1 <= x0 or y1 <= y0:
        return False
    gray = cv2.cvtColor(np.asarray(image.crop((x0, y0, x1, y1)).convert('RGB')), cv2.COLOR_RGB2GRAY)
    h, w = gray.shape
    if min(h, w) < 8:
        return False
    ink = (gray < 175).astype('uint8') * 255
    horizontal = cv2.morphologyEx(ink, cv2.MORPH_OPEN, np.ones((1, max(18, w//5)), np.uint8))
    vertical = cv2.morphologyEx(ink, cv2.MORPH_OPEN, np.ones((max(18, h//5), 1), np.uint8))
    border_x, border_y = max(3, round(w*.15)), max(3, round(h*.15))
    # Only a closed enclosure qualifies. This protects sparse first-quadrant
    # graphs whose axis intersection lies at a corner rather than the interior.
    if not (np.max(np.count_nonzero(horizontal[:border_y], axis=1)) > w*.55 and
            np.max(np.count_nonzero(horizontal[-border_y:], axis=1)) > w*.55 and
            np.max(np.count_nonzero(vertical[:, :border_x], axis=0)) > h*.55 and
            np.max(np.count_nonzero(vertical[:, -border_x:], axis=0)) > h*.55):
        return False
    # A border alone is not an axis pair. Permit axes on the graph boundary
    # when at least one line extends well into the interior of the enclosure.
    crossing = cv2.dilate(horizontal, np.ones((3, 3), np.uint8)) & cv2.dilate(vertical, np.ones((3, 3), np.uint8))
    margin_x, margin_y = max(3, round(w*.08)), max(3, round(h*.08))
    interior = crossing[margin_y:h-margin_y, margin_x:w-margin_x]
    return not np.any(interior)


def _char_key(ch):
    return (round(float(ch['x0']), 2), round(float(ch['top']), 2), ch.get('text', ''))


def _invisible_chars(chars, preview, width, height, min_contrast=24):
    """Keys of characters whose rendered area shows no ink at all.

    Rendering is the ground truth for what a sighted reader sees: a glyph area
    that is flat in the rendered page (max-min luminance below min_contrast)
    holds no visible character, whatever its fill colour or render mode.
    """
    if not chars or width <= 0 or height <= 0:
        return set()
    gray = np.asarray(preview.convert('L'), dtype=np.int16)
    sx, sy = preview.width / width, preview.height / height
    hidden = set()
    for ch in chars[:60000]:
        if not str(ch.get('text', '')).strip():
            continue
        x0, x1 = max(0, int(float(ch['x0']) * sx)), min(gray.shape[1], math.ceil(float(ch['x1']) * sx))
        y0, y1 = max(0, int(float(ch['top']) * sy)), min(gray.shape[0], math.ceil(float(ch['bottom']) * sy))
        if x1 - x0 < 2 or y1 - y0 < 2:
            continue  # Too small to judge from pixels; keep it.
        crop = gray[y0:y1, x0:x1]
        if int(crop.max()) - int(crop.min()) < min_contrast:
            hidden.add(_char_key(ch))
    return hidden


def _merge_boxes(boxes, gap=0):
    result = []
    for box in boxes:
        merged = list(box)
        changed = True
        while changed:
            changed = False
            for index, other in enumerate(result):
                if _intersects(merged, other, gap):
                    merged = _union(merged, result.pop(index))
                    changed = True
                    break
        result.append(merged)
    return result


def raster_regions(image):
    """Find intersecting horizontal/vertical line components, including scanned grids.

    Thresholds are relative to page pixels rather than graph size. Tables can also
    pass this filter: classification is deliberately left to the graph reader.
    """
    gray = cv2.cvtColor(np.asarray(image.convert('RGB')), cv2.COLOR_RGB2GRAY)
    h, w = gray.shape
    ink = (gray < 175).astype('uint8') * 255
    horizontal = cv2.morphologyEx(ink, cv2.MORPH_OPEN, np.ones((1, max(22, w // 28)), np.uint8))
    vertical = cv2.morphologyEx(ink, cv2.MORPH_OPEN, np.ones((max(22, h // 35), 1), np.uint8))
    joined = cv2.dilate(horizontal | vertical, np.ones((5, 5), np.uint8))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(joined)
    boxes = []
    for label in range(1, count):
        x, y, bw, bh, area = map(int, stats[label])
        if bw < w * .07 or bh < h * .045 or bw < 45 or bh < 45:
            continue
        region = (labels[y:y+bh, x:x+bw] == label)
        if np.count_nonzero(horizontal[y:y+bh, x:x+bw][region]) < bw * .6:
            continue
        if np.count_nonzero(vertical[y:y+bh, x:x+bw][region]) < bh * .6:
            continue
        boxes.append([x, y, x+bw, y+bh])
    return boxes


def native_regions(page):
    """Use PDF image and vector object bounds as additional candidate evidence."""
    width, height = float(page.width), float(page.height)
    shapes = []
    for obj in list(page.lines) + list(page.curves) + list(page.rects):
        # Filled PDF backgrounds are often represented by a rectangle around
        # an entire multi-panel figure, despite having no visible border.
        color = obj.get('non_stroking_color')
        channels = color if isinstance(color, (tuple, list)) else [color]
        if not obj.get('stroke', True) and channels and all(isinstance(v, (int, float)) and v >= .94 for v in channels):
            continue
        box = [float(obj['x0']), float(obj['top']), float(obj['x1']), float(obj['bottom'])]
        # Ignore page frames, tiny decoration, and long rules. Raster axes cover
        # long axis lines; full-page rectangles otherwise swallow all panels.
        bw, bh = box[2]-box[0], box[3]-box[1]
        if bw > width*.9 or bh > height*.9 or max(bw, bh) < 8:
            continue
        shapes.append(box)
    # A hostile or extremely complex page must not trigger quadratic clustering.
    warnings = []
    if len(shapes) > 2500:
        shapes = []
        warnings.append('Too many vector objects; used page-image detection instead of vector clustering.')
    merged = _merge_boxes(shapes, gap=4)
    boxes = [b for b in merged if b[2]-b[0] >= 40 and b[3]-b[1] >= 35]
    for obj in page.images:
        b = [float(obj['x0']), float(obj['top']), float(obj['x1']), float(obj['bottom'])]
        bw, bh = b[2]-b[0], b[3]-b[1]
        # A page-sized image is usually a scan; split its raster instead.
        if bw >= 40 and bh >= 35 and not (bw > width*.85 and bh > height*.85):
            boxes.append(b)
    return boxes, warnings


class PdfInspector:
    """Use in exactly one process/thread; PDFium is not thread safe."""
    def __init__(self, source, layout=None):
        import pdfplumber
        import pypdfium2
        self.layout = layout
        self.pdf = pypdfium2.PdfDocument(str(source))
        try:
            if not 0 < len(self.pdf) <= 2000:
                raise ValueError('Choose a PDF with between 1 and 2,000 pages.')
            self.text_pdf = pdfplumber.open(source)
        except Exception:
            self.pdf.close()
            raise

    def close(self):
        self.text_pdf.close()
        self.pdf.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def __len__(self):
        return len(self.pdf)

    def render(self, index, bbox=None, max_side=1400):
        page = self.pdf[index]
        try:
            width, height = page.get_size()
            box = bbox or [0, 0, width, height]
            crop = (box[0], height-box[3], width-box[2], box[1])
            scale = min(6, max_side / max(box[2]-box[0], box[3]-box[1]))
            bitmap = page.render(scale=scale, crop=crop)
            try:
                return bitmap.to_pil().convert('RGB').copy()
            finally:
                bitmap.close()
        finally:
            page.close()

    def inspect_page(self, index):
        native = self.text_pdf.pages[index]
        width, height = float(native.width), float(native.height)
        if not all(math.isfinite(v) and 0 < v <= 14400 for v in [width, height]):
            raise ValueError('Page dimensions exceed this prototype\'s limits.')
        warnings = []
        words = []
        images = []
        preview = self.render(index, max_side=1800)
        try:
            # Text a sighted reader cannot see (white on white, invisible
            # render mode over blank paper, text hidden under a filled shape)
            # must not be read out as page content. OCR layers on scans stay,
            # because the scanned glyphs underneath are visible ink.
            displayed = self.pdf[index]
            try:
                same_geometry = all(abs(a-b) <= .5 for a, b in zip(displayed.get_size(), (width, height)))
            finally:
                displayed.close()
            hidden = _invisible_chars(native.chars, preview, width, height) if same_geometry else set()
            visible_page = native.filter(lambda obj: obj.get('object_type') != 'char' or _char_key(obj) not in hidden) if hidden else native
            text = (visible_page.extract_text() or '')[:50000]
            words = visible_page.extract_words()[:15000]
            if hidden:
                warnings.append(f'Ignored {len(hidden)} character(s) of invisible PDF text (for example white text on a white background). '
                                'It is not read out because it does not appear on the page.')
            images = list(native.images)
            boxes, native_warnings = native_regions(native)
            warnings.extend(native_warnings)
            # Decided before any geometry fallback below clears images/boxes.
            graphic_free = not images and not (list(native.lines) or list(native.curves) or list(native.rects))
        except Exception:
            graphic_free = False
            text, boxes = '', []
            warnings.append('Native text/geometry extraction failed; used page-image inspection.')
        # pdfplumber and PDFium normally agree on displayed dimensions. If not,
        # use the raster geometry alone to avoid incorrect coordinate transforms.
        displayed = self.pdf[index]
        try:
            shown_width, shown_height = displayed.get_size()
        finally:
            displayed.close()
        if abs(shown_width-width) > .5 or abs(shown_height-height) > .5:
            boxes = []
            width, height = shown_width, shown_height
            words = []
            images = []
            warnings.append('Page coordinate systems differ; used displayed page geometry only.')
        raster_boxes = [[b[0]*width/preview.width, b[1]*height/preview.height,
                         b[2]*width/preview.width, b[3]*height/preview.height]
                        for b in raster_regions(preview)]
        if any(sum(_coverage(b, r) >= .65 for r in raster_boxes) > 1 for b in boxes):
            warnings.append('An enclosing PDF region was separated using axis components. Axis-free insets or connecting diagrams may be incomplete; review the page.')
        boxes = _fuse_geometry(boxes, raster_boxes)
        layout_regions = []
        layout_succeeded = False
        tables = []
        captions = []
        if self.layout:
            try:
                layout_regions = self.layout.predict(preview, width, height)
                layout_succeeded = True
                tables = [r['bbox_points'] for r in layout_regions if r.get('label') == 'table' and r.get('score', 0) >= .40]
                captions = [r for r in layout_regions if r.get('label') == 'caption']
                # Use specific panels before enclosing model predictions.
                for region in sorted(layout_regions, key=lambda r: _area(r['bbox_points'])):
                    if region['label'] != 'picture':
                        continue
                    picture = region['bbox_points']
                    matches = [i for i, box in enumerate(boxes)
                               if _coverage(picture, box) >= .35 or _coverage(box, picture) >= .65]
                    if not matches:
                        boxes.append(picture)
                    elif len(matches) == 1 and _area(picture) <= 2.5 * _area(boxes[matches[0]]):
                        boxes[matches[0]] = _union(boxes[matches[0]], picture)
                    # Several geometry components inside a model picture can be
                    # separate panels. Keep these components separately.
            except Exception:
                warnings.append('Trained layout detection failed on this page. Only PDF geometry and raster candidates were used; review this page.')
        if tables:
            pictures = [r['bbox_points'] for r in layout_regions if r.get('label') == 'picture']
            non_table = []
            rejected_tables = 0
            for b in boxes:
                is_table = any(_coverage(b, tbl) >= .75 or _coverage(tbl, b) >= .75 for tbl in tables)
                is_pic = any(_coverage(b, pic) >= .35 or _coverage(pic, b) >= .65 for pic in pictures)
                if is_table and not is_pic:
                    rejected_tables += 1
                else:
                    non_table.append(b)
            boxes = non_table
            if rejected_tables:
                warnings.append(f'Excluded {rejected_tables} table region(s) identified by layout analysis.')
        retained = [b for b in boxes if not _prose_only_box(b, words, preview, width, height)]
        rejected_prose = len(boxes) - len(retained)
        boxes = retained
        if rejected_prose:
            warnings.append(f'Excluded {rejected_prose} dense text enclosure(s) without interior axis evidence. Review the page for unlocated diagrams.')
        # Pad BEFORE rendering, preserving labels which often lie outside lines.
        candidates = []
        for box in sorted(boxes, key=lambda b: (round(b[1]/24), b[0])):
            pad = max(14, min(24, max(box[2]-box[0], box[3]-box[1])*.09))
            padded = [max(0, box[0]-pad), max(0, box[1]-pad), min(width, box[2]+pad), min(height, box[3]+pad)]
            # Keep nearby native labels that extend beyond the graph frame.
            for word in words:
                wb = [word['x0'], word['top'], word['x1'], word['bottom']]
                if _intersects(box, wb, gap=pad) and len(word['text']) <= 28:
                    padded = _union(padded, [max(0, wb[0]-2), max(0, wb[1]-2), min(width, wb[2]+2), min(height, wb[3]+2)])
            padded = _panel_padding(box, padded, boxes)
            if padded[2] <= padded[0] or padded[3] <= padded[1]:
                continue
            native_side = None
            for image in images:
                ib = [image['x0'], image['top'], image['x1'], image['bottom']]
                iw, ih = ib[2]-ib[0], ib[3]-ib[1]
                if iw <= 0 or ih <= 0 or not _intersects(box, ib):
                    continue
                # Preserve source raster detail instead of blindly upscaling
                # embedded graphics. Re-rendering still includes PDF overlays.
                source_width, source_height = image.get('srcsize', (0, 0))
                if source_width and source_height:
                    scale = min(source_width/iw, source_height/ih)
                    native_side = max(200, min(1400, round(max(padded[2]-padded[0], padded[3]-padded[1])*scale)))
                    break
            cand_dict = {'bbox_points': [round(v, 3) for v in padded],
                         'native_max_side': native_side,
                         'methods': ['pdf_geometry', 'raster_axes'] + (['heron_101'] if layout_succeeded else []),
                         'nearby_text': ' '.join(w['text'] for w in words if _intersects(padded, [w['x0'], w['top'], w['x1'], w['bottom']], gap=24))[:3000],
                         'extraction': 'candidate', 'warnings': ['Automatically located region; labels or adjacent panels may be incomplete.']}
            if captions:
                for cap in captions:
                    cb = cap['bbox_points']
                    vert_dist = min(abs(cb[1] - padded[3]), abs(padded[1] - cb[3]))
                    horiz_overlap = min(padded[2], cb[2]) - max(padded[0], cb[0])
                    if vert_dist <= 35 and horiz_overlap > 0:
                        cap_words = [w['text'] for w in words if _coverage(cb, [w['x0'], w['top'], w['x1'], w['bottom']]) >= .45]
                        if cap_words:
                            caption_text = ' '.join(cap_words)
                            cand_dict['caption'] = caption_text
                            cand_dict['nearby_text'] = f"[Caption: {caption_text}] " + cand_dict['nearby_text']
                            break
            candidates.append(cand_dict)
        if len(candidates) > MAX_CANDIDATES_PER_PAGE:
            warnings.append(f'Candidate limit reached: only the first {MAX_CANDIDATES_PER_PAGE} regions were retained. Review this page.')
            candidates = candidates[:MAX_CANDIDATES_PER_PAGE]
        if not candidates and graphic_free:
            # A page with no embedded pictures and no drawn lines/curves/shapes
            # cannot contain a drawn graph. Do not add a whole-page review item
            # (a 150-page text PDF would otherwise produce 150 empty results).
            warnings.append('This page has no pictures or drawings, so there is no graph to read.' if text.strip()
                            else 'This page appears blank: no text, pictures or drawings were found.')
        elif not candidates:
            candidates = [{'bbox_points': [0, 0, width, height], 'extraction': 'page_fallback',
                           'methods': ['page_fallback'], 'nearby_text': '',
                           'warnings': ['No separate graph region was located. This is a whole-page fallback, not a confirmed graph. Small graphs may be unreadable.']}]
        if not text.strip() and candidates:
            warnings.append('No native page text was extracted. Graph OCR still runs; full-page question text OCR is not included.')
        native.close()
        return {'pdf_page': index+1, 'size_points': [width, height], 'text': text,
                'layout_regions': layout_regions, 'warnings': warnings, 'candidates': candidates}

    def rotation(self, index):
        """Clockwise display rotation (0, 90, 180, 270) declared by the page."""
        page = self.pdf[index]
        try:
            return int(page.get_rotation()) % 360
        finally:
            page.close()

    def png(self, index, bbox, max_side=1400):
        image = self.render(index, bbox, max_side=max_side)
        out = io.BytesIO()
        image.save(out, format='PNG')
        return out.getvalue()
