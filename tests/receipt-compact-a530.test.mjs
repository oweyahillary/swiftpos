/**
 * A530 — four receipt switches per client in the admin portal (A538: the classic layout at ~3.75 mm is the standard
 * again; the compact layout is one of the four, opt-in).
 *
 * Owner, 2026-10-19: "I feel the receipt is too long wasting paper" … "the switch settings … should be in the admin per
 * client". The layout, spacing, logo and feed themselves are pinned in shared/printing (test/receipt-compact.test.ts,
 * with the 1.0.19 golden). This pins the wiring: the four switches in shared/posFeatures.ts, the admin portal switching
 * them, the client unable to, and every receipt path (the till's queue and test print, the web POS's receipt, Print Bill
 * and reprint) handing them to the renderer — running the real web mapper and the committed web bundle.
 *
 * MUTATION-CHECKED: drop receiptClassic from the till's business config, the web mapper, PaymentModal's call or the
 * reprint's flags and its case goes red; make the web mapper read `!== false` and the mapping case goes red.
 *
 * A538 (owner, 2026-10-21, after printing the compact receipt: "it feels congested everywhere — qty, subtotal, ctl, vat,
 * roundoff — top arrangement totally off"; chose "go back to the old layout", "line spacing in the middle, about
 * 3.75 mm"): the standard is the classic layout at ESC 3 30 with the small logo and 1-line feed; 'receipt_classic_layout'
 * is retired and 'receipt_compact_layout' opts in to A530's lines. MUTATION-CHECKED (A538): the web mapper reading
 * receipt_classic_layout for compactLayout, the bundle's default back to compact, its spacing back to 26, the admin
 * portal listing a retired key under Other flags — each red on its own.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ipcHandlersSource } from '../scripts/lib/ipc-handler-files.mjs';   // D10: ipcHandlers.ts + ipc/*.ts

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
// A538: the admin portal's order — the compact opt-in first, then the three that bring 1.0.19's spacing, logo and feed.
const KEYS = ['receipt_compact_layout', 'receipt_classic_spacing', 'receipt_full_logo', 'receipt_extra_feed'];
const OLD_1019 = ['receipt_classic_spacing', 'receipt_full_logo', 'receipt_extra_feed'];   // A538: the 1.0.19 receipt

await ok('the four switches, named and explained, off unless set', () => {
  assert.deepEqual([...F.RECEIPT_OPTION_KEYS], KEYS);
  const labels = Object.fromEntries(F.POS_FEATURES.map((f) => [f.key, f.label]));
  assert.equal(labels.receipt_compact_layout, 'Compact receipt layout');
  assert.equal(labels.receipt_classic_spacing, 'Classic line spacing (4.23 mm)');
  assert.equal(labels.receipt_full_logo, 'Full-size receipt logo (up to 36 mm)');
  assert.equal(labels.receipt_extra_feed, 'Extra paper before the cut (3 lines) — for a cutter that clips the last line');
  const desc = (k) => F.POS_FEATURES.find((f) => f.key === k).description;
  assert.match(desc('receipt_compact_layout'), /Type and Bill No\. on one line, Cashier and time on one line, no Kots line, Round Off only when not zero, Total only with a tip or delivery fee, no Payment Detail heading\. Saves more paper; some find it crowded\./);
  assert.match(desc('receipt_classic_spacing'), /instead of the standard 3\.75 mm/);
  for (const k of KEYS) {
    assert.ok(F.POS_FEATURE_KEYS.includes(k), k);
    assert.ok(desc(k).length > 40, `${k} explained`);
    assert.equal(F.noPosFeatures()[k], false, `${k} off by default`);
  }
  assert.deepEqual(F.receiptClassicFrom(null), { spacing: false, fullLogo: false, compactLayout: false, extraFeed: false });
  assert.deepEqual(F.receiptClassicFrom(F.parsePosFeatures([{ key: 'receipt_full_logo', enabled: true }, { key: 'receipt_extra_feed', enabled: 'yes' }])),
    { spacing: false, fullLogo: true, compactLayout: false, extraFeed: false });
});

await ok('A538: receipt_classic_layout is retired — a stale row in production is dropped, read by nothing, not listed', () => {
  assert.ok(!F.POS_FEATURE_KEYS.includes('receipt_classic_layout'));
  assert.deepEqual([...F.RETIRED_POS_FEATURE_KEYS], ['receipt_classic_layout', 'kitchen_font_a']);   // A551: kitchen_font_a too
  const parsed = F.parsePosFeatures([{ key: 'receipt_classic_layout', enabled: true }, { key: 'receipt_full_logo', enabled: true }]);
  assert.ok(!('receipt_classic_layout' in parsed), 'unknown keys are dropped');
  assert.equal(parsed.receipt_full_logo, true, 'the rest still read');
  assert.deepEqual(F.receiptClassicFrom({ receipt_classic_layout: true }), F.receiptClassicFrom({}));
  const biz = { name: 'B', currency: 'KES', vat_rate: 16 };
  assert.deepEqual(B.buildReceiptBusinessConfig(biz, undefined, 0, { posFeatures: { receipt_classic_layout: true } }).receiptClassic,
    { spacing: false, fullLogo: false, compactLayout: false, extraFeed: false });
  // The cloud asks feature_flags for POS_FEATURE_KEYS only (pos/init, posFeatureFlags) — a stale row never travels.
  assert.match(read('apps/server/src/routes/pos.ts'), /\.in\('key', \[\.\.\.POS_FEATURE_KEYS, ATTENDANCE_FLAG\]\)[\s\S]{0,300}parsePosFeatures\(rows\.filter\(\(r\) => r\.key !== ATTENDANCE_FLAG\)\)/);   // A599: + the attendance flag, kept out of the switches
  assert.match(read('apps/server/src/lib/posFeatureFlags.ts'), /\.in\('key', \[\.\.\.POS_FEATURE_KEYS\]\)/);
  const ap = read('apps/admin/src/AdminPortal.tsx');
  assert.equal((ap.match(/!\(RETIRED_POS_FEATURE_KEYS as readonly string\[\]\)\.includes\(f\.key\)/g) ?? []).length, 2, 'Other flags skips it');
  for (const p of ['apps/dashboard/src', 'apps/desktop/src/main', 'apps/desktop/src/renderer', 'apps/server/src', 'apps/admin/src']) {
    const walk = (d) => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(d, e.name)) : /\.(ts|tsx|js)$/.test(e.name) ? [path.join(d, e.name)] : []);
    for (const f of walk(p)) {
      assert.ok(!/\??\.receipt_classic_layout\b|\breceipt_classic_layout\s*===/.test(read(f)), `${f} reads the retired switch`);
    }
  }
});

await ok('the web mapper gives the same answer as posFeatures.receiptClassicFrom', () => {
  const biz = { name: 'B', currency: 'KES', vat_rate: 16 };
  for (const pf of [undefined, null, {}, { receipt_classic_spacing: true }, { receipt_full_logo: true, receipt_compact_layout: true },
    { receipt_compact_layout: true }, { receipt_classic_layout: true },
    Object.fromEntries(KEYS.map((k) => [k, true])), Object.fromEntries(KEYS.map((k) => [k, 'true']))]) {
    assert.deepEqual(B.buildReceiptBusinessConfig(biz, undefined, 0, { posFeatures: pf }).receiptClassic, F.receiptClassicFrom(pf), JSON.stringify(pf));
  }
});

await ok('A538: the web bundle prints the classic layout at ESC 3 30 by default, compact only with the opt-in, 1.0.19 with three', () => {
  const biz = (pf) => B.buildReceiptBusinessConfig({ name: 'B Foods', currency: 'KES', vat_rate: 16 }, undefined, 0, { posFeatures: pf });
  const order = { billNumber: 'W-1', orderType: 'takeaway', cashierName: 'Amina', soldAt: '2026-10-19T09:00:00Z', kotCount: 0,
    lines: [{ name: 'Burger', quantity: 1, unitPrice: 50000, lineTotal: 50000, units: [], stationIds: [] }],
    payments: [{ label: 'CASH', amount: 50000 }], changeGiven: 0, total: 50000 };
  const std = Buffer.from(E.renderReceiptEscPos(order, biz(null), 80));
  const compact = Buffer.from(E.renderReceiptEscPos(order, biz({ receipt_compact_layout: true }), 80));
  const stale = Buffer.from(E.renderReceiptEscPos(order, biz({ receipt_classic_layout: true }), 80));
  const old = Buffer.from(E.renderReceiptEscPos(order, biz(Object.fromEntries(OLD_1019.map((k) => [k, true]))), 80));
  assert.ok(std.subarray(0, 8).equals(Buffer.from([0x1b, 0x40, 0x1b, 0x74, 0, 0x1b, 0x33, 30])), 'ESC 3 30 (~3.75 mm) on the standard receipt');
  assert.ok(!std.includes(Buffer.from([0x1b, 0x33, 26])), 'not A530\'s 26');
  // A539 headed the payments "Payment Details:"; A551: no such words — with no till number (this business) no heading at
  // all (shared/printing receipt-pay-block.test). A540: no "Round Off: 0.00", and a thin gap (ESC J 10) between the info lines.
  assert.ok(!std.includes(Buffer.from('Payment Detail')), 'A551: no "Payment Details" words');
  for (const s of ['Type: Takeaway\n', 'Bill No.: W-1\n', 'Cashier: Amina\n', 'Date: ', 'Kots: 0\n', 'CASH', 'Total:', 'PAY: KES 500.00']) {
    assert.ok(std.includes(Buffer.from(s)), `the standard has "${s.trim()}"`);
  }
  assert.ok(!std.includes(Buffer.from('Round Off:')), 'A540: no "Round Off: 0.00" on the standard receipt');
  assert.ok(std.includes(Buffer.from([0x1b, 0x4a, 10])), 'A540: a thin gap between the info lines');
  assert.ok(std.subarray(-7).equals(Buffer.from([0x1b, 0x64, 1, 0x1d, 0x56, 0x42, 0])), 'one line before the cut');
  assert.ok(stale.equals(std), 'the retired receipt_classic_layout changes nothing');
  assert.ok(compact.includes(Buffer.from([0x1b, 0x33, 30])), 'the compact opt-in at the same 30');
  assert.ok(!compact.includes(Buffer.from('Payment Detail:')) && !compact.includes(Buffer.from('Kots:')) && !compact.includes(Buffer.from('Round Off:')));
  assert.ok(!old.includes(Buffer.from([0x1b, 0x33])), 'no ESC 3 with the classic spacing');
  assert.ok(!old.includes(Buffer.from('Payment Detail')) && old.includes(Buffer.from('Kots: 0')));
  assert.ok(old.subarray(-7).equals(Buffer.from([0x1b, 0x64, 3, 0x1d, 0x56, 0x42, 0])), 'three lines before the cut');
  assert.ok(compact.length < std.length, 'the compact opt-in is shorter');
});

await ok('every receipt path hands the switches to the renderer (till and web)', () => {
  assert.match(ipcHandlersSource(), /receiptClassic:\s+receiptClassicFrom\(getPosFeatures\(\)\),/);
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
  assert.match(ap, /\{RECEIPT_OPTION_KEYS\.map\(key => \{[\s\S]{0,900}toggle\(on, \(\) => toggleFeature\(key, !on\), rf\?\.label \?\? key\)/);
  assert.match(ap, /if \(\(RECEIPT_OPTION_KEYS as readonly string\[\]\)\.includes\(pf\.key\)\) return null;/);
  // A538: "Receipt options", the standard said in one line.
  assert.match(ap, />Receipt options<\/div>/);
  assert.match(ap, /All off = the standard receipt: the classic layout at 3\.75 mm line spacing with a small logo\./);
  assert.ok(!/Receipt \(classic switches\)/.test(ap));
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
