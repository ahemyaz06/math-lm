// Math Notebook editor: one editable document, like a word processor. Commands come
// from the desktop app's menu bar (Alt), so the page itself has no buttons.
import temml from './vendor/temml.mjs';
import { parseBlocks, tableCells } from './markdown.js';
import { plainToLatex, latexToPlain, splitComment, splitDomain } from './equation.js';
import { mathmlToLatex, latexToMathml } from './mathml.js';
import { makeDocx } from './docx.js';
import { brailleHtml } from './braille.js';
import { makeGraph, studentGraph, HIDEABLE, parseCondition } from './graphs.js';
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

let lastSaid = { text: '', at: 0 };
function say(text) {
  lastSaid = { text, at: Date.now() };
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
    // A one-letter <mi> is drawn in italics by Chromium swapping x for the maths letter 𝑥, and
    // that swapped letter is what NVDA gets in focus mode (it says "normalized"). The CSS turns
    // the swap off (editor.css); these letters are put in italics the plain way instead.
    for (const mi of span.querySelectorAll('mi')) {
      if (!mi.hasAttribute('mathvariant') && /^[A-Za-zα-ω]$/u.test(mi.textContent)) mi.classList.add('tml-italic');
    }
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
  settleEquationText();
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
  'data-teacher', 'data-student-note', 'start', 'data-level']);
// Pasted from web pages and other programs: only the structure is kept, never their styles or classes.
const PASTE_ATTRS = new Set(['scope', 'start']);

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
  markComments(target); // a saved file keeps the class; the role is put back here
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
  settleEquationText();
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
      // Items carry their level; nested levels become lists inside the item above. A list that
      // goes on after a picture starts at its next number, at the level it stopped at.
      const root = el(b.ordered ? 'ol' : 'ul');
      const base = b.items[0]?.level || 0;
      if (b.start && b.ordered) root.start = b.start;
      if (base) root.dataset.level = base;
      const stack = [root];
      for (const item of b.items) {
        const level = Math.max(0, item.level - base);
        while (stack.length - 1 > level) stack.pop();
        while (stack.length - 1 < level) {
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
  const name = file.path.split(/[\\/]/).pop();
  doc.focus();
  placeCaretIn(nodes[0] || doc);
  say(`Imported ${name}: ${equations} ${equations === 1 ? 'equation' : 'equations'}${graphCount ? `, ${graphCount} ${graphCount === 1 ? 'graph' : 'graphs'} you can explore by sound` : ''}.`
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
  if (root === doc) { settleEquationText(); wrapLooseInline(); }
  const blocks = [];
  for (const node of root.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.textContent.trim()) blocks.push({ type: 'paragraph', runs: [{ text: node.textContent }] });
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = node.tagName;
    if (/^H[1-6]$/.test(tag)) blocks.push({ type: 'heading', level: Number(tag[1]), runs: inlineRuns(node) });
    else if (tag === 'UL' || tag === 'OL') {
      // A list that goes on after a picture keeps its first number and its level.
      const list = listBlocks(node, Number(node.dataset.level) || 0);
      if (tag === 'OL' && node.start > 1) list.start = node.start;
      blocks.push(list);
    } else if (tag === 'HR') blocks.push({ type: 'pageBreak' });
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

// File > Export as braille: BrailleBlaster makes the .brf from the document's headings, text and
// MathML equations (braille.js, braille.py). It has to be installed; the notebook says so if not.
async function exportBraille() {
  if (!desktop) { say('Exporting needs the desktop app.'); return; }
  const page = brailleHtml(documentBlocks(), docName);
  say('Making braille with BrailleBlaster. A long document takes a minute or two.');
  const result = await desktop.exportBraille({ name: `${docName}.brf`, page });
  if (!result) { say('Braille export cancelled.'); return; }
  if (result.error) { say(result.error); return; }
  const name = result.path.split(/[\\/]/).pop();
  const odd = result.not_six_dot || [];
  say((result.nemeth
    ? `Exported ${name}: UEB with Nemeth maths, as BrailleBlaster is set.`
    : `Exported ${name} in ${result.standard}, as BrailleBlaster is set. For Nemeth maths, choose UEB with Nemeth (UEB-PLUS-NEMETH) in BrailleBlaster's Translation settings and export again.`)
    + (odd.length ? ` ${odd.length} ${odd.length === 1 ? 'line has' : 'lines have'} a cell that is not 6-dot braille (BrailleBlaster could not braille something there, often a matrix): line ${odd.join(', ')} of the file.` : ''));
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
  if (all.length === 1 && block.classList.contains('eq-line')) return all[0];
  // In the comment after an equation, the equation is the one meant (Ctrl+E, Ctrl+G).
  return block?.tagName === 'P' ? commentedEquation(block) : null;
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

// The equation as plain text, or null when plain text cannot hold it (a piecewise function from
// a PDF or .tex file): then it is edited as LaTeX, so pressing Enter cannot break it.
const NO_PLAIN = 'Plain text cannot write all of this equation, so it is shown as LaTeX.';
function plainFor(latex) {
  const plain = latexToPlain(latex);
  try { plainToLatex(splitComment(plain).code); return plain; } catch { return null; }
}

function openEquation(target) {
  equationTarget = target;
  const sel = getSelection();
  equationRange = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  const input = $('equation-text');
  const plain = target ? plainFor(target.dataset.latex) : '';
  latexMode = plain === null;
  input.value = latexMode ? target.dataset.latex : plain;
  $('equation-label').textContent = latexMode ? 'Equation as LaTeX' : 'Equation as plain text';
  $('equation-error').textContent = '';
  preview();
  if (latexMode) $('equation-error').textContent = NO_PLAIN;
  $('equation-dialog').showModal();
  input.focus();
}

// The typed maths without its comment (# or // to the end), which goes beside the equation.
function currentLatex() {
  const { code } = splitComment($('equation-text').value);
  return latexMode ? code : plainToLatex(code);
}

// A comment after an equation: words in the document, never part of the maths. It is marked
// as a comment (role="comment"), so a screen reader can say "comment" before it.
function commentSpan(text) {
  const span = el('span', { class: 'comment', role: 'comment' });
  if (typeof text === 'string') span.textContent = text; else span.append(text);
  return span;
}
function addComment(after, comment) {
  if (!comment) return null;
  const span = commentSpan(comment);
  after.after(' ', span);
  return span;
}

// Comments typed straight after an equation (or in a saved notebook) get the same mark. The
// text node is moved into the mark, and the cursor typing in it is put back where it was.
function markComments(root = doc) {
  for (const span of root.querySelectorAll('span.comment')) span.setAttribute('role', 'comment');
  for (const eq of root.querySelectorAll('.eq')) {
    let n = eq.nextSibling;
    while (n?.nodeType === Node.TEXT_NODE && !n.textContent.trim() && n.nextSibling) n = n.nextSibling;
    if (n?.nodeType !== Node.TEXT_NODE || n.parentElement?.closest('.comment')) continue;
    const m = /^(\s*)(#|\/\/|%)/.exec(n.textContent);
    if (!m) continue;
    const sel = getSelection();
    let caret = sel.rangeCount && sel.isCollapsed && sel.anchorNode === n ? sel.anchorOffset : null;
    if (m[1]) { // the space before it stays outside
      n = n.splitText(m[1].length);
      if (caret !== null) caret = caret >= m[1].length ? caret - m[1].length : null;
    }
    const span = commentSpan('');
    n.replaceWith(span);
    span.append(n);
    if (caret !== null) {
      const r = document.createRange();
      r.setStart(n, caret);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }
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
    const plain = latexMode ? plainFor(latex) : null;
    if (latexMode && plain === null) { $('equation-error').textContent = NO_PLAIN; say(NO_PLAIN); return; }
    latexMode = !latexMode;
    $('equation-text').value = latexMode ? latex : plain;
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
  const { comment } = splitComment($('equation-text').value);
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
  addComment(span, comment);
  doc.focus();
  placeCaretAfter(span);
  tidy();
  setDirty(true);
  say(`Equation: ${latexToPlain(latex)}${comment ? `. Comment: ${comment}` : ''}`);
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
  for (const typed of text.split('\n')) {
    const line = splitComment(typed).code; // y = sin x # a wave: the comment is not graphed
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
  onKeys: () => showKeys('graph'),
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

// Typed maths as LaTeX: plain text (x^2/2) is converted; LaTeX text (\frac{x^2}{2}, from
// Ctrl+L) is kept as it is, once it is checked to be LaTeX that can be shown.
function typedToLatex(text) {
  const source = text.trim();
  if (/\\[A-Za-z]|[_^]\{/.test(source)) {
    try { temml.renderToString(source, { throwOnError: true }); } catch (error) { throw new Error(`This LaTeX has a mistake: ${String(error.message).replace(/^Temml parse error:\s*/i, '')}`); }
    return source;
  }
  return plainToLatex(source);
}

function selectionToEquation() {
  const sel = getSelection();
  const { code: text, comment } = splitComment(sel.toString().trim());
  if (!text) { say('Select the math you typed first, for example x^2 - 4.'); return; }
  let latex;
  try { latex = typedToLatex(text); } catch (error) { say(`Could not convert: ${error.message}`); return; }
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const span = mathSpan(latex);
  range.insertNode(span);
  addComment(span, comment);
  placeCaretAfter(span);
  tidy();
  setDirty(true);
  say(`Converted to an equation: ${latexToPlain(latex)}${comment ? `. Comment kept as text: ${comment}` : ''}`);
}

function lineToEquation() {
  const block = currentBlock();
  if (!block || block.querySelector('.eq') || !block.textContent.trim()) { selectionToEquation(); return; }
  if (getSelection().toString()) { selectionToEquation(); return; }
  // y = x^2 # the parabola: the maths becomes the equation, the comment stays text after it.
  const { code, comment } = splitComment(block.textContent);
  if (!code.trim()) { say('This line is only a comment. Write the maths before the # or //.'); return; }
  let latex;
  try { latex = typedToLatex(code); } catch (error) { say(`Could not convert this line: ${error.message}`); return; }
  const line = equationLine(latex);
  addComment(line.firstChild, comment);
  block.replaceWith(line);
  placeCaretAfter(line.firstChild);
  setDirty(true);
  say(`This line is now an equation: ${latexToPlain(latex)}${comment ? `. Comment kept as text: ${comment}` : ''}`);
}

// Ctrl+L: the equation as its LaTeX, as text you can read and change letter by letter;
// Ctrl+Shift+E makes it an equation again.
function equationToLatexText() {
  const eq = equationAtCaret();
  if (!eq) { say('Move next to an equation first.'); return; }
  const text = document.createTextNode(eq.dataset.latex);
  eq.replaceWith(text);
  placeCaretAfter(text);
  setDirty(true);
  say(`Now LaTeX text: ${text.textContent}. Ctrl+Shift+E makes it an equation again.`);
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

// ---------- an interval for the equation (Ctrl+Shift+D): y = sin x, x in [0, 2pi] ----------

let intervalTarget = null;

// The equation's maths without its interval, and the interval as it was typed.
function withoutInterval(plain) {
  const domain = splitDomain(plain);
  if (domain) {
    const typed = domain.kind === 'interval'
      ? `${domain.interval.open}${domain.interval.lo}, ${domain.interval.hi}${domain.interval.close}`
      : domain.inner;
    return { main: domain.main, typed };
  }
  // y = x^2, 0 < x < 1: comparisons after a comma.
  const parts = plain.split(',');
  if (parts.length > 1 && parts.slice(1).every((p) => /[<>]/.test(p) && /\bx\b/.test(p))) return { main: parts[0].trim(), typed: parts.slice(1).join(', ').trim() };
  return { main: plain, typed: '' };
}

function openInterval() {
  const eq = equationAtCaret();
  if (!eq) { say('Move next to an equation first, for example y = sin x.'); return; }
  intervalTarget = eq;
  const { main, typed } = withoutInterval(latexToPlain(eq.dataset.latex));
  $('interval-about').textContent = `For the equation ${main}.`;
  $('interval-text').value = typed;
  $('interval-error').textContent = '';
  $('interval-dialog').showModal();
  $('interval-text').focus();
  $('interval-text').select();
}

// What was typed, as the words the equation gets: [0, 2pi], (0, pi], 0 < x <= pi, "0 to 2pi".
function intervalText(typed) {
  let text = typed.trim().replace(/^(x\s*(in|∈)|on|for)\s+/i, '').trim();
  const to = /^(.+?)\s+to\s+(.+)$/i.exec(text);
  if (to) text = `[${to[1].trim()}, ${to[2].trim()}]`;
  if (/^[[(]/.test(text)) return `x in ${text}`;
  if (/\bx\b/.test(text)) return text;
  throw new Error('Write the interval with brackets, for example [0, 2pi] or (0, pi], or as 0 < x < pi.');
}

function commitInterval() {
  const eq = intervalTarget;
  if (!eq || !doc.contains(eq)) { $('interval-dialog').close(); return; }
  const { main } = withoutInterval(latexToPlain(eq.dataset.latex));
  const typed = $('interval-text').value;
  let latex;
  try {
    if (!typed.trim()) latex = plainToLatex(main);
    else {
      const words = intervalText(typed);
      const range = parseCondition(words); // the same check the graph makes
      if (range.otherwise) throw new Error('That interval is every x; leave the box empty instead.');
      latex = plainToLatex(`${main}, ${words}`);
    }
  } catch (error) { $('interval-error').textContent = error.message; return; }
  $('interval-dialog').close();
  const span = mathSpan(latex, eq.dataset.display === 'true');
  eq.replaceWith(span);
  doc.focus();
  placeCaretAfter(span);
  setDirty(true);
  say(typed.trim() ? `Equation: ${latexToPlain(latex)}. Ctrl+G graphs it on this interval.` : `Interval taken away. Equation: ${latexToPlain(latex)}`);
}
$('interval-ok').addEventListener('click', (e) => { e.preventDefault(); commitInterval(); });
$('interval-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitInterval(); } });
$('interval-dialog').addEventListener('close', () => { if ($('interval-dialog').returnValue !== 'ok') doc.focus(); });

// ---------- spelling (F7), as in Word ----------
// The Windows spell checker, through the local server: the same one that draws the red
// underlines and gives the right-click suggestions. Equations and graph descriptions are not
// checked, and neither are the names of maths functions written as words (sin, ln, arcsin).

const MATH_WORDS = new Set(['sin', 'cos', 'tan', 'sec', 'csc', 'cot', 'arcsin', 'arccos', 'arctan', 'arcsec', 'arccsc', 'arccot',
  'sinh', 'cosh', 'tanh', 'asin', 'acos', 'atan', 'ln', 'log', 'exp', 'lim', 'sqrt', 'cbrt', 'dx', 'dy', 'dt', 'du', 'dz', 'inf',
  'pgfplots', 'latex', 'mathml', 'cdot', 'frac', 'infty', 'quad']);
const spell = { ignored: new Set(), errors: [], current: null, cursor: null, origin: null, wrapped: false };

// The document's lines as text, with where each text node starts in it. An equation between two
// pieces of text counts as a space, so the words on each side stay apart.
function spellLines() {
  const lines = new Map();
  let prev = null;
  for (const node of textNodes()) {
    if (node.parentElement.closest('.graph-line')) continue;
    const line = findLine(node);
    if (!lines.has(line)) { lines.set(line, { line, text: '', parts: [] }); prev = null; }
    const entry = lines.get(line);
    if (prev) {
      const between = document.createRange();
      between.setStart(prev, prev.length);
      between.setEnd(node, 0);
      if (between.cloneContents().querySelector('.eq, br, img')) entry.text += ' ';
    }
    entry.parts.push({ node, start: entry.text.length });
    entry.text += node.textContent;
    prev = node;
  }
  return [...lines.values()];
}

// A place in a line's text as a place in the document.
function spellPoint(entry, offset, end) {
  const part = entry.parts.findLast((p) => (end ? p.start < offset : p.start <= offset)) || entry.parts[0];
  return [part.node, Math.min(offset - part.start, part.node.length)];
}

async function checkSpelling() {
  const lines = spellLines();
  const { results } = await api('/api/spell', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ texts: lines.map((l) => l.text) }) });
  const out = [];
  lines.forEach((entry, i) => {
    for (const e of results[i] || []) {
      const word = e.word;
      if (e.action !== 'delete' && (word.length < 2 || /\d/.test(word) || MATH_WORDS.has(word.toLowerCase()) || spell.ignored.has(word))) continue;
      const range = document.createRange();
      range.setStart(...spellPoint(entry, e.start, false));
      range.setEnd(...spellPoint(entry, e.start + e.length, true));
      out.push({ ...e, range, line: entry });
    }
  });
  return out;
}

// The first mistake at or after the cursor; after the end, once more from the top to where it began.
function nextMistake(errors) {
  const after = (e, point) => e.range.compareBoundaryPoints(Range.START_TO_START, point) >= 0;
  const found = errors.find((e) => after(e, spell.cursor) && (!spell.wrapped || !after(e, spell.origin)));
  if (found || spell.wrapped) return found || null;
  spell.wrapped = true;
  spell.cursor = document.createRange();
  spell.cursor.setStart(doc, 0);
  return errors.find((e) => !after(e, spell.origin)) || null;
}

function contextOf(mistake) {
  const { text } = mistake.line;
  const from = Math.max(0, text.lastIndexOf(' ', Math.max(0, mistake.start - 50)));
  const to = text.indexOf(' ', Math.min(text.length, mistake.start + mistake.length + 50));
  return `${from > 0 ? '…' : ''}${text.slice(from, to < 0 ? text.length : to).trim()}${to >= 0 ? '…' : ''}`;
}

function describeMistake(m) {
  return m.action === 'delete' ? `Repeated word: ${m.word}.` : `Not in the dictionary: ${m.word}.`;
}

async function startSpelling() {
  const sel = getSelection();
  spell.origin = document.createRange();
  if (sel.rangeCount && doc.contains(sel.anchorNode)) spell.origin.setStart(sel.anchorNode, sel.anchorOffset); else spell.origin.setStart(doc, 0);
  // A word the cursor is in is checked too.
  spell.origin.collapse(true);
  spell.cursor = spell.origin.cloneRange();
  if (spell.origin.startContainer.nodeType === Node.TEXT_NODE) {
    const t = spell.origin.startContainer.textContent;
    let o = spell.origin.startOffset;
    while (o > 0 && /[\p{L}'’]/u.test(t[o - 1])) o -= 1;
    spell.cursor.setStart(spell.origin.startContainer, o);
    spell.origin.setStart(spell.origin.startContainer, o);
  }
  spell.wrapped = false;
  await showNextMistake(true);
}

async function showNextMistake(first = false) {
  let errors;
  try { errors = await checkSpelling(); } catch (error) { say(`Spelling cannot be checked: ${error.message}`); if ($('spell-dialog').open) $('spell-dialog').close(); return; }
  const m = nextMistake(errors);
  spell.current = m;
  if (!m) {
    if ($('spell-dialog').open) $('spell-dialog').close();
    doc.focus();
    const sel = getSelection();
    sel.removeAllRanges();
    if (doc.contains(spell.origin.startContainer)) sel.addRange(spell.origin.cloneRange());
    say(first && !errors.length ? 'No spelling mistakes found.' : 'The spelling check is complete.');
    return;
  }
  // The word is marked in the document while the box is open (the box has the keyboard, so it
  // cannot be selected); closing the box selects it.
  if (window.Highlight) CSS.highlights.set('spelling', new Highlight(m.range.cloneRange()));
  m.range.startContainer.parentElement?.scrollIntoView({ block: 'center' });
  $('spell-word').textContent = describeMistake(m);
  $('spell-context').textContent = `In: ${contextOf(m)}`;
  const list = $('spell-suggestions');
  list.replaceChildren();
  const options = m.action === 'delete' ? [{ label: `Delete the second "${m.word}"`, value: '' }] : m.suggestions.map((w) => ({ label: w, value: w }));
  for (const o of options) list.append(el('option', { value: o.value }, o.label));
  if (!options.length) list.append(el('option', { value: m.word, disabled: '' }, 'No suggestions'));
  list.selectedIndex = options.length ? 0 : -1;
  $('spell-to').value = options.length ? options[0].value : m.word;
  $('spell-change').textContent = m.action === 'delete' ? 'Delete' : 'Change';
  $('spell-change-all').disabled = m.action === 'delete';
  $('spell-add').disabled = m.action === 'delete';
  if (!$('spell-dialog').open) $('spell-dialog').showModal();
  (options.length ? list : $('spell-to')).focus();
  // The box's own description is read when it opens; after that, the next word is said here.
  if (!first) say(`${describeMistake(m)} In: ${contextOf(m)}. ${options.length ? `Suggestion: ${options[0].label}.` : 'No suggestions.'}`);
}

// Changes the mistake's words in the document; the cursor goes on after the new word.
function replaceMistake(m, word) {
  const range = m.range;
  if (m.action === 'delete') {
    // The repeated word and the space before it.
    const node = range.startContainer;
    if (node.nodeType === Node.TEXT_NODE) {
      let o = range.startOffset;
      while (o > 0 && /\s/.test(node.textContent[o - 1])) o -= 1;
      range.setStart(node, o);
    }
  }
  range.deleteContents();
  const text = document.createTextNode(word);
  if (word) range.insertNode(text);
  const after = document.createRange();
  if (word) after.setStartAfter(text); else after.setStart(range.startContainer, range.startOffset);
  after.collapse(true);
  return after;
}

async function spellAction(kind) {
  const m = spell.current;
  if (!m) return;
  if (kind === 'change' || kind === 'changeAll') {
    const word = m.action === 'delete' ? '' : $('spell-to').value.trim();
    if (m.action !== 'delete' && !word) { say('Write the word to change to first.'); $('spell-to').focus(); return; }
    if (kind === 'changeAll') {
      spell.cursor = m.range.cloneRange();
      spell.cursor.collapse(true);
      const all = (await checkSpelling()).filter((e) => e.word === m.word && e.action === m.action);
      for (const e of all.reverse()) replaceMistake(e, word);
      say(`Changed ${all.length === 1 ? 'one place' : `${all.length} places`}.`);
    } else spell.cursor = replaceMistake(m, word);
    doc.normalize();
    setDirty(true);
  } else if (kind === 'ignore') {
    spell.cursor = document.createRange();
    spell.cursor.setStart(m.range.endContainer, m.range.endOffset);
  } else if (kind === 'ignoreAll') {
    spell.ignored.add(m.word);
  } else if (kind === 'add') {
    try {
      await api('/api/spell/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ word: m.word }) });
    } catch (error) { say(`Could not add the word: ${error.message}`); return; }
    spell.ignored.add(m.word); // the red underline may take a moment to learn it too
  }
  await showNextMistake();
}

$('spell-suggestions').addEventListener('change', () => { const o = $('spell-suggestions').selectedOptions[0]; if (o && !o.disabled) $('spell-to').value = o.value; });
$('spell-suggestions').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); spellAction('change'); } });
$('spell-to').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); spellAction('change'); } });
$('spell-change').addEventListener('click', () => spellAction('change'));
$('spell-change-all').addEventListener('click', () => spellAction('changeAll'));
$('spell-ignore').addEventListener('click', () => spellAction('ignore'));
$('spell-ignore-all').addEventListener('click', () => spellAction('ignoreAll'));
$('spell-add').addEventListener('click', () => spellAction('add'));
// Leaving the box (Escape, Close): back in the document with the word selected. Done here and
// not on the close event, which can come late (a hidden window waits for its next frame).
function leaveSpelling() {
  if ($('spell-dialog').open) $('spell-dialog').close();
  if (window.Highlight) CSS.highlights.delete('spelling');
  const m = spell.current;
  spell.current = null;
  if (!m) return;
  doc.focus();
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(m.range.cloneRange());
}
$('spell-dialog').addEventListener('cancel', (e) => { e.preventDefault(); leaveSpelling(); });
$('spell-close').addEventListener('click', (e) => { e.preventDefault(); leaveSpelling(); });
$('spell-dialog').addEventListener('close', () => { if (!$('spell-dialog').open && spell.current) leaveSpelling(); });

// Alt+F7: the next misspelled word after the cursor is selected and said, without the box.
async function nextMisspelling() {
  const sel = getSelection();
  spell.origin = document.createRange();
  if (sel.rangeCount && doc.contains(sel.focusNode)) spell.origin.setStart(sel.focusNode, sel.focusOffset); else spell.origin.setStart(doc, 0);
  spell.origin.collapse(true);
  spell.cursor = spell.origin.cloneRange();
  spell.wrapped = false;
  let errors;
  try { errors = await checkSpelling(); } catch (error) { say(`Spelling cannot be checked: ${error.message}`); return; }
  // From the end of the word found last time (the selection's end), so each press goes on.
  const m = nextMistake(errors);
  if (!m) { say(errors.length ? 'No other spelling mistakes.' : 'No spelling mistakes found.'); return; }
  doc.focus();
  sel.removeAllRanges();
  const range = m.range.cloneRange();
  sel.addRange(range);
  m.range.startContainer.parentElement?.scrollIntoView({ block: 'center' });
  const tips = m.action === 'delete' ? '' : m.suggestions.length ? ` Suggestions: ${m.suggestions.slice(0, 3).join(', ')}.` : ' No suggestions.';
  say(`${describeMistake(m)}${tips} The Applications key lists corrections; F7 opens Spelling.`);
}

// ---------- stepping through an equation with the arrow keys ----------
// As in Word, the arrow keys go into an equation: there it is its plain text, f(x) = 3 sin(x),
// so Right and Left move one symbol at a time and typing changes it. When the cursor leaves,
// it is an equation again, exactly as before if nothing was changed (Settings > Writing).

let openText = null; // { span, latex, plain, display }: the equation being stepped through

// The equation just after the cursor (forward) or just before it.
function equationNextTo(forward) {
  const sel = getSelection();
  if (!sel.rangeCount || !sel.isCollapsed || !doc.contains(sel.anchorNode)) return null;
  const { startContainer: c, startOffset: o } = sel.getRangeAt(0);
  let n;
  if (c.nodeType === Node.TEXT_NODE) {
    if (forward ? o < c.length : o > 0) return null;
    n = forward ? c.nextSibling : c.previousSibling;
  } else n = forward ? c.childNodes[o] : c.childNodes[o - 1];
  while (n?.nodeType === Node.TEXT_NODE && !n.length) n = forward ? n.nextSibling : n.previousSibling;
  return n?.nodeType === Node.ELEMENT_NODE && n.classList.contains('eq') ? n : null;
}

function stepIntoEquation(eq, atEnd) {
  const latex = eq.dataset.latex;
  const plain = latexToPlain(latex);
  const span = el('span', { class: 'eq-text' }, plain);
  eq.replaceWith(span);
  openText = { span, latex, plain, display: eq.dataset.display === 'true' };
  const r = document.createRange();
  r.setStart(span.firstChild, atEnd ? plain.length : 0);
  r.collapse(true);
  getSelection().removeAllRanges();
  getSelection().addRange(r);
}

// Back to an equation. Returns it (null if it was emptied or is not maths yet).
function closeEquationText() {
  const open = openText;
  openText = null;
  if (!open || !doc.contains(open.span)) return null;
  const { span } = open;
  const text = span.textContent;
  let latex = open.latex;
  if (text.trim() !== open.plain.trim()) {
    if (!text.trim()) { span.remove(); setDirty(true); return null; }
    try { latex = typedToLatex(splitComment(text).code); } catch (error) {
      span.replaceWith(document.createTextNode(text));
      setDirty(true);
      say(`This is text now, not an equation: ${error.message} Ctrl+Shift+E makes it an equation again.`);
      return null;
    }
    setDirty(true);
  }
  const eq = mathSpan(latex, open.display);
  span.replaceWith(eq);
  return eq;
}

// Commands (menus, shortcuts) and saving see equations, never one half-stepped-through: the
// cursor goes just after it, where it was.
function settleEquationText() {
  if (!openText) return;
  const inside = openText.span.contains(getSelection().anchorNode);
  const eq = closeEquationText();
  if (eq && inside) placeCaretAfter(eq);
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
// The caret is right beside the equation: only spaces between them, after it or before it.
function caretBeside(eq) {
  const sel = getSelection();
  if (!eq || !sel.rangeCount || !sel.isCollapsed) return false;
  const caret = sel.getRangeAt(0);
  const between = document.createRange();
  if (caret.compareBoundaryPoints(Range.START_TO_START, (between.setStartAfter(eq), between)) >= 0) {
    between.setEnd(caret.startContainer, caret.startOffset);
  } else {
    between.setStart(caret.startContainer, caret.startOffset);
    between.setEndBefore(eq);
  }
  return !between.toString().trim();
}

// The caret is on the block's last line (down) or first line (up), as it is shown.
function onEdgeLine(block, down) {
  if (!block) return false;
  const sel = getSelection();
  if (!sel.rangeCount) return false;
  const rects = [...sel.getRangeAt(0).getClientRects()];
  const caret = rects[0];
  if (!caret || !caret.height) return true; // an empty line, or a place without a box: one line
  const box = block.getBoundingClientRect();
  return down ? box.bottom - caret.bottom < caret.height * .8 : caret.top - box.top < caret.height * .8;
}

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
  if (last?.nodeType === Node.ELEMENT_NODE && last.classList.contains('eq')) return true;
  // ... or an equation and then only its comment (y = x^2 # the parabola).
  return Boolean(commentedEquation(block));
}

// The equation a line's comment belongs to: its last one, with only "# ..." or "// ..." after it.
function commentedEquation(block) {
  const eq = [...block.children].filter((n) => n.classList.contains('eq')).at(-1);
  if (!eq) return null;
  const after = document.createRange();
  after.setStartAfter(eq);
  after.setEnd(block, block.childNodes.length);
  if (after.cloneContents().querySelector('.eq, img')) return null;
  return /^[\s.,;]*(#|\/\/|%)/.test(after.toString()) ? eq : null;
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

// The equations in root that are a graph's own formula: the same maths, however it is spaced
// and whatever it is called (f(x) = x^2 - 2 in the problem, y = x^2 - 2 graphed).
function formulaEquations(graph, root = doc) {
  const same = (latex) => latexToPlain(latex).replace(/\s+/g, '').replace(/^[A-Za-z]('*)(\([A-Za-z]\))?=/, '');
  const formulas = new Set([...(graph.functions || []).map((f) => f.latex), ...(graph.equations || []).map((e) => e.text ?? e)]
    .filter(Boolean).map(same));
  return [...root.querySelectorAll('.eq')].filter((eq) => formulas.has(same(eq.dataset.latex)));
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
  const source = opts.hideFormula ? formulaEquations(graph) : [];
  const said = source.map((eq) => latexToPlain(eq.dataset.latex)).join('; ');
  const blanked = source.length === 1 ? ` The equation with its formula, ${said}, is a blank for students too, with its comment.`
    : source.length ? ` The ${source.length} equations with its formula (${said}) are blanks for students too, with their comments.` : '';
  say(note ? `For students: ${note}${blanked}` : 'Students get the whole graph.');
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
    // A graph whose formula is hidden: the equation it was made from (Ctrl+G on y = x^2 - 2)
    // would give the answer away, so it is blanked too, with its comment.
    for (const eq of graph.student?.hideFormula ? formulaEquations(graph, root) : []) {
      const comment = eq.closest('.eq-line')?.querySelector('.comment');
      if (comment) comment.remove();
      eq.replaceWith(document.createTextNode('______'));
    }
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

// The keyboard shortcuts page (F1): one table per part, one key per row, so it reads row by
// row and H jumps between parts. The parts you use most come first. section 'graph' opens it
// at the graph mode keys (F1 or question mark in graph mode).
async function showKeys(section = null) {
  if ($('keys-dialog').open) return;
  const body = $('keys-body');
  body.replaceChildren(el('p', {}, 'H jumps to the next part, T to the next table; the arrow keys read one key at a time. Escape closes.'));
  const table = (name, rows, id = null) => {
    const h = el('h3', id ? { id, tabindex: '-1' } : {}, name);
    const t = el('table');
    const head = el('tr');
    head.append(el('th', { scope: 'col' }, 'What it does'), el('th', { scope: 'col' }, 'Key'));
    t.append(head);
    for (const [what, key] of rows) { const tr = el('tr'); tr.append(el('td', {}, what), el('td', {}, key)); t.append(tr); }
    body.append(h, t);
  };
  const extra = [
    ['Most used', [['All keys (this page)', 'F1'], ['The menus', 'Alt'], ['Between the toolbar and the document', 'F6'],
      ['Save', 'Ctrl+S'], ['Export as a Word document', 'Ctrl+Shift+W'], ['Import a PDF', 'Ctrl+Shift+I'],
      ['Read the line with its maths spelled out', 'Ctrl+Shift+R'], ['Find', 'Ctrl+F'], ['Headings list', 'Ctrl+Shift+H']]],
    ['Equations', [['Make the line (or selection) an equation', 'Ctrl+Shift+E'], ['Insert an equation', 'Alt+='],
      ['Edit the equation', 'Ctrl+E, or Enter before it'], ['New line after an equation', 'Enter after it'],
      ['Copy the equation above down, to change it', 'Shift+Enter or F11'],
      ['Move through an equation one symbol at a time', 'Right and Left arrows into it'],
      ['Equation back to plain text', 'Ctrl+T or Ctrl+Shift+T'], ['Equation to LaTeX text', 'Ctrl+L'],
      ['Plain text, LaTeX and MathML', 'Ctrl+Shift+M'],
      ['Interval for the equation, such as [0, 2pi]', 'Ctrl+Shift+D'],
      ['Comment next to the maths (not part of it)', 'Type # or // after the maths'],
      ['In the equation box: plain text or LaTeX', 'Ctrl+L']]],
    ['Graphs', [['Graph the equation here, or explore the graph here', 'Ctrl+G, or Enter on a graph line'], ['New graph from equations', 'Ctrl+Shift+G']]],
    ['In graph mode', [['Step along the function', 'J and K'], ['Play or stop', 'Space'], ['Next and previous point of interest', 'Period and comma'],
      ['Slope here', 'S'], ['Limits from the left and the right', 'L'], ['Slope sound on or off', 'D'],
      ['Read the point', 'V'], ['Describe the graph', 'I'], ['Move freely', 'Arrow keys'], ['Back on the function', 'C'],
      ['Next and previous function', 'Tab, Shift+Tab'], ['Ends of the function', 'Home and End'], ['Step size', 'F'],
      ['These keys', 'F1 or question mark'], ['Back to the document', 'Escape']]],
    ['Lists, tables and headings', [['Bulleted and numbered list', 'Ctrl+Shift+L, Ctrl+Shift+7'],
      ['List item in or out a level, next table cell', 'Tab, Shift+Tab'], ['Heading levels 1 to 3, normal text', 'Ctrl+Alt+1, 2, 3, 0'],
      ['Next and previous heading', 'Ctrl+Page Down, Ctrl+Page Up'], ['Page break', 'Ctrl+Enter'],
      ['Spelling suggestions on a misspelled word', 'Applications key']]],
    ['Spelling', [['Check spelling, as in Word', 'F7'], ['Next misspelled word', 'Alt+F7'], ['Corrections for the word', 'Applications key']]],
  ];
  for (const [name, rows] of extra) table(name, rows, name === 'In graph mode' ? 'keys-graph' : null);
  // Then every menu, as the menu bar has it. A command with no key of its own says where it is.
  const menus = desktop?.getMenu ? await desktop.getMenu() : [];
  body.append(el('h3', {}, 'The menus (Alt)'));
  for (const menu of menus) {
    const rows = menu.items.filter((i) => i.label).map((i) => {
      const inGraph = /\(([^)]+)\)$/.exec(i.label); // "Slope here (S)": the key in graph mode
      return [i.label.replace(/\s*\([^)]+\)$/, ''), i.key || (inGraph ? `${inGraph[1]} in graph mode` : 'Menu only')];
    });
    if (rows.length) table(`${menu.label} menu`, rows);
  }
  $('keys-dialog').showModal();
  if (section === 'graph') $('keys-graph').focus(); else body.focus();
}
// Closing it goes back where you were: graph mode, or the document.
$('keys-dialog').addEventListener('close', () => { if (!$('graph-mode').hidden) $('graph-mode').focus(); else backToDocument(); });

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
  const first = { sound: 'set-sound_profile', writing: 'set-step_into_equations', ai: installed ? 'set-use_ai' : null, reading: installed && $('set-use_ai').checked ? 'set-reading_method' : 'set-pages_at_once' }[section];
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

// A graph's line is its description, written by the notebook. Typing there starts a new line
// after the graph (as typing after a table in Word); its words cannot be changed one by one,
// and the whole line selected and deleted removes the graph.
doc.addEventListener('beforeinput', (e) => {
  const sel = getSelection();
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const graphOf = (n) => (n?.nodeType === 1 ? n : n?.parentElement)?.closest?.('.graph-line') || null;
  const line = graphOf(range.startContainer);
  if (line && line === graphOf(range.endContainer)) {
    if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') return;
    e.preventDefault();
    if (e.inputType.startsWith('insert')) {
      const next = line.nextElementSibling;
      const p = next && isBlankLine(next) ? next : newLineAfter(line);
      placeCaretIn(p);
      const text = e.data ?? e.dataTransfer?.getData('text/plain') ?? '';
      if (text) document.execCommand('insertText', false, text);
    } else if (e.inputType.startsWith('delete')) {
      if (!range.collapsed && range.toString().trim() === line.textContent.trim()) {
        const p = el('p');
        p.append(el('br'));
        line.replaceWith(p);
        graphs.delete(line.dataset.graphId);
        placeCaretIn(p);
        setDirty(true);
        say('Graph deleted.');
      } else say("A graph's description cannot be changed. Select the whole line to delete the graph.");
    }
    return;
  }
  // Backspace at the start of the line after a graph, or Delete at the end of the line before
  // one, would join that line and the graph's.
  const block = currentBlock();
  const back = e.inputType === 'deleteContentBackward', ahead = e.inputType === 'deleteContentForward';
  const graph = back ? block?.previousElementSibling : ahead ? block?.nextElementSibling : null;
  if (!range.collapsed || !graph?.classList.contains('graph-line')) return;
  const side = document.createRange();
  side.selectNodeContents(block);
  if (back) side.setEnd(range.startContainer, range.startOffset); else side.setStart(range.startContainer, range.startOffset);
  if (side.toString() !== '' && !isBlankLine(block)) return;
  e.preventDefault();
  if (isBlankLine(block)) { block.remove(); placeCaretIn(graph); setDirty(true); say('Empty line removed.'); }
  else say(`The line ${back ? 'above' : 'below'} is a graph; it stays as it is.`);
});

doc.addEventListener('keydown', (e) => {
  const plainKey = !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
  // Down arrow on the last line, a graph: a new line after it, as Word does after a table.
  if (e.key === 'ArrowDown' && plainKey && currentBlock()?.classList.contains('graph-line') && !currentBlock().nextElementSibling) {
    e.preventDefault();
    newLineAfter(currentBlock());
    say('New line after the graph.');
    return;
  }
  // Right and Left go into an equation, one symbol at a time (Settings > Writing).
  if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && plainKey && !openText && savedSettings?.values?.step_into_equations !== false) {
    const eq = equationNextTo(e.key === 'ArrowRight');
    if (eq) { e.preventDefault(); stepIntoEquation(eq, e.key === 'ArrowLeft'); return; }
  }
  // Enter in an equation being stepped through: it is an equation again, and a new line follows.
  if (e.key === 'Enter' && plainKey && openText?.span.contains(getSelection().anchorNode)) {
    e.preventDefault();
    const eq = closeEquationText();
    const block = eq ? blockOf(eq) : currentBlock();
    if (block) newLineAfter(block);
    return;
  }
  // Shift+Enter: the last equation above comes down to the next line, ready to change (as F11).
  if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    settleEquationText();
    copyEquationDown();
    return;
  }
  if (e.key === 'Enter' && plainKey) {
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
    // Enter elsewhere is always a new line; Shift+Enter (or F11) copies the equation above down.
  }
  // Up and Down onto an equation line (with or without a comment after it), from any line:
  // Chromium's caret does not stop at the equation (it stays put, or lands inside the comment,
  // where the equation is neither said nor reachable), so it is put just after the equation.
  // In a paragraph that wraps, only its first line (Up) or last line (Down) leaves it.
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.ctrlKey && !e.altKey && getSelection().isCollapsed) {
    const block = currentBlock();
    const target = e.key === 'ArrowUp' ? block?.previousElementSibling : block?.nextElementSibling;
    const onlyEquation = (b) => b?.classList.contains('eq-line') && b.querySelector('.eq');
    // Up inside an equation line whose comment wraps: on reaching the shown line that holds the
    // equation, the caret stops after the equation, not in the middle of the comment.
    if (e.key === 'ArrowUp' && onlyEquation(block) && !onEdgeLine(block, false)) {
      setTimeout(() => {
        const eq = block.querySelector('.eq');
        if (currentBlock() === block && onEdgeLine(block, false) && !caretBeside(eq)) placeCaretAfter(eq);
      }, 0);
    }
    if ((onlyEquation(target) && onEdgeLine(block, e.key === 'ArrowDown')) || (onlyEquation(block) && isBlankLine(target))) {
      e.preventDefault();
      if (onlyEquation(target)) placeCaretAfter(target.querySelector('.eq')); else placeCaretIn(target);
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
  const line = currentBlock();
  if (line?.querySelector?.('.eq')) markComments(line);
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
  exportBraille,
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
  interval: openInterval,
  spelling: startSpelling,
  nextMisspelling,
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
  toLatexText: equationToLatexText,
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
  F1: 'keys', 'Ctrl+G': 'exploreGraph', 'Ctrl+Shift+G': 'insertGraph', 'Ctrl+F9': 'hideWords', 'Ctrl+Shift+F9': 'hideLine', 'Ctrl+Shift+V': 'pastePlain', F11: 'copyEquationDown', 'Ctrl+T': 'toPlainText', 'Ctrl+Shift+T': 'toPlainText', 'Ctrl+L': 'toLatexText', 'Ctrl+PageDown': 'nextHeading', 'Ctrl+PageUp': 'previousHeading', 'Ctrl+Shift+H': 'headingList',
  'Ctrl+Shift+D': 'interval', F7: 'spelling', 'Alt+F7': 'nextMisspelling',
};

// Without the desktop menu bar (tests in a plain browser), the menu's other shortcuts work here too.
const FALLBACK_KEYS = {
  'Alt+=': 'insertEquation', 'Ctrl+E': 'editEquation', 'Ctrl+Shift+E': 'toEquation', 'Ctrl+Shift+T': 'toPlainText', 'Ctrl+T': 'toPlainText', 'Ctrl+L': 'toLatexText',
  'Ctrl+Shift+R': 'readLine', 'Ctrl+G': 'exploreGraph', 'Ctrl+Shift+G': 'insertGraph', F8: 'nextNote', 'Shift+F8': 'previousNote',
  'Ctrl+Alt+1': 'heading1', 'Ctrl+Alt+2': 'heading2', 'Ctrl+Alt+3': 'heading3', 'Ctrl+Alt+0': 'normalText', F1: 'keys', 'Ctrl+,': 'settings',
  'Ctrl+B': 'bold', 'Ctrl+I': 'italic', 'Ctrl+U': 'underline', 'Ctrl+Shift+L': 'bulletList', 'Ctrl+Shift+&': 'numberedList', 'Ctrl+Shift+7': 'numberedList',
  'Ctrl+Enter': 'pageBreak', 'Ctrl+F': 'find', 'Ctrl+H': 'replace', F3: 'findNext', 'Shift+F3': 'findPrevious', 'Ctrl+Shift+M': 'convertMath',
};


function run(name) {
  const command = COMMANDS[name];
  if (command && !document.querySelector('dialog[open]')) settleEquationText();
  // While a dialog is open its own keys win: Ctrl+Enter there is the dialog's, not a page
  // break, and Ctrl+B in the Find box must not make the document bold.
  if (command && document.querySelector('dialog[open]') && name !== 'keys') return;
  if (command && studentView && !PREVIEW_SAFE.has(name)) { say('This is the student preview. To change the document, turn the preview off: Teacher menu, Preview student copy.'); return; }
  if (command) command();
}
window.runCommand = run; // used by the desktop bridge and by tests
window.notebookImport = importPdf; // used by tests
desktop?.onCommand(run);
window.serializeNotebook = serialize; // used by tests
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
  // The cursor has left the equation it was stepping through: it is an equation again.
  if (openText && sel.rangeCount && !openText.span.contains(sel.anchorNode) && document.activeElement === doc) closeEquationText();
  if (!sel.rangeCount || !sel.isCollapsed) return;
  // Only while typing in the document: moving the selection would also move the keyboard
  // focus back into it, away from graph mode or a dialog.
  if (!doc.contains(sel.anchorNode) || document.activeElement !== doc) return;
  const node = sel.anchorNode.nodeType === Node.ELEMENT_NODE ? sel.anchorNode : sel.anchorNode.parentElement;
  const eq = node?.closest('.eq');
  if (eq && eq !== doc) placeCaretAfter(eq);
  announceEquation();
});

// In focus mode NVDA reads only the start of an equation (MathCAT reads it in browse mode), so
// when the cursor comes to an equation, it is said once as plain text. Settings > Writing can
// turn this off.
let announcedEquation = null;
let announceTimer = null;
function announceEquation() {
  clearTimeout(announceTimer);
  // Away from it, even for a moment (Up then Down quickly), it is said again on coming back.
  if (!caretBeside(equationAtCaret())) announcedEquation = null;
  announceTimer = setTimeout(() => {
    if (savedSettings?.values?.say_equations === false || document.activeElement !== doc) return;
    // Said when the caret comes beside it; reading on into its comment and coming back says it again.
    let eq = equationAtCaret();
    if (eq && !caretBeside(eq)) eq = null;
    if (eq === announcedEquation) return;
    announcedEquation = eq;
    if (!eq) return;
    const words = latexToPlain(eq.dataset.latex);
    // Just converted or copied: that was said a moment ago.
    if (Date.now() - lastSaid.at < 600 && lastSaid.text.includes(words)) return;
    say(`Equation: ${words}`);
  }, 250);
}

const first = el('p');
first.append(el('br'));
doc.append(first);
setDirty(false);
doc.focus();
placeCaretIn(first); // typing goes into the first paragraph, not loose in the document
say('Math Notebook. Alt opens the menus; F1 lists the keys.');
