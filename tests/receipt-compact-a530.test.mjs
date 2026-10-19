/**
 * A530 — the compact receipt is the standard; four switches per client in the admin portal put the old one back.
 *
 * Owner, 2026-10-19: "I feel the receipt is too long wasting paper" … "the switch settings … should be in the admin per
 * client". The layout, spacing, logo and feed themselves are pinned in shared/printing (test/receipt-compact.test.ts,
 * with the 1.0.19 golden). This pins the wiring: the four switches in shared/posFeatures.ts, the admin portal switching
 * them, the client unable to, and every receipt path (the till's queue and test print, the web POS's receipt, Print Bill
 * and reprint) handing them to the renderer — running the real web mapper and the committed web bundle.
 *
 * MUTATION-CHECKED: drop receiptClassic from the till's business config, the web mapper, PaymentModal's call or the
 * reprint's flags and its case goes red; make the web mapper read `!== false` and the mapping case goes red.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.A530_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, A530_TS: '1' } });
  process.exit(r.status ?? 1);
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const F = await import(pathToFileURL(path.join(ROOT, 'shared/posFeatures.ts')).href);
const B = await import(pathToFileURL(path.join(ROOT, 'apps/dashboard/src/lib/buildReceiptOrder.ts')).href);
const E = await import(pathToFileURL(path.join(ROOT, 'apps/dashboard/src/lib/escposRenderer.js')).href);
const KEYS = ['receipt_classic_spacing', 'receipt_full_logo', 'receipt_classic_layout', 'receipt_extra_feed'];

await ok('the four switches, named and explained, off unless set', () => {
  assert.deepEqual([...F.RECEIPT_CLASSIC_KEYS], KEYS);
  const labels = Object.fromEntries(F.POS_FEATURES.map((f) => [f.key, f.label]));
  assert.equal(labels.receipt_classic_spacing, 'Classic line spacing (4.23 mm)');
  assert.equal(labels.receipt_full_logo, 'Full-size receipt logo (up to 36 mm)');
  assert.equal(labels.receipt_classic_layout, 'Classic receipt layout (all separators and lines)');
  assert.equal(labels.receipt_extra_feed, 'Extra paper before the cut (3 lines) — for a cutter that clips the last line');
  for (const k of KEYS) {
    assert.ok(F.POS_FEATURE_KEYS.includes(k), k);
    assert.ok(F.POS_FEATURES.find((f) => f.key === k).description.length > 40, `${k} explained`);
    assert.equal(F.noPosFeatures()[k], false, `${k} off by default`);
  }
  assert.deepEqual(F.receiptClassicFrom(null), { spacing: false, fullLogo: false, layout: false, extraFeed: false });
  assert.deepEqual(F.receiptClassicFrom(F.parsePosFeatures([{ key: 'receipt_full_logo', enabled: true }, { key: 'receipt_extra_feed', enabled: 'yes' }])),
    { spacing: false, fullLogo: true, layout: false, extraFeed: false });
});

await ok('the web mapper gives the same answer as posFeatures.receiptClassicFrom', () => {
  const biz = { name: 'B', currency: 'KES', vat_rate: 16 };
  for (const pf of [undefined, null, {}, { receipt_classic_spacing: true }, { receipt_full_logo: true, receipt_classic_layout: true },
    Object.fromEntries(KEYS.map((k) => [k, true])), Object.fromEntries(KEYS.map((k) => [k, 'true']))]) {
    assert.deepEqual(B.buildReceiptBusinessConfig(biz, undefined, 0, { posFeatures: pf }).receiptClassic, F.receiptClassicFrom(pf), JSON.stringify(pf));
  }
});

await ok('the web bundle prints compact by default and classic with all four switches', () => {
  const biz = (pf) => B.buildReceiptBusinessConfig({ name: 'B Foods', currency: 'KES', vat_rate: 16 }, undefined, 0, { posFeatures: pf });
  const order = { billNumber: 'W-1', orderType: 'takeaway', cashierName: 'Amina', soldAt: '2026-10-19T09:00:00Z', kotCount: 0,
    lines: [{ name: 'Burger', quantity: 1, unitPrice: 50000, lineTotal: 50000, units: [], stationIds: [] }],
    payments: [{ label: 'CASH', amount: 50000 }], changeGiven: 0, total: 50000 };
  const compact = Buffer.from(E.renderReceiptEscPos(order, biz(null), 80));
  const classic = Buffer.from(E.renderReceiptEscPos(order, biz(Object.fromEntries(KEYS.map((k) => [k, true]))), 80));
  assert.ok(compact.includes(Buffer.from([0x1b, 0x33, 26])), 'ESC 3 26 on the compact receipt');
  assert.ok(!compact.includes(Buffer.from('Payment Detail:')) && !compact.includes(Buffer.from('Kots:')));
  assert.ok(compact.subarray(-7).equals(Buffer.from([0x1b, 0x64, 1, 0x1d, 0x56, 0x42, 0])), 'one line before the cut');
  assert.ok(!classic.includes(Buffer.from([0x1b, 0x33])), 'no ESC 3 with the classic spacing');
  assert.ok(classic.includes(Buffer.from('Payment Detail:')) && classic.includes(Buffer.from('Kots: 0')));
  assert.ok(classic.subarray(-7).equals(Buffer.from([0x1b, 0x64, 3, 0x1d, 0x56, 0x42, 0])), 'three lines before the cut');
  assert.ok(compact.length < classic.length);
});

await ok('every receipt path hands the switches to the renderer (till and web)', () => {
  assert.match(read('apps/desktop/src/main/ipcHandlers.ts'), /receiptClassic:\s+receiptClassicFrom\(getPosFeatures\(\)\),/);
  assert.match(read('apps/desktop/src/main/print/printWorker.ts'), /receiptClassic = receiptClassicFrom\(getPosFeatures\(\)\);/);
  assert.match(read('apps/dashboard/src/pages/pos/PaymentModal.tsx'), /logoRaster: receiptLogo, pay: receiptPay, posFeatures \}\);/);
  assert.match(read('apps/dashboard/src/pages/pos/CashierScreen.tsx'), /posFeatures=\{posFeatures\}/);
  assert.match(read('apps/dashboard/src/pages/pos/CashierScreen.tsx'), /posFeatures,\s+\/\/ A530: the client's classic-receipt switches\s+kinds: \['receipt'\]/);
  assert.match(read('apps/dashboard/src/lib/printRouted.ts'), /posFeatures: a\.posFeatures \}\);/);
  const rp = read('apps/dashboard/src/lib/reprintReceipt.ts');
  assert.match(rp, /api\.get<Record<string, boolean>>\('\/api\/flags'\)/);
  assert.match(rp, /posFeatures: flags,/);
});

await ok('the admin portal switches them per client; the owner and the client cannot', () => {
  const ap = read('apps/admin/src/AdminPortal.tsx');
  assert.match(ap, /\{RECEIPT_CLASSIC_KEYS\.map\(key => \{[\s\S]{0,900}toggle\(on, \(\) => toggleFeature\(key, !on\), rf\?\.label \?\? key\)/);
  assert.match(ap, /if \(\(RECEIPT_CLASSIC_KEYS as readonly string\[\]\)\.includes\(pf\.key\)\) return null;/);
  const ctl = read('apps/server/src/routes/controls.ts');
  const owner = /OWNER_POS_KEYS = \[([^\]]*)\]/.exec(ctl)[1];
  for (const k of KEYS) assert.ok(!owner.includes(k), `${k} is not an owner option`);
  // The client's PUT /api/flags refuses every POS_FEATURE_KEYS key — which now includes these four.
  assert.match(read('apps/server/src/routes/flags.ts'), /if \(\(POS_FEATURE_KEYS as readonly string\[\]\)\.includes\(req\.params\.key\)\) \{\s*res\.status\(403\)/);
});

await ok('a logo is stored up to 288 dots (till and web) and printed at 120; the web preview shows the printed size', () => {
  // Owner, 2026-10-19 ("that's okay"): storage full size, so 'receipt_full_logo' works for old and new uploads alike.
  assert.match(read('shared/printing/src/raster.ts'), /export const RECEIPT_LOGO_MAX_HEIGHT = 288;/);
  assert.match(read('shared/printing/src/raster.ts'), /export const RECEIPT_LOGO_PRINT_MAX_HEIGHT = 120;/);
  assert.match(read('apps/desktop/src/main/brandingGuard.ts'), /export const RGBA_MAX_HEIGHT = 288;/);
  assert.match(read('apps/desktop/src/renderer/lib/prepareRasterLogo.ts'), /export const RECEIPT_MAX_H = 288;/);
  assert.equal(E.RECEIPT_LOGO_MAX_HEIGHT, 288);
  assert.equal(E.RECEIPT_LOGO_PRINT_MAX_HEIGHT, 120);
  const bt = read('apps/dashboard/src/pages/settings/BrandingTab.tsx');
  assert.match(bt, /fitStoredLogo\(monoRasterFromString\(logoReceipt\)\)/);
  assert.match(bt, /fitMonoRaster\(r, RECEIPT_LOGO_MAX_WIDTH, RECEIPT_LOGO_PRINT_MAX_HEIGHT\)/);
  assert.match(bt, /Prints up to 15 mm tall \(full size if ZapTill turns on Full-size logo\)/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
