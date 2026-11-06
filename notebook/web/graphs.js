// Graphs from maths in the document: LaTeX or plain text, including piecewise functions
// (\begin{cases}), become functions that Sound Lab's engine can trace and describe.
// Rules, not AI: the maths is parsed and evaluated, never guessed.
import { intervalCondition, latexToPlain, parsePlain, plainToLatex, splitDomain } from './equation.js';
import { compileEquation, compileExpression, detectLandmarks, formatNumber } from '/sound/graph-math.js';

// How numbers are said while exploring a graph (Settings > Graph sound): 'half' rounds to the
// nearest half (4.1931 is 4, 0.894 is 1, 0.00004 is 0), 'tenth' to one decimal, 'exact' keeps
// six digits. What is written into the document (makeGraph, studentGraph) has at most two
// decimals (1.41421 is 1.41; the owner asked, 2026-11-05), whatever the setting.
let numberStyle = 'exact';
export function setNumberStyle(style) {
  if (['half', 'tenth', 'exact'].includes(style)) numberStyle = style;
}
export function roundForSpeech(n) {
  if (!Number.isFinite(n)) return n;
  // Halves round away from zero on both sides: 3.75 is 4 and -3.75 is -4 (Math.round alone
  // would make -3.75 into -3.5).
  const to = (k) => Math.sign(n) * Math.round(Math.abs(n) * k) / k;
  // Written: two decimals, but a small number that is not 0 keeps two digits (0.004 is not 0).
  const written = () => (Math.abs(n) < .005 && Math.abs(n) > 1e-7 ? Number(n.toPrecision(2)) : to(100));
  const r = numberStyle === 'half' ? to(2) : numberStyle === 'tenth' ? to(10) : numberStyle === 'written' ? written() : n;
  // A point found a hair inside an open end (1e-9 for "0 < x") is said as that end.
  return Math.abs(r) < 1e-7 ? 0 : r;
}
export const say = (n) => formatNumber(roundForSpeech(n)).replace('-', 'minus ');
// Two decimals while work runs: what is written, and the points a description names.
export function exactly(work) {
  const before = numberStyle;
  numberStyle = 'written';
  try { return work(); } finally { numberStyle = before; }
}

// ---------- the parsed maths -> Sound Lab's expression syntax ----------

const INVERSE = { sin: 'asin', cos: 'acos', tan: 'atan' };

function graphText(n) {
  switch (n.type) {
    case 'num': return n.value;
    case 'var':
      if (n.name === 'x' || n.name === 'e') return n.name;
      throw new Error(`The letter ${n.name} has no value; a graph can only vary x. Write the number instead.`);
    case 'sym':
      if (n.latex === '\\pi') return 'pi';
      throw new Error(`${n.latex.replace('\\', '')} cannot be graphed.`);
    case 'bin':
      if (n.op === '+-') throw new Error('A ± sign gives two functions; write them as two lines.');
      return `(${graphText(n.left)}${n.op}${graphText(n.right)})`;
    case 'neg': return `(-(${graphText(n.arg)}))`;
    case 'mul': return `(${graphText(n.left)}*${graphText(n.right)})`;
    case 'frac': return `((${graphText(n.num)})/(${graphText(n.den)}))`;
    case 'pow':
      if (n.exp.type === 'sym' && (n.exp.latex === '+' || n.exp.latex === '-')) throw new Error('A one-sided sign (a^+ or a^-) is a limit, not a function.');
      return `((${graphText(n.base)})^(${graphText(n.exp)}))`;
    case 'paren': return `(${graphText(n.inner)})`;
    case 'abs': return `abs(${graphText(n.arg)})`;
    case 'sqrt':
      if (!n.index) return `sqrt(${graphText(n.arg)})`;
      if (n.index === '3' || (n.index.type === 'num' && n.index.value === '3')) return `cbrt(${graphText(n.arg)})`;
      return `((${graphText(n.arg)})^(1/(${graphText(typeof n.index === 'string' ? { type: 'num', value: n.index } : n.index)})))`;
    case 'fn': {
      const a = graphText(n.arg);
      // sin^{-1} x is arcsin x; sin^2 x is (sin x)^2.
      const power = n.power ? graphText(n.power) : null;
      if (power && /^\(?\(-\(1\)\)\)?$|^-1$/.test(power.replace(/\s/g, '')) && INVERSE[n.name]) return `${INVERSE[n.name]}(${a})`;
      const base = {
        sin: `sin(${a})`, cos: `cos(${a})`, tan: `tan(${a})`, sec: `(1/cos(${a}))`, csc: `(1/sin(${a}))`, cot: `(cos(${a})/sin(${a}))`,
        arcsin: `asin(${a})`, arccos: `acos(${a})`, arctan: `atan(${a})`, ln: `ln(${a})`, log: `log(${a})`, exp: `exp(${a})`,
        sinh: `((exp(${a})-exp(-(${a})))/2)`, cosh: `((exp(${a})+exp(-(${a})))/2)`, tanh: `((exp(${a})-exp(-(${a})))/(exp(${a})+exp(-(${a}))))`,
      }[n.name];
      if (!base) throw new Error(`${n.name} cannot be graphed yet.`);
      // log_b x = ln x / ln b
      const logged = n.name === 'log' && n.base ? `(ln(${a})/ln(${graphText(n.base)}))` : base;
      return power ? `((${logged})^(${power}))` : logged;
    }
    case 'sub': throw new Error('A subscript (like x_1) is a name, not a function of x.');
    case 'fact': throw new Error('Factorials cannot be graphed.');
    case 'prime': throw new Error("A derivative (f') cannot be graphed from its name; write the function itself.");
    case 'lim': throw new Error('A limit is a number, not a function to graph.');
    case 'large': throw new Error(`${n.latex === '\\sum' || n.latex === '\\prod' ? 'A sum or product' : 'An integral'} cannot be graphed; graph the function inside it instead.`);
    case 'list': throw new Error('Write one function per line. For an interval, write on (1, 2) or for 1 < x < 2.');
    case 'rel': throw new Error('Only one = sign, as in y = x^2.');
    default: throw new Error('This cannot be graphed.');
  }
}

// "y = ...", "f(x) = ..." or just the right-hand side.
function functionSide(ast) {
  if (ast.type !== 'rel') return { name: null, body: ast };
  if (ast.op !== '=') throw new Error('An inequality cannot be graphed yet; write a function such as y = x^2.');
  const isName = (n) => n.type === 'var' && n.name === 'y'
    || (n.type === 'mul' && n.left.type === 'var' && n.right.type === 'paren' && n.right.inner.type === 'var' && n.right.inner.name === 'x');
  if (isName(ast.left) && ast.right.type !== 'rel') return { name: ast.left.type === 'var' ? 'y' : `${ast.left.left.name}(x)`, body: ast.right };
  if (isName(ast.right) && ast.left.type !== 'rel') return { name: ast.right.type === 'var' ? 'y' : `${ast.right.left.name}(x)`, body: ast.left };
  const isX = (n) => n.type === 'var' && n.name === 'x';
  if (isX(ast.left) !== isX(ast.right) && !/"name":"[xy]"/.test(JSON.stringify(isX(ast.left) ? ast.right : ast.left))) throw new Error('A vertical line (x = 2) cannot be graphed yet; graphs are of functions, y = ...');
  throw new Error('Write the function as y = ... or f(x) = ... so it is clear what to graph.');
}

function constantValue(ast) {
  const value = compileExpression(graphText(ast)).evaluate({});
  if (!Number.isFinite(value)) throw new Error('A condition needs a number on one side of x.');
  return value;
}

// ---------- piecewise conditions: x < 0, 0 <= x < 2, x = 1, x != 3, otherwise ----------

function comparisons(ast, out = []) {
  if (ast.type !== 'rel') throw new Error('Each condition compares x with a number, such as x < 2.');
  // a < b < c is read by the parser as (a < b) < c.
  if (ast.left.type === 'rel') { comparisons(ast.left, out); out.push([ast.left.right, ast.op, ast.right]); }
  else out.push([ast.left, ast.op, ast.right]);
  return out;
}

const FLIP = { '<': '>', '>': '<', '<=': '>=', '>=': '<=', '=': '=', '!=': '!=' };

export function parseCondition(text) {
  let words = text.replace(/\b(if|for|when|where)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  // x in [0, 2pi), and {0 < x < 1} with its braces.
  words = words.replace(/^\{(.*)\}$/, '$1').trim();
  words = intervalCondition(words) || words;
  if (!words || /^(otherwise|else|elsewhere|all other x)$/i.test(words)) return { otherwise: true, text: 'otherwise' };
  const range = { lo: -Infinity, loClosed: false, hi: Infinity, hiClosed: false, not: [], text: words };
  // "x > 0 and x < 2", "x > 0, x < 2": each part is its own comparison.
  const parts = words.split(/\band\b|[,;]/i).map((p) => p.trim()).filter(Boolean);
  for (const [left, rawOp, right] of parts.flatMap((p) => comparisons(parsePlain(p)))) {
    let op = rawOp, other;
    if (left.type === 'var' && left.name === 'x') other = right;
    else if (right.type === 'var' && right.name === 'x') { other = left; op = FLIP[op]; }
    else throw new Error(`The condition "${words}" does not compare x with a number.`);
    const v = constantValue(other);
    if (op === '<' || op === '<=') { if (v < range.hi || (v === range.hi && op === '<')) { range.hi = v; range.hiClosed = op === '<='; } }
    else if (op === '>' || op === '>=') { if (v > range.lo || (v === range.lo && op === '>')) { range.lo = v; range.loClosed = op === '>='; } }
    else if (op === '=') { range.lo = range.hi = v; range.loClosed = range.hiClosed = true; }
    else if (op === '!=') range.not.push(v);
    else throw new Error(`"${rawOp}" cannot be used in a condition.`);
  }
  if (range.lo > range.hi || (range.lo === range.hi && !(range.loClosed && range.hiClosed))) throw new Error(`No x satisfies "${words}".`);
  return range;
}

const near = (a, b) => Math.abs(a - b) <= 1e-9 * (1 + Math.abs(a));
function inRange(r, x) {
  if (r.otherwise) return true;
  if (r.not.some((v) => near(v, x))) return false;
  // At an end itself, the end's own sign (< or <=) decides.
  const aboveLo = r.lo === -Infinity || (near(x, r.lo) ? r.loClosed : x > r.lo);
  const belowHi = r.hi === Infinity || (near(x, r.hi) ? r.hiClosed : x < r.hi);
  return aboveLo && belowHi;
}

// The rows of a \begin{cases} ... \end{cases}: [expression, condition].
function caseRows(latex) {
  const m = /\\begin\{cases\}([\s\S]*?)\\end\{cases\}/.exec(latex);
  if (!m) return null;
  const before = latex.slice(0, m.index).trim().replace(/\\left\s*\\?\{?$/, '').replace(/=$/, '').trim();
  const rows = m[1].split(/\\\\/).map((r) => r.trim()).filter(Boolean).map((row) => {
    const [expr, cond = ''] = row.split(/(?<!\\)&/);
    return [expr.trim(), cond.replace(/\\text\{([^}]*)\}/g, ' $1 ').replace(/\\(quad|qquad|,|;)/g, ' ').trim()];
  });
  return { name: before, rows };
}

// ---------- functions ----------

const isInequality = (n) => n.type === 'rel' && n.op !== '=' && (n.left.type !== 'rel' || n.left.op !== '=');

// One function of x from plain text or LaTeX. Returns Sound Lab's graph object plus the
// dots that a piecewise function's ends make, and a label to speak.
export function compileFunction(source, format = /\\[A-Za-z]|[_^]\{/.test(source) ? 'latex' : 'plain') {
  // 1e-9 could be 1 times 10 to the -9 or 1 times e, minus 9: a wrong guess describes the wrong
  // function with confidence, so the writer says which.
  const sci = /(^|[^A-Za-z\d.])(\d*\.?\d+)[eE]([+-]?\d+)(?![\d.])/.exec(String(source));
  if (sci) throw new Error(`${sci[2]}e${sci[3]} could mean ${sci[2]} times 10 to the ${sci[3]}, or ${sci[2]} times e${/^[+-]/.test(sci[3]) ? `, ${sci[3][0] === '-' ? 'minus' : 'plus'} ${sci[3].slice(1)}` : ` times ${sci[3]}`}. Write ${sci[2]}*10^(${sci[3]}) for the number, or put a space or * around e.`);
  // Functions the graphs cannot draw yet, said by name (not "the letter f has no value").
  const unsupported = /\b(floor|ceil|ceiling|round|sgn|sign|max|min|mod|gcd|lcm)\s*\(/.exec(String(source));
  if (unsupported) throw new Error(`${unsupported[1]} is not supported in graphs yet.`);
  // A sentence's full stop or comma after the maths (g(x) = x^{3}.) is not part of it.
  const latex = (format === 'latex' ? source.trim() : plainToLatex(source)).replace(/\s*[.,;]\s*$/, '');
  const cases = caseRows(latex);
  if (cases) return piecewise(cases, latex);
  // "y = sin x, [0, 2pi]", "y = sin x on [0, 2pi)", "y = x^2 for 0 < x < 1": a function with
  // its interval is one row with a condition.
  const domain = splitDomain(latexToPlain(latex));
  if (domain) {
    return piecewise({ name: functionSide(parsePlain(domain.main)).name, rows: [[plainToLatex(domain.main.replace(/^[^=]*=/, '')), domain.condition]] }, latex);
  }
  // "y = ln(csc x), 0 < x < pi/2": the same, with the comparisons after a comma.
  const parsed = parsePlain(latexToPlain(latex));
  if (parsed.type === 'list' && parsed.items.length >= 2 && parsed.items.slice(1).every(isInequality)) {
    const [first, ...conditions] = latexToPlain(latex).split(',');
    return piecewise({ name: functionSide(parsePlain(first)).name, rows: [[plainToLatex(first.replace(/^[^=]*=/, '')), conditions.join(' and ')]] }, latex);
  }
  const { name, body } = functionSide(parsed);
  const text = graphText(body);
  if (text.length > 400) throw new Error('This function is too long to graph.');
  const graph = compileEquation(`y = ${text}`);
  const spoken = latexToPlain(plainToLatex(latexToPlain(latex).replace(/^\s*(y|[a-z]\(x\))\s*=\s*/i, '')));
  graph.label = `${name || 'y'} = ${spoken}`;
  // rows: the formula (Sound Lab's syntax) and where it applies, for writing pgfplots code.
  return { graph, label: graph.label, latex, dots: [], notes: [], rows: [{ text, intervals: [[-Infinity, Infinity]] }] };
}

function piecewise({ name, rows }, latex) {
  if (!rows.length) throw new Error('The cases have no rows.');
  const pieces = rows.map(([expr, cond], i) => {
    let fn, text;
    try { text = graphText(functionSide(parsePlain(latexToPlain(expr))).body); fn = compileEquation(`y = ${text}`); } catch (error) { throw new Error(`Row ${i + 1} (${latexToPlain(expr)}): ${error.message}`); }
    let range;
    try { range = parseCondition(latexToPlain(cond)); } catch (error) { throw new Error(`Row ${i + 1}, condition "${latexToPlain(cond)}": ${error.message}`); }
    return { fn, text, range, expr: latexToPlain(expr), cond: range.otherwise ? 'otherwise' : latexToPlain(cond).replace(/\b(if|for|when)\b/gi, '').trim() };
  });
  const single = rows.length === 1 && !pieces[0].range.otherwise;
  // The first row whose condition holds decides, as when reading the cases top to bottom.
  const pieceAt = (x) => pieces.find((p) => !p.range.otherwise && inRange(p.range, x)) || pieces.find((p) => p.range.otherwise) || null;
  const valueOf = (p, x) => (p ? p.fn.limitAt(x) : { defined: false, hole: false, y: NaN });
  const graph = {
    type: 'function',
    // f(x), or the maths before the brace as words (|x|, for "sqrt(x^2) = |x| = cases").
    label: single
      // One formula on an interval is not piecewise: y = sin x (for 0 <= x <= 2 pi).
      ? `${/^([a-z]\(x\)|y)$/i.test(name) ? name : 'y'} = ${pieces[0].expr}`
      : `${/^([a-z]\(x\)|y)$/i.test(name) ? name : name ? latexToPlain(name.split('=').at(-1)) : 'f(x)'}, piecewise`,
    hasSteps: false,
    yAt: (x) => { const l = valueOf(pieceAt(x), x); return l.defined ? l.y : NaN; },
    limitAt(x) {
      const own = valueOf(pieceAt(x), x);
      if (own.defined || own.hole) return own;
      // x belongs to no row: a hole when both sides come to the same height.
      const eps = 1e-6;
      const l = valueOf(pieceAt(x - eps), x - eps), r = valueOf(pieceAt(x + eps), x + eps);
      if (l.defined && r.defined && Math.abs(l.y - r.y) < 1e-4 * (1 + Math.abs(l.y))) return { defined: false, hole: true, y: Number(((l.y + r.y) / 2).toPrecision(10)) };
      return { defined: false, hole: false, y: NaN };
    },
    isContinuousBetween(a, b) {
      const p = pieceAt(a);
      return p !== null && pieceAt(b) === p && pieceAt((a + b) / 2) === p && p.fn.isContinuousBetween(a, b);
    },
    // Each row's own divisions by zero, only where that row is the one in use. Elsewhere the
    // check has no value (not 1): a value jumping from 1 to the row's own at the row's end
    // looked like a sign change, and every end of an interval became a "vertical asymptote".
    domainChecks: pieces.flatMap((p) => p.fn.domainChecks.map((c) => ({ kind: c.kind, evaluate: (scope) => (pieceAt(scope.x) === p ? c.evaluate(scope) : NaN) }))),
  };
  return { graph, label: graph.label, latex, dots: piecewiseDots(pieces, pieceAt), notes: single ? [`for ${pieces[0].cond}`] : pieces.map((p) => `${p.expr} when ${p.cond}`),
    domain: single ? [pieces[0].range.lo, pieces[0].range.hi] : null,
    rows: pieces.map((p, i) => ({ text: p.text, intervals: rowIntervals(p, pieces.slice(0, i)) })) };
}

// Where a row is the one in use, as intervals (its single points are drawn as dots instead).
function rowIntervals(piece, before) {
  const cut = (list, [a, b]) => list.flatMap(([lo, hi]) => [[lo, Math.min(hi, a)], [Math.max(lo, b), hi]]).filter(([lo, hi]) => hi - lo > 1e-12);
  const own = piece.range.otherwise ? [[-Infinity, Infinity]] : [[piece.range.lo, piece.range.hi]];
  let out = own.filter(([lo, hi]) => hi > lo);
  for (const p of before) if (!p.range.otherwise) out = cut(out, [p.range.lo, p.range.hi]);
  return out;
}

// Where a row starts or ends at a number, its end is a dot: solid if that x belongs to the
// row, open if not. Where the next row carries on at the same height, there is no dot.
function piecewiseDots(pieces, pieceAt) {
  const ends = new Set();
  for (const p of pieces) {
    if (p.range.otherwise) continue;
    for (const v of [p.range.lo, p.range.hi, ...p.range.not]) if (Number.isFinite(v)) ends.add(v);
  }
  const dots = [];
  for (const b of [...ends].sort((a, c) => a - c)) {
    const eps = 1e-7;
    const owner = pieceAt(b);
    const at = owner ? owner.fn.limitAt(b) : { defined: false };
    // The height each side's row reaches at b is its own formula's value (or limit) at b,
    // even where b itself belongs to another row.
    const sides = [pieceAt(b - eps), pieceAt(b + eps)].map((p) => {
      const l = p ? p.fn.limitAt(b) : { defined: false };
      return l.defined || l.hole ? { defined: true, y: Math.abs(l.y) < 1e-12 ? 0 : l.y } : { defined: false };
    });
    const heights = sides.filter((s) => s.defined).map((s) => s.y);
    const continuous = at.defined && heights.every((y) => Math.abs(y - at.y) < 1e-4 * (1 + Math.abs(y)));
    if (continuous && heights.length === 2) continue; // a smooth join, no dot
    if (at.defined) dots.push({ kind: 'solid dot', coordinate: [b, at.y], label: `solid dot at ${say(b)}, ${say(at.y)}` });
    for (const y of new Set(heights.map((h) => Number(h.toPrecision(8))))) {
      if (at.defined && Math.abs(y - at.y) < 1e-4 * (1 + Math.abs(y))) continue;
      dots.push({ kind: 'open dot', coordinate: [b, y], label: `open dot at ${say(b)}, ${say(y)}` });
    }
  }
  // Name what happens at each x, in the course's words: a jump when the two sides go to
  // different heights; a hole (removable discontinuity) when both sides go to the same
  // height but the function's value there is missing or elsewhere.
  for (const b of new Set(dots.map((d) => d.coordinate[0]))) {
    const here = dots.filter((d) => d.coordinate[0] === b);
    const eps = 1e-7;
    const sides = [pieceAt(b - eps), pieceAt(b + eps)].map((p) => (p ? p.fn.limitAt(b) : { defined: false }))
      .filter((l) => l.defined || l.hole).map((l) => l.y);
    const jump = sides.length === 2 && Math.abs(sides[0] - sides[1]) >= 1e-4 * (1 + Math.abs(sides[0]));
    for (const d of here) {
      if (jump) d.label = `jump at x = ${say(b)}: ${d.label}`;
      else if (sides.length === 2 && d.kind === 'open dot') d.label = `hole at ${say(b)}, ${say(d.coordinate[1])}: both sides go to ${say(d.coordinate[1])}`;
      else if (sides.length === 2 && d.kind === 'solid dot') d.label = `the value at x = ${say(b)} is ${say(d.coordinate[1])}, away from the curve`;
    }
  }
  return dots;
}

// ---------- the window: x range given or chosen, y range fitted ----------

const nice = (v, up) => {
  if (v === 0) return 0;
  const step = 10 ** Math.floor(Math.log10(Math.abs(v))) / 2;
  return Number(((up ? Math.ceil(v / step) : Math.floor(v / step)) * step).toPrecision(12)); // -7 * 0.05 is -0.35, not -0.35000000000000003
};

export function chooseXRange(functions) {
  // Wide enough for every dot, hole and asymptote, with room on both sides.
  const xs = [-5, 5];
  for (const f of functions) for (const d of f.dots) xs.push(d.coordinate[0]);
  for (const f of functions) {
    const marks = landmarksOf(f.graph, 20).filter((l) => ['open-point', 'asymptote'].includes(l.kind));
    // Asymptotes that repeat (tan x, sec x) do not widen the window: a few periods show the pattern.
    for (const l of marks.length > 4 ? marks.filter((m) => Math.abs(m.x) <= 5) : marks) xs.push(l.x);
  }
  // Every function on its own interval (y = sin x, [0, 2pi]): the window is those intervals with
  // a little room around them, not -5 to 5.
  const domains = functions.map((f) => f.domain);
  if (domains.every((d) => d && Number.isFinite(d[0]) && Number.isFinite(d[1]))) {
    const a = Math.min(...domains.map((d) => d[0])), b = Math.max(...domains.map((d) => d[1]));
    const room = Math.max((b - a) * 0.05, 0.1);
    return [nice(a - room, false), nice(b + room, true)];
  }
  const lo = Math.min(...xs), hi = Math.max(...xs);
  const pad = Math.max(1, (hi - lo) * 0.15);
  return [nice(Math.min(-1, lo - (lo < -5 ? pad : 0)), false), nice(Math.max(1, hi + (hi > 5 ? pad : 0)), true)];
}

export function fitYRange(functions, [x0, x1]) {
  const ys = [];
  for (const f of functions) {
    for (let i = 0; i <= 400; i += 1) {
      const y = f.graph.yAt(x0 + (x1 - x0) * i / 400);
      if (Number.isFinite(y)) ys.push(y);
    }
    for (const d of f.dots) ys.push(d.coordinate[1]);
  }
  if (!ys.length) return [-5, 5];
  ys.sort((a, b) => a - b);
  // Leave out the far tails near asymptotes (they run to infinity), keep the shape.
  const pick = (q) => ys[Math.min(ys.length - 1, Math.max(0, Math.round(q * (ys.length - 1))))];
  let lo = Math.min(pick(0.03), 0), hi = Math.max(pick(0.97), 0);
  // Where the ends run far off (x e^(-x) reaches -742 at x = -5 but peaks at 0.37), the
  // turning points, zeros and dots are what matter: fit those, with room around them.
  const keys = [0];
  for (const f of functions) {
    for (const l of landmarksOf(f.graph, Math.max(Math.abs(x0), Math.abs(x1)))) if (Number.isFinite(l.y) && l.x >= x0 && l.x <= x1) keys.push(l.y);
  }
  const span = Math.max(...keys) - Math.min(...keys);
  // Only when most of the curve stays in that window: a parabola (3x^2 + 2x) climbing steadily
  // to 85 is not running off, and cut to y from -0.5 to 2 it was mostly out of sight.
  if (keys.length > 2 && span > 1e-9 && hi - lo > 25 * Math.max(span, 1)) {
    const room = Math.max(span, 1) * 1.5;
    const zlo = Math.max(lo, Math.min(...keys) - room), zhi = Math.min(hi, Math.max(...keys) + room);
    if (ys.filter((y) => y >= zlo && y <= zhi).length >= 0.4 * ys.length) { lo = zlo; hi = zhi; }
  }
  for (const f of functions) for (const d of f.dots) { lo = Math.min(lo, d.coordinate[1]); hi = Math.max(hi, d.coordinate[1]); }
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.1;
  return [nice(lo - pad, false), nice(hi + pad, true)];
}

// ---------- points of interest ----------

// Sound Lab's points of interest, checked: where a division by zero is found but the curve
// stays finite on both sides and both sides agree, it is a hole, not a vertical asymptote
// (in (x^2-x-2)/(x-2) the row has a hole at x = 2, filled or not by another row).
export function landmarksOf(graph, boundary) {
  const out = [];
  // Defined nowhere in the window (1/0): nothing to point out, and no "asymptote" at every step.
  const grid = Array.from({ length: 401 }, (_, i) => valueAt(graph, -boundary + (2 * boundary * i) / 400));
  if (!grid.some(Number.isFinite)) return [];
  // Rounding noise is not a shape: cos(x)^2 + sin(x)^2 is 1 everywhere, with no peaks, even
  // where the computer's last digit wobbles.
  const flatAround = (x, y) => {
    const ys = Array.from({ length: 21 }, (_, k) => valueAt(graph, x + ((k - 10) * boundary) / 200)).filter(Number.isFinite);
    return ys.length > 2 && ys.every((v) => Math.abs(v - y) <= 1e-9 * (1 + Math.abs(y)));
  };
  for (const l of detectLandmarks(graph, boundary)) {
    if ((l.kind === 'maximum' || l.kind === 'minimum') && flatAround(l.x, l.y)) continue;
    if (l.kind === 'asymptote') {
      const sides = [-1e-5, 1e-5].map((d) => graph.yAt(l.x + d));
      const scale = 1 + Math.max(...sides.map(Math.abs));
      if (sides.every(Number.isFinite) && Math.abs(sides[0] - sides[1]) < 1e-3 * scale && scale < 1e4) {
        const here = graph.limitAt(l.x);
        // Filled by another row: no point of interest of its own (its dots say what happens).
        if (!here.defined) out.push({ kind: 'open-point', x: l.x, y: Number(((sides[0] + sides[1]) / 2).toPrecision(10)), label: `Open point (hole) at (${formatNumber(l.x)}, ${formatNumber((sides[0] + sides[1]) / 2)})` });
        continue;
      }
    }
    // A flat root (x - 3)^3 is found a hair away (3.00002); the whole number is the root
    // when the function is at least as close to zero there.
    if (l.kind === 'x-axis') {
      const r = Number(l.x.toFixed(3));
      const at = (x) => Math.abs(valueAt(graph, x));
      if (r !== l.x && Math.abs(r - l.x) < 1e-3 && at(r) <= at(l.x) + 1e-12) l.x = r;
    }
    out.push(l);
  }
  let all = [...out, ...shapeMarks(graph, boundary, out), ...jumpMarks(graph, boundary, out)]
    .filter((l) => !((l.kind === 'maximum' || l.kind === 'minimum') && Number.isFinite(l.y) && flatAround(l.x, l.y)));
  // A corner, an end or a turning point at height 0 (where pieces meet) is a zero too; an end
  // the curve does not include (an open dot) is not on the curve, so it is not.
  for (const l of [...all]) {
    if (['corner', 'endpoint', 'minimum', 'maximum'].includes(l.kind) && l.y === 0 && l.included !== false && !all.some((m) => ['x-axis', 'origin'].includes(m.kind) && Math.abs(m.x - l.x) < 1e-6)) {
      all.push(Math.abs(l.x) < 1e-9 ? { kind: 'origin', x: 0, y: 0, label: 'Origin (0, 0)' } : { kind: 'x-axis', x: l.x, y: 0, label: `X-axis root at (${formatNumber(l.x)}, 0)` });
    }
  }
  // sin(1/x) near 0: the zeros and turns crowd together without end. Said once, as that.
  for (const c of oscillations(graph, boundary, all)) {
    const r = boundary / 20;
    all = all.filter((l) => !(['x-axis', 'origin', 'maximum', 'minimum', 'asymptote'].includes(l.kind) && Math.abs(l.x - c) < r));
    // A hole there (x sin(1/x) at 0) is measured much closer in: 1e-5 away it still wobbles.
    for (const l of all.filter((m) => m.kind === 'open-point' && Math.abs(m.x - c) < 1e-6)) {
      l.y = tidy((valueAt(graph, c - 1e-10) + valueAt(graph, c + 1e-10)) / 2);
      l.label = `Open point (hole) at (${formatNumber(l.x)}, ${formatNumber(l.y)})`;
    }
    all.push({ kind: 'oscillation', x: c, y: null, label: `Oscillates infinitely often near x = ${formatNumber(c)}` });
  }
  // Touching the x-axis is not crossing it: x^2 is above it on both sides of 0.
  for (const l of all) {
    if (l.kind !== 'x-axis' && l.kind !== 'origin') continue;
    const d = Math.max(1e-6, boundary * 1e-4);
    const [a, b] = [valueAt(graph, l.x - d), valueAt(graph, l.x + d)];
    if (Number.isFinite(a) && Number.isFinite(b) && Math.sign(a) === Math.sign(b) && a !== 0) l.touches = true;
  }
  return all.sort((a, b) => a.x - b.x);
}

// Where a curve wiggles infinitely often (sin(1/x) at 0): looked at ten times closer, it shows
// several times as many turns. Candidates are where the zeros and turns found crowd together.
function oscillations(graph, boundary, marks) {
  const wiggles = marks.filter((l) => ['x-axis', 'origin', 'maximum', 'minimum'].includes(l.kind)).map((l) => l.x).sort((a, b) => a - b);
  if (wiggles.length < 8) return [];
  const turns = (lo, hi, n) => {
    let count = 0, prev = null, last = valueAt(graph, lo);
    for (let i = 1; i <= n; i += 1) {
      const y = valueAt(graph, lo + ((hi - lo) * i) / n);
      if (Number.isFinite(y) && Number.isFinite(last)) {
        const step = Math.sign(y - last);
        if (step && prev && step !== prev) count += 1;
        if (step) prev = step;
      }
      last = y;
    }
    return count;
  };
  const w = boundary / 20;
  const candidates = new Set();
  // Where the curve is not defined or the found points bunch up (eight within w of each other).
  for (let i = 0; i + 7 < wiggles.length; i += 1) if (wiggles[i + 7] - wiggles[i] < 2 * w) candidates.add(Number(((wiggles[i] + wiggles[i + 7]) / 2).toFixed(1)));
  if (!Number.isFinite(valueAt(graph, 0))) candidates.add(0);
  const found = [];
  for (const c of [...candidates].sort((a, b) => Math.abs(a) - Math.abs(b))) {
    if (found.some((f) => Math.abs(f - c) < 2 * w)) continue;
    const coarse = turns(c - w, c + w, 2000), fine = turns(c - w, c + w, 20000);
    if (fine >= 20 && fine >= 2.5 * coarse) found.push(c);
  }
  return found;
}

// Horizontal asymptotes: far out to one side the curve settles at a height (e^x at 0 to the left,
// 1/(x + 2) + 2 at 2 on both sides). A curve that is simply flat there (a row y = 2) has none.
export function horizontalAsymptotes(f, [x0, x1]) {
  const out = [];
  for (const dir of [-1, 1]) {
    if (f.domain && Number.isFinite(dir < 0 ? f.domain[0] : f.domain[1])) continue;
    // Farther and farther out, as long as there is a value (e^x has none past x = -745 or so).
    const ys = [];
    for (const v of [20, 50, 100, 300, 700, 1e3, 1e4, 1e6, 1e8, 1e10, 1e12]) {
      const y = valueAt(f.graph, dir * v);
      if (!Number.isFinite(y)) break;
      ys.push(y);
    }
    if (ys.length < 5) continue;
    const L = ys.at(-1);
    const off = ys.map((y) => Math.abs(y - L));
    const n = ys.length;
    if (!(off[n - 2] < 1e-4 * (1 + Math.abs(L)) && off[n - 3] <= off[n - 4] + 1e-12 && off[n - 2] <= off[n - 3] + 1e-12)) continue;
    const edge = valueAt(f.graph, dir < 0 ? x0 : x1);
    if (Number.isFinite(edge) && Math.abs(edge - L) <= 1e-9 * (1 + Math.abs(L))) continue;
    out.push({ dir, y: Math.abs(L) < 1e-6 ? 0 : Number(L.toPrecision(6)) });
  }
  if (out.length === 2 && out[0].y === out[1].y) return [{ dir: 0, y: out[0].y }];
  return out;
}

// At a jump, the point itself can be the lowest or highest around it: in a piecewise function
// whose value at x = 0 is -1 with the curve above it on both sides, (0, -1) is a valley.
function jumpMarks(graph, boundary, known) {
  if (graph.hasSteps) return [];
  const out = [];
  const N = 800, h = (2 * boundary) / N;
  for (let i = 0; i < N; i += 1) {
    let a = -boundary + i * h, b = a + h;
    if (graph.isContinuousBetween(a, b) || !Number.isFinite(valueAt(graph, a)) || !Number.isFinite(valueAt(graph, b))) continue;
    for (let n = 0; n < 60; n += 1) { const mid = (a + b) / 2; if (graph.isContinuousBetween(a, mid)) a = mid; else b = mid; }
    // The break is at a or b; take the nicer number and look at the point and both sides.
    for (const x of new Set([a, b].map((v) => Number(v.toFixed(6)) || 0))) {
      if (known.some((l) => l.kind === 'asymptote' && Math.abs(l.x - x) < 1e-5)) continue;
      const v = valueAt(graph, x);
      // Each side close in (1e-4) and closer (1e-6): both must settle, not run off (a pole).
      const [l4, l6, r4, r6] = [-1e-4, -1e-6, 1e-4, 1e-6].map((d) => valueAt(graph, x + d));
      if (![v, l4, l6, r4, r6].every(Number.isFinite)) continue;
      const settles = (p, q) => Math.abs(p - q) <= 1e-2 * (1 + Math.abs(q));
      if (!settles(l4, l6) || !settles(r4, r6)) continue;
      const tol = 1e-4 * (1 + Math.abs(v)), tiny = 1e-12 * (1 + Math.abs(v));
      // Lowest: higher on both sides (a flat piece next to a jump is not a valley), with at
      // least one side jumping away from it.
      const kind = l4 > v + tiny && r4 > v + tiny && (l6 > v + tol || r6 > v + tol) ? 'minimum'
        : l4 < v - tiny && r4 < v - tiny && (l6 < v - tol || r6 < v - tol) ? 'maximum' : null;
      if (!kind || [...known, ...out].some((l) => l.kind === kind && Math.abs(l.x - x) < 1e-5)) continue;
      const y = tidy(v);
      out.push({ kind, x, y, label: `${kind === 'maximum' ? 'Peak (local max)' : 'Valley (local min)'} at (${formatNumber(x)}, ${formatNumber(y)})` });
    }
  }
  return out;
}

// A point of interest in words, with numbers said the way Settings asks (rounded by default).
export function spokenLabel(l) {
  const at = `${say(l.x)}, ${say(l.y ?? 0)}`;
  switch (l.kind) {
    case 'x-axis': return `${l.touches ? 'touches' : 'crosses'} the x-axis at ${say(l.x)}`;
    case 'oscillation': return `oscillates infinitely often near x = ${say(l.x)}`;
    case 'y-axis': return `crosses the y-axis at ${say(l.y)}`;
    case 'origin': return 'the origin, 0, 0';
    case 'maximum': return `peak at ${at}`;
    case 'minimum': return `valley at ${at}`;
    case 'open-point': return `hole at ${at}`;
    case 'solid-point': return `solid dot at ${at}`;
    case 'asymptote': return `vertical asymptote at x = ${say(l.x)}`;
    case 'corner': return `${l.shape || 'corner'} at ${at}${l.slopeLeft !== undefined && l.slopeLeft !== null ? `: ${slopeWord(l.slopeLeft)} before, ${slopeWord(l.slopeRight)} after` : ''}`;
    case 'endpoint': return `the curve ${l.side === 'end' ? 'ends' : 'starts'} at ${at}${l.included === false ? ', not including that point' : ''}`;
    default: return l.label || `${l.kind} at ${at}`;
  }
}

// ---------- corners, cusps and ends: what Sound Lab's smooth search does not find ----------

const valueAt = (graph, x) => { const l = graph.limitAt(x); return l.defined ? l.y : NaN; };
const tidy = (v) => (Math.abs(v) < 1e-9 ? 0 : Number(v.toPrecision(10)));
// The simplest nearby number (1 rather than 1.0000000003) when the curve agrees.
function niceX(graph, x, test) {
  for (const digits of [0, 1, 2, 3]) {
    const r = Number(x.toFixed(digits));
    if (Math.abs(r - x) < 1e-8 * (1 + Math.abs(x)) && test(r)) return r;
  }
  return tidy(x);
}

// Zoom in on a suspected kink: a real corner keeps the same jump in slope however close
// you look, a smooth bend's jump shrinks with every zoom. Returns the kink, or null.
function zoomKink(graph, lo, hi) {
  const N = 40;
  let jumps = [];
  let best = null, firstStep = null;
  for (let level = 0; level < 6; level += 1) {
    const h = (hi - lo) / N;
    const ys = Array.from({ length: N + 1 }, (_, i) => valueAt(graph, lo + i * h));
    if (!ys.every(Number.isFinite)) return null;
    const m = ys.slice(1).map((y, i) => (y - ys[i]) / h);
    let j = 1;
    for (let k = 2; k < N; k += 1) if (Math.abs(m[k] - m[k - 1]) > Math.abs(m[j] - m[j - 1])) j = k;
    jumps.push(Math.abs(m[j] - m[j - 1]));
    best = { x: lo + j * h, left: m[j - 1], right: m[j], step: Math.max(...ys.slice(1).map((y, i) => Math.abs(y - ys[i]))) };
    firstStep ??= best.step;
    lo += (j - 2) * h; hi = lo + 4 * h;
  }
  // A jump in the curve (not a kink): the values still step apart as much this close in.
  if (best.step > 0.2 * firstStep) return null;
  // Smooth: the slope's jump shrank about 10x per zoom. A kink holds (corner) or grows (cusp).
  if (!(jumps.at(-1) > 0.3 * jumps[1]) || jumps.at(-1) < 1e-3 * (1 + Math.abs(best.left) + Math.abs(best.right))) return null;
  // A cusp: the slopes on each side keep growing the closer you look.
  return { ...best, steep: jumps.at(-1) > 3 * jumps[1] };
}

// Zoom in on a suspected vertical tangent (cube root at 0): the steepest slope keeps
// growing however close you look, while the curve itself does not jump.
function zoomSteep(graph, lo, hi) {
  const N = 40;
  const peaks = [];
  let best = null, firstStep = null;
  for (let level = 0; level < 6; level += 1) {
    const h = (hi - lo) / N;
    const ys = Array.from({ length: N + 1 }, (_, i) => valueAt(graph, lo + i * h));
    if (!ys.every(Number.isFinite)) return null;
    const m = ys.slice(1).map((y, i) => (y - ys[i]) / h);
    let j = 0;
    for (let k = 1; k < N; k += 1) if (Math.abs(m[k]) > Math.abs(m[j])) j = k;
    peaks.push(Math.abs(m[j]));
    // The steepest point is the end of the steepest piece next to the next steepest.
    const x = lo + (j + (Math.abs(m[j + 1] ?? 0) > Math.abs(m[j - 1] ?? 0) ? 1 : 0)) * h;
    best = { x, left: m[Math.max(0, j - 2)], right: m[Math.min(N - 1, j + 2)], step: Math.abs(ys[j + 1] - ys[j]) };
    firstStep ??= best.step;
    lo = x - 2 * h; hi = x + 2 * h;
  }
  if (best.step > 0.2 * firstStep || !(peaks.at(-1) > 3 * peaks[0])) return null;
  return { ...best, steep: true };
}

const slopeWord = (m) => (Math.abs(m) < 1e-6 ? 'flat' : m > 0 ? 'rising' : 'falling');

export function shapeMarks(graph, boundary, known = []) {
  if (graph.hasSteps) return [];
  const N = 800, h = (2 * boundary) / N;
  const xs = Array.from({ length: N + 1 }, (_, i) => -boundary + i * h);
  const ys = xs.map((x) => valueAt(graph, x));
  const out = [];
  const near = (x, kinds) => [...known, ...out].some((l) => Math.abs(l.x - x) < 1e-5 && (!kinds || kinds.includes(l.kind)));
  const add = (mark) => { if (!near(mark.x, [mark.kind])) out.push(mark); };

  // Corners and cusps: the slope between samples jumps at one place and not around it.
  const m = xs.slice(1).map((x, i) => (Number.isFinite(ys[i]) && Number.isFinite(ys[i + 1]) ? (ys[i + 1] - ys[i]) / h : NaN));
  const jump = m.map((v, i) => (i > 0 && Number.isFinite(v) && Number.isFinite(m[i - 1]) ? Math.abs(v - m[i - 1]) : NaN));
  for (let i = 3; i < jump.length - 3; i += 1) {
    const here = jump[i];
    if (!Number.isFinite(here) || here < 1e-3 * (1 + Math.abs(m[i]))) continue;
    const around = [jump[i - 3], jump[i - 2], jump[i + 2], jump[i + 3]];
    if (!around.every(Number.isFinite) || here < 6 * Math.max(...around) || here < jump[i - 1] || here < jump[i + 1]) continue;
    const k = zoomKink(graph, xs[i - 2], xs[i + 2]);
    if (k) kink(k, (r) => zoomKink(graph, r - h / 50, r + h / 50) !== null);
  }
  // Vertical tangents: one place where the slope is far steeper than around it.
  for (let i = 3; i < m.length - 3; i += 1) {
    const s = Math.abs(m[i]);
    const around = [m[i - 3], m[i + 3]].map(Math.abs);
    if (!Number.isFinite(s) || s < 5 || !around.every(Number.isFinite) || s < 3 * Math.max(...around) || s < Math.abs(m[i - 1]) || s < Math.abs(m[i + 1])) continue;
    const k = zoomSteep(graph, xs[i - 2], xs[i + 3]);
    if (k) kink(k, (r) => zoomSteep(graph, r - h / 50, r + h / 50) !== null);
  }

  function kink(k, holds) {
    const x = niceX(graph, k.x, holds);
    const y0 = valueAt(graph, x), y = Math.abs(y0) < 1e-7 ? 0 : tidy(y0);
    if (!Number.isFinite(y) || near(x, ['corner'])) return;
    const steep = k.steep;
    const shape = steep ? (Math.sign(k.left) === Math.sign(k.right) ? 'vertical tangent' : 'cusp') : 'sharp corner';
    // The slopes just before and just after the corner (one-sided, very close in).
    const d = 1e-6 * (1 + Math.abs(x));
    const before = (valueAt(graph, x) - valueAt(graph, x - d)) / d, after = (valueAt(graph, x + d) - valueAt(graph, x)) / d;
    const left = steep ? Math.sign(k.left) * Infinity : Number(before.toPrecision(4)), right = steep ? Math.sign(k.right) * Infinity : Number(after.toPrecision(4));
    add({ kind: 'corner', shape, x, y, slopeLeft: left, slopeRight: right,
      label: `${shape} at ${say(x)}, ${say(y)}: ${slopeWord(left)} before, ${slopeWord(right)} after` });
    // A peak or valley at a corner (|x| written as cases) that the smooth search missed.
    if (left < 0 && right > 0 && !near(x, ['minimum'])) add({ kind: 'minimum', x, y, label: `Valley (local min) at (${formatNumber(x)}, ${formatNumber(y)})` });
    if (left > 0 && right < 0 && !near(x, ['maximum'])) add({ kind: 'maximum', x, y, label: `Peak (local max) at (${formatNumber(x)}, ${formatNumber(y)})` });
  }

  // Where the curve stops: sqrt(x) starts at 0; ln x runs down beside x = 0 without end.
  for (let i = 0; i < N; i += 1) {
    if (Number.isFinite(ys[i]) === Number.isFinite(ys[i + 1])) continue;
    const insideRight = Number.isFinite(ys[i + 1]);
    let a = xs[i], b = xs[i + 1]; // the edge lies between a and b
    for (let n = 0; n < 60; n += 1) {
      const mid = (a + b) / 2;
      if (Number.isFinite(valueAt(graph, mid)) === insideRight) b = mid; else a = mid;
    }
    const edge = insideRight ? b : a;
    if (near(edge, ['open-point', 'asymptote']) || near(tidy(edge), ['open-point', 'asymptote'])) continue;
    // A single missing point is a hole (found elsewhere), not an end.
    const dir = insideRight ? 1 : -1;
    const toward = [1e-3, 1e-6, 1e-9, 1e-12].map((d) => valueAt(graph, edge + dir * d));
    const settles = toward.every(Number.isFinite) && Math.abs(toward[2] - toward[3]) < 1e-3 * (1 + Math.abs(toward[3]));
    const single = Number.isFinite(valueAt(graph, edge - dir * 1e-4));
    // A single missing point is a hole (found elsewhere) unless the curve runs off there (ln|x| at 0).
    if (single && settles) continue;
    // Values too small for the computer (e^(-1/x^2) near 0) are not an end of the curve.
    if (toward.some((v) => v !== 0 && Math.abs(v) < 1e-100)) continue;
    const x = single ? niceX(graph, edge, () => true)
      : niceX(graph, edge, (r) => Number.isFinite(valueAt(graph, r + dir * 1e-9)) && !Number.isFinite(valueAt(graph, r - dir * 1e-4)));
    if (single && near(x, ['asymptote'])) continue;
    if (!settles) {
      add({ kind: 'asymptote', x, y: null, label: `Vertical asymptote at x = ${formatNumber(x)}: the curve runs ${toward[3] > 0 ? 'up' : 'down'} beside it` });
      continue;
    }
    // The end point itself belongs to the curve when the curve is there at the edge found (x
    // may be that edge written shorter, -3.14159265 for -pi, a hair outside).
    // A short number (1, 0.5) is the end itself, so the curve decides: 0 < x < 1 leaves out x = 1
    // although 0.999999999 is on the curve.
    const here = graph.limitAt(x);
    const shortX = Number(x.toFixed(3));
    const included = Math.abs(shortX - x) < 1e-8 * (1 + Math.abs(x)) ? graph.limitAt(shortX).defined
      : here.defined || (Math.abs(x - edge) < 1e-8 * (1 + Math.abs(x)) && Number.isFinite(valueAt(graph, edge)));
    const y0 = here.defined ? here.y : included ? valueAt(graph, edge) : toward[3];
    const y = Math.abs(y0) < 1e-7 ? 0 : tidy(y0);
    add({ kind: 'endpoint', x, y, included, side: insideRight ? 'start' : 'end',
      label: `the curve ${insideRight ? 'starts' : 'ends'} at ${say(x)}, ${say(y)}${included ? '' : ', not including that point'}` });
  }
  return out;
}

// ---------- describing a graph in words ----------

// What a teacher can keep from students, and the points of interest each one covers.
export const HIDEABLE = {
  zeros: { name: 'where it crosses the x-axis (zeros)', kinds: ['x-axis', 'origin'] },
  yIntercept: { name: 'where it crosses the y-axis', kinds: ['y-axis', 'origin'] },
  extrema: { name: 'peaks and valleys', kinds: ['maximum', 'minimum'] },
  holes: { name: 'holes, jumps and dots', kinds: ['open-point', 'solid-point'] },
  asymptotes: { name: 'asymptotes', kinds: ['asymptote'] },
  corners: { name: 'sharp corners, cusps and where the curve ends', kinds: ['corner', 'endpoint'] },
};
const hiddenKinds = (hide = []) => new Set(hide.flatMap((h) => HIDEABLE[h]?.kinds || []));

// The points of interest in words, each with its kind, so a student copy can leave some out.
export function describeFunction(f, [x0, x1], hide = []) {
  const boundary = Math.max(Math.abs(x0), Math.abs(x1));
  const hidden = hiddenKinds(hide);
  const marks = landmarksOf(f.graph, boundary).filter((l) => l.x >= x0 - 1e-9 && l.x <= x1 + 1e-9);
  const list = (kind) => (hidden.has(kind) ? [] : marks.filter((l) => l.kind === kind));
  const parts = [];
  // 1/0: nothing in the window at all.
  if (!Array.from({ length: 401 }, (_, i) => valueAt(f.graph, x0 + ((x1 - x0) * i) / 400)).some(Number.isFinite)) return [`is not defined anywhere from x = ${say(x0)} to ${say(x1)}`];
  const zeroMarks = [...list('x-axis'), ...(hide.includes('zeros') ? [] : marks.filter((l) => l.kind === 'origin'))].sort((a, b) => a.x - b.x);
  const crossing = zeroMarks.filter((l) => !l.touches).map((l) => say(l.x)), touching = zeroMarks.filter((l) => l.touches).map((l) => say(l.x));
  if (crossing.length) parts.push(`crosses the x-axis at x = ${crossing.join(', ')}`);
  if (touching.length) parts.push(`touches the x-axis at x = ${touching.join(', ')}`);
  const yInt = hide.includes('yIntercept') ? null : marks.find((l) => l.kind === 'y-axis') || marks.find((l) => l.kind === 'origin');
  if (yInt) parts.push(`crosses the y-axis at y = ${say(yInt.y ?? 0)}`);
  for (const l of list('maximum')) parts.push(`peak at ${say(l.x)}, ${say(l.y)}`);
  for (const l of list('minimum')) parts.push(`valley at ${say(l.x)}, ${say(l.y)}`);
  for (const l of list('open-point')) parts.push(`hole at ${say(l.x)}, ${say(l.y)}`);
  for (const l of list('asymptote')) parts.push(`vertical asymptote at x = ${say(l.x)}`);
  // 'beyond': a drawing shows only what is drawn, so nothing is said about far past its edges.
  if (!hide.includes('asymptotes') && !hide.includes('beyond')) {
    for (const h of horizontalAsymptotes(f, [x0, x1])) parts.push(`horizontal asymptote y = ${say(h.y)}${h.dir === 0 ? ' on both sides' : h.dir < 0 ? ' as x goes to minus infinity' : ' as x goes to infinity'}`);
  }
  for (const l of list('oscillation')) parts.push(`oscillates infinitely often near x = ${say(l.x)}`);
  for (const l of list('corner')) parts.push(`${l.shape} at ${say(l.x)}, ${say(l.y)}`);
  for (const l of list('endpoint')) parts.push(l.label);
  if (!hide.includes('holes')) for (const d of f.dots) parts.push(d.label);
  return parts;
}

// ---------- the student copy of a graph ----------

// graph.student = { hideFormula: true|false, hide: ['zeros', 'extrema', ...] }, set by the
// teacher. The copy keeps the shape and the points students may see. With the formula
// hidden it holds only points along the curve (the formula is not in the file at all), so
// students hear the curve and find the function themselves.
export function studentGraph(graph) {
  return exactly(() => studentCopy(graph));
}

function studentCopy(graph) {
  const opts = graph.student;
  if (!opts || (!opts.hideFormula && !(opts.hide || []).length)) {
    const { student, ...rest } = graph;
    return rest;
  }
  const hide = opts.hide || [];
  const span = graph.span;
  const sources = [...(graph.functions || []).map((f) => ({ text: f.latex, format: 'latex' })), ...(graph.equations || [])];
  const functions = sources.map((s) => compileFunction(s.text ?? s, s.format));
  const words = functions.map((f, i) => {
    const parts = describeFunction(f, span.x, opts.drawn ? [...hide, 'beyond'] : hide);
    // opts.names: what the page calls each curve (f(x) and g(x) in a TikZ drawing with labels).
    const name = opts.hideFormula ? (opts.names?.[i] || (functions.length > 1 ? `Function ${i + 1}` : 'The function')) : f.label;
    return `${name}${parts.length ? `: ${parts.join('; ')}` : ''}`;
  });
  const shown = `Shown for x from ${say(span.x[0])} to ${say(span.x[1])} and y from ${say(span.y[0])} to ${say(span.y[1])}.`;
  // opts.note: why the formula is left out (a worksheet drawing shows only the curve).
  const task = opts.hideFormula ? ` ${opts.note || 'Its formula is for you to find.'}` : '';
  const out = {
    summary: `${words.join('. ')}. ${shown}${task}`,
    span,
    hidden: [...hiddenKinds(hide)],
    points: hide.includes('holes') ? [] : (graph.points || []).map(({ label, ...p }) => (opts.hideFormula ? p : { label, ...p })),
    curves: (graph.curves || []).map((c) => ({ ...c })), // read from a PDF: already only points
  };
  if (!opts.hideFormula) {
    if (graph.functions) out.functions = graph.functions;
    if (graph.equations) out.equations = graph.equations;
    return out;
  }
  const hidden = hiddenKinds(hide);
  functions.forEach((f, i) => {
    const boundary = Math.max(Math.abs(span.x[0]), Math.abs(span.x[1]));
    const marks = landmarksOf(f.graph, boundary).filter((l) => !hidden.has(l.kind) && l.x >= span.x[0] - 1e-9 && l.x <= span.x[1] + 1e-9);
    out.curves.push({
      kind: 'curve', label: opts.names?.[i] || (functions.length > 1 ? `function ${i + 1}` : 'the function'), color: '',
      samples: sampleCurve(f.graph, span.x),
      turning_points: marks.filter((l) => l.kind === 'maximum' || l.kind === 'minimum').map((l) => ({ kind: l.kind === 'maximum' ? 'peak' : 'valley', at: [l.x, l.y] })),
      crosses_x_axis_at: marks.filter((l) => l.kind === 'x-axis' || (l.kind === 'origin' && !hide.includes('zeros'))).map((l) => l.x),
      crosses_y_axis_at: hide.includes('yIntercept') ? null : (marks.find((l) => l.kind === 'y-axis' || l.kind === 'origin')?.y ?? null),
      asymptotes: marks.filter((l) => l.kind === 'asymptote').map((l) => l.x),
      // Sharp corners, cusps and where the curve starts or ends, with the slopes the sounds use.
      shapes: marks.filter((l) => l.kind === 'corner' || l.kind === 'endpoint').map((l) => ({ kind: l.kind, shape: l.shape, at: [l.x, l.y],
        slopeLeft: l.slopeLeft, slopeRight: l.slopeRight, included: l.included, label: l.label })),
    });
    // A hole of the formula itself ((x^2-4)/(x-2) at 2) becomes an open dot students hear.
    for (const l of marks.filter((m) => m.kind === 'open-point')) out.points.push({ kind: 'open dot', coordinate: [l.x, l.y] });
  });
  out.points = out.points.map(({ function: owner, ...p }) => p); // no link back to a formula
  return out;
}

// Points along a curve, with null where it breaks (a jump, an asymptote, a gap).
const round = (v) => Number(v.toPrecision(7));
export function sampleCurve(graph, [x0, x1], count = 600) {
  const out = [];
  let prev = null;
  for (let i = 0; i <= count; i += 1) {
    const x = round(x0 + (x1 - x0) * i / count);
    const lim = graph.limitAt(x);
    if (!lim.defined) { if (out.length && out.at(-1) !== null) out.push(null); prev = null; continue; }
    if (prev !== null && !graph.isContinuousBetween(prev, x) && out.at(-1) !== null) out.push(null);
    out.push([x, round(lim.y)]);
    prev = x;
  }
  return out;
}

// Everything the document's graph line keeps: the functions as LaTeX, the window, the dots.
export function makeGraph(sources, range = {}) {
  return exactly(() => makeGraphNow(sources, range));
}

function makeGraphNow(sources, { x = null, y = null } = {}) {
  const functions = sources.map((s) => compileFunction(s.text ?? s, s.format));
  const xRange = x || chooseXRange(functions);
  const yRange = y || fitYRange(functions, xRange);
  const pieces = functions.map((f) => {
    const words = describeFunction(f, xRange);
    return `${f.label}${f.notes.length ? ` (${f.notes.join('; ')})` : ''}${words.length ? `: ${words.join('; ')}` : ''}`;
  });
  return {
    summary: `${pieces.join('. ')}. Shown for x from ${say(xRange[0])} to ${say(xRange[1])} and y from ${say(yRange[0])} to ${say(yRange[1])}.`,
    span: { x: xRange, y: yRange },
    functions: functions.map((f) => ({ latex: f.latex })),
    points: functions.flatMap((f, i) => f.dots.map((d) => ({ ...d, function: i }))), // which function's end each dot is
  };
}
