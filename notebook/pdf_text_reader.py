"""Read a page of a LaTeX-made PDF into Markdown + LaTeX by rules, without AI.

LaTeX PDFs keep every character with its font, size and position. The fonts say what a
character is (CMMI: math letter, CMSY: math symbol, CMEX: big delimiter, CMR: text or
upright math) and the positions say how the math is laid out:
- a smaller character raised or lowered next to another is an exponent or a subscript;
- characters centred above and below a thin horizontal rule are a fraction;
- a radical sign with a rule running from its top is a square root over what is under it;
- a tall brace built from pieces (top, middle, bottom) is a piecewise definition.
So the page can be rebuilt exactly, in a fraction of a second, and it cannot invent
anything. Pages whose math is drawn as shapes (OpenStax) or scanned have nothing to read
here; the caller sends those to the AI.
"""
from collections import Counter
from dataclasses import dataclass, field, replace
import math
import re
import statistics

VERSION = 10  # 10: a small letter on the line after a word is no subscript ("units of y"); formulas located for reading_check
# 9: big symbols placed as drawn, fractions in fractions, piecewise rows, formulas broken across lines
# 8: displayed sums and integrals with limits, tall roots and brackets (found by re-typesetting)
# 7: \cdots, slanted fractions, a sentence's bracket outside the maths
# 6: fine print is not the text size, primes, scripts in large headings, tables without hline
# 5: an unread drawing is said, not read as one-letter equations
# 4: root indexes, roots in denominators, raised exponents, underlined words
# 3: a small fraction in a line is no longer read as an exponent

MATH_FONT = re.compile(r'CMMI|CMSY|CMEX|CMBSY|MSAM|MSBM|EUFM|EUSM|RSFS|LMMath|Math|Symbol', re.I)
BOLD_FONT = re.compile(r'CMBX|CMB\d|Bold', re.I)

# Character codes of TeX's math fonts that PDF readers leave unnamed ("(cid:48)").
CMSY_CODES = {0: '−', 1: '·', 2: '×', 3: '∗', 4: '÷', 6: '±', 7: '∓', 14: '◦', 15: '•', 17: '≡', 20: '≤', 21: '≥',
              24: '∼', 25: '≈', 32: '←', 33: '→', 41: '⇐', 42: '⇒', 44: '⇔', 48: '′', 49: '∞', 50: '∈', 54: '̸',
              56: '∀', 57: '∃', 59: '∅', 91: '∪', 92: '∩', 102: '{', 103: '}', 104: '⟨', 105: '⟩', 106: '|',
              107: '‖', 112: '√'}
CMEX_CODES = {0: '(', 1: ')', 2: '[', 3: ']', 4: '⌊', 5: '⌋', 6: '⌈', 7: '⌉', 8: '{', 9: '}', 10: '⟨', 11: '⟩',
              12: '|', 13: '‖', 16: '(', 17: ')', 18: '(', 19: ')', 20: '[', 21: ']', 22: '⌊', 23: '⌋', 24: '⌈',
              25: '⌉', 26: '{', 27: '}', 28: '⟨', 29: '⟩', 32: '(', 33: ')', 34: '[', 35: ']', 40: '{', 41: '}',
              48: '⎛', 49: '⎞', 50: '⎡', 51: '⎤', 52: '⎣', 53: '⎦', 54: '⎢', 55: '⎥', 56: '⎧', 57: '⎫',
              58: '⎩', 59: '⎭', 60: '⎨', 61: '⎬', 62: '⎪', 64: '⎝', 65: '⎠', 66: '⎜', 67: '⎟',
              80: '∑', 81: '∏', 82: '∫', 88: '∑', 89: '∏', 90: '∫', 104: '[', 105: ']', 106: '⌊', 107: '⌋',
              108: '⌈', 109: '⌉', 110: '{', 111: '}', 112: '√', 113: '√', 114: '√', 115: '√', 116: '√'}
# Adobe's private-use names for delimiter pieces, as some PDF readers report them.
PRIVATE = {'': '⎛', '': '⎜', '': '⎝', '': '⎡', '': '⎢', '': '⎣',
           '': '⎧', '': '⎨', '': '⎩', '': '⎪', '': '⎞', '': '⎟',
           '': '⎠', '': '⎤', '': '⎥', '': '⎦', '': '⎫', '': '⎬', '': '⎭'}
LIGATURES = {'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', '“': '"', '”': '"', '‘': "'", '’': "'"}
T1_LIGATURES = {27: 'ﬀ', 28: 'ﬁ', 29: 'ﬂ', 30: 'ﬃ', 31: 'ﬄ'}
PIECES = {'⎛': '(', '⎜': '(', '⎝': '(', '⎞': ')', '⎟': ')', '⎠': ')', '⎡': '[', '⎢': '[', '⎣': '[',
          '⎤': ']', '⎥': ']', '⎦': ']'}
BRACE_PIECES = set('⎧⎨⎩⎪')

GREEK = {'α': 'alpha', 'β': 'beta', 'γ': 'gamma', 'δ': 'delta', 'ϵ': 'epsilon', 'ε': 'varepsilon', 'ζ': 'zeta',
         'η': 'eta', 'θ': 'theta', 'ϑ': 'vartheta', 'ι': 'iota', 'κ': 'kappa', 'λ': 'lambda', 'μ': 'mu', 'ν': 'nu',
         'ξ': 'xi', 'π': 'pi', 'ϖ': 'varpi', 'ρ': 'rho', 'ϱ': 'varrho', 'σ': 'sigma', 'ς': 'varsigma', 'τ': 'tau',
         'υ': 'upsilon', 'ϕ': 'phi', 'φ': 'varphi', 'χ': 'chi', 'ψ': 'psi', 'ω': 'omega', 'Γ': 'Gamma',
         'Δ': 'Delta', '∆': 'Delta', 'Θ': 'Theta', 'Λ': 'Lambda', 'Ξ': 'Xi', 'Π': 'Pi', 'Σ': 'Sigma',
         'Υ': 'Upsilon', 'Φ': 'Phi', 'Ψ': 'Psi', 'Ω': 'Omega'}
SYMBOLS = {'−': '-', '·': '\\cdot', '×': '\\times', '∗': '*', '÷': '\\div', '±': '\\pm', '∓': '\\mp', '◦': '\\circ',
           '∘': '\\circ', '•': '\\bullet', '≡': '\\equiv', '≤': '\\le', '≥': '\\ge', '∼': '\\sim', '≈': '\\approx',
           '←': '\\leftarrow', '→': '\\to', '⇐': '\\Leftarrow', '⇒': '\\Rightarrow', '⇔': '\\Leftrightarrow',
           '′': "'", '∞': '\\infty', '∈': '\\in', '∀': '\\forall', '∃': '\\exists', '∅': '\\emptyset',
           '∪': '\\cup', '∩': '\\cap', '{': '\\{', '}': '\\}', '⟨': '\\langle', '⟩': '\\rangle', '‖': '\\|',
           '∑': '\\sum', '∏': '\\prod', '∫': '\\int', '∂': '\\partial', '∇': '\\nabla', '≠': '\\ne',
           '⌊': '\\lfloor', '⌋': '\\rfloor', '⌈': '\\lceil', '⌉': '\\rceil', '√': '\\surd', '%': '\\%',
           '#': '\\#', '&': '\\&', '$': '\\$', '_': '\\_', '⊂': '\\subset', '⊆': '\\subseteq', '¬': '\\neg',
           '∧': '\\wedge', '∨': '\\vee', '…': '\\ldots', '⋯': '\\cdots', '|': '|', '–': '-',
           **{k: '\\' + v for k, v in GREEK.items()}}
FUNCTIONS = {'sin', 'cos', 'tan', 'sec', 'csc', 'cot', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh',
             'ln', 'log', 'exp', 'lim', 'max', 'min', 'sup', 'inf', 'det', 'gcd', 'deg'}
BIG_OPERATORS = ('\\lim', '\\sum', '\\prod', '\\max', '\\min', '\\sup', '\\inf')
# Maths in a sentence that ends a line with an operator or relation (TeX breaks only there).
INLINE_BREAK = re.compile(r'(?<!\$)\$[^$]*(?:[-+=<>]|\\(?:cdot|times|le|ge|ne|pm|to|approx|in))\s*\$$')
LABEL = re.compile(r'^(?:\d{1,3}\.|\([a-z]{1,4}\)|\(\d{1,2}\)|[a-z]\))$')
PROBLEM_LABEL = re.compile(r'^(?:\d{1,3}\.|\([a-z]{1,4}\))$')
SCRIPT = 0.82  # a character this much smaller than its line is a script


@dataclass
class Atom:
    tex: str            # LaTeX when used in math
    text: str           # plain text when used in prose
    x0: float
    x1: float
    top: float
    bottom: float
    base: float         # baseline, in points from the top of the page
    size: float
    cls: str            # 'm' math, 'L' text letter, 'n' neutral (digits, punctuation, = + ( ))
    ch: str = ''
    bold: bool = False
    floating: bool = False  # big delimiters and built pieces: placed by their box, not baseline
    sub: list = field(default_factory=list)
    sup: list = field(default_factory=list)

    @property
    def cx(self):
        return (self.x0 + self.x1) / 2

    @property
    def cy(self):
        return (self.top + self.bottom) / 2

    @property
    def right(self):
        return max([self.x1] + [a.x1 for a in self.sub + self.sup])


def join_tex(parts):
    out = ''
    for p in parts:
        if not p:
            continue
        if out and re.search(r'\\[A-Za-z]+$', out) and re.match(r'[A-Za-z0-9]', p):
            out += ' '
        out += p
    return out


# ---------- characters ----------

# A big symbol named by its character, not its code: its width (in ems) says which size it is.
CMEX_WIDTHS = {
    '(': ((.458, 1.2), (.597, 1.8), (.736, 2.4), (.791, 3.0)), ')': ((.458, 1.2), (.597, 1.8), (.736, 2.4), (.791, 3.0)),
    '[': ((.416, 1.2), (.472, 1.8), (.527, 2.4), (.583, 3.0)), ']': ((.416, 1.2), (.472, 1.8), (.527, 2.4), (.583, 3.0)),
    '{': ((.583, 1.2), (.666, 1.8), (.75, 2.4), (.805, 3.0)), '}': ((.583, 1.2), (.666, 1.8), (.75, 2.4), (.805, 3.0)),
    '∑': ((1.056, 1.0), (1.444, 1.4)), '∏': ((.944, 1.0), (1.278, 1.4)), '∫': ((.556, 1.7),),  # text and display integrals have one width
    '√': ((.833, 1.2), (1.0, 1.8)), '|': ((.333, .6),), '‖': ((.5, .6),),
}


def cmex_depth(code, ch, width=None):
    """How far below its origin a big-symbol (CMEX) glyph is drawn, in ems. Its ink starts at
    its origin (measured in pdfTeX and Tectonic PDFs); its box does not say where (it is placed
    differently by each program). From TeX's cmex10 tables."""
    if code is None:
        # The pieces tall brackets and braces are built from: tops and bottoms 1.8 em, the
        # stretches 0.6 (bracket) or 0.3 (brace), the brace's ends and middle 0.9.
        for pieces, depth in (('⎛⎞⎡⎤⎣⎦⎝⎠', 1.8), ('⎜⎟⎢⎥', .6), ('⎧⎩⎫⎭⎨⎬', .9), ('⎪', .3)):
            if ch in pieces:
                return depth
        sizes = CMEX_WIDTHS.get(ch)
        if sizes and width:
            return min(sizes, key=lambda s: abs(s[0] - width))[1]
        return 1.2
    if code in (12, 13, 62, 63, 117, 118) or code >= 119:
        return .6  # the pieces a tall bar, brace or arrow is stretched with
    if code in (72, 82):
        return 1.11  # text-style integrals
    if code in (73, 90):
        return 2.22  # displayed integrals
    if 72 <= code <= 97:
        # Big operators: text style 1, display 1.4 (74-79 alternate; 80-87 and 96 are text).
        text = (code < 80 and code % 2 == 0) or 80 <= code <= 87 or code == 96
        return 1.0 if text else 1.4
    if 98 <= code <= 103:
        return .3  # wide accents
    for last, depth in ((15, 1.2), (17, 1.8), (31, 2.4), (47, 3.0), (55, 1.8), (61, .9), (67, 1.8), (71, 1.2),
                        (111, 1.8), (112, 1.2), (113, 1.8), (114, 2.4), (115, 3.0)):
        if code <= last:
            return depth
    return 1.8


def _glyph(c, notes):
    font = c['fontname'].split('+')[-1]
    t = c['text']
    code = None
    if t.startswith('(cid:'):
        code = int(t[5:-1])
        # A text font with no table of its own (pdflatex T1 fonts without cmap): in the T1
        # encoding codes 27 to 31 are always the ligatures ff, fi, fl, ffi and ffl.
        table = CMEX_CODES if 'CMEX' in font.upper() else CMSY_CODES if 'SY' in font.upper() else {} if MATH_FONT.search(font) else T1_LIGATURES
        t = table.get(code)
        if t is None:
            notes.append(f'an unknown symbol (code {code} in font {font})')
            t = '?'
    elif 'CMEX' in font.upper() and len(t) == 1 and t.isascii() and ord(t) in CMEX_CODES and (
            t not in r'()[]{}|/\<>' or t in '<>'
            # ( and ) are also codes 40 and 41, the tallest braces: told apart by their width
            # (0.805 em; the tallest round bracket is 0.791, measured in Tectonic PDFs)
            or (t in '()' and abs((c['x1'] - c['x0']) / c['size'] - .805) < .007)):
        # A big-symbol font named by its own codes (Tectonic, XeLaTeX): the letter Z is the
        # display integral, X the display sum, " and # tall brackets, < and > the middle and
        # stretch of a tall brace. CMEX has no letters.
        code = ord(t)
        t = CMEX_CODES[code]
    t = PRIVATE.get(t, t)
    is_math = bool(MATH_FONT.search(font))
    big = 'CMEX' in font.upper() or t in BRACE_PIECES or t in PIECES
    if t == '•' and not is_math:
        cls = 'n'  # a list bullet
    elif t == '-' and not is_math:
        cls = 'L'  # a hyphen ("x-intercept"); a minus sign is − in a maths font
    elif t in GREEK or t in SYMBOLS and not t.isascii():
        cls = 'm'
    elif is_math:
        cls = 'm'
    elif t.isalpha() or t in LIGATURES:
        cls = 'L'
    else:
        cls = 'n'
    tex = SYMBOLS.get(t, PIECES.get(t, t))
    if is_math and 'MSBM' in font.upper() and t.isalpha():
        tex = f'\\mathbb{{{t}}}'
    elif cls == 'm' and BOLD_FONT.search(font) and t.isalnum():
        tex = f'\\mathbf{{{t}}}'
    base = c['top'] + (c['y1'] - c['matrix'][5])
    top, bottom = c['top'], c['bottom']
    if 'CMEX' in font.upper():
        # Where it is drawn: from its origin down.
        top, bottom = base, base + cmex_depth(code, t, (c['x1'] - c['x0']) / c['size']) * c['size']
    return Atom(tex=tex, text=LIGATURES.get(t, t), x0=c['x0'], x1=c['x1'], top=top, bottom=bottom,
                base=base, size=c['size'], cls=cls, ch=t, bold=bool(BOLD_FONT.search(font)), floating=big)


def _inside(box, x, y):
    return box[0] <= x <= box[2] and box[1] <= y <= box[3]


# ---------- rows ----------

def _base_size(atoms):
    """The size of a formula's main line: its largest ordinary character, or built piece (the
    fraction of (1/x)^2, whose 2 is then small beside it), or big operator (a sum over a fraction
    of fractions, whose limits are small beside it)."""
    sizes = [a.size for a in atoms if not a.floating or not a.ch or a.ch in '∑∏∫']
    return max(sizes) if sizes else max((a.size for a in atoms), default=10)


def _mode_size(atoms):
    sizes = Counter(round(a.size, 1) for a in atoms if not a.floating)
    if not sizes:
        return max((a.size for a in atoms), default=10)
    mode, count = sizes.most_common(1)[0]
    # A long footnote or credit in fine print (8pt) is not the page's text when about as much is
    # in 9-13pt: measured against 8pt, a 7pt exponent or prime was a line of its own ($$'$$).
    if mode < 9:
        normal = [(n, s) for s, n in sizes.items() if 9 <= s <= 13 and n >= .5 * count]
        if normal:
            return max(normal)[1]
    return mode


def cluster(atoms, body=None):
    """Group atoms into rows that share a baseline. Scripts and floating pieces join the
    row they belong to; anything left over forms rows of its own."""
    if not atoms:
        return []
    body = body or _base_size(atoms)
    # A prime is a script of what is before it (f' is f^{\prime}), whatever its size.
    # In large type (a heading "Derivative of y = sin^{-1} x") a script is body-sized: it is a
    # script because it is small next to the large character it is raised or lowered from.
    large = [b for b in atoms if not b.floating and b.size > body * 1.1]
    # (Its baseline is within the large character's height: a letter of the next line is not.)
    raised = {id(a) for a in atoms if a.size >= SCRIPT * body and not a.floating and a.cls != 'L' and any(
        a.size < SCRIPT * b.size and -1 <= a.x0 - b.x1 <= .45 * b.size and .15 * b.size < abs(a.base - b.base)
        and b.base - .75 * b.size <= a.base <= b.base + .35 * b.size for b in large)}
    # ... and so is what follows it on its line at its size (the 1 of ^{-1}).
    grow = [a for a in atoms if id(a) in raised]
    while grow:
        s = grow.pop()
        for a in atoms:
            if id(a) not in raised and a.cls != 'L' and not a.floating and abs(a.size - s.size) < .1 and abs(a.base - s.base) < .1 * s.size and -1 <= a.x0 - s.x1 <= .3 * s.size:
                raised.add(id(a))
                grow.append(a)
    # (A fraction of fractions has small characters but is no script: it is taller than two lines.)
    tall = lambda a: a.floating and not a.ch and a.bottom - a.top > 1.8 * body  # noqa: E731
    script = lambda a: (a.size < SCRIPT * body and not tall(a)) or (a.ch and a.ch in '′″‴') or id(a) in raised  # noqa: E731
    anchors = sorted((a for a in atoms if not a.floating and not script(a)), key=lambda a: a.base)
    rows = []
    for a in anchors:
        if rows and abs(a.base - rows[-1]['base']) <= .3 * body:
            rows[-1]['atoms'].append(a)
        else:
            rows.append({'base': a.base, 'atoms': [a]})
    floats = [a for a in atoms if a.floating and not script(a)]
    left_over = []
    # A line with something right beside the piece: "Find it." far to the left of a displayed
    # fraction or integral is the line above it, not its line.
    beside = lambda r, f: any(a.x0 - 2 * body <= f.x1 and f.x0 <= a.x1 + 2 * body for a in r['atoms'])  # noqa: E731
    # Built pieces (fractions, roots) first: one on no line is a line of its own at once, so a
    # bracket around it (\left(\frac{1}{x}\right)) finds it beside it.
    for f in sorted(floats, key=lambda f: bool(f.ch)):
        if f.ch:
            # A big bracket, bar or operator is centred on the maths axis of its line (a little
            # above the baseline): of the lines whose baseline it spans, the one with something
            # beside it, centred best.
            near = [r for r in rows if f.top - .2 * body <= r['base'] <= f.bottom + .2 * body]
            near = [r for r in near if beside(r, f)] or near
            if near:
                min(near, key=lambda r: abs(r['base'] - .25 * body - f.cy))['atoms'].append(f)
                continue
        near = [r for r in rows if f.top - .15 * body <= r['base'] <= f.bottom + .15 * body]
        near = near or [r for r in rows if abs(r['base'] - f.cy) <= 1.2 * body]
        if not f.ch:
            # ... or one on its baseline (a wide fraction between d/dx and the = after it).
            near = [r for r in near if beside(r, f)] or [r for r in near if abs(r['base'] - f.base) <= .35 * body]
        if near:
            min(near, key=lambda r: abs(r['base'] - f.base))['atoms'].append(f)
        elif not f.ch:
            own = next((r for r in rows if r.get('own') and abs(f.base - r['base']) <= .4 * f.size), None)
            if own:
                own['atoms'].append(f)
            else:
                rows.append({'base': f.base, 'atoms': [f], 'own': True})
        else:
            left_over.append(f)
    smalls = sorted((a for a in atoms if script(a)), key=lambda a: a.x0)
    for s in smalls:
        # The limits of a displayed sum or product are set well above and below it, and those of
        # a displayed integral at its lower right: they belong to the operator's row.
        limits = [r for r in rows if -2 * body <= s.base - r['base'] <= 2 * body and any(
            a.floating and a.ch and a.ch in '∑∏∫' and a.x0 - .3 * body <= s.cx <= a.x1 + (.5 if a.ch == '∫' else .3) * body
            for a in r['atoms'])]
        if limits:
            min(limits, key=lambda r: abs(s.base - r['base']))['atoms'].append(s)
            continue
        candidates = [r for r in rows if -1.0 * body <= s.base - r['base'] <= 1.05 * body]
        # An exponent on big brackets or a fraction ((1/2)^x) is raised higher than one on a
        # letter; it may join a row that far up only if it touches something just to its left.
        higher = [r for r in rows if -1.6 * body <= s.base - r['base'] < -1.0 * body]

        def touches(r):
            for a in r['atoms']:
                if s.x0 - .45 * body <= a.x1 <= s.x0 + .8 and a.top - .6 * body <= s.base <= a.bottom + .9 * body:
                    return True  # something just to its left: a script of it
                if a.x0 - .8 * body <= s.cx <= a.x1 + .8 * body and r['base'] + .3 * body < s.base < r['base'] + 1.05 * body:
                    return True  # under an operator: limits
            return False
        touching = [r for r in candidates if touches(r)] or [r for r in higher if touches(r)]
        pool = touching or [r for r in candidates if abs(s.base - r['base']) <= .6 * body]
        if pool:
            min(pool, key=lambda r: abs(s.base - r['base']))['atoms'].append(s)
        else:
            left_over.append(s)
    for a in sorted(left_over, key=lambda a: a.base):
        for r in rows:
            if r.get('own') and abs(a.base - r['base']) <= .4 * a.size:
                r['atoms'].append(a)
                break
        else:
            rows.append({'base': a.base, 'atoms': [a], 'own': True})
    rows.sort(key=lambda r: r['base'])
    return [sorted(r['atoms'], key=lambda a: a.x0) for r in rows]


def attach_scripts(row):
    """Turn a row into base items with their subscripts and superscripts attached."""
    if not row:
        return []
    for a in row:
        a.sub, a.sup = [], []
    ref = _base_size(row)
    bigs = [a for a in row if a.size >= SCRIPT * ref]
    # Right after a tall closing bracket, what sits wholly above its middle is its exponent,
    # small or not: in a numerator, the -1 of (2/a)^{-1} is the size of the 2 and the a.
    raised = set()
    for d in [b for b in row if b.floating and b.ch in ')]}|']:
        end = d.x1
        for a in sorted((b for b in bigs if not b.floating and b.x0 >= d.x1 - .5), key=lambda b: b.x0):
            if a.x0 - end > .3 * ref or a.bottom > d.cy:
                break
            d.sup.append(a)
            raised.add(id(a))
            end = a.x1
    bigs = [a for a in bigs if id(a) not in raised]
    # The baseline from letters, else from built pieces (a fraction): a big bracket's box sits
    # above where it is drawn, so its own "baseline" would make the ^2 of (1/x)^2 a subscript.
    anchored = [a for a in bigs if not a.floating] or [a for a in bigs if not a.ch] or bigs
    line = statistics.median(a.base for a in anchored)
    smalls = [a for a in row if a not in bigs and id(a) not in raised]
    # A built root or fraction from above the maths axis to below the baseline is on the line,
    # however small its characters (\sqrt{\frac{y}{x}} in a numerator is not the exponent of
    # the + before it; the raised x/n of e^{x/n} ends above the baseline).
    across = [a for a in smalls if a.floating and not a.ch and a.top < line - .5 * ref and a.bottom > line + .1 * ref]
    bigs += across
    smalls = [a for a in smalls if a not in across]
    under =[s for s in smalls if s.base > line + .45 * ref]
    over = [s for s in smalls if s.base < line - .8 * ref]
    # Limits under and over operators (lim, sum) span the operator: attach each group to
    # the last character it lies under.
    for group_atoms, role in ((under, 'sub'), (over, 'sup')):
        for group in _x_groups(group_atoms, .6 * ref):
            lo, hi = min(a.x0 for a in group), max(a.x1 for a in group)
            # (A bracket only when centred on it: the -1 of (e^b)^{-1} touches the next bracket
            # but is not over it.)
            hosts = [b for b in bigs if b.x1 > lo - 1 and b.x0 < hi + 1
                     and (b.ch not in ')]}|' or b.x0 - 1 <= (lo + hi) / 2 <= b.x1 + 1)]
            if hosts:
                getattr(max(hosts, key=lambda b: b.x0), role).extend(group)
                for a in group:
                    smalls.remove(a)
    host = None
    for a in sorted(row, key=lambda a: a.x0):
        if a in bigs:
            host = a
            continue
        if a not in smalls:
            continue
        # A small fraction written in the line (text-style \frac{1}{x}, digits of size 7)
        # sits on the maths axis; only one clearly raised above it is an exponent (e^{1/x}).
        if a.tex.startswith('\\frac') and a.floating and a.base > line - .3 * ref:
            host = a
            continue
        target = host or a
        if target is a:
            continue  # a script with nothing before it stays a plain item (below)
        if abs(a.base - line) < .08 * ref and target.cls == 'L':
            continue  # small but on the line, after a word: "units of y" in a small numerator
        (target.sup if a.base < line else target.sub).append(a)
    attached = {id(s) for b in bigs for s in b.sub + b.sup} | raised
    return [a for a in sorted(row, key=lambda a: a.x0) if a in bigs or id(a) not in attached]


def _x_groups(atoms, gap):
    groups = []
    for a in sorted(atoms, key=lambda a: a.x0):
        if groups and a.x0 - max(b.x1 for b in groups[-1]) <= gap:
            groups[-1].append(a)
        else:
            groups.append([a])
    return groups


# ---------- items, words and the math/text decision ----------

def _script_tex(atoms, role):
    if role == 'sup' and atoms and all(a.ch == '′' for a in atoms):
        return "'" * len(atoms)
    # Scripts stop shrinking at the third level (2^{3^{4^t}}: the 4 and the t are one size),
    # so an exponent there is only raised: a character touching the one before it and set
    # clearly higher is that character's exponent.
    ordered = sorted(atoms, key=lambda a: a.x0)
    for k in range(1, len(ordered)):
        left, a = ordered[k - 1], ordered[k]
        if (role == 'sup' and abs(a.size - left.size) < .1 and abs(a.x0 - left.x1) < .8
                and a.base < left.base - .3 * a.size):
            raised = replace(left, tex=left.tex + _script_tex(ordered[k:], 'sup'), ch='', sub=[], sup=[],
                             x1=max(b.x1 for b in ordered[k - 1:]))
            return _script_tex(ordered[:k - 1] + [raised], role)
    inner = math_latex(atoms)
    return f'{"^" if role == "sup" else "_"}{{{inner}}}'


def _item_tex(a, upright_word=None):
    tex = upright_word if upright_word is not None else a.tex
    sub = _script_tex(a.sub, 'sub') if a.sub else ''
    sup = _script_tex(a.sup, 'sup') if a.sup else ''
    if sup.startswith("'"):
        return tex + sup + sub
    return tex + sub + sup


def _words(items, body):
    words = []
    for a in items:
        if words and a.x0 - words[-1][-1].right <= .15 * max(a.size, body * .7) and not a.floating:
            words[-1].append(a)
        elif words and a.floating and a.x0 - words[-1][-1].right <= .05 * body:
            words[-1].append(a)
        else:
            words.append([a])
    return words


def _pieces(word):
    """Split a word at the boundary between text letters and everything else."""
    pieces = []
    for a in word:
        kind = 'L' if a.cls == 'L' else 'x'
        if pieces and pieces[-1][0] == kind:
            pieces[-1][1].append(a)
        else:
            pieces.append([kind, [a]])
    return pieces


def segments(items, body, math_context=False):
    """Decide which parts of a row are math and which are text.
    Returns a list of (kind, words) with kind 'M' or 'T'; each word is a list of
    (atoms, role) pieces."""
    marked = []  # (word index, atoms, kind) kind in M, T, N
    words = _words(items, body)
    for w, word in enumerate(words):
        text = ''.join(a.text for a in word)
        # (A label "(a)" has no exponents or tall brackets: (x^{1/2})^3 is maths.)
        if w == 0 and not math_context and LABEL.match(text) and not any(a.sub or a.sup or a.floating for a in word):
            marked.append([w, word, 'T'])
            continue
        parts = _pieces(word)
        for k, (kind, atoms) in enumerate(parts):
            if kind == 'L':
                name = ''.join(a.text for a in atoms)
                # A function name needs math right after it: "ln(2", "sin x", not "cm/min."
                after = parts[k + 1][1] if k + 1 < len(parts) else (words[w + 1] if w + 1 < len(words) else [])
                neighbours = bool(after) and (after[0].cls == 'm' or after[0].ch in '([{' or after[0].ch.isdigit())
                if name in FUNCTIONS and (neighbours or atoms[-1].sub or atoms[-1].sup):
                    marked.append([w, atoms, 'F'])
                elif any(a.sub or a.sup for a in atoms):
                    marked.append([w, atoms, 'M'])  # upright letters with scripts are math
                else:
                    marked.append([w, atoms, 'T'])
            elif any(a.cls == 'm' or a.sub or a.sup or a.floating for a in atoms):
                marked.append([w, atoms, 'M'])
            elif any(p[0] == 'L' and ''.join(a.text for a in p[1]) not in FUNCTIONS for p in parts):
                marked.append([w, atoms, 'T'])  # punctuation stuck to a word: "is," "(that"
            else:
                marked.append([w, atoms, 'N'])
    # Functions with scripts or next to math are math.
    for m in marked:
        if m[2] == 'F':
            m[2] = 'M'
    changed = True
    while changed:
        changed = False
        for i, m in enumerate(marked):
            if m[2] != 'N':
                continue
            text = ''.join(x.text for x in m[1])
            # An opening bracket joins the math after it, a closing one the math before it.
            sides = (i + 1,) if set(text) <= set('([{') else (i - 1,) if set(text) <= set(')]}.,;:') else (i - 1, i + 1)
            if any(0 <= j < len(marked) and marked[j][2] == 'M' for j in sides):
                m[2] = 'M'
                changed = True
    for m in marked:
        if m[2] == 'N':
            m[2] = 'M' if math_context else 'T'
    # Sentence punctuation that closes a math run belongs to the text.
    for i, m in enumerate(marked):
        if math_context:
            break
        if m[2] == 'M' and (i + 1 == len(marked) or marked[i + 1][2] == 'T'):
            tail = m[1]
            if tail and tail[-1].ch and tail[-1].ch in '.,;:' and not tail[-1].sub and not tail[-1].sup:
                if len(tail) == 1:
                    if i > 0 and marked[i - 1][2] == 'M':
                        m[2] = 'T'
                else:
                    marked.insert(i + 1, [m[0], [tail[-1]], 'T'])
                    m[1] = tail[:-1]
    runs = []
    for w, atoms, kind in marked:
        if runs and runs[-1][0] == kind:
            runs[-1][1].append((w, atoms))
        else:
            runs.append([kind, [(w, atoms)]])
    return runs


def _math_run_tex(pieces):
    parts, last_word, last_right = [], None, None
    for w, atoms in pieces:
        if last_word is not None and w != last_word:
            wide = atoms[0].x0 - last_right > 1.5 * max(atoms[0].size, 7)
            parts.append(' \\quad ' if wide else ' ')
        last_word, last_right = w, max(a.right for a in atoms)
        if all(a.cls == 'L' for a in atoms):
            name = ''.join(a.text for a in atoms)
            if name in FUNCTIONS:
                parts.append(_item_tex(atoms[-1], '\\' + name))
            else:
                parts.append(f'\\mathrm{{{name}}}' if len(atoms) > 1 else atoms[0].text)
                if atoms[-1].sub or atoms[-1].sup:
                    parts[-1] = _item_tex(atoms[-1], parts[-1])
            continue
        for a in atoms:
            parts.append(_item_tex(a))
    # \cdots is printed as three centred dots: one symbol, said "dot dot dot", not "times times times".
    tex = re.sub(r'\\cdot(?: *\\cdot){2}(?![a-z])', r'\\cdots', re.sub(r' {2,}', ' ', join_tex(parts)))
    # A slanted fraction (\nicefrac{\pi}{2}): the top raised, a slash, the bottom lowered.
    return re.sub(r'\^\{([^{}]+)\}\s*/\s*_\{([^{}]+)\}', r'\\tfrac{\1}{\2}', tex).strip()


def _text_run(pieces):
    words, last_word = [], None
    for w, atoms in pieces:
        chunk = ''.join(a.text for a in atoms)
        bold = all(a.bold for a in atoms if a.text.strip())
        if last_word == w and words:
            words[-1] = (words[-1][0] + chunk, words[-1][1] and bold)
        else:
            words.append((chunk, bold))
        last_word = w
    out, in_bold = [], False
    for chunk, bold in words:
        if bold and not in_bold:
            chunk = '**' + chunk
            in_bold = True
        elif not bold and in_bold:
            out[-1] += '**'
            in_bold = False
        out.append(chunk)
    if in_bold and out:
        out[-1] += '**'
    return ' '.join(out)


def math_latex(atoms):
    """LaTeX for a group of atoms inside math (a numerator, a script, a root...)."""
    rows = cluster(atoms)
    texts = []
    for row in rows:
        items = attach_scripts(row)
        body = _base_size(row)
        out = []
        for kind, pieces in segments(items, body, math_context=True):
            if kind == 'M':
                out.append(_math_run_tex(pieces))
            else:
                out.append(f'\\text{{ {_text_run(pieces).replace("**", "")} }}')
        texts.append(join_tex(out))
    return ' '.join(t for t in texts if t)


# ---------- built pieces: roots, fractions, piecewise braces ----------

def _rules(page, figure_boxes):
    flat, upright = [], []
    for r in list(page.rects) + list(page.lines):
        w, h = r['x1'] - r['x0'], r['bottom'] - r['top']
        if any(_inside(b, (r['x0'] + r['x1']) / 2, (r['top'] + r['bottom']) / 2) for b in figure_boxes):
            continue
        if h <= 1.5 and w >= 2:
            flat.append({'x0': r['x0'], 'x1': r['x1'], 'y': (r['top'] + r['bottom']) / 2, 'w': w})
        elif w <= 1.5 and h >= 5:
            upright.append({'x': (r['x0'] + r['x1']) / 2, 'top': r['top'], 'bottom': r['bottom']})
    return flat, upright


def _grow(alive, seeds, allowed, one_line=False):
    """seeds and what touches them, again and again. one_line (a fraction's part): its
    characters share a baseline, apart from their scripts; the next row of a piecewise
    function, close under a denominator, is not part of it."""
    chosen = list(seeds)
    changed = True
    while changed:
        changed = False
        top, bottom = min(a.top for a in chosen), max(a.bottom for a in chosen)
        for a in alive:
            if a in chosen or not allowed(a):
                continue
            # Words of the neighbouring text line are not part of the formula; a word on the
            # baseline of a letter already taken is (the sec of \sqrt[3]{\sec^2 t + |...|}, whose
            # first pieces are its tall bars).
            lines = [s.base for s in chosen if not s.floating] or [s.base for s in seeds]
            if a.cls == 'L' and all(abs(a.base - b) > 1.5 for b in lines):
                continue
            if one_line and not a.floating:
                level = [s for s in chosen if not s.floating]
                # (What was taken so far may be only scripts, the -1 of (\sqrt[4]{b})^{-1}: a
                # larger character is the part's own line.)
                if level and a.size <= 1.15 * max(s.size for s in level) and not any(abs(a.base - s.base) <= .35 * s.size or (a.size < SCRIPT * s.size and abs(a.cy - s.cy) <= s.size)
                                     for s in level):
                    continue
            if one_line and a.floating and not a.ch:
                # A built fraction or root belongs if it reaches the part's line (the next row's
                # \sqrt{...}, under a denominator, does not).
                level = [s for s in chosen if not s.floating]
                if level and not (a.top < max(s.bottom for s in level) and a.bottom > min(s.top for s in level)):
                    continue
            if a.top < bottom and a.bottom > top:
                chosen.append(a)
                changed = True
    return chosen


def build_pieces(atoms, rules, verticals, body, notes):
    alive = list(atoms)
    tableish, used_rules = [], []
    for r in sorted(rules, key=lambda r: r['w']):
        if any(abs(v['x'] - x) < 1.5 and v['top'] - 1.5 <= r['y'] <= v['bottom'] + 1.5
               for v in verticals for x in (r['x0'], r['x1'])):
            tableish.append(r)
            continue
        within = lambda a: r['x0'] - 1.5 <= a.cx <= r['x1'] + 1.5 and a.x1 <= r['x1'] + 2  # noqa: E731
        # A root's content or a fraction's part never reaches past another bar: the y under a/b
        # in (a/b)/y belongs to the middle bar's fraction, not to a/b's.
        bars = [o for o in rules if o is not r and o not in used_rules and o not in tableish]
        crossed = lambda a: any(o['x0'] - 1 <= a.cx <= o['x1'] + 1 and min(r['y'], a.cy) < o['y'] < max(r['y'], a.cy) for o in bars)  # noqa: E731
        # A square root: the rule starts at the top right of a radical sign.
        # (A big sign is placed where it is drawn, from its top down: its rule is at that top,
        # not a fraction bar further down beside it.)
        root = next((g for g in alive if g.ch == '√' and abs(r['x0'] - g.x1) < 3
                     and g.top - 3 <= r['y'] <= (g.top + 3 if g.floating else g.bottom)), None)
        if root:
            seeds = [a for a in alive if a is not root and within(a) and r['y'] - 2.5 <= a.top <= r['y'] + .55 * body]
            if not seeds:
                continue
            seeds = [a for a in seeds if not crossed(a)]
            if not seeds:
                continue
            inside = _grow(alive, seeds, lambda a: a is not root and within(a) and a.top >= r['y'] - 2.5 and not crossed(a), one_line=True)
            # The index (the 3 of a cube root) sits over the radical's left half; its box can
            # reach past the radical's middle and below it (seen in LuaLaTeX notes), its centre not.
            # It never rises far above the root's rule: the 5 of x^5 over a fraction bar, up and
            # to the left of a root in the denominator, is that x's exponent. Its centre is over
            # the sign: the 2 of x^2\sqrt{...} ends where the sign begins. The sign's box can sit
            # above where it is drawn (from its rule down, in Tectonic and XeLaTeX PDFs): the
            # index is then in the upper half of the drawn sign, below the box.
            # (A big sign is placed as drawn: its foot is its content's; the n of another root
            # under it, in a denominator, is not its index.)
            foot = max(a.bottom for a in inside)
            drawn = foot if root.floating else max(r['y'] + (root.bottom - root.top), foot)
            lowest = (r['y'] + drawn) / 2 if root.floating else max(root.bottom + 1, (r['y'] + drawn) / 2)
            index = [a for a in alive if a.size < root.size * SCRIPT and root.x0 + .5 <= a.cx <= root.cx + 1
                     and a.x1 <= root.x1 and a.cy <= lowest and a.top >= r['y'] - 3]
            tex = f'\\sqrt[{math_latex(index)}]{{{math_latex(inside)}}}' if index else f'\\sqrt{{{math_latex(inside)}}}'
            used = inside + index + [root]
            anchors = [a for a in inside if not a.floating] or inside
            # The root's top is its rule: the radical sign's own box is placed higher than the
            # sign is drawn, and would lift a root in a denominator above its fraction bar.
            new = Atom(tex=tex, text=tex, x0=min(a.x0 for a in used), x1=max(r['x1'], max(a.x1 for a in used)),
                       top=min(r['y'], min(a.top for a in inside + index)),
                       bottom=max(a.bottom for a in inside + index + ([] if root.floating else [root])),
                       base=statistics.median(a.base for a in anchors), size=max(a.size for a in inside),
                       cls='m', floating=True)
            alive = [a for a in alive if a not in used] + [new]
            used_rules.append(r)
            continue
        above = [a for a in alive if within(a) and r['y'] - .55 * body <= a.bottom <= r['y'] + .2 * body]
        below = [a for a in alive if within(a) and r['y'] - .2 * body <= a.top <= r['y'] + .55 * body]
        if not above and below:
            # A numerator set further up than usual (tall brackets in it): looked for further
            # away, only when the bar has a denominator (an underline has none; a heading's
            # underline with the next line under it is no fraction).
            above = [a for a in alive if within(a) and r['y'] - .75 * body <= a.bottom <= r['y'] + .2 * body]
        above = [a for a in above if a not in below or a.cy < r['y']]
        below = [a for a in below if a not in above]
        if not above or not below:
            continue
        # Underlined words (\underline{Leibniz Notation:}) sit on their rule, 1.5pt above it; a
        # numerator of full-size characters is raised about 4pt over its bar.
        level = [a for a in above if not a.floating]
        if level and all(a.size >= .9 * body for a in level) and r['y'] - statistics.median(a.base for a in level) < .25 * body:
            continue
        above = [a for a in above if not crossed(a)]
        below = [a for a in below if not crossed(a)]
        if not above or not below:
            continue
        num = _grow(alive, above, lambda a: within(a) and a.cy < r['y'] and not crossed(a), one_line=True)
        den = _grow(alive, below, lambda a: within(a) and a.cy > r['y'] and not crossed(a), one_line=True)
        span = max(max(a.x1 for a in g) - min(a.x0 for a in g) for g in (num, den))
        if span < .55 * r['w'] or set(map(id, num)) & set(map(id, den)):
            continue
        size = max(a.size for a in num + den)
        new = Atom(tex=f'\\frac{{{math_latex(num)}}}{{{math_latex(den)}}}', text='', x0=r['x0'], x1=r['x1'],
                   top=min(a.top for a in num), bottom=max(a.bottom for a in den), base=r['y'] + .25 * size,
                   size=size, cls='m', floating=True)
        alive = [a for a in alive if a not in num and a not in den] + [new]
        used_rules.append(r)
    alive = _build_braces(alive, body, notes)
    return alive, tableish, [r for r in rules if r not in used_rules and r not in tableish]


def _cases(rows, body):
    """Rows of a piecewise definition; the widest gap in a row separates the value
    from its condition."""
    lines = []
    for row in rows:
        row = sorted(row, key=lambda a: a.x0)
        cut = None
        for i in range(1, len(row)):
            gap = row[i].x0 - max(a.right for a in row[:i])
            if gap >= .9 * body and (cut is None or gap > cut[1]):
                cut = (i, gap)
        cells = [row[:cut[0]], row[cut[0]:]] if cut else [row]
        lines.append(' & '.join(math_latex(c) for c in cells))
    return '\\begin{cases} ' + ' \\\\ '.join(lines) + ' \\end{cases}'


def _single_braces(alive, body):
    """A big left brace drawn as one glyph, with two or more rows to its right and no
    matching right brace: a piecewise definition."""
    for g in [a for a in alive if a.ch == '{' and a.floating]:
        if any(a.ch == '}' and a.floating and abs(a.top - g.top) < 2 for a in alive):
            continue
        # (Its rows lie between its top and its foot: it is placed where it is drawn.)
        content = [a for a in alive if a is not g and g.x1 - 1 <= a.x0 <= g.x1 + 250
                   and g.top - .3 * body <= a.cy <= g.bottom + .3 * body]
        rows = cluster(content, body)
        if len(rows) < 2 or any(min(a.x0 for a in r) > g.x1 + 3 * body for r in rows):
            continue
        used = content + [g]
        top, bottom = min(a.top for a in used), max(a.bottom for a in used)
        new = Atom(tex=_cases(rows, body), text='', x0=g.x0, x1=max(a.x1 for a in used), top=top, bottom=bottom,
                   base=(top + bottom) / 2 + .25 * body, size=body, cls='m', floating=True)
        alive = [a for a in alive if a not in used] + [new]
    return alive


def _build_braces(alive, body, notes):
    alive = _single_braces(alive, body)
    pieces = sorted((a for a in alive if a.ch in BRACE_PIECES), key=lambda a: a.top)
    # A brace is built from a top piece, extensions, a middle piece and a bottom piece.
    braces = []
    for p in pieces:
        last = braces[-1] if braces else None
        if (last and last[-1].ch != '⎩' and p.ch != '⎧' and abs(p.x0 - last[-1].x0) < 1.5
                and p.base - last[-1].base < 2.5 * p.size):
            last.append(p)
        else:
            braces.append([p])
    for brace in braces:
        top, bottom, x1 = min(p.top for p in brace), max(p.bottom for p in brace), max(p.x1 for p in brace)
        content = [a for a in alive if a not in brace and a.x0 >= x1 - 1 and top - 2 <= a.cy <= bottom + 2]
        rows = cluster(content, body)
        if len(rows) < 2:
            notes.append('a large brace whose rows could not be told apart')
            alive = [a for a in alive if a not in brace]
            continue
        tex = _cases(rows, body)
        used = content + brace
        middle = next((p for p in brace if p.ch == '⎨'), None)
        center = middle.cy if middle else (top + bottom) / 2
        new = Atom(tex=tex, text='', x0=min(p.x0 for p in brace), x1=max(a.x1 for a in used), top=top, bottom=bottom,
                   base=center + .25 * body, size=body, cls='m', floating=True)
        alive = [a for a in alive if a not in used] + [new]
    return alive


def _blanks(rules, atoms, body):
    """A short rule on a line of text is a blank to fill in: "the area of a circle: ____"."""
    out = []
    for r in rules:
        if not 10 <= r['w'] <= 250:
            continue
        base = r['y'] - 1
        if any(r['x0'] - 1 <= a.cx <= r['x1'] + 1 and 0 <= r['y'] - a.base <= .4 * body for a in atoms):
            continue  # underlined words, not a blank
        if any(abs(a.base - base) < .35 * body and abs(a.cx - (r['x0'] + r['x1']) / 2) < 150 for a in atoms):
            out.append(Atom(tex='\\underline{\\qquad}', text='_____', x0=r['x0'], x1=r['x1'], top=base - .7 * body,
                            bottom=base + .25 * body, base=base, size=body, cls='n', ch='_'))
    return out


def _not_signs(atoms):
    """TeX writes ≠ as = with a slash laid over it."""
    slashes = [a for a in atoms if a.ch == '̸']
    for s in slashes:
        # The slash has no width of its own and is drawn over the next character.
        partner = min((a for a in atoms if a is not s and a.ch != '̸' and abs(a.base - s.base) < 2
                       and s.x0 - 1.5 <= a.x0 <= s.x0 + 6),
                      key=lambda a: abs(a.x0 - s.x0), default=None)
        if partner:
            partner.tex = {'=': '\\ne', '\\in': '\\notin', '<': '\\nless', '>': '\\ngtr'}.get(partner.tex, '\\not' + partner.tex)
            partner.cls = 'm'
            partner.x0, partner.x1 = min(partner.x0, s.x0), max(partner.x1, s.x1)
    return [a for a in atoms if a.ch != '̸']


def _join_pieces(atoms):
    """A tall bracket or bar is drawn as pieces stacked one on another (a tall | is two or more
    bars, a tall ( a top, middle and bottom): one delimiter, not || or (((."""
    # Only bars and the pieces of tall brackets, where one ends and the next begins: the [ of
    # d/dx [f(x) + g(x)] on two lines, one under the other, are two brackets.
    pieces = sorted((a for a in atoms if a.floating and (a.ch in '|‖' or a.ch in PIECES) and a.ch),
                    key=lambda a: (round(a.x0), a.top))
    gone = set()
    for k, a in enumerate(pieces):
        if id(a) in gone:
            continue
        for b in pieces[k + 1:]:
            if id(b) in gone or b.tex != a.tex or abs(b.x0 - a.x0) > 1 or b.top > a.bottom + 1:
                continue
            a.top, a.bottom = min(a.top, b.top), max(a.bottom, b.bottom)
            gone.add(id(b))
    return [a for a in atoms if id(a) not in gone]


# ---------- tables ----------

def _tables(alive, tableish, verticals, body):
    """Ruled tables (tabular with | and \\hline) as Markdown tables. Returns
    (remaining atoms, [(top, lines)])."""
    def joined(x, y0, y1):
        """The table's side rule runs from y0 to y1 (drawn row by row, with small breaks)."""
        reach = y0
        for v in sorted((v for v in verticals if abs(v['x'] - x) < 1.5), key=lambda v: v['top']):
            if v['top'] <= reach + 2:
                reach = max(reach, v['bottom'])
        return reach >= y1 - 2
    def xs(reg):
        return sorted({round(v['x'], 1) for v in verticals if reg['x0'] - 2 <= v['x'] <= reg['x1'] + 2})
    regions = []
    for r in sorted(tableish, key=lambda r: r['y']):
        for reg in regions:
            # Rows without \hline between them leave a long gap; the column rules still join them
            # (three or more: a framed box has only its two sides).
            if abs(reg['x0'] - r['x0']) < 3 and abs(reg['x1'] - r['x1']) < 3 and (
                    r['y'] - reg['bottom'] < 3 * body or sum(joined(x, reg['bottom'], r['y']) for x in xs(reg)) >= 3):
                reg['bottom'] = r['y']
                break
        else:
            regions.append({'x0': r['x0'], 'x1': r['x1'], 'top': r['y'], 'bottom': r['y']})
    out = []
    for reg in regions:
        cols = sorted({round(v['x'], 1) for v in verticals if reg['x0'] - 2 <= v['x'] <= reg['x1'] + 2
                       and v['top'] < reg['bottom'] and v['bottom'] > reg['top']})
        if len(cols) < 3:
            continue  # a box around a formula, not a table
        inside = [a for a in alive if reg['x0'] <= a.cx <= reg['x1'] and reg['top'] <= a.cy <= reg['bottom']]
        if not inside:
            continue
        lines = []
        for row in cluster(inside, body):
            if len(cols) >= 2:
                edges = cols
            else:
                edges = [reg['x0'], reg['x1']]
            cells = [[a for a in row if lo <= a.cx < hi] for lo, hi in zip(edges, edges[1:])]
            lines.append('| ' + ' | '.join(row_markdown(attach_scripts(c), body) if c else '' for c in cells) + ' |')
        if lines:
            width = lines[0].count('|') - 1
            lines.insert(1, '|' + '---|' * width)
            out.append((reg['top'], lines))
        alive = [a for a in alive if a not in inside]
    return alive, out


# ---------- the page ----------

def _extent(atoms):
    """(x0, top, x1, bottom) of atoms with their scripts: where they are on the page."""
    every = []

    def walk(a):
        every.append(a)
        for s in a.sub + a.sup:
            walk(s)
    for a in atoms:
        walk(a)
    return (min(a.x0 for a in every), min(a.top for a in every), max(a.x1 for a in every), max(a.bottom for a in every))


def row_markdown(items, body, found=None):
    """A row as Markdown. found, if given, gets each formula and where it is (for the
    check that typesets the reading again, reading_check.py)."""
    out, last_word = '', None
    for kind, pieces in segments(items, body):
        piece = _text_run(pieces) if kind == 'T' else _math_run_tex(pieces)
        if not piece:
            continue
        if kind == 'M' and found is not None:
            found.append({'latex': piece, 'display': False, 'size': body,
                          'box': _extent([a for _w, atoms in pieces for a in atoms])})
        if kind == 'M':
            # The bracket of the sentence around it is not maths: "(if ... that $a > 0$)".
            tail = ''
            # (Brackets count as one kind: the interval (-1, 1] is whole.)
            while piece[-1:] in (')', ']') and piece.count(')') + piece.count(']') > piece.count('(') + piece.count('['):
                piece, tail = piece[:-1].rstrip(), piece[-1] + tail
            piece = f'${piece}${tail}' if piece else tail
        # Runs that meet inside one printed word ("$x$-intercept", "$a$,") stay joined.
        same_word = last_word is not None and pieces[0][0] == last_word
        out += piece if not out or same_word else ' ' + piece
        last_word = pieces[-1][0]
    return out.replace(' ,', ',').replace(' .', '.')


def _split_side_by_side(items, body):
    """Two problems or parts printed side by side become separate lines."""
    words = _words(items, body)
    starts = [0]
    for i in range(1, len(words)):
        gap = words[i][0].x0 - words[i - 1][-1].right
        if gap > 2.2 * body and PROBLEM_LABEL.match(''.join(a.text for a in words[i])):
            starts.append(i)
    starts.append(len(words))
    return [[a for w in words[s:e] for a in w] for s, e in zip(starts, starts[1:])]


def _drawing_regions(page, boxes):
    """Drawings no figure box covers: a curve or a slanted line at least 15pt long starts one
    (a framed box's rounded corners and dots are smaller), and every line, box or curve that
    touches it joins. Returns (x0, top, x1, bottom) boxes."""
    def box(o):
        return [o['x0'], o['top'], o['x1'], o['bottom']]

    def outside(o):
        return not any(_inside(b, (o['x0'] + o['x1']) / 2, (o['top'] + o['bottom']) / 2) for b in boxes)
    parts = [o for o in list(page.curves) + list(page.lines) + list(page.rects) if outside(o)]
    seeds = [box(o) for o in page.curves if outside(o) and max(o['x1'] - o['x0'], o['bottom'] - o['top']) >= 15]
    seeds += [box(o) for o in page.lines if outside(o) and o['x1'] - o['x0'] >= 3 and o['bottom'] - o['top'] >= 3
              and math.hypot(o['x1'] - o['x0'], o['bottom'] - o['top']) >= 15]
    regions = []
    for s in seeds:
        r = list(s)
        # The axes: a long upright line beside the curve, over most of its height (the
        # horizontal axis then joins by touching it). A fraction bar touches no upright line.
        for o in parts:
            b = box(o)
            h = b[3] - b[1]
            if (b[2] - b[0] <= 1.5 and h >= 60 and min(b[3], r[3]) - max(b[1], r[1]) >= .5 * (r[3] - r[1])
                    and (r[0] - b[2] <= (r[2] - r[0]) / 2 and b[0] - r[2] <= (r[2] - r[0]) / 2)):
                r = [min(r[0], b[0]), min(r[1], b[1]), max(r[2], b[2]), max(r[3], b[3])]
        changed = True
        while changed:
            changed = False
            for o in parts:
                b = box(o)
                if b[0] <= r[2] + 2 and b[2] >= r[0] - 2 and b[1] <= r[3] + 2 and b[3] >= r[1] - 2 and not (
                        r[0] <= b[0] and b[2] <= r[2] and r[1] <= b[1] and b[3] <= r[3]):
                    r = [min(r[0], b[0]), min(r[1], b[1]), max(r[2], b[2]), max(r[3], b[3])]
                    changed = True
        for other in regions:
            if r[0] <= other[2] and r[2] >= other[0] and r[1] <= other[3] and r[3] >= other[1]:
                other[:] = [min(r[0], other[0]), min(r[1], other[1]), max(r[2], other[2]), max(r[3], other[3])]
                break
        else:
            regions.append(r)
    # A wide flat region is a page rule or a frame's edge, not a drawing.
    return [r for r in regions if r[2] - r[0] >= 30 and r[3] - r[1] >= 30]


DRAWING_NOTE = 'A drawing is here that the notebook could not read.'


def _drawing_labels(atoms, regions, body):
    """Take the labels of unread drawings out of the text: read as lines they become one-letter
    equations ($$Q_{2}$$, $$a \\quad x$$) that say nothing true. Each drawing becomes one plain
    line that says it is there, with its labels as printed. A text line that runs on past the
    drawing's edge is text and stays."""
    drawings = []
    for r in regions:
        pad = [r[0] - 1.5 * body, r[1] - 1.2 * body, r[2] + 1.5 * body, r[3] + 1.2 * body]
        inside = [a for a in atoms if pad[0] <= a.cx <= pad[2] and pad[1] <= a.cy <= pad[3]]
        rest = [a for a in atoms if a not in inside]
        # A sentence crossing the edge goes on with a word gap; a problem printed beside the
        # drawing ("(a) p'(4)" left of a tick label) is further off.
        keep = set()
        for a in inside:
            if any(abs(b.base - a.base) < .3 * body and max(b.x0 - a.right, a.x0 - b.right) < .8 * body for b in rest):
                keep.update(id(c) for c in inside if abs(c.base - a.base) < .3 * body)
        labels = [a for a in inside if id(a) not in keep]
        # A line in the drawing is not a blank to fill in.
        atoms = [a for a in atoms if not (a in labels and a.ch == '_' and a.text == '_____')]
        labels = [a for a in labels if not (a.ch == '_' and a.text == '_____')]
        # Many words of prose inside means a framed passage, not a picture with labels.
        if sum(1 for a in labels if a.cls == 'L') > 120:
            continue
        # Each label as the reader reads any line (pi/2 stays a fraction), listed, not displayed.
        said = [row_markdown(attach_scripts(row), body).strip() for row in (cluster(labels, body) if labels else [])]
        note = DRAWING_NOTE + (f' Labels in it, as printed: {"; ".join(t for t in said if t)}.' if said else '')
        drawings.append({'bbox': pad, 'text': f'*{note}*'})
        atoms = [a for a in atoms if a not in labels]
    return atoms, drawings


def read_page(page, figures=()):
    """page: a pdfplumber page. figures: dicts with 'bbox' (x0, top, x1, bottom) and 'marker'
    (the [FIGURE ...] line to put in its place). Returns markdown, the line of each figure,
    and notes for lines the reader was unsure of."""
    notes_raw = []
    equations = []  # each formula, its reading and where it is, for reading_check
    boxes = [f['bbox'] for f in figures]
    atoms = []
    seen = set()
    for c in page.chars:
        # (A big-symbol font's code 32 is a tall bracket, named by its code: a space.)
        if not c.get('upright', True) or not c['text'].strip() and not (c['text'] == ' ' and 'CMEX' in c['fontname'].upper()):
            continue
        key = (c['text'], round(c['x0'], 1), round(c['top'], 1))
        if key in seen:
            continue
        seen.add(key)
        local = []
        a = _glyph(c, local)
        if any(_inside(b, a.cx, a.cy) for b in boxes):
            continue
        for n in local:
            notes_raw.append((a.base, n))
        atoms.append(a)
    if not atoms and not figures:
        return {'markdown': '', 'figure_lines': {}, 'notes': [], 'chars': 0}
    body = _mode_size(atoms) if atoms else 10
    atoms = _join_pieces(_not_signs(atoms))
    rules, verticals = _rules(page, boxes)
    brace_notes = []
    atoms, tableish, spare = build_pieces(atoms, rules, verticals, body, brace_notes)
    atoms += _blanks(spare, atoms, body)
    # After fractions are built (a label may be pi/2), before the drawing's grid becomes a table.
    atoms, drawings = _drawing_labels(atoms, _drawing_regions(page, boxes), body)
    tableish = [r for r in tableish if not any(_inside(d['bbox'], (r['x0'] + r['x1']) / 2, r['y']) for d in drawings)]
    atoms, tables = _tables(atoms, tableish, verticals, body)
    rows = cluster(atoms, body)

    left = min((min(a.x0 for a in r) for r in rows), default=0)
    entries = []  # (y, kind, payload)
    for row in rows:
        items = attach_scripts(row)
        for part in _split_side_by_side(items, body):
            if not part:
                continue
            base = statistics.median(a.base for a in part if not a.floating) if any(not a.floating for a in part) else part[0].base
            entries.append((base, 'row', part))
    for top, lines in tables:
        entries.append((top, 'table', lines))
    for n, f in enumerate(figures):
        entries.append((f['bbox'][1], 'figure', n))
    for d in drawings:
        entries.append((d['bbox'][1], 'drawing', d['text']))
    entries.sort(key=lambda e: e[0])

    lines, figure_lines, notes, prev, waiting = [], {}, [], None, []

    def blank():
        if lines and lines[-1] != '':
            lines.append('')

    def place_figures():
        nonlocal prev
        for n in waiting:
            blank()
            figure_lines[n] = len(lines)
            lines.append(figures[n]['marker'])
            blank()
            prev = None
        waiting.clear()
    for y, kind, payload in entries:
        if kind == 'figure':
            waiting.append(payload)  # placed at the end of the paragraph it interrupts
            continue
        if kind == 'drawing':
            place_figures()
            blank()
            lines.append(payload)
            blank()
            prev = None
            continue
        if kind == 'table':
            place_figures()
            blank()
            lines.extend(payload)
            blank()
            prev = None
            continue
        part = payload
        size = max(a.size for a in part)
        segs = segments(part, body)
        all_math = all(k == 'M' for k, _ in segs)
        inline = []
        text = row_markdown(part, body, inline)
        if not text.strip():
            continue
        x0 = min(a.x0 for a in part)
        first = ''.join(a.text for a in _words(part, body)[0])
        line_notes = [n for b, n in notes_raw if abs(b - y) < 2 * body]
        # A display line may end in words ("= x for all x > 0"); one that starts with maths
        # and is set well in from the margin is a display too, not a paragraph to join.
        # A wide display starts at the margin, or left of it, but is centred on the page; after
        # a finished sentence (not a paragraph line that happens to be all maths).
        x1 = max(a.right for a in part)
        width = getattr(page, 'width', None)
        centred = bool(width) and abs((x0 + x1) / 2 - width / 2) < body and x1 - x0 > width / 3
        after_sentence = prev is None or prev['kind'] != 'text' or prev['ends']
        if (all_math and (x0 > left + 15 or (centred and after_sentence))) or (segs and segs[0][0] == 'M' and x0 > left + 3 * body):
            tex = row_markdown_math(part, body)
            out, kind_now = f'$${tex}$$', 'display'
            equations.append({'latex': tex, 'display': True, 'size': body, 'box': _extent(part)})
        elif size >= 1.3 * body and (not any(k == 'M' for k, _ in segs) or (
                # a heading with maths in it ("Derivative of $y = \sin^{-1} x$"): its words are large
                len(words := [a for a in part if a.cls == 'L']) >= 3 and all(a.size >= 1.3 * body for a in words))):
            out, kind_now = ('# ' if size >= 1.6 * body else '## ') + text.replace('**', ''), 'heading'
        else:
            out, kind_now = text, 'text'
            equations.extend(inline)
        # Lines with tall math (fractions) sit further apart, so a wider gap alone does not
        # end a paragraph unless the previous line ended a sentence.
        gap = y - prev['y'] if prev else 0
        new_paragraph = (kind_now != 'text' or prev is None or prev['kind'] != 'text' or LABEL.match(first)
                         or gap > 3 * body or (gap > 1.65 * body and prev['ends'])
                         or (x0 > prev['left'] + .9 * body and prev['ends']))
        if new_paragraph:
            place_figures()
            blank()
            lines.append(out)
            if kind_now != 'text':
                blank()
        else:
            if lines[-1].endswith('-') and re.search(r'[a-z]-$', lines[-1]) and re.match(r'[a-z]', out):
                lines[-1] = lines[-1][:-1] + out
            elif INLINE_BREAK.search(lines[-1]) and out.startswith('$') and not out.startswith('$$'):
                # TeX breaks a formula in a sentence only after an operator or relation: one
                # ending in + or = goes on at the start of the next line, as one formula.
                lines[-1] = lines[-1][:-1].rstrip() + ' ' + out[1:]
            else:
                lines[-1] += ' ' + out
        if line_notes:
            notes.append((len(lines) - 1, '; '.join(sorted(set(line_notes)))))
        prev = {'kind': kind_now, 'y': y, 'left': x0 if new_paragraph else prev['left'],
                'ends': bool(re.search(r'[.:?!]\**$', out))}
    place_figures()
    for n in brace_notes:
        notes.append((max(0, len(lines) - 1), n))
    while lines and lines[-1] == '':
        lines.pop()
    return {'markdown': '\n'.join(lines), 'figure_lines': figure_lines, 'notes': notes, 'chars': len(page.chars),
            'equations': equations}


def row_markdown_math(items, body):
    """A display row: everything is math; text words become \\text{}."""
    out = []
    for kind, pieces in segments(items, body, math_context=True):
        out.append(_math_run_tex(pieces) if kind == 'M' else f'\\text{{ {_text_run(pieces).replace("**", "")} }}')
    return join_tex(out).strip()
