"""Read a graph that a PDF draws with vector instructions (LaTeX TikZ/pgfplots, most
course handouts) directly from those instructions instead of from pixels.

The tick labels are real text with exact positions and the curves are real point
lists, so the axes can be calibrated and the curves converted to graph coordinates
without OCR. Nothing is guessed: if the tick labels do not line up on a linear
scale, no numbers are returned.
"""
import math
import re

NUMBER = re.compile(r'^[-−–]?\d+(?:\.\d+)?$')
FUNCTION_LABEL = re.compile(r'^(?:[A-Za-z](?:\([a-z]\))?|y\s*=.*|[A-Za-z]\s*=.*)$')
COLORS = {
    'black': (0, 0, 0), 'red': (1, 0, 0), 'blue': (0, 0, 1), 'green': (0, .5, 0),
    'bright green': (0, 1, 0), 'orange': (1, .5, 0), 'purple': (.5, 0, .5), 'magenta': (1, 0, 1),
    'cyan': (0, 1, 1), 'brown': (.6, .3, .1), 'teal': (0, .5, .5), 'violet': (.5, 0, 1),
}


def _rgb(color):
    if color is None:
        return None
    if isinstance(color, (int, float)):
        color = (color,)
    color = tuple(float(c) for c in color)
    if len(color) == 1:
        return (color[0],) * 3
    if len(color) == 4:  # CMYK
        c, m, y, k = color
        return ((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k))
    return color[:3]


def color_name(color):
    rgb = _rgb(color)
    if rgb is None:
        return None
    if max(rgb) - min(rgb) < .08:
        return 'black' if max(rgb) < .2 else 'gray'
    return min(COLORS, key=lambda n: sum((a - b) ** 2 for a, b in zip(rgb, COLORS[n])))


def _number(text):
    return float(text.replace('−', '-').replace('–', '-'))


def _fit(pairs):
    """Least-squares value = a*position + b. Returns (a, b, worst error)."""
    n = len(pairs)
    mp = sum(p for p, _ in pairs) / n
    mv = sum(v for _, v in pairs) / n
    var = sum((p - mp) ** 2 for p, _ in pairs)
    if var == 0:
        return None
    a = sum((p - mp) * (v - mv) for p, v in pairs) / var
    b = mv - a * mp
    return a, b, max(abs(a * p + b - v) for p, v in pairs)


def _axis_labels(words):
    """The row of numbers under the x-axis and the column beside the y-axis."""
    nums = [w for w in words if NUMBER.match(w['text'])]
    best_x = best_y = None
    rows = {}
    for w in nums:
        rows.setdefault(round((w['top'] + w['bottom']) / 4), []).append(w)  # 2-point bands
    for row in rows.values():
        row = sorted(row, key=lambda w: w['x0'])
        values = [_number(w['text']) for w in row]
        if len(row) >= 3 and all(b > a for a, b in zip(values, values[1:])):
            if best_x is None or len(row) > len(best_x):
                best_x = row
    cols = {}
    for w in nums:
        cols.setdefault(round(w['x1'] / 3), []).append(w)  # right-aligned labels, 3-point bands
    for col in cols.values():
        col = sorted(col, key=lambda w: w['top'])
        values = [_number(w['text']) for w in col]
        if len(col) >= 3 and all(b < a for a, b in zip(values, values[1:])):
            if best_y is None or len(col) > len(best_y):
                best_y = col
    return best_x, best_y


def _chain(pieces, tol=0.6):
    """Join point lists whose ends touch (a curve drawn in several strokes)."""
    pieces = [list(p) for p in pieces if len(p) >= 2]
    joined = True
    while joined:
        joined = False
        for i in range(len(pieces)):
            for j in range(len(pieces)):
                if i == j:
                    continue
                a, b = pieces[i], pieces[j]
                if math.dist(a[-1], b[0]) <= tol:
                    pieces[i] = a + b[1:]
                elif math.dist(a[-1], b[-1]) <= tol:
                    pieces[i] = a + b[::-1][1:]
                else:
                    continue
                pieces.pop(j)
                joined = True
                break
            if joined:
                break
    return pieces


def _clip(points, left, top, right, bottom):
    """Split a polyline into the pieces inside a rectangle (Liang-Barsky per segment)."""
    pieces, current = [], []
    for (x1, y1), (x2, y2) in zip(points, points[1:]):
        dx, dy = x2 - x1, y2 - y1
        t0, t1, inside = 0.0, 1.0, True
        for p, q in ((-dx, x1 - left), (dx, right - x1), (-dy, y1 - top), (dy, bottom - y1)):
            if p == 0:
                if q < 0:
                    inside = False
                    break
                continue
            t = q / p
            if p < 0:
                t0 = max(t0, t)
            else:
                t1 = min(t1, t)
        if not inside or t0 > t1:
            if len(current) >= 2:
                pieces.append(current)
            current = []
            continue
        a = (x1 + t0 * dx, y1 + t0 * dy)
        b = (x1 + t1 * dx, y1 + t1 * dy)
        if not current or math.dist(current[-1], a) > 1e-6:
            if len(current) >= 2:
                pieces.append(current)
            current = [a]
        current.append(b)
        if t1 < 1:
            pieces.append(current)
            current = []
    if len(current) >= 2:
        pieces.append(current)
    return pieces


def _simplify(points, eps):
    """Ramer-Douglas-Peucker: keep only the corners."""
    if len(points) < 3:
        return points
    (x1, y1), (x2, y2) = points[0], points[-1]
    length = math.hypot(x2 - x1, y2 - y1) or 1e-12
    worst, index = 0, 0
    for k, (x, y) in enumerate(points[1:-1], 1):
        d = abs((y2 - y1) * x - (x2 - x1) * y + x2 * y1 - y2 * x1) / length
        if d > worst:
            worst, index = d, k
    if worst <= eps:
        return [points[0], points[-1]]
    return _simplify(points[:index + 1], eps)[:-1] + _simplify(points[index:], eps)


def _clean(v):
    """Remove PDF coordinate rounding noise (about 0.01 point)."""
    r = round(v, 2)
    return 0.0 if r == 0 else r




def _bounds(pts):
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def _round_shape(pts):
    """True for a circle-like outline: every point about the same distance from the centre."""
    x0, y0, x1, y1 = _bounds(pts)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    radii = [math.dist(p, (cx, cy)) for p in pts]
    return len(pts) >= 5 and max(radii) > 0 and min(radii) / max(radii) > .6 and abs((x1 - x0) - (y1 - y0)) < 1.5


def _features(points, y_step):
    """Zeros and turning points of a smooth sampled curve, in graph units."""
    zeros, turns = [], []
    for (xa, ya), (xb, yb) in zip(points, points[1:]):
        if ya == 0:
            zeros.append(xa)
        elif ya * yb < 0:
            zeros.append(xa + (xb - xa) * ya / (ya - yb))
    direction = 0
    for k in range(1, len(points)):
        dy = points[k][1] - points[k - 1][1]
        if abs(dy) < 1e-9:
            continue
        new = 1 if dy > 0 else -1
        if direction and new != direction:
            turns.append({'kind': 'peak' if direction > 0 else 'valley', 'at': list(points[k - 1]), 'index': k - 1})
        direction = new
    # Where the drawn curve stops (often at an arrowhead, whose last points bend back) is its end,
    # not a peak or a valley: no turns in the last few points or the last 3% of its width.
    width = abs(points[-1][0] - points[0][0]) if len(points) > 1 else 0
    turns = [{'kind': t['kind'], 'at': t['at']} for t in turns
             if 2 < t['index'] < len(points) - 3
             and min(abs(t['at'][0] - points[0][0]), abs(t['at'][0] - points[-1][0])) > .03 * width]
    # Drop wiggles smaller than 1% of a grid step.
    kept = []
    for t in turns:
        if kept and abs(kept[-1]['at'][1] - t['at'][1]) < .01 * y_step:
            kept.pop()
            continue
        kept.append(t)
    clean_zeros = []
    for z in zeros:
        if not clean_zeros or abs(z - clean_zeros[-1]) > .02:
            clean_zeros.append(z)
    return clean_zeros, kept


def read_vector_graph(page, bbox):
    """page: a pdfplumber page. bbox: (x0, top, x1, bottom) in PDF points."""
    x0, top, x1, bottom = bbox
    box = (max(0, x0), max(0, top), min(page.width, x1), min(page.height, bottom))
    # LaTeX fakes bold by printing a character several times on top of itself.
    words = page.crop(box).dedupe_chars().extract_words(extra_attrs=['non_stroking_color'])
    x_labels, y_labels = _axis_labels(words)
    if not x_labels or not y_labels:
        return {'status': 'no_vector_scale', 'message': 'No numbered axes were found in the drawing.'}

    # Every drawn shape that touches the graph box. Shapes only partly inside are kept:
    # curves often run far off the page and are clipped by LaTeX.
    shapes = []
    for obj in list(page.curves) + list(page.lines):
        pts = obj.get('pts') or []
        if len(pts) < 2:
            continue
        sx0, sy0, sx1, sy1 = _bounds(pts)
        if sx1 < box[0] or sx0 > box[2] or sy1 < box[1] or sy0 > box[3]:
            continue
        shapes.append((obj, pts, sx1 - sx0, sy1 - sy0))

    vertical, horizontal, frame, strokes, arrows, dots = [], [], [], [], [], []
    for obj, pts, w, h in shapes:
        name = color_name(obj.get('stroking_color'))
        fill_name = color_name(obj.get('non_stroking_color'))
        small = max(w, h) < 9
        if len(pts) == 2 and (w < .3 or h < .3):
            if w < .3:
                vertical.append(pts[0][0])
            else:
                horizontal.append(pts[0][1])
        if small and _round_shape(pts):
            dots.append((obj, pts))
        elif small and (obj.get('fill') or len(pts) >= 3):
            # Arrowheads: small filled triangles, or small open strokes of three points.
            arrows.append((fill_name if obj.get('fill') and fill_name not in (None, 'gray') else name, pts))
        elif name == 'gray':
            frame.extend(pts)
        elif name == 'black' and len(pts) == 2 and (w < .5 or h < .5):
            if not small:
                frame.extend(pts)  # axes
        elif not small and obj.get('stroke', True):
            dash = obj.get('dash')
            strokes.append({'color': name, 'dashed': bool(dash and dash[0]), 'pts': pts})

    def snap(position, lines):
        near = min(lines, key=lambda v: abs(v - position), default=None)
        return near if near is not None and abs(near - position) <= 1.5 else position
    fx = _fit([(snap((w['x0'] + w['x1']) / 2, vertical), _number(w['text'])) for w in x_labels])
    fy = _fit([(snap((w['top'] + w['bottom']) / 2, horizontal), _number(w['text'])) for w in y_labels])
    if not fx or not fy:
        return {'status': 'no_vector_scale', 'message': 'The axis numbers do not form a scale.'}
    x_step = abs(_number(x_labels[1]['text']) - _number(x_labels[0]['text']))
    y_step = abs(_number(y_labels[1]['text']) - _number(y_labels[0]['text']))
    if fx[2] > .05 * x_step or fy[2] > .05 * y_step:
        return {'status': 'no_vector_scale', 'message': 'The axis numbers are not evenly spaced, so no coordinates were read.'}
    ax, bx = fx[0], fx[1]
    ay, by = fy[0], fy[1]

    def to_graph(p):
        return ax * p[0] + bx, ay * p[1] + by

    # The visible area is the grid and axes. LaTeX hides overhanging curve parts with a
    # clipping box that the PDF text layer does not report.
    left, upper, right, lower = _bounds(frame) if frame else box
    left, upper, right, lower = left - .05, upper - .05, right + .05, lower + .05

    curves = []
    groups = {}
    for s in strokes:
        groups.setdefault((s['color'], s['dashed']), []).append(s['pts'])
    for (name, dashed), pieces in groups.items():
        for chain in _chain(pieces):
            ends = {'start': False, 'end': False}
            # An arrowhead at an end means the curve continues; LaTeX stops the line
            # short of the arrow, so extend it to the arrow's tip.
            for side in ('start', 'end'):
                if side == 'start':
                    end, before = chain[0], chain[min(2, len(chain) - 1)]
                else:
                    end, before = chain[-1], chain[max(-3, -len(chain))]
                for color, apts in arrows:
                    if color == name and min(math.dist(end, q) for q in apts) < 5:
                        tip = max(apts, key=lambda q: math.dist(q, before))
                        chain = [tip] + chain if side == 'start' else chain + [tip]
                        ends[side] = True
                        break
            for piece in _clip(chain, left, upper, right, lower):
                px0, py0, px1, py1 = _bounds(piece)
                if max(px1 - px0, py1 - py0) < 6:
                    continue
                graph_pts = [to_graph(p) for p in piece]
                corners = _simplify(graph_pts, eps=0.01 * max(x_step, y_step))
                curve = {'color': name, 'dashed': dashed, 'label': None,
                         'continues': [side for side, flag in ends.items() if flag],
                         'start': [_clean(v) for v in graph_pts[0]], 'end': [_clean(v) for v in graph_pts[-1]],
                         'pixels': piece}
                # Drawn straight pieces reduce to a few corners; a sampled smooth curve keeps
                # many corners relative to its points.
                if len(corners) <= 5 or (len(corners) <= 12 and len(corners) < .15 * len(piece)):
                    curve['kind'] = 'straight pieces'
                    curve['corners'] = [[_clean(x), _clean(y)] for x, y in corners]
                else:
                    curve['kind'] = 'curve'
                    zeros, turns = _features(graph_pts, y_step)
                    curve['crosses_x_axis_at'] = [_clean(z) for z in zeros]
                    curve['turning_points'] = [{'kind': t['kind'], 'at': [_clean(v) for v in t['at']]} for t in turns]
                    step = max(1, len(graph_pts) // 200)
                    curve['samples'] = [[_clean(x), _clean(y)] for x, y in graph_pts[::step]]
                curves.append(curve)

    # Labels such as f(x) go to the curve of the same colour, else to the nearest curve.
    coloured_first = sorted(words, key=lambda w: color_name(w.get('non_stroking_color')) == 'black')
    for w in coloured_first:
        if not FUNCTION_LABEL.match(w['text']) or w['text'] in ('x', 'y'):
            continue
        centre = ((w['x0'] + w['x1']) / 2, (w['top'] + w['bottom']) / 2)
        colour = color_name(w.get('non_stroking_color'))
        pool = [c for c in curves if c['label'] is None and (c['color'] == colour or colour == 'black')]
        if not pool:
            continue
        nearest = min(pool, key=lambda c: min(math.dist(centre, p) for p in c['pixels']))
        # A black word only labels a curve it sits next to; it may be question text.
        if colour == nearest['color'] or min(math.dist(centre, p) for p in nearest['pixels']) < 25:
            nearest['label'] = w['text']

    points = []
    for obj, pts in dots:
        dx0, dy0, dx1, dy1 = _bounds(pts)
        cx, cy = (dx0 + dx1) / 2, (dy0 + dy1) / 2
        if not (left <= cx <= right and upper <= cy <= lower):
            continue
        fill = _rgb(obj.get('non_stroking_color'))
        # A white-filled circle is an open dot (a hole); any other fill is a solid dot.
        filled = bool(obj.get('fill')) and fill is not None and min(fill) < .95
        gx, gy = to_graph((cx, cy))
        points.append({'coordinate': [_clean(gx), _clean(gy)], 'kind': 'solid dot' if filled else 'open dot',
                       'color': color_name(obj.get('stroking_color'))})
    points.sort(key=lambda p: (p['coordinate'][0], p['coordinate'][1]))
    for c in curves:
        c.pop('pixels')

    result = {
        'status': 'exact',
        'message': 'Read from the drawing instructions inside the PDF, not from the picture: values are exact to about 0.01.',
        'axis_labels': {'x': [_number(w['text']) for w in x_labels], 'y': [_number(w['text']) for w in y_labels]},
        'axis_span': _span(to_graph, (left + .05, upper + .05, right - .05, lower - .05),
                           [_number(w['text']) for w in x_labels], [_number(w['text']) for w in y_labels], x_step, y_step),
        'curves': curves,
        'points': points,
        'blank_grid': not curves and not points,
        # Where the graph's own text sits (frame plus axis numbers and labels), in PDF
        # points from the top-left, so other tools can tell it apart from page text.
        # The margin covers axis names such as x and y beside the arrow tips.
        'text_box': [round(v, 2) for v in (
            min([left] + [w['x0'] for w in x_labels + y_labels]) - 14,
            min([upper] + [w['top'] for w in x_labels + y_labels]) - 14,
            max([right] + [w['x1'] for w in x_labels + y_labels]) + 14,
            max([lower] + [w['bottom'] for w in x_labels + y_labels]) + 14)],
    }
    result['summary'] = describe(result)
    return result


def _span(to_graph, frame, x_values, y_values, x_step, y_step):
    """The drawn range. Axis arrows overshoot the last label slightly; then the labels win."""
    left, upper, right, lower = frame
    xs = [to_graph((left, 0))[0], to_graph((right, 0))[0]]
    ys = [to_graph((0, lower))[1], to_graph((0, upper))[1]]
    lo_x, hi_x = min(x_values), max(x_values)
    lo_y, hi_y = min(y_values), max(y_values)
    x0 = lo_x if 0 < lo_x - xs[0] <= .3 * x_step else xs[0]
    x1 = hi_x if 0 < xs[1] - hi_x <= .3 * x_step else xs[1]
    y0 = lo_y if 0 < lo_y - ys[0] <= .3 * y_step else ys[0]
    y1 = hi_y if 0 < ys[1] - hi_y <= .3 * y_step else ys[1]
    return {'x': [_clean(x0), _clean(x1)], 'y': [_clean(y0), _clean(y1)]}


def _pt(p):
    return f'({_fmt(p[0])}, {_fmt(p[1])})'


def _fmt(v):
    return ('−' if v < 0 else '') + (f'{abs(v):.2f}'.rstrip('0').rstrip('.'))


def _join(items):
    items = list(items)
    return items[0] if len(items) == 1 else ', '.join(items[:-1]) + ' and ' + items[-1]


def _continues(c):
    if not c['continues']:
        return ''
    if len(c['continues']) == 2:
        return ' Arrows show it continues past both ends.'
    rightward = c['start'][0] <= c['end'][0]
    at_start = c['continues'] == ['start']
    return f" An arrow shows it continues past its {'left' if at_start == rightward else 'right'} end."


def describe(result):
    span = result['axis_span']
    sentences = [f"The graph shows x from {_fmt(span['x'][0])} to {_fmt(span['x'][1])} and y from "
                 f"{_fmt(span['y'][0])} to {_fmt(span['y'][1])}."]
    if result['blank_grid']:
        sentences.append('No curves or points are drawn: this is a blank grid, probably space for your answer.')
    for c in result['curves']:
        style = ('dashed ' if c['dashed'] else '') + c['color']
        kind = 'line' if c['kind'] == 'straight pieces' else 'curve'
        name = f"{c['label']} ({style})" if c['label'] else f'A {style} {kind}'
        more = _continues(c)
        if c['kind'] == 'straight pieces' and len(c['corners']) == 2:
            (xa, ya), (xb, yb) = c['corners']
            if abs(xa - xb) < .02:
                sentences.append(f"{name} is a vertical line at x = {_fmt(xa)}, from y = {_fmt(min(ya, yb))} to {_fmt(max(ya, yb))}.{more}")
            elif abs(ya - yb) < .02:
                sentences.append(f"{name} is a horizontal line at y = {_fmt(ya)}, from x = {_fmt(min(xa, xb))} to {_fmt(max(xa, xb))}.{more}")
            else:
                sentences.append(f"{name} is a straight line from {_pt(c['corners'][0])} to {_pt(c['corners'][1])}.{more}")
        elif c['kind'] == 'straight pieces':
            sentences.append(f"{name} is made of straight pieces joining {_join(_pt(p) for p in c['corners'])}.{more}")
        else:
            parts = [f"{name} runs from {_pt(c['start'])} to {_pt(c['end'])}."]
            if c['turning_points']:
                parts.append('It turns at ' + _join(f"a {t['kind']} near {_pt(t['at'])}" for t in c['turning_points']) + '.')
            if c['crosses_x_axis_at']:
                parts.append('It crosses the x-axis near x = ' + _join(_fmt(z) for z in c['crosses_x_axis_at']) + '.')
            sentences.append(' '.join(parts) + more)
    for p in result['points']:
        colour = f"{p['color']} " if p['color'] not in (None, 'black') else ''
        sentences.append(f"A {colour}{p['kind']} is at {_pt(p['coordinate'])}.")
    return ' '.join(sentences)
