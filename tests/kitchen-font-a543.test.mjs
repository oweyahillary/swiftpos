/**
 * A543 made kitchen tickets the printer's smaller Font B, with a per-client switch ('kitchen_font_a') to bring Font A back.
 * A551 (owner, 2026-10-21, on paper: "kitchen receipt use the same font as the despatcher"): Font A is the standard again
 * and Font B the opt-in ('kitchen_font_b'); 'kitchen_font_a' is retired (a stored row is dropped — Font A is what it asked
 * for). Receipts stay Font A, every line (A543: "if the manager/owner adds address and social media on the footer it should
 * be the same font like the others").
 *
 * The ticket itself (ESC M 1 / ESC M 0, 64 / 42 columns, ESC 3 24 with the switch; Font A without) is pinned in
 * shared/printing (test/kitchen-font.test.ts). This pins the wiring: the switch in packages/core/src/posFeatures.ts, the admin portal
 * switching it, the owner and the client unable to, and every kitchen print path (the till's queue and test print, the
 * web POS's Send to kitchen, pay-first and the kitchen VOID) handing it to the renderer — running the real web mapper and
 * the committed web bundle.
 *
 * MUTATION-CHECKED, each red on its own: the web mapper reading `!== false` (mapping); kitchenFontB dropped from the
 * till's business config or the test print (paths); posFeatures dropped from one of CashierScreen's kitchen calls
 * (paths); KITCHEN_OPTION_KEYS not listed in the admin portal (admin); 'kitchen_font_b' added to OWNER_POS_KEYS (admin).
 * A551: the web bundle not rebuilt (web bundle); 'kitchen_font_a' not retired (switch).
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

const F = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/posFeatures.ts')).href);
const B = await import(pathToFileURL(path.join(ROOT, 'apps/dashboard/src/lib/buildReceiptOrder.ts')).href);
const E = await import(pathToFileURL(path.join(ROOT, 'apps/dashboard/src/lib/escposRenderer.js')).href);
const FONT_B = Buffer.from([0x1b, 0x4d, 1]), FONT_A = Buffer.from([0x1b, 0x4d, 0]), ESC_M = Buffer.from([0x1b, 0x4d]);
const CUT_AFTER_ONE = Buffer.from([0x1b, 0x64, 1, 0x1d, 0x56, 0x42, 0]);

await ok('the switch, named and explained, off unless set (A551: kitchen_font_b; kitchen_font_a retired)', () => {
  const pf = F.POS_FEATURES.find((x) => x.key === 'kitchen_font_b');
  assert.equal(pf.label, 'Kitchen tickets in the small font');
  assert.equal(pf.description, 'Kitchen tickets print in the printer’s smaller Font B (64 characters a line on 80 mm) instead of the normal Font A (48 a line, like the dispatch ticket). Fits long orders on less paper; harder to read at a distance.');
  assert.deepEqual([...F.KITCHEN_OPTION_KEYS], ['kitchen_font_b']);
  assert.ok(!F.RECEIPT_OPTION_KEYS.includes('kitchen_font_b'));
  assert.equal(F.parsePosFeatures(null).kitchen_font_b, false);
  assert.equal(F.parsePosFeatures([{ key: 'kitchen_font_b', enabled: true }]).kitchen_font_b, true);
  assert.equal(F.kitchenFontBFrom(null), false);
  assert.equal(F.kitchenFontBFrom({ kitchen_font_b: 'yes' }), false, 'only a real true');
  assert.equal(F.kitchenFontBFrom(F.parsePosFeatures([{ key: 'kitchen_font_b', enabled: true }])), true);
  // A551: A543's 'kitchen_font_a' is retired — a stored row is dropped, read by nothing, listed nowhere; Font A is the standard.
  assert.ok(!F.POS_FEATURES.some((x) => x.key === 'kitchen_font_a') && F.RETIRED_POS_FEATURE_KEYS.includes('kitchen_font_a'));
  assert.ok(!('kitchen_font_a' in F.parsePosFeatures([{ key: 'kitchen_font_a', enabled: true }])), 'a stale row is dropped');
  assert.equal(F.kitchenFontBFrom(F.parsePosFeatures([{ key: 'kitchen_font_a', enabled: true }])), false, 'a stale kitchen_font_a = Font A');
  assert.equal(F.kitchenFontAFrom, undefined, 'the old reader is gone');
});

await ok('mapping: the web mapper gives the same answer as posFeatures.kitchenFontBFrom', () => {
  const biz = { name: 'B Foods', currency: 'KES', vat_rate: 16 };
  for (const pf of [undefined, null, {}, { kitchen_font_b: true }, { kitchen_font_b: false }, { kitchen_font_b: 'true' },
    { kitchen_font_a: true }, { kitchen_font_a: false }, { receipt_full_logo: true }]) {
    assert.equal(B.buildReceiptBusinessConfig(biz, undefined, 0, { posFeatures: pf }).kitchenFontB, F.kitchenFontBFrom(pf), JSON.stringify(pf));
  }
  assert.ok(!('kitchenFontA' in B.buildReceiptBusinessConfig(biz, undefined, 0, { posFeatures: { kitchen_font_a: true } })));
});

await ok('the web bundle: kitchen, bar and master KOT tickets in Font A (A551), Font B with kitchen_font_b; dispatch and the receipt Font A', () => {
  const biz = (pf) => B.buildReceiptBusinessConfig({ name: 'B Foods', currency: 'KES', vat_rate: 16 }, undefined, 0, { posFeatures: pf });
  const order = { billNumber: 'W-1', orderType: 'takeaway', cashierName: 'Amina', soldAt: '2026-10-21T09:00:00Z', kotCount: 0,
    lines: [{ name: 'Burger', quantity: 1, unitPrice: 50000, lineTotal: 50000, units: [], stationIds: ['k1'] }],
    payments: [{ label: 'CASH', amount: 50000 }], changeGiven: 0, total: 50000 };
  for (const type of ['kitchen', 'bar', 'kot']) {
    const b = Buffer.from(E.renderStationEscPos(order, biz({ kitchen_font_b: true }), { id: 'k1', type, paperWidthMm: 80 }));
    assert.ok(b.subarray(0, 11).equals(Buffer.from([0x1b, 0x40, 0x1b, 0x74, 0, 0x1b, 0x33, 24, 0x1b, 0x4d, 1])), `${type}: kitchen_font_b — ESC 3 24, ESC M 1 at the start`);
    assert.ok(b.lastIndexOf(FONT_A) > b.lastIndexOf(Buffer.from('items to cook')), `${type}: kitchen_font_b — ESC M 0 after the last line`);
    assert.ok(b.includes(Buffer.from(`Order  W-1${' '.repeat(64 - 'Order  W-1'.length - 'TAKEAWAY'.length)}TAKEAWAY`)), `${type}: kitchen_font_b — 64 columns`);
    for (const pf of [null, { kitchen_font_a: true }]) {
      const a = Buffer.from(E.renderStationEscPos(order, biz(pf), { id: 'k1', type, paperWidthMm: 80 }));
      assert.ok(!a.includes(ESC_M) && !a.includes(Buffer.from([0x1b, 0x33])), `${type} ${JSON.stringify(pf)}: no ESC M, no ESC 3`);
      assert.ok(a.includes(Buffer.from(`Order  W-1${' '.repeat(48 - 'Order  W-1'.length - 'TAKEAWAY'.length)}TAKEAWAY`)), `${type}: 48 columns`);
      // A551: one line fed before the cut (the bundle's station says 3 — the document's cutFeed wins on a cutting printer).
      assert.ok(a.subarray(a.length - 7).equals(CUT_AFTER_ONE), `${type}: ESC d 1 then the cut`);
    }
  }
  const k58 = Buffer.from(E.renderStationEscPos(order, biz({ kitchen_font_b: true }), { id: 'k1', type: 'kitchen', paperWidthMm: 58 }));
  assert.ok(k58.includes(Buffer.from(`Order  W-1${' '.repeat(42 - 'Order  W-1'.length - 'TAKEAWAY'.length)}TAKEAWAY`)), '58 mm Font B: 42 columns');
  for (const pf of [null, { kitchen_font_b: true }]) {
    const d = Buffer.from(E.renderStationEscPos(order, biz(pf), { id: 'd1', type: 'expeditor', paperWidthMm: 80 }));
    assert.ok(!d.includes(ESC_M), 'dispatch: Font A');
    assert.ok(d.subarray(d.length - 7).equals(CUT_AFTER_ONE), 'dispatch: ESC d 1 then the cut');
    assert.ok(!Buffer.from(E.renderStationEscPos(order, biz(pf), { id: 'r1', type: 'receipt', paperWidthMm: 80 })).includes(ESC_M), 'Print Bill: Font A');
  }
  const owner = { ...biz(null), header: 'Moi Avenue, Nairobi\nIG: @tjspizza', thankYouMessage: 'www.tjspizza.co.ke' };
  const r = Buffer.from(E.renderReceiptEscPos(order, owner, 80));
  assert.ok(!r.includes(ESC_M) && !r.includes(FONT_B), 'the receipt with the owner\'s address and social lines: Font A');
  assert.ok(r.equals(Buffer.from(E.renderReceiptEscPos(order, { ...owner, kitchenFontB: true }, 80))), 'the switch never touches a receipt');
});

await ok('paths: every kitchen print path hands the switch to the renderer (till and web)', () => {
  const ipc = ipcHandlersSource();
  assert.match(ipc, /kitchenFontB:\s+kitchenFontBFrom\(getPosFeatures\(\)\),/);
  assert.match(ipc, /import \{[^}]*\bkitchenFontBFrom\b[^}]*\} from '@zaptill\/core\/posFeatures';/);   // D10: ipc/*.ts import '@zaptill/core/posFeatures' (shared-components batch D)
  assert.ok(!/kitchenFontA/.test(ipc), 'the till no longer reads kitchen_font_a');
  const pw = read('apps/desktop/src/main/print/printWorker.ts');
  assert.match(pw, /kitchenFontB = kitchenFontBFrom\(getPosFeatures\(\)\);/);
  assert.match(pw, /\.\.\.\(kitchenFontB \? \{ kitchenFontB \} : \{\}\)/);
  // The web POS's kitchen tickets: Send to kitchen, the kitchen VOID, pay-first (and Print Bill already had them).
  const cs = read('apps/dashboard/src/pages/pos/CashierScreen.tsx');
  const calls = cs.split('printRoutedStations({').slice(1).map((c) => c.slice(0, c.indexOf('})')));
  const kitchenCalls = calls.filter((c) => /kinds: \['kitchen', 'dispatch'\]/.test(c));
  assert.equal(kitchenCalls.length, 3, 'three kitchen print calls');
  for (const c of kitchenCalls) assert.match(c, /\bposFeatures,/, c.slice(0, 120));
  assert.match(read('apps/dashboard/src/lib/printRouted.ts'), /posFeatures: a\.posFeatures \}\);/);
  assert.match(read('apps/dashboard/src/lib/buildReceiptOrder.ts'), /kitchenFontB:\s+extra\.posFeatures\?\.kitchen_font_b === true,/);
});

await ok('admin: the admin portal switches it per client; the owner and the client cannot', () => {
  const ap = read('apps/admin/src/AdminPortal.tsx');
  assert.match(ap, />Kitchen ticket options<\/div>/);
  assert.match(ap, /\{KITCHEN_OPTION_KEYS\.map\(key => \{[\s\S]{0,900}toggle\(on, \(\) => toggleFeature\(key, !on\), kf\?\.label \?\? key\)/);
  assert.match(ap, /if \(\(KITCHEN_OPTION_KEYS as readonly string\[\]\)\.includes\(pf\.key\)\) return null;/);
  const ctl = read('apps/server/src/routes/controls.ts');
  assert.ok(!/OWNER_POS_KEYS = \[([^\]]*)\]/.exec(ctl)[1].includes('kitchen_font_b'), 'not an owner option');
  assert.ok(!/OWNER_POS_OPTIONS = \[([^\]]*)\]/.exec(read('apps/admin/src/ownerSettings.ts'))[1].includes('kitchen_font_b'));
  // The client's PUT /api/flags refuses every POS_FEATURE_KEYS key — kitchen_font_b is one.
  assert.ok(F.POS_FEATURE_KEYS.includes('kitchen_font_b'));
  assert.match(read('apps/server/src/routes/flags.ts'), /if \(\(POS_FEATURE_KEYS as readonly string\[\]\)\.includes\(req\.params\.key\)\) \{\s*res\.status\(403\)/);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
