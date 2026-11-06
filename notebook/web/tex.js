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
  // A name is letters or one symbol: \newcommand{\?}{\stackrel{?}{=}}. (@ is a letter in
  // \makeatletter's \renewcommand{\@seccntformat}.)
  const re = /\\(?:re)?newcommand\*?\s*\{?\\([A-Za-z@]+|[^A-Za-z@\s{}\\])\}?|\\def\\([A-Za-z]+)|\\DeclareMathOperator\*?\s*\{\\([A-Za-z]+)\}/g;
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
  // A letter name ends where the letters do; a symbol name is that one symbol.
  const re = new RegExp(`\\\\(${names.join('|')})(?<=\\\\[^A-Za-z]|[A-Za-z](?![A-Za-z]))`, 'g');
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
        let g = null;
        try { g = group(out, i); } catch { /* a { never closed: the next character is the argument */ }
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
  'normalfont', 'linewidth', 'textwidth', 'scshape', 'upshape', 'mdseries',
  // The exam class's page furniture: points in the margin, answer lines, grade tables.
  'addpoints', 'noaddpoints', 'printanswers', 'noprintanswers', 'pointsinmargin', 'nopointsinmargin', 'bracketedpoints',
  'boxedpoints', 'pointsdroppedatright', 'unframedsolutions', 'answerline', 'gradetable', 'pointtable', 'bonusgradetable',
  'partialgradetable', 'combinedgradetable']);
const DROP_WITH_ARG = new Set(['label', 'vspace', 'hspace', 'vspace*', 'hspace*', 'setlength', 'pagestyle', 'thispagestyle', 'addtolength',
  'setcounter', 'addcontentsline', 'phantom', 'index', 'hypersetup', 'usepackage', 'documentclass', 'geometry', 'graphicspath',
  'vphantom', 'hphantom', 'fillwithlines', 'fillwithdottedlines', 'makeemptybox', 'enlargethispage']);
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
      const m = /^\\([A-Za-z]+\*?|[\s\S])/.exec(src.slice(i));
      if (!m) break; // a backslash at the very end
      const name = m[1];
      i += m[0].length;
      // A backslash before a space or a line end ("Quiz 1\ Version A\") is a space.
      if (/^\s$/.test(name)) { text(' '); continue; }
      // \verb|\frac{a}{b}|: what is between the two marks, exactly as typed.
      if (name === 'verb' || name === 'verb*') {
        const end = src.indexOf(src[i], i + 1);
        if (src[i] && end > i) { text(src.slice(i + 1, end)); i = end + 1; }
        continue;
      }
      if (name === 'fillin') { const opt = optional(src, i); if (opt) i = opt[1]; text('____'); continue; }
      if (name === '\\' || name === 'newline') { if (src[i] === '*') i += 1; const opt = optional(src, i); if (opt) i = opt[1]; runs.push({ lineBreak: true }); continue; }
      if (STYLE[name]) { const g = group(src, i); if (g) { runs.push(...inlineRuns(g[0], { ...style, [STYLE[name]]: true }, ctx)); i = g[1]; } continue; }
      // A drawn line (\rule{\linewidth}{2pt}) is decoration, not text.
      if (name === 'rule') { const opt = optional(src, i); if (opt) i = opt[1]; for (let k = 0; k < 2; k += 1) { const g = group(src, i); if (g) i = g[1]; } continue; }
      // \textcolor{red}{word}: the word, without its colour.
      if (name === 'textcolor' || name === 'colorbox') { const colour = group(src, i); if (colour) i = colour[1]; }
      if (name === 'color') { const colour = group(src, i); if (colour) i = colour[1]; continue; }
      if (name === 'textsc' || name === 'textrm' || name === 'texttt' || name === 'textsf' || name === 'mbox' || name === 'text' || name === 'textnormal' || name === 'textup'
        || name === 'centerline' || name === 'textcolor' || name === 'colorbox') {
        const g = group(src, i); if (g) { runs.push(...inlineRuns(g[0], style, ctx)); i = g[1]; } continue;
      }
      if (name === 'href') { const url = group(src, i); const label = url && group(src, url[1]); if (label) { runs.push(...inlineRuns(label[0], style, ctx)); i = label[1]; } continue; }
      if (name === 'url') { const g = group(src, i); if (g) { text(g[0]); i = g[1]; } continue; }
      if (name === 'vskip' || name === 'hskip') { i += skipLength(src.slice(i)); text(' '); continue; }
      if (name === 'footnotemark') { const opt = optional(src, i); if (opt) i = opt[1]; continue; }
      if (name === 'footnotetext') { const opt = optional(src, i); if (opt) i = opt[1]; const g = group(src, i); if (g) { text(' (footnote: '); runs.push(...inlineRuns(g[0], style, ctx)); text(')'); i = g[1]; } continue; }
      if (name === 'footnote') { const g = group(src, i); if (g) { text(' (footnote: '); runs.push(...inlineRuns(g[0], style, ctx)); text(')'); i = g[1]; } continue; }
      if (name === 'ref' || name === 'eqref' || name === 'cite' || name === 'pageref') { const g = group(src, i); if (g) i = g[1]; text(name === 'cite' ? '[citation]' : '(reference)'); continue; }
      if (DROP_WITH_ARG.has(name)) { const opt = optional(src, i); if (opt) i = opt[1]; const g = group(src, i); if (g) i = g[1]; continue; }
      if (IGNORED.has(name)) {
        // \gradetable[h][questions], \answerline[3]: their options are not text either.
        if (/table$|^answerline$/.test(name)) for (let opt = optional(src, i); opt; opt = optional(src, i)) i = opt[1];
        continue;
      }
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

// The length after \vskip or \hskip (0.2in, -2 mm, 1em plus 2pt, \baselineskip): how many characters.
function skipLength(rest) {
  const m = /^\s*(?:-?(?:\d+\.?\d*|\.\d+)\s*(?:pt|in|cm|mm|em|ex|bp|pc|sp|dd|cc|mu|true\s*\w+)|\\[A-Za-z]+)(?:\s*(?:plus|minus)\s*-?(?:\d+\.?\d*|\.\d+)\s*(?:pt|in|cm|mm|em|ex|fil{1,3}))*/.exec(rest);
  return m ? m[0].length : 0;
}

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
    // A command as separator (\item, \question) is that command, not a longer one (\items, \questions).
    else if (depth === 0 && envDepth === 0 && src.startsWith(separator, i) && !(/[A-Za-z]$/.test(separator) && /[A-Za-z]/.test(src[i + separator.length] || ''))) {
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
      let runs;
      try {
        runs = inlineRuns(para, {}, ctx);
      } catch (error) {
        // One bad spot (a { never closed) loses only this paragraph's commands, not the
        // document: its words are kept as typed, with a note saying so.
        const words = para.replace(/\\[A-Za-z]+\*?/g, ' ').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
        ctx.notes.push(`A paragraph could not be read fully (${error.message}); its words are kept as typed: ${words.slice(0, 60)}`);
        runs = words ? [{ text: words }] : [];
      }
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
      if (end < 0) {
        ctx.notes.push(`Display maths opened with ${src.slice(i, i + 2)} is never closed; what follows is read as text.`);
        i += 2;
        continue;
      }
      flush();
      blocks.push(...displayRows(src.slice(i + 2, end), ctx));
      i = end + 2;
      continue;
    }
    try {
    const cmd = /^\\([A-Za-z]+)(\*?)/.exec(src.slice(i));
    if (cmd && SECTIONS[cmd[1]]) {
      flush();
      let j = i + cmd[0].length;
      const opt = optional(src, j); if (opt) j = opt[1];
      const g = group(src, j);
      if (g) { blocks.push({ type: 'heading', level: SECTIONS[cmd[1]] + ctx.headingShift, runs: inlineRuns(g[0], {}, ctx) }); i = g[1]; continue; }
    }
    if (cmd && ['newpage', 'clearpage', 'pagebreak', 'cleardoublepage'].includes(cmd[1])) { flush(); blocks.push({ type: 'pageBreak' }); i += cmd[0].length; continue; }
    // A large centred line is a heading: \textbf{\centerline{\large Higher Order Derivatives}}.
    const centred = /^(\\textbf\s*\{\s*)?\\centerline\s*\{/.exec(src.slice(i));
    if (centred) {
      const g = group(src, i + centred[0].length - 1);
      if (g && /\\(?:large|Large|LARGE|huge|Huge)(?![A-Za-z])/.test(g[0])) {
        const close = centred[1] ? /^\s*\}/.exec(src.slice(g[1])) : null;
        flush();
        blocks.push({ type: 'heading', level: 1 + ctx.headingShift, runs: inlineRuns(g[0], {}, ctx).map(({ underline, ...r }) => r) });
        i = g[1] + (close ? close[0].length : 0);
        continue;
      }
    }
    // Vertical space ends the paragraph, as in TeX: "Step 1: ... \vskip0.1in Step 2: ..." are two.
    if (cmd && ['vskip', 'vfill', 'bigskip', 'medskip', 'smallskip'].includes(cmd[1])) { flush(); i += cmd[0].length + (cmd[1] === 'vskip' ? skipLength(src.slice(i + cmd[0].length)) : 0); continue; }
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
    // \input{part2}: the other file is not part of this one.
    if (cmd && ['input', 'include', 'subfile'].includes(cmd[1])) {
      const g = group(src, i + cmd[0].length);
      if (g) {
        flush();
        blocks.push({ type: 'note', text: `This file includes another file, ${g[0].trim()}, which was not read. Import that file on its own.` });
        i = g[1];
        continue;
      }
    }
    // A box around whole paragraphs, environments or display maths (\fbox{\parbox{\textwidth}{\begin{definition}...}},
    // \fbox{\parbox{\textwidth}{Then, $$...$$}}): its content, read as blocks. A box inside a sentence stays part of it.
    const box = cmd && BOXES[cmd[1]] !== undefined ? boxContent(src, i + cmd[0].length, BOXES[cmd[1]]) : null;
    if (box && /\\begin\{|\n[ \t]*\n|\$\$|\\\[|\\par(?![A-Za-z])/.test(box[0])) {
      flush();
      blocks.push(...readBlocks(box[0], ctx, listLevel));
      i = box[1];
      continue;
    }
    if (cmd && cmd[1] === 'begin') {
      const g = group(src, i + cmd[0].length);
      if (!g) { i += cmd[0].length; continue; }
      const name = g[0].trim();
      let endAt, after;
      try {
        [endAt, after] = environmentEnd(src, g[1], name);
      } catch (error) {
        // Never closed: its content is read on, as if \begin{...} were not there.
        ctx.notes.push(`${error.message} What follows it is read as ordinary text.`);
        flush();
        i = g[1];
        continue;
      }
      const body = src.slice(g[1], endAt);
      flush();
      try {
        blocks.push(...environment(name, body, ctx, listLevel));
      } catch (error) {
        // One environment that cannot be read loses only itself: its text stays when it has any.
        ctx.notes.push(`The ${name} here could not be read (${error.message}).`);
        if (!/^(tikzpicture|tabular|tabularx|array|longtable|axis)$/.test(name)) {
          try { blocks.push(...readBlocks(body, ctx, listLevel)); } catch { /* the note is enough */ }
        }
      }
      i = after;
      continue;
    }
    } catch (error) {
      // A command that cannot be read (a { never closed after \section) is kept as text.
      ctx.notes.push(`Something here could not be read (${error.message}): ${src.slice(i, i + 40).replace(/\s+/g, ' ')}`);
    }
    para += src[i];
    i += 1;
    // Commands with arguments that belong in the paragraph are read whole by inlineRuns.
  }
  flush();
  return blocks;
}

// The blocks of one \begin{name}...\end{name}.
function environment(name, body, ctx, listLevel) {
  if (DISPLAY_MATH.has(name)) {
    if (/^alignat/.test(name)) body = body.replace(/^\s*\{[^}]*\}/, '');
    return displayRows(body, ctx);
  }
  if (name in LISTS) return listBlocks(body, LISTS[name], ctx, listLevel);
  if (name === 'tabular' || name === 'tabularx' || name === 'array' || name === 'longtable') return [tableBlock(body, ctx)];
  if (name === 'tikzpicture') return tikzBlocks(body, ctx);
  if (name === 'verbatim' || name === 'lstlisting' || name === 'minted') {
    return [{ type: 'paragraph', runs: [{ text: body.replace(/^\s*(\[[^\]]*\]|\{[^}]*\})?\n?/, '').replace(/\n$/, '') }] }];
  }
  if (name === 'document') return readBlocks(body, ctx, listLevel);
  // The exam class: questions are headings, parts and choices are lists.
  if (name === 'questions') return questionBlocks(body, ctx, listLevel);
  if (EXAM_LISTS[name]) return examList(body, EXAM_LISTS[name], ctx, listLevel);
  // An exam's solutions are printed only with \printanswers: a student's copy has none.
  if (ctx.exam && /^(solution|solutionorbox|solutionorlines|solutionordottedlines|solutionorgrid)$/.test(name) && !ctx.printAnswers) return [];
  if (THEOREMS.test(name)) {
    // "Theorem (Name)." then its text, as in the printed document.
    const opt = optional(body, 0);
    const title = name.replace('*', '').replace(/^./, (c) => c.toUpperCase());
    const inner = readBlocks(opt ? body.slice(opt[1]) : body, ctx, listLevel);
    const label = { text: `${title}${opt ? ` (${opt[0]})` : ''}. `, bold: true };
    if (inner[0]?.type === 'paragraph') inner[0].runs.unshift(label); else inner.unshift({ type: 'paragraph', runs: [label] });
    return inner;
  }
  // center, figure, table, minipage, quote, abstract and the rest: their content.
  const inner = body.replace(/^\s*(\[[^\]]*\])?(\{[^}]*\})?/, (m) => (/^(minipage|tabular|multicols)/.test(name) ? '' : m));
  const out = name === 'abstract' ? [{ type: 'heading', level: 2 + ctx.headingShift, runs: [{ text: 'Abstract' }] }] : [];
  return [...out, ...readBlocks(inner, ctx, listLevel)];
}

// Commands that put a box around their last argument: how many arguments come before it
// (\parbox{width}{text}, \colorbox{colour}{text}, \fcolorbox{frame}{fill}{text}).
const BOXES = { fbox: 0, framebox: 0, mbox: 0, makebox: 0, parbox: 1, colorbox: 1, fcolorbox: 2, textcolor: 1 };
function boxContent(src, i, before) {
  for (let opt = optional(src, i); opt; opt = optional(src, i)) i = opt[1];
  for (let k = 0; k < before; k += 1) { const g = group(src, i); if (!g) return null; i = g[1]; }
  return group(src, i);
}

// \begin{questions}: \question[points] text, each a numbered heading.
function questionBlocks(body, ctx, listLevel) {
  const src = body.replace(/\\(bonusquestion|bonustitledquestion)(?![A-Za-z])/g, (m, n) => (n === 'bonusquestion' ? '\\question' : '\\titledquestion'))
    .replace(/\\titledquestion\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g, '\\question\x01$1\x02');
  const out = [];
  let n = 0;
  for (const part of splitTop(src, '\\question').slice(1)) {
    n += 1;
    let text = part;
    const title = /^\x01([^\x02]*)\x02/.exec(text);
    if (title) text = text.slice(title[0].length);
    const points = /^\s*\[\s*(\d+(?:\.\d+)?)\s*\]/.exec(text);
    if (points) text = text.slice(points[0].length);
    const words = `Question ${n}${title ? `: ${title[1].trim()}` : ''}${points ? ` (${points[1]} ${points[1] === '1' ? 'point' : 'points'})` : ''}`;
    out.push({ type: 'heading', level: Math.min(6, SECTIONS.section + ctx.headingShift), runs: [{ text: words }] }, ...readBlocks(text, ctx, listLevel));
  }
  return out;
}

// parts, subparts and choices: lists labelled as the exam class prints them.
const EXAM_LISTS = {
  parts: { item: 'part', label: (k) => `(${String.fromCharCode(97 + k)})` },
  subparts: { item: 'subpart', label: (k) => `${['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x'][k] || k + 1}.` },
  subsubparts: { item: 'subsubpart', label: (k) => `${String.fromCharCode(945 + k)}.` },
  choices: { item: 'choice', label: (k) => `${String.fromCharCode(65 + k)}.` },
  oneparchoices: { item: 'choice', label: (k) => `${String.fromCharCode(65 + k)}.` },
  checkboxes: { item: 'choice', label: (k) => `${String.fromCharCode(65 + k)}.` },
  oneparcheckboxes: { item: 'choice', label: (k) => `${String.fromCharCode(65 + k)}.` },
};
function examList(body, { item, label }, ctx, listLevel) {
  // \CorrectChoice is an ordinary choice on a student's copy (the exam class marks it only with answers).
  const src = body.replace(/\\CorrectChoice(?![A-Za-z])/g, '\\choice');
  const parts = splitTop(src, `\\${item}`);
  // \part[2] text: the points go after the label.
  const items = parts.slice(1).map((p, k) => {
    const points = /^\s*\[\s*(\d+(?:\.\d+)?)\s*\]/.exec(p);
    const rest = points ? p.slice(points[0].length) : p;
    return `\\item[${label(k)}${points ? ` (${points[1]} ${points[1] === '1' ? 'point' : 'points'})` : ''}]${rest}`;
  });
  return [...(parts[0].trim() ? readBlocks(parts[0], ctx, listLevel) : []), ...listBlocks(items.join(''), false, ctx, listLevel)];
}

function listBlocks(body, ordered, ctx, level) {
  // The items, and the pictures, tables and notes between them, in the document's order.
  const seq = [];
  const parts = splitTop(body, '\\item').slice(1);
  for (const part of parts) {
    let text = part;
    let label = null;
    const opt = optional(text, 0);
    if (opt && /^\s*\[/.test(text)) { label = opt[0]; text = text.slice(opt[1]); }
    const inner = readBlocks(text, ctx, level + 1);
    // An item's sentences and display equations stay in their order, each sentence on its own
    // line and each equation after the words before it ("We know that p(x) = ..."), until a
    // sub-list; its sub-lists keep their level, and words after a sub-list are a line below it.
    const runs = label ? [{ text: `${label} `, bold: !ordered }] : [];
    const item = { runs, level };
    seq.push(item);
    let current = item;
    for (const b of inner) {
      if (b.type === 'list') {
        seq.push(...b.items);
        current = { runs: [], level: level + 1, more: true };
        seq.push(current);
      } else if (!current) {
        seq.push({ block: b }); // words after a picture: below the picture, before the next item
      } else if (b.type === 'paragraph') {
        if (current.runs.length && !(current === item && label && current.runs.length === 1)) current.runs.push({ lineBreak: true });
        current.runs.push(...b.runs);
      } else if (b.type === 'equation') {
        if (current.runs.length) current.runs.push({ text: ' ' });
        current.runs.push({ latex: b.latex });
      } else {
        // A graph, table or note stays in its item, after the item's words: the list stops
        // there and goes on after it at the next number (start).
        seq.push({ block: b });
        current = null;
      }
    }
  }
  // The lists between those blocks. A list that goes on after a picture starts at its next
  // number; items that come back to a lower level than the list began at are a new list.
  const out = [];
  const count = [];
  let list = null;
  for (const e of seq) {
    if (e.block) { out.push(e.block); list = null; continue; }
    if (e.more && !e.runs.length) continue;
    count[e.level] = (count[e.level] || 0) + 1;
    count.length = e.level + 1;
    if (!list || e.level < list.items[0].level) {
      list = { type: 'list', ordered, items: [] };
      if (count[e.level] > 1) list.start = count[e.level];
      out.push(list);
    }
    list.items.push({ runs: e.runs, level: e.level });
  }
  return out.length ? out : [{ type: 'list', ordered, items: [] }];
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
  // In pgfplots maths 1e-9 is always a number in scientific notation.
  s = s.replace(/(^|[^A-Za-z\d.])(\d*\.?\d+)[eE]([+-]?\d+)(?![\d.])/g, '$1($2*10^($3))');
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
// -pi, 2*pi and pi/2 too (domain=-pi:pi).
const num = (v) => tikzNumber(v);

// A shaded area (how a page shows an integral), in words for the graph's description.
function shadeWords(shades) {
  if (!shades.length) return '';
  const range = (s) => (s.lo !== null && s.hi !== null ? ` from x = ${spoken(s.lo)} to ${spoken(s.hi)}` : '');
  return ` Shaded: ${shades.map((s) => `the area ${s.between ? 'between the two curves' : 'under the curve'}${range(s)}`).join('; ')}.`;
}

// Options with the file's own styles written out: [holdot] is [color=blue, fill=white, only marks, mark=*].
function withStyles(opts, ctx) {
  const styles = ctx.styles || {};
  let out = opts || '';
  for (let round = 0; round < 3; round += 1) out = splitTop(out, ',').map((p) => styles[p.trim()] ?? p).join(',');
  return out;
}
// A dot drawn open (white inside) or solid, from its options.
const isOpen = (opts) => /fill\s*=\s*(white|none)|mark\s*=\s*o\b|mark options\s*=\s*\{[^}]*fill\s*=\s*white|^\s*white\s*(,|$)/.test(opts);
// Arrowheads (<->, ->, -latex, {Stealth}-{Stealth}): which ends of the curve go on past the window.
function arrowEnds(opts) {
  for (const raw of splitTop(opts || '', ',')) {
    const t = raw.replace(/^\s*arrows\s*=\s*/, '').trim();
    const m = /^(\{?[A-Za-z<>|[\]]*\}?)-(\{?[A-Za-z<>|[\]]*\}?)$/.exec(t);
    if (m && !t.includes('=') && (m[1] || m[2])) return { left: Boolean(m[1]), right: Boolean(m[2]) };
  }
  return { left: false, right: false };
}
// A point in a pgfplots axis: (axis cs:-3,0) or (-3,0), its numbers as TikZ writes them.
const AXIS_POINT = /\(\s*(?:axis\s+cs\s*:)?\s*([^,()]+?)\s*,\s*([^,()]+?)\s*\)/g;
const axisPoints = (text) => [...text.matchAll(AXIS_POINT)].map((p) => [tikzNumber(p[1]), tikzNumber(p[2])]).filter((p) => p.every((v) => v !== null));

// A straight line drawn in a graph: a dashed vertical line is how a page shows an asymptote.
function lineWords({ pts, dashed }) {
  const kind = dashed ? 'dashed ' : '';
  if (pts.length === 2 && close(pts[0][0], pts[1][0])) return `${kind}vertical line at x = ${spoken(pts[0][0])}`;
  if (pts.length === 2 && close(pts[0][1], pts[1][1])) return `${kind}horizontal line at y = ${spoken(pts[0][1])}`;
  return `${kind}line through ${pts.map((p) => `${spoken(p[0])}, ${spoken(p[1])}`).join('; then ')}`;
}

function axisGraph(axisOpts, body, ctx) {
  const axis = keyValues(axisOpts);
  const sources = [];
  const points = [];
  const curves = [];
  const lines = []; // straight lines drawn with \draw or plotted through two points: { pts, dashed }
  const shades = [];
  const named = {}; // name path=f: which plot it is, for fill between
  const domainOf = (text) => { const d = (text || '').split(':').map(num); return d.length === 2 && d.every((v) => v !== null) ? d : null; };
  let domain = axis.domain ? axis.domain.split(':').map(num) : null;
  const re = /\\addplot\+?\s*(\[[^\]]*\])?\s*/g;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    const raw = withStyles(m[1] ? m[1].slice(1, -1) : '', ctx);
    const opts = keyValues(raw);
    let rest = body.slice(m.index + m[0].length);
    if (/^coordinates/.test(rest)) {
      const g = group(rest, 'coordinates'.length);
      const pts = [...g[0].matchAll(/\(\s*([^,()]+)\s*,\s*([^()]+?)\s*\)/g)].map((p) => [num(p[1]), num(p[2])]).filter((p) => p.every((v) => v !== null));
      // Marks only, or a single point (it cannot be a line): dots, open when white inside.
      if (/only marks/.test(raw) || pts.length === 1) for (const p of pts) points.push({ kind: isOpen(raw) ? 'open dot' : 'solid dot', coordinate: p });
      else if (pts.length === 2 && (/dash/.test(raw) || close(pts[0][0], pts[1][0]))) lines.push({ pts, dashed: /dash/.test(raw) });
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
      sources.push({ text: latex, format: 'latex', domain: [Math.min(...own), Math.max(...own)], arrows: arrowEnds(raw) });
    } catch (error) {
      ctx.notes.push(`A plotted function could not be read: ${g[0]} (${error.message})`);
    }
  }
  // Dots, dashed lines and other straight lines drawn with TikZ inside the axis.
  let unread = 0;
  for (const d of drawCommands(body)) {
    const raw = withStyles(d.opts, ctx);
    const pts = axisPoints(d.rest);
    if (!pts.length) { if (d.command !== 'node' && d.command !== 'path') unread += 1; continue; }
    if (/\bcircle\b/.test(d.rest) && d.command !== 'node') {
      // \fill[white, draw=blue] (axis cs:-3,0) circle[radius=3pt] is open; \fill[blue] is solid; \draw alone is open.
      const open = d.command === 'fill' ? /^\s*white\s*(,|$)|fill\s*=\s*white/.test(raw) : isOpen(raw) || (d.command === 'draw' && !/fill/.test(raw));
      points.push({ kind: open ? 'open dot' : 'solid dot', coordinate: pts[0] });
      continue;
    }
    if (d.command === 'node' || /\bnode\b/.test(d.rest)) {
      const content = /\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}\s*$/.exec(d.rest)?.[1] || '';
      const kind = /\\circ\b|\\ocircle/.test(content) ? 'open dot' : /bullet/.test(content) ? 'solid dot'
        : /circle/.test(raw) && !content.trim() ? (isOpen(raw) || !/fill/.test(raw) ? 'open dot' : 'solid dot') : null;
      if (kind) points.push({ kind, coordinate: pts[0] });
      continue; // otherwise a label
    }
    if (pts.length >= 2 && /--/.test(d.rest)) { lines.push({ pts, dashed: /dash|dotted/.test(raw) }); continue; }
    unread += 1;
  }
  if (unread) ctx.notes.push(`${unread} ${unread === 1 ? 'thing' : 'things'} drawn inside a pgfplots graph could not be read; check the graph against the page.`);
  const x = [num(axis.xmin), num(axis.xmax)];
  const y = [num(axis.ymin), num(axis.ymax)];
  // Without xmin and xmax the axis is as wide as what is plotted.
  const widest = sources.length ? [Math.min(...sources.map((src) => src.domain[0])), Math.max(...sources.map((src) => src.domain[1]))] : null;
  const xr = x.every((v) => v !== null) && x[0] < x[1] ? x : domain && domain.every((v) => v !== null) ? domain : widest;
  const yr = y.every((v) => v !== null) && y[0] < y[1] ? y : null;
  // A plot of 0 named only for fill between is the x-axis, not a function to describe.
  const drop = new Set(Object.values(named).filter((n) => n.drop).map((n) => n.index));
  // A plot drawn on only part of the axis is that function on that part. An arrowhead means
  // the curve goes on past that end; an open dot drawn at an end leaves that point out.
  const kept = sources.filter((_, i) => !drop.has(i)).map((src) => {
    const end = (v, side) => {
      if (src.arrows[side] || !xr || (side === 'left' ? v <= xr[0] + 1e-9 : v >= xr[1] - 1e-9)) return null;
      let yv = NaN;
      try { yv = compileFunction(src.text, 'latex').graph.yAt(v); } catch { /* the plain end */ }
      const dot = points.find((p) => close(p.coordinate[0], v) && Math.abs(p.coordinate[1] - yv) < 0.05 * (1 + Math.abs(yv)));
      return dot?.kind === 'open dot' ? '<' : '\\le';
    };
    const lo = end(src.domain[0], 'left'), hi = end(src.domain[1], 'right');
    if (!lo && !hi) return src;
    const condition = `${lo ? `${fmt(src.domain[0])} ${lo} ` : ''}x${hi ? ` ${hi} ${fmt(src.domain[1])}` : ''}`;
    return { ...src, text: `f(x) = \\begin{cases} ${src.text} & ${condition} \\end{cases}` };
  });
  if (!kept.length && !curves.length && !points.length && !lines.length) return null;
  const graph = kept.length ? makeGraph(kept, { x: xr, y: yr }) : {
    summary: `${[...curves.map((c) => c.label), ...lines.map(lineWords)].join('; ')}${points.length ? `${curves.length || lines.length ? '; ' : ''}${points.length} marked ${points.length === 1 ? 'point' : 'points'}` : ''}.`.replace(/^./, (c) => c.toUpperCase()),
    span: { x: xr || [-5, 5], y: yr || [-5, 5] }, functions: [], points: [],
  };
  // A plot simply stops at the end of its domain: pgfplots draws no dot there.
  for (const pt of graph.points || []) graph.summary = graph.summary.replace(`; ${pt.label}`, '').replace(`: ${pt.label}; `, ': ').replace(`: ${pt.label}.`, '.');
  graph.curves = [...(graph.curves || []), ...curves];
  graph.points = points;
  if (points.length && kept.length) graph.summary += ` Marked: ${points.map((p) => `${p.kind} at ${p.coordinate.map(spoken).join(', ')}`).join('; ')}.`;
  if (lines.length && kept.length) graph.summary += ` Also drawn: ${lines.map(lineWords).join('; ')}.`;
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
  const all = plots.map((p) => {
    const plain = pgfToPlain(p.expr);
    const fn = compileFunction(plain, 'plain').graph;
    return { ...p, plain, latex: latexOfPlain(plain), fn, lo: p.left ? -Infinity : snap(p.lo), hi: p.right ? Infinity : snap(p.hi) };
  }).sort((a, b) => a.lo - b.lo);
  // Plots side by side are the pieces of one function; plots of different formulas over the
  // same x (f and g on the same axes) are different functions, told apart by their labels
  // (node{$f(x)$}) when the page has them.
  const overlap = (a, b) => Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo) > 1e-6;
  const groups = [];
  for (const p of all) {
    let g = p.label ? groups.find((q) => q.label === p.label) : null;
    g ||= groups.find((q) => (!p.label || !q.label) && q.pieces.every((r) => r.plain === p.plain || !overlap(r, p)));
    if (!g) { g = { label: null, pieces: [] }; groups.push(g); }
    g.pieces.push(p);
    g.label ||= p.label;
  }
  const several = groups.length > 1;
  const built = groups.map((g, k) => {
    let pieces = g.pieces;
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
    // The page's own name for the curve: f(x), g(x), or a label such as $h$.
    const letter = /^\s*([A-Za-z])\s*(\(\s*x\s*\))?\s*$/.exec(g.label || '');
    const name = several ? (letter ? `${letter[1]}(x)` : 'y') : all.map((p) => p.label).find((l) => l && /f\s*\(\s*x\s*\)/.test(l)) ? 'f(x)' : 'y';
    const latex = rows.every((r) => r === null) && pieces.length === 1 ? `${name} = ${pieces[0].latex}`
      : `${name} = \\begin{cases} ${pieces.map((p, n) => rows[n] ?? `${p.latex} & \\text{otherwise}`).join(' \\\\ ')} \\end{cases}`;
    return { pieces, latex, spokenName: letter ? `${letter[1]}(x)` : g.label ? latexToPlain(g.label) : `Function ${k + 1}` };
  });
  const full = makeGraph(built.map((b) => ({ text: b.latex, format: 'latex' })), { x, y });
  // Where the drawing simply stops (a domain end with nothing drawn there) there is no dot:
  // the curve's start or end is said instead. Dots stay where they are drawn, and where two
  // pieces of the same function meet (a jump).
  const shared = (pieces, b) => pieces.some((p) => close(p.hi, b)) && pieces.some((p) => close(p.lo, b));
  const drawn = (pt) => dots.some((d) => d.kind === pt.kind && close(d.coordinate[0], pt.coordinate[0]) && Math.abs(d.coordinate[1] - pt.coordinate[1]) < 0.05);
  const dropped = full.points.filter((pt) => !(drawn(pt) || shared(built[pt.function ?? 0].pieces, pt.coordinate[0])));
  full.points = full.points.filter((pt) => !dropped.includes(pt));
  // Dots drawn in the picture that the pieces' own ends did not already make, each with the
  // function it sits on.
  const extra = dots.filter((d) => !full.points.some((p) => p.kind === d.kind && close(p.coordinate[0], d.coordinate[0]) && Math.abs(p.coordinate[1] - d.coordinate[1]) < 0.05));
  const owner = (d) => Math.max(0, built.findIndex((b) => b.pieces.some((p) => { const v = p.fn.limitAt(d.coordinate[0]); return (v.defined || v.hole) && Math.abs(v.y - d.coordinate[1]) < 0.05 * (1 + Math.abs(v.y)); })));
  full.points.push(...extra.map((d) => ({ ...d, function: owner(d), label: `${d.kind} at ${d.coordinate.join(', ')}` })));
  const graph = studentGraph({ ...full, student: { hideFormula: true, hide: [], drawn: true, names: several ? built.map((b) => b.spokenName) : undefined,
    note: several ? 'Drawn on the page; their formulas are not shown, as on paper.' : 'Drawn on the page; its formula is not shown, as on paper.' } });
  for (const pt of dropped) graph.summary = graph.summary.replace(`; ${pt.label}`, '').replace(`: ${pt.label}; `, ': ');
  if (extra.length) graph.summary += ` Also drawn: ${extra.map((d) => `${d.kind} at ${d.coordinate.join(', ')}`).join('; ')}.`;
  return graph;
}

function tikzBlocks(body, ctx) {
  // A box placed on the page itself ([remember picture, overlay]: the name and section box at
  // the top of a quiz) is page furniture, not a figure.
  if (/^\s*\[[^\]]*\b(remember picture|overlay)\b/.test(body)) return [];
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
    const inside = body.slice(opt ? opt[1] : start, end);
    const graph = axisGraph(opt ? opt[0] : '', inside, ctx);
    if (graph) { out.push({ type: 'graph', graph }); continue; }
    // An axis with nothing drawn on it is a grid to sketch on.
    const o = keyValues(opt ? opt[0] : '');
    const range = (a, b) => (num(o[a]) !== null && num(o[b]) !== null ? `${spoken(num(o[a]))} to ${spoken(num(o[b]))}` : null);
    if (!/\\(addplot|draw|fill|node|filldraw)\b/.test(inside)) {
      const xs = range('xmin', 'xmax'), ys = range('ymin', 'ymax');
      out.push({ type: 'paragraph', runs: [{ text: `An empty grid to draw on${xs ? `, x from ${xs}` : ''}${ys ? `, y from ${ys}` : ''}.` }] });
    } else out.push({ type: 'note', text: 'A pgfplots graph with nothing that could be read.' });
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

// The source without its % comments. A % inside \url{...}, \href{...}, \verb|...| or a verbatim
// environment is part of the text (http://a.b/50%off), so it stays.
function withoutComments(src) {
  let verbatim = null;
  return src.split('\n').map((line) => {
    if (verbatim) {
      if (line.includes(`\\end{${verbatim}}`)) verbatim = null;
      return line;
    }
    let depth = 0; // inside \url{ or \href{
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '\\') {
        const m = /^\\(url|href|verb\*?|begin\{(verbatim|lstlisting|minted)\})/.exec(line.slice(i));
        if (m?.[1].startsWith('verb')) { const end = line.indexOf(line[i + m[0].length], i + m[0].length + 1); i = end < 0 ? line.length : end; continue; }
        if (m?.[2]) { if (!line.includes(`\\end{${m[2]}}`, i)) verbatim = m[2]; return line; }
        if (m && line[i + m[0].length] === '{') { depth += 1; i += m[0].length; continue; }
        i += 1; // \% and other escapes
        continue;
      }
      if (depth && ch === '{') depth += 1;
      else if (depth && ch === '}') depth -= 1;
      else if (ch === '%' && !depth) return line.slice(0, i);
    }
    return line;
  }).join('\n');
}

// TikZ and pgfplots styles a file defines (\tikzset{holdot/.style={fill=white, ...}}): name -> options.
function tikzStyles(src) {
  const styles = {};
  const re = /([A-Za-z][\w ]*?)\s*\/\.style\s*=\s*\{/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    try {
      const g = group(src, m.index + m[0].length - 1);
      if (g) { styles[m[1].trim()] = g[0]; re.lastIndex = g[1]; }
    } catch { /* an unfinished style is left out */ }
  }
  return styles;
}

export function texToBlocks(source) {
  const notes = [];
  const ctx = { notes, unknown: new Set(), headingShift: 0 };
  const noComments = withoutComments(source.replace(/\r\n?/g, '\n'));
  const macros = collectMacros(noComments, notes);
  const begin = noComments.indexOf('\\begin{document}');
  const end = noComments.lastIndexOf('\\end{document}');
  const preamble = begin >= 0 ? noComments.slice(0, begin) : '';
  let body = begin >= 0 ? noComments.slice(begin + '\\begin{document}'.length, end >= 0 ? end : undefined) : noComments;
  ctx.exam = /\\documentclass\s*(\[[^\]]*\])?\s*\{exam\}/.test(preamble);
  ctx.printAnswers = /\\printanswers\b|\\documentclass\s*\[[^\]]*\banswers\b/.test(noComments);
  ctx.styles = tikzStyles(preamble + body);
  // cases* (mathtools) is cases with its second column in words: \text{if }x>0.
  body = body.replace(/\\begin\{cases\*\}([\s\S]*?)\\end\{cases\*\}/g, (_, rows) => `\\begin{cases}${rows.split('\\\\').map((row) => {
    const [expr, ...rest] = row.split(/(?<!\\)&/);
    if (!rest.length) return row;
    const words = rest.join('&').split('$').map((piece, k) => (k % 2 ? piece : piece.trim() ? `\\text{${piece.replace(/^\s+/, '').replace(/\s+$/, ' ')}}` : '')).join('');
    return `${expr}& ${words}`;
  }).join('\\\\')}\\end{cases}`);
  // The definitions themselves are not text.
  body = body.replace(/\\(?:re)?newcommand\*?\s*\{?\\(?:[A-Za-z@]+|[^A-Za-z@\s{}\\])\}?(\[\d\])?(\[[^\]]*\])?/g, '\\DROPDEF').replace(/\\DeclareMathOperator\*?\s*\{\\[A-Za-z]+\}/g, '\\DROPDEF');
  body = body.replace(/\\DROPDEF\s*\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}/g, '');
  body = expandMacros(body, macros);
  const titleOf = (name) => {
    const m = new RegExp(`\\\\${name}\\s*(\\[[^\\]]*\\])?\\s*\\{`).exec(preamble + body);
    try { return m ? group(preamble + body, m.index + m[0].length - 1)?.[0] : null; } catch { notes.push(`The \\${name} could not be read.`); return null; }
  };
  let title = titleOf('title');
  const author = titleOf('author');
  // Without \title, a large centred line at the very top is the title:
  // \textbf{\centerline{\Large Section 3.9 - Related Rates}}.
  if (!title) {
    const top = /^\s*(?:\\noindent\s*)?(\\textbf\s*\{\s*)?\\centerline\s*\{/.exec(body);
    const g = top && group(body, top[0].length - 1);
    if (g && /\\(?:Large|LARGE|huge|Huge)(?![A-Za-z])/.test(g[0])) {
      const close = top[1] ? /^\s*\}/.exec(body.slice(g[1])) : null;
      title = g[0];
      body = body.slice(g[1] + (close ? close[0].length : 0));
    }
  }
  // \title and \author are shown where \maketitle is (or at the top).
  body = body.replace(/\\(title|author|date)\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, '');
  ctx.headingShift = title ? 1 : 0; // the title is the only level-1 heading
  const blocks = [];
  if (title) blocks.push({ type: 'heading', level: 1, runs: inlineRuns(expandMacros(title, macros), {}, ctx) });
  if (author) blocks.push({ type: 'paragraph', runs: inlineRuns(expandMacros(author.replace(/\\and/g, ', '), macros), {}, ctx) });
  try {
    blocks.push(...readBlocks(body, ctx));
  } catch (error) {
    // Nothing above should let an error through; if one does, each paragraph is read on its own.
    notes.push(`Part of this file could not be read (${error.message}).`);
    for (const chunk of body.split(/\n[ \t]*\n/)) {
      try { blocks.push(...readBlocks(chunk, ctx)); } catch { blocks.push({ type: 'paragraph', runs: [{ text: chunk.replace(/\s+/g, ' ').trim() }] }); }
    }
  }
  for (const b of blocks) if (b.type === 'heading') b.level = Math.min(b.level, 6);
  if (ctx.unknown.size) notes.push(`These commands are not known to the notebook, so only their text was kept: ${[...ctx.unknown].map((n) => `\\${n}`).join(', ')}.`);
  return { title: title ? inlineRuns(expandMacros(title, macros), {}, ctx).map((r) => r.text ?? (r.lineBreak ? ' ' : '')).join('').replace(/\s+/g, ' ').trim() : null, blocks, notes };
}
