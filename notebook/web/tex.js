// A LaTeX source file (.tex) as notebook blocks, and graphs to and from pgfplots code.
// Rules, not AI: the source already holds the exact maths; this only reads its structure.
// Blocks are the same as docx.js uses, plus { type: 'graph', graph } and { type: 'note', text }.
import { latexToMathml } from './mathml.js';
import { latexToPlain, parsePlain, plainToLatex } from './equation.js';
import { makeGraph, compileFunction } from './graphs.js';

// ---------- reading groups ----------

// The text of the {...} group that starts at src[i] (after spaces), and the index after it.
function group(src, i, open = '{', close = '}') {
  while (/\s/.test(src[i] || '')) i += 1;
  if (src[i] !== open) return null;
  let depth = 0;
  for (let j = i; j < src.length; j += 1) {
    if (src[j] === '\\') { j += 1; continue; }
    if (src[j] === open) depth += 1;
    else if (src[j] === close) { depth -= 1; if (depth === 0) return [src.slice(i + 1, j), j + 1]; }
  }
  throw new Error(`A ${open} has no matching ${close}.`);
}
const optional = (src, i) => group(src, i, '[', ']');

// Where \end{name} matching the \begin{name} that ended at i is, allowing nesting.
function environmentEnd(src, i, name) {
  const re = new RegExp(`\\\\(begin|end)\\{${name.replace(/\*/g, '\\*')}\\}`, 'g');
  re.lastIndex = i;
  let depth = 1;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    depth += m[1] === 'begin' ? 1 : -1;
    if (depth === 0) return [m.index, m.index + m[0].length];
  }
  throw new Error(`\\begin{${name}} has no \\end{${name}}.`);
}

// ---------- the document's own commands (\newcommand) ----------

function collectMacros(src, notes) {
  const macros = new Map();
  const re = /\\(?:re)?newcommand\*?\s*\{?\\([A-Za-z]+)\}?|\\def\\([A-Za-z]+)|\\DeclareMathOperator\*?\s*\{\\([A-Za-z]+)\}/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let i = m.index + m[0].length;
    try {
      if (m[3]) { const [text, end] = group(src, i); macros.set(m[3], { args: 0, body: `\\operatorname{${text}}` }); re.lastIndex = end; continue; }
      let args = 0;
      if (m[1]) { const opt = optional(src, i); if (opt) { args = Number(opt[0]) || 0; i = opt[1]; } }
      else { const params = /^(#\d)*/.exec(src.slice(i))[0]; args = params.length / 2; i += params.length; }
      const [body, end] = group(src, i);
      macros.set(m[1] || m[2], { args, body });
      re.lastIndex = end;
    } catch { notes.push(`The definition of \\${m[1] || m[2] || m[3]} could not be read.`); }
  }
  return macros;
}

function expandMacros(src, macros) {
  if (!macros.size) return src;
  const names = [...macros.keys()].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`\\\\(${names.join('|')})(?![A-Za-z])`, 'g');
  let out = src;
  for (let round = 0; round < 10; round += 1) {
    let changed = false;
    let result = '';
    let pos = 0;
    re.lastIndex = 0;
    for (let m = re.exec(out); m; m = re.exec(out)) {
      const { args, body } = macros.get(m[1]);
      let i = m.index + m[0].length;
      const values = [];
      for (let k = 0; k < args; k += 1) {
        const g = group(out, i);
        if (g) { values.push(g[0]); i = g[1]; } else { while (out[i] === ' ') i += 1; values.push(out[i] ?? ''); i += 1; }
      }
      result += out.slice(pos, m.index) + body.replace(/#(\d)/g, (_, n) => values[Number(n) - 1] ?? '');
      pos = i;
      re.lastIndex = i;
      changed = true;
    }
    out = result + out.slice(pos);
    if (!changed) break;
  }
  return out;
}

// ---------- text and inline maths ----------

const TEXT_SYMBOLS = { ldots: '…', dots: '…', LaTeX: 'LaTeX', TeX: 'TeX', textbackslash: '\\', S: '§', copyright: '©', today: '',
  textendash: '–', textemdash: '—', quad: ' ', qquad: ' ', ' ': ' ', ',': ' ', ';': ' ', '!': '' };
const IGNORED = new Set(['noindent', 'centering', 'raggedright', 'raggedleft', 'medskip', 'bigskip', 'smallskip', 'hfill', 'vfill',
  'maketitle', 'tableofcontents', 'normalsize', 'small', 'footnotesize', 'large', 'Large', 'LARGE', 'huge', 'Huge', 'bfseries',
  'itshape', 'rmfamily', 'sffamily', 'ttfamily', 'indent', 'linebreak', 'nolinebreak', 'protect', 'relax', 'displaystyle', 'item']);
const DROP_WITH_ARG = new Set(['label', 'vspace', 'hspace', 'vspace*', 'hspace*', 'setlength', 'pagestyle', 'thispagestyle', 'addtolength',
  'setcounter', 'addcontentsline', 'phantom', 'index', 'hypersetup', 'usepackage', 'documentclass', 'geometry', 'graphicspath']);
const STYLE = { textbf: 'bold', textit: 'italic', emph: 'italic', textsl: 'italic', underline: 'underline', uline: 'underline' };

function mathOk(latex, notes) {
  try { latexToMathml(latex); } catch (error) { notes.push(`This maths may not show correctly: ${latex.slice(0, 60)} (${error.message})`); }
  return latex;
}

// Inline content (a paragraph, an item, a cell) as runs.
function inlineRuns(src, style, ctx) {
  const runs = [];
  const text = (t) => {
    if (!t) return;
    const last = runs.at(-1);
    if (last && last.text !== undefined && !last.lineBreak && last.bold === style.bold && last.italic === style.italic && last.underline === style.underline) last.text += t;
    else runs.push({ text: t, ...style });
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '$' && src[i + 1] !== '$') {
      const end = src.indexOf('$', i + 1);
      if (end < 0) { text(src.slice(i)); break; }
      runs.push({ latex: mathOk(src.slice(i + 1, end).trim(), ctx.notes) });
      i = end + 1;
      continue;
    }
    if (src.startsWith('\\(', i)) {
      const end = src.indexOf('\\)', i + 2);
      if (end < 0) { text(src.slice(i)); break; }
      runs.push({ latex: mathOk(src.slice(i + 2, end).trim(), ctx.notes) });
      i = end + 2;
      continue;
    }
    if (ch === '\\') {
      const m = /^\\([A-Za-z]+\*?|.)/.exec(src.slice(i));
      const name = m[1];
      i += m[0].length;
      if (name === '\\' || name === 'newline') { if (src[i] === '*') i += 1; const opt = optional(src, i); if (opt) i = opt[1]; runs.push({ lineBreak: true }); continue; }
      if (STYLE[name]) { const g = group(src, i); if (g) { runs.push(...inlineRuns(g[0], { ...style, [STYLE[name]]: true }, ctx)); i = g[1]; } continue; }
      if (name === 'textrm' || name === 'texttt' || name === 'textsf' || name === 'mbox' || name === 'text' || name === 'textnormal' || name === 'textup') {
        const g = group(src, i); if (g) { runs.push(...inlineRuns(g[0], style, ctx)); i = g[1]; } continue;
      }
      if (name === 'href') { const url = group(src, i); const label = url && group(src, url[1]); if (label) { runs.push(...inlineRuns(label[0], style, ctx)); i = label[1]; } continue; }
      if (name === 'url') { const g = group(src, i); if (g) { text(g[0]); i = g[1]; } continue; }
      if (name === 'footnote') { const g = group(src, i); if (g) { text(' (footnote: '); runs.push(...inlineRuns(g[0], style, ctx)); text(')'); i = g[1]; } continue; }
      if (name === 'ref' || name === 'eqref' || name === 'cite' || name === 'pageref') { const g = group(src, i); if (g) i = g[1]; text(name === 'cite' ? '[citation]' : '(reference)'); continue; }
      if (DROP_WITH_ARG.has(name)) { const opt = optional(src, i); if (opt) i = opt[1]; const g = group(src, i); if (g) i = g[1]; continue; }
      if (IGNORED.has(name)) continue;
      if (TEXT_SYMBOLS[name] !== undefined) { text(TEXT_SYMBOLS[name]); if (/^[A-Za-z]+$/.test(name) && src[i] === ' ') i += 1; continue; }
      if (/^[&%$#_{}~^]$/.test(name)) { text(name === '~' ? '~' : name); continue; }
      if (name === "'" || name === '"' || name === '`' || name === '^' || name === '~') { const g = group(src, i); const letter = g ? g[0] : src[i]; i = g ? g[1] : i + 1; text(letter); continue; }
      // Anything else: its argument is kept as text, the command itself is not shown.
      const g = group(src, i);
      if (g) { ctx.unknown.add(name); runs.push(...inlineRuns(g[0], style, ctx)); i = g[1]; } else ctx.unknown.add(name);
      continue;
    }
    if (ch === '~') { text(' '); i += 1; continue; }
    if (ch === '{' || ch === '}') { i += 1; continue; }
    if (src.startsWith('---', i)) { text('—'); i += 3; continue; }
    if (src.startsWith('--', i)) { text('–'); i += 2; continue; }
    if (src.startsWith('``', i)) { text('“'); i += 2; continue; }
    if (src.startsWith("''", i)) { text('”'); i += 2; continue; }
    text(/\s/.test(ch) ? ' ' : ch);
    i += 1;
  }
  // Spaces at the ends of a paragraph are not part of it.
  if (runs[0]?.text !== undefined) runs[0].text = runs[0].text.replace(/^\s+/, '');
  const last = runs.at(-1);
  if (last?.text !== undefined) last.text = last.text.replace(/\s+$/, '');
  return runs.filter((r) => r.text !== '' || r.latex !== undefined || r.lineBreak);
}

// ---------- blocks ----------

const DISPLAY_MATH = new Set(['equation', 'equation*', 'align', 'align*', 'gather', 'gather*', 'multline', 'multline*', 'displaymath',
  'eqnarray', 'eqnarray*', 'flalign', 'flalign*', 'alignat', 'alignat*', 'math']);
const LISTS = { itemize: false, enumerate: true, description: false };
const THEOREMS = /^(theorem|lemma|corollary|proposition|definition|example|exercise|problem|solution|remark|note|proof|claim|question|answer)\*?$/i;
const SECTIONS = { part: 1, chapter: 1, section: 1, subsection: 2, subsubsection: 3, paragraph: 4, subparagraph: 4 };

// Split at top-level separators (\\ between rows, & between cells, \item between items).
function splitTop(src, separator) {
  const parts = [];
  let depth = 0, envDepth = 0, last = 0;
  for (let i = 0; i < src.length; i += 1) {
    if (src.startsWith('\\begin{', i)) envDepth += 1;
    else if (src.startsWith('\\end{', i)) envDepth -= 1;
    if (src[i] === '\\' && !src.startsWith(separator, i)) { i += 1; continue; }
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') depth -= 1;
    else if (depth === 0 && envDepth === 0 && src.startsWith(separator, i) && (separator !== '\\item' || !/[A-Za-z]/.test(src[i + 5] || ''))) {
      parts.push(src.slice(last, i));
      i += separator.length - 1;
      last = i + 1;
    }
  }
  parts.push(src.slice(last));
  return parts;
}

function displayRows(body, ctx) {
  // Each row of an align is its own line; & only lines the rows up, so it goes.
  // Only the row's own & go: those inside \begin{cases} or a matrix are part of the maths.
  return splitTop(body, '\\\\').map((row) => splitTop(row.replace(/\\(label|tag)\{[^}]*\}|\\nonumber|\\notag/g, ''), '&').join(' ').trim())
    .filter(Boolean).map((latex) => ({ type: 'equation', latex: mathOk(latex, ctx.notes) }));
}

function readBlocks(src, ctx, listLevel = 0) {
  const blocks = [];
  let para = '';
  const flush = () => {
    if (para.trim()) {
      const runs = inlineRuns(para, {}, ctx);
      if (runs.length) blocks.push({ type: 'paragraph', runs });
    }
    para = '';
  };
  let i = 0;
  while (i < src.length) {
    // A blank line ends a paragraph.
    const blank = /^\n[ \t]*\n/.exec(src.slice(i));
    if (blank) { flush(); i += blank[0].length; continue; }
    if (src.startsWith('$$', i) || src.startsWith('\\[', i)) {
      const close = src.startsWith('$$', i) ? '$$' : '\\]';
      const end = src.indexOf(close, i + 2);
      if (end < 0) throw new Error(`Display maths opened with ${src.slice(i, i + 2)} is never closed.`);
      flush();
      blocks.push(...displayRows(src.slice(i + 2, end), ctx));
      i = end + 2;
      continue;
    }
    const cmd = /^\\([A-Za-z]+)(\*?)/.exec(src.slice(i));
    if (cmd && SECTIONS[cmd[1]]) {
      flush();
      let j = i + cmd[0].length;
      const opt = optional(src, j); if (opt) j = opt[1];
      const g = group(src, j);
      if (g) { blocks.push({ type: 'heading', level: SECTIONS[cmd[1]] + ctx.headingShift, runs: inlineRuns(g[0], {}, ctx) }); i = g[1]; continue; }
    }
    if (cmd && ['newpage', 'clearpage', 'pagebreak', 'cleardoublepage'].includes(cmd[1])) { flush(); blocks.push({ type: 'pageBreak' }); i += cmd[0].length; continue; }
    if (cmd && cmd[1] === 'par' && !/[A-Za-z]/.test(src[i + 4] || '')) { flush(); i += 4; continue; }
    if (cmd && cmd[1] === 'includegraphics') {
      flush();
      let j = i + cmd[0].length;
      const opt = optional(src, j); if (opt) j = opt[1];
      const g = group(src, j);
      blocks.push({ type: 'note', text: `Picture: ${g ? g[0] : 'a picture'} (pictures are not part of the .tex file, so it is not shown).` });
      i = g ? g[1] : j;
      continue;
    }
    if (cmd && cmd[1] === 'caption') { flush(); const g = group(src, i + cmd[0].length); if (g) { blocks.push({ type: 'paragraph', runs: [{ text: 'Caption: ', italic: true }, ...inlineRuns(g[0], { italic: true }, ctx)] }); i = g[1]; continue; } }
    if (cmd && cmd[1] === 'begin') {
      const g = group(src, i + cmd[0].length);
      const name = g[0].trim();
      const [endAt, after] = environmentEnd(src, g[1], name);
      let body = src.slice(g[1], endAt);
      if (DISPLAY_MATH.has(name)) {
        flush();
        if (/^alignat/.test(name)) body = body.replace(/^\s*\{[^}]*\}/, '');
        blocks.push(...displayRows(body, ctx));
      } else if (name in LISTS) {
        flush();
        blocks.push(...listBlocks(body, LISTS[name], ctx, listLevel));
      } else if (name === 'tabular' || name === 'tabularx' || name === 'array' || name === 'longtable') {
        flush();
        blocks.push(tableBlock(body, ctx));
      } else if (name === 'tikzpicture') {
        flush();
        blocks.push(...tikzBlocks(body, ctx));
      } else if (name === 'verbatim' || name === 'lstlisting' || name === 'minted') {
        flush();
        blocks.push({ type: 'paragraph', runs: [{ text: body.replace(/^\s*(\[[^\]]*\]|\{[^}]*\})?\n?/, '').replace(/\n$/, '') }] });
      } else if (name === 'document') {
        flush();
        blocks.push(...readBlocks(body, ctx, listLevel));
      } else if (THEOREMS.test(name)) {
        flush();
        // "Theorem (Name)." then its text, as in the printed document.
        const opt = optional(body, 0);
        const title = name.replace('*', '').replace(/^./, (c) => c.toUpperCase());
        const inner = readBlocks(opt ? body.slice(opt[1]) : body, ctx, listLevel);
        const label = { text: `${title}${opt ? ` (${opt[0]})` : ''}. `, bold: true };
        if (inner[0]?.type === 'paragraph') inner[0].runs.unshift(label); else inner.unshift({ type: 'paragraph', runs: [label] });
        blocks.push(...inner);
      } else {
        // center, figure, table, minipage, quote, abstract and the rest: their content.
        flush();
        const inner = body.replace(/^\s*(\[[^\]]*\])?(\{[^}]*\})?/, (m) => (/^(minipage|tabular|multicols)/.test(name) ? '' : m));
        if (name === 'abstract') blocks.push({ type: 'heading', level: 2 + ctx.headingShift, runs: [{ text: 'Abstract' }] });
        blocks.push(...readBlocks(inner, ctx, listLevel));
      }
      i = after;
      continue;
    }
    para += src[i];
    i += 1;
    // Commands with arguments that belong in the paragraph are read whole by inlineRuns.
  }
  flush();
  return blocks;
}

function listBlocks(body, ordered, ctx, level) {
  const out = { type: 'list', ordered, items: [] };
  const extra = [];
  const parts = splitTop(body, '\\item').slice(1);
  for (const part of parts) {
    let text = part;
    let label = null;
    const opt = optional(text, 0);
    if (opt && /^\s*\[/.test(text)) { label = opt[0]; text = text.slice(opt[1]); }
    const inner = readBlocks(text, ctx, level + 1);
    const first = inner.find((b) => b.type === 'paragraph');
    const runs = first ? first.runs : [];
    if (label) runs.unshift({ text: `${label} `, bold: !ordered });
    // An item's own display equations join the item's line; its sub-lists keep their level.
    const rest = inner.filter((b) => b !== first);
    for (const b of rest.filter((x) => x.type === 'equation')) runs.push({ text: ' ' }, { latex: b.latex });
    out.items.push({ runs, level });
    for (const b of rest) {
      if (b.type === 'list') out.items.push(...b.items);
      else if (b.type === 'paragraph') out.items.push({ runs: b.runs, level: level + 1 });
      else if (b.type !== 'equation') extra.push(b);
    }
  }
  return [out, ...extra];
}

function tableBlock(body, ctx) {
  const spec = group(body, 0);
  const rowsSrc = splitTop(spec && /^\s*\{/.test(body) ? body.slice(spec[1]) : body, '\\\\');
  const rows = rowsSrc.map((r) => r.replace(/\\(hline|toprule|midrule|bottomrule|cline\{[^}]*\})/g, '').trim()).filter(Boolean)
    .map((r) => splitTop(r, '&').map((cell) => inlineRuns(cell.replace(/\\multicolumn\{[^}]*\}\{[^}]*\}/g, ''), {}, ctx)));
  // A rule right after the first row marks it as the header (\hline or \midrule).
  const header = /^[^\\]*?(\\\\)\s*\\(hline|midrule)/.test(rowsSrc.slice(0, 2).join('\\\\') + '\\\\') || /\\(hline|midrule)/.test(rowsSrc[1] || '');
  return { type: 'table', rows, header };
}

// ---------- pgfplots graphs ----------

// pgfplots maths -> plain text the graphs understand. pgfplots measures sin, cos and tan
// in degrees: sin(deg(x)) is the sine of x radians, sin(x) the sine of x degrees.
export function pgfToPlain(expr) {
  let s = expr.replace(/\\x\b/g, 'x').replace(/\s+/g, ' ').trim();
  let out = '';
  for (let i = 0; i < s.length;) {
    const m = /^(sin|cos|tan|sec|cosec|csc|cot)\s*\(/.exec(s.slice(i));
    if (!m) { out += s[i]; i += 1; continue; }
    let depth = 0, j = i + m[0].length - 1;
    for (; j < s.length; j += 1) { if (s[j] === '(') depth += 1; else if (s[j] === ')') { depth -= 1; if (depth === 0) break; } }
    const arg = s.slice(i + m[0].length, j);
    const deg = /^\s*deg\s*\((.*)\)\s*$/.exec(arg);
    const name = m[1] === 'cosec' ? 'csc' : m[1];
    out += deg ? `${name}(${pgfToPlain(deg[1])})` : `${name}((${pgfToPlain(arg)})*pi/180)`;
    i = j + 1;
  }
  return out.replace(/\blog10\(/g, 'log(').replace(/\bpow\(([^,]+),([^)]+)\)/g, '($1)^($2)');
}

function keyValues(opts) {
  const out = {};
  for (const part of splitTop(opts || '', ',')) {
    const [k, ...v] = part.split('=');
    if (k.trim()) out[k.trim()] = v.join('=').trim();
  }
  return out;
}
const num = (v) => { const n = Number(String(v ?? '').replace(/[{}]/g, '').trim().replace(/^pi$/, String(Math.PI))); return Number.isFinite(n) ? n : null; };

function axisGraph(axisOpts, body, ctx) {
  const axis = keyValues(axisOpts);
  const sources = [];
  const points = [];
  const curves = [];
  let domain = axis.domain ? axis.domain.split(':').map(num) : null;
  const re = /\\addplot\+?\s*(\[[^\]]*\])?\s*/g;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    const opts = keyValues(m[1] ? m[1].slice(1, -1) : '');
    let rest = body.slice(m.index + m[0].length);
    if (/^coordinates/.test(rest)) {
      const g = group(rest, 'coordinates'.length);
      const pts = [...g[0].matchAll(/\(\s*([^,()]+)\s*,\s*([^()]+?)\s*\)/g)].map((p) => [num(p[1]), num(p[2])]).filter((p) => p.every((v) => v !== null));
      const onlyMarks = 'only marks' in opts || /only marks/.test(m[1] || '');
      const open = /mark\s*=\s*o\b|fill\s*=\s*white/.test(m[1] || '');
      if (onlyMarks) for (const p of pts) points.push({ kind: open ? 'open dot' : 'solid dot', coordinate: p });
      else if (pts.length >= 2) curves.push({ kind: 'line', color: opts.color || '', label: `line through ${pts.length} points`, corners: pts.sort((a, b) => a[0] - b[0]) });
      re.lastIndex = m.index + m[0].length + g[1];
      continue;
    }
    if (/^(table|file|gnuplot|\()/.test(rest)) { ctx.notes.push('A pgfplots plot from a table, a file or with parametric coordinates was not read.'); continue; }
    const g = /^\{/.test(rest) ? group(rest, 0) : null;
    if (!g) continue;
    re.lastIndex = m.index + m[0].length + g[1];
    const plotDomain = opts.domain ? opts.domain.split(':').map(num) : domain;
    try {
      let latex = latexOfPlain(pgfToPlain(g[0]));
      // A plot drawn only on part of the axis is that function on that part.
      // (A domain as wide as the axis itself is not a restriction.)
      const axisX = [num(axis.xmin), num(axis.xmax)];
      const narrower = plotDomain && plotDomain.every((v) => v !== null)
        && !(axisX.every((v) => v !== null) && plotDomain[0] <= axisX[0] && plotDomain[1] >= axisX[1]);
      if (narrower) latex = `f(x) = \\begin{cases} ${latex} & ${plotDomain[0]} \\le x \\le ${plotDomain[1]} \\end{cases}`;
      sources.push({ text: latex, format: 'latex' });
    } catch (error) {
      ctx.notes.push(`A plotted function could not be read: ${g[0]} (${error.message})`);
    }
  }
  const x = [num(axis.xmin), num(axis.xmax)];
  const y = [num(axis.ymin), num(axis.ymax)];
  const xr = x.every((v) => v !== null) && x[0] < x[1] ? x : domain && domain.every((v) => v !== null) ? domain : null;
  const yr = y.every((v) => v !== null) && y[0] < y[1] ? y : null;
  if (!sources.length && !curves.length && !points.length) return null;
  const graph = sources.length ? makeGraph(sources, { x: xr, y: yr }) : {
    summary: `${curves.map((c) => c.label).join('; ')}${points.length ? `; ${points.length} marked ${points.length === 1 ? 'point' : 'points'}` : ''}.`,
    span: { x: xr || [-5, 5], y: yr || [-5, 5] }, functions: [], points: [],
  };
  graph.curves = [...(graph.curves || []), ...curves];
  graph.points = [...(graph.points || []), ...points];
  if (points.length && sources.length) graph.summary += ` Marked: ${points.map((p) => `${p.kind} at ${p.coordinate.join(', ')}`).join('; ')}.`;
  return graph;
}

function latexOfPlain(plain) {
  parsePlain(plain); // reports a mistake in words
  return plainToLatex(plain);
}

function tikzBlocks(body, ctx) {
  const axes = [...body.matchAll(/\\begin\{(axis|semilogyaxis|semilogxaxis|loglogaxis)\}/g)];
  if (!axes.length) return [{ type: 'note', text: 'A TikZ drawing (not a pgfplots graph), so it was not read.' }];
  const out = [];
  for (const a of axes) {
    const start = a.index + a[0].length;
    const opt = optional(body, start);
    const [end] = environmentEnd(body, opt ? opt[1] : start, a[1]);
    const graph = axisGraph(opt ? opt[0] : '', body.slice(opt ? opt[1] : start, end), ctx);
    out.push(graph ? { type: 'graph', graph } : { type: 'note', text: 'A pgfplots graph with nothing that could be read.' });
  }
  return out;
}

// pgfplots code pasted on its own (in the graph dialog): \begin{axis}...\end{axis} or \addplot lines.
export function graphFromPgfplots(code) {
  const ctx = { notes: [], unknown: new Set(), headingShift: 0 };
  const src = /\\begin\{axis\}/.test(code) ? code : `\\begin{axis}${code}\\end{axis}`;
  const blocks = tikzBlocks(src, ctx);
  const graph = blocks.find((b) => b.type === 'graph')?.graph;
  if (!graph) throw new Error(ctx.notes[0] || 'No \\addplot with a function or coordinates was found.');
  return { graph, notes: ctx.notes };
}

// ---------- a graph as pgfplots code ----------

const PGF_NAMES = { log: 'log10', asin: 'rad(asin', acos: 'rad(acos', atan: 'rad(atan' };
export function graphToPgfplots(graph) {
  const lines = [];
  const [x0, x1] = graph.span.x, [y0, y1] = graph.span.y;
  lines.push('\\begin{tikzpicture}', '\\begin{axis}[', `  axis lines=middle, xlabel={$x$}, ylabel={$y$},`,
    `  xmin=${x0}, xmax=${x1}, ymin=${y0}, ymax=${y1},`, '  samples=300, unbounded coords=jump, restrict y to domain=' + `${y0 - 10 * (y1 - y0)}:${y1 + 10 * (y1 - y0)}`, ']');
  for (const f of graph.functions || []) {
    const fn = compileFunction(f.latex, 'latex');
    for (const row of fn.rows) {
      for (const [a, b] of row.intervals) {
        const lo = Math.max(x0, a), hi = Math.min(x1, b);
        if (lo < hi) lines.push(`\\addplot[thick, domain=${+lo.toPrecision(10)}:${+hi.toPrecision(10)}] {${toPgf(row.text)}};`);
      }
    }
  }
  for (const c of graph.curves || []) {
    const pts = (c.corners || c.samples || []).filter(Boolean);
    if (pts.length) lines.push(`\\addplot[thick] coordinates {${pts.map(([x, y]) => `(${x},${y})`).join(' ')}};`);
  }
  const solid = (graph.points || []).filter((p) => p.kind !== 'open dot');
  const open = (graph.points || []).filter((p) => p.kind === 'open dot');
  if (solid.length) lines.push(`\\addplot[only marks, mark=*] coordinates {${solid.map((p) => `(${p.coordinate.join(',')})`).join(' ')}};`);
  if (open.length) lines.push(`\\addplot[only marks, mark=*, mark options={fill=white}] coordinates {${open.map((p) => `(${p.coordinate.join(',')})`).join(' ')}};`);
  lines.push('\\end{axis}', '\\end{tikzpicture}');
  return lines.join('\n');
}

// Sound Lab syntax -> pgfplots maths: trig of radians is sin(deg(x)).
function toPgf(text) {
  let s = text;
  s = s.replace(/\b(sin|cos|tan)\(/g, '$1(deg(').replace(/\bcbrt\(/g, 'CBRT(');
  // close the deg( we opened: walk the brackets
  let out = '';
  const stack = [];
  for (let i = 0; i < s.length; i += 1) {
    const m = /^(sin|cos|tan)\(deg\(/.exec(s.slice(i));
    if (m) { out += m[0]; stack.push('deg'); i += m[0].length - 1; continue; }
    if (s[i] === '(') { stack.push('('); out += '('; continue; }
    if (s[i] === ')') { const top = stack.pop(); out += top === 'deg' ? '))' : ')'; continue; }
    out += s[i];
  }
  out = out.replace(/\bCBRT\(([^()]*(?:\([^()]*\))*[^()]*)\)/g, '(sign($1)*abs($1)^(1/3))');
  for (const [k, v] of Object.entries(PGF_NAMES)) out = out.replace(new RegExp(`\\b${k}\\(([^()]*)\\)`, 'g'), v.includes('(') ? `${v}($1))` : `${v}($1)`);
  // Brackets around one letter or number are not needed: sin(deg((x))) -> sin(deg(x)), ((x)^(2)) -> (x^2).
  for (let before = ''; before !== out;) {
    before = out;
    out = out.replace(/\(\((x|pi|e|\d+(?:\.\d+)?)\)\)/g, '($1)').replace(/\((x|pi|e|\d+(?:\.\d+)?)\)\^\((x|pi|e|\d+(?:\.\d+)?)\)/g, '$1^$2');
  }
  return out;
}

// ---------- the whole file ----------

export function texToBlocks(source) {
  const notes = [];
  const ctx = { notes, unknown: new Set(), headingShift: 0 };
  const noComments = source.replace(/\r\n?/g, '\n').replace(/(^|[^\\])%.*$/gm, '$1');
  const macros = collectMacros(noComments, notes);
  const begin = noComments.indexOf('\\begin{document}');
  const end = noComments.lastIndexOf('\\end{document}');
  const preamble = begin >= 0 ? noComments.slice(0, begin) : '';
  let body = begin >= 0 ? noComments.slice(begin + '\\begin{document}'.length, end >= 0 ? end : undefined) : noComments;
  // The definitions themselves are not text.
  body = body.replace(/\\(?:re)?newcommand\*?\s*\{?\\[A-Za-z]+\}?(\[\d\])?(\[[^\]]*\])?/g, '\\DROPDEF').replace(/\\DeclareMathOperator\*?\s*\{\\[A-Za-z]+\}/g, '\\DROPDEF');
  body = body.replace(/\\DROPDEF\s*\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}/g, '');
  body = expandMacros(body, macros);
  const titleOf = (name) => { const m = new RegExp(`\\\\${name}\\s*(\\[[^\\]]*\\])?\\s*\\{`).exec(preamble + body); return m ? group(preamble + body, m.index + m[0].length - 1)?.[0] : null; };
  const title = titleOf('title');
  const author = titleOf('author');
  // \title and \author are shown where \maketitle is (or at the top).
  body = body.replace(/\\(title|author|date)\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, '');
  ctx.headingShift = title ? 1 : 0; // the title is the only level-1 heading
  const blocks = [];
  if (title) blocks.push({ type: 'heading', level: 1, runs: inlineRuns(expandMacros(title, macros), {}, ctx) });
  if (author) blocks.push({ type: 'paragraph', runs: inlineRuns(expandMacros(author.replace(/\\and/g, ', '), macros), {}, ctx) });
  blocks.push(...readBlocks(body, ctx));
  for (const b of blocks) if (b.type === 'heading') b.level = Math.min(b.level, 6);
  if (ctx.unknown.size) notes.push(`These commands are not known to the notebook, so only their text was kept: ${[...ctx.unknown].map((n) => `\\${n}`).join(', ')}.`);
  return { title: title ? inlineRuns(title, {}, ctx).map((r) => r.text ?? '').join('') : null, blocks, notes };
}
