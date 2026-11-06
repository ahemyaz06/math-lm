"""Checking what the PDF reader read, by typesetting it again (Tectonic).

LaTeX only goes from source to page, so the reader has to guess the source from where the
characters sit. Each guess can be checked: typeset the reading and look at it beside the page.
If every character is there, in the same order, raised or lowered by the same amount, and every
fraction bar and root covers the same characters, the reading is the page. Spacing is not
compared: a \\, before dx or a \\left( read as ( changes it and not the maths.

When an equation does not match, readings near it are tried (an exponent read as a subscript,
a root or fraction that reaches one character more or less, a root's index) and one is kept
only if it matches the page exactly. Nothing is guessed: what does not match stays as read.

Tectonic is found at TECTONIC, tools/tectonic/tectonic.exe next to the notebook folder, or on
the PATH; without it nothing is checked. Its first run downloads the TeX packages it needs.
"""
from pathlib import Path
import difflib
import hashlib
import os
import re
import shutil
import statistics
import subprocess
import tempfile

import pdf_text_reader as reader

HERE = Path(__file__).resolve().parent
CACHE = Path(tempfile.gettempdir()) / 'math-notebook-retypeset'


def find_tectonic():
    for p in [os.environ.get('TECTONIC'), HERE.parent / 'tools' / 'tectonic' / 'tectonic.exe',
              HERE / 'tools' / 'tectonic.exe', shutil.which('tectonic')]:
        if p and Path(p).is_file():
            return str(p)
    return None


def typeset(tex):
    """The PDF of a whole .tex document (cached by its text), or (None, the error)."""
    key = hashlib.sha256(tex.encode('utf8')).hexdigest()[:20]
    CACHE.mkdir(parents=True, exist_ok=True)
    pdf = CACHE / f'{key}.pdf'
    if pdf.exists():
        return pdf, None
    src = CACHE / f'{key}.tex'
    src.write_text(tex, encoding='utf8')
    run = subprocess.run([find_tectonic(), '--chatter', 'minimal', '--outdir', str(CACHE), str(src)],
                         capture_output=True, text=True, encoding='utf8', errors='replace',
                         creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if run.returncode or not pdf.exists():
        return None, (run.stderr or run.stdout).strip()[-600:]
    return pdf, None


# ---------- what a part of a page shows ----------

def marks(page, box=None, margin=1.5):
    """The characters and rules of a page (or of a box on it): characters as (name, x0, x1,
    baseline, size, tall), named as the reader names them, so a tall bracket and a plain one,
    a sum by its code or by its name, are the same thing; rules as (x0, x1, y)."""
    rules = []
    for r in list(page.rects) + list(page.lines):
        w, h = r['x1'] - r['x0'], r['bottom'] - r['top']
        y = (r['top'] + r['bottom']) / 2
        if h <= 1.5 and w >= 2 and (not box or (box[0] - margin <= (r['x0'] + r['x1']) / 2 <= box[2] + margin
                                                and box[1] - margin <= y <= box[3] + margin)):
            rules.append((r['x0'], r['x1'], y))
    glyphs = []
    for c in page.chars:
        if not c.get('upright', True) or (not c['text'].strip() and not (c['text'] == ' ' and 'CMEX' in c['fontname'].upper())):
            continue
        a = reader._glyph(c, [])
        if box:
            # Across: its middle inside the box (the full stop after "x = 1." is the sentence's).
            # Up and down: its middle inside, or for a root sign (whose box is set above where
            # it is drawn) any overlap, when its rule starts at it in the box.
            if not box[0] - .3 <= a.cx <= box[2] + .3:
                continue
            middle = box[1] - margin <= (a.top + a.bottom) / 2 <= box[3] + margin
            if not middle and not (a.tex == '\\surd' and a.top < box[3] and a.bottom > box[1] - margin
                                   and any(abs(r[0] - a.x1) < 3 for r in rules)):
                continue
        # (A big-symbol glyph also carries how tall it is drawn, in ems: which size of bracket.)
        tall = round((a.bottom - a.top) / a.size, 2) if 'CMEX' in c['fontname'].upper() else 0
        glyphs.append((a.tex, a.x0, a.x1, a.base, a.size, tall))
    # A frame around the formula (\boxed) is no fraction bar: it reaches past its characters.
    # A rule drawn twice counts once.
    if glyphs:
        left, right = min(g[1] for g in glyphs), max(g[2] for g in glyphs)
        rules = [r for r in rules if not (r[0] < left - 1.5 and r[1] > right + 1.5)]
    rules = sorted({(round(r[0], 1), round(r[1], 1), round(r[2], 1)) for r in rules})
    # Duplicates (a PDF may draw a character twice for boldness) count once.
    glyphs = _one_symbol(sorted(set(glyphs), key=lambda g: (round(g[1], 1), g[3])))
    # Only fraction bars (characters over and under them) and roots' rules (a root sign at
    # their start) are maths; a frame around part of a line or an underline is not.
    def maths_rule(r):
        over = [g for g in glyphs if r[0] - .8 <= (g[1] + g[2]) / 2 <= r[1] + .8]
        root = any(g[0] == '\\surd' and abs(g[2] - r[0]) < 3 for g in glyphs)
        return root or (any(0 < r[2] - g[3] < 2.2 * g[4] for g in over) and any(0 < g[3] - r[2] < 2.6 * g[4] for g in over))
    rules = [r for r in rules if maths_rule(r)]
    return _reading_order(glyphs, rules), rules


def _one_symbol(glyphs):
    """What is drawn in pieces, as one symbol: a tall brace from its top, middle and bottom
    pieces (or one glyph: the same brace), a tall bracket or bar from its stacked pieces, a
    slashed = (whether \\ne or \\not =)."""
    out = []
    for g in glyphs:
        name = '\\{' if g[0] in '⎧⎨⎩⎪' else '\\}' if g[0] in '⎫⎬⎭' else g[0]
        last = out[-1] if out else None
        if last and name == last[0] and name in BRACKETS and g[5] and last[5] and abs(g[1] - last[1]) < 1:
            out[-1] = (name, last[1], max(last[2], g[2]), min(last[3], g[3]), last[4], last[5] + g[5])
            continue
        out.append((name,) + g[1:])
    for s in [g for g in out if g[0] == '̸']:
        partner = min((g for g in out if g[0] != '̸' and abs(g[3] - s[3]) < 2 and s[1] - 2 <= g[1] <= s[1] + 6),
                      key=lambda g: abs(g[1] - s[1]), default=None)
        if partner:
            out[out.index(partner)] = ('\\not' + partner[0],) + partner[1:]
    return [g for g in out if g[0] != '̸']


def _reading_order(glyphs, rules):
    """Glyphs in the order their LaTeX is written: left to right, and a fraction's top before
    its bottom (by position alone the two interleave, differently for every spacing)."""
    def covered(gs, r):
        return [g for g in gs if r[0] - .8 <= (g[1] + g[2]) / 2 <= r[1] + .8 and abs(g[3] - r[2]) < 2.6 * g[4]]

    def order(gs, rs):
        # The rows of a piecewise function, top to bottom, each as written.
        brace = next((g for g in gs if g[0] == '\\{' and g[5] >= 1.5 and not any(h[0] == '\\}' and h[1] > g[1] for h in gs)), None)
        if brace:
            top, bottom = brace[3], brace[3] + brace[5] * brace[4]
            rows_part = [g for g in gs if g[1] > brace[1] and top - .5 * brace[4] <= g[3] <= bottom + .5 * brace[4]]
            if rows_part:
                def line_of(g):
                    bar = next((r for r in rs if r[0] - .8 <= (g[1] + g[2]) / 2 <= r[1] + .8 and abs(g[3] - r[2]) < 1.6 * g[4]), None)
                    return bar[2] if bar else g[3] - .25 * g[4]
                keyed = sorted(rows_part, key=line_of)
                rows, last = [], None
                for g in keyed:
                    if last is None or line_of(g) - last > 1.2 * g[4]:
                        rows.append([])
                    rows[-1].append(g)
                    last = line_of(g)
                left = [g for g in gs if g not in rows_part and g is not brace and g[1] < brace[1]]
                right = [g for g in gs if g not in rows_part and g is not brace and g not in left]
                return order(left, rs) + [brace] + [g for row in rows for g in order(row, rs)] + order(right, rs)
        for r in sorted(rs, key=lambda r: r[0] - r[1]):  # the widest first: the outermost
            inside = covered(gs, r)
            top = [g for g in inside if g[3] < r[2]]
            bottom = [g for g in inside if g[3] >= r[2]]
            if not top or not bottom:
                continue  # a root's rule: what is under it is in line
            rest = [o for o in rs if o is not r]
            left = [g for g in gs if g not in inside and (g[1] + g[2]) / 2 < r[0]]
            right = [g for g in gs if g not in inside and g not in left]
            return order(left, rest) + order(top, rest) + order(bottom, rest) + order(right, rest)
        return sorted(gs, key=lambda g: (round(g[1], 1), g[3]))
    return order(glyphs, rules)


def differences(page_marks, read_marks):
    """What differs between a part of the page and the typeset reading ([] when nothing):
    characters missing or extra, raised or lowered differently, or a different size; rules
    covering different characters."""
    (ga, ra), (gb, rb) = page_marks, read_marks
    if not ga:
        return []
    sm = difflib.SequenceMatcher(None, [g[0] for g in ga], [g[0] for g in gb], autojunk=False)
    pairs, why = [], []
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == 'equal':
            pairs += list(zip(range(i1, i2), range(j1, j2)))
        else:
            why.append(f'{op} {"".join(g[0] for g in ga[i1:i2]) or "-"} / {"".join(g[0] for g in gb[j1:j2]) or "-"}')
    if not pairs:
        return why or ['nothing in common']
    # The two are typeset at different places, and the rows of a piecewise function or of an
    # aligned derivation may be spaced differently: each character's height is compared with
    # its neighbours'. One exponent read as a subscript stands out among them.
    # (Small print, a label in a drawing, is typeset at the text size: one scale for all.)
    scale = statistics.median(ga[i][4] / gb[j][4] for i, j in pairs)
    shifts = [ga[i][3] - scale * gb[j][3] for i, j in pairs]
    for n, (i, j) in enumerate(pairs):
        a, b = ga[i], gb[j]
        shift = statistics.median(shifts[max(0, n - 4):n + 5])
        if abs(shifts[n] - shift) > max(.6, .06 * a[4]) or abs(a[4] - scale * b[4]) > .7:
            why.append(f'{a[0]} at another height or size')
    to_b = dict(pairs)

    def covered(glyphs, rule):
        x0, x1, y = rule
        return {k for k, g in enumerate(glyphs) if x0 - .8 <= (g[1] + g[2]) / 2 <= x1 + .8 and abs(g[3] - y) < 1.8 * g[4]}
    b_sets = [covered(gb, r) for r in rb]
    for r in ra:
        want = {to_b[k] for k in covered(ga, r) if k in to_b}
        if want and want not in b_sets:
            why.append('a fraction bar or root covers different characters')
    if len(ra) != len(rb):
        why.append(f'{len(ra)} bars on the page, {len(rb)} in the reading')
    return why


# ---------- brackets at the page's sizes ----------

BRACKETS = {'(': 'l', '[': 'l', '\\{': 'l', ')': 'r', ']': 'r', '\\}': 'r', '|': '', '\\|': ''}
SIZES = ((1.5, '\\big'), (2.1, '\\Big'), (2.7, '\\bigg'), (99, '\\Bigg'))


def _bracket_tokens(tex):
    """(start, end, bracket) of each bracket in tex, leaving out the [ ] of \\sqrt[3]."""
    out, k, index_depth = [], 0, 0
    while k < len(tex):
        if tex.startswith('\\sqrt[', k):
            k += 6
            index_depth += 1
            continue
        if tex[k] == ']' and index_depth:
            index_depth -= 1
            k += 1
            continue
        two = tex[k:k + 2]
        if two in ('\\{', '\\}', '\\|'):
            out.append((k, k + 2, two))
            k += 2
            continue
        if tex[k] == '\\':
            m = re.match(r'\\[A-Za-z]+|\\.', tex[k:])
            k += m.end()
            continue
        if tex[k] in '()[]|':
            out.append((k, k + 1, tex[k]))
        k += 1
    return out


def dress(tex, page_glyphs):
    """tex with its brackets at the sizes the page has them (\\bigl( for a tall one), so that
    typeset it matches the page when it is right: a tall bracket raises the exponent after it.
    Only when the page's brackets and the reading's are the same in number and kind."""
    page = []
    for g in page_glyphs:
        if g[0] in BRACKETS:
            # The pieces of one tall bracket, stacked, count once.
            if page and page[-1][0] == g[0] and abs(page[-1][1] - g[1]) < 1 and g[5]:
                page[-1] = (g[0], g[1], page[-1][2] + g[5])
            else:
                page.append((g[0], g[1], g[5]))
    toks = _bracket_tokens(tex)
    if '\\begin{cases}' in tex:
        # The brace of a piecewise function is the environment's, not a bracket in the reading.
        page = [p for p in page if p[0] != '\\{'] if tex.count('\\begin{cases}') else page
    if len(toks) != len(page) or any(t[2] != p[0] for t, p in zip(toks, page)):
        return tex
    out, last = [], 0
    for (start, end, br), (_ch, _x, tall) in zip(toks, page):
        out.append(tex[last:start])
        if tall and not re.search(r'\\(left|right)\s*$', tex[:start]):
            size = next(name for limit, name in SIZES if tall < limit)
            out.append(f'{size}{BRACKETS[br]}{br}')
        else:
            out.append(br)
        last = end
    return ''.join(out) + tex[last:]


# ---------- typesetting the readings of a page ----------

def _document(items, size):
    option = min(((10, '10pt'), (10.95, '11pt'), (12, '12pt')), key=lambda o: abs(o[0] - size))[1]
    pages = []
    for latex in items:
        # Each reading twice: as a display and in a sentence (a line of its own on the page may
        # be either), each on a page of its own.
        pages.append(f'\\[ {latex} \\]')
        pages.append(f'${latex}$')
    body = '\n\\newpage\n'.join(f'\\noindent\n{p}' for p in pages)
    return (f'\\documentclass[{option}]{{article}}\n\\usepackage{{amsmath,amssymb}}\n'
            '\\usepackage[paperwidth=150cm,paperheight=40cm,margin=2cm]{geometry}\n'
            f'\\pagestyle{{empty}}\n\\begin{{document}}\n{body}\n\\end{{document}}\n')


def _typeset_all(items, size):
    """For each LaTeX reading, the marks of its two typeset pages, or None if it does not typeset."""
    import pdfplumber
    if not items:
        return []
    pdf, _err = typeset(_document(items, size))
    if pdf:
        with pdfplumber.open(pdf) as doc:
            if len(doc.pages) == 2 * len(items):
                out = []
                for k in range(len(items)):
                    out.append([marks(doc.pages[2 * k]), marks(doc.pages[2 * k + 1])])
                return out
    # One that does not typeset spoils the rest: each alone.
    return [(_typeset_all([latex], size) or [None])[0] if len(items) > 1 else None for latex in items]


def check_page(page, equations):
    """For each equation the reader found on a page: (verdict, reading), verdict 'same' when
    the typeset reading matches the page, 'fixed' when a reading near it matches and is given
    instead, 'differs' when neither does, 'not typeset' when the reading is not LaTeX TeX takes.
    """
    if not equations or not find_tectonic():
        return []
    size = statistics.median(e['size'] for e in equations)
    on_page = [marks(page, e['box']) for e in equations]
    # The reading as it is, and drawn the other ways the same maths can be (\dfrac for a
    # fraction set large in a line): any that matches says the reading is right.
    tries = [(k, d) for k, e in enumerate(equations) for d in [e['latex'], *drawings(e['latex'])]]
    typed = _typeset_all([dress(d, on_page[k][0]) for k, d in tries], size)
    results = [None] * len(equations)
    typed_first = {}  # the reading itself, typeset (first of its drawings)
    for (k, _d), both in zip(tries, typed):
        typed_first.setdefault(k, both)
        if both and any(not differences(on_page[k], t) for t in both):
            results[k] = ('same', equations[k]['latex'])
    for k, e in enumerate(equations):
        if results[k] is None:
            typeset_at_all = any(both for (j, _d), both in zip(tries, typed) if j == k)
            results[k] = ('differs' if typeset_at_all else 'not typeset', e['latex'])
    # Readings near the ones that differ (and each drawn large), all typeset at once. One is
    # kept only if it matches the page. When none does, the one closest to the page is the
    # start of the next step (a word read with a subscript in a numerator and in a denominator
    # takes two steps), up to three steps.
    current = {k: (equations[k]['latex'], None) for k, (v, _) in enumerate(results) if v != 'same'}
    for _step in range(3):
        if not current:
            break
        # (Each as written and with its fractions large: the drawings most sources use, so that
        # a page with a misreading still takes seconds.)
        tries = [(k, alt, drawn) for k, (tex, _score) in current.items() for alt in alternatives(tex)
                 for drawn in [alt, *drawings(alt)[:1]]]
        typed = _typeset_all([dress(drawn, on_page[k][0]) for k, _alt, drawn in tries], size)
        best = {}
        for (k, alt, _drawn), both in zip(tries, typed):
            if not both or results[k][0] == 'fixed':
                continue
            score = min(len(differences(on_page[k], t)) for t in both)
            if score == 0:
                results[k] = ('fixed', alt)
            elif k not in best or score < best[k][1]:
                best[k] = (alt, score)
        nxt = {}
        for k, (alt, score) in best.items():
            if results[k][0] == 'fixed':
                continue
            before = current[k][1]
            if before is None:
                # How far the reading itself is from the page.
                before = min((len(differences(on_page[k], t)) for t in (typed_first[k] or [])), default=10 ** 6)
            if score < before:
                nxt[k] = (alt, score)
        current = nxt
    return results


def drawings(tex):
    """The same maths drawn the other ways a source may draw it: every fraction large
    (\\dfrac), or small (\\tfrac), or all but the outermost large."""
    out = []
    if '\\frac' in tex:
        first = tex.index('\\frac') + len('\\frac')
        out += [tex.replace('\\frac', '\\dfrac'), tex.replace('\\frac', '\\tfrac'),
                tex[:first] + tex[first:].replace('\\frac', '\\dfrac')]
    # Brackets as \left ... \right pairs (\left[ g(x) \right]^2 sets its 2 a little higher).
    paired = _left_right(tex)
    if paired != tex:
        out += [paired] + ([paired.replace('\\frac', '\\dfrac')] if '\\frac' in paired else [])
    return out


def _left_right(tex):
    """tex with each pair of brackets written \\left( ... \\right)."""
    toks = _bracket_tokens(tex)
    stack, pairs = [], []
    for t in toks:
        if BRACKETS[t[2]] == 'l':
            stack.append(t)
        elif BRACKETS[t[2]] == 'r' and stack:
            pairs.append((stack.pop(), t))
    if stack or not pairs:
        return tex
    marks_at = sorted([(o[0], '\\left') for o, _c in pairs] + [(c[0], '\\right') for _o, c in pairs], reverse=True)
    for at, word in marks_at:
        tex = tex[:at] + word + tex[at:]
    return tex


# ---------- readings near a reading ----------

def _groups(tex):
    """Spans (start, end) of every {...} group in tex, with the command or script mark before it."""
    out, stack = [], []
    for k, ch in enumerate(tex):
        if ch == '{' and (k == 0 or tex[k - 1] != '\\'):
            stack.append(k)
        elif ch == '}' and (k == 0 or tex[k - 1] != '\\') and stack:
            out.append((stack.pop(), k))
    return sorted(out)


TOKEN = re.compile(r'\\[A-Za-z]+|\\.|[A-Za-z0-9]|[^\s{}]')


def alternatives(tex, limit=60):
    """Readings one step from tex, the ways the reader can go wrong: a script raised or
    lowered the other way, a script that is no script, a root or fraction part that ends
    one token earlier or later, a root's index read as an exponent after it."""
    alts = []

    def add(t):
        if t != tex and t not in alts:
            alts.append(t)
    # ^ and _ swapped, one at a time.
    for m in re.finditer(r'(?<!\\)[\^_]', tex):
        add(tex[:m.start()] + ('_' if m.group() == '^' else '^') + tex[m.end():])
    # \sqrt{x}^{3} and \sqrt{x}3: the index read after the root.
    for m in re.finditer(r'\\sqrt\{', tex):
        groups = [g for g in _groups(tex) if g[0] == m.end() - 1]
        if not groups:
            continue
        end = groups[0][1]
        rest = tex[end + 1:]
        idx = re.match(r'\^\{([^{}]+)\}|\^(\w)|\s*(\w)', rest)
        if idx:
            index = next(g for g in idx.groups() if g)
            add(tex[:m.start()] + f'\\sqrt[{index}]{{{tex[m.end():end]}}}' + rest[idx.end():])
    # A group (root, numerator, denominator, script) one token longer or shorter.
    for start, end in _groups(tex):
        inside = tex[start + 1:end]
        after = tex[end + 1:]
        nxt = TOKEN.match(after.lstrip())
        if nxt and not nxt.group().startswith(('\\frac', '\\end', '&')) and nxt.group() not in ('=', '\\\\'):
            gap = len(after) - len(after.lstrip())
            add(tex[:end] + after[:gap] + nxt.group() + '}' + after[gap + nxt.end():])
        toks = list(TOKEN.finditer(inside))
        if len(toks) > 1:
            last = toks[-1]
            if not inside[:last.start()].rstrip().endswith(('\\frac', '^', '_')):
                add(tex[:start + 1] + inside[:last.start()].rstrip() + '}' + inside[last.start():] + tex[end + 1:])
    # A mark set over a relation (\stackrel{?}{=}, "is it equal?") read as its exponent.
    for m in re.finditer(r'(=|\\ne|<|>|\\le|\\ge|\\to)\s*\^\{([^{}]+)\}', tex):
        add(tex[:m.start()] + f'\\stackrel{{{m.group(2)}}}{{{m.group(1)}}}' + tex[m.end():])
    # A script that is no script: x^{2} as x 2 (two items side by side).
    for m in re.finditer(r'(?<!\\)[\^_]\{([^{}]*)\}', tex):
        add(tex[:m.start()] + ' ' + m.group(1) + tex[m.end():])
    return alts[:limit]


def fix_markdown(markdown, equations, results):
    """The page's Markdown with each fixed reading put in place of the one it replaces."""
    for e, (verdict, latex) in zip(equations, results):
        if verdict != 'fixed':
            continue
        # The formula itself, as a display or in a sentence; a part of one only where a
        # sentence's formula was joined from two lines (its halves were checked one by one).
        for old, new in ((f'$${e["latex"]}$$', f'$${latex}$$'), (f'${e["latex"]}$', f'${latex}$')):
            m = re.search(r'(?<!\$)' + re.escape(old) + r'(?!\$)' if old.count('$') == 2 else re.escape(old), markdown)
            if m:
                markdown = markdown[:m.start()] + new + markdown[m.end():]
                break
        else:
            if e['latex'] in markdown:
                markdown = markdown.replace(e['latex'], latex, 1)
    return markdown
