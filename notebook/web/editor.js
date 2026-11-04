// Math Notebook editor: one editable document, like a word processor. Commands come
// from the desktop app's menu bar (Alt), so the page itself has no buttons.
import temml from './vendor/temml.mjs';
import { parseBlocks, tableCells } from './markdown.js';
import { plainToLatex, latexToPlain } from './equation.js';
import { mathmlToLatex, latexToMathml } from './mathml.js';
import { makeDocx } from './docx.js';
import { makeGraph, studentGraph, HIDEABLE } from './graphs.js';
import { texToBlocks, graphFromPgfplots, graphToPgfplots } from './tex.js';
import { GraphMode } from './graph-mode.js';

const $ = (id) => document.getElementById(id);
const doc = $('doc');
const desktop = window.notebook || null; // the Electron bridge; absent in a plain browser
const graphs = new Map();
let filePath = null;
let docName = 'Untitled';
let dirty = false;
let importing = null;

// ---------- small helpers ----------

function say(text) {
  $('status').textContent = '';
  setTimeout(() => { $('status').textContent = text; }, 30);
}
function setDirty(value) {
  dirty = value;
  showMode(); // the title: name, unsaved star, Teacher mode
}
function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (k === 'class') node.className = v; else node.setAttribute(k, v);
  }
  if (text !== undefined) node.textContent = text;
  return node;
}
const newId = () => Math.random().toString(36).slice(2, 10);

// ---------- equations ----------

export function mathSpan(latex, display = false) {
  const span = el('span', { class: 'eq', contenteditable: 'false', 'data-latex': latex });
  if (display) span.dataset.display = 'true';
  try {
    temml.render(latex, span, { displayMode: display, annotate: true, throwOnError: true });
  } catch {
    span.textContent = latex;
    span.classList.add('math-error');
  }
  return span;
}

function equationLine(latex) {
  const p = el('p', { class: 'eq-line' });
  p.append(mathSpan(latex, true));
  return p;
}

// Inline Markdown pieces: $math$, \(math\), **bold**. Text goes in as text only.
function inlineInto(parent, text) {
  const pattern = /\$([^$]+)\$|\\\((.+?)\\\)|\*\*(.+?)\*\*/g;
  let pos = 0;
  let m;
  while ((m = pattern.exec(text))) {
    if (m.index > pos) parent.append(text.slice(pos, m.index));
    if (m[3] !== undefined) parent.append(inlineInto(el('strong'), m[3]));
    else parent.append(mathSpan(m[1] ?? m[2]));
    pos = m.index + m[0].length;
  }
  if (pos < text.length) parent.append(text.slice(pos));
  return parent;
}

// ---------- turning a read PDF page into document blocks ----------

function graphLine(graph, prefix = 'Graph') {
  const id = newId();
  graphs.set(id, graph);
  const p = el('p', { class: 'graph-line', 'data-graph-id': id });
  p.textContent = `${prefix}: ${graph.summary || 'no description.'} Press Enter to explore it by sound.`;
  return p;
}

function figureBlocks(block, figure) {
  const out = [];
  const rows = block.lines.filter((l) => tableCells(l));
  if (rows.length >= 2) out.push(tableBlock(rows));
  const numbers = figure?.numbers;
  if (numbers?.status === 'exact') {
    const g = numbers.graph;
    out.push(graphLine({ summary: numbers.summary, span: g.axis_span, curves: g.curves, points: g.points }));
    return out;
  }
  const description = figure?.description || block.lines.filter((l) => !tableCells(l) && !/^\|[\s:|-]+\|$/.test(l.trim())).join(' ');
  if (numbers?.status === 'estimated' && numbers.equations?.length) {
    const span = numbers.axis_span || {};
    out.push(graphLine({
      summary: `${numbers.message} ${numbers.summary || ''}`.trim(),
      span: { x: span.x || [-5, 5], y: span.y || [-5, 5] },
      equations: numbers.equations,
    }, 'Graph, estimated'));
  }
  // A table's own one-line summary ("A table with 3 rows") adds nothing once the table is shown.
  const text = description.replace(/\s+/g, ' ').trim();
  if (text && !(rows.length && /^a table/i.test(text))) {
    out.push(el('p', { class: 'figure-line' }, `Picture, AI description that may be wrong: ${text}`));
  } else if (!out.length) {
    out.push(el('p', { class: 'figure-line' }, `Picture: ${figure?.skipped || 'no description could be made.'}`));
  }
  return out;
}

// A picture still waiting for its description keeps its place in the document.
function waitingFigure(docId, page, figure, number) {
  const text = `Picture ${number} on page ${page}: its description is on the way; this line will be replaced.`;
  return el('p', { class: 'figure-line waiting', 'data-figure': `${docId}:${page}:${figure.line}` }, text);
}

function tableBlock(rows) {
  const table = el('table');
  rows.map(tableCells).filter(Boolean).forEach((cells, n) => {
    const tr = el('tr');
    for (const cell of cells) tr.append(inlineInto(el(n === 0 ? 'th' : 'td', n === 0 ? { scope: 'col' } : {}), cell));
    table.append(tr);
  });
  return table;
}

function pageBlocks(record, docId) {
  const heading = el('h2', { 'data-page': record.page }, `Page ${record.page}`);
  if (record.check && record.check.checked === false) {
    // A scanned or picture-only page: nothing in the PDF to compare the AI's copy with.
    heading.classList.add('warned');
    heading.dataset.warning = JSON.stringify(['This page has no text in the PDF to check against, so the AI copy of it was not checked. Listen to it carefully.']);
  } else if (record.check?.math_checked === false) {
    // Textbooks such as OpenStax draw formulas as shapes: the words were checked, the maths could not be.
    heading.classList.add('warned');
    heading.dataset.warning = JSON.stringify(['The equations on this page are drawn as pictures in the PDF, so only the words were checked. Listen to the equations carefully.']);
  }
  const out = [heading];
  const figures = new Map((record.figures || []).map((f) => [f.line, f]));
  const flags = record.check?.flags || [];
  let answerFor = null;
  let pictures = 0;
  const closeAnswer = () => {
    if (answerFor) {
      const p = el('p', { class: 'answer', 'data-placeholder': `Your answer to ${answerFor}` });
      p.append(el('br'));
      out.push(p);
    }
    answerFor = null;
  };
  for (const block of parseBlocks(record.markdown || '')) {
    let made = [];
    if (block.type === 'problem' || block.type === 'example' || block.type === 'heading') closeAnswer();
    if (block.type === 'problem') { made = [el('h3', {}, `Problem ${block.number}`)]; answerFor = `problem ${block.number}`; }
    else if (block.type === 'example') { made = [el('h3', {}, block.label)]; answerFor = block.label.toLowerCase(); }
    else if (block.type === 'heading') made = [inlineInto(el('h3'), block.text)];
    else if (block.type === 'display') made = [equationLine(block.tex)];
    else if (block.type === 'table') made = [tableBlock(block.rows)];
    else if (block.type === 'figure') {
      const figure = figures.get(block.start);
      pictures += 1;
      made = figure?.pending ? [waitingFigure(docId, record.page, figure, pictures)] : figureBlocks(block, figure);
    }
    else made = [inlineInto(el('p'), block.text)];
    // Differences the checker found become review notes on the blocks they belong to.
    const notes = flags.filter((f) => f.line >= block.start && f.line <= block.end).map((f) => f.message);
    if (notes.length && made[0]) {
      made[0].classList.add('warned');
      made[0].dataset.warning = JSON.stringify(notes);
    }
    out.push(...made);
  }
  closeAnswer();
  for (const figure of (record.figures || []).filter((f) => f.unmentioned && f.numbers?.graph)) {
    const g = figure.numbers.graph;
    out.push(graphLine({ summary: figure.numbers.summary, span: g.axis_span, curves: g.curves, points: g.points }, 'Graph the reader did not mention'));
  }
  return out;
}

// ---------- importing a PDF ----------

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `The reader answered ${response.status}.`);
  return body;
}

async function importPdf(path) {
  if (!path) return;
  if (importing) { say('A PDF is already being converted. Wait for it to finish.'); return; }
  try {
    const answer = await api('/api/open-path', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) });
    if (answer.notebook) { openAttachedNotebook(answer.notebook, answer.name); return; }
    const { meta } = answer;
    if (isEmpty()) {
      docName = meta.name.replace(/\.pdf$/i, '');
      doc.replaceChildren(el('h1', {}, docName));
      setDirty(true);
    }
    importing = { id: meta.id, next: 1, total: meta.pages, name: meta.name };
    say(`Converting ${meta.name}, ${meta.pages} ${meta.pages === 1 ? 'page' : 'pages'}. Pages are added at the end as they finish; you can keep working.`);
    pollImport();
  } catch (error) {
    say(`Could not open the PDF: ${error.message}`);
  }
}

// A PDF exported by this notebook has the document inside it: open that, exactly as written
// (equations, graphs with their sound, teacher marks) instead of reading the printed page.
function openAttachedNotebook(text, name) {
  if (isEmpty()) {
    loadNotebook(text, null);
    setDirty(true);
  } else {
    const data = JSON.parse(text);
    if (data.format !== 'math-notebook') throw new Error('The attached file is not a Math Notebook document.');
    const holder = el('div');
    holder.append(...cleanNodes(data.html || ''));
    // Graph ids are made new, so they never clash with this document's graphs.
    for (const line of holder.querySelectorAll('[data-graph-id]')) {
      const graph = data.graphs?.[line.dataset.graphId];
      const id = newId();
      if (graph) graphs.set(id, graph);
      line.dataset.graphId = id;
    }
    doc.append(...holder.childNodes);
    setDirty(true);
  }
  say(`${name} was made with Math Notebook, so the document inside it was opened exactly as written, with no reading of the page.`);
}

async function pollImport() {
  const job = importing;
  if (!job) return;
  let data;
  try {
    data = await api(`/api/doc/${job.id}`);
  } catch (error) {
    say(`The reader stopped answering: ${error.message}`);
    importing = null;
    return;
  }
  const ready = new Map(data.pages.map((p) => [p.page, p]));
  while (ready.has(job.next)) {
    for (const node of pageBlocks(ready.get(job.next), job.id)) doc.append(node);
    if (job.next === 1) say('Page 1 is in the document. Press F8 to go to the first review note.');
    job.next += 1;
    setDirty(true);
  }
  const status = data.status || {};
  const errors = status.errors || {};
  if (errors.document) {
    say(`${job.name} could not be read: ${errors.document}`);
    importing = null;
    return;
  }
  // A page that failed is noted in the document and skipped so later pages still arrive.
  while (errors[job.next] && !ready.has(job.next)) {
    const p = el('p', { class: 'warned', 'data-warning': JSON.stringify([`Page ${job.next} could not be read: ${errors[job.next]}`]) }, `Page ${job.next} could not be converted.`);
    doc.append(el('h2', { 'data-page': job.next }, `Page ${job.next}`), p);
    job.next += 1;
  }
  fillWaitingFigures(job.id, ready);
  if (job.next > job.total) {
    const waiting = doc.querySelectorAll(`[data-figure^="${job.id}:"]`).length;
    const notes = doc.querySelectorAll('[data-warning]').length;
    say(`${job.name} is converted. ${notes ? `${notes} review ${notes === 1 ? 'note' : 'notes'}; F8 goes to the next one.` : 'No review notes.'}`
      + (waiting ? ` ${waiting} ${waiting === 1 ? 'picture is' : 'pictures are'} still being described; their places are marked.` : ''));
    importing = null; // another PDF can be imported while the pictures are described
    if (waiting) pollPictures(job);
    return;
  }
  setTimeout(pollImport, 1500);
}

// After a PDF's pages are in, its waiting pictures are filled in as their descriptions arrive.
async function pollPictures(job) {
  let data;
  try {
    data = await api(`/api/doc/${job.id}`);
  } catch {
    return; // the places stay marked; nothing else is lost
  }
  const filled = fillWaitingFigures(job.id, new Map(data.pages.map((p) => [p.page, p])));
  const waiting = doc.querySelectorAll(`[data-figure^="${job.id}:"]`).length;
  if (filled) say(waiting ? `${filled} more ${filled === 1 ? 'picture' : 'pictures'} described in ${job.name}.` : `All pictures in ${job.name} are described.`);
  // The picture queue being empty twice in a row means nothing more will arrive.
  job.idle = data.status?.figures_waiting ? 0 : (job.idle || 0) + 1;
  if (!waiting) return;
  if (job.idle >= 2) { say(`${waiting} ${waiting === 1 ? 'picture' : 'pictures'} in ${job.name} could not be described.`); return; }
  setTimeout(() => pollPictures(job), 1500);
}

// Replace each waiting picture whose description has arrived. If the person typed into
// the waiting line, it is kept and the description goes right after it.
function fillWaitingFigures(docId, ready) {
  let filled = 0;
  for (const holder of doc.querySelectorAll(`[data-figure^="${docId}:"]`)) {
    const [, page, line] = holder.dataset.figure.split(':');
    const figure = ready.get(Number(page))?.figures?.find((f) => f.line === Number(line));
    if (!figure || figure.pending) continue;
    const nodes = figureBlocks({ lines: [] }, figure);
    if (holder.textContent.includes('its description is on the way')) holder.replaceWith(...nodes);
    else { holder.removeAttribute('data-figure'); holder.classList.remove('waiting'); holder.after(...nodes); }
    filled += 1;
    setDirty(true);
  }
  return filled;
}

// ---------- the document as a file ----------

function isEmpty() {
  return !doc.textContent.trim() && !doc.querySelector('.eq, .graph-line');
}

function serialize() {
  const used = new Set([...doc.querySelectorAll('[data-graph-id]')].map((n) => n.dataset.graphId));
  if (studentView) {
    // Saving while previewing saves the teacher's document, not what students get.
    const keep = studentView.graphs;
    const ids = new Set([...studentView.html.matchAll(/data-graph-id="([^"]+)"/g)].map((m) => m[1]));
    return JSON.stringify({ format: 'math-notebook', version: 1, name: docName, teacher: true, html: studentView.html,
      graphs: Object.fromEntries([...keep].filter(([id]) => ids.has(id))) });
  }
  return JSON.stringify({
    format: 'math-notebook', version: 1, name: docName, teacher: teacherMode || undefined,
    html: doc.innerHTML,
    graphs: Object.fromEntries([...graphs].filter(([id]) => used.has(id))),
  });
}

const ALLOWED_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'P', 'DIV', 'SPAN', 'STRONG', 'EM', 'B', 'I', 'U', 'BR', 'HR', 'TABLE', 'TBODY', 'THEAD', 'TR', 'TH', 'TD', 'UL', 'OL', 'LI']);
const ALLOWED_ATTRS = new Set(['class', 'data-latex', 'data-display', 'data-graph-id', 'data-warning', 'data-page', 'data-placeholder', 'data-figure', 'scope',
  'data-teacher', 'data-student-note']);
// Pasted from web pages and other programs: only the structure is kept, never their styles or classes.
const PASTE_ATTRS = new Set(['scope']);

// Rebuild HTML from an allow-list, so a notebook file or a paste can never run code.
// MathML in it (pasted from a web page) becomes a real equation.
function cleanNodes(html, attrs = ALLOWED_ATTRS) {
  const template = document.createElement('template');
  template.innerHTML = html;
  const clean = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent);
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    if (node.classList.contains('eq') && node.dataset.latex) return mathSpan(node.dataset.latex, node.dataset.display === 'true');
    if (node.localName === 'math') {
      try {
        return mathSpan(mathmlToLatex(node.outerHTML), node.getAttribute('display') === 'block');
      } catch {
        return document.createTextNode(node.textContent);
      }
    }
    if (['SCRIPT', 'STYLE', 'TEMPLATE', 'TITLE', 'META', 'LINK'].includes(node.tagName)) return null;
    // A line on a web page is not a page break; only the notebook's own page breaks are kept.
    if (node.tagName === 'HR' && !node.classList.contains('page-break')) return null;
    if (!ALLOWED_TAGS.has(node.tagName)) {
      const frag = document.createDocumentFragment();
      for (const child of node.childNodes) { const c = clean(child); if (c) frag.append(c); }
      return frag;
    }
    const copy = document.createElement(node.tagName);
    for (const attr of node.attributes) if (attrs.has(attr.name)) copy.setAttribute(attr.name, attr.value);
    if (node.tagName === 'HR') copy.className = 'page-break';
    for (const child of node.childNodes) { const c = clean(child); if (c) copy.append(c); }
    return copy;
  };
  return [...template.content.childNodes].map(clean).filter(Boolean);
}

function sanitizeInto(target, html) {
  target.replaceChildren(...cleanNodes(html));
}

function loadNotebook(text, path) {
  const data = JSON.parse(text);
  if (data.format !== 'math-notebook') throw new Error('This is not a Math Notebook file.');
  graphs.clear();
  for (const [id, g] of Object.entries(data.graphs || {})) graphs.set(id, g);
  if (studentView) togglePreview(false);
  sanitizeInto(doc, data.html || '');
  setTeacherMode(Boolean(data.teacher), true);
  docName = data.name || 'Untitled';
  filePath = path;
  setDirty(false);
  doc.focus();
  say(`Opened ${docName}.`);
}

async function save(as = false) {
  if (!desktop) { say('Saving needs the desktop app.'); return; }
  const saved = await desktop.save({ path: as ? null : filePath, name: `${docName}.mathnb`, content: serialize() });
  if (!saved) return;
  filePath = saved;
  docName = saved.split(/[\\/]/).pop().replace(/\.mathnb$/i, '');
  setDirty(false);
  say(`Saved ${docName}.`);
}

function exportHtml() {
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${docName.replace(/[<&]/g, '')}</title></head><body>${doc.innerHTML}</body></html>`;
  desktop?.save({ path: null, name: `${docName}.html`, content: page, filters: [{ name: 'Web page', extensions: ['html'] }] })
    .then((p) => p && say(`Exported ${p.split(/[\\/]/).pop()}. Word can open this file.`));
}

// ---------- blocks (from a .tex file) as the document ----------

function runsInto(parent, runs) {
  for (const r of runs || []) {
    if (r.lineBreak) { parent.append(el('br')); continue; }
    if (r.latex !== undefined) { parent.append(mathSpan(r.latex)); continue; }
    let node = document.createTextNode(r.text);
    for (const [flag, tag] of [['underline', 'u'], ['italic', 'i'], ['bold', 'b']]) if (r[flag]) { const w = el(tag); w.append(node); node = w; }
    parent.append(node);
  }
  return parent;
}

function blocksToNodes(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.type === 'heading') out.push(runsInto(el(`h${Math.min(b.level, 4)}`), b.runs));
    else if (b.type === 'equation') out.push(equationLine(b.latex));
    else if (b.type === 'pageBreak') out.push(el('hr', { class: 'page-break' }));
    else if (b.type === 'graph') out.push(graphLine(b.graph));
    else if (b.type === 'note') out.push(el('p', { class: 'figure-line' }, b.text));
    else if (b.type === 'table') {
      const table = el('table');
      b.rows.forEach((cells, n) => {
        const tr = el('tr');
        for (const runs of cells) tr.append(runsInto(el(n === 0 && b.header ? 'th' : 'td', n === 0 && b.header ? { scope: 'col' } : {}), runs));
        table.append(tr);
      });
      out.push(table);
    } else if (b.type === 'list') {
      // Items carry their level; nested levels become lists inside the item above.
      const root = el(b.ordered ? 'ol' : 'ul');
      const stack = [root];
      for (const item of b.items) {
        while (stack.length - 1 > item.level) stack.pop();
        while (stack.length - 1 < item.level) {
          const parentItem = stack.at(-1).lastElementChild || stack.at(-1).appendChild(el('li'));
          const sub = el(b.ordered ? 'ol' : 'ul');
          parentItem.append(sub);
          stack.push(sub);
        }
        stack.at(-1).append(runsInto(el('li'), item.runs));
      }
      out.push(root);
    } else out.push(runsInto(el('p'), b.runs));
  }
  return out;
}

async function importTex() {
  if (!desktop) { say('Importing needs the desktop app.'); return; }
  const file = await desktop.openText({ title: 'Import LaTeX', filters: [{ name: 'LaTeX', extensions: ['tex', 'latex', 'ltx'] }] });
  if (!file) return;
  let result;
  try { result = texToBlocks(file.content); } catch (error) { say(`Could not read ${file.path.split(/[\\/]/).pop()}: ${error.message}`); return; }
  const nodes = blocksToNodes(result.blocks);
  if (result.notes.length) {
    // What could not be read is said at the end, as review notes (F8 goes to them).
    const p = el('p', { class: 'warned', 'data-warning': JSON.stringify(result.notes) }, `Notes from importing ${file.path.split(/[\\/]/).pop()}: ${result.notes.length}.`);
    nodes.push(p);
  }
  if (isEmpty()) {
    docName = result.title || file.path.split(/[\\/]/).pop().replace(/\.(tex|latex|ltx)$/i, '');
    doc.replaceChildren(...nodes);
  } else {
    doc.append(...nodes);
  }
  setDirty(true);
  const equations = nodes.reduce((n, node) => n + (node.classList?.contains('eq') ? 1 : node.querySelectorAll?.('.eq').length || 0), 0);
  const graphCount = nodes.filter((n) => n.classList?.contains('graph-line')).length;
  doc.focus();
  placeCaretIn(nodes[0] || doc);
  say(`Imported ${file.path.split(/[\\/]/).pop()}: ${equations} ${equations === 1 ? 'equation' : 'equations'}${graphCount ? `, ${graphCount} ${graphCount === 1 ? 'graph' : 'graphs'} you can explore by sound` : ''}.`
    + (result.notes.length ? ` ${result.notes.length} ${result.notes.length === 1 ? 'note' : 'notes'} on what could not be read; F8 goes to them.` : ''));
}

// Graph > Copy graph as LaTeX: pgfplots code that draws the same graph in a .tex file.
async function copyGraphLatex() {
  const block = currentBlock();
  const graph = block?.classList.contains('graph-line') ? graphs.get(block.dataset.graphId) : null;
  if (!graph) { say('Move to a graph line first.'); return; }
  const code = graphToPgfplots(graph);
  if (desktop) await desktop.copyText(code); else await navigator.clipboard.writeText(code);
  say(`Copied the graph as LaTeX (pgfplots), ${code.split('\n').length} lines. Paste it into a .tex file that uses the pgfplots package.`);
}

// ---------- the document as Word blocks (docx.js) ----------

function inlineRuns(node, style = {}) {
  const runs = [];
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      // Line breaks in the HTML source are not line breaks on the page, and the no-break
      // spaces Chromium types at the edges of formatting are ordinary spaces.
      const text = child.textContent.replace(/[\r\n]+/g, ' ').replace(/ /g, ' ');
      if (text) runs.push({ text, ...style });
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    if (child.classList.contains('eq') && child.dataset.latex) { runs.push({ latex: child.dataset.latex }); continue; }
    if (child.tagName === 'BR') {
      // The last <br> of a line only keeps the line open while it is empty.
      if (child.nextSibling || runs.length === 0) runs.push({ lineBreak: true });
      continue;
    }
    if (['UL', 'OL', 'TABLE'].includes(child.tagName)) continue; // handled as their own blocks
    const next = { ...style };
    if (child.tagName === 'B' || child.tagName === 'STRONG' || /bold|[6-9]00/.test(child.style?.fontWeight || '')) next.bold = true;
    if (child.tagName === 'I' || child.tagName === 'EM' || child.style?.fontStyle === 'italic') next.italic = true;
    if (child.tagName === 'U' || /underline/.test(child.style?.textDecoration || '')) next.underline = true;
    runs.push(...inlineRuns(child, next));
  }
  // An empty last line (a lone break) is not printed.
  while (runs.length && runs.at(-1).lineBreak) runs.pop();
  return runs;
}

function listBlocks(list, level = 0, out = { type: 'list', ordered: list.tagName === 'OL', items: [] }) {
  for (const item of list.children) {
    if (item.tagName === 'LI') {
      out.items.push({ runs: inlineRuns(item), level });
      for (const sub of item.children) if (sub.tagName === 'UL' || sub.tagName === 'OL') listBlocks(sub, level + 1, out);
    } else if (item.tagName === 'UL' || item.tagName === 'OL') {
      listBlocks(item, level + 1, out); // a list typed straight inside a list
    }
  }
  return out;
}

const INLINE = new Set(['SPAN', 'B', 'I', 'U', 'STRONG', 'EM', 'BR']);
const isInline = (node) => node.nodeType === Node.TEXT_NODE || (node.nodeType === Node.ELEMENT_NODE && INLINE.has(node.tagName));

// Text, equations or bold words lying straight in the document (outside any paragraph) are
// put into a paragraph of their own, so every line is a real paragraph for NVDA and Word.
function wrapLooseInline() {
  let changed = false;
  for (let node = doc.firstChild; node;) {
    if (!isInline(node) || (node.nodeType === Node.TEXT_NODE && !node.textContent.trim() && !(node.nextSibling && isInline(node.nextSibling)))) { node = node.nextSibling; continue; }
    const p = el('p');
    node.before(p);
    while (p.nextSibling && isInline(p.nextSibling)) p.append(p.nextSibling);
    changed = true;
    node = p.nextSibling;
  }
  return changed;
}

function documentBlocks(root = doc) {
  if (root === doc) wrapLooseInline();
  const blocks = [];
  for (const node of root.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.textContent.trim()) blocks.push({ type: 'paragraph', runs: [{ text: node.textContent }] });
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = node.tagName;
    if (/^H[1-6]$/.test(tag)) blocks.push({ type: 'heading', level: Number(tag[1]), runs: inlineRuns(node) });
    else if (tag === 'UL' || tag === 'OL') blocks.push(listBlocks(node));
    else if (tag === 'HR') blocks.push({ type: 'pageBreak' });
    else if (tag === 'TABLE') {
      const rows = [...node.querySelectorAll('tr')].map((tr) => [...tr.children].map((cell) => inlineRuns(cell)));
      blocks.push({ type: 'table', rows, header: Boolean(node.querySelector('tr')?.querySelector('th')) });
    } else {
      const eqs = node.querySelectorAll('.eq');
      // A line holding only one equation is a display equation, centred on its own line.
      if (eqs.length === 1 && node.textContent.trim() === eqs[0].textContent.trim() && (node.classList.contains('eq-line') || eqs[0].dataset.display === 'true')) {
        blocks.push({ type: 'equation', latex: eqs[0].dataset.latex });
      } else {
        blocks.push({ type: 'paragraph', runs: inlineRuns(node) });
      }
    }
  }
  return blocks;
}

async function exportDocx() {
  if (!desktop) { say('Exporting needs the desktop app.'); return; }
  const { bytes, problems } = makeDocx(documentBlocks(), docName);
  const saved = await desktop.saveBinary({ name: `${docName}.docx`, bytes, filters: [{ name: 'Word document', extensions: ['docx'] }] });
  if (!saved) return;
  const name = saved.split(/[\\/]/).pop();
  say(problems.length
    ? `Exported ${name}, but ${problems.length} ${problems.length === 1 ? 'equation' : 'equations'} could not be made into Word equations and are written as LaTeX text: ${problems.join('; ')}`
    : `Exported ${name}. Every equation is a Word equation.`);
}

async function exportPdf() {
  if (!desktop) { say('Exporting needs the desktop app.'); return; }
  const saved = await desktop.exportPdf({ name: `${docName}.pdf`, notebook: serialize() });
  if (saved) say(`Exported ${saved.split(/[\\/]/).pop()}. It opens like any PDF; this notebook is inside it, so Math Notebook opens it exactly. Equations in a PDF are hard for screen readers; for reading with NVDA, share the Word file too.`);
}

// ---------- caret and blocks ----------

// The top-level line (paragraph, heading, table…) that contains a node, or null when
// the node is the document itself or outside it.
function blockOf(node) {
  if (!node || node === doc || !doc.contains(node)) return null;
  while (node.parentNode !== doc) node = node.parentNode;
  return node.nodeType === Node.ELEMENT_NODE ? node : null;
}

function currentBlock() {
  const sel = getSelection();
  if (sel.anchorNode === doc) return doc.children[Math.min(sel.anchorOffset, doc.children.length - 1)] || null;
  return blockOf(sel.anchorNode);
}

function equationAtCaret() {
  const sel = getSelection();
  if (!sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const near = [];
  const { startContainer: c, startOffset: o } = range;
  if (c.nodeType === Node.ELEMENT_NODE) near.push(c.childNodes[o], c.childNodes[o - 1]);
  else near.push(o === c.textContent.length ? c.nextSibling : null, o === 0 ? c.previousSibling : null);
  near.push(c.parentElement?.closest('.eq'));
  const hit = near.find((n) => n?.nodeType === Node.ELEMENT_NODE && n.classList.contains('eq'));
  if (hit) return hit;
  const block = currentBlock();
  const all = block ? block.querySelectorAll('.eq') : [];
  return all.length === 1 && block.classList.contains('eq-line') ? all[0] : null;
}

function placeCaretAfter(node) {
  const range = document.createRange();
  range.setStartAfter(node);
  range.collapse(true);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function placeCaretIn(block) {
  const range = document.createRange();
  range.selectNodeContents(block);
  range.collapse(true);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  block.scrollIntoView({ block: 'center' });
}

// ---------- equation dialog ----------

let equationTarget = null;
let equationRange = null;
let latexMode = false;

function openEquation(target) {
  equationTarget = target;
  const sel = getSelection();
  equationRange = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  latexMode = false;
  const input = $('equation-text');
  input.value = target ? latexToPlain(target.dataset.latex) : '';
  $('equation-label').textContent = 'Equation as plain text';
  $('equation-error').textContent = '';
  preview();
  $('equation-dialog').showModal();
  input.focus();
}

function currentLatex() {
  const text = $('equation-text').value;
  return latexMode ? text : plainToLatex(text);
}

function preview() {
  const box = $('equation-preview');
  try {
    const latex = currentLatex();
    box.replaceChildren(latex ? mathSpan(latex, true) : '');
    $('equation-error').textContent = '';
  } catch (error) {
    box.replaceChildren();
    $('equation-error').textContent = error.message;
  }
}

function toggleLatex() {
  try {
    const latex = currentLatex();
    latexMode = !latexMode;
    $('equation-text').value = latexMode ? latex : latexToPlain(latex);
    $('equation-label').textContent = latexMode ? 'Equation as LaTeX' : 'Equation as plain text';
    say(latexMode ? `LaTeX: ${latex}` : `Plain text: ${$('equation-text').value}`);
    preview();
  } catch (error) {
    $('equation-error').textContent = error.message;
  }
}

function commitEquation() {
  let latex;
  try { latex = currentLatex(); } catch (error) { $('equation-error').textContent = error.message; return; }
  $('equation-dialog').close();
  if (!latex) return;
  const span = mathSpan(latex, equationTarget?.dataset.display === 'true');
  if (equationTarget) {
    equationTarget.replaceWith(span);
  } else {
    doc.focus();
    const sel = getSelection();
    sel.removeAllRanges();
    if (equationRange && doc.contains(equationRange.startContainer)) sel.addRange(equationRange);
    else { const r = document.createRange(); r.selectNodeContents(doc); r.collapse(false); sel.addRange(r); }
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(span);
  }
  doc.focus();
  placeCaretAfter(span);
  tidy();
  setDirty(true);
  say(`Equation: ${latexToPlain(latex)}`);
}

$('equation-text').addEventListener('input', preview);
$('equation-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); commitEquation(); }
  if (e.key.toLowerCase() === 'l' && e.ctrlKey) { e.preventDefault(); toggleLatex(); }
});
$('equation-dialog').addEventListener('close', () => { if (!$('equation-dialog').returnValue) doc.focus(); });

// ---------- graph from equations ----------

let graphRange = null;
function openGraphDialog() {
  const sel = getSelection();
  graphRange = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  $('graph-error').textContent = '';
  $('graph-dialog').showModal();
  $('graph-text').focus();
}

// "a, b" as a range; empty means "choose for me".
function readRange(text, name) {
  if (!text.trim()) return null;
  const range = text.split(',').map((t) => Number(t.trim()));
  if (range.length !== 2 || !range.every(Number.isFinite) || range[0] >= range[1]) throw new Error(`Write the ${name} range as two numbers, smaller first, for example -5, 5, or leave it empty.`);
  return range;
}

// The functions typed in the dialog: one per line. A LaTeX piecewise function may run over
// several lines, so lines inside \begin{cases} ... \end{cases} stay together.
function graphSources(text) {
  const out = [];
  let open = '';
  for (const line of text.split('\n')) {
    open = open ? `${open} ${line}` : line;
    if ((open.match(/\\begin\{cases\}/g) || []).length > (open.match(/\\end\{cases\}/g) || []).length) continue;
    // Semicolons still separate plain-text functions, as before.
    for (const part of /\\/.test(open) ? [open] : open.split(';')) if (part.trim()) out.push(part.trim());
    open = '';
  }
  if (open.trim()) out.push(open.trim());
  return out;
}

function commitGraph() {
  const sources = graphSources($('graph-text').value);
  if (!sources.length) { $('graph-error').textContent = 'Write at least one function of x.'; return; }
  let graph;
  try {
    const code = $('graph-text').value;
    // pgfplots code (\addplot ...) pasted from a .tex file is read as that graph.
    graph = /\\addplot|\\begin\{axis\}/.test(code) ? graphFromPgfplots(code).graph
      : makeGraph(sources, { x: readRange($('graph-range').value, 'x'), y: readRange($('graph-yrange').value, 'y') });
  } catch (error) {
    $('graph-error').textContent = error.message;
    return;
  }
  const line = graphLine(graph);
  $('graph-dialog').close();
  doc.focus();
  const block = graphRange ? blockOf(graphRange.startContainer) : null;
  if (block) block.after(line); else doc.append(line);
  placeCaretIn(line);
  setDirty(true);
  say(`Graph inserted: ${graph.summary} Press Enter on it to explore it by sound.`);
}

// Ctrl+G on an equation in the document: graph it, keep the graph under its line, explore.
function graphEquation(eq) {
  let graph;
  try { graph = makeGraph([{ text: eq.dataset.latex, format: 'latex' }]); } catch (error) { say(`This equation cannot be graphed: ${error.message}`); return; }
  const block = blockOf(eq);
  const line = graphLine(graph);
  if (block) block.after(line); else doc.append(line);
  setDirty(true);
  exploreGraph(line);
}
$('graph-text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); commitGraph(); } });
$('graph-range').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitGraph(); } });

// ---------- graph mode ----------

let graphReturn = null;
const graphMode = new GraphMode({
  root: $('graph-mode'), status: $('status'), reading: $('graph-reading'),
  onExit: () => { doc.focus(); if (graphReturn) placeCaretIn(graphReturn); say('Back in the document.'); },
});

function exploreGraph(block = currentBlock()) {
  // On an equation (not on a graph line): graph that equation.
  const eq = !block?.classList.contains('graph-line') && equationAtCaret();
  if (eq) { graphEquation(eq); return; }
  let target = block?.classList.contains('graph-line') ? block : null;
  if (!target && block) {
    for (let n = block.nextElementSibling; n && !target; n = n.nextElementSibling) if (n.classList.contains('graph-line')) target = n;
  }
  target ||= doc.querySelector('.graph-line');
  const graph = target && graphs.get(target.dataset.graphId);
  if (!graph) { say('There is no graph here. Insert one from the Insert menu, or import a PDF with graphs.'); return; }
  graphReturn = target;
  graphMode.open(graph);
}

// ---------- review notes ----------

function moveToWarning(direction) {
  const all = [...doc.querySelectorAll('[data-warning]')];
  if (!all.length) { say('There are no review notes.'); return; }
  const here = currentBlock();
  let index = here ? all.findIndex((n) => n === here || (here.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING)) : 0;
  if (direction > 0) {
    if (here && all.includes(here)) index = all.indexOf(here) + 1;
  } else {
    const before = here ? all.filter((n) => n !== here && (n.compareDocumentPosition(here) & Node.DOCUMENT_POSITION_FOLLOWING)) : [];
    index = before.length ? all.indexOf(before.at(-1)) : -1;
  }
  if (index < 0 || index >= all.length) { say(direction > 0 ? 'No more review notes below.' : 'No review notes above.'); return; }
  const target = all[index];
  placeCaretIn(target);
  const notes = JSON.parse(target.dataset.warning);
  say(`Review note ${index + 1} of ${all.length}: ${notes.join(' ')} The line reads: ${spoken(target)}`);
}

function clearWarning() {
  const block = currentBlock();
  if (!block?.dataset.warning) { say('This line has no review note.'); return; }
  delete block.dataset.warning;
  block.classList.remove('warned');
  setDirty(true);
  say('Review note removed.');
}

// Text of a block with equations written as plain math, for reading aloud.
function spoken(block) {
  const copy = block.cloneNode(true);
  copy.querySelectorAll('.eq').forEach((eq) => eq.replaceWith(` ${latexToPlain(eq.dataset.latex)} `));
  return copy.textContent.replace(/\s+/g, ' ').trim();
}

// ---------- converting typed text ----------

function selectionToEquation() {
  const sel = getSelection();
  const text = sel.toString().trim();
  if (!text) { say('Select the math you typed first, for example x^2 - 4.'); return; }
  let latex;
  try { latex = plainToLatex(text); } catch (error) { say(`Could not convert: ${error.message}`); return; }
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const span = mathSpan(latex);
  range.insertNode(span);
  placeCaretAfter(span);
  tidy();
  setDirty(true);
  say(`Converted to an equation: ${latexToPlain(latex)}`);
}

function lineToEquation() {
  const block = currentBlock();
  if (!block || block.querySelector('.eq') || !block.textContent.trim()) { selectionToEquation(); return; }
  if (getSelection().toString()) { selectionToEquation(); return; }
  let latex;
  try { latex = plainToLatex(block.textContent); } catch (error) { say(`Could not convert this line: ${error.message}`); return; }
  const line = equationLine(latex);
  block.replaceWith(line);
  placeCaretAfter(line.firstChild);
  setDirty(true);
  say(`This line is now an equation: ${latexToPlain(latex)}`);
}

function equationToText() {
  const eq = equationAtCaret();
  if (!eq) { say('Move next to an equation first.'); return; }
  const text = document.createTextNode(latexToPlain(eq.dataset.latex));
  eq.replaceWith(text);
  placeCaretAfter(text);
  setDirty(true);
  say(`Now plain text: ${text.textContent}`);
}

// ---------- working line by line: the equation above, copied down ----------

// A line with nothing on it (an empty paragraph).
const isBlankLine = (b) => b?.tagName === 'P' && !b.textContent.trim() && !b.querySelector('.eq, img, .graph-line') && !b.classList.contains('graph-line');

// The last equation before the cursor: on this line, or else on the nearest line above that has one.
function equationBefore(block) {
  if (block?.querySelector('.eq')) return [...block.querySelectorAll('.eq')].at(-1);
  for (let b = block?.previousElementSibling; b; b = b.previousElementSibling) {
    const all = b.querySelectorAll('.eq');
    if (all.length) return all[all.length - 1];
  }
  return null;
}

// F11 (and Enter on the blank line under an equation): the last equation before the cursor
// comes down as a new equation line, ready to change (Ctrl+E). It goes on this line when this
// line is empty, otherwise on a new line below it.
function copyEquationDown() {
  const block = currentBlock();
  const source = equationBefore(block);
  if (!source) { say('There is no equation above to copy.'); return; }
  const line = equationLine(source.dataset.latex);
  if (isBlankLine(block)) block.replaceWith(line);
  else if (block) block.after(line);
  else doc.append(line);
  placeCaretAfter(line.firstChild);
  line.scrollIntoView({ block: 'center' });
  setDirty(true);
  say(`Copied down: ${latexToPlain(source.dataset.latex)}. Ctrl+E changes it.`);
}

// The cursor is just after this equation (nothing but spaces between).
function caretAfter(eq) {
  const sel = getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return false;
  const after = document.createRange();
  after.setStartAfter(eq);
  return sel.getRangeAt(0).compareBoundaryPoints(Range.START_TO_START, after) >= 0;
}

// An equation line, or a line whose last thing is an equation (text after it is only spaces or a full stop).
function endsWithEquation(block) {
  if (!block || block.tagName !== 'P') return false;
  if (block.classList.contains('eq-line')) return Boolean(block.querySelector('.eq'));
  let last = block.lastChild;
  while (last && (last.nodeName === 'BR' || (last.nodeType === Node.TEXT_NODE && /^[\s.,;]*$/.test(last.textContent)))) last = last.previousSibling;
  return last?.nodeType === Node.ELEMENT_NODE && last.classList.contains('eq');
}

// A new empty line after this one, with the cursor on it.
function newLineAfter(block) {
  const p = el('p');
  p.append(el('br'));
  block.after(p);
  placeCaretIn(p);
  setDirty(true);
  return p;
}

function setBlockType(tag) {
  const block = currentBlock();
  if (!block || block.classList.contains('graph-line')) return;
  if (block.tagName === 'UL' || block.tagName === 'OL' || block.tagName === 'TABLE') {
    say(block.tagName === 'TABLE' ? 'Headings cannot go inside a table cell.' : 'This line is in a list. Turn the list off first with Ctrl+Shift+L, or Ctrl+Shift+7 for a numbered list.');
    return;
  }
  const replacement = el(tag);
  replacement.append(...block.childNodes);
  if (!replacement.childNodes.length) replacement.append(el('br'));
  block.replaceWith(replacement);
  placeCaretIn(replacement);
  setDirty(true);
  say(tag === 'p' ? 'Normal text.' : `Heading level ${tag[1]}.`);
}

function readLine() {
  const eq = equationAtCaret();
  if (eq) { say(`Equation: ${latexToPlain(eq.dataset.latex)}`); return; }
  const block = currentBlock();
  say(block ? spoken(block) || 'Blank line.' : 'Nothing here.');
}

// ---------- formatting, lists, page breaks ----------

function inDocument() {
  const sel = getSelection();
  return sel.rangeCount > 0 && doc.contains(sel.anchorNode);
}

function format(command, name) {
  if (!inDocument()) doc.focus();
  document.execCommand(command);
  setDirty(true);
  say(`${name} ${document.queryCommandState(command) ? 'on' : 'off'}.`);
}

function toggleList(ordered) {
  const block = currentBlock();
  if (block && (block.classList.contains('graph-line') || block.classList.contains('figure-line') || block.tagName === 'TABLE')) {
    say('A graph, picture or table cannot be a list item.');
    return;
  }
  // Lists are built here, not with Chromium's list command, which nested lists inside
  // paragraphs and moved the caret to the start of the item.
  const tag = ordered ? 'OL' : 'UL';
  const li = listItem();
  if (li) {
    const list = li.parentElement;
    if (list.tagName !== tag) {
      // Bulleted <-> numbered: the same items, the other kind of list.
      keepCaret(() => { const other = el(tag.toLowerCase()); other.append(...list.childNodes); list.replaceWith(other); });
      say(ordered ? 'Numbered list.' : 'Bulleted list.');
    } else {
      { let made = null; keepCaret(() => { made = listItemToParagraph(li); }, () => made); }
      say('List off; normal text.');
    }
    setDirty(true);
    return;
  }
  if (!block) return;
  keepCaret(() => {
    const item = el('li');
    item.append(...block.childNodes);
    if (!item.childNodes.length) item.append(el('br'));
    const list = el(tag.toLowerCase());
    list.append(item);
    block.replaceWith(list);
    // Next to a list of the same kind, the item joins it.
    const before = list.previousElementSibling, after = list.nextElementSibling;
    if (before?.tagName === tag) { before.append(...list.childNodes); list.remove(); if (after?.tagName === tag) { before.append(...after.childNodes); after.remove(); } }
    else if (after?.tagName === tag) { after.prepend(...list.childNodes); list.remove(); }
  }, () => listItem() || doc);
  setDirty(true);
  say(ordered ? 'Numbered list.' : 'Bulleted list.');
}

// A list item becomes a normal paragraph where it is: the items before it stay a list,
// the items after it become a second list.
function listItemToParagraph(li) {
  const list = li.parentElement;
  const p = el('p');
  p.append(...[...li.childNodes].filter((n) => !(n.nodeType === Node.ELEMENT_NODE && /^(UL|OL)$/.test(n.tagName))));
  const nested = [...li.children].filter((n) => /^(UL|OL)$/.test(n.tagName));
  if (!p.childNodes.length) p.append(el('br'));
  const rest = el(list.tagName.toLowerCase());
  for (let n = li.nextSibling; n;) { const next = n.nextSibling; rest.append(n); n = next; }
  li.remove();
  // Inside a nested list the paragraph cannot stand alone; it goes after the outer item.
  const outerItem = list.parentElement?.closest('li');
  const place = outerItem && doc.contains(outerItem) ? outerItem.parentElement : list;
  place.after(p);
  if (rest.childNodes.length) p.after(rest);
  for (const sub of nested) (rest.childNodes.length ? rest : p).after(sub);
  if (!list.children.length) list.remove();
  return p;
}

// Run a change that moves nodes around, then put the caret back where it was. If the node
// it was in is gone, it goes to the start of fallback().
function keepCaret(change, fallback) {
  const sel = getSelection();
  const r = sel.rangeCount ? sel.getRangeAt(0) : null;
  const saved = r && [r.startContainer, r.startOffset, r.endContainer, r.endOffset];
  const startText = saved && saved[0].nodeType === Node.TEXT_NODE;
  // A caret between elements is remembered by the nodes on either side, which move with it.
  const child = saved && !startText ? saved[0].childNodes[saved[1]] || null : null;
  const before = saved && !startText ? saved[0].childNodes[saved[1] - 1] || null : null;
  change();
  const range = document.createRange();
  try {
    if (startText && doc.contains(saved[0]) && doc.contains(saved[2])) { range.setStart(saved[0], saved[1]); range.setEnd(saved[2], saved[3]); }
    else if (before && doc.contains(before)) { range.setStartAfter(before); range.collapse(true); }
    else if (child && doc.contains(child)) { range.setStartBefore(child); range.collapse(true); }
    else throw new Error('caret node moved out');
  } catch {
    const target = fallback?.() || doc;
    range.selectNodeContents(target);
    range.collapse(true);
  }
  sel.removeAllRanges();
  sel.addRange(range);
}

// Tab: the item goes in a level, under the item above it. Shift+Tab: out a level.
function indentListItem(out) {
  const li = listItem();
  const list = li.parentElement;
  if (!out) {
    const above = li.previousElementSibling;
    if (!above) { say('The first item of a list cannot go in a level.'); return; }
    keepCaret(() => {
      let sub = [...above.children].find((n) => n.tagName === list.tagName);
      if (!sub) { sub = el(list.tagName.toLowerCase()); above.append(sub); }
      sub.append(li);
    });
    say('List item moved in a level.');
  } else {
    const outerItem = list.parentElement?.closest('li');
    if (!outerItem || !doc.contains(outerItem)) { { let made = null; keepCaret(() => { made = listItemToParagraph(li); }, () => made); } say('List off; normal text.'); setDirty(true); return; }
    keepCaret(() => {
      // The items after it come along as its own sub-items.
      const rest = [];
      for (let n = li.nextElementSibling; n; n = n.nextElementSibling) rest.push(n);
      if (rest.length) { const sub = el(list.tagName.toLowerCase()); sub.append(...rest); li.append(sub); }
      outerItem.after(li);
      if (!list.children.length) list.remove();
    });
    say('List item moved out a level.');
  }
  setDirty(true);
}

function listItem() {
  const sel = getSelection();
  const node = sel.anchorNode?.nodeType === Node.ELEMENT_NODE ? sel.anchorNode : sel.anchorNode?.parentElement;
  const li = node?.closest('li');
  return li && doc.contains(li) ? li : null;
}

function insertAfterCurrent(...nodes) {
  const block = currentBlock();
  // An empty line is replaced; otherwise the new block goes after the current line.
  if (block && block.tagName === 'P' && !block.textContent.trim() && !block.querySelector('.eq') && !block.classList.contains('answer')) block.replaceWith(...nodes);
  else if (block) block.after(...nodes);
  else doc.append(...nodes);
}

function pageBreak() {
  const after = el('p');
  after.append(el('br'));
  insertAfterCurrent(el('hr', { class: 'page-break' }), after);
  placeCaretIn(after);
  setDirty(true);
  say('Page break. A new page starts here when printed or exported.');
}

// ---------- tables ----------

let tableReturn = null;

function openTableDialog() {
  const sel = getSelection();
  tableReturn = sel.rangeCount && doc.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
  $('table-error').textContent = '';
  $('table-dialog').showModal();
  $('table-columns').focus();
  $('table-columns').select();
}

function emptyCell(tag) {
  const cell = el(tag, tag === 'th' ? { scope: 'col' } : {});
  cell.append(el('br'));
  return cell;
}

function insertTable() {
  const columns = Number($('table-columns').value), rows = Number($('table-rows').value);
  if (!Number.isInteger(columns) || columns < 1 || columns > 20) { $('table-error').textContent = 'Columns must be a whole number from 1 to 20.'; return; }
  if (!Number.isInteger(rows) || rows < 1 || rows > 200) { $('table-error').textContent = 'Rows must be a whole number from 1 to 200.'; return; }
  const header = $('table-header').checked;
  const table = el('table');
  for (let r = 0; r < rows; r += 1) {
    const tr = el('tr');
    for (let c = 0; c < columns; c += 1) tr.append(emptyCell(header && r === 0 ? 'th' : 'td'));
    table.append(tr);
  }
  const after = el('p');
  after.append(el('br'));
  $('table-dialog').close('insert');
  doc.focus();
  if (tableReturn) { const sel = getSelection(); sel.removeAllRanges(); sel.addRange(tableReturn); }
  insertAfterCurrent(table, after);
  placeCaretIn(table.querySelector('th, td'));
  setDirty(true);
  say(`Table with ${columns} ${columns === 1 ? 'column' : 'columns'} and ${rows} ${rows === 1 ? 'row' : 'rows'}${header ? ', the first row is the header' : ''}. You are in the first cell. Tab moves to the next cell.`);
}

$('table-form').addEventListener('submit', (e) => {
  if (e.submitter?.value === 'cancel') return;
  e.preventDefault(); // the dialog stays open if a number is refused
  insertTable();
});
$('table-dialog').addEventListener('close', () => { if ($('table-dialog').returnValue !== 'insert') doc.focus(); $('table-dialog').returnValue = ''; });

function currentCell() {
  const sel = getSelection();
  const node = sel.anchorNode?.nodeType === Node.ELEMENT_NODE ? sel.anchorNode : sel.anchorNode?.parentElement;
  const cell = node?.closest('td, th');
  return cell && doc.contains(cell) ? cell : null;
}

function moveCell(direction) {
  const cell = currentCell();
  const table = cell.closest('table');
  const cells = [...table.querySelectorAll('td, th')];
  let index = cells.indexOf(cell) + direction;
  if (index >= cells.length) {
    // Tab in the last cell adds a row, as in Word.
    const row = el('tr');
    for (let c = 0; c < cell.parentElement.children.length; c += 1) row.append(emptyCell('td'));
    table.querySelector('tr:last-child').after(row);
    placeCaretIn(row.firstChild);
    setDirty(true);
    say(`Row ${table.rows.length} added.`);
    return;
  }
  if (index < 0) { say('First cell of the table.'); return; }
  const target = cells[index];
  const range = document.createRange();
  range.selectNodeContents(target);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range); // the cell's text is selected, as in Word, so typing replaces it
}

function tableCommand(action) {
  const cell = currentCell();
  if (!cell) { say('Move into a table first.'); return; }
  const row = cell.parentElement;
  const table = cell.closest('table');
  const column = [...row.children].indexOf(cell);
  if (action === 'addRow') {
    const fresh = el('tr');
    for (let c = 0; c < row.children.length; c += 1) fresh.append(emptyCell('td'));
    row.after(fresh);
    placeCaretIn(fresh.children[column]);
    say(`Row added below; you are in row ${fresh.rowIndex + 1}.`);
  } else if (action === 'addColumn') {
    for (const tr of table.rows) tr.children[column].after(emptyCell(tr.children[column].tagName.toLowerCase()));
    placeCaretIn(row.children[column + 1]);
    say(`Column added to the right; you are in column ${column + 2}.`);
  } else if (action === 'deleteRow') {
    if (table.rows.length === 1) { tableCommand('deleteTable'); return; }
    const next = row.nextElementSibling || row.previousElementSibling;
    row.remove();
    placeCaretIn(next.children[Math.min(column, next.children.length - 1)]);
    say(`Row deleted. ${table.rows.length} ${table.rows.length === 1 ? 'row' : 'rows'} left.`);
  } else if (action === 'deleteColumn') {
    if (row.children.length === 1) { tableCommand('deleteTable'); return; }
    for (const tr of table.rows) tr.children[column]?.remove();
    placeCaretIn(row.children[Math.min(column, row.children.length - 1)]);
    say(`Column deleted. ${row.children.length} ${row.children.length === 1 ? 'column' : 'columns'} left.`);
  } else if (action === 'deleteTable') {
    const after = table.nextElementSibling;
    table.remove();
    if (after) placeCaretIn(after);
    say('Table deleted.');
  }
  setDirty(true);
}

// ---------- find and replace ----------

const findState = { text: '', matchCase: false, wholeWords: false };

// Text nodes of the document outside equations, in order.
function textNodes() {
  const walker = document.createTreeWalker(doc, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement.closest('.eq') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const out = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n);
  return out;
}

function findLine(node) {
  const cell = node.parentElement?.closest('td, th, li');
  return (cell && doc.contains(cell) ? cell : blockOf(node)) || doc;
}

// Every match as a Range. Matches stay inside one line (block), as in Word.
function findMatches() {
  const { text, matchCase, wholeWords } = findState;
  if (!text) return [];
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(wholeWords ? `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])` : escaped, `gu${matchCase ? '' : 'i'}`);
  const byBlock = new Map();
  for (const node of textNodes()) {
    // Each table cell and list item is its own line: "x" and "f(x)" in two cells are not "xf(x)".
    const block = findLine(node);
    if (!byBlock.has(block)) byBlock.set(block, []);
    byBlock.get(block).push(node);
  }
  const ranges = [];
  for (const nodes of byBlock.values()) {
    // Chromium types no-break spaces at the edges of formatting; to the reader they are spaces.
    const joined = nodes.map((n) => n.textContent).join('').replace(/ /g, ' ');
    const starts = [];
    let at = 0;
    for (const n of nodes) { starts.push(at); at += n.textContent.length; }
    const locate = (offset, end) => {
      // The text node holding this offset (an end offset belongs to the node it ends).
      let k = nodes.length - 1;
      while (k > 0 && (end ? starts[k] >= offset : starts[k] > offset)) k -= 1;
      return [nodes[k], offset - starts[k]];
    };
    for (const m of joined.matchAll(pattern)) {
      if (!m[0]) continue;
      const range = document.createRange();
      range.setStart(...locate(m.index, false));
      range.setEnd(...locate(m.index + m[0].length, true));
      ranges.push(range);
    }
  }
  return ranges;
}

function readFindForm() {
  findState.text = $('find-text').value;
  findState.matchCase = $('find-case').checked;
  findState.wholeWords = $('find-words').checked;
}

let findRange = null; // where the caret was when the dialog opened

function openFind(replacing) {
  const sel = getSelection();
  findRange = sel.rangeCount && doc.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
  const selected = sel.toString();
  if (selected && !selected.includes('\n') && selected.length < 200) $('find-text').value = selected;
  $('find-dialog').classList.toggle('replacing', replacing);
  $('find-title').textContent = replacing ? 'Replace' : 'Find';
  $('find-message').textContent = '';
  $('find-dialog').showModal();
  $('find-text').focus();
  $('find-text').select();
}

function selectRange(range) {
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  (range.startContainer.parentElement || doc).scrollIntoView({ block: 'center' });
}

// The next (or previous) match from a place in the document, going round at the end.
function nextMatch(matches, here, direction) {
  if (!here) return { index: direction > 0 ? 0 : matches.length - 1, wrapped: false };
  const startCompare = (r) => r.compareBoundaryPoints(Range.START_TO_START, here);
  let index;
  if (direction > 0) {
    // A caret finds a match starting right there; a selected match is skipped.
    index = matches.findIndex((r) => startCompare(r) > 0 || (startCompare(r) === 0 && here.collapsed));
  } else {
    index = matches.findLastIndex((r) => startCompare(r) < 0);
  }
  if (index >= 0) return { index, wrapped: false };
  return { index: direction > 0 ? 0 : matches.length - 1, wrapped: true };
}

// F3 and Shift+F3 in the document, or Find next and Find previous in the dialog.
// Find selects the match in the document; Replace keeps the dialog open and reads the match.
function findAgain(direction, fromDialog = false) {
  const replacing = fromDialog && $('find-dialog').classList.contains('replacing');
  // While the dialog stays open its own message line speaks; otherwise the status line does.
  const message = (text, inDialog) => { if (inDialog) $('find-message').textContent = text; else say(text); };
  if (!findState.text) {
    if (fromDialog) message('Type what to find first.', true); else openFind(false);
    return null;
  }
  const matches = findMatches();
  if (!matches.length) { message(`"${findState.text}" was not found.`, fromDialog); return null; }
  const sel = getSelection();
  const here = fromDialog ? findRange : (sel.rangeCount && doc.contains(sel.anchorNode) ? sel.getRangeAt(0) : null);
  const { index, wrapped } = nextMatch(matches, here, direction);
  const match = matches[index];
  const block = findLine(match.startContainer);
  const text = `${wrapped ? (direction > 0 ? 'Searched to the end; continued from the top. ' : 'Searched to the top; continued from the end. ') : ''}`
    + `Match ${index + 1} of ${matches.length}. The line reads: ${block ? spoken(block) : match.toString()}`;
  if (replacing) {
    findRange = match.cloneRange(); // Replace changes this match
    message(text, true);
    return match;
  }
  if (fromDialog) $('find-dialog').close('found');
  doc.focus();
  selectRange(match);
  message(text, false);
  return match;
}

function replaceRange(range, text) {
  range.deleteContents();
  if (text) range.insertNode(document.createTextNode(text));
  range.startContainer.parentElement?.normalize();
  setDirty(true);
}

function replaceOne() {
  readFindForm();
  if (!findState.text) { $('find-message').textContent = 'Type what to find first.'; return; }
  const matches = findMatches();
  if (!matches.length) { $('find-message').textContent = `"${findState.text}" was not found.`; return; }
  // The match at or after the caret is replaced, then the next one is shown.
  const here = findRange;
  const target = matches.find((r) => !here || r.compareBoundaryPoints(Range.START_TO_START, here) >= 0) || matches[0];
  const after = target.cloneRange();
  replaceRange(target, $('replace-text').value);
  after.collapse(false);
  findRange = after;
  const left = findMatches().length;
  $('find-message').textContent = `Replaced one. ${left ? `${left} more ${left === 1 ? 'match' : 'matches'}.` : 'No more matches.'}`;
}

function replaceAll() {
  readFindForm();
  if (!findState.text) { $('find-message').textContent = 'Type what to find first.'; return; }
  const matches = findMatches();
  // From the end backwards, so the places of earlier matches do not move.
  for (const range of matches.reverse()) replaceRange(range, $('replace-text').value);
  $('find-message').textContent = matches.length ? `Replaced ${matches.length} ${matches.length === 1 ? 'match' : 'matches'}.` : `"${findState.text}" was not found.`;
}

// Find next is the dialog's default button: Enter anywhere in it (a check box too) finds.
$('find-form').addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'find') return; // Close closes
  e.preventDefault();
  readFindForm();
  findAgain(1, true);
});
$('find-previous').addEventListener('click', () => { readFindForm(); findAgain(-1, true); });
$('replace-one').addEventListener('click', replaceOne);
$('replace-all').addEventListener('click', replaceAll);
$('find-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); readFindForm(); findAgain(e.shiftKey ? -1 : 1, true); }
});
$('replace-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); replaceOne(); } });
$('find-dialog').addEventListener('close', () => {
  readFindForm();
  if ($('find-dialog').returnValue !== 'found') {
    doc.focus();
    if (findRange && doc.contains(findRange.startContainer)) selectRange(findRange);
  }
  $('find-dialog').returnValue = '';
});

// ---------- moving by heading, without leaving the document ----------
// In browse mode NVDA's H key does this; these keys do it while typing, so there is no
// need to switch modes (as in Word, where the Navigation pane lists the headings).

const headings = () => [...doc.querySelectorAll('h1, h2, h3, h4')];

function goToHeading(direction) {
  const all = headings();
  if (!all.length) { say('There are no headings. Ctrl+Alt+1, 2 or 3 makes the current line a heading.'); return; }
  const here = currentBlock();
  let target;
  if (direction > 0) target = all.find((h) => here ? here.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING : true);
  else target = all.filter((h) => here && h !== here && (h.compareDocumentPosition(here) & Node.DOCUMENT_POSITION_FOLLOWING)).at(-1);
  if (!target) { say(direction > 0 ? 'No more headings below.' : 'No headings above.'); return; }
  placeCaretIn(target);
  say(`Heading level ${target.tagName[1]}: ${spoken(target)}`);
}

function openHeadingList() {
  const all = headings();
  if (!all.length) { say('There are no headings. Ctrl+Alt+1, 2 or 3 makes the current line a heading.'); return; }
  const list = $('heading-list');
  const here = currentBlock();
  list.replaceChildren(...all.map((h, i) => el('option', { value: String(i) }, `${'  '.repeat(Number(h.tagName[1]) - 1)}${spoken(h) || '(empty heading)'}, level ${h.tagName[1]}`)));
  // The heading at or above the caret is chosen to start with.
  const current = here ? all.filter((h) => h === here || (h.compareDocumentPosition(here) & Node.DOCUMENT_POSITION_FOLLOWING)).at(-1) : null;
  list.selectedIndex = Math.max(0, current ? all.indexOf(current) : 0);
  $('headings-dialog').showModal();
  list.focus();
}

$('headings-form').addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'go') return;
  e.preventDefault();
  const target = headings()[Number($('heading-list').value)];
  $('headings-dialog').close('go');
  doc.focus();
  if (target) { placeCaretIn(target); say(`Heading level ${target.tagName[1]}: ${spoken(target)}`); }
});
$('heading-list').addEventListener('dblclick', () => $('headings-go').click());
// Enter in a list box does not submit a form by itself.
$('heading-list').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('headings-go').click(); } });
$('headings-dialog').addEventListener('close', () => { if ($('headings-dialog').returnValue !== 'go') doc.focus(); $('headings-dialog').returnValue = ''; });

// ---------- teacher mode ----------
// A teacher (or TA, tutor, disability services) writes the full document: answers, graphs
// with their formulas. Teacher-only parts are marked; "Save student copy" writes a new file
// with them taken out, so nothing hidden is in the student's file at all. The teacher's own
// file is the answer key.

let teacherMode = false;
let studentView = null; // while previewing the student copy: the teacher's document, kept aside

function setTeacherMode(on, quiet = false) {
  teacherMode = on;
  document.body.classList.toggle('teacher', on);
  desktop?.setMenuChecked?.('teacherMode', on);
  $('tb-teacher')?.setAttribute('aria-pressed', String(on));
  showMode();
  if (!quiet) say(on ? 'Teacher mode on. The Teacher menu marks what students will not get, and saves the student copy.' : 'Teacher mode off.');
}

function needTeacher() {
  if (teacherMode) return true;
  say('Turn on Teacher mode first: Teacher menu, Teacher mode.');
  return false;
}

// The top-level lines touched by the selection (or the caret's line).
function selectedBlocks() {
  const sel = getSelection();
  if (!sel.rangeCount || !doc.contains(sel.anchorNode)) return [];
  const range = sel.getRangeAt(0);
  const first = blockOf(range.startContainer) || currentBlock();
  const last = blockOf(range.endContainer) || first;
  const out = [];
  for (let n = first; n; n = n.nextElementSibling) { out.push(n); if (n === last) break; }
  return out.filter(Boolean);
}

function hideLines() {
  if (!needTeacher()) return;
  const blocks = selectedBlocks();
  if (!blocks.length) { say('Move to the line to hide first.'); return; }
  const hide = !blocks.every((b) => b.dataset.teacher);
  for (const b of blocks) { if (hide) b.dataset.teacher = 'only'; else delete b.dataset.teacher; }
  setDirty(true);
  const what = blocks.length === 1 ? 'This line' : `${blocks.length} lines`;
  say(hide ? `${what} hidden from students: it is left out of the student copy.` : `${what} shown to students again.`);
}

function hideWords() {
  if (!needTeacher()) return;
  const sel = getSelection();
  const node = sel.anchorNode?.nodeType === Node.ELEMENT_NODE ? sel.anchorNode : sel.anchorNode?.parentElement;
  const marked = node?.closest('span[data-teacher]');
  if (marked && doc.contains(marked)) {
    marked.replaceWith(...marked.childNodes);
    setDirty(true);
    say('These words are shown to students again.');
    return;
  }
  if (sel.isCollapsed || !doc.contains(sel.anchorNode)) { say('Select the words or the equation to hide first, for example the answer in a sentence.'); return; }
  if (selectedBlocks().length > 1) { say('Select words within one line; to hide whole lines, use Hide this line from students.'); return; }
  const range = sel.getRangeAt(0);
  const span = el('span', { 'data-teacher': 'only' });
  span.append(range.extractContents());
  range.insertNode(span);
  setDirty(true);
  say(`Hidden from students: ${spoken(span)}. In the student copy they see a blank, ______.`);
}

function insertAnswerBox() {
  const box = el('p', { class: 'answer', 'data-placeholder': 'Your answer' });
  box.append(el('br'));
  insertAfterCurrent(box);
  placeCaretIn(box);
  setDirty(true);
  say(teacherMode ? 'Answer box. Write the answer here: students get the box empty.' : 'Answer box.');
}

// ---- graphs for students ----

let studentGraphLine = null;
function openStudentGraph() {
  if (!needTeacher()) return;
  const block = currentBlock();
  const line = block?.classList.contains('graph-line') ? block : null;
  const graph = line && graphs.get(line.dataset.graphId);
  if (!graph) { say('Move to a graph line first (Insert > Graph, or Ctrl+G on an equation).'); return; }
  studentGraphLine = line;
  const opts = graph.student || { hideFormula: false, hide: [] };
  const hasFormula = Boolean(graph.functions?.length || graph.equations?.length);
  $('student-graph-about').textContent = hasFormula ? 'Students always get the graph itself: its shape and sound.' : 'This graph was read from a PDF, so it has no formula to hide.';
  $('sg-formula').checked = hasFormula && opts.hideFormula;
  $('sg-formula').disabled = !hasFormula;
  for (const key of Object.keys(HIDEABLE)) $(`sg-${key}`).checked = (opts.hide || []).includes(key);
  $('student-graph-dialog').showModal();
  (hasFormula ? $('sg-formula') : $('sg-zeros')).focus();
}

function studentNote(opts) {
  const parts = [...(opts.hideFormula ? ['the formula'] : []), ...(opts.hide || []).map((k) => HIDEABLE[k].name)];
  return parts.length ? `${parts.join(', ')} hidden.` : '';
}

$('student-graph-form').addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'save') return;
  e.preventDefault();
  const graph = graphs.get(studentGraphLine.dataset.graphId);
  const opts = { hideFormula: $('sg-formula').checked, hide: Object.keys(HIDEABLE).filter((k) => $(`sg-${k}`).checked) };
  graph.student = opts;
  const note = studentNote(opts);
  if (note) studentGraphLine.dataset.studentNote = note; else delete studentGraphLine.dataset.studentNote;
  $('student-graph-dialog').close('save');
  doc.focus();
  placeCaretIn(studentGraphLine);
  setDirty(true);
  say(note ? `For students: ${note}` : 'Students get the whole graph.');
});
$('student-graph-dialog').addEventListener('close', () => { if ($('student-graph-dialog').returnValue !== 'save') doc.focus(); $('student-graph-dialog').returnValue = ''; });

// ---- the student copy ----

// The student copy of the document: teacher-only lines out, hidden words blanked, answer
// boxes emptied, review notes dropped, graphs replaced by their student versions.
function studentCopy() {
  const source = studentView ? studentView : { html: doc.innerHTML, graphs };
  const root = el('div');
  root.append(...cleanNodes(source.html));
  for (const n of [...root.querySelectorAll('[data-teacher]')]) {
    if (n.tagName === 'SPAN') n.replaceWith(document.createTextNode('______'));
    else n.remove();
  }
  for (const box of root.querySelectorAll('p.answer')) box.replaceChildren(el('br'));
  for (const n of root.querySelectorAll('[data-warning]')) { n.removeAttribute('data-warning'); n.classList.remove('warned'); }
  const copyGraphs = new Map();
  for (const line of root.querySelectorAll('[data-graph-id]')) {
    const graph = source.graphs.get(line.dataset.graphId);
    if (!graph) continue;
    const id = newId();
    const copy = studentGraph(graph);
    copyGraphs.set(id, copy);
    line.dataset.graphId = id;
    line.removeAttribute('data-student-note');
    line.textContent = `Graph: ${copy.summary} Press Enter to explore it by sound.`;
  }
  return { root, graphs: copyGraphs };
}

function togglePreview(force, quiet = false) {
  const on = force ?? !studentView;
  if (on === Boolean(studentView)) return;
  if (on) {
    const copy = studentCopy();
    studentView = { html: doc.innerHTML, graphs: new Map(graphs) };
    for (const [id, g] of copy.graphs) graphs.set(id, g);
    doc.replaceChildren(...copy.root.childNodes);
    doc.contentEditable = 'false';
    document.body.classList.add('student-preview');
    showMode();
    if (!quiet) say('Student preview: this is exactly what students get. It cannot be edited; Teacher > Preview student copy again returns to your document.');
  } else {
    graphs.clear();
    for (const [id, g] of studentView.graphs) graphs.set(id, g);
    sanitizeInto(doc, studentView.html);
    studentView = null;
    doc.contentEditable = 'true';
    document.body.classList.remove('student-preview');
    showMode();
    if (!quiet) say('Back to your document, with everything in it.');
  }
  desktop?.setMenuChecked?.('studentPreview', on);
  doc.focus();
}

async function saveStudentCopy() {
  if (!desktop) { say('Saving needs the desktop app.'); return; }
  const { root, graphs: copyGraphs } = studentCopy();
  const content = JSON.stringify({ format: 'math-notebook', version: 1, name: `${docName} (student copy)`, studentCopy: true,
    html: root.innerHTML, graphs: Object.fromEntries(copyGraphs) });
  const saved = await desktop.save({ path: null, name: `${docName} (student copy).mathnb`, content });
  if (saved) say(`Saved the student copy as ${saved.split(/[\\/]/).pop()}. Your own file, with the answers, is unchanged.`);
}

async function exportStudentDocx() {
  if (!desktop) { say('Exporting needs the desktop app.'); return; }
  const { root } = studentCopy();
  const { bytes } = makeDocx(documentBlocks(root), `${docName} (student copy)`);
  const saved = await desktop.saveBinary({ name: `${docName} (student copy).docx`, bytes, filters: [{ name: 'Word document', extensions: ['docx'] }] });
  if (saved) say(`Exported the student copy as ${saved.split(/[\\/]/).pop()}.`);
}

async function exportStudentPdf() {
  if (!desktop) { say('Exporting needs the desktop app.'); return; }
  const wasPreview = Boolean(studentView);
  // Only the student copy goes inside: the answers are never in a student's PDF.
  const { root, graphs: copyGraphs } = studentCopy();
  const notebook = JSON.stringify({ format: 'math-notebook', version: 1, name: `${docName} (student copy)`, studentCopy: true,
    html: root.innerHTML, graphs: Object.fromEntries(copyGraphs) });
  togglePreview(true, true);
  let saved = null;
  try {
    saved = await desktop.exportPdf({ name: `${docName} (student copy).pdf`, notebook });
  } finally {
    if (!wasPreview) togglePreview(false, true);
  }
  if (saved) say(`Exported the student copy as ${saved.split(/[\\/]/).pop()}. Only the student copy is inside it.`);
}

// Commands that change the document wait while the student preview is shown.
const PREVIEW_SAFE = new Set(['studentPreview', 'teacherMode', 'keys', 'exploreGraph', 'readLine', 'find', 'findNext', 'findPrevious', 'wordCount',
  'nextHeading', 'previousHeading', 'headingList', 'nextNote', 'previousNote', 'saveStudentCopy', 'exportStudentDocx', 'exportStudentPdf',
  'settings', 'settingsReading', 'settingsSound', 'settingsAi', 'print', 'graphPlay', 'graphNextPoint', 'graphPreviousPoint',
  'graphDescribe', 'graphReadPoint', 'graphStep', 'graphNextFunction', 'graphClose', 'graphSlope', 'graphLimits', 'graphSlopeSound', 'soundGuide', 'copyGraphLatex', 'convertMath', 'save', 'saveAs']);

// When a dialog closes, the document gets the focus back, unless graph mode or another
// dialog is open (they keep it).
function backToDocument() {
  if (!$('graph-mode').hidden || document.querySelector('dialog[open]')) return;
  doc.focus();
}

// ---------- the toolbar ----------
// Words on every button. One Tab stop: arrow keys move between its controls (as in Office),
// F6 goes between the toolbar and the document. Each button runs the same command as its menu item.

const toolbar = $('toolbar');
const toolbarItems = () => [...toolbar.querySelectorAll('button, select')];
toolbarItems().forEach((item, i) => item.setAttribute('tabindex', i === 0 ? '0' : '-1'));

function focusToolbarItem(item) {
  for (const other of toolbarItems()) other.setAttribute('tabindex', other === item ? '0' : '-1');
  item.focus();
}

toolbar.addEventListener('click', (e) => {
  const button = e.target.closest('button[data-command]');
  if (!button) return;
  // Formatting acts on the document's selection, so the document gets the focus back first.
  if (['bold', 'italic', 'underline', 'bulletList', 'numberedList'].includes(button.dataset.command)) doc.focus();
  run(button.dataset.command);
});
toolbar.addEventListener('keydown', (e) => {
  const items = toolbarItems();
  const at = items.indexOf(document.activeElement);
  if (at < 0) return;
  const move = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
  // In the style box, up and down choose a style; left and right still leave it.
  if (move) { e.preventDefault(); focusToolbarItem(items[(at + move + items.length) % items.length]); }
  else if (e.key === 'Home') { e.preventDefault(); focusToolbarItem(items[0]); }
  else if (e.key === 'End') { e.preventDefault(); focusToolbarItem(items.at(-1)); }
  else if (e.key === 'Escape') { e.preventDefault(); doc.focus(); } // (F6 is handled once, for the whole page, below)
});
$('tb-style').addEventListener('change', () => { doc.focus(); run($('tb-style').value); });

// F6 anywhere outside a dialog: between the document and the toolbar.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'F6' || document.querySelector('dialog[open]') || !$('graph-mode').hidden) return;
  e.preventDefault();
  if (toolbar.contains(document.activeElement)) doc.focus();
  else focusToolbarItem(toolbar.querySelector('[tabindex="0"]') || toolbarItems()[0]);
});

// The toolbar shows the state at the caret: bold on or off, the line's style.
function updateToolbar() {
  if (!inDocument()) return;
  for (const name of ['bold', 'italic', 'underline']) {
    toolbar.querySelector(`[data-command="${name}"]`).setAttribute('aria-pressed', String(document.queryCommandState(name)));
  }
  const block = currentBlock();
  $('tb-style').value = { H1: 'heading1', H2: 'heading2', H3: 'heading3' }[block?.tagName] || 'normalText';
}
document.addEventListener('selectionchange', updateToolbar);

// The mode in the window title (NVDA+T reads it) and in the corner of the screen.
function showMode() {
  const mode = studentView ? 'Student preview' : teacherMode ? 'Teacher mode' : '';
  $('mode-indicator').textContent = mode;
  const title = `${dirty ? '* ' : ''}${docName}${mode ? ` (${mode})` : ''} - Math Notebook`;
  desktop?.setTitle(title);
  document.title = title;
}

// ---------- keyboard shortcuts: one page, made from the menus ----------

// ---------- help in dialogs ----------

// Dialogs show only their fields; what to type and which keys work is behind a Help button
// (and F1), in a small dialog NVDA reads when it opens. Returns false outside such a dialog.
function showDialogHelp(dialog = [...document.querySelectorAll('dialog[open]')].filter((d) => d.id !== 'help-dialog' && d.id !== 'keys-dialog').at(-1)) {
  const help = dialog?.querySelector('template.dialog-help');
  if (!help || $('help-dialog').open) return Boolean(help);
  const back = document.activeElement;
  $('help-title').textContent = `Help: ${dialog.querySelector('h2')?.textContent || ''}`;
  $('help-text').replaceChildren(help.content.cloneNode(true));
  $('help-dialog').showModal();
  $('help-close').focus();
  $('help-dialog').addEventListener('close', () => back?.focus?.(), { once: true });
  return true;
}
for (const dialog of document.querySelectorAll('dialog')) {
  if (!dialog.querySelector('template.dialog-help')) continue;
  let row = dialog.querySelector('form > .buttons');
  if (!row) { row = document.createElement('div'); row.className = 'buttons'; dialog.querySelector('form').append(row); }
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'help-button';
  button.textContent = 'Help';
  button.addEventListener('click', () => showDialogHelp(dialog));
  row.append(button);
  // F1 from any field of the dialog (the desktop menu's F1 does the same; a second call does nothing).
  dialog.addEventListener('keydown', (e) => { if (e.key === 'F1') { e.preventDefault(); e.stopPropagation(); showDialogHelp(dialog); } });
}

async function showKeys() {
  if ($('keys-dialog').open) return;
  const body = $('keys-body');
  body.replaceChildren(el('p', {}, 'Every command is in the menus (Alt). The keys below are the same as in Word wherever Word has one.'));
  const menus = desktop?.getMenu ? await desktop.getMenu() : [];
  for (const menu of menus) {
    const rows = menu.items.filter((i) => i.label);
    if (!rows.length) continue;
    body.append(el('h3', {}, menu.label));
    const table = el('table');
    const head = el('tr');
    head.append(el('th', { scope: 'col' }, 'Command'), el('th', { scope: 'col' }, 'Key'));
    table.append(head);
    for (const item of rows) {
      const tr = el('tr');
      tr.append(el('td', {}, item.label), el('td', {}, item.key || ''));
      table.append(tr);
    }
    body.append(table);
  }
  const extra = [
    ['In the document', [['Next and previous heading', 'Ctrl+Page Down, Ctrl+Page Up'], ['Between the toolbar and the document', 'F6'],
      ['List item in or out a level, next table cell', 'Tab, Shift+Tab'], ['Spelling suggestions on a misspelled word', 'Applications key'],
      ['Edit the equation at the caret', 'Ctrl+E, or Enter before an equation'], ['New line after an equation', 'Enter after it'],
      ['Copy the equation above down, to change it', 'F11, or Enter on the blank line under an equation']]],
    ['In graph mode', [['Step along the function', 'J and K'], ['Play or stop', 'Space'], ['Move freely', 'Arrow keys'],
      ['Next and previous point of interest', 'Period and comma'], ['Next function', 'Tab'], ['Describe the graph', 'I'],
      ['Read the point', 'V'], ['Slope here', 'S'], ['Limits from the left and the right', 'L'], ['Slope sound on or off', 'D'], ['Step size', 'F'], ['Ends of the function', 'Home and End'], ['Back to the document', 'Escape']]],
  ];
  for (const [name, rows] of extra) {
    body.append(el('h3', {}, name));
    const table = el('table');
    for (const [what, key] of rows) { const tr = el('tr'); tr.append(el('td', {}, what), el('td', {}, key)); table.append(tr); }
    body.append(table);
  }
  $('keys-dialog').showModal();
  body.focus();
}
$('keys-dialog').addEventListener('close', () => backToDocument());

// ---------- graph mode from the Graph menu ----------

function graphCommand(name) {
  if ($('graph-mode').hidden) { say('Open a graph first: on a graph line or an equation, press Ctrl+G.'); return; }
  graphMode.command(name);
}

// ---------- word count ----------

function wordCount() {
  const copy = doc.cloneNode(true);
  const equations = copy.querySelectorAll('.eq').length;
  copy.querySelectorAll('.eq').forEach((eq) => eq.replaceWith(' '));
  const text = copy.textContent;
  const words = (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
  const characters = text.replace(/\s/g, '').length;
  say(`${words} ${words === 1 ? 'word' : 'words'}, ${equations} ${equations === 1 ? 'equation' : 'equations'}, ${characters} characters without spaces.`);
}

// ---------- converting math between plain text, LaTeX and MathML ----------

let convertRange = null;
let convertLatex = '';

export function detectFormat(text) {
  const s = text.trim();
  if (/^<(?:[\w-]+:)?math[\s>]/i.test(s) || /^<\?xml/.test(s)) return 'mathml';
  if (/\\[A-Za-z]+|\\[{}|,;!]|[_^]\{/.test(s)) return 'latex';
  return 'plain';
}

export function convertMath(text, from, to) {
  const source = from === 'auto' ? detectFormat(text) : from;
  if (!text.trim()) return { source, latex: '', output: '' };
  let latex;
  if (source === 'plain') latex = plainToLatex(text);
  else if (source === 'latex') latex = text.trim();
  else latex = mathmlToLatex(text);
  // Every conversion goes through MathML once, so broken LaTeX is reported here.
  const mathml = latexToMathml(latex);
  const output = to === 'latex' ? latex : to === 'plain' ? latexToPlain(latex) : mathml;
  return { source, latex, output };
}

function runConvert() {
  const input = $('convert-input').value;
  const names = { plain: 'plain text', latex: 'LaTeX', mathml: 'MathML' };
  try {
    const { source, latex, output } = convertMath(input, $('convert-from').value, $('convert-to').value);
    convertLatex = latex;
    $('convert-output').value = output;
    $('convert-error').textContent = '';
    $('convert-preview').replaceChildren(latex ? mathSpan(latex, true) : '');
    $('convert-from').options[0].textContent = input.trim() ? `Find out automatically (this looks like ${names[source]})` : 'Find out automatically';
  } catch (error) {
    convertLatex = '';
    $('convert-output').value = '';
    $('convert-preview').replaceChildren();
    $('convert-error').textContent = `Cannot convert: ${error.message}`;
  }
}

function openConvert() {
  const sel = getSelection();
  convertRange = sel.rangeCount && doc.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
  const eq = equationAtCaret();
  const selected = sel.toString().trim();
  if (eq) { $('convert-input').value = eq.dataset.latex; $('convert-from').value = 'latex'; }
  else if (selected && doc.contains(sel.anchorNode)) { $('convert-input').value = selected; $('convert-from').value = 'auto'; }
  runConvert();
  $('convert-dialog').showModal();
  $('convert-input').focus();
  $('convert-input').select();
}

async function copyConverted() {
  const text = $('convert-output').value;
  if (!text) { $('convert-error').textContent = 'There is nothing to copy yet.'; return; }
  try {
    if (desktop) await desktop.copyText(text); else await navigator.clipboard.writeText(text);
    $('convert-error').textContent = `Copied the ${$('convert-to').selectedOptions[0].textContent} result.`;
  } catch (error) {
    $('convert-error').textContent = `Could not copy: ${error.message}`;
  }
}

function insertConverted() {
  if (!convertLatex) { $('convert-error').textContent = 'There is no equation to insert yet.'; return; }
  $('convert-dialog').close('insert');
  doc.focus();
  const sel = getSelection();
  sel.removeAllRanges();
  if (convertRange && doc.contains(convertRange.startContainer)) sel.addRange(convertRange);
  else { const r = document.createRange(); r.selectNodeContents(doc); r.collapse(false); sel.addRange(r); }
  const range = sel.getRangeAt(0);
  const eq = equationAtCaret();
  const span = mathSpan(convertLatex);
  if (eq && range.collapsed && eq.dataset.latex === $('convert-input').value.trim()) eq.after(span);
  else { range.deleteContents(); range.insertNode(span); }
  placeCaretAfter(span);
  tidy();
  setDirty(true);
  say(`Equation inserted: ${latexToPlain(convertLatex)}`);
}

$('convert-input').addEventListener('input', runConvert);
$('convert-from').addEventListener('change', runConvert);
$('convert-to').addEventListener('change', runConvert);
// Copy result is the default button: Enter in the choices copies instead of closing.
$('convert-form').addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'copy') return;
  e.preventDefault();
  copyConverted();
});
$('convert-insert').addEventListener('click', insertConverted);
$('convert-dialog').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); copyConverted(); } });
$('convert-dialog').addEventListener('close', () => { if ($('convert-dialog').returnValue !== 'insert') doc.focus(); $('convert-dialog').returnValue = ''; });

// ---------- pasting ----------

// Pasted web pages and documents keep their headings, lists, tables, bold and italic, and
// their MathML becomes real equations; their styles, scripts and pictures are left out.
doc.addEventListener('paste', (e) => {
  const html = e.clipboardData?.getData('text/html');
  if (!html) return; // plain text pastes as plain text
  e.preventDefault();
  const holder = el('div');
  holder.append(...cleanNodes(html, PASTE_ATTRS));
  // A marker at the end puts the caret right after the pasted text (Chromium otherwise can
  // leave it on a copy of the last equation that is not in the document, where typing fails).
  holder.append(el('span', { 'data-paste-end': '' }, '​')); // not empty, or Chromium drops it
  document.execCommand('insertHTML', false, holder.innerHTML);
  // Keep the notebook's own equation spans whole (their MathML has no editable text).
  for (const span of doc.querySelectorAll('.eq:not([contenteditable])')) span.setAttribute('contenteditable', 'false');
  const end = doc.querySelector('[data-paste-end]');
  if (end) {
    const range = document.createRange();
    range.setStartBefore(end);
    range.collapse(true);
    const parent = end.parentNode;
    end.remove();
    parent.normalize();
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }
  setDirty(true);
});

async function pastePlain() {
  if (!desktop) return;
  const text = await desktop.readText();
  if (!inDocument()) doc.focus();
  document.execCommand('insertText', false, text);
  setDirty(true);
}

// ---------- settings (Settings menu) ----------

let settingsReturn = null;
let savedSettings = null;

async function loadSettings() {
  savedSettings = await api('/api/settings');
  graphMode.applySettings(savedSettings.values);
  return savedSettings;
}

// The AI is an add-on. Not installed: its choices are not shown, a line says so. Installed:
// one switch turns it on or off, and its choices are shown only while it is on.
function showAiChoices() {
  const installed = savedSettings?.ai_installed !== false;
  $('settings-no-ai').hidden = installed;
  $('use-ai-label').hidden = !installed;
  $('settings-ai-choices').hidden = !installed || !$('set-use_ai').checked;
  $('reading-ai-choice').hidden = !installed || !$('set-use_ai').checked;
}
$('set-use_ai').addEventListener('change', showAiChoices);

function fillSettings({ values, models }) {
  const modelChoices = (select, allowNone) => {
    select.replaceChildren(...(allowNone ? [el('option', { value: '' }, 'None')] : []), ...models.map((m) => el('option', { value: m }, m)));
  };
  modelChoices($('set-reading_model'), false);
  modelChoices($('set-second_model'), true);
  for (const [name, value] of Object.entries(values)) {
    const control = $(`set-${name}`);
    if (!control) continue;
    if (control.type === 'checkbox') { control.checked = Boolean(value); continue; }
    if (![...control.options].some((o) => o.value === String(value))) control.append(el('option', { value: String(value) }, String(value)));
    control.value = String(value);
  }
  showAiChoices();
}

// Each part of Settings is its own small dialog: Reading PDFs, AI add-on, Graph sound.
const SETTINGS_PARTS = { reading: 'Reading PDFs', ai: 'AI add-on', writing: 'Writing', sound: 'Graph sound' };
async function openSettings(section) {
  if (!SETTINGS_PARTS[section]) section = 'reading';
  for (const part of Object.keys(SETTINGS_PARTS)) $(`settings-${part}`).hidden = part !== section;
  $('settings-title').textContent = `Settings: ${SETTINGS_PARTS[section]}`;
  settingsReturn = document.activeElement;
  try {
    fillSettings(await loadSettings());
  } catch (error) {
    say(`Settings could not be loaded: ${error.message}`);
    return;
  }
  $('settings-error').textContent = '';
  $('settings-dialog').showModal();
  const installed = savedSettings.ai_installed !== false;
  const first = { sound: 'set-sound_profile', writing: 'set-enter_copies_equation', ai: installed ? 'set-use_ai' : null, reading: installed && $('set-use_ai').checked ? 'set-reading_method' : 'set-pages_at_once' }[section];
  (first ? $(first) : $('settings-save')).focus();
}

function settingsFromForm() {
  const out = {};
  for (const control of $('settings-form').querySelectorAll('[name]')) {
    if (control.name === 'use_ai' && savedSettings?.ai_installed === false) continue; // no add-on, no switch
    if (control.type === 'checkbox') out[control.name] = control.checked;
    else out[control.name] = control.hasAttribute('data-number') ? Number(control.value) : control.value;
  }
  return out;
}

async function saveSettings() {
  const before = savedSettings?.values || {};
  try {
    const result = await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settingsFromForm()) });
    savedSettings = result;
    graphMode.applySettings(result.values);
    $('settings-dialog').close();
    const readingChanged = ['reading_method', 'reading_model', 'second_model'].some((k) => before[k] !== result.values[k]);
    say(`Settings saved.${readingChanged ? ' PDFs you import from now on are read the new way; pages already in the document stay as they are.' : ''}`);
  } catch (error) {
    $('settings-error').textContent = error.message;
  }
}

async function resetSettings(askFirst = true) {
  if (askFirst && !confirm('Put every setting back to its default?')) return;
  try {
    const result = await api('/api/settings/reset', { method: 'POST' });
    savedSettings = result;
    graphMode.applySettings(result.values);
    if ($('settings-dialog').open) fillSettings(result);
    say('All settings are back to their defaults.');
  } catch (error) {
    say(`Settings could not be reset: ${error.message}`);
  }
}

$('settings-form').addEventListener('submit', (e) => {
  if (e.submitter?.value === 'save') { e.preventDefault(); saveSettings(); }
});
$('settings-defaults').addEventListener('click', () => resetSettings(true));
// Hearing a sound before choosing it: a few notes as you move through the list, a whole example with Listen.
$('set-sound_profile').addEventListener('change', () => graphMode.preview(settingsFromForm(), true));
$('sound-listen').addEventListener('click', () => say(graphMode.preview(settingsFromForm())));
$('settings-dialog').addEventListener('close', () => { (settingsReturn && document.contains(settingsReturn) ? settingsReturn : doc).focus(); });

// ---------- the sound guide (Help > Sound guide, or Settings > Graph sound) ----------

// [name, what it is, what you hear]. The names are graph-mode.js guide()'s.
function guideSounds(dots) {
  const newDots = dots !== 'original';
  return [
    ['above', 'Above zero', 'A clear note. The higher the curve, the higher the note: here 1, 3 and 6.'],
    ['zero', 'At zero', 'The middle note: zero, home.'],
    ['below', 'Below zero', 'A warmer, lower note, lower as the curve goes down: minus 1, minus 3, minus 6.'],
    ['up', 'Going up', 'Steps along a rising curve: each note a little higher, sliding up from the last.'],
    ['down', 'Going down', 'Steps along a falling curve, through zero and below it.'],
    ['leftright', 'Left and right', 'Where you are along x: the left of the graph in your left ear, the right in your right ear.'],
    ['gear', 'Past 10', 'Above 10 the notes start again from low, and a small tick marks the change.'],
    ['bass', 'The bass line', 'While playing with Space, a soft low line follows the curve under the notes.'],
    ['peak', 'A peak', 'A swell that rises: the highest point nearby.'],
    ['valley', 'A valley', 'A swell that falls: the lowest point nearby.'],
    ['x-axis', 'Crossing the x-axis', 'A soft tick where the curve crosses zero.'],
    ['y-axis', 'Crossing the y-axis', 'A tick in the middle, where x is zero.'],
    ['origin', 'The origin', 'A soft chime at 0, 0.'],
    ['solid', 'A solid dot', newDots ? 'A small bump: a point that is on the graph.' : 'A held tone: a point that is on the graph.'],
    ['open', 'An open dot, a hole', newDots ? 'A breath of wind: the curve goes up to it, but the point is missing.' : 'A breath of air: the point is missing.'],
    ['corner', 'A sharp corner', newDots ? 'A slide down then up (a V), or up then down (a peak with a point).' : 'No sound of its own with the original dot sounds.'],
    ['asymptote', 'No curve here', 'A low knock: an asymptote, or a place the function is not defined.'],
    ['end', 'Where the curve ends', newDots ? 'A smaller bump (the end point is included) or wind (it is not).' : 'The point sound, softer.'],
    ['slope', 'The slope sound', 'D in graph mode. After each note, a soft second note for the slope: high is rising, the middle note is flat, low is falling. Here y = x squared: the slope note climbs from low, through the middle note at the valley, to high.'],
  ];
}
const QUIZ = ['up', 'down', 'peak', 'valley', 'x-axis', 'origin', 'solid', 'open', 'corner', 'asymptote', 'above', 'below'];
let guideValues = null;
let quizAnswer = null;
let guideReturn = null;

function openSoundGuide(values = null) {
  guideValues = values || savedSettings?.values || {};
  const list = $('sound-guide-list');
  list.replaceChildren();
  const sounds = guideSounds(guideValues.dot_sounds);
  for (const [name, title, words] of sounds) {
    const id = `guide-${name}`;
    const button = el('button', { type: 'button', 'data-sound': name, 'aria-describedby': id }, `Play: ${title}`);
    const item = el('div', { class: 'guide-item' });
    item.append(button, el('p', { id, class: 'hint' }, words));
    list.append(item);
  }
  const answers = $('sound-quiz-answers');
  answers.replaceChildren(...QUIZ.map((name) => el('button', { type: 'button', 'data-answer': name }, sounds.find((s) => s[0] === name)[1])));
  answers.hidden = true;
  $('sound-quiz-result').textContent = '';
  quizAnswer = null;
  guideReturn = document.activeElement;
  $('sound-guide-dialog').showModal();
  list.querySelector('button').focus();
}
$('sound-guide-list').addEventListener('click', (e) => {
  const name = e.target.closest('button')?.dataset.sound;
  if (name) graphMode.guide(name, guideValues);
});
$('sound-quiz-play').addEventListener('click', () => {
  quizAnswer = QUIZ[Math.floor(Math.random() * QUIZ.length)];
  graphMode.guide(quizAnswer, guideValues);
  $('sound-quiz-answers').hidden = false;
  $('sound-quiz-result').textContent = 'Which sound was it? Choose below, or play it again with the same button.';
  $('sound-quiz-play').textContent = 'Play a new mystery sound';
});
$('sound-quiz-answers').addEventListener('click', (e) => {
  const name = e.target.closest('button')?.dataset.answer;
  if (!name || !quizAnswer) return;
  const title = (n) => guideSounds(guideValues.dot_sounds).find((s) => s[0] === n)[1];
  $('sound-quiz-result').textContent = name === quizAnswer ? `Right: ${title(quizAnswer)}.` : `Not quite: that was ${title(quizAnswer)}. Play a new one when you are ready.`;
  graphMode.guide(quizAnswer, guideValues);
  quizAnswer = name === quizAnswer ? null : quizAnswer;
  if (!quizAnswer) $('sound-quiz-answers').hidden = true;
  $('sound-quiz-play').focus();
});
$('sound-guide-close').addEventListener('click', () => $('sound-guide-dialog').close());
$('sound-guide-dialog').addEventListener('close', () => { if (guideReturn && document.contains(guideReturn)) guideReturn.focus(); else backToDocument(); });
$('sound-guide-open').addEventListener('click', () => openSoundGuide(settingsFromForm()));

// ---------- keys inside the document ----------

doc.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
    // Enter on a graph line explores it; on an equation line it edits the equation.
    // Next to an equation inside text, Enter is a normal new line (Ctrl+E edits).
    const block = currentBlock();
    if (block?.classList.contains('graph-line')) { e.preventDefault(); exploreGraph(block); return; }
    if (block?.classList.contains('eq-line')) {
      const eq = block.querySelector('.eq');
      // After the equation (where converting a line leaves the cursor), Enter starts a new
      // line, as in Word; before it, Enter edits the equation. Ctrl+E edits it from anywhere.
      if (eq && caretAfter(eq)) { e.preventDefault(); newLineAfter(block); return; }
      if (eq) { e.preventDefault(); openEquation(eq); return; }
    }
    // Enter again on the blank line under an equation: the equation comes down to the next
    // line, with this line left blank between them (Settings > Writing can turn this off).
    if (savedSettings?.values?.enter_copies_equation !== false && isBlankLine(block) && endsWithEquation(block.previousElementSibling)) {
      e.preventDefault();
      newLineAfter(block);
      copyEquationDown();
      return;
    }
  }
  // Enter on an empty list item ends the list there, as in Word.
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
    const li = listItem();
    if (li && !li.textContent.trim() && !li.querySelector('.eq, ul, ol')) {
      e.preventDefault();
      let made = null;
      keepCaret(() => { made = listItemToParagraph(li); }, () => made);
      setDirty(true);
      say('List ended.');
      return;
    }
  }
  // Tab moves between table cells and indents list items, as in Word.
  if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
    if (currentCell()) { e.preventDefault(); moveCell(e.shiftKey ? -1 : 1); return; }
    if (listItem()) { e.preventDefault(); indentListItem(e.shiftKey); return; }
  }
});

// The page runs these shortcuts itself, wherever the focus is (document or toolbar); the
// menu bar shows them but does not also catch them (main.cjs), so each runs once. Chromium
// would otherwise do Ctrl+B, I and U on its own without saying anything. Dialogs and graph
// mode keep their own keys.
const shortcutOf = (e) => `${e.ctrlKey ? 'Ctrl+' : ''}${e.shiftKey ? 'Shift+' : ''}${e.altKey ? 'Alt+' : ''}${e.key.length === 1 ? e.key.toUpperCase() : e.key}`;
document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.target.closest?.('dialog, #graph-mode')) return;
  const shortcut = shortcutOf(e);
  const command = DOCUMENT_KEYS[shortcut] || (!desktop && FALLBACK_KEYS[shortcut]);
  if (command) { e.preventDefault(); run(command); }
});
window.pageKeys = () => Object.keys(DOCUMENT_KEYS); // the menu bar leaves these to the page
// Loose text or equations straight in the document go into a paragraph as they appear.
function tidy() {
  const loose = [...doc.childNodes].some((n) => isInline(n) && (n.nodeType !== Node.TEXT_NODE || n.textContent.trim()));
  if (loose) keepCaret(wrapLooseInline);
}
// Enter copies a line's marks onto the new line. A new empty line is a fresh line: it is not
// hidden from students and has no review note (splitting a line keeps them on both halves).
const LINE_MARKS = ['data-teacher', 'data-warning', 'data-student-note', 'data-figure', 'data-page'];
function freshLine(block) {
  if (!block || block.textContent.trim() || block.querySelector('.eq')) return;
  for (const name of LINE_MARKS) block.removeAttribute(name);
  block.classList.remove('warned', 'waiting', 'figure-line');
}
doc.addEventListener('input', (e) => {
  setDirty(true);
  if (e.inputType === 'insertParagraph') {
    const block = currentBlock();
    freshLine(block);
    freshLine(block?.previousElementSibling);
  }
  tidy();
});
doc.addEventListener('click', (e) => {
  const eq = e.target.closest?.('.eq');
  if (eq) openEquation(eq);
  const graph = e.target.closest?.('.graph-line');
  if (graph && e.detail === 2) exploreGraph(graph);
});

// ---------- commands (from the menu bar) ----------

const COMMANDS = {
  new: () => {
    if (dirty && !confirm('Discard the unsaved changes?')) return;
    const p = el('p');
    p.append(el('br'));
    doc.replaceChildren(p);
    graphs.clear(); filePath = null; docName = 'Untitled'; setDirty(false); doc.focus(); placeCaretIn(p); say('New document.');
  },
  open: async () => {
    if (!desktop) return;
    if (dirty && !confirm('Discard the unsaved changes?')) return;
    const file = await desktop.openNotebook();
    if (file) try { loadNotebook(file.content, file.path); } catch (error) { say(`Could not open: ${error.message}`); }
  },
  importPdf: async () => {
    fetch('/api/warm', { method: 'POST' }).catch(() => {}); // model loads while the file is chosen
    const path = desktop ? await desktop.choosePdf() : prompt('PDF path');
    importPdf(path);
  },
  save: () => save(false),
  saveAs: () => save(true),
  exportHtml,
  exportDocx,
  exportPdf,
  print: () => (desktop ? desktop.print() : window.print()),
  pastePlain,
  find: () => openFind(false),
  replace: () => openFind(true),
  findNext: () => findAgain(1),
  findPrevious: () => findAgain(-1),
  wordCount,
  nextHeading: () => goToHeading(1),
  previousHeading: () => goToHeading(-1),
  headingList: openHeadingList,
  bold: () => format('bold', 'Bold'),
  italic: () => format('italic', 'Italic'),
  underline: () => format('underline', 'Underline'),
  bulletList: () => toggleList(false),
  numberedList: () => toggleList(true),
  pageBreak,
  insertTable: openTableDialog,
  tableAddRow: () => tableCommand('addRow'),
  tableAddColumn: () => tableCommand('addColumn'),
  tableDeleteRow: () => tableCommand('deleteRow'),
  tableDeleteColumn: () => tableCommand('deleteColumn'),
  tableDelete: () => tableCommand('deleteTable'),
  convertMath: openConvert,
  importTex,
  copyGraphLatex,
  graphPlay: () => graphCommand('play'),
  graphNextPoint: () => graphCommand('next'),
  graphPreviousPoint: () => graphCommand('previous'),
  graphDescribe: () => graphCommand('describe'),
  graphReadPoint: () => graphCommand('read'),
  graphStep: () => graphCommand('step'),
  graphNextFunction: () => graphCommand('function'),
  graphClose: () => graphCommand('close'),
  copyEquationDown,
  soundGuide: () => openSoundGuide(),
  settingsWriting: () => openSettings('writing'),
  graphSlope: () => graphCommand('slope'),
  graphLimits: () => graphCommand('limits'),
  graphSlopeSound: () => graphCommand('slopeSound'),
  teacherMode: () => setTeacherMode(!teacherMode),
  hideLine: hideLines,
  hideWords,
  answerBox: insertAnswerBox,
  studentGraph: openStudentGraph,
  studentPreview: () => togglePreview(),
  saveStudentCopy,
  exportStudentDocx,
  exportStudentPdf,
  heading3: () => setBlockType('h3'),
  insertEquation: () => openEquation(null),
  insertGraph: openGraphDialog,
  heading1: () => setBlockType('h1'),
  heading2: () => setBlockType('h2'),
  normalText: () => setBlockType('p'),
  editEquation: () => { const eq = equationAtCaret(); if (eq) openEquation(eq); else say('Move next to an equation first.'); },
  readLine,
  toEquation: lineToEquation,
  toPlainText: equationToText,
  exploreGraph: () => exploreGraph(),
  nextNote: () => moveToWarning(1),
  previousNote: () => moveToWarning(-1),
  clearNote: clearWarning,
  keys: () => { if (!showDialogHelp()) showKeys(); }, // F1 in a dialog is that dialog's help
  settings: () => openSettings('reading'),
  settingsReading: () => openSettings('reading'),
  settingsAi: () => openSettings('ai'),
  settingsSound: () => openSettings('sound'),
  settingsReset: () => resetSettings(true),
};

// Shortcuts the document itself handles, desktop app or not (they edit at the caret).
const DOCUMENT_KEYS = {
  'Ctrl+B': 'bold', 'Ctrl+I': 'italic', 'Ctrl+U': 'underline', 'Ctrl+Shift+L': 'bulletList', 'Ctrl+Shift+&': 'numberedList',
  'Ctrl+Shift+7': 'numberedList', 'Ctrl+Enter': 'pageBreak', 'Ctrl+Alt+1': 'heading1', 'Ctrl+Alt+2': 'heading2', 'Ctrl+Alt+3': 'heading3',
  'Ctrl+Alt+0': 'normalText', 'Ctrl+Shift+E': 'toEquation', 'Ctrl+E': 'editEquation', 'Alt+=': 'insertEquation', 'Ctrl+F': 'find',
  'Ctrl+H': 'replace', F3: 'findNext', 'Shift+F3': 'findPrevious', 'Ctrl+Shift+M': 'convertMath', 'Ctrl+Shift+W': 'exportDocx',
  F1: 'keys', 'Ctrl+G': 'exploreGraph', 'Ctrl+Shift+G': 'insertGraph', 'Ctrl+F9': 'hideWords', 'Ctrl+Shift+F9': 'hideLine', 'Ctrl+Shift+V': 'pastePlain', F11: 'copyEquationDown', 'Ctrl+PageDown': 'nextHeading', 'Ctrl+PageUp': 'previousHeading', 'Ctrl+Shift+H': 'headingList',
};

// Without the desktop menu bar (tests in a plain browser), the menu's other shortcuts work here too.
const FALLBACK_KEYS = {
  'Alt+=': 'insertEquation', 'Ctrl+E': 'editEquation', 'Ctrl+Shift+E': 'toEquation', 'Ctrl+Shift+T': 'toPlainText',
  'Ctrl+Shift+R': 'readLine', 'Ctrl+G': 'exploreGraph', 'Ctrl+Shift+G': 'insertGraph', F8: 'nextNote', 'Shift+F8': 'previousNote',
  'Ctrl+Alt+1': 'heading1', 'Ctrl+Alt+2': 'heading2', 'Ctrl+Alt+3': 'heading3', 'Ctrl+Alt+0': 'normalText', F1: 'keys', 'Ctrl+,': 'settings',
  'Ctrl+B': 'bold', 'Ctrl+I': 'italic', 'Ctrl+U': 'underline', 'Ctrl+Shift+L': 'bulletList', 'Ctrl+Shift+&': 'numberedList', 'Ctrl+Shift+7': 'numberedList',
  'Ctrl+Enter': 'pageBreak', 'Ctrl+F': 'find', 'Ctrl+H': 'replace', F3: 'findNext', 'Shift+F3': 'findPrevious', 'Ctrl+Shift+M': 'convertMath',
};


function run(name) {
  const command = COMMANDS[name];
  // While a dialog is open its own keys win: Ctrl+Enter there is the dialog's, not a page
  // break, and Ctrl+B in the Find box must not make the document bold.
  if (command && document.querySelector('dialog[open]') && name !== 'keys') return;
  if (command && studentView && !PREVIEW_SAFE.has(name)) { say('This is the student preview. To change the document, turn the preview off: Teacher menu, Preview student copy.'); return; }
  if (command) command();
}
window.runCommand = run; // used by the desktop bridge and by tests
window.notebookImport = importPdf; // used by tests
desktop?.onCommand(run);
window.isDirty = () => dirty; // asked by the desktop window before it closes
window.saveForClose = async () => { await save(false); return !dirty; };

// Start with an empty page ready for typing.
loadSettings().catch(() => {}); // graph sounds follow the saved settings
// Enter makes a new paragraph (<p>), not Chromium's default <div>, so every line is a real paragraph.
document.execCommand('defaultParagraphSeparator', false, 'p');

// The caret never stays inside an equation's MathML (nothing there can be typed): it goes
// just after the equation.
document.addEventListener('selectionchange', () => {
  const sel = getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return;
  // Only while typing in the document: moving the selection would also move the keyboard
  // focus back into it, away from graph mode or a dialog.
  if (!doc.contains(sel.anchorNode) || document.activeElement !== doc) return;
  const node = sel.anchorNode.nodeType === Node.ELEMENT_NODE ? sel.anchorNode : sel.anchorNode.parentElement;
  const eq = node?.closest('.eq');
  if (eq && eq !== doc) placeCaretAfter(eq);
});

const first = el('p');
first.append(el('br'));
doc.append(first);
setDirty(false);
doc.focus();
placeCaretIn(first); // typing goes into the first paragraph, not loose in the document
say('Math Notebook. Alt opens the menus; F1 lists the keys.');
