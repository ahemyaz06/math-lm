// A Word document (.docx) from the notebook's blocks, with every equation as a real Word
// equation (OMML), so Word, NVDA and MathCAT read it as maths. No Word or Pandoc needed.
//
// Blocks: { type: 'heading', level, runs } | { type: 'paragraph', runs } | { type: 'equation', latex } | { type: 'pageBreak' }
//   | { type: 'list', ordered, items: [{ runs, level }] } | { type: 'table', rows: [[runs]], header }
// Runs:   { text, bold, italic, underline } | { latex } | { lineBreak: true }
import { latexToOmml } from './mathml.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // Characters XML 1.0 cannot hold at all (control characters) are left out.
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '');

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
  + 'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" '
  + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function textRun(r) {
  const props = `${r.bold ? '<w:b/><w:bCs/>' : ''}${r.italic ? '<w:i/><w:iCs/>' : ''}${r.underline ? '<w:u w:val="single"/>' : ''}`;
  // Tabs and line breaks inside a piece of text become Word's own tab and break.
  return String(r.text).split(/(\t|\n)/).filter((p) => p !== '').map((part) => {
    const inner = part === '\t' ? '<w:tab/>' : part === '\n' ? '<w:br/>' : `<w:t xml:space="preserve">${esc(part)}</w:t>`;
    return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}${inner}</w:r>`;
  }).join('');
}

function runsXml(runs, problems) {
  return (runs || []).map((r) => {
    if (r.lineBreak) return '<w:r><w:br/></w:r>';
    if (r.latex !== undefined) {
      try {
        return latexToOmml(r.latex);
      } catch (error) {
        problems.push(`${r.latex}: ${error.message}`);
        return textRun({ text: r.latex });
      }
    }
    return r.text ? textRun(r) : '';
  }).join('');
}

const paragraph = (style, body, extra = '') => `<w:p>${style || extra ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${extra}</w:pPr>` : ''}${body}</w:p>`;

function blockXml(block, ctx) {
  switch (block.type) {
    case 'heading': {
      const level = Math.min(Math.max(block.level || 1, 1), 6);
      return paragraph(`Heading${level}`, runsXml(block.runs, ctx.problems));
    }
    case 'pageBreak':
      return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
    case 'equation': {
      let body;
      try { body = latexToOmml(block.latex, true); } catch (error) {
        ctx.problems.push(`${block.latex}: ${error.message}`);
        body = textRun({ text: block.latex });
      }
      return paragraph(null, body);
    }
    case 'list': {
      ctx.lists += 1;
      const num = ctx.lists; // every list has its own numbering, so each one starts at 1
      ctx.numbering.push({ num, ordered: block.ordered });
      return block.items.map((item) => paragraph('ListParagraph', runsXml(item.runs, ctx.problems),
        `<w:numPr><w:ilvl w:val="${Math.min(item.level || 0, 8)}"/><w:numId w:val="${num}"/></w:numPr>`)).join('');
    }
    case 'table': {
      const columns = Math.max(1, ...block.rows.map((r) => r.length));
      const grid = `<w:tblGrid>${'<w:gridCol w:w="2000"/>'.repeat(columns)}</w:tblGrid>`;
      const rows = block.rows.map((cells, n) => {
        const header = n === 0 && block.header;
        const filled = [...cells, ...Array(columns - cells.length).fill([])];
        return `<w:tr>${header ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${filled.map((runs) =>
          `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${paragraph(null, runsXml(header ? runs.map((r) => (r.text ? { ...r, bold: true } : r)) : runs, ctx.problems))}</w:tc>`).join('')}</w:tr>`;
      }).join('');
      return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/><w:tblLook w:val="04A0" w:firstRow="${block.header ? 1 : 0}" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>${grid}${rows}</w:tbl>${paragraph(null, '')}`;
    }
    default:
      return paragraph(null, runsXml(block.runs, ctx.problems));
  }
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${NS}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
${[1, 2, 3, 4, 5, 6].map((n) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${n === 1 ? 360 : 240}" w:after="120"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="${[36, 30, 26, 24, 24, 24][n - 1]}"/><w:szCs w:val="${[36, 30, 26, 24, 24, 24][n - 1]}"/></w:rPr></w:style>`).join('\n')}
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/><w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>
<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr></w:style>
</w:styles>`;

function numberingXml(lists) {
  const levels = (ordered) => Array.from({ length: 9 }, (_, l) => {
    const format = ordered ? ['decimal', 'lowerLetter', 'lowerRoman'][l % 3] : 'bullet';
    const text = ordered ? `%${l + 1}.` : ['•', 'o', '▪'][l % 3];
    // Real Unicode bullets in ordinary fonts (not the Symbol font's private codes), so
    // every program and screen reader gets the same character.
    const font = l % 3 === 1 ? 'Courier New' : 'Calibri';
    const bulletFont = ordered ? '' : `<w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:hint="default"/></w:rPr>`;
    return `<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (l + 1)}" w:hanging="360"/></w:pPr>${bulletFont}</w:lvl>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering ${NS}>
<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${levels(false)}</w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${levels(true)}</w:abstractNum>
${lists.map(({ num, ordered }) => `<w:num w:numId="${num}"><w:abstractNumId w:val="${ordered ? 1 : 0}"/>${ordered ? '<w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride>' : ''}</w:num>`).join('\n')}
</w:numbering>`;
}

export function documentParts(blocks, title = 'Document') {
  const ctx = { problems: [], lists: 0, numbering: [] };
  const body = blocks.map((b) => blockXml(b, ctx)).join('\n');
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${NS}><w:body>
${body || paragraph(null, '')}
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>
</w:body></w:document>`;
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const parts = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
    'word/_rels/document.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`,
    'word/document.xml': document,
    'word/styles.xml': STYLES,
    'word/numbering.xml': numberingXml(ctx.numbering),
    'docProps/core.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dc:language>en-US</dc:language><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`,
  };
  return { parts, problems: ctx.problems };
}

// ---------- a plain ZIP file (stored, not compressed: Word reads it the same) ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
export function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zip(files) {
  const encoder = new TextEncoder();
  const entries = Object.entries(files).map(([name, data]) => ({ name: encoder.encode(name), data: typeof data === 'string' ? encoder.encode(data) : data }));
  const chunks = [];
  const central = [];
  let offset = 0;
  // A fixed date (1 Jan 2026) keeps the same document giving the same bytes.
  const time = 0, date = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const { name, data } of entries) {
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true); local.setUint16(10, time, true); local.setUint16(12, date, true);
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), name, data);
    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true); dir.setUint16(4, 20, true); dir.setUint16(6, 20, true); dir.setUint16(8, 0x0800, true);
    dir.setUint16(10, 0, true); dir.setUint16(12, time, true); dir.setUint16(14, date, true); dir.setUint32(16, crc, true);
    dir.setUint32(20, data.length, true); dir.setUint32(24, data.length, true); dir.setUint16(28, name.length, true);
    dir.setUint32(42, offset, true);
    central.push(new Uint8Array(dir.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, c) => s + c.length, 0));
  let at = 0;
  for (const c of all) { out.set(c, at); at += c.length; }
  return out;
}

export function makeDocx(blocks, title) {
  const { parts, problems } = documentParts(blocks, title);
  return { bytes: zip(parts), problems };
}
