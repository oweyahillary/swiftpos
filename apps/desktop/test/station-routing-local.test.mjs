// A411 — which categories print at a station is saved on the till first, and sent to the cloud after.
// Owner, 2026-10-05: "why does it have to save to the cloude cant it save local then push later if the till is fully
// offline what happens since it cant reach the cloud?"
//
// Drives the REAL compiled dist/main (localDb, stationRouting, syncEngine.pushStationRoutingNow) on a REAL SQLite file,
// with a stand-in cloud.
//
//   cd apps/desktop && npx tsc -p tsconfig.main.json && node test/station-routing-local.test.mjs
//
// MUTATIONS TO CONFIRM BITE:
//   - saveRoutingLocally not writing category_stations          → "prints the new way at once" fails
//   - overlayPending removed from the pull                       → "a pull does not undo it" fails
//   - a newer edit cleared by an older answer (no `at` check)    → "changed again while sending" fails
//   - a 5xx treated as a refusal                                 → "the cloud down: still waiting" fails
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
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a411-'));
const shim = path.join(userData, 'electron-shim.cjs');
let online = true;
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.2' }, ipcMain: { handle() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => globalThis.__online } };`);
globalThis.__online = true;
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return req === 'electron' ? shim : orig.call(this, req, parent, ...rest); };

const L = require(path.join(dist, 'localDb.js'));
const C = require(path.join(dist, 'deviceConfig.js'));
const R = require(path.join(dist, 'stationRouting.js'));
const E = require(path.join(dist, 'syncEngine.js'));
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, refresh_token, user_id, business_id, business_name, logged_in_at) VALUES (1, 'acc', 'ref', 'u-owner', 'biz-1', 'B Foods', '2026-10-05T00:00:00Z')`).run();
C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1', device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Till 1' });
E.configureSyncEngine('http://cloud', 'acc', 'ref');
const now = new Date().toISOString();
for (const [id, name] of [['st-drinks', 'Drinks'], ['st-kitchen', 'Kitchen']]) {
  db.prepare(`INSERT INTO print_stations (id, name, kind, sort_order, active, synced_at) VALUES (?, ?, 'kitchen', 0, 1, ?)`).run(id, name, now);
}
const links = (st) => db.prepare(`SELECT category_id FROM category_stations WHERE station_id = ? ORDER BY category_id`).all(st).map((r) => r.category_id);

// The stand-in cloud.
const cloud = { mode: 'ok', puts: [], reject: [] };
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const json = (status, b, h = {}) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json', ...h } });
  const m = u.match(/\/api\/stations\/([^/]+)\/categories$/);
  if (m && init.method === 'PUT') {
    const body = JSON.parse(init.body);
    cloud.puts.push({ url: u, station: m[1], ids: body.category_ids, auth: init.headers?.Authorization, secret: init.headers?.['X-Node-Secret'] });
    const mark = u.includes('/node/cloud/') ? { 'x-node-gateway': '1' } : {};
    if (cloud.mode === 'offline') throw new TypeError('fetch failed');
    if (cloud.mode === 'down') return json(503, { error: 'Service unavailable' }, mark);
    if (cloud.mode === 'gone') return json(404, { error: 'Station not found' }, mark);
    const valid = body.category_ids.filter((id) => !cloud.reject.includes(id));
    return json(200, { station_id: m[1], category_ids: valid, rejected: body.category_ids.filter((id) => cloud.reject.includes(id)) }, mark);
  }
  return json(404, { error: 'not found' });
};

console.log('\nWho may change it\n');
ok('the cloud\'s own rule: stations.manage or products.manage (or owner)',
  R.mayRoute('manager', '{"stations.manage":true}') && R.mayRoute('supervisor', '{"products.manage":true}') && R.mayRoute('owner', '{}')
  && R.mayRoute('x', '{"*":true}') && !R.mayRoute('cashier', '{"orders.create":true}') && !R.mayRoute('cashier', 'garbage'));

console.log('\nNo connection at all\n');
{
  cloud.mode = 'offline'; globalThis.__online = true;
  R.saveRoutingLocally(db, 'st-drinks', ['c-coffee', 'c-juice', 'c-coffee'], 'Mary');
  ok('a tap prints the new way at once — this till\'s routing has it', JSON.stringify(links('st-drinks')) === '["c-coffee","c-juice"]', JSON.stringify(links('st-drinks')));
  const out = await E.pushStationRoutingNow();
  ok('the cloud cannot be reached: saved on this till, waiting', out['st-drinks']?.state === 'pending' && /Saved on this till/.test(out['st-drinks'].message));
  ok('…still waiting, still routed here', E.stationRoutingPending() && JSON.stringify(links('st-drinks')) === '["c-coffee","c-juice"]');

  // A pull from the cloud (or the branch server) rewrites the routing as the cloud has it — the old set.
  db.prepare(`DELETE FROM category_stations`).run();
  db.prepare(`INSERT INTO category_stations (category_id, station_id) VALUES ('c-burgers', 'st-drinks')`).run();
  R.overlayPending(db);
  ok('a pull does not undo it while it waits', JSON.stringify(links('st-drinks')) === '["c-coffee","c-juice"]', JSON.stringify(links('st-drinks')));
  globalThis.__online = false;
  const off = await E.pushStationRoutingNow();
  ok('the machine offline: nothing is sent, it keeps waiting', off['st-drinks']?.state === 'pending' && cloud.puts.length === 1);
  globalThis.__online = true;
}

console.log('\nThe connection is back\n');
{
  cloud.mode = 'down';
  const down = await E.pushStationRoutingNow();
  ok('the cloud down (503): still waiting', down['st-drinks']?.state === 'pending' && E.stationRoutingPending());
  cloud.mode = 'ok'; cloud.puts.length = 0;
  const up = await E.pushStationRoutingNow();
  ok('it goes up: the whole set, with the till\'s sign-in', cloud.puts.length === 1 && JSON.stringify(cloud.puts[0].ids) === '["c-coffee","c-juice"]'
    && cloud.puts[0].auth === 'Bearer acc' && cloud.puts[0].url === 'http://cloud/api/stations/st-drinks/categories', JSON.stringify(cloud.puts[0]));
  ok('…saved, and no longer waiting', up['st-drinks']?.state === 'saved' && !E.stationRoutingPending());
}
{
  cloud.reject = ['c-ghost'];
  R.saveRoutingLocally(db, 'st-kitchen', ['c-burgers', 'c-ghost']);
  const out = await E.pushStationRoutingNow();
  ok('a category the cloud does not know: reported, and this till keeps what the cloud kept',
    out['st-kitchen']?.state === 'saved' && JSON.stringify(out['st-kitchen'].rejected) === '["c-ghost"]' && JSON.stringify(links('st-kitchen')) === '["c-burgers"]');
  cloud.reject = [];
}
{
  cloud.mode = 'gone';
  R.saveRoutingLocally(db, 'st-kitchen', ['c-fries']);
  const out = await E.pushStationRoutingNow();
  ok('a station deleted elsewhere (404): refused with the reason, no longer waiting (the next pull brings the cloud\'s back)',
    out['st-kitchen']?.state === 'refused' && /Station not found/.test(out['st-kitchen'].message) && !E.stationRoutingPending());
  cloud.mode = 'ok';
}
{
  // Changed again while the first set was on its way: the newer one keeps waiting.
  R.saveRoutingLocally(db, 'st-drinks', ['c-tea'], null, '2026-10-05T10:00:00.000Z');
  const res = await R.pushPendingRouting(db, async () => {
    R.saveRoutingLocally(db, 'st-drinks', ['c-tea', 'c-water'], null, '2026-10-05T10:00:05.000Z');
    return { status: 200, body: { category_ids: ['c-tea'], rejected: [] } };
  });
  ok('changed again while sending: the newer set stays, and still waits',
    res['st-drinks']?.state === 'saved' && R.readPending(db)['st-drinks']?.category_ids.join() === 'c-tea,c-water'
    && JSON.stringify(links('st-drinks')) === '["c-tea","c-water"]', JSON.stringify(R.readPending(db)));
  await E.pushStationRoutingNow();
  ok('…and goes up next', !E.stationRoutingPending());
}
{
  R.saveRoutingLocally(db, 'st-gone', ['c-x']);
  R.overlayPending(db);
  ok('a station no longer on this till is dropped from the waiting list', !('st-gone' in R.readPending(db)));
}

console.log('\nOn a till with a branch server (A410)\n');
{
  C.saveDeviceConfig({ node_url: 'http://server.lan:4100', node_secret: 'BRANCH-CODE' });
  cloud.puts.length = 0;
  R.saveRoutingLocally(db, 'st-drinks', ['c-coffee']);
  const out = await E.pushStationRoutingNow();
  ok('it goes to the cloud THROUGH the branch server, with the branch access code',
    cloud.puts[0]?.url === 'http://server.lan:4100/node/cloud/api/stations/st-drinks/categories' && cloud.puts[0]?.secret === 'BRANCH-CODE'
    && out['st-drinks']?.state === 'saved', JSON.stringify(cloud.puts[0]));
  C.saveDeviceConfig({ node_url: '' });
}

console.log('\nWired in\n');
{
  const S = fs.readFileSync(path.join(src, 'syncEngine.ts'), 'utf8');
  const I = fs.readFileSync(path.join(src, 'ipcHandlers.ts'), 'utf8');
  const X = fs.readFileSync(path.join(src, 'index.ts'), 'utf8');
  ok('a pull lays the waiting sets back over what it wrote',
    /for \(const catId of \(st\.category_ids \?\? \[\]\)\) linkStation\.run\(catId, st\.id\);\s*\}\s*\/\/ A411[^\n]*\n\s*overlayPendingRouting\(db\);/.test(S));
  ok('…and so does the refresh after a station edit', /insLk\.run\(cid, st\.id\);\s*\}\s*overlayPending\(db\);/.test(I));
  ok('sent before each pull, in every push pass, and on the 20 s beat',
    /if \(stationRoutingPending\(\)\) \{ try \{ await pushStationRoutingNow\(\); \} catch[^\n]*\n\s*pulled = await pullCatalogue\(\);/.test(S)
    && /stage\('station routing'/.test(S) && /if \(stationRoutingPending\(\)\) pushStationRoutingNow\(\)/.test(X));
  ok('the tap: role checked on the till, saved here FIRST, then sent',
    /if \(!mayRoute\(staff\.role_name, staff\.permissions\)\) throw/.test(I)
    && /const saved = saveRoutingLocally\(db, id, categoryIds, staff\.staff_name\);\s*const outcome = \(await pushStationRoutingNow\(\)\)\[id\];/.test(I));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
