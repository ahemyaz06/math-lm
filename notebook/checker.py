"""Compare an AI transcription (Markdown + LaTeX) with the text built into the PDF.

The PDF's own text has the right symbols in a jumbled layout: x^2 comes out as
"x" then "2", fractions are flattened. Turning the transcription's LaTeX into the
same flat symbol stream lets the two be compared character by character.
Everything here is plain rules; no AI is involved in checking the AI.
"""
from difflib import SequenceMatcher
import re
import unicodedata

# LaTeX commands that print a symbol, written the way PDF text shows them.
SYMBOLS = {
    'cdot': '·', 'times': '×', 'div': '÷', 'circ': '∘', 'pm': '±', 'mp': '∓',
    'neq': '≠', 'ne': '≠', 'le': '≤', 'leq': '≤', 'ge': '≥', 'geq': '≥',
    'to': '→', 'rightarrow': '→', 'Rightarrow': '⇒', 'implies': '⇒', 'leftarrow': '←',
    'infty': '∞', 'approx': '≈', 'sim': '∼', 'equiv': '≡', 'in': '∈', 'notin': '∉',
    'cup': '∪', 'cap': '∩', 'subset': '⊂', 'emptyset': '∅', 'varnothing': '∅',
    'int': '∫', 'sum': '∑', 'prod': '∏', 'partial': '∂', 'nabla': '∇', 'prime': "'",
    'ldots': '...', 'cdots': '···', 'dots': '...', 'angle': '∠', 'degree': '°',
    'alpha': 'α', 'beta': 'β', 'gamma': 'γ', 'delta': 'δ', 'Delta': 'Δ', 'epsilon': 'ϵ',
    'varepsilon': 'ε', 'theta': 'θ', 'Theta': 'Θ', 'lambda': 'λ', 'mu': 'μ', 'pi': 'π',
    'Pi': 'Π', 'rho': 'ρ', 'sigma': 'σ', 'Sigma': 'Σ', 'tau': 'τ', 'phi': 'ϕ',
    'varphi': 'φ', 'omega': 'ω', 'Omega': 'Ω', 'lvert': '|', 'rvert': '|', 'vert': '|',
    'mid': '|', '|': '‖', '{': '{', '}': '}', '%': '%', '$': '$', '&': '&', '#': '#',
    ',': '', ';': '', ':': '', '!': '', ' ': '',
}
# Function names print as their letters.
NAMES = {'sin', 'cos', 'tan', 'sec', 'csc', 'cot', 'arcsin', 'arccos', 'arctan', 'sinh',
         'cosh', 'tanh', 'ln', 'log', 'exp', 'lim', 'max', 'min', 'det', 'deg', 'sup', 'inf'}
# Commands that only change layout or style; their argument (if any) is kept.
DROP = {'left', 'right', 'big', 'Big', 'bigg', 'Bigg', 'displaystyle', 'textstyle',
        'quad', 'qquad', 'limits', 'nolimits', 'hline', 'boxed', 'mathrm', 'mathbf',
        'mathit', 'mathbb', 'mathcal', 'text', 'textbf', 'textit', 'mbox', 'operatorname',
        'bm', 'boldsymbol', 'underline', 'overline', 'hat', 'bar', 'vec', 'tilde', 'dot',
        'ddot', 'widehat', 'overrightarrow', 'cancel', 'tfrac', 'dfrac', 'frac', 'sqrt',
        'binom', 'stackrel', 'overset', 'underset', 'phantom', 'hspace', 'vspace',
        'begin', 'end', 'label', 'tag', 'notag', 'nonumber', 'newline'}

_TOKEN = re.compile(r'\\([A-Za-z]+|.)|([{}^_&~])|(\\\\)|(.)', re.S)


def latex_to_plain(latex):
    """Flatten LaTeX into the symbol order a PDF text layer typically shows."""
    out = []
    i = 0
    tokens = [m for m in _TOKEN.finditer(latex)]
    skip_group = 0  # environment names after \begin/\end are not printed
    while i < len(tokens):
        m = tokens[i]
        cmd, special, _newline, char = m.group(1), m.group(2), m.group(3), m.group(4)
        if cmd is not None:
            if cmd in ('begin', 'end'):
                skip_group = 1
            elif cmd == 'sqrt':
                out.append('√')
                # \sqrt[n]{x}: the index is printed small before the radical in PDFs; drop it.
                if i + 1 < len(tokens) and tokens[i + 1].group(4) == '[':
                    while i + 1 < len(tokens) and tokens[i + 1].group(4) != ']':
                        i += 1
                    i += 1
            elif cmd in NAMES:
                out.append(cmd)
            elif cmd in SYMBOLS:
                out.append(SYMBOLS[cmd])
            elif cmd in DROP or cmd == '\\':
                pass
            else:
                out.append(cmd)  # unknown command: keep its letters so differences show up
        elif special is not None:
            if special == '{' and skip_group:
                # Skip the environment name, e.g. {cases}; arrays and tables also have a
                # column layout such as {ccc} or {r|l} that is not printed.
                while True:
                    depth, i = 1, i + 1
                    name = []
                    while i < len(tokens) and depth:
                        g = tokens[i].group(2)
                        depth += (g == '{') - (g == '}')
                        if depth and tokens[i].group(4):
                            name.append(tokens[i].group(4))
                        i += 1
                    if ''.join(name).rstrip('*') in ('array', 'tabular', 'alignat') and \
                            i < len(tokens) and tokens[i].group(2) == '{':
                        continue
                    break
                skip_group = 0
                continue
            # braces, ^, _, & and ~ only arrange things on the page
        elif char is not None and not char.isspace():
            out.append(char)
        i += 1
    return ''.join(out)


def normalize(text):
    """One spelling per symbol; no whitespace; case-insensitive."""
    text = text.replace('̸=', '≠').replace('≠', '≠')
    text = unicodedata.normalize('NFKC', text)
    for variants, canonical in (('−–—‐', '-'), ('∗', '*'), ('⋅•', '·'), ('◦', '∘'),
                                ('′’‘`', "'"), ('“”', '"'), ('ε', 'ϵ'), ('φ', 'ϕ')):
        for v in variants:
            text = text.replace(v, canonical)
    kept = []
    for ch in text:
        cat = unicodedata.category(ch)
        if ch.isspace() or cat in ('Cc', 'Cf', 'Co', 'Cn', 'Mn', 'Zs'):
            continue  # layout, soft hyphens, private-use bracket pieces
        kept.append(ch)
    return ''.join(kept).casefold()


_FENCE = re.compile(r'^\s*```')
_FIGURE = re.compile(r'^\s*\[FIGURE\b', re.I)
_INLINE = re.compile(r'\$\$(.+?)\$\$|\$(.+?)\$|\\\((.+?)\\\)|\\\[(.+?)\\\]')


def markdown_segments(markdown):
    """Yield (text, is_math, line_number) for the parts of the page to check.

    Figure blocks are AI descriptions of pictures; the PDF has no text for them,
    so they are left out of the comparison.
    """
    lines = markdown.splitlines()
    in_display, display, display_start, in_figure = False, [], 0, False
    for n, line in enumerate(lines):
        stripped = line.strip()
        if _FENCE.match(line):
            continue
        if in_figure:
            if not stripped:
                in_figure = False
            elif stripped.startswith('|') and not re.fullmatch(r'\|[\s:|-]+\|', stripped):
                # Table cells are real page text, so they are checked; descriptions are not.
                for cell in stripped.strip('|').split('|'):
                    yield from _inline_segments(cell, n)
            elif is_table_row(stripped):
                yield ' '.join(table_cells(stripped)), False, n
            continue
        if _FIGURE.match(line):
            in_figure = True
            continue
        if in_display:
            if stripped.endswith('$$') or stripped.endswith('\\]'):
                display.append(stripped[:-2])
                yield ' '.join(display), True, display_start
                in_display, display = False, []
            else:
                display.append(line)
            continue
        if (stripped.startswith('$$') and not stripped.endswith('$$')) or stripped == '$$' or \
           (stripped.startswith('\\[') and not stripped.endswith('\\]')):
            in_display, display, display_start = True, [stripped[2:]], n
            continue
        if stripped.startswith('|') and stripped.endswith('|'):
            if not re.fullmatch(r'\|[\s:|-]+\|', stripped):
                for cell in stripped.strip('|').split('|'):
                    yield from _inline_segments(cell, n)
            continue
        yield from _inline_segments(line, n)
    if display:
        yield ' '.join(display), True, display_start


_CELL = re.compile(r"^(?:[-−]?\d+(?:\.\d+)?|[A-Za-z]'*\([a-z]\)|[a-z]|\$[^$]+\$)$")


def table_cells(line):
    """Cells of a table row in any of the forms the reader writes: '| 1 | 3 |',
    '1 3 2', '1, 3, 2' or 'Row 2: 1, 3, 2'. None for prose."""
    body = re.sub(r'^\s*row\s*\d+\s*:\s*', '', line.strip(), flags=re.I).strip('|')
    cells = [c for c in re.split(r'\s*[|,]\s*|\s+', body) if c]
    if len(cells) >= 3 and sum(bool(_CELL.match(c)) for c in cells) >= .8 * len(cells):
        return cells
    return None


def is_table_row(line):
    return table_cells(line) is not None


def _inline_segments(line, n):
    pos = 0
    for m in _INLINE.finditer(line):
        if m.start() > pos:
            yield _plain_markdown(line[pos:m.start()]), False, n
        yield next(g for g in m.groups() if g is not None), True, n
        pos = m.end()
    if pos < len(line):
        yield _plain_markdown(line[pos:]), False, n


def _plain_markdown(text):
    text = re.sub(r'\[([^\]]*)\]\([^)]*\)', r'\1', text)  # a link reads as its words
    text = re.sub(r'^\s{0,3}#{1,6}\s*', '', text)
    text = re.sub(r'^\s*(---+|\*\*\*+)\s*$', '', text)
    text = re.sub(r'^\s*[-*+]\s+', '', text)  # bullet markers; numbered "1." stays
    return text.replace('**', '').replace('__', '').replace('`', '')


def _stream(markdown):
    chars, lines, math = [], [], []
    for text, is_math, line in markdown_segments(markdown):
        flat = normalize(latex_to_plain(text) if is_math else text)
        chars.append(flat)
        lines.extend([line] * len(flat))
        math.extend([is_math] * len(flat))
    return ''.join(chars), lines, math


_SIGNIFICANT = re.compile(r'[0-9a-zα-ωϵϕ+\-=<>≠≤≥√/^∞π∫∑×÷±→]', re.I)
# In ordinary words only letters and digits matter: "R-I-T" and "R·I·T" are the same.
_SIGNIFICANT_TEXT = re.compile(r'[0-9a-zα-ω]', re.I)
# LaTeX-made PDFs store some symbols as other characters in their text layer:
# the radical sign comes out as r, p, q or s and the prime in f' as 0.
_SAME_IN_PDF = {('√', 'r'), ('√', 'p'), ('√', 'q'), ('√', 's'), ("'", '0'), ('·', '.'), ('·', '-'),
                ('[', 'h'), (']', 'i')}  # big brackets come out as h and i


def _equivalent(ai_part, pdf_part):
    return len(ai_part) == len(pdf_part) and all(a == b or (a, b) in _SAME_IN_PDF for a, b in zip(ai_part, pdf_part))


# Running heads and feet that, like page numbers, readers leave out: "243" alone,
# "3.5 • Derivatives of Trigonometric Functions 243", "310 3 • Exercises",
# "Access for free at openstax.org".
_RUNNING = re.compile(r'\s*(page\s*)?\d{1,4}\s*|\s*\d{1,4}\s+[\d.]*\s*[•·].*|.*[•·].*\s\d{1,4}\s*|.*access for free at .*', re.I)


def _strip_running_lines(markdown):
    """Blank out a running head the reader copied on its first or last line. Lines keep
    their numbers, so review notes still land on the right block."""
    lines = markdown.splitlines()
    filled = [n for n, l in enumerate(lines) if l.strip()]
    for n in filled[:1] + filled[-1:]:
        if _RUNNING.fullmatch(_plain_markdown(lines[n]).strip()):
            lines[n] = ''
    return '\n'.join(lines)


def strip_page_numbers(pdf_text):
    """Drop page numbers and running heads on the first and last lines."""
    lines = pdf_text.strip().splitlines()
    while lines and _RUNNING.fullmatch(lines[-1]):
        lines.pop()
    while lines and _RUNNING.fullmatch(lines[0]):
        lines.pop(0)
    return '\n'.join(lines)


def compare(pdf_text, markdown, context=12, math_fonts=None):
    """Return where the transcription and the PDF's own text disagree.
    math_fonts: whether the page uses a maths font (None when unknown).

    A flag means "listen to this one carefully", not proof of an error: the PDF
    layer itself can be out of order. Differences in brackets and punctuation
    only are not flagged, because PDF layers often drop large brackets.
    """
    ai, ai_lines, ai_math = _stream(_strip_running_lines(markdown))
    pdf = normalize(strip_page_numbers(pdf_text or ''))
    if len(pdf) < 20:
        return {'checked': False, 'reason': 'This PDF page has no text layer to check against.',
                'agreement': None, 'flags': []}
    matcher = SequenceMatcher(None, ai, pdf, autojunk=False)
    spans = []
    for op, i1, i2, j1, j2 in matcher.get_opcodes():
        if op == 'equal':
            continue
        ai_part, pdf_part = ai[i1:i2], pdf[j1:j2]
        at = min(i1, len(ai_lines) - 1) if ai_lines else 0
        in_math = any(ai_math[max(0, i1 - 1):max(i2, i1 + 1)]) if ai_math else False
        if not (_SIGNIFICANT if in_math else _SIGNIFICANT_TEXT).search(ai_part + pdf_part):
            continue
        if op == 'replace' and _equivalent(ai_part, pdf_part):
            continue
        line = ai_lines[at] if ai_lines else 0
        # Differences a few characters apart are one mistake ("split" read as "spilt").
        last = spans[-1] if spans else None
        if last and last[4] == line and i1 - last[1] <= 3 and j1 - last[3] <= 3:
            last[1], last[3], last[5] = i2, j2, last[5] or in_math
            continue
        spans.append([i1, i2, j1, j2, line, in_math])
    flags = []
    for i1, i2, j1, j2, line, in_math in spans:
        ai_part, pdf_part = ai[i1:i2], pdf[j1:j2]
        kind = 'different' if ai_part and pdf_part else 'extra' if ai_part else 'missing'
        flags.append({
            'line': line, 'math': in_math, 'kind': kind,
            'ai': ai_part[:60], 'pdf': pdf_part[:60],
            # A one-letter difference is easier to hear inside its neighbours: "homwork" / "homework".
            'ai_near': ai[max(0, i1 - 3):i2 + 3], 'pdf_near': pdf[max(0, j1 - 3):j2 + 3],
            'ai_context': ai[max(0, i1 - context):i2 + context][:90],
            'pdf_context': pdf[max(0, j1 - context):j2 + context][:90],
        })
    flags = _drop_moved(flags, ai, pdf)
    # Some PDFs (OpenStax textbooks, for example) draw every formula as shapes, so their
    # text has the words but no maths. Every equation would then be flagged. Measure how
    # much of the reader's maths the PDF text contains; if it is under half, only words
    # are checked and the page says its equations could not be.
    # A page set with maths fonts (LaTeX's CMMI/CMSY, Cambria Math...) has its maths in
    # the text and is always checked; without them, chance digit matches can make drawn
    # maths look half-present, so the bar is higher.
    math_total = sum(ai_math)
    math_found = sum(sum(ai_math[i:i + size]) for i, _j, size in matcher.get_matching_blocks())
    needed = {True: 0.0, False: MATH_VISIBLE_NO_MATH_FONT}.get(math_fonts, MATH_VISIBLE)
    math_checked = math_total < MIN_MATH_TO_JUDGE or math_found >= needed * math_total
    if not math_checked:
        flags = [f for f in flags if not f['math']]
    return {'checked': True, 'agreement': round(matcher.ratio(), 4), 'flags': flags, 'math_checked': math_checked,
            'math_in_pdf_text': round(math_found / math_total, 3) if math_total else None}


MIN_MATH_TO_JUDGE = 30  # characters of maths; below this a page is judged by its words anyway
MATH_VISIBLE = 0.5      # share of the reader's maths found in the PDF text (fonts unknown)
MATH_VISIBLE_NO_MATH_FONT = 0.8  # same, for a page with no maths font (OpenStax: 0-53%)
MATH_FONT = re.compile(r'CMMI|CMSY|CMEX|CMBSY|MSAM|MSBM|EUFM|RSFS|STIX|Math|Symbol', re.I)


def has_math_fonts(fontnames):
    """True when any of the page's font names is a maths font."""
    return any(MATH_FONT.search(name or '') for name in fontnames)


def _canonical(text):
    for a, b in _SAME_IN_PDF:
        text = text.replace(a, '').replace(b, '') if a == '√' else text.replace(a, b)
    return text


def _drop_moved(flags, ai, pdf):
    """Text the PDF stores in another order (a table beside the questions, a caption
    above a figure) shows up as 'missing' in one place and 'extra' in another. If the
    piece is found elsewhere on the other side, it was moved, not misread."""
    ai_c, pdf_c = _canonical(ai), _canonical(pdf)
    kept = []
    for f in flags:
        if f['kind'] == 'missing' and len(f['pdf']) >= 4 and _canonical(f['pdf']) in ai_c:
            continue
        if f['kind'] == 'extra' and len(f['ai']) >= 4 and _canonical(f['ai']) in pdf_c:
            continue
        kept.append(f)
    return kept


def describe(flag):
    """One short sentence for a screen reader."""
    where = 'equation' if flag['math'] else 'text'
    short = len(flag['ai']) <= 2 and len(flag['pdf']) <= 2
    ai, pdf = (flag['ai_near'], flag['pdf_near']) if short else (flag['ai'], flag['pdf'])
    if flag['kind'] == 'different' or short:
        return f"In this {where}, the reader wrote “{ai}” where the PDF has “{pdf}”."
    if flag['kind'] == 'extra':
        return f"In this {where}, the reader wrote “{ai}”, which the PDF does not have."
    return f"Near this {where}, the PDF has “{pdf}”, which the reader left out."
