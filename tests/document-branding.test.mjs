/**
 * document-branding.test.mjs — 0.6.25: every document carries the client's logo, and looks corporate.
 *
 * Owner, 2026-09-30: "also add the logo in all documents being generated from the system beautify the documents make them
 * bit cooporate".
 *
 *   node tests/document-branding.test.mjs
 *
 * RUNS the real A4 engine (apps/dashboard/src/lib/printDocument.ts buildDocumentHtml, type-stripped); pins the thermal
 * Z-report line (its runtime check is shared/printing/test/shift-report-logo.test.ts) and the callers that fetch the logo.
 *
 * MUTATIONS TO CONFIRM BITE: the Branding logo ignored (logo_url only) → "the Branding logo is used" fails; the footer
 * dropped → "a footer" fails; escaping dropped → "user text is escaped" fails; the Z-report's logo line removed →
 * "the thermal Z-report prints the logo" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.DOC_BRAND_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, DOC_BRAND_TS: '1' } });
  process.exit(r.status ?? 1);
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n       ${e.message}`); } };

const D = await import(pathToFileURL(path.join(ROOT, 'apps/dashboard/src/lib/printDocument.ts')).href);
const spec = {
  docType: 'PURCHASE ORDER', number: 'PO-0001', dateLabel: '30 Sep 2026', statusLabel: 'sent', accent: D.DOC_ACCENT.po,
  business: { name: 'B Foods <&>', phone: '0712', tax_pin: 'P05', logo_url: 'https://old.example/logo.png' },
  meta: [{ label: 'Supplier', value: 'Kenchic' }], columns: [{ label: 'Item' }, { label: 'Qty', align: 'right' }],
  rows: [['<b>Chicken</b>', '4']], totals: [{ label: 'Total', value: 'KES 1,800.00' }],
};
const BRAND = 'data:image/png;base64,QlJBTkQ=';

console.log('0.6.25 — the logo on every document; a corporate look\n');
ok('the Branding logo is used (preferred over the old profile URL)', () => {
  const h = D.buildDocumentHtml(spec, BRAND, new Date(2026, 8, 30, 14, 5));
  assert.match(h, new RegExp(`<img class="logo" src="${BRAND.replace(/[+/=]/g, '\\$&')}"`));
  assert.doesNotMatch(h, /old\.example/);
});
ok('no Branding logo → the profile\'s logo URL; neither → no image', () => {
  assert.match(D.buildDocumentHtml(spec, null), /src="https:\/\/old\.example\/logo\.png"/);
  assert.doesNotMatch(D.buildDocumentHtml({ ...spec, business: { name: 'X' } }, null), /<img/);
});
ok('user text is escaped (names, cells)', () => {
  const h = D.buildDocumentHtml(spec, BRAND);
  assert.match(h, /B Foods &lt;&amp;&gt;/);
  assert.match(h, /&lt;b&gt;Chicken&lt;\/b&gt;/);
  assert.doesNotMatch(h, /<b>Chicken<\/b>/);
});
ok('a footer names the business and the document, with when it was printed', () => {
  const h = D.buildDocumentHtml(spec, BRAND, new Date(2026, 8, 30, 14, 5));
  assert.match(h, /<div class="foot"><span>B Foods &lt;&amp;&gt; &nbsp;·&nbsp; PURCHASE ORDER PO-0001<\/span><span>Printed [^<]*2026[^<]* &nbsp;·&nbsp; SwiftPOS<\/span><\/div>/);
});
ok('corporate layout: accent title, shaded table header, totals box, signature guidance', () => {
  const h = D.buildDocumentHtml(spec, BRAND);
  assert.match(h, /\.doctype \{ font-size:22px; font-weight:800;[^}]*color:#4f46e5;/);
  assert.match(h, /table\.items th \{ background:#f3f4f6; border-top:2px solid #4f46e5;/);
  assert.match(h, /Name, signature &amp; date/);
});
ok('the window opens inside the click, then the logo is filled in (no popup block)', () => {
  const src = read('apps/dashboard/src/lib/printDocument.ts');
  assert.ok(src.indexOf("window.open('', '_blank'") < src.indexOf('void brandLogo().then('));
  assert.match(src, /api\.get<\{ logo_png: string \| null \} \| null>\('\/api\/business\/branding'\)/);
});

ok('the web end-of-day Z-report is headed by the logo', () => {
  const z = read('apps/dashboard/src/pages/pos/ZReportModal.tsx');
  assert.match(z, /void documentLogo\(\)\.then\(\(logo\) => \{/);
  assert.match(z, /<\/head><body>\$\{logoHtml\}\$\{el\.innerHTML\}<\/body><\/html>/);
});

// ── The thermal Z-report ─────────────────────────────────────────────────────
// Its runtime check lives in shared/printing/test/shift-report-logo.test.ts (that package's npm test builds it); this
// suite runs where shared/printing is NOT built, so here the renderer line is pinned in the source.
ok('the thermal Z-report prints the logo first when given', () => {
  assert.match(read('shared/printing/src/shiftReport.ts'),
    /\/\/ ── Heading ─+\n  if \(r\.logoRaster\) d\.image\(r\.logoRaster, 'center'\);/);
});
ok('the till and the web pass the receipt logo to the Z-report (same switch as the receipt)', () => {
  assert.match(read('apps/desktop/src/main/print/printWorker.ts'), /const logoRaster = brand\?\.receiptLogoEnabled && brand\.logoReceipt \? monoRasterFromString\(brand\.logoReceipt\)/);
  assert.match(read('apps/dashboard/src/lib/printShiftReport.ts'), /logoRaster:\s+branding\?\.receipt_logo_enabled && branding\.logo_receipt \? monoRasterFromString\(branding\.logo_receipt\)/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
