// MathML <-> LaTeX and MathML -> Word equations (OMML). Rules, not AI: every piece of
// MathML maps to one piece of the other format, so a conversion never changes the maths.
// Runs in the page and in Node (the tests), so it has its own small XML reader.
import temml from './vendor/temml.mjs';

// ---------- a small XML reader (MathML only needs elements, attributes and text) ----------

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: '\u00a0', InvisibleTimes: '\u2062',
  ApplyFunction: '\u2061', af: '\u2061', it: '\u2062', minus: '−', infin: '∞', pi: 'π', le: '≤',
  ge: '≥', ne: '≠', pm: '±', times: '×', rarr: '→', int: '∫', sum: '∑', prime: '′',
  middot: '·', sdot: '⋅', theta: 'θ', alpha: 'α', beta: 'β', Delta: 'Δ', delta: 'δ' };

function decode(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[A-Za-z]+);/gi, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name] ?? whole;
  });
}

// Returns the root element: { name, attrs, children } with text children as strings.
// Namespace prefixes (mml:mi, m:mi) are dropped; comments and processing instructions skipped.
export function parseXml(source) {
  const root = { name: '#root', attrs: {}, children: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*>|<\/\s*([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(source))) {
    const top = stack.at(-1);
    if (m[1] !== undefined) top.children.push(m[1]);
    else if (m[2]) {
      const name = m[2].replace(/^.*:/, '');
      if (top.name !== name) throw new Error(`The MathML is broken: </${name}> closes <${top.name}>.`);
      stack.pop();
    } else if (m[3]) {
      const attrs = {};
      for (const a of m[4].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1].replace(/^.*:/, '')] = decode(a[2] ?? a[3]);
      const node = { name: m[3].replace(/^.*:/, ''), attrs, children: [] };
      top.children.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6] !== undefined) {
      if (/^\s*$/.test(m[6])) continue; // spacing between tags means nothing in MathML
      if (m[6].includes('<')) throw new Error('The MathML is broken: a < is not part of a tag.');
      top.children.push(decode(m[6]));
    }
  }
  if (stack.length > 1) throw new Error(`The MathML is broken: <${stack.at(-1).name}> is never closed.`);
  return root;
}

const elements = (node) => node.children.filter((c) => typeof c !== 'string');
const textOf = (node) => (typeof node === 'string' ? node : node.children.map(textOf).join(''));

// The <math> element of a MathML string, with <semantics> unwrapped. Annotations are kept
// apart so a Temml equation's own LaTeX can be used as it is.
export function readMathml(source) {
  const root = parseXml(String(source).trim());
  const math = findMath(root);
  if (!math) throw new Error('This is not MathML: there is no <math> element.');
  return math;
}
function findMath(node) {
  if (typeof node === 'string') return null;
  if (node.name === 'math') return node;
  for (const c of node.children) { const hit = findMath(c); if (hit) return hit; }
  return null;
}
function annotation(math, encoding) {
  const sem = elements(math).length === 1 && elements(math)[0].name === 'semantics' ? elements(math)[0] : null;
  const ann = sem && elements(sem).find((c) => c.name === 'annotation' && c.attrs.encoding === encoding);
  return ann ? textOf(ann) : null;
}
// The visible content of a node: <semantics> keeps only its first child, annotations go.
function content(node) {
  return elements(node).flatMap((c) => {
    // A plain row inside <semantics> is unwrapped; a styled one (\boxed's border) is kept.
    if (c.name === 'semantics') return elements(c).slice(0, 1).flatMap((x) => (x.name === 'mrow' && !x.attrs.style ? content(x) : [x]));
    if (c.name === 'annotation' || c.name === 'annotation-xml' || c.name === 'none' || c.name === 'mprescripts') return [];
    return [c];
  });
}

// ---------- characters ----------

const LARGE_OPS = { '∫': '\\int', '∬': '\\iint', '∭': '\\iiint', '∮': '\\oint', '∑': '\\sum', '∏': '\\prod',
  '∐': '\\coprod', '⋃': '\\bigcup', '⋂': '\\bigcap', '⨁': '\\bigoplus', '⨂': '\\bigotimes' };
const LIMIT_WORDS = new Set(['lim', 'max', 'min', 'sup', 'inf', 'limsup', 'liminf', 'det', 'gcd', 'Pr']);
const ACCENTS = { 'ˆ': '\\hat', '^': '\\hat', '\u0302': '\\hat', '˜': '\\tilde', '~': '\\tilde', '\u0303': '\\tilde',
  '¯': '\\bar', '‾': '\\overline', '\u0304': '\\bar', '\u0305': '\\overline', '→': '\\vec', '\u20d7': '\\vec',
  '˙': '\\dot', '\u0307': '\\dot', '¨': '\\ddot', '\u0308': '\\ddot', 'ˇ': '\\check', '\u030c': '\\check',
  '˘': '\\breve', '\u0306': '\\breve', '´': '\\acute', '\u0301': '\\acute', '`': '\\grave', '\u0300': '\\grave',
  '⏞': '\\overbrace', '⏟': '\\underbrace', '―': '\\overline', '_': '\\underline', '\u0332': '\\underline' };

const SYMBOLS = {
  'α': '\\alpha', 'β': '\\beta', 'γ': '\\gamma', 'δ': '\\delta', 'ε': '\\varepsilon', 'ϵ': '\\epsilon',
  'ζ': '\\zeta', 'η': '\\eta', 'θ': '\\theta', 'ϑ': '\\vartheta', 'ι': '\\iota', 'κ': '\\kappa',
  'λ': '\\lambda', 'μ': '\\mu', 'ν': '\\nu', 'ξ': '\\xi', 'π': '\\pi', 'ρ': '\\rho', 'σ': '\\sigma',
  'ς': '\\varsigma', 'τ': '\\tau', 'υ': '\\upsilon', 'φ': '\\varphi', 'ϕ': '\\phi', 'χ': '\\chi',
  'ψ': '\\psi', 'ω': '\\omega', 'Γ': '\\Gamma', 'Δ': '\\Delta', 'Θ': '\\Theta', 'Λ': '\\Lambda',
  'Ξ': '\\Xi', 'Π': '\\Pi', 'Σ': '\\Sigma', 'Υ': '\\Upsilon', 'Φ': '\\Phi', 'Ψ': '\\Psi', 'Ω': '\\Omega',
  '−': '-', '±': '\\pm', '∓': '\\mp', '×': '\\times', '÷': '\\div', '⋅': '\\cdot', '·': '\\cdot',
  '≤': '\\le', '≥': '\\ge', '≠': '\\ne', '≈': '\\approx', '≡': '\\equiv', '∼': '\\sim', '≅': '\\cong',
  '∝': '\\propto', '≪': '\\ll', '≫': '\\gg',
  '→': '\\to', '←': '\\leftarrow', '↔': '\\leftrightarrow', '⇒': '\\Rightarrow', '⇐': '\\Leftarrow',
  '⇔': '\\Leftrightarrow', '⟹': '\\implies', '⟺': '\\iff', '↦': '\\mapsto',
  '∞': '\\infty', '∂': '\\partial', '∇': '\\nabla', '′': "'", '″': "''", '‴': "'''",
  '∈': '\\in', '∉': '\\notin', '∋': '\\ni', '⊂': '\\subset', '⊃': '\\supset', '⊆': '\\subseteq',
  '⊇': '\\supseteq', '∪': '\\cup', '∩': '\\cap', '∅': '\\emptyset', '∀': '\\forall', '∃': '\\exists',
  '¬': '\\neg', '∧': '\\wedge', '∨': '\\vee', '∘': '\\circ', '°': '^{\\circ}', '…': '\\ldots',
  '⋯': '\\cdots', '⋮': '\\vdots', '⋱': '\\ddots', '∣': '\\mid', '∥': '\\parallel', '⊥': '\\perp',
  '∠': '\\angle', '△': '\\triangle', '∴': '\\therefore', '∵': '\\because',
  'ℝ': '\\mathbb{R}', 'ℕ': '\\mathbb{N}', 'ℤ': '\\mathbb{Z}', 'ℚ': '\\mathbb{Q}', 'ℂ': '\\mathbb{C}',
  'ℓ': '\\ell', 'ℏ': '\\hbar', '⟨': '\\langle', '⟩': '\\rangle', '〈': '\\langle', '〉': '\\rangle',
  '⌊': '\\lfloor', '⌋': '\\rfloor', '⌈': '\\lceil', '⌉': '\\rceil', '‖': '\\|', '\u00a0': '~',
  '{': '\\{', '}': '\\}', '%': '\\%', '#': '\\#', '&': '\\&', '$': '\\$', '\\': '\\backslash',
  ...LARGE_OPS,
};
const INVISIBLE = new Set(['\u2061', '\u2062', '\u2063', '\u2064', '\u200b']);
// Italic and bold maths letters (U+1D400...) back to plain letters.
function plainLetters(text) {
  return [...text].map((ch) => {
    const c = ch.codePointAt(0);
    if (c >= 0x1d400 && c <= 0x1d6a3) {
      const k = (c - 0x1d400) % 52;
      return String.fromCharCode(k < 26 ? 65 + k : 97 + k - 26);
    }
    if (c === 0x210e) return 'h';
    return ch;
  }).join('');
}

const FUNCTION_NAMES = new Set(['sin', 'cos', 'tan', 'sec', 'csc', 'cot', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh',
  'coth', 'ln', 'log', 'exp', 'lim', 'max', 'min', 'sup', 'inf', 'det', 'gcd', 'deg', 'dim', 'ker', 'arg', 'Pr', 'lg', 'hom']);

// ---------- MathML -> LaTeX ----------

function charsToLatex(text) {
  let out = '';
  for (const ch of plainLetters(text)) {
    if (INVISIBLE.has(ch)) continue;
    const sym = SYMBOLS[ch];
    out += sym === undefined ? ch : (/^\\[A-Za-z]+$/.test(sym) ? `${sym} ` : sym);
  }
  return out;
}

const group = (s) => {
  const t = s.trim();
  return t.length === 1 || /^\\[A-Za-z]+$/.test(t) ? t : `{${t}}`;
};
const braced = (s) => `{${s.trim()}}`;

function tokenLatex(node) {
  const text = textOf(node);
  const plain = plainLetters(text);
  if (node.name === 'mtext' || node.name === 'ms') {
    if (/^[\s\u00a0]*$/.test(text)) return text.length ? '\\ ' : '';
    return `\\text{${text.replace(/[\\{}]/g, (c) => `\\${c === '\\' ? 'textbackslash ' : c}`)}}`;
  }
  if (node.name === 'mi' && plain.length > 1 && /^[A-Za-z]+$/.test(plain)) {
    return FUNCTION_NAMES.has(plain) ? `\\${plain} ` : `\\operatorname{${plain}}`;
  }
  if (node.name === 'mi' && node.attrs.mathvariant === 'normal' && /^[A-Za-z]$/.test(plain)) return `\\mathrm{${plain}}`;
  if (node.name === 'mi' && node.attrs.mathvariant === 'double-struck' && /^[A-Za-z]$/.test(plain)) return `\\mathbb{${plain}}`;
  if (node.name === 'mi' && node.attrs.mathvariant === 'bold' && /^[A-Za-z]$/.test(plain)) return `\\mathbf{${plain}}`;
  // A bar that is not a bracket ("given" in P(A | B)); |x| itself uses <mi>|</mi>.
  if (node.name === 'mo' && text === '|' && node.attrs.fence !== 'true') return '\\mid ';
  return charsToLatex(text);
}

function fenceLatex(ch) {
  if (ch === '') return '.';
  if (ch === '{') return '\\{';
  if (ch === '}') return '\\}';
  return SYMBOLS[ch] && /^\\/.test(SYMBOLS[ch]) ? SYMBOLS[ch] : ch;
}

function rowLatex(nodes) {
  let out = '';
  for (let i = 0; i < nodes.length; i += 1) {
    const piece = nodeLatex(nodes[i]);
    // \sin x: a command word followed by a letter needs the space; "x y" stays "xy".
    if (/\\[A-Za-z]+$/.test(out) && /^[A-Za-z0-9]/.test(piece)) out += ' ';
    out += piece;
    // [0, 1] keeps its space: written 0,1 it reads as one number with a decimal comma.
    if (piece === ',' && nodes[i].name === 'mo') out += ' ';
  }
  return out;
}

function nodeLatex(node) {
  const kids = content(node);
  switch (node.name) {
    case 'math': case 'mrow': case 'mstyle': case 'mpadded': case 'semantics': case 'merror': {
      if (/border\s*:/.test(node.attrs.style || '')) return `\\boxed${braced(rowLatex(kids))}`;
      if (node.name === 'mstyle' && node.attrs.displaystyle === 'true') return `\\displaystyle ${rowLatex(kids)}`;
      // A stretchy pair of fences around a row: \left( ... \right)
      const first = kids[0], last = kids.at(-1);
      if (kids.length === 3 && first.name === 'mo' && textOf(first) === '(' && textOf(last) === ')' && kids[1].name === 'mfrac'
          && /^0+(\.0*)?(px|em|pt)?$/.test(kids[1].attrs.linethickness || '1')) {
        const [n, k] = content(kids[1]).map(nodeLatex);
        return `\\binom${braced(n)}${braced(k)}`;
      }
      if (kids.length >= 2 && first.name === 'mo' && last.name === 'mo' && first.attrs.stretchy === 'true' && last.attrs.stretchy === 'true'
          && first.attrs.fence === 'true' && last.attrs.fence === 'true') {
        const inner = kids.slice(1, -1);
        if (inner.length === 1 && inner[0].name === 'mtable') {
          const env = { '(': 'pmatrix', '[': 'bmatrix', '|': 'vmatrix', '{': textOf(last) === '' ? 'cases' : 'Bmatrix', '‖': 'Vmatrix' }[textOf(first)];
          if (env && (env !== 'cases' || textOf(last) === '')) return tableLatex(inner[0], env);
        }
        return `\\left${fenceLatex(textOf(first))} ${rowLatex(inner)} \\right${fenceLatex(textOf(last))}`;
      }
      return rowLatex(kids);
    }
    case 'mi': case 'mn': case 'mo': case 'mtext': case 'ms': return tokenLatex(node);
    case 'mspace': {
      const w = parseFloat(node.attrs.width || '0');
      if (!(w > 0)) return '';
      return w >= 0.9 ? '\\quad ' : w >= 0.27 ? '\\ ' : '\\,';
    }
    case 'mfrac': {
      const [a, b] = kids.map(nodeLatex);
      // A fraction with no bar and no brackets (a \binom's brackets are handled with its row).
      if (/^0+(\.0*)?(px|em|pt)?$/.test(node.attrs.linethickness || '1')) return `\\genfrac{}{}{0pt}{}${braced(a)}${braced(b)}`;
      return `\\frac${braced(a)}${braced(b)}`;
    }
    case 'msqrt': return `\\sqrt${braced(rowLatex(kids))}`;
    case 'mroot': {
      const base = nodeLatex(kids[0]);
      const index = nodeLatex(kids[1]);
      return `\\sqrt[${index.trim()}]${braced(base)}`;
    }
    case 'msup': case 'msub': case 'msubsup': {
      const base = nodeLatex(kids[0]);
      const b = textOf(kids[0]).length > 1 && kids[0].name !== 'mi' && !LARGE_OPS[textOf(kids[0])] ? `{${base.trim()}}` : base.trim();
      const sub = node.name === 'msup' ? null : nodeLatex(kids[1]);
      const sup = node.name === 'msub' ? null : nodeLatex(kids[node.name === 'msup' ? 1 : 2]);
      // Primes: f' rather than f^{'}
      if (sup !== null && /^'+$/.test(sup.trim())) return `${b}${sub !== null ? `_${group(sub)}` : ''}${sup.trim()}`;
      return `${b}${sub !== null ? `_${group(sub)}` : ''}${sup !== null ? `^${group(sup)}` : ''}`;
    }
    case 'munder': case 'mover': case 'munderover': {
      const baseNode = kids[0];
      const base = nodeLatex(baseNode).trim();
      const under = node.name === 'mover' ? null : nodeLatex(kids[1]);
      const over = node.name === 'munder' ? null : nodeLatex(kids[node.name === 'mover' ? 1 : 2]);
      const word = plainLetters(textOf(baseNode));
      if (LARGE_OPS[textOf(baseNode)] || LIMIT_WORDS.has(word)) {
        return `${base}${under !== null ? `_${group(under)}` : ''}${over !== null ? `^${group(over)}` : ''}`;
      }
      const accentChar = textOf(kids[1] ?? '').trim();
      // \bar is a short accent (stretchy="false"); \overline is a bar over everything.
      if (node.name === 'mover' && /^[‾¯]$/.test(accentChar) && kids[1].attrs.stretchy === 'false') return `\\bar${braced(base)}`;
      if (node.name === 'mover' && ACCENTS[accentChar]) return `${ACCENTS[accentChar]}${braced(base)}`;
      if (node.name === 'munder' && (accentChar === '_' || accentChar === '\u0332' || accentChar === '‾')) return `\\underline${braced(base)}`;
      if (node.name === 'munder' && accentChar === '⏟') return `\\underbrace${braced(base)}`;
      if (node.name === 'munder') return `\\underset${braced(under)}${braced(base)}`;
      if (node.name === 'mover') return `\\overset${braced(over)}${braced(base)}`;
      return `\\overset${braced(over)}{\\underset${braced(under)}${braced(base)}}`;
    }
    case 'mtable': return tableLatex(node, 'matrix');
    case 'menclose': {
      const notation = node.attrs.notation || '';
      if (notation === 'top') return `\\overline${braced(rowLatex(kids))}`;
      if (notation === 'bottom') return `\\underline${braced(rowLatex(kids))}`;
      if (/strike/.test(notation)) return `\\cancel${braced(rowLatex(kids))}`;
      return /box/.test(notation) ? `\\boxed${braced(rowLatex(kids))}` : rowLatex(kids);
    }
    case 'mphantom': return '';
    case 'mfenced': {
      const open = node.attrs.open ?? '(', close = node.attrs.close ?? ')';
      const seps = (node.attrs.separators ?? ',').replace(/\s/g, '');
      const parts = kids.map(nodeLatex);
      const joined = parts.map((p, i) => (i < parts.length - 1 ? p + (seps[Math.min(i, seps.length - 1)] || '') : p)).join('');
      return `\\left${fenceLatex(open)} ${joined} \\right${fenceLatex(close)}`;
    }
    default: return rowLatex(kids);
  }
}

function tableLatex(table, env) {
  const rows = content(table).filter((r) => r.name === 'mtr' || r.name === 'mlabeledtr')
    .map((r) => content(r).filter((c) => c.name === 'mtd').map((c) => rowLatex(content(c)).trim()).join(' & '));
  return `\\begin{${env}} ${rows.join(' \\\\ ')} \\end{${env}}`;
}

export function mathmlToLatex(source, { useAnnotation = true } = {}) {
  const math = readMathml(source);
  if (useAnnotation) {
    const tex = annotation(math, 'application/x-tex') ?? annotation(math, 'TeX') ?? annotation(math, 'LaTeX');
    if (tex) return tex.trim();
  }
  // Tidy the spacing, but never inside \text{...}, where spaces are part of the words.
  return nodeLatex(math).split(/(\\text\{[^{}]*\})/).map((part, i) => (i % 2 ? part
    : part.replace(/\s+/g, ' ').replace(/ ([_^}])/g, '$1'))).join('').trim();
}

export function latexToMathml(latex, display = false) {
  // Temml has no \mbox or \hbox; in maths they are \text (\lim f(x) \mbox{ and } \lim g(x)).
  // Nor nicefrac's \nicefrac{\pi}{2}, a small fraction: \tfrac.
  const source = latex.replace(/\\[mh]box(?![A-Za-z])\s*\{/g, '\\text{').replace(/\\nicefrac(?![A-Za-z])/g, '\\tfrac');
  return temml.renderToString(source, { displayMode: display, annotate: true, throwOnError: true, xml: true });
}

// ---------- MathML -> OMML (Word's own equations) ----------

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const val = (tag, v) => `<m:${tag} m:val="${esc(v)}"/>`;

function run(text, style) {
  if (!text) return '';
  const props = style === 'text' ? '<m:rPr><m:nor/></m:rPr><w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/></w:rPr>'
    : style === 'plain' ? `<m:rPr>${val('sty', 'p')}</m:rPr>` : style === 'bold' ? `<m:rPr>${val('sty', 'b')}</m:rPr>`
    : style === 'double' ? `<m:rPr>${val('scr', 'double-struck')}${val('sty', 'p')}</m:rPr>` : '';
  return `<m:r>${props}<m:t xml:space="preserve">${esc(text)}</m:t></m:r>`;
}

function tokenOmml(node) {
  let text = [...textOf(node)].filter((ch) => !INVISIBLE.has(ch)).join('');
  if (!text) return '';
  if (node.name === 'mtext' || node.name === 'ms') return run(text.replace(/\u00a0/g, ' '), 'text');
  const plain = plainLetters(text);
  if (node.name === 'mi') {
    const variant = node.attrs.mathvariant;
    if (variant === 'double-struck') return run(plain, 'double');
    if (variant === 'bold') return run(plain, 'bold');
    // A single letter is italic in maths (Word's default); words and upright letters are plain.
    if (variant === 'normal' || [...plain].length > 1) return run(plain, 'plain');
    return run(plain);
  }
  if (node.name === 'mo' && text === '-') text = '−';
  return run(plain, node.name === 'mn' || node.name === 'mo' ? null : null);
}

const e = (x) => `<m:e>${x}</m:e>`;
const isLargeOp = (n) => n && (n.name === 'mo' || n.name === 'mi') && LARGE_OPS[textOf(n).trim()] !== undefined;
const RELATION_CHARS = new Set(['=', '<', '>', '≤', '≥', '≠', '≈', '≡', '→', '⇒', '⇔', ',', ';', '∈', '∼']);
const isRelation = (n) => n?.name === 'mo' && RELATION_CHARS.has(textOf(n).trim());
const isSpace = (n) => n?.name === 'mspace' || (n?.name === 'mo' && [...textOf(n)].every((ch) => INVISIBLE.has(ch)));

// A large operator (integral, sum) takes what follows it, up to the next = or comma, as its body.
function naryOmml(opNode, sub, sup, rest, display) {
  const ch = textOf(opNode).trim();
  const isIntegral = /[∫-∳]/.test(ch);
  const limLoc = isIntegral || (!display && opNode.attrs.movablelimits !== 'false' && !isIntegral) ? 'subSup' : 'undOvr';
  const props = `<m:naryPr>${val('chr', ch)}${val('limLoc', isIntegral ? 'subSup' : limLoc)}${sub === null ? val('subHide', '1') : ''}${sup === null ? val('supHide', '1') : ''}</m:naryPr>`;
  return `<m:nary>${props}<m:sub>${sub ?? ''}</m:sub><m:sup>${sup ?? ''}</m:sup>${e(rest)}</m:nary>`;
}

function rowOmml(nodes, display) {
  let out = '';
  for (let i = 0; i < nodes.length; i += 1) {
    const n = nodes[i];
    // sin x, log_2 x: a function name followed by U+2061 and its argument.
    // Temml groups the name with its U+2061: <mrow><mi>tan</mi><mo>&#x2061;</mo><mspace/></mrow> θ
    const head = n.name === 'mrow' && content(n).length > 1 && content(n).slice(1).every(isSpace) ? content(n) : null;
    const fname = functionName(head ? head[0] : n);
    if (fname) {
      let j = i + 1;
      let applied = Boolean(head && head.slice(1).some((x) => textOf(x).includes('\u2061')));
      while (j < nodes.length && isSpace(nodes[j])) { if (textOf(nodes[j]).includes('\u2061')) applied = true; j += 1; }
      if (applied && j < nodes.length && !isRelation(nodes[j])) {
        // The argument: sin(x) takes the bracket; sin 2x and lim f(x) take what follows,
        // up to the next =, +, - or another function.
        const body = [nodes[j]];
        const word = plainLetters(textOf(head ? head[0] : n)).replace(/[^A-Za-z]/g, '');
        if (!(isFencedGroup(nodes[j]) && !LIMIT_WORDS.has(word))) {
          for (let k = j + 1; k < nodes.length && !endsArgument(nodes[k]); k += 1) {
            // \sin x \, dx: a space ends the argument of sin (but lim takes all of f(x) \, g).
            if (nodes[k].name === 'mspace' && !LIMIT_WORDS.has(word)) break;
            body.push(nodes[k]);
          }
        }
        out += `<m:func><m:fName>${fname}</m:fName>${e(rowOmml(body, display))}</m:func>`;
        i = j + body.length - 1;
        continue;
      }
    }
    // Integrals and sums: the operator with its limits, then its body.
    const opInfo = largeOperator(n);
    if (opInfo) {
      let j = i + 1;
      const body = [];
      while (j < nodes.length && !isRelation(nodes[j])) {
        if (body.length && /^[+−-]$/.test(textOf(nodes[j]).trim()) && nodes[j].name === 'mo' && !isIntegral(opInfo.op)) break;
        body.push(nodes[j]); j += 1;
      }
      out += naryOmml(opInfo.op, opInfo.sub, opInfo.sup, rowOmml(body, display), display);
      i = j - 1;
      continue;
    }
    out += nodeOmml(n, display);
  }
  return out;
}
const isIntegral = (op) => /[∫-∳]/.test(textOf(op));
const isFencedGroup = (n) => n?.name === 'mrow' && content(n)[0]?.name === 'mo' && content(n)[0].attrs.fence === 'true';
const isSign = (n) => n?.name === 'mo' && /^[+−±∓-]$/.test(textOf(n).trim());
function endsArgument(n) {
  if (isRelation(n) || isSign(n) || largeOperator(n)) return true;
  const head = n.name === 'mrow' && content(n).length > 1 && content(n).slice(1).every(isSpace) ? content(n)[0] : n;
  return Boolean(functionName(head));
}

function largeOperator(n) {
  if (isLargeOp(n)) return { op: n, sub: null, sup: null };
  if (!['msub', 'msup', 'msubsup', 'munder', 'mover', 'munderover'].includes(n?.name)) return null;
  const k = content(n);
  if (!isLargeOp(k[0])) return null;
  const lower = ['msub', 'msubsup', 'munder', 'munderover'].includes(n.name) ? nodeOmml(k[1]) : null;
  const upper = n.name === 'msup' || n.name === 'mover' ? nodeOmml(k[1]) : (n.name === 'msubsup' || n.name === 'munderover' ? nodeOmml(k[2]) : null);
  return { op: k[0], sub: lower, sup: upper };
}

// The function name part, as OMML, when this node is a function word (sin, log_2, sin^2).
function functionName(n) {
  if (!n) return null;
  const word = (x) => x?.name === 'mi' && FUNCTION_NAMES.has(plainLetters(textOf(x)));
  if (word(n)) return run(plainLetters(textOf(n)), 'plain');
  const k = content(n);
  // lim_{x \to a} written inline is still Word's limit (read "the limit as x approaches a"),
  // not "lim" with a subscript.
  if (n.name === 'msub' && word(k[0]) && LIMIT_WORDS.has(plainLetters(textOf(k[0])))) {
    return `<m:limLow>${e(run(plainLetters(textOf(k[0])), 'plain'))}<m:lim>${nodeOmml(k[1])}</m:lim></m:limLow>`;
  }
  if (['msub', 'msup', 'msubsup', 'munder'].includes(n.name) && word(k[0])) return nodeOmml(n);
  return null;
}

function nodeOmml(node, display = false) {
  if (!node) return '';
  const kids = content(node);
  switch (node.name) {
    case 'math': case 'mrow': case 'mstyle': case 'mpadded': case 'semantics': case 'merror': {
      // \boxed: Temml draws the box with a CSS border.
      if (/border\s*:/.test(node.attrs.style || '')) return `<m:borderBox>${e(rowOmml(kids, display))}</m:borderBox>`;
      const first = kids[0], last = kids.at(-1);
      // Growing brackets: \left( \right), matrices, \binom. Plain f(x) brackets
      // (stretchy="false") stay ordinary characters.
      if (kids.length >= 2 && first.name === 'mo' && last.name === 'mo' && first.attrs.fence === 'true' && last.attrs.fence === 'true'
          && first.attrs.stretchy !== 'false' && last.attrs.stretchy !== 'false') {
        const inner = kids.slice(1, -1);
        const props = `<m:dPr>${val('begChr', textOf(first))}${val('endChr', textOf(last))}</m:dPr>`;
        return `<m:d>${props}${e(rowOmml(inner, display))}</m:d>`;
      }
      return rowOmml(kids, display);
    }
    case 'mi': case 'mn': case 'mo': case 'mtext': case 'ms': return tokenOmml(node);
    case 'mspace': return parseFloat(node.attrs.width || '0') >= 0.27 ? run(' ', 'text') : '';
    case 'mphantom': return '';
    case 'mfrac': {
      // \binom is a fraction with no bar; its brackets come from the row around it.
      const noBar = /^0+(\.0*)?(px|em|pt)?$/.test(node.attrs.linethickness || '1');
      return `<m:f>${noBar ? `<m:fPr>${val('type', 'noBar')}</m:fPr>` : ''}<m:num>${nodeOmml(kids[0])}</m:num><m:den>${nodeOmml(kids[1])}</m:den></m:f>`;
    }
    case 'msqrt': return `<m:rad><m:radPr>${val('degHide', '1')}</m:radPr><m:deg/>${e(rowOmml(kids))}</m:rad>`;
    case 'mroot': return `<m:rad><m:deg>${nodeOmml(kids[1])}</m:deg>${e(nodeOmml(kids[0]))}</m:rad>`;
    case 'msup': case 'msub': case 'msubsup': {
      const op = largeOperator(node);
      if (op) return naryOmml(op.op, op.sub, op.sup, '', display);
      const base = nodeOmml(kids[0]);
      if (node.name === 'msup') {
        // A prime is already raised: f′ is written as is, not as a superscript.
        if (/^[′″‴']+$/.test(textOf(kids[1]).trim())) return base + run(textOf(kids[1]).trim().replace(/'/g, '′'));
        return `<m:sSup>${e(base)}<m:sup>${nodeOmml(kids[1])}</m:sup></m:sSup>`;
      }
      if (node.name === 'msub') return `<m:sSub>${e(base)}<m:sub>${nodeOmml(kids[1])}</m:sub></m:sSub>`;
      return `<m:sSubSup>${e(base)}<m:sub>${nodeOmml(kids[1])}</m:sub><m:sup>${nodeOmml(kids[2])}</m:sup></m:sSubSup>`;
    }
    case 'munder': case 'mover': case 'munderover': {
      const op = largeOperator(node);
      if (op) return naryOmml(op.op, op.sub, op.sup, '', display);
      const base = nodeOmml(kids[0]);
      const mark = textOf(kids[1] ?? '').trim();
      if (node.name === 'mover' && (mark === '‾' || mark === '¯' || mark === '\u0305' || mark === '―')) {
        // \bar on one letter is an accent; \overline on more is a bar.
        if (mark === '¯' || (textOf(kids[0]).length === 1 && node.attrs.accent !== 'false')) {
          return `<m:acc><m:accPr>${val('chr', '\u0305')}</m:accPr>${e(base)}</m:acc>`;
        }
        return `<m:bar><m:barPr>${val('pos', 'top')}</m:barPr>${e(base)}</m:bar>`;
      }
      if (node.name === 'munder' && (mark === '_' || mark === '\u0332' || mark === '‾')) return `<m:bar><m:barPr>${val('pos', 'bot')}</m:barPr>${e(base)}</m:bar>`;
      if (mark === '⏞' || mark === '⏟') {
        return `<m:groupChr><m:groupChrPr>${val('chr', mark)}${val('pos', mark === '⏞' ? 'top' : 'bot')}${val('vertJc', mark === '⏞' ? 'bot' : 'top')}</m:groupChrPr>${e(base)}</m:groupChr>`;
      }
      const ACCENT_CHARS = { 'ˆ': '\u0302', '^': '\u0302', '˜': '\u0303', '~': '\u0303', '→': '\u20d7', '\u20d7': '\u20d7',
        '˙': '\u0307', '¨': '\u0308', 'ˇ': '\u030c', '˘': '\u0306', '´': '\u0301', '`': '\u0300' };
      const combining = /^[\u0300-\u036f\u20d0-⃿]$/.test(mark) ? mark : ACCENT_CHARS[mark];
      if (node.name === 'mover' && combining) return `<m:acc><m:accPr>${val('chr', combining)}</m:accPr>${e(base)}</m:acc>`;
      if (node.name === 'munder') return `<m:limLow>${e(base)}<m:lim>${nodeOmml(kids[1])}</m:lim></m:limLow>`;
      if (node.name === 'mover') return `<m:limUpp>${e(base)}<m:lim>${nodeOmml(kids[1])}</m:lim></m:limUpp>`;
      return `<m:limUpp>${e(`<m:limLow>${e(base)}<m:lim>${nodeOmml(kids[1])}</m:lim></m:limLow>`)}<m:lim>${nodeOmml(kids[2])}</m:lim></m:limUpp>`;
    }
    case 'mtable': {
      const rows = kids.filter((r) => r.name === 'mtr' || r.name === 'mlabeledtr').map((r) => content(r).filter((c) => c.name === 'mtd'));
      const columns = Math.max(1, ...rows.map((r) => r.length));
      const left = rows.some((r) => r.some((c) => /tml-left/.test(c.attrs.class || '') || c.attrs.columnalign === 'left'));
      const props = `<m:mPr><m:mcs><m:mc><m:mcPr>${val('count', String(columns))}${val('mcJc', left ? 'left' : 'center')}</m:mcPr></m:mc></m:mcs></m:mPr>`;
      const body = rows.map((r) => `<m:mr>${Array.from({ length: columns }, (_, k) => e(r[k] ? rowOmml(content(r[k])) : '')).join('')}</m:mr>`).join('');
      return `<m:m>${props}${body}</m:m>`;
    }
    case 'menclose': {
      const notation = node.attrs.notation || 'longdiv';
      if (notation === 'top') return `<m:bar><m:barPr>${val('pos', 'top')}</m:barPr>${e(rowOmml(kids))}</m:bar>`;
      if (notation === 'bottom') return `<m:bar><m:barPr>${val('pos', 'bot')}</m:barPr>${e(rowOmml(kids))}</m:bar>`;
      if (/box|circle/.test(notation)) return `<m:borderBox>${e(rowOmml(kids))}</m:borderBox>`;
      if (/strike/.test(notation)) {
        const hide = `${val('hideTop', '1')}${val('hideBot', '1')}${val('hideLeft', '1')}${val('hideRight', '1')}`;
        const strikes = `${/horizontalstrike/.test(notation) ? val('strikeH', '1') : ''}${/verticalstrike/.test(notation) ? val('strikeV', '1') : ''}${/updiagonalstrike/.test(notation) ? val('strikeBLTR', '1') : ''}${/downdiagonalstrike/.test(notation) ? val('strikeTLBR', '1') : ''}`;
        return `<m:borderBox><m:borderBoxPr>${hide}${strikes}</m:borderBoxPr>${e(rowOmml(kids))}</m:borderBox>`;
      }
      return rowOmml(kids);
    }
    case 'mfenced': {
      const seps = (node.attrs.separators ?? ',').replace(/\s/g, '');
      const props = `<m:dPr>${val('begChr', node.attrs.open ?? '(')}${seps[0] && seps[0] !== ',' ? val('sepChr', seps[0]) : ''}${val('endChr', node.attrs.close ?? ')')}</m:dPr>`;
      return `<m:d>${props}${kids.map((k) => e(nodeOmml(k))).join('')}</m:d>`;
    }
    default: return rowOmml(kids, display);
  }
}

// One equation as Word's <m:oMath>; display equations go on their own line in <m:oMathPara>.
export function mathmlToOmml(source, display = false) {
  const math = readMathml(source);
  const isDisplay = display || math.attrs.display === 'block';
  const body = `<m:oMath>${nodeOmml(math, isDisplay)}</m:oMath>`;
  return isDisplay ? `<m:oMathPara><m:oMathParaPr>${val('jc', 'center')}</m:oMathParaPr>${body}</m:oMathPara>` : body;
}

export function latexToOmml(latex, display = false) {
  return mathmlToOmml(latexToMathml(latex, display), display);
}
