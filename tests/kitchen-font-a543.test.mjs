/**
 * A543 — kitchen tickets in the printer's smaller Font B; a per-client switch ('kitchen_font_a') brings Font A back.
 *
 * Owner, 2026-10-21: "change the font of the kitchen printer, packing is okay" — chose "Smaller / condensed font — the
 * printer's smaller Font B so long orders fit on less paper". And: "if the manager/owner adds address and social media on
 * the footer it should be the same font like the others" — receipts stay Font A, every line.
 *
 * The ticket itself (ESC M 1 / ESC M 0, 64 / 42 columns, ESC 3 24, the old bytes with the switch) is pinned in
 * shared/printing (test/kitchen-font.test.ts). This pins the wiring: the switch in shared/posFeatures.ts, the admin portal
 * switching it, the owner and the client unable to, and every kitchen print path (the till's queue and test print, the
 * web POS's Send to kitchen, pay-first and the kitchen VOID) handing it to the renderer — running the real web mapper and
 * the committed web bundle.
 *
 * MUTATION-CHECKED, each red on its own: the web mapper reading `!== false` (mapping); kitchenFontA dropped from the
 * till's business config or the test print (paths); posFeatures dropped from one of CashierScreen's kitchen calls
 * (paths); KITCHEN_OPTION_KEYS not listed in the admin portal (admin); 'kitchen_font_a' added to OWNER_POS_KEYS (admin).
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ipcHandlersSource } from '../scripts/lib/ipc-handler-files.mjs';   // D10: ipcHandlers.ts + ipc/*.ts

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.A543_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, A543_TS: '1' } });
  process.exit(r.status ?? 1);
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const F = await import(pathToFileURL(path.join(ROOT, 'shared/posFeatures.ts')).href);
const B = await import(pathToFileURL(path.join(ROOT, 'apps/dashboard/src/lib/buildReceiptOrder.ts')).href);
const E = await import(pathToFileURL(path.join(ROOT, 'apps/dashboard/src/lib/escposRenderer.js')).href);
const FONT_B = Buffer.from([0x1b, 0x4d, 1]), FONT_A = Buffer.from([0x1b, 0x4d, 0]), ESC_M = Buffer.from([0x1b, 0x4d]);

await ok('the switch, named and explained, off unless set', () => {
  const pf = F.POS_FEATURES.find((x) => x.key === 'kitchen_font_a');
  assert.equal(pf.label, 'Kitchen tickets in the normal font');
  assert.equal(pf.description, 'Kitchen tickets print in the printer’s normal font (Font A, 48 characters a line on 80 mm) instead of the smaller Font B (64 a line), which fits long orders on less paper.');
  assert.deepEqual([...F.KITCHEN_OPTION_KEYS], ['kitchen_font_a']);
  assert.ok(!F.RECEIPT_OPTION_KEYS.includes('kitchen_font_a'));
  assert.equal(F.parsePosFeatures(null).kitchen_font_a, false);
  assert.equal(F.parsePosFeatures([{ key: 'kitchen_font_a', enabled: true }]).kitchen_font_a, true);
  assert.equal(F.kitchenFontAFrom(null), false);
  assert.equal(F.kitchenFontAFrom({ kitchen_font_a: 'yes' }), false, 'only a real true');
  assert.equal(F.kitchenFontAFrom(F.parsePosFeatures([{ key: 'kitchen_font_a', enabled: true }])), true);
});

await ok('mapping: the web mapper gives the same answer as posFeatures.kitchenFontAFrom', () => {
  const biz = { name: 'B Foods', currency: 'KES', vat_rate: 16 };
  for (const pf of [undefined, null, {}, { kitchen_font_a: true }, { kitchen_font_a: false }, { kitchen_font_a: 'true' }, { receipt_full_logo: true }]) {
    assert.equal(B.buildReceiptBusinessConfig(biz, undefined, 0, { posFeatures: pf }).kitchenFontA, F.kitchenFontAFrom(pf), JSON.stringify(pf));
  }
});

await ok('the web bundle: kitchen, bar and master KOT tickets in Font B; the switch, dispatch and the receipt in Font A', () => {
  const biz = (pf) => B.buildReceiptBusinessConfig({ name: 'B Foods', currency: 'KES', vat_rate: 16 }, undefined, 0, { posFeatures: pf });
  const order = { billNumber: 'W-1', orderType: 'takeaway', cashierName: 'Amina', soldAt: '2026-10-21T09:00:00Z', kotCount: 0,
    lines: [{ name: 'Burger', quantity: 1, unitPrice: 50000, lineTotal: 50000, units: [], stationIds: ['k1'] }],
    payments: [{ label: 'CASH', amount: 50000 }], changeGiven: 0, total: 50000 };
  for (const type of ['kitchen', 'bar', 'kot']) {
    const b = Buffer.from(E.renderStationEscPos(order, biz(null), { id: 'k1', type, paperWidthMm: 80 }));
    assert.ok(b.subarray(0, 11).equals(Buffer.from([0x1b, 0x40, 0x1b, 0x74, 0, 0x1b, 0x33, 24, 0x1b, 0x4d, 1])), `${type}: ESC 3 24, ESC M 1 at the start`);
    assert.ok(b.lastIndexOf(FONT_A) > b.lastIndexOf(Buffer.from('items to cook')), `${type}: ESC M 0 after the last line`);
    assert.ok(b.includes(Buffer.from(`Order  W-1${' '.repeat(64 - 'Order  W-1'.length - 'TAKEAWAY'.length)}TAKEAWAY`)), `${type}: 64 columns`);
    const a = Buffer.from(E.renderStationEscPos(order, biz({ kitchen_font_a: true }), { id: 'k1', type, paperWidthMm: 80 }));
    assert.ok(!a.includes(ESC_M) && !a.includes(Buffer.from([0x1b, 0x33])), `${type}: kitchen_font_a — no ESC M, no ESC 3`);
    assert.ok(a.includes(Buffer.from(`Order  W-1${' '.repeat(48 - 'Order  W-1'.length - 'TAKEAWAY'.length)}TAKEAWAY`)), `${type}: kitchen_font_a — 48 columns`);
  }
  const k58 = Buffer.from(E.renderStationEscPos(order, biz(null), { id: 'k1', type: 'kitchen', paperWidthMm: 58 }));
  assert.ok(k58.includes(Buffer.from(`Order  W-1${' '.repeat(42 - 'Order  W-1'.length - 'TAKEAWAY'.length)}TAKEAWAY`)), '58 mm: 42 columns');
  for (const pf of [null, { kitchen_font_a: true }]) {
    assert.ok(!Buffer.from(E.renderStationEscPos(order, biz(pf), { id: 'd1', type: 'expeditor', paperWidthMm: 80 })).includes(ESC_M), 'dispatch: Font A');
    assert.ok(!Buffer.from(E.renderStationEscPos(order, biz(pf), { id: 'r1', type: 'receipt', paperWidthMm: 80 })).includes(ESC_M), 'Print Bill: Font A');
  }
  const owner = { ...biz(null), header: 'Moi Avenue, Nairobi\nIG: @tjspizza', thankYouMessage: 'www.tjspizza.co.ke' };
  const r = Buffer.from(E.renderReceiptEscPos(order, owner, 80));
  assert.ok(!r.includes(ESC_M) && !r.includes(FONT_B), 'the receipt with the owner\'s address and social lines: Font A');
  assert.ok(r.equals(Buffer.from(E.renderReceiptEscPos(order, { ...owner, kitchenFontA: true }, 80))), 'the switch never touches a receipt');
});

await ok('paths: every kitchen print path hands the switch to the renderer (till and web)', () => {
  const ipc = ipcHandlersSource();
  assert.match(ipc, /kitchenFontA:\s+kitchenFontAFrom\(getPosFeatures\(\)\),/);
  assert.match(ipc, /import \{[^}]*\bkitchenFontAFrom\b[^}]*\} from '\.\.?\/posFeatures';/);   // D10: ipc/*.ts import '../posFeatures'
  const pw = read('apps/desktop/src/main/print/printWorker.ts');
  assert.match(pw, /kitchenFontA = kitchenFontAFrom\(getPosFeatures\(\)\);/);
  assert.match(pw, /\.\.\.\(kitchenFontA \? \{ kitchenFontA \} : \{\}\)/);
  // The web POS's kitchen tickets: Send to kitchen, the kitchen VOID, pay-first (and Print Bill already had them).
  const cs = read('apps/dashboard/src/pages/pos/CashierScreen.tsx');
  const calls = cs.split('printRoutedStations({').slice(1).map((c) => c.slice(0, c.indexOf('})')));
  const kitchenCalls = calls.filter((c) => /kinds: \['kitchen', 'dispatch'\]/.test(c));
  assert.equal(kitchenCalls.length, 3, 'three kitchen print calls');
  for (const c of kitchenCalls) assert.match(c, /\bposFeatures,/, c.slice(0, 120));
  assert.match(read('apps/dashboard/src/lib/printRouted.ts'), /posFeatures: a\.posFeatures \}\);/);
  assert.match(read('apps/dashboard/src/lib/buildReceiptOrder.ts'), /kitchenFontA:\s+extra\.posFeatures\?\.kitchen_font_a === true,/);
});

await ok('admin: the admin portal switches it per client; the owner and the client cannot', () => {
  const ap = read('apps/admin/src/AdminPortal.tsx');
  assert.match(ap, />Kitchen ticket options<\/div>/);
  assert.match(ap, /\{KITCHEN_OPTION_KEYS\.map\(key => \{[\s\S]{0,900}toggle\(on, \(\) => toggleFeature\(key, !on\), kf\?\.label \?\? key\)/);
  assert.match(ap, /if \(\(KITCHEN_OPTION_KEYS as readonly string\[\]\)\.includes\(pf\.key\)\) return null;/);
  const ctl = read('apps/server/src/routes/controls.ts');
  assert.ok(!/OWNER_POS_KEYS = \[([^\]]*)\]/.exec(ctl)[1].includes('kitchen_font_a'), 'not an owner option');
  assert.ok(!/OWNER_POS_OPTIONS = \[([^\]]*)\]/.exec(read('apps/admin/src/ownerSettings.ts'))[1].includes('kitchen_font_a'));
  // The client's PUT /api/flags refuses every POS_FEATURE_KEYS key — kitchen_font_a is one.
  assert.ok(F.POS_FEATURE_KEYS.includes('kitchen_font_a'));
  assert.match(read('apps/server/src/routes/flags.ts'), /if \(\(POS_FEATURE_KEYS as readonly string\[\]\)\.includes\(req\.params\.key\)\) \{\s*res\.status\(403\)/);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
