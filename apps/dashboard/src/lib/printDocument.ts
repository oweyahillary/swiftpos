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

export function printDocument(spec: PrintDocSpec): void {
  const {
    docType, number, dateLabel, business,
    meta = [], columns, rows, totals = [], note, signatures = ['Prepared by', 'Authorised by'],
    accent = DOC_ACCENT.default, statusLabel,
  } = spec;

  const metaHtml = meta.length
    ? `<div class="meta">${meta.map(m => `<div><span class="ml">${esc(m.label)}</span><span class="mv">${esc(m.value)}</span></div>`).join('')}</div>`
    : '';

  const head = `<tr>${columns.map(c => `<th class="${c.align === 'right' ? 'r' : 'l'}">${esc(c.label)}</th>`).join('')}</tr>`;
  const body = rows.length
    ? rows.map(r => `<tr>${r.map((cell, i) => `<td class="${columns[i]?.align === 'right' ? 'r' : 'l'}">${esc(cell)}</td>`).join('')}</tr>`).join('')
    : `<tr><td class="l" colspan="${columns.length}" style="color:#888;padding:14px 8px;">No items.</td></tr>`;

  const totalsHtml = totals.length
    ? `<table class="totals">${totals.map((t, i) =>
        `<tr class="${i === totals.length - 1 ? 'grand' : ''}"><td class="l">${esc(t.label)}</td><td class="r">${esc(t.value)}</td></tr>`).join('')}</table>`
    : '';

  const noteHtml = note && String(note).trim()
    ? `<div class="note"><div class="nl">Notes</div><div>${esc(note)}</div></div>` : '';

  const sigHtml = signatures.length
    ? `<div class="sigs">${signatures.map(s => `<div class="sig"><div class="sigline"></div><div class="sigl">${esc(s)}</div></div>`).join('')}</div>`
    : '';

  const pillHtml = statusLabel
    ? `<span class="pill">${esc(titleCase(statusLabel))}</span>`
    : '';

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(docType)} ${esc(number)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color:#111; margin:0; }
  .accentbar { height:6px; background:${esc(accent)}; }
  .page { padding:26px 36px 32px; }
  .top { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:2px solid #111; padding-bottom:14px; }
  .biz { font-size:18px; font-weight:700; }
  .bizblock { display:flex; align-items:flex-start; gap:12px; }
  .logo { max-height:52px; max-width:180px; object-fit:contain; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  .bizsub { font-size:11px; color:#555; margin-top:2px; line-height:1.5; }
  .doc { text-align:right; }
  .doctype { font-size:15px; font-weight:700; letter-spacing:.06em; }
  .docnum { font-size:13px; margin-top:2px; }
  .docdate { font-size:11px; color:#555; margin-top:2px; }
  .pill { display:inline-block; margin-top:6px; border:1.5px solid ${esc(accent)}; color:${esc(accent)};
          border-radius:999px; padding:2px 11px; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; }
  .meta { display:grid; grid-template-columns:1fr 1fr; gap:6px 24px; margin:18px 0; font-size:12px; }
  .meta .ml { color:#666; display:inline-block; min-width:96px; }
  .meta .mv { font-weight:600; }
  table.items { width:100%; border-collapse:collapse; margin-top:6px; font-size:12px; }
  table.items th { border-bottom:1.5px solid #111; padding:7px 8px; font-size:10px; text-transform:uppercase; letter-spacing:.05em; color:#333; }
  table.items td { border-bottom:1px solid #e3e3e3; padding:7px 8px; }
  .l { text-align:left; } .r { text-align:right; }
  table.totals { margin-left:auto; margin-top:12px; border-collapse:collapse; font-size:12px; min-width:220px; }
  table.totals td { padding:4px 8px; }
  table.totals tr.grand td { border-top:1.5px solid #111; font-weight:700; font-size:13px; padding-top:7px; }
  .note { margin-top:20px; font-size:12px; } .note .nl { color:#666; font-size:10px; text-transform:uppercase; letter-spacing:.05em; margin-bottom:3px; }
  .sigs { display:flex; gap:48px; margin-top:44px; }
  .sig { flex:1; } .sigline { border-top:1px solid #999; } .sigl { font-size:10px; color:#666; margin-top:4px; }
  @media print { @page { margin:14mm; } .accentbar { -webkit-print-color-adjust:exact; print-color-adjust:exact; } }
</style></head><body>
  <div class="accentbar"></div>
  <div class="page">
  <div class="top">
    <div class="bizblock">
      ${business.logo_url ? `<img class="logo" src="${esc(business.logo_url)}" alt="" />` : ''}
      <div>
        <div class="biz">${esc(business.name)}</div>
        <div class="bizsub">
          ${business.address ? esc(business.address) + '<br>' : ''}
          ${business.phone ? 'Tel: ' + esc(business.phone) : ''}${business.phone && business.tax_pin ? ' · ' : ''}${business.tax_pin ? 'PIN: ' + esc(business.tax_pin) : ''}
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
  </div>
</body></html>`;

  const win = window.open('', '_blank', 'width=820,height=900');
  if (!win) return; // popup blocked — caller can surface a message
  win.document.open();
  win.document.write(html);
  win.document.close();
  // Give the browser a tick to lay out before printing.
  setTimeout(() => { try { win.focus(); win.print(); } catch { /* user can print manually */ } }, 250);
}
