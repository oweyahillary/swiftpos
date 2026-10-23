// A564 — on the till: find an item in another branch's stock, and ask that branch for it (Manager › Stock › Other branches).
// Owner, 2026-10-22: "add a feature where employees can search if items are in an inventory of another branch and the
// manager can request for them".
//
// RUNS the real compiled dist/main (the IPC handlers through registerIpcHandlers, manageFetch, cloudGateway; real SQLite,
// electron shimmed) on a till that has a BRANCH SERVER (A410: only the server talks to the cloud), with a stand-in branch
// server / cloud; and the real renderer navigation (src/renderer/lib/managerNav.ts, type-stripped); and reads the screens.
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/branch-stock-a564.test.mjs
//
// MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A564 report):
//   - cloudAnswer treating every failure as offline (no status check)     → "a refusal keeps the cloud's words" fails
//   - cloudAnswer passing the raw no-connection error through              → "offline: Needs a connection" fails
//   - branchStock:find without requireKey(['inventory.view'])             → "the kitchen role is refused" fails
//   - branchStock:request sending the renderer's branch, not this one's   → "always FOR this branch" fails
//   - managerNav showing Other branches without the online licence        → "only with the online licence" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.A564_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)], { stdio: 'inherit', env: { ...process.env, A564_TS: '1' } });
  process.exit(r.status ?? 1);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const read = (p) => fs.readFileSync(path.join(here, '..', p), 'utf8').replace(/\r\n/g, '\n');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a564-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `
  const handlers = (global.__handlers = {});
  module.exports = {
    app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.20', getName: () => 'ZapTill', on() {}, isPackaged: false },
    ipcMain: { handle(ch, fn) { handlers[ch] = fn; }, on() {}, removeHandler() {} },
    BrowserWindow: class { static getAllWindows() { return []; } static getFocusedWindow() { return null; } },
    dialog: {}, shell: {}, screen: {}, Menu: {}, powerMonitor: { on() {}, getSystemIdleTime: () => 0 },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('w:' + s), decryptString: (b) => Buffer.from(b).toString().slice(2) },
    net: { isOnline: () => true },
    session: { fromPartition: () => ({ setCertificateVerifyProc() {} }) },
  };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return orig.call(this, req === 'electron' ? shim : req, parent, ...rest); };

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e?.message ?? String(e); } };
const BR = '22222222-2222-4222-8222-222222222222', KIL = '33333333-2222-4222-8222-222222222222';

// ── The stand-in branch server (its gateway to the cloud) ──
const net = { mode: 'ok', calls: [], answer: null };
const SIGNED = { 'content-type': 'application/json', 'x-zaptill-server': '1', 'x-node-gateway': '1' };
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  net.calls.push({ url: u, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined });
  if (net.mode === 'unreachable') throw new TypeError('fetch failed');
  if (net.mode === 'uplink') return new Response(JSON.stringify({ error: 'no internet' }), { status: 502, headers: { ...SIGNED, 'x-node-uplink': 'down' } });
  if (net.answer) { const [status, b] = net.answer; return new Response(JSON.stringify(b), { status, headers: SIGNED }); }
  if (u.includes('/api/stock/other-branches')) {
    return new Response(JSON.stringify({ branch_id: BR, truncated: false, products: [{ product_id: 'p1', name: 'Tusker lager', sold_by: 'unit',
      branches: [{ branch_id: KIL, branch_name: 'Kilimani', quantity: 24, qty_pieces: null, updated_at: '2026-10-22T08:00:00Z', counting: false }] }] }), { status: 200, headers: SIGNED });
  }
  if (u.includes('/api/stock/requests')) return new Response(JSON.stringify({ branch_id: BR, incoming_open: 1, requests: [] }), { status: 200, headers: SIGNED });
  return new Response('{}', { status: 200, headers: SIGNED });
};

const L = require(path.join(dist, 'localDb.js'));
const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'dev-T2', 'biz-1', 'Test Bar', '2026-10-22T00:00:00Z')`).run();
const C = require(path.join(dist, 'deviceConfig.js'));
const config = (over = {}) => C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: BR, device_id: 'dev-T2', device_role: 'till',
  terminal_code: 'T2', device_name: 'Back', node_url: 'http://192.168.1.10:4100', node_secret: 'branch-code', ...over });
config();
C.setWebPosEnabled(true);   // the online licence, as the catalogue pull stores it
const TS = require(path.join(dist, 'tokenStore.js'));
TS.writeSessionTokens({ token: 't', refreshToken: 'r' });
const V2 = (keys) => JSON.stringify({ 'catalogue.v2': true, ...Object.fromEntries(keys.map((k) => [k, true])) });
const signIn = (name, keys, branch = BR) => {
  db.prepare(`DELETE FROM staff_session`).run();
  db.prepare(`INSERT INTO staff_session (id, staff_id, staff_name, role_name, permissions, branch_id, token, logged_in_at) VALUES (1, ?, ?, 'Manager', ?, ?, 'x', '2026-10-22T06:00:00Z')`)
    .run(`u-${name}`, name, V2(keys), branch);
  TS.writeStaffTokens({ token: `staff-${name}`, refreshToken: 'r' });
};
require(path.join(dist, 'ipcHandlers.js')).registerIpcHandlers();
const H = global.__handlers;
const BS = require(path.join(dist, 'ipc', 'branchStock.js'));
const last = () => net.calls[net.calls.length - 1];

console.log('\nFind in other branches — through the branch server (A410)\n');
{
  signIn('Cate', ['orders.create', 'inventory.view']);
  net.mode = 'ok'; net.calls.length = 0;
  const r = await H['branchStock:find'](null, { q: '  tusker ' });
  const c = last();
  ok('a cashier (inventory.view) finds it: each other branch and how much it holds', r.ok === true && r.data.products[0].branches[0].quantity === 24, JSON.stringify(r));
  ok('…asked of the BRANCH SERVER\'s gateway (never the cloud directly), with the branch code and the person\'s own sign-in',
    c.url === 'http://192.168.1.10:4100/node/cloud/api/stock/other-branches?q=tusker&limit=20' && c.headers['X-Node-Secret'] === 'branch-code'
    && c.headers.Authorization === 'Bearer staff-Cate' && net.calls.every((x) => !x.url.startsWith('http://cloud')), JSON.stringify(c));
  net.mode = 'uplink'; net.calls.length = 0;
  const u = await H['branchStock:find'](null, { q: 'tusker' });
  ok('offline (the branch server has no internet): "Needs a connection" — never an old figure',
    u.ok === false && u.offline === true && u.error === BS.NEEDS_CONNECTION && /^Needs a connection/.test(u.error), JSON.stringify(u));
  net.mode = 'unreachable';
  const n = await H['branchStock:find'](null, { q: 'tusker' });
  ok('…the branch server not reachable either: the same', n.ok === false && n.offline === true && n.error === BS.NEEDS_CONNECTION, JSON.stringify(n));
  net.mode = 'ok';
  const short = await H['branchStock:find'](null, { q: 't' });
  ok('a search under 2 letters is not sent', short.ok === false && short.code === 'SEARCH_TOO_SHORT');
  signIn('Kit', ['products.view']);
  ok('the kitchen role (no inventory.view) is refused on the till', (await rejects(H['branchStock:find'](null, { q: 'tusker' }))) === BS.FIND_REFUSED);
  signIn('Cate', ['orders.create', 'inventory.view']);
  ok('a cashier cannot ask for stock (inventory.transfer)', (await rejects(H['branchStock:request'](null, { from_branch_id: KIL, product_id: 'p1', quantity: 2 }))) === BS.REQUEST_REFUSED);
  ok('…nor see the requests', (await rejects(H['branchStock:requests'](null))) === BS.REQUEST_REFUSED);
  C.setWebPosEnabled(false);
  ok('without the online licence: refused (the page is hidden too)', /online licence/.test(String(await rejects(H['branchStock:find'](null, { q: 'tusker' })))));
  C.setWebPosEnabled(true);
}

console.log('\nAsk, answer — a manager\n');
{
  signIn('Max', ['inventory.view', 'inventory.transfer']);
  net.calls.length = 0;
  const r = await H['branchStock:request'](null, { from_branch_id: KIL, product_id: 'p1', quantity: 6, note: '  Weekend rush ' });
  const c = last();
  ok('a request goes to POST /api/stock/requests through the server, always FOR this branch, the note trimmed',
    r.ok === true && c.method === 'POST' && c.url === 'http://192.168.1.10:4100/node/cloud/api/stock/requests'
    && c.body.to_branch_id === BR && c.body.from_branch_id === KIL && c.body.quantity === 6 && c.body.note === 'Weekend rush', JSON.stringify(c));
  net.answer = [403, { error: 'You can ask for stock only for your own branch.', code: 'NOT_YOUR_BRANCH' }];
  const refused = await H['branchStock:request'](null, { from_branch_id: KIL, product_id: 'p1', quantity: 6 });
  ok('a refusal keeps the cloud\'s words and code (not "offline")', refused.ok === false && refused.offline === false
    && refused.error === 'You can ask for stock only for your own branch.' && refused.code === 'NOT_YOUR_BRANCH', JSON.stringify(refused));
  net.answer = null; net.calls.length = 0;
  const d = await H['branchStock:decide'](null, { id: 'req-1', step: 'decline', reason: '   ' });
  ok('decline needs a reason — asked here first, nothing sent', d.ok === false && d.code === 'REASON_REQUIRED' && net.calls.length === 0);
  await H['branchStock:decide'](null, { id: 'req-1', step: 'decline', reason: ' Need it ' });
  ok('…with one: POST …/req-1/decline { reason }', last().url.endsWith('/node/cloud/api/stock/requests/req-1/decline') && last().body.reason === 'Need it');
  await H['branchStock:decide'](null, { id: 'req-1', step: 'accept' });
  ok('accept and send: POST …/req-1/accept', last().url.endsWith('/api/stock/requests/req-1/accept') && last().method === 'POST');
  await H['branchStock:decide'](null, { id: 'req-1', step: 'accept', quantity: 20 });
  ok('accept with a changed quantity (owner: fewer or more than asked): { quantity: 20 } sent', last().url.endsWith('/req-1/accept') && last().body.quantity === 20, JSON.stringify(last()));
  const bad = await H['branchStock:decide'](null, { id: 'req-1', step: 'delete' });
  ok('an unknown step is refused', bad.ok === false && bad.error === 'Unknown step.');
  const l = await H['branchStock:requests'](null);
  ok('the requests list (with the count waiting here)', l.ok === true && l.data.incoming_open === 1);
  net.mode = 'uplink';
  const off = await H['branchStock:request'](null, { from_branch_id: KIL, product_id: 'p1', quantity: 1 });
  ok('offline: a request says "Needs a connection" (not saved for later — the other branch must see it now)', off.ok === false && off.offline === true && off.error === BS.NEEDS_CONNECTION);
  net.mode = 'ok';
}

console.log('\nThe screens\n');
{
  const Nav = await import(pathToFileURL(path.join(here, '..', 'src', 'renderer', 'lib', 'managerNav.ts')).href);
  const tabsOf = (a) => Nav.buildManagerNav({ isRestaurant: false, canOverview: true, canOrders: true, canItems: false, canShifts: true,
    canExpenses: true, canCloseDay: true, canMenu: true, canOffers: true, canSettings: true, canPrinting: true, canStaff: true,
    showStock: false, canWaste: false, canTransfer: true, ...a }).flatMap((g) => g.tabs);
  const keys = (a) => tabsOf(a).map((t) => t.key);
  ok('Manager › Stock › Other branches only with the online licence and inventory.view',
    keys({ online: true, canBranchStock: true }).includes('branchstock') && !keys({ online: false, canBranchStock: true }).includes('branchstock')
    && !keys({ online: true, canBranchStock: false }).includes('branchstock'));
  ok('…the requests waiting here on the tab: "Other branches (2)"; none: the plain label',
    tabsOf({ online: true, canBranchStock: true, branchRequests: 2 }).find((t) => t.key === 'branchstock').label === 'Other branches (2)'
    && tabsOf({ online: true, canBranchStock: true, branchRequests: 0 }).find((t) => t.key === 'branchstock').label === 'Other branches');
  const page = read('src/renderer/pages/ManagerPage.tsx');
  ok('ManagerPage: the tab by inventory.view, asking by inventory.transfer, the count read once (no timer)',
    /canBranchStock: has\('inventory\.view'\)/.test(page)
    && /case 'branchstock': return online \? <BranchStockTab canRequest=\{has\('inventory\.transfer'\)\} onCount=\{setBranchRequests\} \/>/.test(page)
    && /posApi\.branchStock\.requests\(\)\.then\(\(r\) => \{ if \(r\.ok && r\.data\) setBranchRequests/.test(page));
  const tab = read('src/renderer/components/BranchStockTab.tsx');
  ok('the page: "Westlands: 24 · Kilimani: 0", Request from a branch that holds some, Accept and send / Decline (a reason) / Cancel request',
    /\.join\(' · '\)/.test(tab) && /Request from \{s\.branch_name\}/.test(tab) && /Accept and send/.test(tab)
    && /disabled=\{busy \|\| !reason\.trim\(\)\}/.test(tab) && /Cancel request/.test(tab) && !/setInterval/.test(tab));
  ok('offline is said, not hidden (the amber "Needs a connection" line)', /data-testid=\{offline \? 'branch-stock-offline' : 'branch-stock-error'\}/.test(tab));
  const R = await import(pathToFileURL(path.join(here, '..', 'src', 'renderer', 'lib', 'branchStock.ts')).href);
  ok('the request form: a blank quantity is never sent ("Enter how many."), 0 / words refused, not more than they hold',
    R.quantityProblem('') === 'Enter how many.' && R.quantityProblem('0') === 'Enter a quantity above 0.' && R.quantityProblem('x') === 'Enter a quantity above 0.'
    && R.quantityProblem('30', 24, 'Kilimani') === 'Kilimani holds 24.' && R.quantityProblem('5', 24) === null);
  ok('"asked 30 · sent 20" when the sender changed it; nothing when they sent what was asked',
    R.askedSent({ status: 'accepted', quantity: 30, sent_quantity: 20 }) === 'asked 30 · sent 20' && R.askedSent({ status: 'accepted', quantity: 6, sent_quantity: 6 }) === '');
  ok('the screens use them: the request form opens blank; Accept and send opens the quantity (asked, editable) and sends it',
    /const \[n, setN\] = useState\(''\);/.test(tab) && /const why = quantityProblem\(n, s\.quantity, s\.branch_name\);/.test(tab)
    && /onSend=\{\(n\) => decide\(r, 'accept', \{ quantity: n \}\)\}/.test(tab) && /useState\(String\(Number\(r\.quantity\)\)\)/.test(tab)
    && /askedSent\(r\) \? ` · \$\{askedSent\(r\)\}` : ''/.test(tab));
  const pre = read('src/main/preload.ts');
  ok('preload: branchStock.find / requests / request / decide', /branchStock: \{/.test(pre) && /'branchStock:find'/.test(pre) && /'branchStock:decide'/.test(pre));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
