// Builds a ZapTill manual into a Word .docx and a self-contained .html, side by side with its markdown.
//   node build.mjs ../../setup/TECHNICIAN-SETUP-GUIDE.md
// Owner, 2026-10-22: "for manuals always create a word document and a .html file". One markdown source (GitHub-style:
// headings, paragraphs, **bold**, `code`, lists, - [ ] checklists, tables, > notes, ![alt](screenshots/x.png)); images
// are read from disk relative to the markdown file and embedded in both outputs, so each file opens on its own.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, basename, extname } from 'node:path';
import { marked } from 'marked';
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun, Table, TableRow, TableCell, WidthType, ShadingType,
  BorderStyle, AlignmentType, LevelFormat, Footer, PageNumber, ExternalHyperlink,
} from 'docx';

const src = process.argv[2];
if (!src) { console.error('usage: node build.mjs <path to the markdown file>'); process.exit(1); }
const mdPath = resolve(src);
const baseDir = dirname(mdPath);
const stem = basename(mdPath, extname(mdPath));
const md = readFileSync(mdPath, 'utf8');
const tokens = marked.lexer(md, { gfm: true });

const TEAL = '0F766E', INK = '1F2937', QUIET = '6B7280', LINE = 'D1D5DB', HEAD_FILL = 'E6F4F1', NOTE_FILL = 'FFF7E6';
const PAGE_W = 11906, MARGIN = 1134;            // A4, 2 cm margins (DXA)
const CONTENT_W = PAGE_W - 2 * MARGIN;          // 9638 DXA
const MAX_IMG_PX = 620;                         // ≈ 16.4 cm at 96 dpi, inside the margins

// ── images ────────────────────────────────────────────────────────────────────────────────────────────────────────
const imgCache = new Map();
function loadImage(href) {
  if (imgCache.has(href)) return imgCache.get(href);
  const buf = readFileSync(resolve(baseDir, href));
  const ext = extname(href).slice(1).toLowerCase();
  let w = 800, h = 600;
  if (ext === 'png') { w = buf.readUInt32BE(16); h = buf.readUInt32BE(20); }
  const img = { buf, type: ext === 'jpeg' ? 'jpg' : ext, w, h };
  imgCache.set(href, img);
  return img;
}
const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ── HTML ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const headings = tokens.filter((t) => t.type === 'heading' && t.depth === 2).map((t) => ({ text: t.text, id: slug(t.text) }));
const renderer = new marked.Renderer();
renderer.heading = function ({ tokens: tk, depth, text }) {
  const inner = this.parser.parseInline(tk);
  return `<h${depth} id="${slug(text)}">${inner}</h${depth}>\n`;
};
renderer.image = function ({ href, text }) {
  const img = loadImage(href);
  const mime = img.type === 'jpg' ? 'image/jpeg' : `image/${img.type}`;
  return `<figure><img src="data:${mime};base64,${img.buf.toString('base64')}" alt="${text}" loading="lazy"><figcaption>${text}</figcaption></figure>`;
};
const bodyHtml = marked.parser(tokens, { renderer, gfm: true });
const title = (tokens.find((t) => t.type === 'heading' && t.depth === 1) || { text: stem }).text;
const toc = headings.map((h) => `<li><a href="#${h.id}">${h.text}</a></li>`).join('');
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root{--ink:#1f2937;--quiet:#6b7280;--teal:#0f766e;--line:#d1d5db;--head:#e6f4f1;--note:#fff7e6;--bg:#ffffff;--card:#f9fafb}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 "Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif}
.wrap{max-width:900px;margin:0 auto;padding:32px 20px 80px}
h1{font-size:2rem;line-height:1.2;color:var(--teal);margin:0 0 4px}
h2{font-size:1.4rem;color:var(--teal);margin:48px 0 12px;padding-top:12px;border-top:2px solid var(--head)}
h3{font-size:1.1rem;margin:28px 0 8px}
p{margin:10px 0}
a{color:var(--teal)}
code{background:#f3f4f6;border-radius:4px;padding:1px 5px;font-size:.92em}
pre{background:#f3f4f6;border:1px solid var(--line);border-radius:8px;padding:12px 14px;overflow-x:auto;font-size:.88rem;line-height:1.5}
pre code{background:none;padding:0}
table{border-collapse:collapse;width:100%;margin:14px 0;font-size:.94rem}
th,td{border:1px solid var(--line);padding:7px 10px;text-align:left;vertical-align:top}
th{background:var(--head)}
tbody tr:nth-child(even){background:var(--card)}
figure{margin:18px 0;text-align:center}
figure img{max-width:100%;height:auto;border:1px solid var(--line);border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
figcaption{color:var(--quiet);font-size:.85rem;margin-top:6px}
blockquote{margin:14px 0;padding:10px 14px;background:var(--note);border-left:4px solid #f59e0b;border-radius:4px}
ul,ol{padding-left:24px}
li{margin:4px 0}
li input[type=checkbox]{margin-right:8px;transform:scale(1.15)}
li:has(> input[type=checkbox]){list-style:none;margin-left:-22px}
.toc{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 18px;margin:20px 0}
.toc ol{margin:6px 0 0}
@media print{.toc{break-after:page} h2{break-before:page;border-top:none} figure{break-inside:avoid} table{break-inside:auto} a{color:inherit;text-decoration:none}}
</style></head><body><div class="wrap">
${bodyHtml.replace(/(<\/h1>\s*<p>.*?<\/p>\s*<p>.*?<\/p>)/s, `$1\n<nav class="toc"><strong>Contents</strong><ol>${toc}</ol></nav>`)}
</div></body></html>`;
writeFileSync(resolve(baseDir, `${stem}.html`), html);

// ── DOCX ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// Inline tokens → TextRuns (bold, italic, code, links); `style` carries the surrounding run's formatting down.
function runs(inline, style = {}) {
  const out = [];
  for (const t of inline || []) {
    if (t.type === 'strong') out.push(...runs(t.tokens, { ...style, bold: true }));
    else if (t.type === 'em') out.push(...runs(t.tokens, { ...style, italics: true }));
    else if (t.type === 'codespan') out.push(new TextRun({ text: unescape(t.text), font: 'Consolas', size: 19, shading: { type: ShadingType.CLEAR, fill: 'F3F4F6', color: 'auto' }, ...style }));
    else if (t.type === 'link') out.push(new ExternalHyperlink({ link: t.href, children: [new TextRun({ text: t.text, style: 'Hyperlink', ...style })] }));
    else if (t.type === 'br') out.push(new TextRun({ break: 1 }));
    else if (t.tokens) out.push(...runs(t.tokens, style));
    else out.push(new TextRun({ text: unescape(t.text ?? t.raw ?? ''), ...style }));
  }
  return out;
}
function unescape(s) { return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"); }

function imageParagraphs(tok) {
  const img = loadImage(tok.href);
  const scale = Math.min(1, MAX_IMG_PX / img.w);
  return [
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 160, after: 40 }, keepNext: true,
      children: [new ImageRun({ type: img.type, data: img.buf, transformation: { width: Math.round(img.w * scale), height: Math.round(img.h * scale) },
        altText: { title: tok.text, description: tok.text, name: basename(tok.href) } })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 },
      children: [new TextRun({ text: tok.text, italics: true, color: QUIET, size: 18 })] }),
  ];
}

let listInstance = 0;
function listParagraphs(list, level = 0) {
  const out = [];
  const instance = ++listInstance;
  for (const item of list.items) {
    const inline = item.tokens.filter((t) => t.type === 'text' || t.type === 'paragraph').flatMap((t) => t.tokens || [{ type: 'text', text: t.text }]);
    if (item.task) {
      out.push(new Paragraph({ spacing: { after: 60 }, indent: { left: 360 + level * 360, hanging: 360 },
        children: [new TextRun({ text: '☐  ', font: 'Segoe UI Symbol', color: TEAL }), ...runs(inline)] }));
    } else {
      out.push(new Paragraph({ spacing: { after: 60 },
        numbering: list.ordered ? { reference: 'steps', level, instance } : { reference: 'bullets', level },
        children: runs(inline) }));
    }
    for (const sub of item.tokens.filter((t) => t.type === 'list')) out.push(...listParagraphs(sub, level + 1));
  }
  return out;
}

function tableBlock(tok) {
  const cols = tok.header.length;
  // Column widths by content length, at least 18% each, summing to the content width.
  const len = tok.header.map((h, i) => Math.max(h.text.length, ...tok.rows.map((r) => (r[i]?.text || '').length)));
  const total = len.reduce((a, b) => a + b, 0) || 1;
  let widths = len.map((l) => Math.max(CONTENT_W * 0.18, (CONTENT_W * l) / total));
  const s = widths.reduce((a, b) => a + b, 0);
  widths = widths.map((w) => Math.floor((w * CONTENT_W) / s));
  widths[cols - 1] += CONTENT_W - widths.reduce((a, b) => a + b, 0);
  const border = { style: BorderStyle.SINGLE, size: 4, color: LINE };
  const borders = { top: border, bottom: border, left: border, right: border };
  const cell = (c, i, head) => new TableCell({
    width: { size: widths[i], type: WidthType.DXA }, borders,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    shading: head ? { type: ShadingType.CLEAR, fill: HEAD_FILL, color: 'auto' } : undefined,
    children: [new Paragraph({ children: runs(c.tokens, head ? { bold: true, size: 19 } : { size: 19 }) })],
  });
  return new Table({
    width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: widths,
    rows: [new TableRow({ tableHeader: true, children: tok.header.map((c, i) => cell(c, i, true)) }),
      ...tok.rows.map((r) => new TableRow({ children: r.map((c, i) => cell(c, i, false)) }))],
  });
}

const children = [];
let first = true;
for (const tok of tokens) {
  if (tok.type === 'heading') {
    if (tok.depth === 1) {
      children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: runs(tok.tokens) }));
    } else {
      children.push(new Paragraph({ heading: tok.depth === 2 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2,
        pageBreakBefore: tok.depth === 2 && !first, children: runs(tok.tokens) }));
      if (tok.depth === 2) first = false;
    }
  } else if (tok.type === 'paragraph') {
    const only = tok.tokens.length === 1 && tok.tokens[0].type === 'image' ? tok.tokens[0] : null;
    if (only) children.push(...imageParagraphs(only));
    else children.push(new Paragraph({ spacing: { after: 120 }, children: runs(tok.tokens) }));
    // Contents list right after the title's byline.
    if (children.length === 3 && headings.length) {   // title, byline, introduction
      children.push(new Paragraph({ spacing: { before: 200, after: 80 }, children: [new TextRun({ text: 'Contents', bold: true, color: TEAL })] }));
      const inst = ++listInstance;
      for (const h of headings) children.push(new Paragraph({ numbering: { reference: 'steps', level: 0, instance: inst }, spacing: { after: 20 }, children: [new TextRun(h.text)] }));
    }
  } else if (tok.type === 'list') {
    children.push(...listParagraphs(tok));
  } else if (tok.type === 'table') {
    children.push(tableBlock(tok), new Paragraph({ spacing: { after: 80 }, children: [] }));
  } else if (tok.type === 'blockquote') {
    for (const p of tok.tokens.filter((t) => t.type === 'paragraph')) {
      children.push(new Paragraph({ spacing: { before: 120, after: 120 }, indent: { left: 200 },
        shading: { type: ShadingType.CLEAR, fill: NOTE_FILL, color: 'auto' },
        border: { left: { style: BorderStyle.SINGLE, size: 24, color: 'F59E0B', space: 8 } },
        children: runs(p.tokens) }));
    }
  } else if (tok.type === 'code') {
    // A589: a fenced block (commands, SQL) — one shaded monospace line each, nothing wrapped into the next.
    for (const line of String(tok.text).split('\n')) {
      children.push(new Paragraph({ spacing: { after: 0 }, indent: { left: 200 }, shading: { type: ShadingType.CLEAR, fill: 'F3F4F6', color: 'auto' },
        children: [new TextRun({ text: line || ' ', font: 'Consolas', size: 17 })] }));
    }
    children.push(new Paragraph({ spacing: { after: 80 }, children: [] }));
  } else if (tok.type === 'hr') {
    children.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: LINE, space: 1 } }, children: [] }));
  }
}

const levels = (fmt) => [0, 1, 2].map((level) => ({
  level, format: fmt, text: fmt === LevelFormat.BULLET ? ['•', '◦', '▪'][level] : `%${level + 1}.`, alignment: AlignmentType.LEFT,
  style: { paragraph: { indent: { left: 360 + level * 360, hanging: 360 } } },
}));
const doc = new Document({
  creator: 'ZapTill', title, description: title,
  styles: {
    default: { document: { run: { font: 'Calibri', size: 21, color: INK } } },
    paragraphStyles: [
      { id: 'Title', name: 'Title', basedOn: 'Normal', run: { size: 44, bold: true, color: TEAL }, paragraph: { spacing: { after: 120 } } },
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 32, bold: true, color: TEAL }, paragraph: { spacing: { before: 240, after: 160 }, outlineLevel: 0, keepNext: true } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 25, bold: true, color: INK }, paragraph: { spacing: { before: 200, after: 100 }, outlineLevel: 1, keepNext: true } },
    ],
  },
  numbering: { config: [
    { reference: 'bullets', levels: levels(LevelFormat.BULLET) },
    { reference: 'steps', levels: levels(LevelFormat.DECIMAL) },
  ] },
  sections: [{
    properties: { page: { size: { width: PAGE_W, height: 16838 }, margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN } } },
    footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [
      new TextRun({ text: `${title} · page `, color: QUIET, size: 16 }), new TextRun({ children: [PageNumber.CURRENT], color: QUIET, size: 16 }),
    ] })] }) },
    children,
  }],
});
writeFileSync(resolve(baseDir, `${stem}.docx`), await Packer.toBuffer(doc));
console.log(`wrote ${stem}.html and ${stem}.docx in ${baseDir} (${imgCache.size} images)`);
