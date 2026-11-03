// Turns the reader's Markdown + LaTeX into accessible HTML.
// Math becomes MathML (read by MathCAT in NVDA); all other text goes in as plain
// text, never as HTML, so nothing in a document can run as code.
import temml from './vendor/temml.mjs';

const PROBLEM = /^(\d{1,3})\.\s+(.*)$/;
const EXAMPLE = /^\*{0,2}(Example\s+\d+[a-z]?)\s*[:.]?\*{0,2}\s*(.*)$/i;
// The model sometimes adds attributes: [FIGURE type=graph description="..."].
const FIGURE = /^\s*\[FIGURE(?:\s+type="?([a-z_]+)"?)?([^\]]*)\]\s*(.*)$/i;
const FIGURE_NAMES = {
  coordinate_graph: 'graph', table: 'table', diagram: 'diagram', number_line: 'number line', other: 'picture',
};

export function parseBlocks(markdown) {
  const lines = markdown.replace(/\r/g, '').split('\n');
  const blocks = [];
  let i = 0;
  const push = (block) => blocks.push(block);
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (!t || /^```/.test(t) || /^(---+|\*\*\*+)$/.test(t)) { i += 1; continue; }
    let m;
    if ((m = FIGURE.exec(line))) {
      const start = i;
      const attr = /description="([^"]*)"/i.exec(m[2] || '');
      const body = [attr?.[1], m[3]].filter(Boolean);
      i += 1;
      while (i < lines.length && lines[i].trim()) { body.push(lines[i]); i += 1; }
      push({ type: 'figure', kind: (m[1] || 'other').toLowerCase(), lines: body, start, end: i - 1 });
      continue;
    }
    if (t.startsWith('$$') || t.startsWith('\\[')) {
      const close = t.startsWith('$$') ? '$$' : '\\]';
      const start = i; let tex = t.slice(2);
      if (tex.trim().endsWith(close) && tex.trim().length >= close.length) {
        tex = tex.trim().slice(0, -close.length);
      } else {
        i += 1;
        while (i < lines.length && !lines[i].trim().endsWith(close)) { tex += '\n' + lines[i]; i += 1; }
        if (i < lines.length) tex += '\n' + lines[i].trim().slice(0, -close.length);
      }
      push({ type: 'display', tex: tex.trim(), start, end: i });
      i += 1; continue;
    }
    if ((m = /^(#{1,6})\s+(.*)$/.exec(t))) { push({ type: 'heading', text: m[2], start: i, end: i }); i += 1; continue; }
    if (/^\|.*\|$/.test(t)) {
      const start = i; const rows = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) { rows.push(lines[i].trim()); i += 1; }
      push({ type: 'table', rows, start, end: i - 1 });
      continue;
    }
    if (line.search(/\S/) < 2 && (m = PROBLEM.exec(t))) {
      push({ type: 'problem', number: m[1], start: i, end: i });
      if (m[2].trim()) push({ type: 'paragraph', text: m[2], start: i, end: i });
      i += 1; continue;
    }
    if ((m = EXAMPLE.exec(t)) && /^\*{0,2}Example/i.test(t)) {
      push({ type: 'example', label: m[1], start: i, end: i });
      if (m[2].trim()) push({ type: 'paragraph', text: m[2].replace(/^\*+\s*/, ''), start: i, end: i });
      i += 1; continue;
    }
    // A paragraph runs until a blank line or another kind of block.
    const start = i; const text = [t]; i += 1;
    while (i < lines.length) {
      const next = lines[i].trim();
      if (!next || FIGURE.test(next) || next.startsWith('$$') || next.startsWith('\\[') || /^#{1,6}\s/.test(next) ||
          /^\|.*\|$/.test(next) || (lines[i].search(/\S/) < 2 && PROBLEM.test(next)) || /^\*{0,2}Example\s+\d/i.test(next) ||
          /^\([a-z]\)/i.test(next)) break;
      text.push(next); i += 1;
    }
    push({ type: 'paragraph', text: text.join(' '), start, end: i - 1 });
  }
  return blocks;
}

export function mathElement(tex, display) {
  const holder = document.createElement(display ? 'div' : 'span');
  holder.className = display ? 'math-display' : 'math-inline';
  try {
    temml.render(tex, holder, { displayMode: display, annotate: true, throwOnError: true });
  } catch {
    // Show the source rather than guessing at a picture of it.
    holder.textContent = tex;
    holder.classList.add('math-error');
    holder.setAttribute('title', 'This math could not be displayed; its LaTeX source is shown.');
  }
  return holder;
}

// Inline pieces: $math$, \(math\) and **bold**.
export function inline(text, parent) {
  const pattern = /\$([^$]+)\$|\\\((.+?)\\\)|\*\*(.+?)\*\*/g;
  let pos = 0; let m;
  while ((m = pattern.exec(text))) {
    if (m.index > pos) parent.append(text.slice(pos, m.index));
    if (m[3] !== undefined) {
      const strong = document.createElement('strong');
      inline(m[3], strong);
      parent.append(strong);
    } else {
      parent.append(mathElement(m[1] ?? m[2], false));
    }
    pos = m.index + m[0].length;
  }
  if (pos < text.length) parent.append(text.slice(pos));
  return parent;
}

// Same rule as checker.table_cells: '| 1 | 3 |', '1 3 2', '1, 3, 2' or 'Row 2: 1, 3, 2'.
const CELL = /^(?:[-−]?\d+(?:\.\d+)?|[A-Za-z]'*\([a-z]\)|[a-z]|\$[^$]+\$)$/;
export function tableCells(line) {
  const trimmed = line.trim();
  if (/^\|.*\|$/.test(trimmed)) {
    return /^\|[\s:|-]+\|$/.test(trimmed) ? null : trimmed.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  }
  const body = trimmed.replace(/^row\s*\d+\s*:\s*/i, '');
  const cells = body.split(/\s*[|,]\s*|\s+/).filter(Boolean);
  return cells.length >= 3 && cells.filter((c) => CELL.test(c)).length >= 0.8 * cells.length ? cells : null;
}

function tableElement(rows) {
  const table = document.createElement('table');
  rows.map(tableCells).filter(Boolean).forEach((cells, n) => {
    const tr = document.createElement('tr');
    for (const cell of cells) {
      const td = document.createElement(n === 0 ? 'th' : 'td');
      if (n === 0) td.scope = 'col';
      inline(cell, td);
      tr.append(td);
    }
    table.append(tr);
  });
  return table;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function figureElement(block, figure, docId, pageNumber) {
  const name = FIGURE_NAMES[block.kind] || 'picture';
  const box = el('div', 'figure');
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', `Figure: ${name}`);
  box.append(el('h5', '', `Figure: ${name}`));
  const isRow = (l) => tableCells(l) !== null || /^\|[\s:|-]+\|$/.test(l.trim());
  const tableRows = block.lines.filter((l) => tableCells(l) !== null);
  if (tableRows.length >= 2) box.append(tableElement(tableRows));
  const description = figure?.numbers?.status === 'exact' ? '' : figure?.description || block.lines.filter((l) => !isRow(l)).join('\n');
  if (description.trim()) {
    const label = el('p', 'unverified');
    label.append(el('strong', '', 'AI description, may be wrong. '));
    box.append(label);
    for (const line of description.split('\n').map((l) => l.trim()).filter(Boolean)) {
      box.append(inline(line.replace(/^[-*]\s+/, ''), el('p')));
    }
  }
  const numbers = figure?.numbers;
  if (numbers?.status === 'exact') {
    box.append(el('p', 'numbers-note', numbers.message));
    // One sentence per paragraph so each can be read and reread on its own.
    for (const sentence of numbers.summary.split(/(?<=\.)\s+(?=[A-Z])/)) box.append(el('p', '', sentence));
  } else if (numbers) {
    box.append(el('p', 'numbers-note', numbers.message));
    if (numbers.equations?.length) {
      const list = el('ul');
      for (const eq of numbers.equations) list.append(el('li', '', `Estimated curve: ${eq.replace(/\*/g, ' ')}`));
      box.append(list);
    }
    if (numbers.points?.length) {
      box.append(el('p', '', `Marked points, estimated: ${numbers.points.map(([x, y]) => `(${x}, ${y})`).join(', ')}.`));
    }
  }
  if (figure?.picture) {
    const details = el('details');
    details.append(el('summary', '', `Show the ${name} picture (for sighted helpers)`));
    const img = el('img');
    img.src = `/api/doc/${docId}/image/${figure.picture}`;
    img.alt = `The ${name} as printed on page ${pageNumber}.`;
    details.append(img);
    box.append(details);
  }
  return box;
}

function answerBox(docId, page, label) {
  const id = `answer-${page}-${label.replace(/\W+/g, '-')}`;
  const wrap = el('div', 'answer');
  const lab = el('label', '', `Your answer to ${label}`);
  lab.htmlFor = id;
  const area = el('textarea');
  area.id = id;
  area.rows = 3;
  area.spellcheck = false;
  const key = `notebook:${docId}:${page}:${label}`;
  try { area.value = localStorage.getItem(key) || ''; } catch { /* storage blocked */ }
  area.addEventListener('input', () => { try { localStorage.setItem(key, area.value); } catch { /* storage blocked */ } });
  wrap.append(lab, area);
  return wrap;
}

export function renderPage(record, docId) {
  const section = el('section', 'page');
  const titleId = `page-${record.page}-title`;
  section.setAttribute('aria-labelledby', titleId);
  const title = el('h3', '', `Page ${record.page}`);
  title.id = titleId;
  title.tabIndex = -1;
  section.append(title);

  const check = record.check || {};
  const flags = check.flags || [];
  const summary = !check.checked
    ? 'This page has no built-in text, so it could not be checked.'
    : flags.length === 0
      ? 'Checked against the PDF’s own text: no differences found.'
      : `Checked against the PDF’s own text: ${flags.length} ${flags.length === 1 ? 'place' : 'places'} to check, marked “Check”.`;
  section.append(el('p', 'page-check', summary));

  const blocks = parseBlocks(record.markdown || '');
  const figures = new Map((record.figures || []).map((f) => [f.line, f]));
  const placed = new Set();
  let openProblem = null;
  const closeProblem = () => {
    if (openProblem) section.append(answerBox(docId, record.page, openProblem));
    openProblem = null;
  };
  for (const block of blocks) {
    if (block.type === 'problem' || block.type === 'example' || block.type === 'heading') closeProblem();
    if (block.type === 'problem') {
      section.append(el('h4', '', `Problem ${block.number}`));
      openProblem = `problem ${block.number}`;
    } else if (block.type === 'example') {
      section.append(el('h4', '', block.label));
      openProblem = block.label.toLowerCase();
    } else if (block.type === 'heading') {
      section.append(inline(block.text, el('h4')));
    } else if (block.type === 'display') {
      section.append(mathElement(block.tex, true));
    } else if (block.type === 'table') {
      section.append(tableElement(block.rows));
    } else if (block.type === 'figure') {
      section.append(figureElement(block, figures.get(block.start), docId, record.page));
    } else {
      section.append(inline(block.text, el('p')));
    }
    for (const flag of flags.filter((f) => !placed.has(f) && f.line >= block.start && f.line <= block.end)) {
      placed.add(flag);
      const note = el('p', 'check');
      note.append(el('strong', '', 'Check: '), flag.message);
      section.append(note);
    }
  }
  closeProblem();
  for (const figure of (record.figures || []).filter((f) => f.unmentioned)) {
    const box = figureElement({ kind: 'coordinate_graph', lines: [] }, figure, docId, record.page);
    box.querySelector('h5').textContent = 'Graph found on this page (the reader did not mention it)';
    section.append(box);
  }
  // A difference on a line that is not shown (for example a code fence) still gets reported.
  for (const flag of flags.filter((f) => !placed.has(f))) {
    const note = el('p', 'check');
    note.append(el('strong', '', 'Check: '), flag.message);
    section.append(note);
  }

  const details = el('details', 'page-picture');
  details.append(el('summary', '', `Show page ${record.page} as printed (for sighted helpers)`));
  const img = el('img');
  img.src = `/api/doc/${docId}/image/${record.page}.png`;
  img.alt = `Page ${record.page} as printed.`;
  img.loading = 'lazy';
  details.append(img);
  section.append(details);
  return section;
}
