// A414 — wastage recorded on the till: saved on the till first, sent to the cloud after.
// Owner, 2026-10-06: "Recording wastage on the till itself" — decided "save on till, sync later".
//
// Drives the REAL compiled dist/main (localDb, tillWastage, syncEngine.pushWastageNow) on a REAL SQLite file, with a
// stand-in cloud.
//
//   cd apps/desktop && npx tsc -p tsconfig.main.json && node test/till-wastage.test.mjs
//
// MUTATIONS TO CONFIRM BITE:
//   - the client_id not sent                                   → "sent with its own id" fails
//   - a 409 treated as "try again later"                       → "a refusal ends the wait, with the reason" fails
//   - a 503 treated as a refusal                               → "the cloud down: still waiting" fails
//   - the push not stopping at the first lost connection       → "no connection: everything stays, in order" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const src = path.join(here, '..', 'src', 'main');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a414-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.3' }, ipcMain: { handle() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => globalThis.__online } };`);
globalThis.__online = true;
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return req === 'electron' ? shim : orig.call(this, req, parent, ...rest); };

const L = require(path.join(dist, 'localDb.js'));
const C = require(path.join(dist, 'deviceConfig.js'));
const W = require(path.join(dist, 'tillWastage.js'));
const E = require(path.join(dist, 'syncEngine.js'));
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, refresh_token, user_id, business_id, business_name, logged_in_at) VALUES (1, 'acc', 'ref', 'u-owner', 'biz-1', 'B Foods', '2026-10-06T00:00:00Z')`).run();
C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1', device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Till 1' });
E.configureSyncEngine('http://cloud', 'acc', 'ref');

const cloud = { mode: 'ok', posts: [], seen: new Map(), refuse: null };
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const json = (status, b, h = {}) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json', ...h } });
  if (/\/api\/wastage$/.test(u) && init.method === 'POST') {
    const body = JSON.parse(init.body);
    cloud.posts.push({ url: u, body, auth: init.headers?.Authorization, secret: init.headers?.['X-Node-Secret'] });
    const mark = u.includes('/node/cloud/') ? { 'x-node-gateway': '1' } : {};
    if (cloud.mode === 'offline') throw new TypeError('fetch failed');
    if (cloud.mode === 'down') return json(503, { error: 'Service unavailable' }, mark);
    if (cloud.refuse && body.items.some((i) => i.name === cloud.refuse)) return json(409, { error: `${cloud.refuse}: only 1 at this branch.`, code: 'MORE_THAN_HELD' }, mark);
    if (cloud.seen.has(body.client_id)) return json(200, { ref: cloud.seen.get(body.client_id), entries: 1, value: 0, duplicate: true }, mark);
    const ref = `WST-${String(cloud.seen.size + 1).padStart(4, '0')}`;
    cloud.seen.set(body.client_id, ref);
    return json(201, { ref, entries: body.items.length, value: 120 }, mark);
  }
  return json(404, { error: 'not found' });
};
const rec = (id, items, over = {}) => ({ client_id: id, branch_id: 'br-1', reason: 'expired', note: '', items,
  recorded_by_name: 'Mary', recorded_at: '2026-10-06T09:00:00.000Z', ...over });
const milk = { kind: 'product', id: 'p-milk', name: 'Milk 500ml', quantity: 2 };

console.log('\nThe rules (pure)\n');
ok('who may: inventory.waste or inventory.adjust, or the owner; a cashier may not',
  W.mayWaste('manager', '{"inventory.waste":true}') && W.mayWaste('x', '{"inventory.adjust":true}') && W.mayWaste('owner', '{}')
  && !W.mayWaste('cashier', '{"orders.create":true}') && !W.mayWaste('cashier', 'nonsense'));
ok('what must be there: a known reason, a note for "Other", 1 to 100 items, each with an amount',
  W.recordingProblem(rec('a', [milk])) === null && /Choose why/.test(W.recordingProblem(rec('a', [milk], { reason: 'stolen' })))
  && /Say what happened/.test(W.recordingProblem(rec('a', [milk], { reason: 'other' })))
  && /Add the items/.test(W.recordingProblem(rec('a', [])))
  && /enter how much/.test(W.recordingProblem(rec('a', [{ ...milk, quantity: 0 }]))));

console.log('\nNo connection\n');
{
  cloud.mode = 'offline';
  W.queueRecording(db, rec('11111111-1111-4111-8111-111111111111', [milk]));
  W.queueRecording(db, rec('22222222-2222-4222-8222-222222222222', [{ ...milk, name: 'Bread', id: 'p-bread' }]));
  const out = await E.pushWastageNow();
  ok('no connection: everything stays, in order, and the push stops at the first failure',
    W.readPending(db).length === 2 && cloud.posts.length === 1 && out['11111111-1111-4111-8111-111111111111']?.state === 'pending'
    && out['22222222-2222-4222-8222-222222222222']?.state === 'pending', JSON.stringify(out));
  globalThis.__online = false; cloud.posts.length = 0;
  const off = await E.pushWastageNow();
  ok('the machine offline: nothing is sent', cloud.posts.length === 0 && Object.values(off).every((o) => o.state === 'pending'));
  globalThis.__online = true;
  cloud.mode = 'down';
  await E.pushWastageNow();
  ok('the cloud down (503): still waiting', W.readPending(db).length === 2);
}

console.log('\nThe connection is back\n');
{
  cloud.mode = 'ok'; cloud.posts.length = 0;
  const out = await E.pushWastageNow();
  const first = cloud.posts[0]?.body;
  ok('sent with its own id, the person and the time on the till, with the till\'s sign-in',
    first?.client_id === '11111111-1111-4111-8111-111111111111' && first?.recorded_by_name === 'Mary' && first?.recorded_at === '2026-10-06T09:00:00.000Z'
    && first?.branch_id === 'br-1' && first?.reason === 'expired' && cloud.posts[0].auth === 'Bearer acc', JSON.stringify(cloud.posts[0]));
  ok('both recorded, oldest first, and no longer waiting', out['11111111-1111-4111-8111-111111111111']?.ref === 'WST-0001'
    && out['22222222-2222-4222-8222-222222222222']?.ref === 'WST-0002' && W.readPending(db).length === 0 && !E.wastagePending(), JSON.stringify(out));
}
{
  // The answer was lost: the till sends the same recording again.
  W.queueRecording(db, rec('11111111-1111-4111-8111-111111111111', [milk]));
  const out = await E.pushWastageNow();
  ok('sent again after a lost answer → the cloud\'s existing entry, not a second one', out['11111111-1111-4111-8111-111111111111']?.ref === 'WST-0001' && cloud.seen.size === 2);
}
{
  cloud.refuse = 'Chicken';
  W.queueRecording(db, rec('33333333-3333-4333-8333-333333333333', [{ kind: 'ingredient', id: 'g-chicken', name: 'Chicken', quantity: 9 }]));
  W.queueRecording(db, rec('44444444-4444-4444-8444-444444444444', [milk]));
  const out = await E.pushWastageNow();
  const refused = W.readRefused(db);
  ok('a refusal ends the wait, with the reason — and the next one still goes',
    out['33333333-3333-4333-8333-333333333333']?.state === 'refused' && refused[0]?.message === 'Chicken: only 1 at this branch.'
    && out['44444444-4444-4444-8444-444444444444']?.state === 'saved' && W.readPending(db).length === 0, JSON.stringify({ out, refused }));
  W.dismissRefused(db, '33333333-3333-4333-8333-333333333333');
  ok('the manager dismisses it', W.readRefused(db).length === 0);
  cloud.refuse = null;
}

console.log('\nOn a till with a branch server (A410)\n');
{
  C.saveDeviceConfig({ node_url: 'http://server.lan:4100', node_secret: 'BRANCH-CODE' });
  cloud.posts.length = 0;
  W.queueRecording(db, rec('55555555-5555-4555-8555-555555555555', [milk]));
  const out = await E.pushWastageNow();
  ok('it goes to the cloud THROUGH the branch server', cloud.posts[0]?.url === 'http://server.lan:4100/node/cloud/api/wastage'
    && cloud.posts[0]?.secret === 'BRANCH-CODE' && out['55555555-5555-4555-8555-555555555555']?.state === 'saved', JSON.stringify(cloud.posts[0]));
  C.saveDeviceConfig({ node_url: '' });
}

console.log('\nWired in\n');
{
  const S = fs.readFileSync(path.join(src, 'syncEngine.ts'), 'utf8');
  const I = fs.readFileSync(path.join(src, 'ipcHandlers.ts'), 'utf8');
  const X = fs.readFileSync(path.join(src, 'index.ts'), 'utf8');
  ok('sent in every push pass and on the 20 s beat', /stage\('wastage'/.test(S) && /if \(wastagePending\(\)\) pushWastageNow\(\)/.test(X));
  ok('recording: the role checked on the till, kept here FIRST, then sent',
    /if \(!mayWaste\(staff\.role_name, staff\.permissions\)\) throw/.test(I)
    && /queueRecording\(db, rec\);\s*const outcome = \(await pushWastageNow\(\)\)\[rec\.client_id\];/.test(I));
  ok('the person and the branch come from the till\'s sign-in, never the screen',
    /recorded_by_name: staff\.staff_name/.test(I) && /branch_id: staff\.branch_id/.test(I));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
