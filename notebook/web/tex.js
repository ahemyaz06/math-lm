// A LaTeX source file (.tex) as notebook blocks, and graphs to and from pgfplots code.
// Rules, not AI: the source already holds the exact maths; this only reads its structure.
// Blocks are the same as docx.js uses, plus { type: 'graph', graph } and { type: 'note', text }.
import { latexToMathml } from './mathml.js';
import { latexToPlain, parsePlain, plainToLatex } from './equation.js';
import { makeGraph, compileFunction, studentGraph } from './graphs.js';

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
  'itshape', 'rmfamily', 'sffamily', 'ttfamily', 'indent', 'linebreak', 'nolinebreak', 'protect', 'relax', 'displaystyle', 'item',
  'normalfont', 'linewidth', 'textwidth', 'scshape', 'upshape', 'mdseries']);
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
      // A lone dot or bullet in a word (R$\cdot$I$\cdot$T) is punctuation, not maths.
      const lone = { '\\cdot': '·', '\\bullet': '•', '\\cdots': '⋯' }[src.slice(i + 1, end).trim()];
      if (lone) { text(lone); i = end + 1; continue; }
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
      // A drawn line (\rule{\linewidth}{2pt}) is decoration, not text.
      if (name === 'rule') { const opt = optional(src, i); if (opt) i = opt[1]; for (let k = 0; k < 2; k += 1) { const g = group(src, i); if (g) i = g[1]; } continue; }
      if (name === 'textsc' || name === 'textrm' || name === 'texttt' || name === 'textsf' || name === 'mbox' || name === 'text' || name === 'textnormal' || name === 'textup') {
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
  // No empty lines: a break at the start or end, or a break after a break (left where a
  // drawn line or a space was), is dropped.
  const trimmed = runs.map((r, n) => (r.text !== undefined && (runs[n - 1]?.lineBreak || runs[n + 1]?.lineBreak) ? { ...r, text: r.text.trim() } : r))
    .filter((r) => r.text !== '' || r.latex !== undefined || r.lineBreak);
  const out = [];
  for (const r of trimmed) {
    if (r.lineBreak && (!out.length || out.at(-1).lineBreak)) continue;
    out.push(r);
  }
  while (out.at(-1)?.lineBreak) out.pop();
  return out;
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
    // A line break, even one with extra space after it (\\[0.1cm]), is not display maths:
    // the paragraph's reader turns it into a line break.
    if (src.startsWith('\\\\', i)) { para += '\\\\'; i += 2; continue; }
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
  // (\x) is how TikZ files keep a negative x safe; written out it is just x.
  // (Not deg(\x) or sqrt(\x): there the brackets belong to the function.)
  let s = expr.replace(/(^|[^A-Za-z])\(\s*\\x\s*\)/g, '$1x').replace(/\\x\b/g, 'x').replace(/\s+/g, ' ').trim();
  let out = '';
  for (let i = 0; i < s.length;) {
    const m = /^(sin|cos|tan|sec|cosec|csc|cot)\s*\(/.exec(s.slice(i));
    if (!m) { out += s[i]; i += 1; continue; }
    let depth = 0, j = i + m[0].length - 1;
    for (; j < s.length; j += 1) { if (s[j] === '(') depth += 1; else if (s[j] === ')') { depth -= 1; if (depth === 0) break; } }
    const arg = s.slice(i + m[0].length, j);
    // Radians: sin(deg(x)) in pgfplots, or TikZ's own sin(\x r) (r after the angle).
    const deg = /^\s*deg\s*\((.*)\)\s*$/.exec(arg) || /^(.*\S)\s+r\s*$/.exec(arg);
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
// A number from an option; a missing option (xmin not given) is null, not 0.
const num = (v) => { const s = String(v ?? '').replace(/[{}]/g, '').trim(); if (!s) return null; const n = Number(s.replace(/^pi$/, String(Math.PI))); return Number.isFinite(n) ? n : null; };

// A shaded area (how a page shows an integral), in words for the graph's description.
function shadeWords(shades) {
  if (!shades.length) return '';
  const range = (s) => (s.lo !== null && s.hi !== null ? ` from x = ${spoken(s.lo)} to ${spoken(s.hi)}` : '');
  return ` Shaded: ${shades.map((s) => `the area ${s.between ? 'between the two curves' : 'under the curve'}${range(s)}`).join('; ')}.`;
}

function axisGraph(axisOpts, body, ctx) {
  const axis = keyValues(axisOpts);
  const sources = [];
  const points = [];
  const curves = [];
  const shades = [];
  const named = {}; // name path=f: which plot it is, for fill between
  const domainOf = (text) => { const d = (text || '').split(':').map(num); return d.length === 2 && d.every((v) => v !== null) ? d : null; };
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
    // \addplot fill between[of=f and g, soft clip={domain=0:1}]: the area between two named plots.
    const between = /^fill\s+between\s*(\[[^\]]*(?:\{[^}]*\}[^\]]*)*\])?/.exec(rest);
    if (between) {
      const o = keyValues((between[1] || '[]').slice(1, -1));
      const clip = /domain\s*=\s*([^,}\]]+)/.exec(o['soft clip'] || '');
      const of = (o.of || '').split(/\s+and\s+/).map((s) => s.trim());
      // Between a curve and a plot of 0 (the x-axis) is the area under the curve.
      const axisLine = of.some((n) => named[n]?.zero);
      shades.push({ between: !axisLine, ...(clip ? { lo: domainOf(clip[1])?.[0] ?? null, hi: domainOf(clip[1])?.[1] ?? null } : { lo: null, hi: null }) });
      for (const n of of) if (named[n]?.zero) named[n].drop = true;
      re.lastIndex = m.index + m[0].length + between[0].length;
      continue;
    }
    const g = /^\{/.test(rest) ? group(rest, 0) : null;
    if (!g) continue;
    re.lastIndex = m.index + m[0].length + g[1];
    const plotDomain = opts.domain ? opts.domain.split(':').map(num) : domain;
    // \addplot[fill=...] {x^2} \closedcycle: the area under the curve over its domain.
    const filled = /^\s*\\closedcycle/.test(rest.slice(g[1])) || (opts.fill && opts.fill !== 'none' && !/white/.test(opts.fill));
    if (filled) {
      shades.push({ between: false, lo: plotDomain?.[0] ?? null, hi: plotDomain?.[1] ?? null });
      // The same curve drawn again in full is the graph; the filled part only marks the area.
      if (body.split(`{${g[0]}}`).length > 2) continue;
    }
    try {
      let latex = latexOfPlain(pgfToPlain(g[0]));
      if (opts['name path']) named[opts['name path']] = { zero: /^\s*0\s*$/.test(g[0]), index: sources.length };
      // pgfplots draws a plot over its domain, or the axis's, or -5 to 5.
      const own = plotDomain && plotDomain.every((v) => v !== null) ? plotDomain : [-5, 5];
      sources.push({ text: latex, format: 'latex', domain: [Math.min(...own), Math.max(...own)] });
    } catch (error) {
      ctx.notes.push(`A plotted function could not be read: ${g[0]} (${error.message})`);
    }
  }
  const x = [num(axis.xmin), num(axis.xmax)];
  const y = [num(axis.ymin), num(axis.ymax)];
  // Without xmin and xmax the axis is as wide as what is plotted.
  const widest = sources.length ? [Math.min(...sources.map((src) => src.domain[0])), Math.max(...sources.map((src) => src.domain[1]))] : null;
  const xr = x.every((v) => v !== null) && x[0] < x[1] ? x : domain && domain.every((v) => v !== null) ? domain : widest;
  const yr = y.every((v) => v !== null) && y[0] < y[1] ? y : null;
  // A plot of 0 named only for fill between is the x-axis, not a function to describe.
  const drop = new Set(Object.values(named).filter((n) => n.drop).map((n) => n.index));
  // A plot drawn on only part of the axis is that function on that part.
  const kept = sources.filter((_, i) => !drop.has(i)).map((src) => (xr && (src.domain[0] > xr[0] + 1e-9 || src.domain[1] < xr[1] - 1e-9)
    ? { ...src, text: `f(x) = \\begin{cases} ${src.text} & ${src.domain[0]} \\le x \\le ${src.domain[1]} \\end{cases}` } : src));
  if (!kept.length && !curves.length && !points.length) return null;
  const graph = kept.length ? makeGraph(kept, { x: xr, y: yr }) : {
    summary: `${curves.map((c) => c.label).join('; ')}${points.length ? `; ${points.length} marked ${points.length === 1 ? 'point' : 'points'}` : ''}.`,
    span: { x: xr || [-5, 5], y: yr || [-5, 5] }, functions: [], points: [],
  };
  // A plot simply stops at the end of its domain: pgfplots draws no dot there.
  for (const pt of graph.points || []) graph.summary = graph.summary.replace(`; ${pt.label}`, '').replace(`: ${pt.label}; `, ': ').replace(`: ${pt.label}.`, '.');
  graph.curves = [...(graph.curves || []), ...curves];
  graph.points = points;
  if (points.length && kept.length) graph.summary += ` Marked: ${points.map((p) => `${p.kind} at ${p.coordinate.join(', ')}`).join('; ')}.`;
  graph.summary += shadeWords(shades);
  return graph;
}

function latexOfPlain(plain) {
  parsePlain(plain); // reports a mistake in words
  return plainToLatex(plain);
}

// ---------- TikZ drawings of functions ----------

// A number as TikZ writes one: 2, -0.5, .5, pi, -pi, 2*pi, pi/2 (the last few are rare in points).
const NUM = '(-?\\d*\\.?\\d+)';
const POINT = `\\(\\s*${NUM}\\s*,\\s*${NUM}\\s*\\)`;
const tikzNumber = (v) => {
  const s = String(v ?? '').replace(/[{}\s]/g, '');
  if (!s) return null;
  const n = Number(s);
  if (Number.isFinite(n)) return n;
  // pi, -pi, 2*pi, pi/2, 3.14: a short product or quotient of a number and pi.
  const m = /^(-?)(\d*\.?\d*)\*?(pi)?(?:\/(\d*\.?\d+))?$/.exec(s);
  if (!m || (!m[2] && !m[3])) return null;
  return (m[1] ? -1 : 1) * (m[2] ? Number(m[2]) : 1) * (m[3] ? Math.PI : 1) / (m[4] ? Number(m[4]) : 1);
};
// A drawn end close to a whole number is that number: plots stop a little short of a dot
// (domain=0.03:0.99 is drawn up to the dots at 0 and 1).
const snap = (v) => (Math.abs(v - Math.round(v)) <= 0.06 ? Math.round(v) : v);
const close = (a, b) => Math.abs(a - b) <= 1e-6 * (1 + Math.abs(a));
const fmt = (v) => String(Number(v.toPrecision(12)));
const spoken = (v) => String(Number(v.toPrecision(6))).replace('-', 'minus ');

// Everything a \draw / \filldraw / \fill / \path command says, up to its ;
function drawCommands(body) {
  const out = [];
  const re = /\\(draw|filldraw|fill|path|node)\b/g;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    let i = m.index + m[0].length, depth = 0;
    for (; i < body.length; i += 1) {
      if (body[i] === '{') depth += 1;
      else if (body[i] === '}') depth -= 1;
      else if (body[i] === ';' && depth <= 0) break;
    }
    const text = body.slice(m.index + m[0].length, i);
    const opts = /^\s*\[([^\]]*)\]/.exec(text);
    out.push({ command: m[1], opts: opts ? opts[1] : '', rest: opts ? text.slice(opts[0].length) : text });
    re.lastIndex = i + 1;
  }
  return out;
}

// A TikZ picture that draws a function becomes a real graph:
// - \draw plot (\x, {formula}) (or ({\x}, {...}), any variable, domain on the draw or the plot):
//   each plot is a piece of the function; one formula drawn in parts around a gap is one piece;
// - \draw (-2,1) -- (0,3) -- (2,1) and \draw plot coordinates {...}: a graph of straight pieces;
// - the solid lines along y = 0 and x = 0 are the axes and give the window (or a \clip);
//   dashed and grid lines are left out;
// - dots: \node at (x,y) {$\circ$} (open) or {\textbullet}, {$\bullet$} (solid), a circle node
//   (filled or white), \fill (x,y) circle (solid) and \draw[fill=white] (x,y) circle (open).
// Returns null when the picture draws no function.
function tikzPlotGraph(body, ctx) {
  const plots = [], polylines = [], dots = [], shades = [];
  let x = null, y = null, clip = null;
  for (const d of drawCommands(body)) {
    const dashed = /dash|dot|help lines|gr[ae]y|very thin/.test(d.opts);
    // A plot of a formula.
    const plot = /plot\s*(\[([^\]]*)\])?\s*\(\s*\{?\s*\\([A-Za-z]+)\s*\}?\s*,/.exec(d.rest);
    if (plot && d.command !== 'node') {
      const g = group(d.rest, plot.index + plot[0].length);
      if (!g) continue;
      const opts = { ...keyValues(d.opts), ...keyValues(plot[2] || '') };
      const variable = (opts.variable || '\\x').replace(/^\\/, '');
      if (variable !== plot[3]) { ctx.notes.push('A TikZ plot of a curve given by two formulas (parametric) was not read.'); continue; }
      const domain = (opts.domain || '-5:5').split(':').map(tikzNumber);
      if (domain.length !== 2 || domain.some((v) => v === null)) continue;
      const expr = g[0].replace(new RegExp(`\\\\${variable}\\b`, 'g'), '\\x');
      const label = /^\s*\)\s*node\s*(\[[^\]]*\])?\s*\{\s*\$([^$]*)\$\s*\}/.exec(d.rest.slice(g[1]));
      // \fill (0,0) -- plot (\x, {\x^2}) -- (2,0) -- cycle: a shaded area under the curve.
      if ((d.command === 'fill' || /(^|,)\s*fill\b(?!\s*=\s*white)/.test(d.opts)) && /--\s*cycle/.test(d.rest)) {
        shades.push({ between: false, lo: Math.min(...domain), hi: Math.max(...domain), expr });
        if (d.command === 'fill') continue;
      }
      plots.push({ expr, lo: Math.min(...domain), hi: Math.max(...domain), left: /<-|latex-|stealth-/.test(d.opts), right: /->|-latex|-stealth/.test(d.opts), label: label ? label[2] : null });
      continue;
    }
    // Points listed with plot coordinates {(0,0) (1,1)}.
    const coords = /plot\s*(\[[^\]]*\])?\s*coordinates\s*\{([^}]*)\}/.exec(d.rest);
    if (coords) { polylines.push([...coords[2].matchAll(new RegExp(POINT, 'g'))].map((p) => [Number(p[1]), Number(p[2])])); continue; }
    // plot ({cos(\x r)}, {sin(\x r)}): x is a formula too, so this is not a function of x.
    if (/plot\s*(\[[^\]]*\])?\s*\(\s*\{/.test(d.rest) && d.command !== 'node') { ctx.notes.push('A TikZ plot of a curve given by two formulas (parametric) was not read.'); continue; }
    if (/^\s*\(/.test(d.rest) && /\bclip\b/.test(d.opts + d.command)) { /* \path[clip] */ }
    // A straight path (a) -- (b) -- (c).
    const line = new RegExp(`^\\s*${POINT}((?:\\s*--\\s*${POINT})+)`).exec(d.rest);
    if (line && d.command !== 'node') {
      const pts = [...d.rest.slice(0, line[0].length).matchAll(new RegExp(POINT, 'g'))].map((p) => [Number(p[1]), Number(p[2])]);
      if (dashed) continue;
      const horizontal = pts.every((p) => p[1] === 0), vertical = pts.every((p) => p[0] === 0);
      if (pts.length === 2 && horizontal) { x = [Math.min(pts[0][0], pts[1][0]), Math.max(pts[0][0], pts[1][0])]; continue; }
      if (pts.length === 2 && vertical) { y = [Math.min(pts[0][1], pts[1][1]), Math.max(pts[0][1], pts[1][1])]; continue; }
      // A graph goes left to right; anything that turns back (a box, an arrow) is a drawing.
      const xs = pts.map((p) => p[0]);
      if (xs.every((v, k) => k === 0 || v > xs[k - 1]) || xs.every((v, k) => k === 0 || v < xs[k - 1])) polylines.push(pts);
      continue;
    }
    // Dots.
    const at = new RegExp(`at\\s*${POINT}\\s*\\{([^}]*)\\}`).exec(d.rest) || new RegExp(`^\\s*${POINT}\\s*node\\s*(?:\\[[^\\]]*\\])?\\s*\\{([^}]*)\\}`).exec(d.rest);
    if (at && (d.command === 'node' || /node/.test(d.rest))) {
      const content = at[3];
      const circle = /circle/.test(d.opts) && !content.trim();
      const kind = /\\circ\b|\\ocircle/.test(content) ? 'open dot' : /bullet/.test(content) ? 'solid dot'
        : circle ? (/fill\s*=\s*white/.test(d.opts) || !/fill/.test(d.opts) ? 'open dot' : 'solid dot') : null;
      if (kind) dots.push({ kind, coordinate: [Number(at[1]), Number(at[2])] });
      continue;
    }
    const round = new RegExp(`^\\s*${POINT}\\s*circle`).exec(d.rest);
    if (round) {
      const open = /fill\s*=\s*white/.test(d.opts) || (d.command === 'draw' && !/fill/.test(d.opts));
      dots.push({ kind: open ? 'open dot' : 'solid dot', coordinate: [Number(round[1]), Number(round[2])] });
      continue;
    }
    const rect = new RegExp(`^\\s*${POINT}\\s*rectangle\\s*${POINT}`).exec(d.rest);
    if (rect && /clip/.test(d.opts + d.command)) clip = rect.slice(1, 5).map(Number);
  }
  for (const m of body.matchAll(new RegExp(`\\\\clip\\s*${POINT}\\s*rectangle\\s*${POINT}`, 'g'))) clip = m.slice(1, 5).map(Number);
  if (clip) {
    x ||= [Math.min(clip[0], clip[2]), Math.max(clip[0], clip[2])];
    y ||= [Math.min(clip[1], clip[3]), Math.max(clip[1], clip[3])];
  }
  // Only filled, never drawn: the shaded area's edge is the curve.
  if (!plots.length) plots.push(...shades.map((sh) => ({ expr: sh.expr, lo: sh.lo, hi: sh.hi, left: false, right: false, label: null })));
  if (!plots.length && !polylines.length) return null;
  // Straight lines alone are a graph only with axes: a box and an arrow are a drawing.
  if (!plots.length && !x && !y) return null;
  try {
    const graph = plots.length ? formulaGraph(plots, dots, x, y) : { summary: '', span: null, curves: [], points: [] };
    // Straight pieces drawn point to point: exact corners, as drawn.
    // Pieces side by side (one ends where or before the next starts) are one function with a
    // break between them; pieces that overlap in x are separate lines.
    const sortedLines = polylines.map((pts) => [...pts].sort((a, b) => a[0] - b[0])).sort((a, b) => a[0][0] - b[0][0]);
    const sideBySide = sortedLines.every((pts, k) => k === 0 || pts[0][0] >= sortedLines[k - 1].at(-1)[0] - 1e-9);
    if (sideBySide && sortedLines.length > 1) graph.curves.push({ kind: 'line', label: 'the graph', color: '', corners: sortedLines.flatMap((pts, k) => (k ? [null, ...pts] : pts)) });
    else for (const pts of sortedLines) graph.curves.push({ kind: 'line', label: sortedLines.length > 1 ? 'a line' : 'the graph', color: '', corners: pts });
    if (!plots.length) {
      const all = polylines.flat();
      const pad = (lo, hi) => [Math.floor(lo - 1), Math.ceil(hi + 1)];
      graph.span = { x: x || pad(Math.min(...all.map((p) => p[0])), Math.max(...all.map((p) => p[0]))), y: y || pad(Math.min(0, ...all.map((p) => p[1])), Math.max(0, ...all.map((p) => p[1]))) };
      graph.points = dots;
      const pt = (p) => `${spoken(p[0])}, ${spoken(p[1])}`;
      graph.summary = `${polylines.map((pts) => `Straight pieces through ${[...pts].sort((a, b) => a[0] - b[0]).map(pt).join('; then ')}`).join('. ')}.`
        + `${dots.length ? ` Dots: ${dots.map((d) => `${d.kind} at ${pt(d.coordinate)}`).join('; ')}.` : ''}`
        + ` Shown for x from ${spoken(graph.span.x[0])} to ${spoken(graph.span.x[1])} and y from ${spoken(graph.span.y[0])} to ${spoken(graph.span.y[1])}.`;
    } else if (polylines.length) {
      graph.summary += ` Also straight pieces through ${polylines.map((pts) => pts.map((p) => `${spoken(p[0])}, ${spoken(p[1])}`).join('; then ')).join('. And ')}.`;
    }
    graph.summary += shadeWords(shades);
    return graph;
  } catch (error) {
    ctx.notes.push(`A function drawn with TikZ could not be read: ${plots.map((p) => p.expr).join('; ')} (${error.message})`);
    return null;
  }
}

// Plots of formulas, with their dots, as one function. The formula is not kept: the printed
// page shows only the drawing, so the graph holds the curve, its points and dots (as a student
// copy whose formula is hidden).
function formulaGraph(plots, dots, x, y) {
  let pieces = plots.map((p) => {
    const plain = pgfToPlain(p.expr);
    const fn = compileFunction(plain, 'plain').graph;
    return { ...p, plain, latex: latexOfPlain(plain), fn, lo: p.left ? -Infinity : snap(p.lo), hi: p.right ? Infinity : snap(p.hi) };
  }).sort((a, b) => a.lo - b.lo);
  // One formula drawn in parts (left and right of an asymptote, 1/(x-1) on -3:0.9 and 1.1:3)
  // is one function: its own maths says what happens in the gap.
  if (pieces.length > 1 && pieces.every((p) => p.plain === pieces[0].plain)) {
    pieces = [{ ...pieces[0], lo: pieces[0].lo, hi: Math.max(...pieces.map((p) => p.hi)), right: pieces.some((p) => p.right) }];
  }
  // Each end belongs to its piece when a solid dot sits there (or nothing marks it open and
  // no earlier piece already has that x); an open dot leaves it out.
  const ownsEnd = (p, b, earlier) => {
    const v = p.fn.limitAt(b);
    const at = (kind) => dots.some((d) => d.kind === kind && close(d.coordinate[0], b) && (v.defined || v.hole) && Math.abs(d.coordinate[1] - v.y) < 0.05 * (1 + Math.abs(v.y)));
    if (at('open dot')) return false;
    if (at('solid dot')) return true;
    return !earlier;
  };
  const rows = pieces.map((p, n) => {
    const before = pieces.slice(0, n).some((q) => close(q.hi, p.lo) && ownsEnd(q, p.lo, false));
    const lo = Number.isFinite(p.lo) ? `${fmt(p.lo)} ${ownsEnd(p, p.lo, before) ? '\\le' : '<'} ` : '';
    const hi = Number.isFinite(p.hi) ? ` ${ownsEnd(p, p.hi, false) ? '\\le' : '<'} ${fmt(p.hi)}` : '';
    return lo || hi ? `${p.latex} & ${lo}x${hi}` : null;
  });
  const name = plots.map((p) => p.label).find((l) => l && /f\s*\(\s*x\s*\)/.test(l)) ? 'f(x)' : 'y';
  const latex = rows.every((r) => r === null) && pieces.length === 1 ? `${name} = ${pieces[0].latex}`
    : `${name} = \\begin{cases} ${pieces.map((p, n) => rows[n] ?? `${p.latex} & \\text{otherwise}`).join(' \\\\ ')} \\end{cases}`;
  const full = makeGraph([{ text: latex, format: 'latex' }], { x, y });
  // Where the drawing simply stops (a domain end with nothing drawn there) there is no dot:
  // the curve's start or end is said instead. Dots stay where they are drawn, and where two
  // pieces meet (a jump).
  const shared = (b) => pieces.some((p) => close(p.hi, b)) && pieces.some((p) => close(p.lo, b));
  const drawn = (pt) => dots.some((d) => d.kind === pt.kind && close(d.coordinate[0], pt.coordinate[0]) && Math.abs(d.coordinate[1] - pt.coordinate[1]) < 0.05);
  const dropped = full.points.filter((pt) => !(drawn(pt) || shared(pt.coordinate[0])));
  full.points = full.points.filter((pt) => !dropped.includes(pt));
  // Dots drawn in the picture that the pieces' own ends did not already make.
  const extra = dots.filter((d) => !full.points.some((p) => p.kind === d.kind && close(p.coordinate[0], d.coordinate[0]) && Math.abs(p.coordinate[1] - d.coordinate[1]) < 0.05));
  full.points.push(...extra.map((d) => ({ ...d, function: 0, label: `${d.kind} at ${d.coordinate.join(', ')}` })));
  const graph = studentGraph({ ...full, student: { hideFormula: true, hide: [], note: 'Drawn on the page; its formula is not shown, as on paper.' } });
  for (const pt of dropped) graph.summary = graph.summary.replace(`; ${pt.label}`, '').replace(`: ${pt.label}; `, ': ');
  if (extra.length) graph.summary += ` Also drawn: ${extra.map((d) => `${d.kind} at ${d.coordinate.join(', ')}`).join('; ')}.`;
  return graph;
}

function tikzBlocks(body, ctx) {
  const axes = [...body.matchAll(/\\begin\{(axis|semilogyaxis|semilogxaxis|loglogaxis)\}/g)];
  if (!axes.length) {
    const graph = tikzPlotGraph(body, ctx);
    if (graph) return [{ type: 'graph', graph }];
    return [{ type: 'note', text: 'A TikZ drawing (not a pgfplots graph), so it was not read.' }];
  }
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
  return { title: title ? inlineRuns(expandMacros(title, macros), {}, ctx).map((r) => r.text ?? (r.lineBreak ? ' ' : '')).join('').replace(/\s+/g, ' ').trim() : null, blocks, notes };
}
