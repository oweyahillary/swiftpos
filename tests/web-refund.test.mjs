/**
 * web-refund.test.mjs — A359 (2026-09-28): refund from the web POS's and the manager dashboard's order list.
 *
 * Owner, on v0.6.18 (V5): "no refund option in orders or order history". Both web places a manager uses — POS Menu →
 * Orders and the manager dashboard's Orders — render POSOrderHistoryTab, which could only reprint. (The owner's own
 * Orders page already had Refund.)
 *
 *   node tests/web-refund.test.mjs
 *
 * RUNS the real apps/dashboard/src/pages/orderRefund.ts (type-stripped), then pins the list component.
 *
 * MUTATIONS TO CONFIRM BITE: canRefundOrder ignoring `mayVoid` → "only orders.void" fails; ignoring isRefunded →
 * "never twice" fails; the POST without override_pin → the wiring pin fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.WEB_REFUND_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, WEB_REFUND_TS: '1' } });
  process.exit(r.status ?? 1);
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = await import(pathToFileURL(path.join(ROOT, 'apps/dashboard/src/pages/orderRefund.ts')).href);
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const paid = { status: 'completed', payments: [{ status: 'completed' }] };
ok('a completed sale can be refunded by someone with orders.void — only by them', () => {
  assert.equal(R.canRefundOrder(paid, true), true);
  assert.equal(R.canRefundOrder(paid, false), false);
});
ok('never twice, never a voided or open order', () => {
  assert.equal(R.canRefundOrder({ status: 'completed', payments: [{ status: 'completed' }, { status: 'refunded' }] }, true), false);
  assert.equal(R.canRefundOrder({ status: 'voided', payments: [] }, true), false);
  assert.equal(R.canRefundOrder({ status: 'open', payments: [] }, true), false);
});
ok('the reasons are the till\'s (VoidModal), so both surfaces record the same words', () => {
  const vm = read('apps/desktop/src/renderer/components/VoidModal.tsx');
  for (const r of R.REFUND_REASONS.filter((x) => x !== 'Other')) assert.ok(vm.includes(`'${r}'`), r);
});

const tab = read('apps/dashboard/src/pages/pos/POSOrderHistoryTab.tsx');
ok('the list offers Refund only when canRefundOrder says so, gated on orders.void', () => {
  assert.match(tab, /const mayVoid = hasPermission\('orders\.void'\);/);
  assert.match(tab, /\{canRefundOrder\(order, mayVoid\) && refunding !== order\.id && \(/);
  assert.match(tab, /\{isRefunded\(order\.payments\) && <span style=\{s\.refundedBadge\}>refunded<\/span>\}/);
});
ok('it posts to the cloud refund with a reason and the manager\'s PIN, and shows the cloud\'s own words', () => {
  assert.match(tab, /await posApi\.post\(`\/api\/orders\/\$\{order\.id\}\/refund`, \{ reason, override_pin: refundPin\.trim\(\) \}\);/);
  assert.match(tab, /setRefundMsg\(\{ id: order\.id, text: e\?\.message \?\? 'Refund failed', ok: false \}\);/);
  assert.match(tab, /placeholder="Manager or owner PIN"/);
});
ok('both web places a manager uses render this list (web POS drawer, manager dashboard)', () => {
  assert.match(read('apps/dashboard/src/pages/pos/POSDrawer.tsx'), /'orders\.view_all': \(\{ currency \}\) => <POSOrderHistoryTab currency=\{currency\} \/>/);
  assert.match(read('apps/dashboard/src/pages/manager/ManagerDashboard.tsx'), /case 'orders':\s+return <POSOrderHistoryTab currency=\{currency\} \/>;/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
