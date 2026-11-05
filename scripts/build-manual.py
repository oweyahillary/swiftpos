"""build-manual.py — a ZapTill manual's Markdown → .docx (python-docx) and a self-contained .html, as Stage 0's
docs/Manuals/ANDROID-INSTALL was made. Usage: python scripts/build-manual.py docs/Manuals/X.md docs/Manuals/X.docx docs/Manuals/X.html (needs python-docx)

Handles what the manuals use: # title, ## headings, paragraphs, > notes, | tables |, 1. numbered and - bulleted lists
(one level of nesting), **bold** and `code`.
"""
import html
import re
import sys
import copy

from docx import Document
from docx.enum.text import WD_BREAK  # noqa: F401  (kept for parity with other manual scripts)
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor, Twips

TEAL = RGBColor(0x0F, 0x76, 0x6E)
CSS = """:root{--ink:#1f2937;--quiet:#6b7280;--teal:#0f766e;--line:#d1d5db;--head:#e6f4f1;--note:#fff7e6;--bg:#ffffff;--card:#f9fafb}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 "Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif}
.wrap{max-width:900px;margin:0 auto;padding:32px 20px 80px}
h1{font-size:2rem;line-height:1.2;color:var(--teal);margin:0 0 4px}
h2{font-size:1.4rem;color:var(--teal);margin:48px 0 12px;padding-top:12px;border-top:2px solid var(--head)}
h3{font-size:1.1rem;margin:28px 0 8px}
p{margin:10px 0}
code{background:#f3f4f6;border-radius:4px;padding:1px 5px;font-size:.92em}
table{border-collapse:collapse;width:100%;margin:14px 0;font-size:.94rem}
th,td{border:1px solid var(--line);padding:7px 10px;text-align:left;vertical-align:top}
th{background:var(--head)}
tbody tr:nth-child(even){background:var(--card)}
blockquote{margin:14px 0;padding:10px 14px;background:var(--note);border-left:4px solid #f59e0b;border-radius:4px}
ul,ol{padding-left:24px}
li{margin:4px 0}
@media print{h2{break-after:avoid}table,blockquote{break-inside:avoid}}"""

INLINE = re.compile(r"(\*\*[^*]+\*\*|`[^`]+`)")


def blocks(md):
    """Split into blocks: ('title'|'h2'|'h3'|'p'|'quote'|'table'|'list', payload)."""
    lines = md.replace("\r\n", "\n").split("\n")
    out, i = [], 0
    while i < len(lines):
        line = lines[i]
        if not line.strip():
            i += 1
            continue
        if line.startswith("# "):
            out.append(("title", line[2:].strip())); i += 1; continue
        if line.startswith("## "):
            out.append(("h2", line[3:].strip())); i += 1; continue
        if line.startswith("### "):
            out.append(("h3", line[4:].strip())); i += 1; continue
        if line.startswith(">"):
            buf = []
            while i < len(lines) and lines[i].startswith(">"):
                buf.append(lines[i].lstrip(">").strip()); i += 1
            out.append(("quote", " ".join(buf))); continue
        if line.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].startswith("|"):
                cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
                if not all(re.fullmatch(r":?-{3,}:?", c) for c in cells):
                    rows.append(cells)
                i += 1
            out.append(("table", rows)); continue
        if re.match(r"^\s*(\d+\.|-)\s", line):
            items = []   # (level, ordered, text)
            while i < len(lines) and lines[i].strip():
                m = re.match(r"^(\s*)(\d+\.|-)\s+(.*)$", lines[i])
                if m:
                    items.append([1 if len(m.group(1)) >= 2 else 0, m.group(2) != "-", m.group(3)])
                else:
                    items[-1][2] += " " + lines[i].strip()   # a wrapped line of the item above
                i += 1
            out.append(("list", items)); continue
        buf = []
        while i < len(lines) and lines[i].strip() and not re.match(r"^(#|>|\||\s*(\d+\.|-)\s)", lines[i]):
            buf.append(lines[i].strip()); i += 1
        out.append(("p", " ".join(buf)))
    return out


# ── HTML ───────────────────────────────────────────────────────────────────────────────────────────────────────────

def inline_html(text):
    parts = []
    for piece in INLINE.split(text):
        if piece.startswith("**") and piece.endswith("**"):
            parts.append(f"<strong>{html.escape(piece[2:-2], quote=False)}</strong>")
        elif piece.startswith("`") and piece.endswith("`"):
            parts.append(f"<code>{html.escape(piece[1:-1], quote=False)}</code>")
        else:
            parts.append(html.escape(piece, quote=False))
    return "".join(parts)


def list_html(items):
    out, stack = [], []
    for level, ordered, text in items:
        tag = "ol" if ordered else "ul"
        while len(stack) > level + 1:
            out.append(f"</li></{stack.pop()}>")
        if len(stack) == level + 1 and stack[-1] != tag:
            out.append(f"</li></{stack.pop()}>")
        if len(stack) < level + 1:
            out.append(f"<{tag}>")
            stack.append(tag)
        elif out and not out[-1].endswith(f"<{tag}>"):
            out.append("</li>")
        out.append(f"<li>{inline_html(text)}")
    while stack:
        out.append(f"</li></{stack.pop()}>")
    return "".join(out)


def to_html(bs):
    title = next(p for k, p in bs if k == "title")
    body = []
    for kind, p in bs:
        if kind == "title":
            body.append(f"<h1>{inline_html(p)}</h1>")
        elif kind == "h2":
            body.append(f"<h2>{inline_html(p)}</h2>")
        elif kind == "h3":
            body.append(f"<h3>{inline_html(p)}</h3>")
        elif kind == "p":
            body.append(f"<p>{inline_html(p)}</p>")
        elif kind == "quote":
            body.append(f"<blockquote>{inline_html(p)}</blockquote>")
        elif kind == "table":
            head, rows = p[0], p[1:]
            th = "".join(f"<th>{inline_html(c)}</th>" for c in head)
            trs = "".join("<tr>" + "".join(f"<td>{inline_html(c)}</td>" for c in r) + "</tr>" for r in rows)
            body.append(f"<table><thead><tr>{th}</tr></thead><tbody>{trs}</tbody></table>")
        elif kind == "list":
            body.append(list_html(p))
    return ("<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
            f"<title>{html.escape(title)}</title>\n<style>\n{CSS}\n</style></head>\n<body><div class=\"wrap\">\n"
            + "\n".join(body) + "\n</div></body></html>\n")


# ── Word ───────────────────────────────────────────────────────────────────────────────────────────────────────────

def add_runs(par, text, italic=False):
    for piece in INLINE.split(text):
        if not piece:
            continue
        if piece.startswith("**") and piece.endswith("**"):
            r = par.add_run(piece[2:-2]); r.bold = True
        elif piece.startswith("`") and piece.endswith("`"):
            r = par.add_run(piece[1:-1]); r.font.name = "Consolas"; r.font.size = Pt(9.5)
            r._element.rPr.rFonts.set(qn("w:hAnsi"), "Consolas")
        else:
            r = par.add_run(piece)
        if italic:
            r.italic = True


def restart_numbering(doc, par):
    """Each numbered list starts at 1: a new w:num on the List Number style's own numbering, restarted."""
    numbering = doc.part.numbering_part.numbering_definitions._numbering
    style_num = doc.styles["List Number"]._element.find(qn("w:pPr")).find(qn("w:numPr")).find(qn("w:numId")).get(qn("w:val"))
    abstract = next(n.find(qn("w:abstractNumId")).get(qn("w:val")) for n in numbering.findall(qn("w:num")) if n.get(qn("w:numId")) == style_num)
    new_id = str(max(int(n.get(qn("w:numId"))) for n in numbering.findall(qn("w:num"))) + 1)
    num = OxmlElement("w:num"); num.set(qn("w:numId"), new_id)
    a = OxmlElement("w:abstractNumId"); a.set(qn("w:val"), abstract); num.append(a)
    ov = OxmlElement("w:lvlOverride"); ov.set(qn("w:ilvl"), "0")
    so = OxmlElement("w:startOverride"); so.set(qn("w:val"), "1"); ov.append(so); num.append(ov)
    numbering.append(num)
    pPr = par._p.get_or_add_pPr()
    numPr = OxmlElement("w:numPr")
    il = OxmlElement("w:ilvl"); il.set(qn("w:val"), "0"); numPr.append(il)
    ni = OxmlElement("w:numId"); ni.set(qn("w:val"), new_id); numPr.append(ni)
    pPr.append(numPr)
    return new_id


def use_num(par, num_id):
    pPr = par._p.get_or_add_pPr()
    numPr = OxmlElement("w:numPr")
    il = OxmlElement("w:ilvl"); il.set(qn("w:val"), "0"); numPr.append(il)
    ni = OxmlElement("w:numId"); ni.set(qn("w:val"), num_id); numPr.append(ni)
    pPr.append(numPr)


def shade(cell, fill):
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd"); shd.set(qn("w:val"), "clear"); shd.set(qn("w:color"), "auto"); shd.set(qn("w:fill"), fill)
    tcPr.append(shd)


def to_docx(bs, path):
    doc = Document()
    for kind, p in bs:
        if kind == "title":
            par = doc.add_paragraph(style="Title"); r = par.add_run(p); r.font.color.rgb = TEAL
        elif kind in ("h2", "h3"):
            par = doc.add_heading(level=1 if kind == "h2" else 2)
            add_runs(par, p)
            for r in par.runs:
                r.font.color.rgb = TEAL
        elif kind == "p":
            add_runs(doc.add_paragraph(), p)
        elif kind == "quote":
            par = doc.add_paragraph(); par.paragraph_format.left_indent = Twips(240)
            add_runs(par, p, italic=True)
        elif kind == "table":
            t = doc.add_table(rows=len(p), cols=len(p[0])); t.style = "Table Grid"
            for ri, row in enumerate(p):
                for ci, text in enumerate(row):
                    cell = t.cell(ri, ci)
                    par = cell.paragraphs[0]
                    if ri == 0:
                        r = par.add_run(re.sub(r"\*\*", "", text)); r.bold = True; shade(cell, "E6F4F1")
                    else:
                        add_runs(par, text)
        elif kind == "list":
            num_id = None
            for level, ordered, text in p:
                if ordered and level == 0:
                    par = doc.add_paragraph(style="List Number")
                    if num_id is None:
                        num_id = restart_numbering(doc, par)
                    else:
                        use_num(par, num_id)
                else:
                    par = doc.add_paragraph(style="List Bullet 2" if level else "List Bullet")
                add_runs(par, text)
    doc.core_properties.title = next(p for k, p in bs if k == "title")
    doc.core_properties.author = "ZapTill"
    doc.save(path)


if __name__ == "__main__":
    src, out_docx, out_html = sys.argv[1:4]
    md = open(src, encoding="utf-8").read()
    bs = blocks(md)
    to_docx(bs, out_docx)
    with open(out_html, "w", encoding="utf-8", newline="\n") as f:
        f.write(to_html(bs))
    print(f"{len(bs)} blocks -> {out_docx}, {out_html}")
