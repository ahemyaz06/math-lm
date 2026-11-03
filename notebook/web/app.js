import { renderPage } from './markdown.js';

const $ = (id) => document.getElementById(id);
const STAGES = { preparing: 'preparing', reading: 'reading the page', figure: 'describing a picture', graph: 'reading graph numbers', second: 'double-checking with a second model' };
let current = null; // { id, shown: Set of page numbers, timer, announcedFirst }

function say(text) {
  // Re-setting identical text would not be spoken again.
  $('announce').textContent = '';
  setTimeout(() => { $('announce').textContent = text; }, 30);
}
function showError(text) { $('error').textContent = text || ''; }

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `The notebook server answered ${response.status}.`);
  return body;
}

function fill(select, items, empty) {
  select.replaceChildren();
  if (!items.length) {
    const option = new Option(empty, '');
    option.disabled = true;
    select.append(option);
    return;
  }
  for (const item of items) select.append(new Option(item.label, item.value));
}

async function loadLibrary() {
  const library = await api('/api/library');
  fill($('course'), library.course.map((f) => ({ label: f.name, value: f.path })), `No PDFs in ${library.folder}`);
  fill($('recent'), library.recent.map((d) => ({ label: `${d.name}, ${d.pages} ${d.pages === 1 ? 'page' : 'pages'}`, value: d.id })), 'Nothing opened yet');
}

async function open(request) {
  showError('');
  try {
    const { meta } = await request();
    startDocument(meta);
  } catch (error) {
    showError(error.message);
  }
}

function startDocument(meta) {
  clearTimeout(current?.timer);
  current = { id: meta.id, shown: new Set(), announcedFirst: false };
  $('document').hidden = false;
  $('doc-title').textContent = meta.name;
  $('pages').replaceChildren();
  $('progress').textContent = `${meta.pages} ${meta.pages === 1 ? 'page' : 'pages'}. Starting.`;
  $('doc-title').focus();
  say(`Opened ${meta.name}. Reading ${meta.pages} ${meta.pages === 1 ? 'page' : 'pages'}; the first page takes about a minute.`);
  poll();
}

async function poll() {
  const doc = current;
  if (!doc) return;
  let data;
  try {
    data = await api(`/api/doc/${doc.id}`);
  } catch (error) {
    showError(error.message);
    doc.timer = setTimeout(poll, 5000);
    return;
  }
  if (doc !== current) return;
  const total = data.meta.pages;
  // Add finished pages in order without moving keyboard focus.
  for (const page of data.pages.sort((a, b) => a.page - b.page)) {
    if (doc.shown.has(page.page)) continue;
    const section = renderPage(page, doc.id);
    const after = [...$('pages').children].find((s) => Number(s.dataset.page) > page.page);
    section.dataset.page = page.page;
    $('pages').insertBefore(section, after || null);
    doc.shown.add(page.page);
    if (!doc.announcedFirst) {
      doc.announcedFirst = true;
      say(`Page ${page.page} is ready. Later pages are added below as they finish.`);
    }
  }
  const status = data.status || {};
  const errors = Object.entries(status.errors || {});
  const reading = status.state === 'reading' || status.state === 'waiting';
  if (reading) {
    const stage = status.page ? `Reading page ${status.page} of ${total}: ${STAGES[status.stage] || 'working'}.` : 'Waiting to start.';
    $('progress').textContent = `${doc.shown.size} of ${total} pages ready. ${stage}`;
    doc.timer = setTimeout(poll, 2000);
  } else {
    $('progress').textContent = `${doc.shown.size} of ${total} pages ready.`;
    if (errors.length) {
      showError(errors.map(([page, message]) => `Page ${page} could not be read: ${message}`).join(' '));
    }
    if (status.state && status.state !== 'idle') say(`All pages are done.${errors.length ? ` ${errors.length} could not be read.` : ''}`);
    loadLibrary().catch(() => {});
  }
}

$('open-course').addEventListener('click', () => {
  const path = $('course').value;
  if (!path) return;
  open(() => api('/api/open-path', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) }));
});
$('open-recent').addEventListener('click', () => {
  const id = $('recent').value;
  if (!id) return;
  open(() => api(`/api/doc/${id}/read`, { method: 'POST' }));
});
$('file').addEventListener('change', () => {
  const file = $('file').files[0];
  if (!file) return;
  open(() => api('/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/pdf', 'X-File-Name': encodeURIComponent(file.name) }, body: file }));
});

loadLibrary().catch((error) => showError(error.message));
