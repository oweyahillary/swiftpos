// A545 — credit sales a manager confirms on the till (Manager › Sales › Credit sales).
// Owner, 2026-10-21: "for credit I think the manager has to know which sale is on credit and they have to confirm that it
// was done."
//
// Drives the REAL compiled dist/main (localDb, creditConfirm, syncEngine.pushCreditDecisionsNow) on a REAL SQLite file,
// with a stand-in cloud; and reads the screens (the manager list, the Close Day / Close Branch notice that never blocks).
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/credit-confirm-a545.test.mjs
//
// MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
//   - overlay() ignoring the pending decisions                  → "offline: the decision shows at once" fails
//   - the replay sent with a person's token / without `by`        → "sent with the till's own sign-in, naming who" fails
//   - a 409 treated as "try again later"                         → "a refusal ends the wait" fails
//   - the notice wired into the close button's disabled state     → "never blocks the close" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ipcHandlersSource } from '../../../scripts/lib/ipc-handler-files.mjs';   // D10: ipcHandlers.ts + ipc/*.ts

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const srcDir = path.join(here, '..', 'src');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a545-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.20' }, ipcMain: { handle() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => globalThis.__online } };`);
globalThis.__online = true;
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return req === 'electron' ? shim : orig.call(this, req, parent, ...rest); };

const L = require(path.join(dist, 'localDb.js'));
const C = require(path.join(dist, 'deviceConfig.js'));
const K = require(path.join(dist, 'creditConfirm.js'));
const E = require(path.join(dist, 'syncEngine.js'));
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, refresh_token, user_id, business_id, business_name, logged_in_at) VALUES (1, 'acc', 'ref', 'u-owner', 'biz-1', 'B Foods', '2026-10-21T00:00:00Z')`).run();
C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1', device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Till 1' });
E.configureSyncEngine('http://cloud', 'acc', 'ref');

const cloud = { mode: 'ok', posts: [], refuse: null };
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const json = (status, b) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const m = /\/api\/credit\/sales\/([^/]+)\/replay$/.exec(u);
  if (m && init.method === 'POST') {
    cloud.posts.push({ order: decodeURIComponent(m[1]), body: JSON.parse(init.body), auth: init.headers?.Authorization });
    if (cloud.mode === 'offline') throw new TypeError('fetch failed');
    if (cloud.mode === 'down') return json(503, { error: 'Service unavailable' });
    if (cloud.refuse === m[1]) return json(409, { error: 'That sale was already confirmed — only the owner can change it now.', code: 'ALREADY_DECIDED' });
    return json(200, { order_id: m[1], state: JSON.parse(init.body).decision === 'confirm' ? 'confirmed' : 'disputed' });
  }
  return json(404, { error: 'not found' });
};

const sale = (id, over = {}) => ({ order_id: id, order_number: `T1-${id}`, branch_id: 'br-1', branch_name: 'Westlands', customer_name: 'Acme Ltd',
  amount: 500, state: 'awaiting', source: 'till', over_limit: false, cashier_name: 'Cate', approved_by_name: null, decided_by_name: null,
  decided_at: null, dispute_reason: null, sold_at: '2026-10-21T08:00:00.000Z', ...over });

console.log('\nThe list the manager sees (the cloud\'s, kept for offline)\n');
K.writeCache(db, [sale('o1'), sale('o2'), sale('o3', { state: 'disputed', decided_by_name: 'Max', decided_at: 'x', dispute_reason: 'Not theirs' })]);
ok('the saved list: customer, amount, cashier, time, the approver; three open sales, two awaiting',
  K.readCache(db).rows.length === 3 && K.awaitingCount(K.readCache(db).rows, K.readPending(db)) === 2);
ok('the notice\'s words: "2 credit sales await a manager\'s confirmation"; none → nothing',
  K.awaitingSentence(2) === '2 credit sales await a manager\'s confirmation' && K.awaitingSentence(1) === '1 credit sale awaits a manager\'s confirmation' && K.awaitingSentence(0) === '');
ok('a dispute needs a reason; confirm or dispute only',
  K.decisionProblem({ decision: 'dispute', reason: ' ' }) === 'Say why it is disputed.' && K.decisionProblem({ decision: 'maybe' }) === 'Confirm or dispute.'
  && K.decisionProblem({ decision: 'confirm' }) === null);

console.log('\nOffline: kept on the till, shown at once\n');
{
  K.queueDecision(db, { order_id: 'o1', decision: 'confirm', reason: '', by: 'u-max', by_name: 'Max', at: '2026-10-21T09:00:00.000Z' });
  K.queueDecision(db, { order_id: 'o2', decision: 'dispute', reason: '  Customer says not theirs ', by: 'u-max', by_name: 'Max', at: '2026-10-21T09:01:00.000Z' });
  const view = K.overlay(K.readCache(db).rows, K.readPending(db));
  ok('offline: the decision shows at once (marked not on the cloud yet), and the count drops — the day close sees 0 waiting',
    view.find((r) => r.order_id === 'o1').state === 'confirmed' && view.find((r) => r.order_id === 'o1').pending === true
    && view.find((r) => r.order_id === 'o2').state === 'disputed' && view.find((r) => r.order_id === 'o2').dispute_reason === 'Customer says not theirs'
    && K.awaitingCount(K.readCache(db).rows, K.readPending(db)) === 0, JSON.stringify(view));
  K.queueDecision(db, { order_id: 'o1', decision: 'confirm', reason: '', by: 'u-max', by_name: 'Max', at: '2026-10-21T09:02:00.000Z' });
  ok('one decision per sale (a later one replaces it)', K.readPending(db).length === 2);
  cloud.mode = 'offline';
  const out = await E.pushCreditDecisionsNow();
  ok('no connection: both stay, the push stops at the first failure', K.readPending(db).length === 2 && cloud.posts.length === 1 && E.creditDecisionsPending(), JSON.stringify(out));
  globalThis.__online = false; cloud.posts.length = 0;
  await E.pushCreditDecisionsNow();
  ok('the machine offline: nothing is sent', cloud.posts.length === 0);
  globalThis.__online = true; cloud.mode = 'down';
  await E.pushCreditDecisionsNow();
  ok('the cloud down (503): still waiting', K.readPending(db).length === 2);
}

console.log('\nThe connection is back: synced\n');
{
  cloud.mode = 'ok'; cloud.posts.length = 0;
  const out = await E.pushCreditDecisionsNow();
  const dispute = cloud.posts.find((p) => p.order === 'o2');
  ok('sent with the till\'s own sign-in, naming who decided and when (the replay route)',
    cloud.posts.length === 2 && cloud.posts.every((p) => p.auth === 'Bearer acc' && p.body.by === 'u-max')
    && dispute.body.decision === 'dispute' && dispute.body.reason === 'Customer says not theirs' && dispute.body.at === '2026-10-21T09:01:00.000Z'
    && !('reason' in cloud.posts.find((p) => p.order === 'o1').body), JSON.stringify(cloud.posts));
  ok('both taken: nothing waiting, the saved list follows (no longer pending)', out.o1?.state === 'saved' && out.o2?.state === 'saved'
    && K.readPending(db).length === 0 && !E.creditDecisionsPending()
    && K.readCache(db).rows.find((r) => r.order_id === 'o2').state === 'disputed' && !K.readCache(db).rows.find((r) => r.order_id === 'o1').pending, JSON.stringify(out));
}
{
  cloud.refuse = 'o3';
  K.queueDecision(db, { order_id: 'o3', decision: 'confirm', reason: '', by: 'u-max', by_name: 'Max', at: '2026-10-21T09:05:00.000Z' });
  const out = await E.pushCreditDecisionsNow();
  ok('a refusal ends the wait, with the cloud\'s reason shown (and can be dismissed)',
    out.o3?.state === 'refused' && K.readPending(db).length === 0 && /only the owner/.test(K.readRefused(db)[0]?.message ?? ''), JSON.stringify(out));
  K.dismissRefused(db, 'o3');
  ok('…dismissed', K.readRefused(db).length === 0);
}

console.log('\nThe screens\n');
const read = (p) => fs.readFileSync(path.join(srcDir, p), 'utf8');
const ipc = ipcHandlersSource();
ok('online: the manager decides as themselves (manageFetch to /confirm or /dispute); offline: kept and sent later',
  /manageFetch\(decision === 'dispute' \? `\/api\/credit\/sales\/\$\{encodeURIComponent\(orderId\)\}\/dispute` : `\/api\/credit\/sales\/\$\{encodeURIComponent\(orderId\)\}\/confirm`/.test(ipc)
  && /if \(!creditOffline\(\)\) throw e;\n\s+creditConfirm\.queueDecision\(db, \{ order_id: orderId, decision, reason: why, by: me\.staff_id/.test(ipc)
  && /requireKey\(\['customers\.credit'\], CREDIT_REFUSED\)/.test(ipc));
ok('the list offline: the saved one, with the decisions kept here', /const c = creditConfirm\.readCache\(db\);\n\s+return \{ online: false/.test(ipc));
const sync = read('main/syncEngine.ts');
ok('the sync sends them each pass', /await stage\('credit decisions', async \(\) => \{ await pushCreditDecisionsNow\(\); return 0; \}\);/.test(sync));
const page = read('renderer/pages/ManagerPage.tsx');
ok('Manager › Sales › Credit sales for customers.credit', /canCredit: has\('customers\.credit'\)/.test(page) && /case 'credit': return <CreditSalesTab currency=\{currency\} \/>;/.test(page));
const tab = read('renderer/components/CreditSalesTab.tsx');
ok('the list shows customer, amount, cashier, time, the approver; Confirm and Dispute (a reason asked)',
  /Customer<\/th><th>Amount<\/th><th>Cashier<\/th><th>Time<\/th><th>Approved at sale<\/th>/.test(tab) && /data-testid="credit-confirm"/.test(tab)
  && /data-testid="credit-dispute"/.test(tab) && /if \(decision === 'dispute' && !reason\.trim\(\)\)/.test(tab));
for (const [name, file] of [['Close Day', 'renderer/pages/DayCloseTab.tsx'], ['Close Branch', 'renderer/pages/BranchCloseTab.tsx']]) {
  const t = read(file);
  ok(`${name}: says how many credit sales wait — and never blocks the close`,
    /<CreditAwaitingNotice \/>/.test(t) && !/disabled=\{[^}]*[cC]redit/.test(t) && !/creditAwaiting/.test(t));
}
ok('the notice says the day still closes', /The day still closes\./.test(tab));

console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* Windows: the database file is still open */ }
process.exitCode = fail ? 1 : 0;
