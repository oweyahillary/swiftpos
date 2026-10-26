# Manual builder

Every ZapTill manual ships as a **Word document (.docx)** and a **self-contained web page (.html)**. Owner, 2026-10-22: "for manuals always create a word document and a .html file".

You write one markdown file. Its images are relative paths, e.g. `![Caption](screenshots/01c-admin-new-client-form.png)`. The builder then writes `<name>.docx` and `<name>.html` next to the markdown, with every image embedded, so each file opens on its own: send it by email, print it, or open it offline.

```
cd docs/tools/manual-builder
npm install            # once
node build.mjs ../../setup/TECHNICIAN-SETUP-GUIDE.md
```

**What the markdown can contain:**
- headings: `#` title, `##` sections (each starts a new page in Word), `###` subsections;
- paragraphs with **bold**, *italic*, `code` and links;
- fenced code blocks (commands, SQL — A589);
- numbered and bullet lists, and `- [ ]` checklists;
- tables;
- `>` notes (amber box);
- images on a line of their own; the alt text becomes the caption.

**What it produces:**
- **Word:** A4, 2 cm margins, a contents list after the introduction, and page numbers in the footer. To check it, open it in Word, or let Word save a PDF copy.
- **HTML:** linked contents, readable on a phone, and a print layout with one section per page.

**Manuals built with it:**
- `docs/setup/TECHNICIAN-SETUP-GUIDE` (the screenshots are in `docs/setup/screenshots/`). The same guide is also shared as a Claude doc.
- `docs/Manuals/BARCODE-LABELS` (A571: barcodes, label sizes, printing on label printers, sticker sheets and the receipt printer; driver tips for Xprinter, TSC and Zebra).
- `docs/BACKUPS` (A589: the nightly backup, the restore and its monthly test, the down check).
