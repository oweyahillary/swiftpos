// A519 — till items for 1.0.18: the till checks "Sell"; no duplicate terminal codes; "Send logs to support"; a lazy
// screen that cannot load says so; the update bar's one-tap restart.
//
//   cd apps/desktop && npm run build:main && node test/a519-till-items.test.mjs
//
// RUNS the real compiled dist/main (electron shimmed, REAL SQLite, the network a stand-in), the real renderer modules
// (lib/access.ts, lib/retryLazy.ts, components/ScreenBoundary.tsx — bundled with esbuild, rendered with react-dom/server),
// and reads the screens' source for the routing rules.
//
//   1. SELL — main/sellGate.ts: a Kitchen person cannot start a sale (bill number, hold, kitchen send, payment); a map
//      from before A490 (no marker) keeps selling; the owner sells; a bill already open when the rights change is still
//      held, sent and paid; the screens route someone who cannot sell to a plain screen / the manager screens.
//   2. TERMINAL CODES — main/terminalCodes.ts: the next free code; the cloud's list first, the branch server's join answer
//      second, nothing → not refused; an unchanged code never refused; config:save refuses a code in use; the branch
//      server lists its tills' codes from their drawers and bill numbers.
//   3. SUPPORT LOGS — main/supportLogs.ts + logRedact.ts: secrets removed (a corpus), the 24-hour window newest last, the
//      2 MB cap, packed under the cloud's 1 MB limit, the cloud's answers in words; a technician's session only.
//   4. THE LAZY-SCREEN BOUNDARY — "This screen could not load — Retry / Back", logged through log:renderer; Retry imports
//      the chunk again (retryLazy), a second failure reloads.
//   5. THE UPDATE BAR (owner, 2026-10-16) — back office restarts in one tap; a cashier and nobody signed in are refused in
//      main; no PIN path left.
//
// MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
//   - sellGate.maySell returning true for a marker map without orders.create   → "a Kitchen person cannot get a bill number" fails
//   - maySell refusing a map without the marker                                 → "a map from before A490 keeps selling" fails
//   - sellRefusal ignoring `open`                                               → "…the open bill can still be held / paid" fails
//   - terminalCodeVerdict refusing an unchanged code                             → "a till already trading keeps its code" fails
//   - logRedact without the named-field rule                                     → the "pin / node_secret / access_code" corpus rows fail
//   - windowOfLog keeping the oldest instead of the newest at the cap            → "the cap keeps the NEWEST lines" fails
//   - ScreenBoundary.retry not calling resetFailedScreens                       → "Retry imports the chunk again" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ipcHandlersSource } from '../../../scripts/lib/ipc-handler-files.mjs';   // D10: ipcHandlers.ts + ipc/*.ts

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, '..');
const repo = path.join(desktop, '..', '..');
const dist = path.join(desktop, 'dist', 'main');
const require = createRequire(import.meta.url);
const read = (p) => fs.readFileSync(path.join(desktop, p), 'utf8').replace(/\r\n/g, '\n');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a519-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `
  const handlers = (global.__handlers = {});
  const win = { isDestroyed: () => false, webContents: { send: () => {} } };
  module.exports = {
    app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.18', on() {}, isPackaged: false },
    ipcMain: { handle(ch, fn) { handlers[ch] = fn; }, on() {}, removeHandler() {} },
    BrowserWindow: class { static getAllWindows() { return [win]; } static getFocusedWindow() { return null; } },
    dialog: { showSaveDialog: async () => ({ canceled: true }) }, shell: {}, screen: {}, Menu: {},
    powerMonitor: { on() {}, getSystemIdleTime: () => 0 },
    safeStorage: { isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from('w:' + s), decryptString: (b) => Buffer.from(b).toString().slice(2) },
    net: { isOnline: () => false },
  };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return orig.call(this, req === 'electron' ? shim : req, parent, ...rest); };

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };
const said = async (fn) => {
  try {
    const r = await fn();
    if (r && typeof r === 'object' && (r.ok === false || (typeof r.error === 'string' && !Array.isArray(r)))) return String(r.error ?? r.message ?? r.reason ?? 'refused');
    return 'OK';
  } catch (e) { return String(e?.message ?? e); }
};
const MARK = 'catalogue.v2';
const fine = (...keys) => Object.fromEntries([...keys.map((k) => [k, true]), [MARK, true]]);
// Bundles land under apps/desktop/node_modules so an external 'react' resolves to the app's own copy (removed at the end).
const bundleDir = fs.mkdtempSync(path.join(desktop, 'node_modules', '.a519-'));
const bundle = (entry, out, extra = {}) => {
  require('esbuild').buildSync({ entryPoints: [path.join(desktop, entry)], bundle: true, format: 'esm', platform: 'node',
    outfile: path.join(bundleDir, out), logLevel: 'silent', jsx: 'automatic', ...extra });
  return import(pathToFileURL(path.join(bundleDir, out)).href);
};

// ── the real main process ──────────────────────────────────────────────────────────────────────────────────────────
const L = require(path.join(dist, 'localDb.js'));
const db = L.getLocalDb();
const C = require(path.join(dist, 'deviceConfig.js'));
C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud.test', branch_id: 'br-1', device_id: 'dev-T1', device_role: 'till',
  terminal_code: 'T1', device_name: 'Front', node_secret: 'BRANCH-CODE', configured: true });
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'dev-T1', 'biz-1', 'Pollo', '2026-10-15T00:00:00Z')`).run();
db.prepare(`INSERT OR IGNORE INTO branches (id, name) VALUES ('br-1', 'Main')`).run();
require(path.join(dist, 'tokenStore.js')).writeSessionTokens({ token: 'till-token', refreshToken: 'r' });
let route = () => { throw new TypeError('fetch failed'); };
const fetched = [];
globalThis.fetch = async (url, init) => { fetched.push({ url: String(url), init }); return route(String(url), init); };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
require(path.join(dist, 'ipcHandlers.js')).registerIpcHandlers();
const H = global.__handlers;
const signIn = (perms, role = 'staff', id = 'u-1') => {
  db.prepare(`DELETE FROM staff_session WHERE id=1`).run();
  db.prepare(`INSERT INTO staff_session (id, staff_id, staff_name, role_name, branch_id, branch_name, permissions, token, refresh_token, logged_in_at)
              VALUES (1, ?, 'Pat', ?, 'br-1', 'Main', ?, '', NULL, '2026-10-15T00:00:00Z')`).run(id, role, JSON.stringify(perms));
};
const call = (ch, payload) => H[ch]({}, payload);
const sale = (num) => ({ branch_id: 'br-1', order_number: num, subtotal: 100, vat_amount: 0, total: 100, discount_amount: 0,
  items: [{ product: { id: 'p-1', name: 'Tea' }, unitPrice: 100, quantity: 1, lineTotal: 100 }], payments: [{ method: 'cash', amount: 100 }] });

// ── 1. Sell ─────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n1. The till checks "Sell" (orders.create)\n');
const SG = require(path.join(dist, 'sellGate.js'));
const RA = await bundle('src/renderer/lib/access.ts', 'access.mjs');
{
  ok('the owner sells; a map from before A490 (no marker) keeps selling; a marker map needs orders.create; nobody → no',
    SG.maySell({ roleName: 'Owner', permissions: {} }) && SG.maySell({ roleName: 'cashier', permissions: '{}' })
    && SG.maySell({ roleName: 'x', permissions: '{"reports.view":true}' }) && SG.maySell({ permissions: fine('orders.create') })
    && !SG.maySell({ roleName: 'Kitchen', permissions: fine('stations.manage') }) && !SG.maySell(null));
  ok('the screens agree (lib/access maySell) and say the same words',
    RA.maySell({ role: 'owner', permissions: {} }) && RA.maySell({ role: 'cashier', permissions: {} })
    && RA.maySell({ permissions: fine('orders.create') }) && !RA.maySell({ permissions: fine('inventory.view') }) && !RA.maySell(null)
    && RA.SELL_REFUSAL === SG.SELL_REFUSAL && /Settings › Roles/.test(SG.SELL_REFUSAL) && /‘Sell’/.test(SG.SELL_REFUSAL));
  ok('sellRefusal: a new number is a new sale; hold / kitchen / pay go ahead for an OPEN bill',
    SG.sellRefusal('number', { permissions: fine('inventory.view') }, true) === SG.SELL_REFUSAL
    && ['hold', 'kitchen', 'pay'].every((s) => SG.sellRefusal(s, { permissions: fine('inventory.view') }, true) === null
      && SG.sellRefusal(s, { permissions: fine('inventory.view') }, false) === SG.SELL_REFUSAL));
  const bills = SG.createOpenBills(3);
  ['A', 'B', 'C', 'D'].forEach((n) => bills.note(n));
  ok('open bills are remembered (capped, the oldest forgotten first)', bills.has('D') && !bills.has('A') && bills.size() === 3);

  signIn(fine('stations.manage', 'inventory.view'), 'Kitchen', 'u-k');
  ok('a Kitchen person cannot get a bill number', (await said(() => call('orders:nextBillNumber'))) === SG.SELL_REFUSAL);
  ok('…nor pay a sale nobody opened', (await said(() => call('order:create', sale('ORD-x-1')))) === SG.SELL_REFUSAL);
  ok('…nor hold a new bill', (await said(() => call('held:hold', { orderNumber: 'ORD-x-2', label: 'T', orderType: 'retail', cart: [] }))) === SG.SELL_REFUSAL);
  ok('…nor send a new one to the kitchen', (await said(() => call('kitchen:sent', { order_number: 'ORD-x-3', lines: [] }))) === SG.SELL_REFUSAL);
  ok('…and nothing was written', !db.prepare(`SELECT 1 FROM orders WHERE order_number LIKE 'ORD-x-%'`).get()
    && !db.prepare(`SELECT 1 FROM held_orders WHERE order_number LIKE 'ORD-x-%'`).get());

  signIn({}, 'cashier', 'u-old');
  require(path.join(dist, 'shiftService.js')).openShift(500);   // a drawer to sell into
  const oldNum = await call('orders:nextBillNumber');
  ok('a map from before A490 (no marker) keeps selling: a number…', typeof oldNum === 'string' && oldNum.startsWith('T1--'), String(oldNum));
  const oldSale = await said(() => call('order:create', sale(oldNum)));
  ok('…and the sale', oldSale === 'OK', oldSale);
  signIn({}, 'Owner', 'u-own');
  const ownNum = await call('orders:nextBillNumber');
  ok('the owner sells', (await said(() => call('order:create', sale(ownNum)))) === 'OK');

  // Mid-shift: the person could sell when the bill was opened; their role loses "Sell" (the roster refresh).
  signIn(fine('orders.create'), 'cashier', 'u-c');
  const n1 = await call('orders:nextBillNumber');
  const n2 = await call('orders:nextBillNumber');
  signIn(fine('inventory.view'), 'cashier', 'u-c');
  ok('rights lost mid-shift: the open bill can still be held…', (await said(() => call('held:hold', { orderNumber: n1, label: 'Table 1', orderType: 'dine_in', cart: [] }))) === 'OK');
  const heldRow = db.prepare(`SELECT id FROM held_orders WHERE order_number = ?`).get(n1);
  ok('…recalled', !!(await call('held:recall', { id: heldRow.id })));
  ok('…and paid (the cart is never lost)', (await said(() => call('order:create', sale(n1)))) === 'OK');
  ok('…another open one sent to the kitchen and paid', (await said(() => call('kitchen:sent', { order_number: n2, lines: [] }))) === 'OK'
    && (await said(() => call('order:create', sale(n2)))) === 'OK');
  ok('…but the next NEW sale is refused', (await said(() => call('orders:nextBillNumber'))) === SG.SELL_REFUSAL);
  // A bill held on this till by someone else (a held tab from an earlier shift) is open too.
  db.prepare(`INSERT INTO held_orders (id, order_number, label, order_type, table_number, cart, held_at) VALUES ('h-9', 'T1--900', 'Table 9', 'dine_in', '9', '[]', '2026-10-16T08:00:00Z')`).run();
  ok('a bill held earlier (another shift) is an open bill: recalled and paid', !!(await call('held:recall', { id: 'h-9' }))
    && (await said(() => call('order:create', sale('T1--900')))) === 'OK');

  const app = read('src/renderer/App.tsx');
  ok('App: after the PIN, back office → manager; can sell → POS; else the plain no-sell screen',
    app.includes("setState(hasManagerRights(s) ? 'manager' : maySell(s) ? 'pos' : 'nosell');"));
  ok('…the plain screen: the words, Sign out — not an error banner',
    /function NoSellScreen[\s\S]*?\{SELL_REFUSAL\}[\s\S]*?>Sign out</.test(app) && !/function NoSellScreen[\s\S]{0,600}role="alert"/.test(app));
  ok('…the manager screens get no POS for someone who cannot sell (the button disabled, with the words)',
    app.includes("onOpenPOS={maySell(staff) ? () => { setManagerTab(null); setState('pos'); } : undefined}")
    && /onOpenPOS\?: \(\) => void;/.test(read('src/renderer/pages/ManagerPage.tsx'))
    && /disabled=\{!onOpenPOS\}[\s\S]{0,200}title=\{!onOpenPOS \? SELL_REFUSAL/.test(read('src/renderer/pages/ManagerPage.tsx')));
  ok('…a permission change: manager → POS only if they may sell; someone on the POS stays (the open bill)',
    app.includes("setState((st) => (st === 'manager' ? (maySell(s) ? 'pos' : 'nosell') : st));") && app.includes('canSell={maySell(staff)}'));
  const pos = read('src/renderer/pages/POSPage.tsx');
  ok('POS: a NEW sale (empty cart, no open bill) refused on every way in — tap, simple, configured, fuel',
    /const refuseNewSale = \(\): boolean => \{\s*if \(canSell \|\| cart\.length > 0 \|\| orderNumber\) return false;/.test(pos)
    // A578: the menu-hours refusal (and A577's weighed-item line) may come before the freeze check.
    && /const addSimple = \(product: any\) => \{\n(?:[^\n]*\n){0,2}?    if \(refuseFrozen\(product\)\) return;\n    if \(refuseNewSale\(\)\) return;   \/\/ A519/.test(pos)
    && /const handleTap = \(product: any\) => \{\n(?:[^\n]*\n){0,2}?    if \(refuseFrozen\(product\)\) return;\n    if \(refuseNewSale\(\)\) return;   \/\/ A519/.test(pos)
    && pos.includes('if (refuseNewSale()) { setVariantProduct(null); return; }')
    && /addFuelLine[\s\S]{0,140}refuseNewSale\(\)/.test(pos));
}

// ── 2. Terminal codes ───────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n2. No duplicate terminal codes at setup and join\n');
const TC = require(path.join(dist, 'terminalCodes.js'));
{
  ok('the next free code: T1 → T2 …, gaps filled, letters kept, 4 characters at most',
    TC.nextFreeTerminalCode(['T1'], 'T1') === 'T2' && TC.nextFreeTerminalCode(['T1', 'T3'], 'T1') === 'T2'
    && TC.nextFreeTerminalCode(['T1', 'T2'], 'T1') === 'T3' && TC.nextFreeTerminalCode([], 'T1') === 'T1'
    && TC.nextFreeTerminalCode(['BAR1'], 'BAR1') === 'BAR2' && TC.nextFreeTerminalCode(['A'], 'A') === 'A1'
    && TC.nextFreeTerminalCode(['T999'], 'T999').length <= 4);
  const v = (code, current, cloud, server) => TC.terminalCodeVerdict({ code, current, cloud, server });
  const taken = v('T1', null, { in_use: ['T1', 'T2'] }, null);
  ok('a code another till uses is refused, with the next free one', !taken.ok && taken.taken && taken.suggestion === 'T3'
    && /T1 is already used by another till at this branch \(in use: T1, T2\)\. Use T3\./.test(taken.message), JSON.stringify(taken));
  ok('the cloud first; the branch server\'s answer when the cloud could not be asked', v('T2', null, { in_use: ['T1'] }, ['T2']).ok
    && !v('T2', null, null, ['T2']).ok && v('T2', null, null, ['T2']).source === 'server');
  ok('nobody could be asked → not refused (setup never stops on a check)', v('T1', null, null, null).ok);
  ok('a till already trading keeps its code whatever a sibling uses (unchanged is never refused)', v('t1', 'T1', { in_use: ['T1'] }, ['T1']).ok);
  ok('a bad code is refused in words', !v('T-1', null, null, null).ok && /1–4 letters or digits/.test(v('T-1', null, null, null).message));

  const now = Date.now(), iso = (d) => new Date(now - d * 86_400_000).toISOString();
  db.prepare(`INSERT INTO shifts (id, business_id, branch_id, cashier_id, opened_at, status, created_at, device_id, terminal_code) VALUES ('s-a', 'biz-1', 'br-1', 'u', ?, 'open', ?, 'dev-A', 't2')`).run(iso(1), iso(1));
  db.prepare(`INSERT INTO shifts (id, business_id, branch_id, cashier_id, opened_at, status, created_at, device_id, terminal_code) VALUES ('s-old', 'biz-1', 'br-1', 'u', ?, 'closed', ?, 'dev-Z', 'T7')`).run(iso(200), iso(200));
  const cols = db.prepare(`PRAGMA table_info(orders)`).all().map((c) => c.name);
  const need = db.prepare(`PRAGMA table_info(orders)`).all().filter((c) => c.notnull && c.dflt_value === null && !c.pk).map((c) => c.name);
  const row = { id: 'o-b', order_number: 'T4--12', created_at: iso(2), device_id: 'dev-B' };
  for (const c of need) if (!(c in row)) row[c] = c.endsWith('_at') ? iso(2) : (c === 'total' || c === 'subtotal' ? 0 : 'x');
  const keys = Object.keys(row).filter((k) => cols.includes(k));
  db.prepare(`INSERT INTO orders (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => row[k]));
  const codes = TC.codesFromBranchDb(db, 'dev-Q', now);
  ok('the branch server: its tills\' codes from their drawers and bill numbers (last 60 days)', codes.includes('T2') && codes.includes('T4') && !codes.includes('T7'), codes.join(','));
  ok('…the joining device\'s own left out (a till joining again keeps its code)', !TC.codesFromBranchDb(db, 'dev-A', now).includes('T2'));
  const ns = read('src/main/nodeServer.ts');
  ok('…and the join answer carries them (the server\'s own code too)', /terminal_codes = \[\.\.\.new Set\(\[\.\.\.codesFromBranchDb\(getLocalDb\(\), r\.device_id\)/.test(ns)
    && /\.\.\.\(terminal_codes \? \{ terminal_codes \} : \{\}\)/.test(ns));

  // config:save — a first install (not configured yet), the cloud asked.
  C.saveDeviceConfig({ configured: false, terminal_code: null });
  route = (url) => url.includes('/api/support/terminal-codes') ? json(200, { in_use: ['T1', 'T2'], suggestion: 'T3' }) : json(404, {});
  const refused = await said(() => call('config:save', { terminal_code: 'T1' }));
  ok('config:save refuses a code another till at the branch uses, naming the free one', /already used by another till[\s\S]*Use T3/.test(refused), refused);
  ok('…asked the cloud with this till\'s own session for its branch', fetched.some((f) => /\/api\/support\/terminal-codes\?branch_id=br-1&code=T1/.test(f.url)
    && /Bearer till-token/.test(String(f.init?.headers?.Authorization ?? ''))));
  ok('…takes a free one', (await said(() => call('config:save', { terminal_code: 'T3' }))) === 'OK' && C.getDeviceConfig().terminal_code === 'T3');
  ok('install:checkTerminalCode answers the setup screen (taken + suggestion)', (await call('install:checkTerminalCode', { code: 'T2' })).suggestion === 'T3');
  route = () => { throw new TypeError('fetch failed'); };
  ok('offline and no branch server answer: not refused', (await said(() => call('config:save', { terminal_code: 'T5' }))) === 'OK');
  C.saveDeviceConfig({ configured: true });
  route = (url) => url.includes('/api/support/terminal-codes') ? json(200, { in_use: ['T5'] }) : json(404, {});
  ok('set up and trading: the till\'s own code is never refused because a sibling took it', TC.terminalCodeVerdict({ code: 'T5', current: C.getDeviceConfig().terminal_code, cloud: { in_use: ['T5'] }, server: null }).ok);
  ok('…and a technician-less change after set-up is refused as before (tillGates)', /technician console/.test(await said(() => call('config:save', { terminal_code: 'T9' }))));
  ok('install:checkTerminalCode once set up: a technician only', /technician console/.test(await said(() => call('install:checkTerminalCode', { code: 'T9' }))));
  const ip = read('src/renderer/pages/InstallPage.tsx');
  ok('setup screen: the bind step starts from the restored code or the first free one; refuses a taken one with "Use T…"',
    /if \(restored\) \{ setTerminalCode\(restored\)/.test(ip) && /if \(!cancelled && !v\.ok && v\.taken\) setTerminalCode\(v\.suggestion\)/.test(ip)
    && /if \(!\(await checkCode\(terminalCode\.trim\(\)\.toUpperCase\(\), branchId\)\)\)/.test(ip) && />Use \{codeHint\.suggestion\}</.test(ip));
}

// ── 3. Support logs ─────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n3. Send logs to support\n');
const RD = require(path.join(dist, 'logRedact.js'));
const SL = require(path.join(dist, 'supportLogs.js'));
{
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJhYmMiLCJ0aWxsIjp0cnVlfQ.sOmEsIgNaTuRe_value-123';
  const corpus = [
    ['Authorization: Bearer abcdefghijklmnop.qrstuv', /abcdefghijklmnop/],
    ['headers {"Authorization":"Bearer zzzzzzzzzzzz"}', /zzzzzzzzzzzz/],
    [`refresh failed for ${jwt}`, /sOmEsIgNaTuRe|eyJhbGciOiJIUzI1NiJ9\./],
    ['tech token st2.eyJ0ZWNoIjoiYm9iIn0.c2lnbmF0dXJlLXZhbHVl ok', /st2\.eyJ0/],
    ['hash $2b$10$abcdefghijklmnopqrstuuJ8zVb3u5v8jK0lq9WcF8m1rN2pQ4sT6 stored', /\$2b\$10\$abcdef/],
    ['body {"pin":"4321","branch_id":"br-1"}', /4321/],
    ['verify pin=0099 for till', /0099/],
    ['the PIN 7788 was wrong', /7788/],
    ['config {"node_secret":"K7Q2-XM4P","node_url":"https://192.168.1.5:4100"}', /K7Q2-XM4P/],
    ['access_code: ABCD-1234 shown', /ABCD-1234/],
    ['?token=abc123def456&branch=1', /abc123def456/],
    ['{"refreshToken":"rt-secret-value","x":1}', /rt-secret-value/],
    ['{"password":"hunter2"}', /hunter2/],
    ['device_secret=Zm9vYmFyYmF6cXV4', /Zm9vYmFyYmF6cXV4/],
    ['override_pin: 5555', /5555/],
    ['X-Join-Proof: deadbeefcafe', /deadbeefcafe/],
    ['key 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 used', /9f86d081884c7d659a2f/],
  ];
  const bad = corpus.filter(([s, re]) => re.test(RD.redactLog(s)));
  ok(`secrets removed (${corpus.length} cases: bearer, JWT, technician token, bcrypt, pin, node_secret, access_code, password, hex…)`,
    bad.length === 0, bad.map(([s]) => `${s} → ${RD.redactLog(s)}`).join(' ; '));
  const keep = '2026-10-16T08:01:02.123Z [sale] created 7f3e2a10-1b2c-4d5e-8f90-123456789abc 1250 cash x3 T1--1042 at 08:01; pinned server; Tech page';
  ok('what support needs stays: times, amounts, bill numbers, ids, words like "pinned"', RD.redactLog(keep) === keep, RD.redactLog(keep));
  ok('the three copies are identical (check-shared-sync)', ['shared/logRedact.ts', 'apps/desktop/src/main/logRedact.ts', 'apps/server/src/lib/logRedact.ts']
    .map((p) => fs.readFileSync(path.join(repo, p), 'utf8')).every((s, _, a) => s === a[0]));

  const now = Date.parse('2026-10-16T12:00:00Z');
  const t = (h) => new Date(now - h * 3600_000).toISOString();
  const newest = `${t(2)} [err] boom\n    at stack line\n${t(1)} [sync] newest line\n`;   // a log is appended: oldest first
  const older = `${t(30)} [old] too old\n${t(20)} [mid] in window\n`;
  const w = SL.windowOfLog([newest, older], now);
  ok('the 24-hour window: older lines left out, newest LAST, a stack line kept with its line',
    !/too old/.test(w.text) && /in window[\s\S]*boom\n    at stack line[\s\S]*newest line$/.test(w.text), w.text);
  const big = Array.from({ length: 5000 }, (_, i) => `${new Date(now - (5000 - i) * 1000).toISOString()} [x] line ${i} ${'y'.repeat(60)}`).join('\n');
  const capped = SL.windowOfLog([big], now, SL.WINDOW_MS, 64 * 1024);
  ok('the cap keeps the NEWEST lines (the oldest dropped)', Buffer.byteLength(capped.text) <= 64 * 1024 && /line 4999 /.test(capped.text)
    && !/line 0 /.test(capped.text) && capped.dropped > 0);
  const hdr = { business: 'Pollo', businessId: 'biz-1', branch: 'Main', branchId: 'br-1', terminal: 'T1', deviceId: 'dev-T1', deviceName: 'Front',
    role: 'till', version: '1.0.18', os: 'win32 10', ramGb: 4, freeGb: 1, startup: 'startup: ready 180 ms', sync: SL.syncSummary([
      { channel: 'push', lastOkAt: t(0), lastError: null, failures: 0 }, { channel: 'pull', lastOkAt: null, lastError: 'HTTP 403 refused', failures: 3 }]),
    tech: 'Bob (t-1)', at: new Date(now).toISOString() };
  const built = SL.buildSupportText(hdr, [`${t(1)} [auth] {"token":"leak-me-please"}\n`], [`${t(1)} [auth] renewed\n`], now);
  ok('the header: business, branch, terminal, device, version, OS, RAM, the last start, branch sync', ['Business: Pollo', 'Branch: Main', 'Terminal: T1',
    'device dev-T1', 'Version: 1.0.18', 'RAM 4 GB', 'Last start: startup: ready 180 ms', 'pull: 3 failures — HTTP 403 refused'].every((s) => built.text.includes(s)), built.text.slice(0, 600));
  ok('…the whole file redacted', !/leak-me-please/.test(built.text) && /auth\.log, last 24 hours/.test(built.text));
  const noisy = Array.from({ length: 60000 }, (_, i) => `${new Date(now - i * 100).toISOString()} [x] ${Math.random().toString(36).repeat(3)} ${i}`).join('\n');
  const packed = SL.packSupportText(`HEADER\n── swiftpos.log ──\n${noisy}`);
  ok(`packed under the cloud's limit (${SL.MAX_ENCODED_BYTES} base64 characters), header kept, trimmed when needed`,
    packed.b64.length <= SL.MAX_ENCODED_BYTES && zlib.gunzipSync(Buffer.from(packed.b64, 'base64')).toString().startsWith('HEADER'), `${packed.b64.length}`);
  ok('the cloud\'s answers in words: a reference; offline; 429; an older cloud',
    SL.sendVerdict(201, { reference: 'K7Q2XM' }).reference === 'K7Q2XM' && SL.sendVerdict(null, null).offline === true
    && /last hour/.test(SL.sendVerdict(429, {}).message) && /older cloud/.test(SL.sendVerdict(404, {}).message) && SL.sendVerdict(503, {}).offline);
  ok('a technician\'s session only (send and save)', /Tech session required/.test(await said(() => call('tech:sendLogs')))
    && /Tech session required/.test(await said(() => call('tech:saveLog'))));
  const pre = read('src/main/preload.ts'), sch = read('src/main/ipcSchemas.ts'), tp = read('src/renderer/pages/TechPage.tsx');
  ok('bridged (preload, schemas) and on the Tech page: the button, "Sent — reference", "Save log to file" when it could not be sent',
    pre.includes("sendLogs:     ()               => ipcRenderer.invoke('tech:sendLogs'),") && sch.includes("'tech:sendLogs':      NO_PAYLOAD,")
    && sch.includes("'tech:saveLog':       NO_PAYLOAD,") && tp.includes('Send logs to support') && tp.includes('`Sent — reference ${r.reference}`')
    && /support\?\.offerSave &&[\s\S]{0,300}Save log to file/.test(tp));
  ok('…sent under the till\'s own session to POST /api/support/logs, gzip + base64, the technician token alongside',
    /tillFetch\('\/api\/support\/logs', \{ method: 'POST',[\s\S]{0,200}'X-Tech-Token': raw/.test(ipcHandlersSource())
    && /log_gz_b64: packed\.b64/.test(ipcHandlersSource()));
}

// ── 4. The lazy-screen boundary ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n4. A lazy screen that cannot load says so (A517 follow-up)\n');
{
  const SB = await bundle('src/renderer/components/ScreenBoundary.tsx', 'boundary.mjs', { external: ['react', 'react/jsx-runtime'] });
  const RL = await bundle('src/renderer/lib/retryLazy.ts', 'retryLazy.mjs', { external: ['react'] });
  const React = require('react');
  const { renderToStaticMarkup, renderToPipeableStream } = require('react-dom/server');
  const html = renderToStaticMarkup(React.createElement(SB.ScreenLoadFailed, { onRetry() {}, onBack() {} }));
  ok('"This screen could not load — Retry / Back to the till"', /This screen could not load/.test(html) && />Retry</.test(html) && />Back to the till</.test(html));
  ok('…no Back where there is nowhere to go (setup)', !/screen-back/.test(renderToStaticMarkup(React.createElement(SB.ScreenLoadFailed, { onRetry() {} }))));
  const logged = [];
  globalThis.window = { swiftpos: { logError: (m) => logged.push(m) }, location: { reload() {} } };
  const b = new SB.default({ name: 'manager', onBack: () => logged.push('back') });
  b.setState = (u) => { b.state = { ...b.state, ...(typeof u === 'function' ? u(b.state) : u) }; };
  Object.assign(b.state, SB.default.getDerivedStateFromError(new Error('Failed to fetch dynamically imported module: ./ManagerPage-x.js')));
  b.componentDidCatch(new Error('Failed to fetch dynamically imported module: ./ManagerPage-x.js'));
  ok('the failure is logged through log:renderer (window.swiftpos.logError)', logged.some((l) => /A519: the manager screen could not load — Failed to fetch dynamically/.test(l)), logged.join(' | '));
  let reloaded = 0; b.props.reload = () => { reloaded++; };
  b.retry();
  ok('Retry clears the error to import again', b.state.error === null && b.state.tries === 1 && reloaded === 0);
  b.state.error = 'again'; b.retry();
  ok('…a second failure in this window reloads (every file afresh)', reloaded === 1);
  b.state.error = 'x'; b.back();
  ok('Back goes back (the POS, or the PIN screen)', logged.includes('back') && b.state.error === null);

  // retryLazy: a chunk that failed once is imported again after resetFailedScreens.
  let attempts = 0;
  const Screen = RL.retryLazy(() => { attempts++; return attempts === 1 ? Promise.reject(new Error('chunk missing')) : Promise.resolve({ default: () => React.createElement('p', null, 'manager loaded') }); });
  const render = (el) => new Promise((resolve) => {
    let out = ''; let errored = false;
    const s = renderToPipeableStream(React.createElement(React.Suspense, { fallback: 'loading' }, el), {
      onError() { errored = true; },
      onAllReady() { const w = new (require('node:stream').Writable)({ write(c, _e, cb) { out += c; cb(); } }); w.on('finish', () => resolve({ out, errored })); s.pipe(w); },
      onShellError() { resolve({ out, errored: true }); },
    });
  });
  const first = await render(React.createElement(Screen));
  const reset = RL.resetFailedScreens();
  const second = await render(React.createElement(Screen));
  ok('Retry imports the chunk again (React.lazy alone keeps the failure for ever)', first.errored && reset === 1 && /manager loaded/.test(second.out) && attempts === 2,
    JSON.stringify({ first, reset, second, attempts }));
  ok('…a screen that loaded is never reset', RL.resetFailedScreens() === 0);
  const app = read('src/renderer/App.tsx');
  ok('App: every lazy screen inside the boundary (<Lazy> wraps Suspense in ScreenBoundary), lazy is retryLazy',
    /<ScreenBoundary name=\{name\} onBack=\{onBack\} backLabel=\{backLabel\} overlay=\{overlay\}>\s*<Suspense fallback=\{<ScreenLoading overlay=\{overlay\} \/>\}>\{children\}<\/Suspense>\s*<\/ScreenBoundary>/.test(app)
    && app.includes("import { retryLazy as lazy } from './lib/retryLazy';") && !/import \{[^}]*\blazy\b[^}]*\} from 'react'/.test(app));
  ok('…Back from the manager screens: the POS if they may sell, else sign out; from the Tech page: the PIN screen; help: Close',
    app.includes("<Lazy name=\"manager\" onBack={() => { if (maySell(staff)) setState('pos'); else void handleEndShift(); }}")
    && app.includes("<Lazy name=\"Tech\" onBack={() => setState('pin')} backLabel=\"Back to the PIN screen\">")
    && app.includes('<Lazy overlay name="help" onBack={() => setHelpOpen(false)} backLabel="Close">'));
  delete globalThis.window;
}

// ── 5. The update bar ───────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n5. The update bar: one tap for back office, no PIN\n');
{
  signIn(fine('reports.sales', 'shifts.close_day'), 'Manager', 'u-m');
  ok('a manager (back office): one tap — past the gate (then: not a packaged build)', (await call('update:installNow')).reason === 'not packaged');
  signIn(fine('orders.create', 'sales.void', 'sales.refund'), 'cashier', 'u-c');
  ok('a cashier (even one who may void — A499): refused in main', (await call('update:installNow')).reason === 'manager_required');
  db.prepare(`DELETE FROM staff_session WHERE id=1`).run();
  ok('nobody signed in: refused', (await call('update:installNow')).reason === 'manager_required');
  ok('the PIN channel is gone (handler, bridge, schema)', !H['update:installWithPin'] && !/installWithPin/.test(read('src/main/preload.ts'))
    && !/installWithPin/.test(read('src/main/ipcSchemas.ts')) && !/installWithPin/.test(read('src/renderer/lib/posApi.ts')));
  const banner = read('src/renderer/pages/UpdateBanner.tsx');
  ok('the bar: "Restart & update now" only with canRestart; no PIN box; says it installs on close or when idle; nothing about the day',
    /\{canRestart && \([\s\S]{0,300}Restart &amp; update now/.test(banner) && !/type="password"/.test(banner) && !/close the day/i.test(banner.replace(/\/\*[\s\S]*?\*\//g, ''))
    && /installs when ZapTill is closed, or by itself when the till is idle/.test(banner));
  ok('App gives the button to back office only', /<UpdateBanner [^>]*canRestart=\{backOffice\(staff\)\}/.test(read('src/renderer/App.tsx')));
}

console.log(`\n${pass} passed, ${fail} failed`);
try { L.closeLocalDb?.(); } catch { /* */ }
try { fs.rmSync(bundleDir, { recursive: true, force: true }); } catch { /* */ }
process.exit(fail ? 1 : 0);
