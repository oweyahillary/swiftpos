// mpesa-c2b-a621.test.mjs — A621: M-Pesa payment notifications on the DESKTOP POS.
//
// Owner, 2026-11-02: "Some customers do not like giving out their number, they prefer paying to the till or paybill
// directly; what the cashier gets is a notification of the payments done, then they match it to the bill." The cashier
// TAPS the payment; premium (the online licence); offline / not licensed / not switched on: nothing new shows.
//
// Drives the REAL compiled dist/main/mpesaC2b.js with a fake cloud, and the REAL shared rules (packages/core/src/mpesaPayments.ts,
// bundled with esbuild): what a tapped payment does to the M-Pesa leg, the notice's words. And checks the wiring by source:
// the push channel's ring reaches the bell, the IPC channels are bridged and validated, the payment screen gives taken
// payments back and completes the sale the way a paid STK prompt does.
//
//   cd apps/desktop && npm run build:main && node --no-warnings test/mpesa-c2b-a621.test.mjs
//
// MUTATIONS TO CONFIRM BITE: list() without the licence check → "not licensed: nothing, and the cloud is not asked" fails;
// the stamp not sent back → "the cloud's stamp goes back" fails; matchesBill letting a smaller payment through → "only
// payments of the bill are listed" fails; the liveSync branch removed → "the ring reaches the bell" fails.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const dist = path.join(desktop, 'dist', 'main');
const require = createRequire(import.meta.url);
if (!fs.existsSync(path.join(dist, 'mpesaC2b.js'))) { console.log('\nBuild main first:\n  npm run build:main\n'); process.exit(1); }

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ok   ${name}`); } catch (e) { fail++; console.log(`  FAIL ${name}\n         ${String(e?.stack ?? e).split('\n').slice(0, 3).join('\n         ')}`); }
};

const M = require(path.join(dist, 'mpesaC2b.js'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a621-'));
require('esbuild').buildSync({ entryPoints: [path.join(desktop, '../../packages/core/src/mpesaPayments.ts')], bundle: true, format: 'cjs', platform: 'node',
  outfile: path.join(tmp, 'mpesaPayments.cjs'), logLevel: 'silent' });
const S = require(path.join(tmp, 'mpesaPayments.cjs'));
const src = (p) => fs.readFileSync(path.join(desktop, 'src', p), 'utf8');

/** A fake cloud: answers by path; records every call. */
function fakeCloud() {
  const cloud = { calls: [], online: true, licensed: true, recent: null, claim: null, release: { status: 200, body: { ok: true, released: true } } };
  const answer = (a) => ({ status: a.status, json: async () => a.body });
  cloud.deps = {
    online: () => cloud.online,
    licensed: () => cloud.licensed,
    get: async (p) => { cloud.calls.push(['GET', p]); if (cloud.recent instanceof Error) throw cloud.recent; return answer(cloud.recent); },
    post: async (p, b) => { cloud.calls.push(['POST', p, b]); return answer(p.endsWith('/claim') ? cloud.claim : cloud.release); },
    log: () => {},
  };
  return cloud;
}
const PAY = (o = {}) => ({ trans_id: 'QJK7XT3L5P', amount: 1080, first_name: 'JOHN', bill_ref: null, paid_at: '2026-11-02T11:30:05.000Z', ...o });

console.log('\nA621 — M-Pesa payment notifications on the desktop POS\n');

// Owner, 2026-11-03: "show payments that match the bill only".
await ok('only payments of the bill are listed: exact, or the whole shillings rounded up — never more, never less', () => {
  assert.equal(S.matchesBill(1080, 1080), true);
  assert.equal(S.matchesBill(1080, 1080.004), true);
  assert.equal(S.matchesBill(1081, 1080.5), true, 'a bill with cents: its shillings rounded up, as the prompt asks');
  assert.equal(S.matchesBill(500, 1080), false);
  assert.equal(S.matchesBill(1100, 1080), false);
  assert.equal(S.matchesBill(1081, 1080), false);
  const list = [PAY({ trans_id: 'A', amount: 1080 }), PAY({ trans_id: 'B', amount: 500 }), PAY({ trans_id: 'C', amount: 2000 })];
  assert.deepEqual(S.paymentsForBill(list, 1080).map((p) => p.trans_id), ['A']);
});
await ok('the notice: "KES 1,080 received — JOHN — QJK7XT3L5P"; no name: amount and code', () => {
  assert.equal(S.receivedNotice(PAY()), 'KES 1,080 received — JOHN — QJK7XT3L5P');
  assert.equal(S.receivedNotice(PAY({ first_name: null, amount: 250.5 })), 'KES 250.5 received — QJK7XT3L5P');
});
await ok('the time paid on the POS\'s clock; a sale reference letters, digits and dashes; refusals in the cashier\'s words', () => {
  assert.match(S.paidAtLabel('2026-11-02T11:30:05.000Z'), /^\d{2}:\d{2}$/);
  assert.equal(S.paidAtLabel('nonsense'), '');
  assert.match(S.newSaleRef(), /^PAY-[A-Z0-9]+-[A-Z0-9]+$/);
  assert.match(S.claimRefusalText('TAKEN'), /Another POS/);
  assert.match(S.claimRefusalText('USED'), /another sale/);
  assert.equal(S.claimRefusalText('X', 'Cloud says no'), 'Cloud says no');
});

await ok('not licensed: nothing, and the cloud is not asked', async () => {
  const c = fakeCloud(); c.licensed = false;
  const r = await M.createC2bClient(c.deps).list({ amount: 1080 });
  assert.deepEqual(r, { offered: false, payments: [] }); assert.equal(c.calls.length, 0);
});
await ok('offline: nothing; a tap says type the code', async () => {
  const c = fakeCloud(); c.online = false;
  const client = M.createC2bClient(c.deps);
  assert.deepEqual(await client.list({ amount: 1080 }), { offered: false, payments: [] });
  const t = await client.claim({ trans_id: 'QJK7XT3L5P', sale_ref: 'PAY-1' });
  assert.equal(t.ok, false); assert.match(t.error, /offline/); assert.equal(c.calls.length, 0);
});
await ok('the list: asked for this bill\'s amount; junk rows dropped; not switched on → not offered', async () => {
  const c = fakeCloud();
  c.recent = { status: 200, body: { offered: true, stamp: 1762000000000, payments: [PAY(), { trans_id: 'x', amount: 5 }, PAY({ trans_id: 'ABC1234567', amount: -1 })] } };
  const client = M.createC2bClient(c.deps);
  const r = await client.list({ amount: 1080, ref: 'T12' });
  assert.equal(r.offered, true); assert.deepEqual(r.payments, [PAY()]);
  assert.equal(c.calls[0][1], '/api/payments/c2b/recent?amount=1080&ref=T12');
  c.recent = { status: 200, body: { offered: false, payments: [PAY()] } };
  assert.deepEqual(await M.createC2bClient(c.deps).list({}), { offered: false, payments: [] });
});
await ok('the cloud\'s stamp goes back; "unchanged" shows the last list; a dropped ask keeps it', async () => {
  const c = fakeCloud();
  c.recent = { status: 200, body: { offered: true, stamp: 1762000000000, payments: [PAY()] } };
  const client = M.createC2bClient(c.deps);
  await client.list({ amount: 1080 });
  c.recent = { status: 200, body: { offered: true, unchanged: true, stamp: 1762000000000 } };
  const again = await client.list({ amount: 1080 });
  assert.match(c.calls[1][1], /since=1762000000000/);
  assert.deepEqual(again.payments, [PAY()]);
  c.recent = new Error('socket hang up');
  assert.deepEqual((await client.list({ amount: 1080 })).payments, [PAY()]);
  c.recent = { status: 200, body: { offered: true, stamp: 1762000000999, payments: [] } };
  await client.list({ amount: 500 });
  assert.doesNotMatch(c.calls.at(-1)[1], /since=/, 'another amount: the cloud sorts afresh');
});
await ok('a tap: the payment is this sale\'s; the next list is read afresh (no stamp)', async () => {
  const c = fakeCloud();
  c.recent = { status: 200, body: { offered: true, stamp: 1762000000000, payments: [PAY()] } };
  c.claim = { status: 200, body: { ok: true, payment: PAY() } };
  const client = M.createC2bClient(c.deps);
  await client.list({ amount: 1080 });
  const t = await client.claim({ trans_id: 'QJK7XT3L5P', sale_ref: 'PAY-1' });
  assert.deepEqual(t, { ok: true, payment: PAY() });
  assert.deepEqual(c.calls[1], ['POST', '/api/payments/c2b/claim', { trans_id: 'QJK7XT3L5P', sale_ref: 'PAY-1' }]);
  await client.list({ amount: 1080 });
  assert.doesNotMatch(c.calls[2][1], /since=/);
});
await ok('another POS took it first: refused with the cloud\'s code and words', async () => {
  const c = fakeCloud();
  c.claim = { status: 409, body: { error: 'Another POS has just taken that payment for its bill.', code: 'TAKEN' } };
  const t = await M.createC2bClient(c.deps).claim({ trans_id: 'QJK7XT3L5P', sale_ref: 'PAY-1' });
  assert.equal(t.ok, false); assert.equal(t.code, 'TAKEN'); assert.match(t.error, /Another POS/);
});
await ok('given back: the cloud asked; offline it stays held (the owner sees it)', async () => {
  const c = fakeCloud();
  const client = M.createC2bClient(c.deps);
  assert.deepEqual(await client.release({ trans_id: 'QJK7XT3L5P', sale_ref: 'PAY-1' }), { released: true });
  assert.deepEqual(c.calls[0], ['POST', '/api/payments/c2b/release', { trans_id: 'QJK7XT3L5P', sale_ref: 'PAY-1' }]);
  c.online = false;
  assert.deepEqual(await client.release({ trans_id: 'QJK7XT3L5P', sale_ref: 'PAY-1' }), { released: false });
});
await ok('the cloud\'s ring → the notice\'s payment; anything else → nothing', () => {
  assert.deepEqual(M.arrivedFromRing({ type: 'mpesa_payment', trans_id: 'QJK7XT3L5P', amount: 1080, first_name: 'JOHN' }),
    { trans_id: 'QJK7XT3L5P', amount: 1080, first_name: 'JOHN' });
  assert.equal(M.arrivedFromRing({ type: 'mpesa_payment', trans_id: '<script>', amount: 1 }), null);
  assert.equal(M.arrivedFromRing(null), null);
});

await ok('wiring: the push channel\'s ring reaches the bell; the bell tells the windows only with the licence', () => {
  assert.match(src('main/liveSync.ts'), /m\?\.type === 'mpesa_payment'[\s\S]{0,200}mpesaPaymentBell\?\.\(m\)/);
  const ipc = src('main/ipc/mpesaC2b.ts');
  assert.match(ipc, /if \(!payment \|\| !licensed\(\)\) return;/);
  assert.match(src('main/ipcHandlers.ts'), /registerMpesaC2bHandlers\(ctx\)/);
});
await ok('wiring: the three channels bridged and validated, the ring bridged', () => {
  const preload = src('main/preload.ts'), schemas = src('main/ipcSchemas.ts');
  for (const ch of ['mpesa:receivedList', 'mpesa:receivedClaim', 'mpesa:receivedRelease']) {
    assert.ok(preload.includes(`'${ch}'`), ch); assert.ok(schemas.includes(`'${ch}'`), ch);
  }
  assert.ok(preload.includes("'mpesa:receivedArrived'"));
});
await ok('the payment screen: the list under an M-Pesa leg, loaded on demand (the payment screen is in the main chunk)', () => {
  const pm = src('renderer/components/PaymentModal.tsx');
  assert.match(pm, /const MpesaReceived = lazy\(\(\) => import\('\.\/MpesaReceivedPanel'\)\)/);
  assert.match(pm, /leg\.method === 'mpesa' && <Suspense fallback=\{null\}><MpesaReceived toPay=\{leg\.resolvedAmount\} [^\n]*reference=\{legs\[i\]\.reference\} placing=\{placing\}/);
});
await ok('a tapped payment completes the sale itself, as a paid prompt does; the list holds only the bill\'s payments', () => {
  const pm = src('renderer/components/PaymentModal.tsx'), panel = src('renderer/components/MpesaReceivedPanel.tsx');
  assert.match(pm, /onCode=\{\(code\) => \{ stkCompletes\.current = code !== ''; setLeg\(i, \{ reference: code \}\); \}\}/);
  assert.match(pm, /if \(!stkCompletes\.current\) return;[\s\S]{0,120}if \(canConfirm && !platform\) handleConfirm\(\);/);
  assert.match(panel, /setPayments\(paymentsForBill\(r\.payments \?\? \[\], toPay\)\);/);
  assert.match(panel, /setTaken\(r\.payment\);\n\s*onCode\(r\.payment\.trans_id\);/);
});
await ok('the panel gives its payment back: typed over, taken off, or closed unsold — never when the sale goes through', () => {
  const panel = src('renderer/components/MpesaReceivedPanel.tsx');
  assert.match(panel, /if \(taken && reference !== taken\.trans_id\) \{ giveBack\(taken\); setTaken\(null\); \}/);
  assert.match(panel, /const \{ taken: held, placing: selling \} = latest\.current;\n\s*if \(held && !selling\) giveBack\(held\);/);
  assert.match(panel, /const takeOff = \(\) => \{\n\s*if \(taken\) giveBack\(taken\);/);
  // The POS closes the payment screen on a sale while placing is still true (POSPage handleCharge: setShowPayment(false)
  // before the finally's setPlacing(false)).
  assert.match(src('renderer/pages/POSPage.tsx'), /setShowPayment\(false\);[\s\S]{0,1200}finally \{\n\s*setPlacing\(false\);/);
});
await ok('the notice is on the POS page, loaded on demand', () => {
  const page = src('renderer/pages/POSPage.tsx');
  assert.match(page, /lazy\(\(\) => import\('\.\.\/components\/MpesaArrivedNotice'\)\)/);
  assert.match(page, /<MpesaArrivedNotice currency=\{currency\} \/>/);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
