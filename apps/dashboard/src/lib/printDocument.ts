/**
 * printDocument — print a full-page (A4) business document: purchase order, goods
 * received note, stock transfer note, etc.
 *
 * Distinct from printReceipt (which is thermal 58/80mm). This opens a print window
 * with a clean, self-contained A4 layout: business header, document title + number
 * + date, a meta grid (supplier / from-to / status …), a line-item table, optional
 * totals, an optional note, and signature lines. Callers pre-format money (the
 * engine renders cells verbatim), so it stays generic.
 *
 * All caller-supplied text is HTML-escaped — product/supplier names are user data.
 */

export interface PrintDocColumn { label: string; align?: 'left' | 'right' }
export interface PrintDocSpec {
  docType: string;                                   // "PURCHASE ORDER"
  number: string;                                    // "PO-0001"
  dateLabel?: string;                                // "5 Sep 2026"
  business: { name: string; address?: string | null; phone?: string | null; tax_pin?: string | null; logo_url?: string | null };
  meta?: { label: string; value: string }[];         // Supplier / From / To / Expected …
  columns: PrintDocColumn[];
  rows: (string | number)[][];                       // each row aligned to columns
  totals?: { label: string; value: string }[];
  note?: string | null;
  signatures?: string[];                             // e.g. ["Prepared by", "Received by"]
  accent?: string;                                   // hex accent (top bar + status pill); see DOC_ACCENT
  statusLabel?: string;                              // e.g. "Received" — rendered as a coloured pill
}

/**
 * Semantic accents per document/status. Colour reinforces meaning at a glance
 * (green = goods in / done, amber = in transit, red = cancelled) but never carries
 * it alone — the status also prints as text, so a B&W copy loses nothing. Accents
 * are thin (a top bar + a bordered pill), not big fills, to stay light on toner.
 */
export const DOC_ACCENT = {
  po:        '#4f46e5', // indigo — purchase order (a request going out)
  grn:       '#16a34a', // green  — goods received (complete)
  despatch:  '#d97706', // amber  — transfer despatch (in transit)
  received:  '#0d9488', // teal   — transfer received
  cancelled: '#dc2626', // red    — cancelled / void
  default:   '#111827', // near-black — fallback
} as const;

const titleCase = (s: string): string =>
  s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());


const esc = (v: unknown): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// ── 0.6.25: the client's logo on every document ────────────────────────────────────────────────────────────────
// Owner, 2026-09-30: "add the logo in all documents being generated from the system beautify the documents make them bit
// cooporate". Documents read the logo from Branding (the one place a business sets it — A368), falling back to the older
// Business profile "Logo image URL". Fetched once per page load and cached; a failed read just prints without a logo.
let brandLogoCache: Promise<string | null> | null = null;
/** The client's logo (Branding) for any printed page — cached; null when there is none or it cannot be read. */
export function documentLogo(): Promise<string | null> { return brandLogo(); }
function brandLogo(): Promise<string | null> {
  if (!brandLogoCache) {
    brandLogoCache = import('./api')
      .then(({ api }) => api.get<{ logo_png: string | null } | null>('/api/business/branding'))
      .then((b) => b?.logo_png ?? null)
      .catch(() => { brandLogoCache = null; return null; });
  }
  return brandLogoCache;
}

/** The whole document as HTML — pure, so a test (and a preview) can render it without a browser window. */
export function buildDocumentHtml(spec: PrintDocSpec, logo?: string | null, printedAt: Date = new Date()): string {
  const {
    docType, number, dateLabel, business,
    meta = [], columns, rows, totals = [], note, signatures = ['Prepared by', 'Authorised by'],
    accent = DOC_ACCENT.default, statusLabel,
  } = spec;
  const logoSrc = logo || business.logo_url || null;

  const metaHtml = meta.length
    ? `<div class="meta">${meta.map(m => `<div class="mi"><div class="ml">${esc(m.label)}</div><div class="mv">${esc(m.value)}</div></div>`).join('')}</div>`
    : '';

  const head = `<tr>${columns.map(c => `<th class="${c.align === 'right' ? 'r' : 'l'}">${esc(c.label)}</th>`).join('')}</tr>`;
  const body = rows.length
    ? rows.map(r => `<tr>${r.map((cell, i) => `<td class="${columns[i]?.align === 'right' ? 'r' : 'l'}">${esc(cell)}</td>`).join('')}</tr>`).join('')
    : `<tr><td class="l empty" colspan="${columns.length}">No items.</td></tr>`;

  const totalsHtml = totals.length
    ? `<table class="totals">${totals.map((t, i) =>
        `<tr class="${i === totals.length - 1 ? 'grand' : ''}"><td class="l">${esc(t.label)}</td><td class="r">${esc(t.value)}</td></tr>`).join('')}</table>`
    : '';

  const noteHtml = note && String(note).trim()
    ? `<div class="note"><div class="nl">Notes</div><div>${esc(note)}</div></div>` : '';

  const sigHtml = signatures.length
    ? `<div class="sigs">${signatures.map(s => `<div class="sig"><div class="sigline"></div><div class="sigl">${esc(s)}</div><div class="sigd">Name, signature &amp; date</div></div>`).join('')}</div>`
    : '';

  const pillHtml = statusLabel
    ? `<span class="pill">${esc(titleCase(statusLabel))}</span>`
    : '';

  const stamp = printedAt.toLocaleString('en-KE', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const contact = [
    business.phone ? 'Tel: ' + esc(business.phone) : '',
    business.tax_pin ? 'PIN: ' + esc(business.tax_pin) : '',
  ].filter(Boolean).join(' &nbsp;·&nbsp; ');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(docType)} ${esc(number)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", -apple-system, Roboto, Helvetica, Arial, sans-serif; color:#1f2937; margin:0; font-size:12px; }
  .accentbar { height:6px; background:${esc(accent)}; }
  .page { padding:28px 40px 24px; }
  .top { display:flex; justify-content:space-between; align-items:center; gap:24px; padding-bottom:18px; border-bottom:1px solid #d1d5db; }
  .bizblock { display:flex; align-items:center; gap:16px; }
  .logo { max-height:76px; max-width:200px; object-fit:contain; display:block; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  .biz { font-size:20px; font-weight:700; color:#111827; letter-spacing:.01em; }
  .bizsub { font-size:11px; color:#6b7280; margin-top:3px; line-height:1.55; }
  .doc { text-align:right; }
  .doctype { font-size:22px; font-weight:800; letter-spacing:.08em; color:${esc(accent)}; }
  .docnum { font-size:13px; font-weight:600; margin-top:4px; color:#111827; }
  .docdate { font-size:11px; color:#6b7280; margin-top:2px; }
  .pill { display:inline-block; margin-top:8px; border:1.5px solid ${esc(accent)}; color:${esc(accent)};
          border-radius:999px; padding:2px 12px; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.06em; }
  .meta { display:grid; grid-template-columns:1fr 1fr; gap:0; margin:20px 0 18px; border:1px solid #e5e7eb; border-radius:8px; overflow:hidden; background:#f9fafb; }
  .meta .mi { padding:9px 14px; border-bottom:1px solid #e5e7eb; }
  .meta .mi:nth-child(odd) { border-right:1px solid #e5e7eb; }
  .meta .ml { color:#6b7280; font-size:9.5px; text-transform:uppercase; letter-spacing:.07em; }
  .meta .mv { font-weight:600; font-size:12.5px; color:#111827; margin-top:2px; }
  table.items { width:100%; border-collapse:collapse; margin-top:4px; font-size:12px; }
  table.items th { background:#f3f4f6; border-top:2px solid ${esc(accent)}; border-bottom:1px solid #d1d5db; padding:8px 10px;
                   font-size:9.5px; text-transform:uppercase; letter-spacing:.07em; color:#374151; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  table.items td { border-bottom:1px solid #eceef1; padding:8px 10px; font-variant-numeric:tabular-nums; }
  table.items tbody tr:nth-child(even) td { background:#fafafb; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  table.items td.empty { color:#9ca3af; padding:16px 10px; }
  .l { text-align:left; } .r { text-align:right; }
  table.totals { margin-left:auto; margin-top:14px; border-collapse:collapse; font-size:12px; min-width:260px; border:1px solid #e5e7eb; border-radius:8px; }
  table.totals td { padding:6px 14px; font-variant-numeric:tabular-nums; }
  table.totals tr.grand td { border-top:2px solid ${esc(accent)}; font-weight:800; font-size:14px; padding-top:9px; padding-bottom:9px; color:#111827; }
  .note { margin-top:22px; font-size:12px; white-space:pre-line; border-left:3px solid ${esc(accent)}; background:#f9fafb; padding:10px 14px; border-radius:0 6px 6px 0; }
  .note .nl { color:#6b7280; font-size:9.5px; text-transform:uppercase; letter-spacing:.07em; margin-bottom:4px; }
  .sigs { display:flex; gap:48px; margin-top:52px; }
  .sig { flex:1; } .sigline { border-top:1px solid #9ca3af; } .sigl { font-size:11px; color:#374151; font-weight:600; margin-top:5px; }
  .sigd { font-size:9.5px; color:#9ca3af; margin-top:1px; }
  .foot { margin-top:34px; padding-top:10px; border-top:1px solid #e5e7eb; display:flex; justify-content:space-between; font-size:9.5px; color:#9ca3af; }
  @media print { @page { margin:12mm; } .accentbar { -webkit-print-color-adjust:exact; print-color-adjust:exact; } }
</style></head><body>
  <div class="accentbar"></div>
  <div class="page">
  <div class="top">
    <div class="bizblock">
      ${logoSrc ? `<img class="logo" src="${esc(logoSrc)}" alt="" />` : ''}
      <div>
        <div class="biz">${esc(business.name)}</div>
        <div class="bizsub">
          ${business.address ? esc(business.address) + '<br>' : ''}${contact}
        </div>
      </div>
    </div>
    <div class="doc">
      <div class="doctype">${esc(docType)}</div>
      <div class="docnum">${esc(number)}</div>
      ${dateLabel ? `<div class="docdate">${esc(dateLabel)}</div>` : ''}
      ${pillHtml}
    </div>
  </div>
  ${metaHtml}
  <table class="items"><thead>${head}</thead><tbody>${body}</tbody></table>
  ${totalsHtml}
  ${noteHtml}
  ${sigHtml}
  <div class="foot"><span>${esc(business.name)} &nbsp;·&nbsp; ${esc(docType)} ${esc(number)}</span><span>Printed ${esc(stamp)} &nbsp;·&nbsp; ZapTill</span></div>
  </div>
</body></html>`;
}

export function printDocument(spec: PrintDocSpec): void {
  // The window opens NOW, inside the click, so a popup blocker allows it; the logo is filled in a moment later.
  const win = window.open('', '_blank', 'width=820,height=900');
  if (!win) return; // popup blocked — caller can surface a message
  win.document.open();
  win.document.write('<p style="font-family:sans-serif;color:#6b7280;padding:24px">Preparing the document…</p>');
  void brandLogo().then((logo) => {
    win.document.open();
    win.document.write(buildDocumentHtml(spec, logo));
    win.document.close();
    // Give the browser a tick to lay out (and the logo to decode) before printing.
    setTimeout(() => { try { win.focus(); win.print(); } catch { /* user can print manually */ } }, 350);
  });
}
