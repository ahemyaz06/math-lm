// The document as a clean XHTML page for BrailleBlaster: headings, paragraphs, lists and tables
// as they are, every equation as MathML (BrailleBlaster turns MathML into Nemeth or UEB maths),
// nothing for the screen only. The way of making it follows Owen Petronick's Braille Check
// (tex2braille.py), which makes the same kind of page from a quiz's .tex file.
import { latexToMathml } from './mathml.js';

const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// MathML (Temml's is well-formed XML) without what only the screen uses: its classes and styles.
function mathXml(latex, display) {
  return latexToMathml(latex, display).replace(/ (class|style)="[^"]*"/g, '');
}

function runs(list) {
  let out = '';
  for (const r of list || []) {
    if (r.lineBreak) { out += '<br/>'; continue; }
    if (r.latex !== undefined) { const p = piecesInText(r.latex); out += p || mathXml(r.latex, false); continue; }
    // A graph's line ends with how to explore it on screen; on paper that is not there.
    let text = escape(r.text.replace(/\s*Press Enter to explore it by sound\.\s*$/, ''));
    if (r.bold) text = `<strong>${text}</strong>`;
    if (r.italic) text = `<em>${text}</em>`;
    if (r.underline) text = `<u>${text}</u>`;
    out += text;
  }
  return out;
}

function list(block) {
  // Items carry their level; nested lists are built from it. BrailleBlaster writes the numbers
  // only when a numbered list says its kind (type); otherwise every item starts with a lone
  // period. The kinds are Word's: 1., then a., then i.
  // A list that goes on after a picture starts at its next number, at its first item's level.
  const tag = block.ordered ? 'ol' : 'ul';
  const base = block.items[0]?.level || 0;
  const start = (l, first = 1) => (block.ordered ? `<ol type="${['1', 'a', 'i'][l % 3]}"${first > 1 ? ` start="${first}"` : ''}>` : '<ul>');
  let out = start(base, block.start);
  let level = base;
  let open = false;
  for (const item of block.items) {
    while (level < item.level) { level += 1; out += start(level); open = false; }
    while (level > item.level) { out += `</li></${tag}>`; level -= 1; }
    if (open) out += '</li>';
    out += `<li>${runs(item.runs)}`;
    open = true;
  }
  if (open) out += '</li>';
  while (level > base) { out += `</${tag}></li>`; level -= 1; }
  return `${out}</${tag}>`;
}

// A piecewise function (\begin{cases}) one row to a line: BrailleBlaster turns the rows of a
// cases (or any table in maths) into an 8-dot cell that a 6-dot embosser cannot make, and joins
// them into one line. Each row is written "expression, condition" on its own line instead.
function pieces(latex) {
  const m = /^([\s\S]*?)(?:\\left\s*\\\{\s*)?\\begin\{cases\}([\s\S]*?)\\end\{cases\}(?:\s*\\right\s*\.)?([\s\S]*)$/.exec(latex);
  if (!m || m[3].trim()) return null;
  const rows = m[2].split(/\\\\/).map((r) => r.trim()).filter(Boolean).map((row) => {
    const [expr, ...cond] = row.split(/(?<!\\)&/);
    return { expr: expr.trim(), cond: cond.join(' ').trim() };
  });
  const lead = m[1].trim().replace(/=\s*$/, '').trim();
  return {
    lead: `${lead ? `${mathXml(lead, false)} ` : ''}is defined in ${rows.length} pieces:`,
    rows: rows.map((r) => `${mathXml(r.expr, !inline)}${r.cond ? `, ${mathXml(r.cond, false)}` : ''}`),
  };
}
let inline = false;
// In a sentence BrailleBlaster keeps no line breaks, so the rows are parted by semicolons.
const piecesInText = (latex) => { inline = true; try { const p = pieces(latex); return p && `${p.lead} ${p.rows.join('; ')}`; } finally { inline = false; } };
const piecesAsLines = (latex) => { const p = pieces(latex); return p && [`<p>${p.lead}</p>`, ...p.rows.map((r) => `<p class="math">${r}</p>`)].join('\n'); };

export function brailleHtml(blocks, title) {
  const body = blocks.map((b) => {
    if (b.type === 'heading') return `<h${Math.min(6, b.level)}>${runs(b.runs)}</h${Math.min(6, b.level)}>`;
    if (b.type === 'equation') return piecesAsLines(b.latex) || `<p class="math">${mathXml(b.latex, true)}</p>`;
    if (b.type === 'list') return list(b);
    if (b.type === 'table') {
      return `<table>${b.rows.map((row, n) => `<tr>${row.map((cell) => (b.header && n === 0 ? `<th>${runs(cell)}</th>` : `<td>${runs(cell)}</td>`)).join('')}</tr>`).join('')}</table>`;
    }
    if (b.type === 'pageBreak') return '';
    return `<p>${runs(b.runs)}</p>`;
  }).filter(Boolean);
  return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n'
    + '<html xmlns="http://www.w3.org/1999/xhtml" lang="en" xml:lang="en">\n<head>\n<meta charset="UTF-8"/>\n'
    + `<title>${escape(title)}</title>\n</head>\n<body>\n${body.join('\n')}\n</body>\n</html>\n`;
}
