/**
 * android-till-stage1.test.mjs — ZapTill for Android, Till stage 1: the online Shop POS (docs/ANDROID-APP-DESIGN.md §11).
 *
 *   node tests/android-till-stage1.test.mjs      (build apps/server first — this runs its dist/; needs apps/dashboard's
 *                                                 npm ci for esbuild)
 *
 * RUNS, not reads, wherever it can:
 *   G  the cloud's gates for an 'android-till' session (§11.2) — the REAL rules: lib/posSurface.ts and lib/terminalWrites.ts
 *      as they are; the compiled deviceGrant, cloudPlan, tillSessions, webPosSignIn, appUpdate and requireWebSurface
 *   W  every write the web POS screens make is allowed for a person's PIN sign-in on a Shop POS (read from the screens'
 *      source), and none of them for the Shop POS's own session or a desktop's
 *   P  the web POS screens inside a Shop POS — the dashboard's REAL posTerminal, localPrintServer, printRouted and shopPos,
 *      bundled with esbuild: the POS is its own drawer; tickets go to the branch server when one is joined, else straight
 *      to the printer; in a browser (no Shop POS) nothing changes
 *   A  the app's own rules (apps/android/src/shop/rules.ts, as it is): the beacon, the enrolment form, the cloud of a
 *      server's grant, printer addresses, the PIN sign-in's session, the branch server's print answer, the words
 *   S  what is checked in the source because it cannot run here: the cloud's enrolment and PIN sign-in naming the surface,
 *      the Shop POS's online-licence door, the app's single way into the dashboard's screens
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
 *   - isPosDeviceSurface accepting only 'desktop'                                 → G "the POS devices are …"
 *   - SHOP_POS_WRITES allowed for any surface (no surface === 'android-till')      → W "a desktop PIN sign-in: still denied"
 *   - SHOP_POS_WRITES allowed for the POS's own session (pinSignIn ignored)        → W "the Shop POS's own session: denied …"
 *   - deviceSurfaceOf returning the claim as it is                                → G "an unknown surface is the desktop"
 *   - lapseGateApplies keyed on 'desktop' only (dist)                              → G "A581 lapse gate and A601 backup gate"
 *   - shopPosOwnRead allowing every /api/reports read (dist)                      → G "requireWebSurface: … only the drawer's own Z report"
 *   - setCoveredTerminal still storing a till on a Shop POS                        → P "covers no other POS"
 *   - printRoutedStations printing bytes even when the server printed              → P "nothing printed twice"
 *   - parseBeacon accepting port 0                                                 → A "a beacon with a bad port"
 *   - sameCloud comparing only the host's start                                    → A "another cloud is refused"
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

if (!fs.existsSync(path.join(DIST, 'lib/posSurface.js'))) {
  console.log('\nCannot load apps/server/dist/lib/posSurface.js — build the server first:\n  cd apps/server && npm run build\n');
  process.exit(1);
}
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));

// ── G. The cloud's gates for an 'android-till' session ───────────────────────────────────────────────────────────────
console.log('\nG. the cloud\'s gates for a Shop POS (android-till)\n');
const S = await import(pathToFileURL(path.join(ROOT, 'apps/server/src/lib/posSurface.ts')).href);
const T = await import(pathToFileURL(path.join(ROOT, 'apps/server/src/lib/terminalWrites.ts')).href);
const G = require(path.join(DIST, 'lib/deviceGrant.js'));
const CP = require(path.join(DIST, 'lib/cloudPlan.js'));
const TS = require(path.join(DIST, 'lib/tillSessions.js'));
const WP = require(path.join(DIST, 'lib/webPosSignIn.js'));
const AU = require(path.join(DIST, 'routes/appUpdate.js'));
const MW = require(path.join(DIST, 'middleware/auth.js'));

await ok('the POS devices are the desktop POS and the Shop POS; the web, a kitchen screen and a phone are not', () => {
  assert.deepEqual([...S.POS_DEVICE_SURFACES], ['desktop', 'android-till']);
  for (const s of ['desktop', 'android-till']) assert.equal(S.isPosDeviceSurface(s), true, s);
  for (const s of ['web', 'kds', 'mobile', null, undefined, '', 'Desktop']) assert.equal(S.isPosDeviceSurface(s), false, String(s));
});
await ok('an unknown surface is the desktop (every desktop build sends none); only android-till is the Shop POS', () => {
  assert.equal(S.deviceSurfaceOf(undefined), 'desktop');
  assert.equal(S.deviceSurfaceOf('web'), 'desktop');
  assert.equal(S.deviceSurfaceOf('mobile'), 'desktop');
  assert.equal(S.deviceSurfaceOf('android-till'), 'android-till');
});
await ok('terminalWrites keeps the same POS devices as lib/posSurface.ts (written out there: it is loaded as it is)', () => {
  for (const s of ['desktop', 'android-till', 'web', 'kds', 'mobile']) {
    assert.equal(T.terminalWriteVerdict(s, 'POST', '/api/products') !== 'not-gated', S.isPosDeviceSurface(s), s);
  }
});
await ok('the POS\'s own session token: desktop unchanged (no surface named), Shop POS named android-till', () => {
  const base = { deviceId: 'd1', businessId: 'b1', branchId: 'br1', sessionId: 's1' };
  const desk = G.buildDeviceTokenPayload(base);
  assert.equal(desk.surface, 'desktop');
  assert.deepEqual(Object.keys(desk).sort(), ['branchId', 'businessId', 'deviceId', 'isOwner', 'permissionKeys', 'permissionsVersion', 'sessionId', 'surface', 'till', 'userId']);
  const shop = G.buildDeviceTokenPayload({ ...base, surface: 'android-till' });
  assert.equal(shop.surface, 'android-till');
  assert.equal(shop.till, true); assert.equal(shop.userId, null); assert.equal(G.isTillPayload(shop), true);
  assert.equal(G.isOwnerEraTillPayload(shop), false, 'a Shop POS session is never taken for a pre-A415 one');
});
await ok('A581 lapse gate and A601 backup gate: a Shop POS\'s writes like a desktop POS\'s; reads never', () => {
  for (const s of ['desktop', 'android-till']) {
    assert.equal(CP.lapseGateApplies(s, 'POST', '/api/orders'), true, s);
    assert.equal(CP.lapseGateApplies(s, 'GET', '/api/orders'), false, s);
    assert.equal(CP.lapseGateApplies(s, 'POST', '/api/auth/verify-pin'), false, `${s}: sign-in stays open`);
    assert.equal(CP.backupGateApplies(s, 'POST', '/api/orders/x/void'), true, s);
  }
  assert.equal(CP.lapseGateApplies('web', 'POST', '/api/orders'), false);
});
await ok('A584 web pause: not for either POS (each has its own gates)', () => {
  assert.equal(CP.webGateApplies('android-till', '/api/orders'), false);
  assert.equal(CP.webGateApplies('desktop', '/api/orders'), false);
  assert.equal(CP.webGateApplies('web', '/api/orders'), true);
});
await ok('an owner revoking sessions never ends a Shop POS\'s own session (a device\'s), a PIN sign-in on it is a PIN\'s', () => {
  assert.equal(TS.sessionKind({ surface: 'android-till' }), 'device');
  assert.equal(TS.sessionKind({ surface: 'android-till', pinSignIn: true }), 'pin');
  assert.equal(TS.sessionKind({ surface: 'desktop' }), 'device');
  assert.equal(TS.sessionKind({ surface: 'web' }), 'web');
});
await ok('A608: a Shop POS session is never exchanged for a web POS one', () => {
  const owner = () => true;
  assert.equal(WP.dashboardSessionKind({ surface: 'android-till', isOwner: true }, owner), null);
  assert.equal(WP.dashboardSessionKind({ isOwner: true }, owner), 'owner');
});
await ok('the update feed: a PIN sign-in on a Shop POS asks for the Shop POS (never the owner\'s phone)', () => {
  assert.equal(AU.surfaceOfSession({ isTill: true }), 'android-till');
  assert.equal(AU.surfaceOfSession({ isTill: false, surface: 'android-till' }), 'android-till');
  assert.equal(AU.surfaceOfSession({ isTill: false, surface: 'web' }), 'mobile');
});
await ok('requireWebSurface: a Shop POS is kept off the web portal like a desktop POS — only the drawer\'s own Z report reads', () => {
  const run = (surface, method, url) => {
    let nexted = false, status = 0;
    const res = { status(s) { status = s; return { json() {} }; } };
    MW.requireWebSurface({ surface, method, originalUrl: url, isOwner: false }, res, () => { nexted = true; });
    return nexted ? 'next' : status;
  };
  assert.equal(run('android-till', 'GET', '/api/reports/eod?shift_id=1'), 'next');
  assert.equal(run('android-till', 'GET', '/api/reports/sales'), 403);
  assert.equal(run('android-till', 'GET', '/api/analytics/overview'), 403);
  assert.equal(run('android-till', 'POST', '/api/reports/eod'), 403);
  assert.equal(run('desktop', 'GET', '/api/reports/eod'), 403, 'the desktop POS: unchanged');
  assert.equal(run('web', 'GET', '/api/reports/sales'), 'next');
  assert.equal(MW.shopPosOwnRead('desktop', 'GET', '/api/reports/eod'), false);
});

// ── W. The web POS screens' writes ────────────────────────────────────────────────────────────────────────────────────
console.log('\nW. every write the web POS screens make, for a PIN sign-in on a Shop POS\n');
const denied = (surface, m, p, pin) => T.terminalWriteDenied(surface, m, p, pin);
/** Every POST/PUT/PATCH/DELETE path the web POS screens name, with `${…}` as a placeholder id. */
function screenWrites() {
  const dir = path.join(ROOT, 'apps/dashboard/src/pages/pos');
  const files = [];
  const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); fs.statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) && files.push(p); } };
  walk(dir);
  const out = new Set();
  // A generic may hold one level of <…> (posApi.post<{ items?: Foo<Bar> }>(…)); the path is the first argument.
  const re = /\.(post|put|patch|delete)(?:<(?:[^<>()]|<[^<>]*>)*>)?\(\s*([`'"])(\/api\/[^`'"]*)\2/g;
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8');
    for (const m of s.matchAll(re)) out.add(`${m[1].toUpperCase()} ${m[3].replace(/\$\{[^}]*\}/g, 'x1').split('?')[0]}`);
  }
  return [...out].sort();
}
const writes = screenWrites();
await ok(`the screens' writes were found (${writes.length})`, () => assert.ok(writes.length >= 15, writes.join(', ')));
// The dashboard's own back office (opened from the web dashboard, never from a Shop POS — POSPage's "Open POS").
const NOT_ON_A_SHOP_POS = new Set(['POST /api/auth/pos-session']);
for (const w of writes.filter((x) => !NOT_ON_A_SHOP_POS.has(x))) {
  const [m, p] = w.split(' ');
  await ok(`a PIN sign-in on a Shop POS may ${w}`, () => assert.equal(denied('android-till', m, p, true), false));
}
await ok('the Shop POS\'s own session: denied the web POS screens\' live writes (a person makes them)', () => {
  for (const p of ['/api/shifts/open', '/api/shifts/x1/float', '/api/mpesa/stk-push', '/api/staff/clock', '/api/products'])
    assert.equal(denied('android-till', 'POST', p, false), true, p);
  assert.equal(denied('android-till', 'POST', '/api/orders', false), false, 'its own: sales');
});
await ok('a desktop PIN sign-in: still denied the web POS screens\' live writes (the desktop sends them through sync)', () => {
  for (const p of ['/api/shifts/open', '/api/shifts/x1/expense', '/api/parking-sessions', '/api/payments/c2b/claim'])
    assert.equal(denied('desktop', 'POST', p, true), true, p);
});
await ok('the web and the dashboard: not gated at all, as before', () => assert.equal(T.terminalWriteVerdict('web', 'POST', '/api/products'), 'not-gated'));

// ── P. The web POS screens inside a Shop POS (bundled from the dashboard's own files) ───────────────────────────────────
console.log('\nP. the web POS screens inside a Shop POS\n');
function requireFrom(dirs, name) {
  for (const d of dirs) { try { return createRequire(path.join(ROOT, d, 'package.json'))(name); } catch { /* next */ } }
  throw new Error(`${name} not installed (npm ci in apps/dashboard)`);
}
const esbuild = requireFrom(['apps/dashboard', 'apps/android', 'apps/server'], 'esbuild');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'android-stage1-'));
const lib = (f) => JSON.stringify(path.join(ROOT, 'apps/dashboard/src/lib', f).replace(/\\/g, '/'));
fs.writeFileSync(path.join(tmp, 'entry.ts'), `
export * as terminal from ${lib('posTerminal.ts')};
export * as shop from ${lib('shopPos.ts')};
export * as bridge from ${lib('localPrintServer.ts')};
export * as routed from ${lib('printRouted.ts')};`);
const store = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } }; };
globalThis.sessionStorage = store();
globalThis.localStorage = store();
globalThis.window = globalThis;
globalThis.fetch = async () => { throw new Error('no bridge on this machine'); };
esbuild.buildSync({ entryPoints: [path.join(tmp, 'entry.ts')], bundle: true, format: 'cjs', platform: 'node', outfile: path.join(tmp, 'out.cjs'),
  logLevel: 'silent', nodePaths: [path.join(ROOT, 'apps/dashboard/node_modules')], define: { 'import.meta.env': '{}' } });
const D = createRequire(import.meta.url)(path.join(tmp, 'out.cjs'));

const KITCHEN = { id: 'pk', name: 'Kitchen', printer_name: '192.168.1.60', type: 'kitchen', paper_width: 80, category_ids: ['c-food'], is_default_receipt: false, connection_type: 'qz', enabled: true };
const RECEIPT = { id: 'pr', name: 'Receipt', printer_name: '192.168.1.61:9100', type: 'receipt', paper_width: 80, category_ids: [], is_default_receipt: true, connection_type: 'qz', enabled: true };
const cart = [{ product: { id: 'p1', name: 'Wings', category_id: 'c-food' }, quantity: 2, unitPrice: 650, lineTotal: 1300, selectedVariants: [], selectedModifiers: [], notes: 'no salt' }];
const printArgs = (kinds) => ({ cart, branchPrinters: [KITCHEN, RECEIPT], business: { id: 'b', name: 'B Foods', currency: 'KES' }, orderNumber: 'A1-7',
  orderType: 'dine_in', cashierName: 'Wanjiru', total: 1300, tableNumber: '4', kinds, categories: [{ id: 'c-food', name: 'Food', is_kitchen: true }] });

await ok('in a browser (no Shop POS): the covered POS, the bridge and printing behave as before', () => {
  assert.equal(D.terminal.ownTerminal(), null);
  D.terminal.setCoveredTerminal({ device_id: 'desk-T2', terminal_code: 'T2', device_label: null });
  assert.equal(D.terminal.getCoveredTerminal()?.device_id, 'desk-T2', 'A273 covering still works on the web');
  D.terminal.setCoveredTerminal(null);
  assert.notEqual(D.bridge.getQZStatus(), 'connected');
});
await ok('in a browser, printing with no bridge prints nothing and counts the stations as failed (unchanged)', async () => {
  const r = await D.routed.printRoutedStations(printArgs(['kitchen', 'dispatch']));
  assert.deepEqual(r, { printed: 0, failed: 1, configured: 1 });
});

const sent = [], ordered = [];
let serverAnswer = null;
D.shop.setShopPosHost({
  terminal: { device_id: 'android-tab-1', terminal_code: null, device_label: 'Front counter' },
  printBytes: async (target, bytes) => { sent.push({ target, size: bytes.length }); },
  printOrder: async (job, order) => { ordered.push({ job, order }); return serverAnswer; },
});
await ok('on a Shop POS the POS is its own drawer: it covers no other POS', () => {
  assert.equal(D.terminal.getCoveredTerminal()?.device_id, 'android-tab-1');
  D.terminal.setCoveredTerminal({ device_id: 'desk-T2', terminal_code: 'T2', device_label: null });
  assert.equal(D.terminal.getCoveredTerminal()?.device_id, 'android-tab-1');
  assert.equal(sessionStorage.getItem('swiftpos_pos_terminal'), null, 'nothing of another POS kept');
  D.terminal.setCoveredTerminal(null);
  assert.equal(D.terminal.getCoveredTerminal()?.device_id, 'android-tab-1');
});
await ok('joined to a branch server: the whole ticket goes there, nothing printed twice', async () => {
  sent.length = 0; ordered.length = 0;
  serverAnswer = { printed: 1, failed: 0, configured: 1, problem: null };
  const r = await D.routed.printRoutedStations(printArgs(['kitchen', 'dispatch']));
  assert.equal(sent.length, 0, 'no bytes from the tablet');
  assert.equal(ordered.length, 1);
  assert.equal(ordered[0].job, 'kitchen');
  const o = ordered[0].order;
  assert.equal(o.order_number, 'A1-7'); assert.equal(o.cashier_name, 'Wanjiru'); assert.equal(o.table_number, '4');
  assert.equal(o.items[0].product.category_id, 'c-food'); assert.equal(o.items[0].notes, 'no salt');
  assert.equal(r.printed, 1);
});
await ok('Print bill and a kitchen VOID are their own jobs on the server', async () => {
  ordered.length = 0;
  await D.routed.printRoutedStations({ ...printArgs(['receipt']), proforma: true });
  await D.routed.printRoutedStations({ ...printArgs(['kitchen', 'dispatch']), voided: { by: 'Otieno', reason: 'changed mind' } });
  assert.deepEqual(ordered.map((x) => x.job), ['proforma', 'void']);
  assert.deepEqual(ordered[1].order.kitchen_void, { by: 'Otieno', reason: 'changed mind' });
});
await ok('no branch server (or it did not answer): the tablet prints straight to each station\'s printer', async () => {
  sent.length = 0;
  serverAnswer = null;
  const r = await D.routed.printRoutedStations(printArgs(['kitchen', 'dispatch', 'receipt']));
  assert.deepEqual(sent.map((s) => s.target).sort(), ['printer:192.168.1.60', 'printer:192.168.1.61:9100']);
  assert.ok(sent.every((s) => s.size > 50), 'ESC/POS bytes from shared/printing');
  assert.equal(r.printed, 2);
  assert.equal(D.bridge.getQZStatus(), 'connected', 'no PC bridge is looked for on a Shop POS');
});
await ok('the server\'s jobs for a web POS print: kitchen first, then the receipt', () => {
  assert.deepEqual(D.shop.serverJobsOf({ kinds: ['kitchen', 'dispatch'] }), ['kitchen']);
  assert.deepEqual(D.shop.serverJobsOf({ kinds: ['receipt'] }), ['receipt']);
  assert.deepEqual(D.shop.serverJobsOf({}), ['kitchen', 'receipt']);
  assert.deepEqual(D.shop.serverJobsOf({ kinds: ['receipt'], proforma: true }), ['proforma']);
});
D.shop.setShopPosHost(null);

// ── A. The app's own rules ────────────────────────────────────────────────────────────────────────────────────────────
console.log('\nA. the Shop POS\'s own rules\n');
const A = await import(pathToFileURL(path.join(ROOT, 'apps/android/src/shop/rules.ts')).href);
await ok('the branch server\'s beacon (A427): ours only, a sane port, an IPv4 address', () => {
  const b = JSON.stringify({ magic: 'ZAPTILL-SERVER/1', port: 4100, business: 'B Foods', server: 'Westlands' });
  assert.deepEqual(A.parseBeacon(b, '192.168.1.20'), { url: 'http://192.168.1.20:4100', ip: '192.168.1.20', port: 4100, business: 'B Foods', server: 'Westlands' });
  assert.equal(A.parseBeacon(b.replace('4100', '0'), '192.168.1.20'), null, 'a beacon with a bad port');
  assert.equal(A.parseBeacon(b.replace('ZAPTILL-SERVER/1', 'OTHER/1'), '192.168.1.20'), null);
  assert.equal(A.parseBeacon(b, 'fe80::1'), null);
  assert.equal(A.parseBeacon('not json', '192.168.1.20'), null);
  assert.equal(A.serversHeard([{ ip: '192.168.1.20', text: b }, { ip: '192.168.1.20', text: b }, { ip: '10.0.0.9', text: 'x' }]).length, 1);
  assert.equal(A.joinQuestion(A.parseBeacon(b, '192.168.1.20')), 'Join the Westlands server at 192.168.1.20?');
});
await ok('a branch server\'s grant for another cloud is refused (the desktop\'s A494 check)', () => {
  assert.equal(A.sameCloud('https://api.zaptill.co.ke/', 'https://api.zaptill.co.ke'), true);
  assert.equal(A.sameCloud('https://api.zaptill.co.ke.evil.example', 'https://api.zaptill.co.ke'), false, 'another cloud is refused');
  assert.equal(A.sameCloud('', ''), false);
});
await ok('the technician\'s enrolment form', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  assert.equal(A.joinFormProblem(id, 'ABCD1234', 'Front counter'), null);
  assert.match(A.joinFormProblem('B Foods', 'ABCD1234', 'x'), /business ID/);
  assert.match(A.joinFormProblem(id, 'AB', 'x'), /enrolment code/);
  assert.match(A.joinFormProblem(id, 'ABCD1234', ' '), /name/);
  assert.match(A.joinRefusal('ENROL_INVALID', ''), /wrong, expired or already used/);
});
await ok('a printer\'s address: an IPv4 address or a host name, port 9100 unless given; never a URL', () => {
  assert.deepEqual(A.printerAddress('printer:192.168.1.50'), { host: '192.168.1.50', port: 9100 });
  assert.deepEqual(A.printerAddress('printer:192.168.1.50:9101'), { host: '192.168.1.50', port: 9101 });
  assert.deepEqual(A.printerAddress('kitchen-printer'), { host: 'kitchen-printer', port: 9100 });
  for (const bad of ['printer:EPSON TM-T20', 'printer:http://10.0.0.5', 'printer:10.0.0.5/x', 'printer:300.1.1.1', 'printer:10.0.0.5:70000', 'printer:'])
    assert.equal(A.printerAddress(bad), null, bad);
  assert.match(A.notAnAddress('printer:EPSON TM-T20'), /EPSON TM-T20.*address.*sale is saved/);
});
await ok('the session the web POS screens get after a PIN: the person\'s tokens, this POS\'s branch and business', () => {
  const s = A.cashierSessionFrom({ accessToken: 'a', refreshToken: 'r', staff: { id: 'u1', name: 'Wanjiru', role: 'Cashier' }, permissions: { 'orders.create': true } },
    { branchId: 'br1', branchName: 'Westlands', businessType: 'restaurant', currency: 'KES' });
  assert.deepEqual(s, { token: 'a', refreshToken: 'r', staffId: 'u1', staffName: 'Wanjiru', role: 'Cashier', branchId: 'br1', branchName: 'Westlands',
    businessType: 'restaurant', currency: 'KES', permissions: { 'orders.create': true } });
  assert.equal('fromDashboard' in s, false, 'never "opened from the dashboard": locking returns to the PIN pad');
});
await ok('the branch server\'s print answer, as the screens count prints', () => {
  assert.deepEqual(A.serverPrintResult(200, { ok: true, skipped: [], failed: [], problem: null }), { printed: 1, failed: 0, configured: 1, problem: null });
  assert.equal(A.serverPrintResult(200, { ok: false, skipped: ['Dispatch'], failed: [], problem: 'No printer…' }).failed, 1);
  assert.match(A.serverPrintResult(403, null).problem, /Printing straight to this POS's printers instead/);
  assert.match(A.serverPrintResult(404, { problem: null }).problem, /did not print this ticket/, 'a server without /node/print');
  // …and the caller then prints directly (null) — only a 200 is counted as the server's.
  assert.match(read('apps/android/src/shop/branchServer.ts'), /if \(r\.status !== 200\) return null;/);
});
await ok('the POS\'s own session renews a minute before it runs out', () => {
  const jwt = (exp) => `x.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.y`;
  const now = Date.now();
  assert.equal(A.needsRenewal(jwt(Math.floor(now / 1000) + 600), now), false);
  assert.equal(A.needsRenewal(jwt(Math.floor(now / 1000) + 30), now), true);
  assert.equal(A.needsRenewal('garbage', now), true);
});
await ok('the words: a PIN refusal, no connection; "POS", never "till"', () => {
  assert.match(A.pinRefusal(401, null, 'x'), /PIN is not right/);
  assert.match(A.pinRefusal(0, 'OFFLINE', 'x'), /No connection — can't sell/);
  const words = [A.NO_CONNECTION, A.SERVER_NOT_ANSWERING, A.notAnAddress('x'), A.joinRefusal('CLOUD_SUBSCRIPTION_ENDED', ''), A.joinQuestion({ ip: '1.2.3.4', server: null, business: null })];
  for (const w of words) assert.doesNotMatch(w, /\btills?\b/i, w);
});

// ── S. In the source (cannot run here) ────────────────────────────────────────────────────────────────────────────────
console.log('\nS. in the source\n');
const AUTH = read('apps/server/src/routes/auth.ts');
await ok('enrolment, the device grant and the renewal name the surface; a desktop sends none and stays the desktop', () => {
  assert.equal((AUTH.match(/surface: deviceSurfaceOf\(req\.body\?\.surface\)/g) ?? []).length, 2, 'enrol/redeem and device-token');
  assert.match(AUTH, /surface: deviceSurfaceOf\(cleanPayload\.surface\),\s+\/\/ Till stage 1/);
});
await ok('a PIN sign-in on a Shop POS: a POS seat (the branch licence), recorded as a POS, a person\'s PIN sign-in; no offline PIN hash', () => {
  assert.match(AUTH, /if \(isPosDeviceSurface\(req\.surface\) && !\(branch as any\)\.desktop_licensed\)/);
  assert.match(AUTH, /if \(isPosDeviceSurface\(req\.surface\)\) \{\s+\/\/ Till stage 1: a Shop POS is recorded as a POS/);
  assert.match(AUTH, /\.\.\.\(isPosDeviceSurface\(req\.surface\) \? \{ pinSignIn: true \} : \{\}\)/);
  assert.match(AUTH, /offlineAuth: req\.surface === 'desktop' && typeof matchedUser\.pin_hash/, 'the PIN hash stays the desktop\'s (offline sign-in is Till stage 2)');
});
await ok('a Shop POS needs the online licence at its PIN pad (it sells through the cloud only)', () => {
  assert.match(AUTH, /if \(req\.surface === 'android-till' && !\(await getWebAccess\(req\.businessId[^)]*\)\.catch\(\(\) => null\)\)\?\.fullAccess\) \{\s+res\.status\(403\)\.json\(\{[^}]*code:\s+'ONLINE_LICENCE_REQUIRED'/s);
});
await ok('the online licence (premium features) and /api/pos/init\'s POS licence: both POS devices', () => {
  assert.match(read('apps/server/src/lib/onlineLicence.ts'), /if \(!isPosDeviceSurface\(req\.surface\)\) return false;/);
  assert.match(read('apps/server/src/routes/pos.ts'), /if \(\(req\.surface === 'desktop' \|\| req\.surface === 'android-till'\) && !opBranch\?\.desktop_licensed\)/);
});
await ok('the app enters the dashboard\'s screens one way only, and that file exports what the app declares', () => {
  const entry = read('apps/dashboard/src/shopPos/ShopPosScreens.tsx');
  for (const name of ['export function ShopPosSelling', 'export { setShopPosHost }', 'export { storeCashierSession }']) assert.ok(entry.includes(name), name);
  const env = read('apps/android/src/env.d.ts');
  for (const name of ['export const ShopPosSelling', 'export function setShopPosHost', 'export function storeCashierSession']) assert.ok(env.includes(name), name);
  assert.match(read('apps/android/vite.config.ts'), /if \(source === '@zaptill\/dashboard-pos'\) return SHOP_POS_ENTRY;/);
  const appFiles = [];
  const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); fs.statSync(p).isDirectory() ? walk(p) : appFiles.push(p); } };
  walk(path.join(ROOT, 'apps/android/src'));
  for (const f of appFiles) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /from ['"][./]*\.\.\/dashboard\//, `${f} reaches into the dashboard directly`);
});
await ok('the receipt printer set on the tablet is the one the web POS screens print the receipt to (one settings key)', () => {
  const key = (src, re) => (re.exec(src) ?? [])[1];
  const web = key(read('apps/dashboard/src/hooks/usePrinterSettings.ts'), /const STORAGE_KEY = '([^']+)'/);
  const app = key(read('apps/android/src/shop/printing.ts'), /const PRINTER_SETTINGS_KEY = '([^']+)'/);
  assert.ok(web && web === app, `${web} vs ${app}`);
  assert.match(read('apps/dashboard/src/hooks/usePrinterSettings.ts'), /receiptPrinterName\?: string;/);
});
await ok('the web POS screens\' fetch goes through the native HTTP stack (no CORS entry for the app)', () => {
  assert.match(read('apps/android/capacitor.config.ts'), /CapacitorHttp: \{ enabled: true \}/);
});
await ok('no Supabase in the Shop POS: the dashboard\'s client is swapped for a stub with no address or key', () => {
  assert.match(read('apps/android/vite.config.ts'), /return target === SUPABASE_CLIENT \? SUPABASE_STUB : null;/);
  assert.doesNotMatch(read('apps/android/src/shop/supabaseStub.ts'), /createClient|VITE_SUPABASE/);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
