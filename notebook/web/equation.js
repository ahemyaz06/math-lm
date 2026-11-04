// Plain-text math (what you type: x^2, sqrt(x+1), (a+b)/(c-d)) <-> LaTeX.
// Both directions are rules, not AI, so a conversion never changes the mathematics.

const FUNCTIONS = ['arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'sin', 'cos', 'tan', 'sec', 'csc', 'cot', 'ln', 'log', 'exp', 'lim', 'max', 'min'];
const GREEK = ['alpha', 'beta', 'gamma', 'delta', 'Delta', 'epsilon', 'theta', 'Theta', 'lambda', 'mu', 'pi', 'Pi', 'rho', 'sigma', 'Sigma', 'tau', 'phi', 'omega', 'Omega'];
const RELATIONS = { '<=': '\\le', '>=': '\\ge', '!=': '\\ne', '=': '=', '<': '<', '>': '>', '->': '\\to', '~=': '\\approx' };
const SYMBOLS = { inf: '\\infty', infinity: '\\infty', pm: '\\pm', '+-': '\\pm', dx: 'dx', dy: 'dy', dz: 'dz', dt: 'dt', du: 'du', dr: 'dr', ds: 'ds', dA: 'dA', dV: 'dV' };
// Integrals and sums: int_0^1 x^2 dx, sum_(n=1)^inf 1/n^2. "integral" is the word for int.
const LARGE = { int: '\\int', integral: '\\int', iint: '\\iint', iiint: '\\iiint', oint: '\\oint', sum: '\\sum', prod: '\\prod' };
// Maths characters pasted from elsewhere (∫ x² dx copied from a page) read as their typed words.
const PASTED = { '∫': 'int', '∬': 'iint', '∭': 'iiint', '∮': 'oint', '∑': 'sum', '∏': 'prod', 'π': 'pi', '∞': 'inf',
  '≤': '<=', '≥': '>=', '≠': '!=', '·': '*', '×': '*', '−': '-', '÷': '/', '²': '^2', '³': '^3' };

function tokenize(text) {
  const tokens = [];
  const source = text.replace(/[∫∬∭∮∑∏π∞≤≥≠·×−÷²³]/g, (ch) => ` ${PASTED[ch]} `).replace(/ (\^[23]) /g, '$1');
  const re = /\s*(\d+(?:\.\d+)?|\.\d+|<=|>=|!=|->|~=|\+-|[A-Za-z]+|[-+*/^_=<>(),[\]{}|'!:;]|\S)/gy;
  let m;
  while ((m = re.exec(source))) tokens.push(m[1]);
  return tokens;
}

// Split runs like "xy" or "2x" written without * into separate letters, but keep
// function names (sin, ln), Greek names (theta) and symbol words (inf) whole.
function splitWord(word) {
  const known = [...FUNCTIONS, ...GREEK, ...Object.keys(SYMBOLS), ...Object.keys(LARGE), 'sqrt', 'abs', 'cbrt', 'root', 'text'].sort((a, b) => b.length - a.length);
  const out = [];
  let rest = word;
  while (rest) {
    const hit = known.find((k) => rest.startsWith(k));
    if (hit) { out.push(hit); rest = rest.slice(hit.length); } else { out.push(rest[0]); rest = rest.slice(1); }
  }
  return out;
}

class Parser {
  constructor(text) {
    this.tokens = tokenize(text).flatMap((t) => (/^[A-Za-z]{2,}$/.test(t) ? splitWord(t) : [t]));
    this.i = 0;
    this.absOpen = 0;
  }
  peek(k = 0) { return this.tokens[this.i + k]; }
  next() { return this.tokens[this.i++]; }
  eat(t) { if (this.peek() === t) { this.i += 1; return true; } return false; }
  expect(t) { if (!this.eat(t)) throw new Error(`Expected "${t}"${this.peek() ? ` before "${this.peek()}"` : ' at the end'}.`); }

  parse() {
    const parts = [this.relation()];
    while (this.eat(',')) parts.push(this.relation());
    if (this.i < this.tokens.length) throw new Error(`Unexpected "${this.peek()}".`);
    return parts.length === 1 ? parts[0] : { type: 'list', items: parts };
  }
  relation() {
    let left = this.sum();
    while (RELATIONS[this.peek()]) {
      const op = this.next();
      left = { type: 'rel', op, left, right: this.sum() };
    }
    return left;
  }
  sum() {
    let left = this.term();
    while (this.peek() === '+' || this.peek() === '-' || this.peek() === '+-') {
      const op = this.next();
      left = { type: 'bin', op, left, right: this.term() };
    }
    return left;
  }
  startsFactor(t) {
    return t !== undefined && (/^[A-Za-z\d.]/.test(t) || t === '(' || t === '[' || t === '|' && this.absOpen === 0);
  }
  term() {
    let left = this.unary();
    for (;;) {
      if (this.eat('*')) left = { type: 'mul', explicit: true, left, right: this.unary() };
      else if (this.eat('/')) left = { type: 'frac', num: left, den: this.unary() };
      else if (this.startsFactor(this.peek()) && !RELATIONS[this.peek()]) left = { type: 'mul', explicit: false, left, right: this.unary() };
      else return left;
    }
  }
  unary() {
    if (this.eat('-')) return { type: 'neg', arg: this.unary() };
    if (this.eat('+')) return this.unary();
    return this.power();
  }
  power() {
    const base = this.postfix();
    if (this.eat('^')) {
      // a^- and a^+ (one-sided limits): a lone sign as the exponent.
      const sign = this.peek();
      if ((sign === '-' || sign === '+') && !this.startsFactor(this.peek(1))) {
        this.next();
        return { type: 'pow', base, exp: { type: 'sym', latex: sign } };
      }
      return { type: 'pow', base, exp: this.unary() };
    }
    return base;
  }
  postfix() {
    let node = this.primary();
    for (;;) {
      if (this.eat("'")) node = { type: 'prime', arg: node };
      else if (this.eat('!')) node = { type: 'fact', arg: node };
      else if (this.eat('_')) node = { type: 'sub', base: node, sub: this.primary() };
      else return node;
    }
  }
  group(open, close) {
    const inner = this.relationList();
    this.expect(close);
    return { type: 'paren', open, close, inner };
  }
  relationList() {
    const parts = [this.relation()];
    while (this.eat(',')) parts.push(this.relation());
    return parts.length === 1 ? parts[0] : { type: 'list', items: parts };
  }
  primary() {
    const t = this.next();
    if (t === undefined) throw new Error('The equation ends too early.');
    if (/^(\d|\.)/.test(t)) return { type: 'num', value: t };
    if (t === '(') return this.group('(', ')');
    if (t === '[') return this.group('[', ']');
    if (t === '{') return this.group('{', '}');
    if (t === '|') {
      this.absOpen = (this.absOpen || 0) + 1;
      const inner = this.sum();
      this.expect('|');
      this.absOpen -= 1;
      return { type: 'abs', arg: inner };
    }
    if (t === 'sqrt' || t === 'abs' || t === 'cbrt') {
      const arg = this.peek() === '(' ? (this.next(), this.groupInner(')')) : this.power();
      return t === 'abs' ? { type: 'abs', arg } : { type: 'sqrt', arg, index: t === 'cbrt' ? '3' : null };
    }
    if (t === 'root') {
      this.expect('(');
      const index = this.relation();
      this.expect(',');
      const arg = this.relation();
      this.expect(')');
      return { type: 'sqrt', arg, index };
    }
    if (t === 'lim') {
      let under = null;
      if (this.eat('_')) under = this.primary();
      return { type: 'lim', under, arg: this.unary() };
    }
    if (LARGE[t]) {
      // Its limits in either order (int_0^1 or int^1_0), then the body. The body of an integral
      // runs to its dx (or to an = or a comma); a sum's body is one term, as in print.
      let sub = null, sup = null;
      for (let k = 0; k < 2; k += 1) {
        if (!sub && this.eat('_')) sub = this.primary();
        else if (!sup && this.eat('^')) sup = this.primary();
      }
      const integral = LARGE[t] !== '\\sum' && LARGE[t] !== '\\prod';
      const starts = this.startsFactor(this.peek()) || this.peek() === '-' || LARGE[this.peek()];
      const body = !starts ? null : integral ? this.sum() : this.term();
      return { type: 'large', latex: LARGE[t], sub, sup, body };
    }
    if (FUNCTIONS.includes(t)) {
      let power = null;
      // log_2 x, log_b(x): a logarithm's base is written as a subscript.
      const base = t === 'log' && this.eat('_') ? this.primary() : null;
      if (this.peek() === '^') { this.next(); power = this.primary(); }
      const arg = this.peek() === '(' ? this.primary() : this.unary();
      return { type: 'fn', name: t, power, arg, base };
    }
    if (GREEK.includes(t)) return { type: 'sym', latex: `\\${t}` };
    if (SYMBOLS[t]) return { type: 'sym', latex: SYMBOLS[t] };
    if (/^[A-Za-z]$/.test(t)) return { type: 'var', name: t };
    throw new Error(`Unexpected "${t}".`);
  }
  groupInner(close) {
    const inner = this.relationList();
    this.expect(close);
    return inner;
  }
}

const strip = (n) => (n.type === 'paren' && n.open === '(' ? n.inner : n);
const isSimple = (n) => ['num', 'var', 'sym'].includes(n.type);

function toLatex(n) {
  switch (n.type) {
    case 'num': case 'var': return n.type === 'num' ? n.value : n.name;
    case 'sym': return n.latex;
    case 'list': return n.items.map(toLatex).join(', ');
    case 'rel': return `${toLatex(n.left)} ${RELATIONS[n.op]} ${toLatex(n.right)}`;
    case 'bin': return `${toLatex(n.left)} ${n.op === '+-' ? '\\pm' : n.op} ${toLatex(n.right)}`;
    case 'neg': return `-${toLatex(n.arg)}`;
    case 'mul': {
      const left = toLatex(n.left), right = toLatex(n.right);
      // 3*x is written 3x, as in print; a number after anything needs a dot (2 \cdot 3, x \cdot 2).
      if (n.right.type === 'num' || (/\d$/.test(left) && /^\d/.test(right))) return `${left} \\cdot ${right}`;
      // x^2 dx: the thin space printed before a differential.
      if (n.right.type === 'sym' && SYMBOLS[n.right.latex] === n.right.latex && /^d/.test(right)) return `${left}\\,${right}`;
      // \pi x needs a space so it is not read as the command \pix.
      return /\\[A-Za-z]+$/.test(left) && /^[A-Za-z]/.test(right) ? `${left} ${right}` : `${left}${right}`;
    }
    case 'frac': return `\\frac{${toLatex(strip(n.num))}}{${toLatex(strip(n.den))}}`;
    case 'pow': return `${toLatex(n.base.type === 'neg' || n.base.type === 'frac' ? { type: 'paren', open: '(', close: ')', inner: n.base } : n.base)}^{${toLatex(strip(n.exp))}}`;
    case 'sub': return `${toLatex(n.base)}_{${toLatex(strip(n.sub))}}`;
    case 'prime': return `${toLatex(n.arg)}'`;
    case 'fact': return `${toLatex(n.arg)}!`;
    case 'paren': {
      const [o, c] = n.open === '{' ? ['\\{', '\\}'] : [n.open, n.close];
      const inner = toLatex(n.inner);
      // Grow the brackets only around tall contents such as fractions.
      return /\\frac|\\sqrt|\\lim/.test(inner) ? `\\left${o} ${inner} \\right${c}` : `${o}${inner}${c}`;
    }
    case 'abs': {
      const inner = toLatex(n.arg);
      return /\\frac|\\sqrt/.test(inner) ? `\\left| ${inner} \\right|` : `|${inner}|`;
    }
    case 'sqrt': return n.index ? `\\sqrt[${toLatex(typeof n.index === 'string' ? { type: 'num', value: n.index } : n.index)}]{${toLatex(strip(n.arg))}}` : `\\sqrt{${toLatex(strip(n.arg))}}`;
    case 'lim': return `\\lim_{${n.under ? toLatex(strip(n.under)) : ''}} ${toLatex(n.arg)}`;
    case 'large': {
      const limits = `${n.sub ? `_{${toLatex(strip(n.sub))}}` : ''}${n.sup ? `^{${toLatex(strip(n.sup))}}` : ''}`;
      return `${n.latex}${limits}${n.body ? ` ${toLatex(n.body)}` : ''}`;
    }
    case 'fn': {
      const name = ['arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'sin', 'cos', 'tan', 'sec', 'csc', 'cot', 'ln', 'log', 'exp', 'max', 'min'].includes(n.name) ? `\\${n.name}` : `\\operatorname{${n.name}}`;
      const arg = n.arg.type === 'paren' ? toLatex(n.arg) : ` ${toLatex(n.arg)}`;
      return `${name}${n.base ? `_{${toLatex(strip(n.base))}}` : ''}${n.power ? `^{${toLatex(strip(n.power))}}` : ''}${arg}`;
    }
    default: throw new Error('Unknown piece of math.');
  }
}

export function plainToLatex(text) {
  const source = text.trim();
  if (!source) return '';
  const domain = splitDomain(source);
  if (domain) return `${plainToLatex(domain.main)}, \\quad ${domainLatex(domain)}`;
  // An interval on its own: x in [0, 2pi).
  const alone = /^x\s*(in|∈)/i.test(source) && intervalCondition(source) && trailingInterval(source.replace(/∈/g, ' in '));
  if (alone) return domainLatex({ kind: 'interval', interval: alone });
  return toLatex(new Parser(source).parse()).replace(/\s+/g, ' ').trim();
}

// ---------- comments: words next to the maths that never become maths ----------
// As in programming, everything from # or // to the end is a comment: y = x^2 # the parabola.
// In LaTeX, % starts a comment too (as it does in a .tex file); \# and \% are the signs themselves.
export function splitComment(text) {
  const latex = /\\[A-Za-z]|[_^]\{/.test(text);
  const m = (latex ? /(?<!\\)(#|\/\/|%)/ : /#|\/\//).exec(text);
  if (!m) return { code: text, comment: '' };
  return { code: text.slice(0, m.index).trimEnd(), comment: text.slice(m.index).trim() };
}

// ---------- where a function applies: an interval after it ----------
// y = sin x, [0, 2pi]     y = sin x on [0, 2pi)     y = sin x, x in (0, pi]     y = x^2 for 0 < x < 1
// y = x^2 {0 < x < 1}. (y = x^2, 0 < x < 1 was already a list the parser reads.)
// A square bracket keeps that end, a round one leaves it out, as in class.

const IS_INF = /^[+]?(inf|infinity|∞)$/i;
const IS_MINUS_INF = /^-\s*(inf|infinity|∞)$/i;

// The interval at the very end of the text: its brackets may differ, [0, 2pi), and its ends may
// have brackets of their own, [(-pi)/2, pi/2].
function trailingInterval(text) {
  const t = text.trimEnd();
  if (!/[\])]$/.test(t)) return null;
  let depth = 0, comma = -1, commas = 0;
  for (let i = t.length - 1; i >= 0; i -= 1) {
    const ch = t[i];
    if (ch === ')' || ch === ']') depth += 1;
    else if (ch === '(' || ch === '[') {
      depth -= 1;
      if (depth === 0) {
        if (commas !== 1) return null;
        return { before: t.slice(0, i), open: ch, close: t.at(-1), lo: t.slice(i + 1, comma).trim(), hi: t.slice(comma + 1, -1).trim() };
      }
    } else if (ch === ',' && depth === 1) { commas += 1; comma = i; }
  }
  return null;
}

// "x in [a, b)" (or just "[a, b)") as the comparisons a <= x < b; null when it is not one.
export function intervalCondition(text) {
  const words = text.replace(/∈/g, ' in ').trim();
  const found = trailingInterval(words);
  if (!found || !found.lo || !found.hi || !/^\s*((x\s*)?in\s*)?$/i.test(found.before)) return null;
  return intervalWords(found);
}

function intervalWords({ open, close, lo, hi }) {
  if (IS_INF.test(lo) || IS_MINUS_INF.test(hi)) throw new Error(`The interval ${open}${lo}, ${hi}${close} is written backwards: the smaller end comes first.`);
  const parts = [];
  if (!IS_MINUS_INF.test(lo)) parts.push(`${lo} ${open === '[' ? '<=' : '<'} x`);
  if (!IS_INF.test(hi)) parts.push(`x ${close === ']' ? '<=' : '<'} ${hi}`);
  // [a, inf) is a <= x; (-inf, inf) is every x.
  return parts.length === 2 ? `${lo} ${open === '[' ? '<=' : '<'} x ${close === ']' ? '<=' : '<'} ${hi}` : parts[0] || 'otherwise';
}

// The function and where it applies, from plain text; null when the text has no interval.
// Returns { main, condition (comparisons of x, or 'otherwise'), kind, interval }.
export function splitDomain(text) {
  const source = text.replace(/∈/g, ' in ').trim();
  // {0 < x < 1} after the function.
  const braces = /^(.*\S)\s*,?\s*\{([^{}]*)\}$/.exec(source);
  if (braces && /=/.test(braces[1]) && /\bx\b/.test(braces[2])) {
    const inner = braces[2].trim();
    const main = braces[1].trim().replace(/,$/, '');
    const interval = intervalCondition(inner) && trailingInterval(inner);
    if (interval) return { main, condition: intervalWords(interval), kind: 'interval', interval };
    return { main, condition: inner, kind: 'braces', inner };
  }
  // ... [a, b], ... on [a, b], ... x in [a, b], ... for x in (a, b).
  const found = trailingInterval(source);
  if (found && found.lo && found.hi) {
    const m = /^(.*?\S)\s*(,)?\s*(?:\b(on|for|when|where|if)\b\s*)?(\bx\s*in\b\s*)?$/i.exec(found.before);
    // A bare (a, b) after a comma could be a point, so it needs "on" or "x in"; [a, b] cannot.
    if (m && /=/.test(m[1]) && (m[3] || m[4] || (m[2] && (found.open === '[' || found.close === ']')))) {
      return { main: m[1].replace(/,$/, '').trim(), condition: intervalWords(found), kind: 'interval', interval: found };
    }
  }
  // ... for 0 < x < 1 (also when, where, if).
  const words = /^(.*?\S)\s*,?\s*\b(for|when|where|if)\b\s+(.*\bx\b.*)$/i.exec(source);
  if (words && /=/.test(words[1]) && /[<>]|<=|>=|!=|≤|≥|≠/.test(words[3])) {
    return { main: words[1].trim(), condition: words[3].trim(), kind: 'words', word: words[2].toLowerCase(), inner: words[3].trim() };
  }
  return null;
}

function domainLatex(domain) {
  if (domain.kind === 'interval') {
    const { open, close, lo, hi } = domain.interval;
    const end = (v) => (IS_INF.test(v) ? '\\infty' : IS_MINUS_INF.test(v) ? '-\\infty' : plainToLatex(v));
    return `x \\in ${open}${end(lo)}, ${end(hi)}${close}`;
  }
  if (domain.kind === 'words') return `\\text{${domain.word} } ${plainToLatex(domain.inner)}`;
  return plainToLatex(domain.inner);
}

// The parsed form of plain-text maths (used by the graphs, which evaluate it).
export function parsePlain(text) {
  return new Parser(text.trim()).parse();
}

// ---------- LaTeX -> plain text ----------

const LATEX_WORDS = {
  cdot: '*', times: '*', div: '/', pm: '+-', mp: '-+', le: '<=', leq: '<=', ge: '>=', geq: '>=', ne: '!=', neq: '!=',
  to: '->', rightarrow: '->', infty: 'inf', approx: '~=', circ: 'o', ldots: '...', cdots: '...', quad: ' ', qquad: ' ',
  ',': ' ', ';': ' ', ':': ' ', '!': '', ' ': ' ', '{': '{', '}': '}', '%': '%', '|': '|', lvert: '|', rvert: '|', vert: '|',
};

function readGroup(src, i) {
  // src[i] is '{'; return [content, index after the closing brace].
  let depth = 0;
  for (let j = i; j < src.length; j += 1) {
    if (src[j] === '\\') { j += 1; continue; }
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') { depth -= 1; if (depth === 0) return [src.slice(i + 1, j), j + 1]; }
  }
  throw new Error('A { has no matching }.');
}

function readArg(src, i) {
  while (src[i] === ' ') i += 1;
  if (src[i] === '{') return readGroup(src, i);
  if (src[i] === '\\') {
    const m = /^\\([A-Za-z]+|.)/.exec(src.slice(i));
    return [m[0], i + m[0].length];
  }
  return [src[i] ?? '', i + 1];
}

// Where the bracket opened at text[start] closes, or -1.
function closing(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

const NAMED = new Set([...GREEK, ...Object.keys(SYMBOLS), 'infinity']);

// One piece that a fraction bar or a power cannot split when read back: a number, one letter,
// a named symbol (pi), a bracketed group, a function call (sqrt(x)), or a power of those (x^2).
// "2x" or "xy" is not one piece: 1/2x would read back as (1/2)x.
function isAtom(s) {
  if (/^\d+(\.\d+)?$/.test(s) || /^[A-Za-z]$/.test(s) || NAMED.has(s)) return true;
  if (s[0] === '(') return closing(s, 0) === s.length - 1;
  const call = /^([A-Za-z]+)\(/.exec(s);
  if (call && ['sqrt', 'cbrt', 'abs', 'root', ...FUNCTIONS].includes(call[1])) return closing(s, call[1].length) === s.length - 1;
  // base^exponent or base_sub, where both are single pieces (a power binds tighter than /).
  for (let i = 1; i < s.length; i += 1) {
    if ((s[i] === '^' || s[i] === '_') && isAtom(s.slice(0, i))) {
      const rest = s.slice(i + 1);
      if (/^[+-]$/.test(rest) || isAtom(rest)) return true;
    }
  }
  return false;
}

// Brackets are added only when needed: a lone sign (a^-) or one piece stays as it is.
function wrap(text) {
  const s = text.trim();
  if (/^[+-]$/.test(s) || isAtom(s)) return s;
  return `(${s})`;
}

export function latexToPlain(latex) {
  let out = '';
  let i = 0;
  // \limits only moves an integral's limits; the plain text has one way to write them.
  const src = latex.replace(/\\left|\\right|\\big|\\Big|\\bigg|\\Bigg|\\displaystyle|\\(?:no)?limits(?![A-Za-z])/g, '');
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      const m = /^\\([A-Za-z]+|.)/.exec(src.slice(i));
      const name = m[1];
      i += m[0].length;
      if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
        const [num, a] = readArg(src, i);
        const [den, b] = readArg(src, a);
        out += `${wrap(latexToPlain(num))}/${wrap(latexToPlain(den))}`;
        i = b;
      } else if (name === 'sqrt') {
        let index = null;
        if (src[i] === '[') { const close = src.indexOf(']', i); index = src.slice(i + 1, close); i = close + 1; }
        const [arg, a] = readArg(src, i);
        if (/[A-Za-z0-9]$/.test(out)) out += ' '; // x sqrt(2+x), not xsqrt(2+x)
        out += index ? (index.trim() === '3' ? `cbrt(${latexToPlain(arg)})` : `root(${latexToPlain(index)}, ${latexToPlain(arg)})`) : `sqrt(${latexToPlain(arg)})`;
        i = a;
      } else if (['text', 'mathrm', 'operatorname', 'mathbf', 'mathit', 'textbf'].includes(name)) {
        const [arg, a] = readArg(src, i);
        out += name === 'text' ? ` ${arg.trim()} ` : arg;
        i = a;
      } else if (name === 'begin' || name === 'end') {
        const [env, a] = readArg(src, i);
        i = a;
        if (name === 'begin' && /array|tabular/.test(env) && src[i] === '{') i = readGroup(src, i)[1];
        if (name === 'begin' && env === 'cases') out += 'cases( ';
        if (name === 'end' && env === 'cases') out += ' )';
      } else if (name === '\\') {
        out += '; ';
      } else if (LATEX_WORDS[name] !== undefined) {
        out += ['cdot', 'times', 'le', 'leq', 'ge', 'geq', 'ne', 'neq', 'to', 'approx', 'pm'].includes(name) ? ` ${LATEX_WORDS[name]} ` : LATEX_WORDS[name];
      } else {
        // sin, ln, pi, theta, lim ... as words, with a space from the letters around them:
        // \sin{\theta} is "sin theta", 2\pi x is "2 pi x". A bracket stays close: cos(x).
        const word = /^[A-Za-z]+$/.test(name);
        if (word && /[A-Za-z0-9]$/.test(out)) out += ' ';
        out += name;
        if (word && /^\s*(\{\s*)?([A-Za-z0-9]|\\[A-Za-z])/.test(src.slice(i))) out += ' ';
      }
    } else if (ch === '^' || ch === '_') {
      const [arg, a] = readArg(src, i + 1);
      // A power inside a power keeps its brackets for the reader: e^(x^2), not e^x^2.
      const inner = latexToPlain(arg);
      out += ch + (/[\^_]/.test(inner) && !/^\(.*\)$/.test(inner) ? `(${inner})` : wrap(inner));
      i = a;
    } else if (ch === '{' || ch === '}') {
      i += 1;
    } else if (ch === '&') {
      out += ' ';
      i += 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim();
}

// Words a screen reader can say for a short equation label, e.g. in a graph list.
export function speakable(plain) {
  const LARGE_WORDS = { int: 'integral', iint: 'double integral', iiint: 'triple integral', oint: 'contour integral', sum: 'sum', prod: 'product' };
  const unwrap = (s) => s.replace(/^\((.*)\)$/, '$1');
  return plain.replace(/\b(iiint|iint|oint|int|sum|prod)(?:_(\([^)]*\)|[^\s^]+))?(?:\^(\([^)]*\)|\S+))?(?=\s|$)/g,
    (m, word, sub, sup) => `${LARGE_WORDS[word]}${sub ? ` ${sup ? 'from' : 'over'} ${unwrap(sub)}` : ''}${sup ? ` to ${unwrap(sup)}` : ''} of`)
    .replace(/\^2\b/g, ' squared').replace(/\^3\b/g, ' cubed').replace(/\^/g, ' to the ').replace(/\*/g, ' times ')
    .replace(/\//g, ' over ').replace(/sqrt/g, 'square root of ').replace(/\s+/g, ' ').trim();
}
