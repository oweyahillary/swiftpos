/**
 * attendance-a599.test.mjs — A599: Attendance (premium) — the cloud and the web.
 *
 *   cd apps/server && npm run build && cd ../.. && TZ=UTC node --no-warnings tests/attendance-a599.test.mjs
 *
 * Owner, 2026-10-27/28: punches come ONLY from a ZKTeco device (K90 Pro first), for everyone, through the branch server;
 * fingerprints never leave the device; the flag 'attendance' (ZapTill's, admin portal) — off, nothing anywhere.
 *
 * RUNS the COMPILED server (routes/index.js behind the real requireAuth) over HTTP on the in-memory database
 * (tests/lib-memdb.mjs), the pure rules (dist/lib/attendanceRules.js) directly, the shared permission catalogue, and the
 * dashboard's lib/attendanceView.ts bundled with esbuild.
 *
 *   R  the rules: pairing in time order (in / out alternately), a night shift on the day it started (cut-off 0 and 4 h),
 *      an odd last punch = missing punch-out (flagged, not counted), a double tap ignored, a 16 h gap never paired, the
 *      next free number, a punch from the batch checked, what the device should hold
 *   F  the flag OFF: every web and branch-server route 403 ATTENDANCE_OFF; the menu item hidden
 *   C  the web POS PIN clock-in: works with the flag off, 403 CLOCK_BY_DEVICE with it on (before any PIN is read)
 *   O  an attendance-only person: no users row (no sign-in, no PIN, not a POS user, not on the staff list)
 *   I  ingest: only a confirmed branch server of the business, its own branch's devices; idempotent (a resend is all
 *      duplicates); the device's state (serial) first; the device's users → "New on the device" and the writes queued
 *   U  "Not matched" → link: every punch of the number assigned retroactively
 *   K  corrections: a reason required; the original kept (voided, who / when / why); the change in the report
 *   P  permissions: the defaults (owner / partners all three; Manager and GM view + edit; cashiers none); the rights gate
 *   $  pay: only for the owner or staff.pay — no pay field at all otherwise
 *   D  the dashboard helpers: heat colours, the month grid, one preset lit, the Excel sheets without pay
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — 2026-10-28):
 *   - attendanceRules.ts pairPunches without the MAX_SHIFT_HOURS check            → R "a 16 h gap never pairs" fails
 *   - attendanceRules.ts the pair counted on the OUT's day (businessDate(p.at))   → R "night shift" fails
 *   - routes/attendance.ts the punches upsert without ignoreDuplicates            → I "idempotent" fails
 *   - routes/attendance.ts maySeePay always true                                   → $ "no pay field" fails
 *   - routes/staff.ts /clock without the attendanceEnabled refusal                → C "403 CLOCK_BY_DEVICE" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installMemDb } from './lib-memdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${String(e.stack ?? e.message).split('\n').slice(0, 4).join('\n      ')}`); } };
if (!fs.existsSync(path.join(DIST, 'routes/attendance.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET = randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const mem = installMemDb(supabase);
const state = require(path.join(DIST, 'lib/permissionsState.js'));
const AC = require(path.join(DIST, 'lib/authCache.js'));
const ST = require(path.join(DIST, 'lib/attendanceStore.js'));
const R = require(path.join(DIST, 'lib/attendanceRules.js'));
const bcrypt = require('bcrypt');
console.warn = () => {}; console.error = () => {};
const CAT = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/permissions.ts')).href);

// The dashboard's helpers, bundled.
const esbuild = createRequire(path.join(ROOT, 'apps/dashboard/package.json'))('esbuild');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a599-'));
await esbuild.build({ entryPoints: [path.join(ROOT, 'apps/dashboard/src/lib/attendanceView.ts')], bundle: true, format: 'cjs', platform: 'node',
  outfile: path.join(tmp, 'attendanceView.cjs'), logLevel: 'silent' });
const AV = createRequire(import.meta.url)(path.join(tmp, 'attendanceView.cjs'));
fs.rmSync(tmp, { recursive: true, force: true });

const B = '11111111-1111-4111-8111-111111111111', B2 = '99999999-1111-4111-8111-111111111111';
const BR = '22222222-2222-4222-8222-222222222222', BR2 = '33333333-2222-4222-8222-222222222222', BRX = '44444444-2222-4222-8222-222222222222';
const OWNER = 'aaaaaaaa-0000-4000-8000-000000000001', MGR = 'aaaaaaaa-0000-4000-8000-000000000002', CASH = 'aaaaaaaa-0000-4000-8000-000000000003';
const PART = 'aaaaaaaa-0000-4000-8000-000000000004', FIN = 'aaaaaaaa-0000-4000-8000-000000000005';
const DEV = 'dddddddd-0000-4000-8000-000000000001', DEV2 = 'dddddddd-0000-4000-8000-000000000002', DEVX = 'dddddddd-0000-4000-8000-000000000009';
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const PIN_HASH = await bcrypt.hash('4321', 4);
const MGR_KEYS = ['attendance.view', 'attendance.edit', 'staff.view'];

const reset = (flag = true) => {
  mem.fail = () => null; mem.calls = []; mem.realOr = false; mem.rowCap = Infinity;
  AC._resetAuthCache(); ST.forgetAttendanceFlag();
  const user = (id, name, extra = {}) => ({ id, name, status: 'active', business_id: B, permissions_version: 0, pin_hash: PIN_HASH, hourly_rate: null, roles: { name: 'Staff' }, user_branches: [{ branch_id: BR }], user_permissions: [], ...extra });
  mem.db = {
    businesses: [{ id: B, owner_id: OWNER, name: 'Krunch & Co', type: 'restaurant', currency: 'KES', status: 'active' },
      { id: B2, owner_id: 'x', name: 'Other', type: 'retail', currency: 'KES', status: 'active' }],
    branches: [{ id: BR, business_id: B, name: 'Westlands' }, { id: BR2, business_id: B, name: 'CBD' }, { id: BRX, business_id: B2, name: 'Theirs' }],
    users: [user(OWNER, 'Owner', { user_branches: [] }), user(MGR, 'Akinyi', { hourly_rate: 200 }), user(CASH, 'Brian', { hourly_rate: 150 }),
      user(PART, 'Pam', { user_branches: [] }), user(FIN, 'Faith')],
    user_branches: [],
    user_devices: [
      { id: 'ud-s', business_id: B, device_id: 'dev-S', status: 'approved', retired_at: null, branch_id: BR, user_id: OWNER, device_role: 'node', role_confirmed_at: ago(86_400_000) },
      { id: 'ud-t', business_id: B, device_id: 'dev-T', status: 'approved', retired_at: null, branch_id: BR, user_id: OWNER, device_role: 'till', role_confirmed_at: null },
      { id: 'ud-x', business_id: B2, device_id: 'dev-X', status: 'approved', retired_at: null, branch_id: BRX, user_id: 'x', device_role: 'node', role_confirmed_at: ago(86_400_000) },
    ],
    feature_flags: flag ? [{ business_id: B, key: 'attendance', enabled: true }, { business_id: B2, key: 'attendance', enabled: true }] : [],
    attendance_devices: [
      { id: DEV, business_id: B, branch_id: BR, name: 'Front door', ip: '192.168.1.201', port: 4370, comm_key: 0, serial: null, removed_at: null, created_at: ago(9e6) },
      { id: DEV2, business_id: B, branch_id: BR2, name: 'CBD door', ip: '192.168.2.201', port: 4370, comm_key: 0, serial: 'CBD123', removed_at: null, created_at: ago(9e6) },
      { id: DEVX, business_id: B2, branch_id: BRX, name: 'Theirs', ip: '10.0.0.2', port: 4370, comm_key: 0, serial: 'X1', removed_at: null, created_at: ago(9e6) },
    ],
    attendance_people: [], attendance_device_users: [], attendance_device_actions: [], clock_events: [],
    business_settings: [], branch_settings: [], cloud_plans: [], refresh_tokens: [], audit_log: [], notifications: [], admin_users: [], ops_events: [],
    sync_versions: [], sync_changes: [], sync_change_floor: [{ id: 1, floor_seq: 0 }], roles: [], role_permissions: [], permissions: [],
  };
};

const express = require('express');
const jwt = require('jsonwebtoken');
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/api', require(path.join(DIST, 'routes/index.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const port = server.address().port;
const sign = (p) => jwt.sign({ sessionId: 's', permissionsVersion: 0, businessId: B, branchId: BR, isOwner: false, surface: 'dashboard', ...p }, process.env.JWT_SECRET, { expiresIn: '5m' });
const T = {
  owner: sign({ userId: OWNER, isOwner: true, ownerLogin: true, branchId: null, permissionKeys: ['*'] }),
  manager: sign({ userId: MGR, permissionKeys: MGR_KEYS }),
  managerPay: sign({ userId: MGR, permissionKeys: [...MGR_KEYS, 'staff.pay'] }),
  cashier: sign({ userId: CASH, permissionKeys: ['orders.create', 'staff.view'] }),
  partner: sign({ userId: PART, branchId: null, webPartner: true, allBranches: true, partnerBranches: [BR, BR2], permissionKeys: ['reports.sales'] }),
  posCashier: sign({ userId: CASH, permissionKeys: ['orders.create'], surface: 'pos', pinSignIn: true }),
  server: sign({ userId: null, deviceId: 'dev-S', till: true, permissionKeys: ['*'], surface: 'desktop' }),
  till: sign({ userId: null, deviceId: 'dev-T', till: true, permissionKeys: ['*'], surface: 'desktop' }),
  serverX: sign({ userId: null, businessId: B2, branchId: BRX, deviceId: 'dev-X', till: true, permissionKeys: ['*'], surface: 'desktop' }),
};
const call = async (method, p, token, body) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
};
const at = (s) => new Date(s).toISOString();   // '2026-10-20T08:00:00+03:00' → UTC ISO
const P = (id, s, extra = {}) => ({ id, at: at(s), ...extra });

try {
  state._setPermissionsMigrated(true);

  console.log('\nR. the rules\n');
  await ok('pairing: in / out alternately in time order; first in, last out, worked = the sum of the pairs (a lunch break left out)', async () => {
    const days = R.pairPunches([P('c', '2026-10-20T13:30:00+03:00'), P('a', '2026-10-20T08:00:00+03:00'), P('d', '2026-10-20T17:00:00+03:00'), P('b', '2026-10-20T12:30:00+03:00')]);
    const d = days.get('2026-10-20');
    assert.equal(d.shifts.length, 2);
    assert.equal(d.minutes, 270 + 210); assert.equal(d.hours, 8);
    assert.equal(d.firstIn, at('2026-10-20T08:00:00+03:00')); assert.equal(d.lastOut, at('2026-10-20T17:00:00+03:00'));
    assert.equal(d.missingOut, false);
  });
  await ok('night shift: 22:00 → 06:00 counts 8 h on the day it STARTED (cut-off midnight, and a 4 h cut-off)', async () => {
    for (const cut of [0, 240]) {
      const days = R.pairPunches([P('a', '2026-10-20T22:00:00+03:00'), P('b', '2026-10-21T06:00:00+03:00')], cut);
      assert.equal(days.get('2026-10-20')?.hours, 8, `cut-off ${cut}`);
      assert.ok(!days.get('2026-10-21') || days.get('2026-10-21').minutes === 0, `nothing counted on the 21st (cut-off ${cut})`);
    }
    // a 02:00 punch with a 4 h cut-off belongs to the business day before
    assert.equal(R.businessDate(at('2026-10-21T02:00:00+03:00'), 240), '2026-10-20');
    assert.equal(R.businessDate(at('2026-10-21T02:00:00+03:00'), 0), '2026-10-21');
  });
  await ok('an odd last punch = a missing punch-out: flagged, NOT counted', async () => {
    const d = R.pairPunches([P('a', '2026-10-20T08:00:00+03:00'), P('b', '2026-10-20T17:00:00+03:00'), P('c', '2026-10-20T18:00:00+03:00')]).get('2026-10-20');
    assert.equal(d.hours, 9); assert.equal(d.missingOut, true);
    assert.equal(d.shifts.filter((s) => !s.out).length, 1);
    const p = R.personPeriod([P('x', '2026-10-21T08:00:00+03:00')], '2026-10-21', '2026-10-21');
    assert.equal(p.totals.hours, 0); assert.equal(p.totals.missedOuts, 1); assert.equal(p.totals.daysWorked, 0);
  });
  await ok('a double tap (within 2 minutes) is ignored for the pairing', async () => {
    const d = R.pairPunches([P('a', '2026-10-20T08:00:00+03:00'), P('a2', '2026-10-20T08:00:40+03:00'), P('b', '2026-10-20T16:00:00+03:00')]).get('2026-10-20');
    assert.equal(d.hours, 8); assert.equal(d.doubleTaps, 1); assert.equal(d.missingOut, false);
  });
  await ok('a 16 h gap never pairs: a forgotten punch-out does not swallow the next day', async () => {
    const days = R.pairPunches([P('a', '2026-10-20T08:00:00+03:00'), P('b', '2026-10-21T08:00:00+03:00'), P('c', '2026-10-21T17:00:00+03:00')]);
    assert.equal(days.get('2026-10-20').missingOut, true); assert.equal(days.get('2026-10-20').minutes, 0);
    assert.equal(days.get('2026-10-21').hours, 9); assert.equal(days.get('2026-10-21').missingOut, false);
  });
  await ok('the next free number; a device number cleaned ("0012" → 12; 0, -1, 1e10, "a1" refused)', async () => {
    assert.equal(R.nextFreeNumber([]), 1); assert.equal(R.nextFreeNumber([1, 2, 4]), 3); assert.equal(R.nextFreeNumber([2, 3]), 1);
    assert.equal(R.cleanAttendanceNo('0012'), 12); assert.equal(R.cleanAttendanceNo(7), 7);
    for (const bad of [0, -1, '1e10', 'a1', '', null, 1.5, '1234567890']) assert.equal(R.cleanAttendanceNo(bad), null, String(bad));
  });
  await ok('a punch of the batch is checked: a future time, a time before 2015, a bad user id are refused; seconds kept whole', async () => {
    const now = Date.parse('2026-10-28T10:00:00Z');
    assert.deepEqual(R.cleanIncomingPunch({ device_user_id: '12', at: '2026-10-28T09:00:00.700Z', status: 1, punch: 0 }, now),
      { device_user_id: '12', at: '2026-10-28T09:00:00.000Z', status: 1, punch: 0, uid: null });
    assert.ok('error' in R.cleanIncomingPunch({ device_user_id: '12', at: '2026-10-28T11:00:00Z' }, now));
    assert.ok('error' in R.cleanIncomingPunch({ device_user_id: '12', at: '2010-01-01T00:00:00Z' }, now));
    assert.ok('error' in R.cleanIncomingPunch({ device_user_id: '1 2', at: '2026-10-28T09:00:00Z' }, now));
  });
  await ok('what the device should hold: missing users written, OUR renamed one rewritten, OUR deactivated one removed — an admin never touched', async () => {
    const have = [{ device_user_id: '2', name: 'Bryan', privilege: 0 }, { device_user_id: '3', name: 'Gone', privilege: 0 }, { device_user_id: '5', name: 'Admin', privilege: 14 }, { device_user_id: '9', name: 'Admin2', privilege: 14 }];
    const want = [{ attendance_no: 1, name: 'Akinyi', id: 'p1' }, { attendance_no: 2, name: 'Brian', id: 'p2' }, { attendance_no: 5, name: 'Boss', id: 'p5' }];
    const ours = new Map([[2, 'p2'], [3, 'p3'], [9, 'p9']]);
    const d = R.deviceDiff(want, have, [3, 9], ours);
    assert.deepEqual(d.write.map((p) => p.attendance_no), [1, 2]);
    assert.deepEqual(d.remove, [3]);
    assert.deepEqual(d.clashes.map((c) => c.attendance_no), [5], 'an admin slot is never written');
    assert.deepEqual(R.newOnDevice([{ device_user_id: '7' }, { device_user_id: '1' }], [{ attendance_no: 1 }]).map((u) => u.device_user_id), ['7']);
  });
  await ok('a device bought before ZapTill (real K40: 138 people from 1): a number we never wrote or linked is a stranger — never overwritten, never deleted', async () => {
    const have = [{ device_user_id: '1', name: 'JOHN K', privilege: 0 }, { device_user_id: '2', name: 'Akinyi', privilege: 0 }, { device_user_id: '3', name: 'MARY', privilege: 0 }];
    const d = R.deviceDiff([{ attendance_no: 1, name: 'Brian', id: 'pb' }, { attendance_no: 2, name: 'Akinyi', id: 'pa' }, { attendance_no: 4, name: 'Faith', id: 'pf' }], have, [3], new Map());
    assert.deepEqual(d.clashes.map((c) => [c.attendance_no, c.name_on_device]), [[1, 'JOHN K']], 'Brian is not JOHN K: a clash, nothing written');
    assert.deepEqual(d.write.map((p) => p.attendance_no), [2, 4], 'Akinyi (the same name) written once to claim it; Faith onto an empty slot');
    assert.deepEqual(d.remove, [], 'MARY (3) was never ours: not deleted');
  });
  await ok('who holds a slot: the latest done or pending action — a write gives it, a delete frees it, cancelled and failed give nothing', async () => {
    const c = R.slotClaims([
      { attendance_no: 1, action: 'write_user', person_id: 'pa', status: 'done', created_at: '2026-10-01T00:00:00Z' },
      { attendance_no: 1, action: 'delete_user', person_id: 'pa', status: 'done', created_at: '2026-10-02T00:00:00Z' },
      { attendance_no: 2, action: 'write_user', person_id: 'pb', status: 'pending', overwrite: true, created_at: '2026-10-01T00:00:00Z' },
      { attendance_no: 6, action: 'write_user', person_id: 'pf', status: 'pending', overwrite: false, created_at: '2026-10-01T00:00:00Z' },
      { attendance_no: 3, action: 'write_user', person_id: 'pc', status: 'failed', created_at: '2026-10-01T00:00:00Z' },
      { attendance_no: 4, action: 'write_user', person_id: 'pd', status: 'cancelled', created_at: '2026-10-01T00:00:00Z' },
      { attendance_no: 5, action: 'write_user', person_id: 'pe', status: 'done', created_at: '2026-10-03T00:00:00Z' },
      { attendance_no: 5, action: 'write_user', person_id: 'pz', status: 'done', created_at: '2026-10-01T00:00:00Z' },
    ]);
    assert.equal(c.get(1), null); assert.equal(c.get(2), 'pb'); assert.equal(c.has(3), false); assert.equal(c.has(4), false); assert.equal(c.get(5), 'pe');
    assert.equal(c.has(6), false, 'an automatic write still waiting is not a claim (the slot may be someone else by then)');
  });

  console.log('\nF. the flag OFF — nothing anywhere\n');
  await ok('every web route 403 ATTENDANCE_OFF (owner included)', async () => {
    reset(false);
    for (const [m, p, body] of [['GET', '/api/attendance/access'], ['GET', '/api/attendance/report?from=2026-10-19&to=2026-10-25'], ['GET', '/api/attendance/people'],
      ['POST', '/api/attendance/people', { name: 'Cook', branch_id: BR }], ['GET', '/api/attendance/devices'], ['POST', '/api/attendance/devices', { name: 'X', ip: '1.2.3.4', branch_id: BR }],
      ['GET', '/api/attendance/unmatched'], ['GET', '/api/attendance/device-users'], ['POST', '/api/attendance/punches', { user_id: CASH, at: ago(3600_000), reason: 'forgot' }]]) {
      const r = await call(m, p, T.owner, body);
      assert.equal(r.status, 403, `${m} ${p}: ${r.text.slice(0, 120)}`); assert.equal(r.body.code, 'ATTENDANCE_OFF', p);
    }
    assert.equal(mem.db.attendance_people.length, 0); assert.equal(mem.db.attendance_devices.length, 3);
  });
  await ok('every branch-server route 403 ATTENDANCE_OFF', async () => {
    reset(false);
    for (const [m, p, body] of [['GET', '/api/attendance/node/config'], ['POST', '/api/attendance/node/punches', { device_id: DEV, punches: [] }],
      ['POST', `/api/attendance/node/devices/${DEV}/state`, { serial: 'S1' }], ['POST', `/api/attendance/node/actions/${DEV}/ack`, { ok: true }]]) {
      const r = await call(m, p, T.server, body);
      assert.equal(r.status, 403, p); assert.equal(r.body.code, 'ATTENDANCE_OFF', p);
    }
  });
  await ok('the menu item: hidden with the flag off (even for the owner); with it on, the owner, a partner, attendance.view — never a cashier', async () => {
    const can = (keys) => (k) => keys.includes('*') || keys.includes(k);
    assert.equal(AV.showAttendanceNav({ flagOn: false, isOwner: true, isPartner: false, can: can(['*']) }), false);
    assert.equal(AV.showAttendanceNav({ flagOn: true, isOwner: true, isPartner: false, can: can(['*']) }), true);
    assert.equal(AV.showAttendanceNav({ flagOn: true, isOwner: false, isPartner: true, can: can([]) }), true);
    assert.equal(AV.showAttendanceNav({ flagOn: true, isOwner: false, isPartner: false, can: can(['attendance.view']) }), true);
    assert.equal(AV.showAttendanceNav({ flagOn: true, isOwner: false, isPartner: false, can: can(['orders.create']) }), false);
    const layout = fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/components/DashboardLayout.tsx'), 'utf8');
    assert.match(layout, /path === '\/dashboard\/attendance'\) return showAttendanceNav\(\{ flagOn: attendanceOn/);
    const cashier = fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/pages/pos/CashierScreen.tsx'), 'utf8');
    assert.match(cashier, /\{!attendanceDevice && <button[\s\S]{0,300}setShiftModal\('clockin'\)/, 'the web POS hides its Clock button with the flag');
  });

  console.log('\nC. the web POS PIN clock-in\n');
  await ok('flag OFF: POST /api/staff/clock works as before (right PIN 200 and a pin row; wrong PIN 401)', async () => {
    reset(false);
    const r = await call('POST', '/api/staff/clock', T.posCashier, { pin: '4321', type: 'in', branch_id: BR });
    assert.equal(r.status, 200, r.text.slice(0, 200)); assert.equal(r.body.staff_id, CASH);
    assert.equal(mem.db.clock_events.length, 1); assert.equal(mem.db.clock_events[0].event_type, 'in');
    assert.equal((await call('POST', '/api/staff/clock', T.posCashier, { pin: '9999', type: 'out', branch_id: BR })).status, 401);
  });
  await ok('flag ON: 403 CLOCK_BY_DEVICE, nothing written (the PIN not even checked — a wrong one is refused the same)', async () => {
    reset(true);
    for (const pin of ['4321', '9999']) {
      const r = await call('POST', '/api/staff/clock', T.posCashier, { pin, type: 'in', branch_id: BR });
      assert.equal(r.status, 403); assert.equal(r.body.code, 'CLOCK_BY_DEVICE');
    }
    assert.equal(mem.db.clock_events.length, 0);
  });

  console.log('\nO. an attendance-only person\n');
  let cook;
  await ok('made with a name and a branch (number = the next free one); NOT a users row — no sign-in, no PIN, not a POS user', async () => {
    reset(true);
    const before = mem.db.users.length;
    const r = await call('POST', '/api/attendance/people', T.owner, { name: '  Mama   Njeri ', branch_id: BR });
    assert.equal(r.status, 201, r.text.slice(0, 200));
    cook = r.body;
    assert.equal(cook.name, 'Mama Njeri'); assert.equal(cook.attendance_no, 1); assert.equal(cook.user_id, null);
    assert.equal(mem.db.users.length, before, 'no users row');
    assert.ok(!mem.db.users.some((u) => u.name === 'Mama Njeri'));
  });
  await ok('not on the staff list; no PIN clock-in and no POS sign-in can find them', async () => {
    const staff = await call('GET', '/api/staff', T.owner);
    assert.equal(staff.status, 200, staff.text.slice(0, 200));
    assert.ok(!JSON.stringify(staff.body).includes('Mama Njeri'));
    ST.forgetAttendanceFlag(); mem.db.feature_flags = [];
    const c = await call('POST', '/api/staff/clock', T.posCashier, { pin: '4321', type: 'in', staff_id: cook.id, branch_id: BR });
    assert.equal(c.status, 401, 'no users row to clock');
    const s = await call('POST', '/api/auth/pos-login', undefined, { email: 'Mama Njeri', pin: '4321', branch_id: BR });
    assert.ok(s.status >= 400, `pos-login ${s.status}`);
  });
  await ok('the person is queued onto the branch\'s device (write_user, number + name) — never another branch\'s', async () => {
    const a = mem.db.attendance_device_actions;
    assert.equal(a.length, 1); assert.equal(a[0].device_id, DEV); assert.equal(a[0].action, 'write_user');
    assert.equal(a[0].attendance_no, 1); assert.equal(a[0].name, 'Mama Njeri');
  });

  console.log('\nI. ingest from the branch server\n');
  await ok('refused: a person\'s session, an ordinary POS, another business\'s server for this device', async () => {
    reset(true);
    assert.equal((await call('GET', '/api/attendance/node/config', T.owner)).status, 403);
    assert.equal((await call('GET', '/api/attendance/node/config', T.till)).status, 403);
    const x = await call('POST', '/api/attendance/node/punches', T.serverX, { device_id: DEV, punches: [] });
    assert.equal(x.status, 404); assert.equal(x.body.code, 'DEVICE_NOT_FOUND');
    const other = await call('POST', '/api/attendance/node/punches', T.server, { device_id: DEV2, punches: [] });
    assert.equal(other.status, 404, 'another branch\'s device');
  });
  await ok('config: its own branch\'s devices (with the comm key), people and pending actions', async () => {
    mem.db.attendance_people.push({ id: 'p-mgr', business_id: B, branch_id: BR, user_id: MGR, name: 'Akinyi', attendance_no: 3, active: true },
      { id: 'p-cbd', business_id: B, branch_id: BR2, user_id: null, name: 'Guard', attendance_no: 4, active: true });
    const r = await call('GET', '/api/attendance/node/config', T.server);
    assert.equal(r.status, 200, r.text.slice(0, 200));
    assert.equal(r.body.branch_id, BR); assert.deepEqual(r.body.devices.map((d) => d.id), [DEV]);
    assert.equal(r.body.devices[0].comm_key, 0); assert.equal(r.body.utc_offset_minutes, 180);
    assert.deepEqual(r.body.people.map((p) => p.attendance_no), [3]);
  });
  await ok('punches before the device\'s serial is known: 409; the state report stores it, the users snapshot and queues the writes', async () => {
    const p = await call('POST', '/api/attendance/node/punches', T.server, { device_id: DEV, punches: [{ device_user_id: '3', at: ago(3600_000) }] });
    assert.equal(p.status, 409); assert.equal(p.body.code, 'DEVICE_SERIAL_UNKNOWN');
    const s = await call('POST', `/api/attendance/node/devices/${DEV}/state`, T.server, { serial: 'K90-0001', model: 'K90 Pro', firmware: 'Ver 6.60', clock_drift_s: -42,
      users: [{ device_user_id: '12', name: 'John', privilege: 0 }, { device_user_id: '1', name: 'Admin', privilege: 14 }] });
    assert.equal(s.status, 200, s.text.slice(0, 200));
    const dev = mem.db.attendance_devices.find((d) => d.id === DEV);
    assert.equal(dev.serial, 'K90-0001'); assert.equal(dev.model, 'K90 Pro'); assert.equal(dev.clock_drift_s, -42);
    assert.equal(mem.db.attendance_device_users.length, 2);
    assert.equal(s.body.queued, 1, 'Akinyi (3) is not on the device → a write');
    const again = await call('POST', `/api/attendance/node/devices/${DEV}/state`, T.server, { users: [{ device_user_id: '12', name: 'John', privilege: 0 }, { device_user_id: '1', name: 'Admin', privilege: 14 }] });
    assert.equal(again.body.queued, 0, 'an action already pending is not queued twice');
    const twin = await call('POST', `/api/attendance/node/devices/${DEV}/state`, T.server, { serial: 'CBD123' });
    assert.equal(twin.status, 409, 'a serial another device has');
  });
  await ok('idempotent: a batch sent twice is stored once (the second all duplicates); a bad punch refused, the rest kept', async () => {
    // the branch server runs Akinyi's write and acknowledges it before it sends punches (as attendanceSync does)
    const w = mem.db.attendance_device_actions.find((x) => x.device_id === DEV && x.attendance_no === 3 && x.action === 'write_user' && x.status === 'pending');
    w.created_at = '2026-10-19T00:00:00.000Z';
    assert.equal((await call('POST', `/api/attendance/node/actions/${w.id}/ack`, T.server, { ok: true })).body.status, 'done');
    const punches = [{ device_user_id: '3', at: at('2026-10-20T08:00:00+03:00'), status: 1, punch: 0 }, { device_user_id: '3', at: at('2026-10-20T17:00:00+03:00'), status: 1, punch: 1 },
      { device_user_id: '12', at: at('2026-10-20T07:55:00+03:00') }, { device_user_id: '12', at: at('2026-10-20T16:10:00+03:00') },
      { device_user_id: '3', at: at('2026-10-20T08:00:00+03:00') }, { device_user_id: 'bad id', at: ago(1000) }];
    const r1 = await call('POST', '/api/attendance/node/punches', T.server, { device_id: DEV, punches });
    assert.equal(r1.status, 200, r1.text.slice(0, 200));
    assert.equal(r1.body.accepted, 4); assert.equal(r1.body.unmatched, 2); assert.deepEqual(r1.body.refused.map((x) => x.index), [5]);
    const r2 = await call('POST', '/api/attendance/node/punches', T.server, { device_id: DEV, punches });
    assert.equal(r2.body.accepted, 0); assert.equal(r2.body.duplicates, 5);
    const ev = mem.db.clock_events;
    assert.equal(ev.length, 4);
    const mine = ev.filter((e) => e.attendance_no === 3);
    assert.ok(mine.every((e) => e.person_id === 'p-mgr' && e.staff_id === MGR && e.source === 'device' && e.device_serial === 'K90-0001' && e.event_type === 'punch'));
    assert.equal(ev.find((e) => e.attendance_no === 3 && e.raw_punch === 1)?.raw_status, 1);
    assert.ok(mem.db.attendance_devices.find((d) => d.id === DEV).last_pull_at);
  });
  await ok('an action acknowledged: done; a failure retried, failed after 5 tries', async () => {
    mem.db.attendance_device_actions.push({ id: 'eeeeeeee-0000-4000-8000-000000000002', business_id: B, branch_id: BR, device_id: DEV, action: 'delete_user', attendance_no: 8, status: 'pending', attempts: 0 });
    const b2 = null;
    assert.equal((await call('POST', `/api/attendance/node/actions/eeeeeeee-0000-4000-8000-000000000002/ack`, T.server, { ok: true })).body.status, 'done');
    mem.db.attendance_device_actions.push({ id: 'eeeeeeee-0000-4000-8000-000000000001', business_id: B, branch_id: BR, device_id: DEV, action: 'write_user', attendance_no: 9, status: 'pending', attempts: 0 });
    let st;
    for (let i = 0; i < 5; i++) st = (await call('POST', '/api/attendance/node/actions/eeeeeeee-0000-4000-8000-000000000001/ack', T.server, { ok: false, error: 'TIMEOUT' })).body.status;
    assert.equal(st, 'failed');
    assert.equal((await call('POST', '/api/attendance/node/actions/eeeeeeee-0000-4000-8000-000000000001/ack', T.serverX, { ok: true })).status, 404, 'another business');
    void b2;
  });

  console.log('\nU. "Not matched" and "New on the device" → link\n');
  await ok('the device user 12 (John) is "New on the device" and its punches "Not matched"', async () => {
    const n = await call('GET', '/api/attendance/device-users', T.owner);
    assert.equal(n.status, 200, n.text.slice(0, 200));
    assert.deepEqual(n.body.new_on_device.map((u) => [u.device_user_id, u.name, u.admin]).sort(), [['1', 'Admin', true], ['12', 'John', false]]);
    const u = await call('GET', '/api/attendance/unmatched', T.owner);
    assert.deepEqual(u.body.unmatched.map((g) => [g.device_user_id, g.punches, g.name_on_device]), [['12', 2, 'John']]);
  });
  await ok('linked to a member of staff (Brian): the number is his, every punch under it assigned to him retroactively', async () => {
    const r = await call('POST', '/api/attendance/unmatched/link', T.manager, { device_user_id: '12', user_id: CASH });
    assert.equal(r.status, 200, r.text.slice(0, 200));
    assert.equal(r.body.assigned, 2); assert.equal(r.body.person.attendance_no, 12); assert.equal(r.body.person.user_id, CASH);
    assert.ok(mem.db.clock_events.filter((e) => e.attendance_no === 12).every((e) => e.person_id === r.body.person.id && e.staff_id === CASH));
    assert.equal((await call('GET', '/api/attendance/unmatched', T.owner)).body.unmatched.length, 0);
    const again = await call('POST', '/api/attendance/device-users/link', T.owner, { device_user_id: '12', name: 'Someone' });
    assert.equal(again.status, 409, 'a number already someone\'s');
  });
  await ok('the report: both people\'s hours on the 20th (Akinyi 9 h, Brian 8 h 15 min)', async () => {
    const r = await call('GET', '/api/attendance/report?from=2026-10-19&to=2026-10-25', T.owner);
    assert.equal(r.status, 200, r.text.slice(0, 200));
    const by = Object.fromEntries(r.body.people.map((p) => [p.name, p]));
    assert.equal(by.Akinyi.totals.hours, 9); assert.equal(by.Brian.totals.hours, 8.25);
    assert.equal(by.Akinyi.daily['2026-10-20'], 9);
    assert.equal(r.body.dates.length, 7); assert.equal(r.body.team.hours, 17.25);
    assert.ok(by['Mama Njeri'] === undefined || by['Mama Njeri'].totals.hours === 0);
  });

  console.log('\nK. corrections\n');
  await ok('a reason is required (add, move, remove)', async () => {
    const e = mem.db.clock_events.find((x) => x.attendance_no === 3 && x.raw_punch === 1);
    assert.equal((await call('POST', '/api/attendance/punches', T.manager, { person_id: 'p-mgr', at: at('2026-10-21T08:00:00+03:00') })).body.code, 'REASON_REQUIRED');
    assert.equal((await call('POST', `/api/attendance/punches/${e.id}/move`, T.manager, { at: at('2026-10-20T18:00:00+03:00'), reason: '' })).body.code, 'REASON_REQUIRED');
    assert.equal((await call('POST', `/api/attendance/punches/${e.id}/remove`, T.manager, {})).body.code, 'REASON_REQUIRED');
  });
  await ok('move: the original kept (voided, who / when / why), a correction at the new time naming it; the report shows the change', async () => {
    const e = mem.db.clock_events.find((x) => x.attendance_no === 3 && x.raw_punch === 1);
    const r = await call('POST', `/api/attendance/punches/${e.id}/move`, T.manager, { at: at('2026-10-20T18:00:00+03:00'), reason: 'Stayed for stock count, forgot to punch' });
    assert.equal(r.status, 200, r.text.slice(0, 200));
    const orig = mem.db.clock_events.find((x) => x.id === e.id);
    assert.ok(orig.voided_at); assert.equal(orig.voided_by, MGR); assert.match(orig.void_reason, /stock count/);
    assert.equal(orig.recorded_at, at('2026-10-20T17:00:00+03:00'), 'the original time kept');
    const corr = mem.db.clock_events.find((x) => x.corrects_id === e.id);
    assert.equal(corr.source, 'correction'); assert.equal(corr.recorded_at, at('2026-10-20T18:00:00+03:00')); assert.equal(corr.created_by, MGR);
    assert.equal((await call('POST', `/api/attendance/punches/${e.id}/move`, T.manager, { at: at('2026-10-20T19:00:00+03:00'), reason: 'again please' })).status, 409, 'a voided punch is not moved again');
    const rep = await call('GET', '/api/attendance/report?from=2026-10-19&to=2026-10-25&person=p-mgr', T.manager);
    const me = rep.body.people.find((p) => p.person_id === 'p-mgr');
    assert.equal(me.totals.hours, 10); assert.equal(me.totals.corrections, 1);
    const c = me.days.find((d) => d.date === '2026-10-20').corrections[0];
    assert.equal(c.kind, 'moved'); assert.equal(c.was, at('2026-10-20T17:00:00+03:00')); assert.equal(c.byName, 'Akinyi'); assert.match(c.reason, /stock count/);
  });
  await ok('add a missed punch for staff with a reason; remove keeps the row (voided)', async () => {
    const add = await call('POST', '/api/attendance/punches', T.manager, { user_id: CASH, at: at('2026-10-21T08:00:00+03:00'), reason: 'Device was off' });
    assert.equal(add.status, 201, add.text.slice(0, 200));
    const rm = await call('POST', `/api/attendance/punches/${add.body.id}/remove`, T.manager, { reason: 'Was on leave after all' });
    assert.equal(rm.status, 200);
    const row = mem.db.clock_events.find((x) => x.id === add.body.id);
    assert.ok(row && row.voided_at && row.void_reason === 'Was on leave after all', 'kept, voided');
  });

  console.log('\nP. permissions\n');
  await ok('the catalogue: three keys in the Staff group; Manager view + edit, GM view + edit (not devices), owner all, cashier / waiter none', async () => {
    const keys = ['attendance.view', 'attendance.edit', 'attendance.devices'];
    for (const k of keys) assert.ok(CAT.PERMISSION_KEYS.includes(k), k);
    assert.equal(CAT.PERMISSIONS.find((p) => p.key === 'attendance.view').personal, true);
    const has = (role) => keys.filter((k) => CAT.defaultKeysForRoleName(role).includes(k));
    assert.deepEqual(has('Owner'), keys);
    assert.deepEqual(has('Manager'), ['attendance.view', 'attendance.edit']);
    assert.deepEqual(has('General Manager'), ['attendance.view', 'attendance.edit']);
    for (const r of ['Cashier', 'Waiter', 'Supervisor', 'Kitchen', 'Storekeeper', 'Fuel attendant', 'Auditor']) assert.deepEqual(has(r), [], r);
    const sql = fs.readFileSync(path.join(ROOT, 'migrations/180_attendance.sql'), 'utf8');
    for (const k of keys) {
      const p = CAT.PERMISSIONS.find((x) => x.key === k);
      assert.ok(sql.includes(`('${p.key}', '${p.label}', '${p.group}', '${p.description}')`), `180 registers ${k} with the catalogue's words`);
    }
  });
  await ok('the gate: a manager sees and corrects but not the devices; a cashier nothing; a partner all three whatever their role', async () => {
    assert.equal((await call('GET', '/api/attendance/devices', T.manager)).status, 403);
    assert.equal((await call('POST', '/api/attendance/people', T.manager, { name: 'Guard', branch_id: BR })).status, 403);
    assert.equal((await call('GET', '/api/attendance/access', T.manager)).body.devices, false);
    for (const p of ['/api/attendance/access', '/api/attendance/report?from=2026-10-19&to=2026-10-25']) assert.equal((await call('GET', p, T.cashier)).status, 403, p);
    assert.equal((await call('GET', '/api/attendance/devices', T.partner)).status, 200);
    const acc = await call('GET', '/api/attendance/access', T.partner);
    assert.deepEqual([acc.body.view, acc.body.edit, acc.body.devices], [true, true, true]);
    const devs = await call('GET', '/api/attendance/devices', T.owner);
    assert.ok(devs.body.devices.every((d) => !('comm_key' in d) && 'comm_key_set' in d), 'the comm key never reaches the web');
  });
  await ok('a manager sees their own branch only (the CBD guard not in their report)', async () => {
    mem.db.clock_events.push({ id: 'cbd-1', business_id: B, branch_id: BR2, person_id: 'p-cbd', staff_id: null, source: 'device', event_type: 'punch', recorded_at: at('2026-10-22T06:00:00+03:00'), created_at: ago(1) },
      { id: 'cbd-2', business_id: B, branch_id: BR2, person_id: 'p-cbd', staff_id: null, source: 'device', event_type: 'punch', recorded_at: at('2026-10-22T18:00:00+03:00'), created_at: ago(1) });
    const m = await call('GET', '/api/attendance/report?from=2026-10-19&to=2026-10-25', T.manager);
    assert.ok(!m.body.people.some((p) => p.name === 'Guard'));
    const o = await call('GET', `/api/attendance/report?from=2026-10-19&to=2026-10-25&branch_id=${BR2}`, T.owner);
    assert.deepEqual(o.body.people.map((p) => p.name), ['Guard']); assert.equal(o.body.people[0].totals.hours, 12);
    assert.equal(o.body.people[0].attendance_only, true);
  });

  console.log('\n$. pay\n');
  await ok('no pay field at all without staff.pay (a manager); the owner and a holder of staff.pay get hours × rate', async () => {
    const m = await call('GET', '/api/attendance/report?from=2026-10-19&to=2026-10-25', T.manager);
    assert.equal(m.body.payVisible, false);
    assert.ok(m.body.people.every((p) => !('pay' in p) && !('hourly_rate' in p)), 'masked');
    assert.ok(!('pay' in m.body.team));
    const o = await call('GET', '/api/attendance/report?from=2026-10-19&to=2026-10-25', T.owner);
    const brian = o.body.people.find((p) => p.name === 'Brian');
    assert.equal(o.body.payVisible, true); assert.equal(brian.pay, 8.25 * 150); assert.equal(brian.hourly_rate, 150);
    const mp = await call('GET', '/api/attendance/report?from=2026-10-19&to=2026-10-25', T.managerPay);
    assert.equal(mp.body.payVisible, true); assert.equal(mp.body.people.find((p) => p.name === 'Akinyi').pay, 10 * 200);
    assert.equal(o.body.people.find((p) => p.name === 'Guard')?.pay ?? null, null, 'no rate → no estimate');
  });

  console.log('\nS. staff changes follow onto the devices\n');
  await ok('a member of staff deactivated → delete_user queued for their number; a new member gets the next free number', async () => {
    const before = mem.db.attendance_device_actions.length;
    const d = await call('DELETE', `/api/staff/${CASH}`, T.owner);
    assert.equal(d.status, 200, d.text.slice(0, 200));
    const brian = mem.db.attendance_people.find((p) => p.user_id === CASH);
    assert.equal(brian.active, false);
    const del = mem.db.attendance_device_actions.slice(before).find((a) => a.action === 'delete_user');
    assert.equal(del?.attendance_no, 12);
    await ST.attendanceStaffChanged(B, { id: FIN, name: 'Faith', status: 'active', branch_id: BR }, OWNER);
    assert.equal(mem.db.attendance_people.find((p) => p.user_id === FIN)?.attendance_no, 2, '3, 4, 12 given and 1 on the device (its admin) → 2, never a number the device already has');
  });
  await ok('the real-device case over HTTP: a stranger on the device under a person\'s number — not written, punches "Not matched", listed as a clash; the person given the number they really have claims it', async () => {
    // Faith (2) was given her number before the device reported: the device's 2 is someone else
    const s1 = await call('POST', `/api/attendance/node/devices/${DEV}/state`, T.server, { users: [{ device_user_id: '1', name: 'Admin', privilege: 14 }, { device_user_id: '2', name: 'PETER O', privilege: 0 }, { device_user_id: '40', name: 'Faith', privilege: 0 }] });
    assert.equal(s1.status, 200, s1.text.slice(0, 200));
    assert.ok(s1.body.clashes >= 1, 'a clash reported');
    const faith = mem.db.attendance_people.find((p) => p.user_id === FIN);
    assert.equal(mem.db.attendance_device_actions.filter((a) => a.device_id === DEV && a.attendance_no === 2 && a.action === 'write_user' && a.status === 'pending').length, 0, 'never written over PETER O');
    const p1 = await call('POST', '/api/attendance/node/punches', T.server, { device_id: DEV, punches: [{ device_user_id: '2', at: at('2026-10-22T08:00:00+03:00') }] });
    assert.equal(p1.body.unmatched, 1, "PETER O's punch is not Faith's");
    const du = await call('GET', '/api/attendance/device-users', T.owner);
    assert.deepEqual(du.body.clashes.map((c) => [c.device_user_id, c.name_on_device, c.person_name]), [['2', 'PETER O', 'Faith']]);
    // the manager gives Faith the number she really has on the device (40): it is claimed, her punches there are hers
    const r = await call('PATCH', `/api/attendance/people/${faith.id}`, T.owner, { attendance_no: 40 });
    assert.equal(r.status, 200, r.text.slice(0, 200));
    assert.ok(mem.db.attendance_device_actions.some((a) => a.device_id === DEV && a.attendance_no === 40 && a.action === 'write_user' && a.person_id === faith.id && a.status === 'pending'), 'the slot claimed');
    assert.equal(mem.db.attendance_device_actions.filter((a) => a.device_id === DEV && a.attendance_no === 2 && a.action === 'delete_user' && a.status === 'pending').length, 0, 'PETER O (2) never deleted');
    const p2 = await call('POST', '/api/attendance/node/punches', T.server, { device_id: DEV, punches: [{ device_user_id: '40', at: at('2026-10-22T08:05:00+03:00') }] });
    assert.equal(p2.body.unmatched, 0, "Faith's punch on 40 is hers");
    assert.deepEqual((await call('GET', '/api/attendance/device-users', T.owner)).body.clashes, []);
  });

  console.log('\nD. the dashboard helpers\n');
  await ok('heat colours: a day off grey, then the ramp by hours; the month grid Monday-first with every date once', async () => {
    const p = AV.attendancePalette('light');
    assert.equal(AV.heatColour(0, p), p.off); assert.equal(AV.heatColour(3, p), p.ramp[0]); assert.equal(AV.heatColour(8.5, p), p.ramp[3]); assert.equal(AV.heatColour(11, p), p.ramp[4]);
    assert.notEqual(AV.attendancePalette('dark').off, p.off);
    assert.equal(AV.attendancePalette('light', '#123456').accent, '#123456', 'the brand accent when the shop has one');
    const dates = []; for (let d = 1; d <= 31; d++) dates.push(`2026-10-${String(d).padStart(2, '0')}`);
    const g = AV.monthGrid(dates);
    assert.equal(g[0][3], '2026-10-01', '1 Oct 2026 is a Thursday'); assert.equal(g.flat().filter(Boolean).length, 31);
    assert.ok(g.every((w) => w.length === 7));
    assert.equal(AV.hoursWords(7.5), '7 h 30 min'); assert.equal(AV.clockEAT('2026-10-20T05:00:00.000Z'), '08:00');
  });
  await ok('the presets: This week · Last week · This month · Last month — on the 1st of a month only the one clicked lights', async () => {
    const now = new Date(2026, 9, 1, 12);   // Thu 1 Oct
    const ps = AV.attendancePresets(now);
    assert.deepEqual(ps.map((p) => p.label), ['This week', 'Last week', 'This month', 'Last month']);
    const tm = ps.find((p) => p.label === 'This month');
    assert.equal(AV.activePreset(ps, { from: tm.from, to: tm.to }, 'This month'), 'This month');
  });
  await ok('the Excel sheets: Summary and Hours by day; pay columns only when the cloud sent pay', async () => {
    const report = { from: '2026-10-19', to: '2026-10-20', dates: ['2026-10-19', '2026-10-20'], payVisible: false, team: { hours: 8 },
      people: [{ name: 'A', attendance_no: 1, branch_name: 'W', totals: { hours: 8, daysWorked: 1, avgHours: 8, missedOuts: 0, corrections: 0 }, daily: { '2026-10-20': 8 } }] };
    const s = AV.attendanceSheets(report);
    assert.deepEqual(s.map((x) => x.name), ['Summary', 'Hours by day']);
    assert.ok(!s[0].columns.some((c) => c.key === 'pay'));
    assert.ok(AV.attendanceSheets({ ...report, payVisible: true })[0].columns.some((c) => c.key === 'pay'));
    assert.equal(s[1].rows[0]['2026-10-19'], 0);
  });
} finally {
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
