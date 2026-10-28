// A599 — the branch server's attendance job: ZKTeco devices → the cloud.
// Owner, 2026-10-27/28: attendance is premium (the 'attendance' flag); punches only from the device, pulled by the branch
// server; fingerprints never leave the device; a device admin is never written or deleted from here.
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/attendance-device-a599.test.mjs
//
// RUNS the real compiled dist/main/attendanceSync.js (and through it dist/main/zkteco.js) over real TCP against
// test/zkteco-sim.mjs (in-process fake K90 Pro devices), with a fake cloud that answers the four /api/attendance/node/*
// routes as apps/server/src/routes/attendance.ts does (409 DEVICE_SERIAL_UNKNOWN until the serial is reported, ≤ 500
// punches a call — 413 above, idempotent on device serial + device user + time, acks) and an in-memory key/value store.
//
//   G  the gate: the flag off, not the branch server, or the cloud unreachable — NO cloud call and NO device connection.
//   U  punches made UTC with the config's utc_offset_minutes (+180, Kenya; +330 tried too); 1,234 punches → 500 + 500 + 234.
//   H  the high-water mark: a second run sends nothing (and does not even read the punch log); 3 new punches → exactly 3;
//      a restart (a new job, the same store) sends nothing again; a log cleared on the device → sent again from the start.
//   A  actions: write a user (number + name, a normal user) and delete one — done on the device and acked ok; a write
//      onto a device admin's number is refused and acked with an error, the admin untouched.
//   O  a device that does not answer: state { error } posted, its actions NOT acked, and the next device is done.
//   S  409 on punches (the cloud has no serial yet): state again, then the batch again; 409 on state (serial changed): no
//      punches sent for that device.
//   T  Test connection (serial + clock drift) and Set device time (the PC's clock at the business's local time).
//
// MUTATIONS TO CONFIRM BITE (each made in dist/main/attendanceSync.js, seen to fail, restored — 2026-10-28):
//   - gate() without the flag check                                → G "flag off: no cloud call" fails
//   - wallToDate(p.wall, offset) → wallToDate(p.wall, 0) in sendPunches → U "08:00 at +180 is 05:00Z" fails
//   - PUNCH_BATCH = 600                                             → U "every call ≤ 500" fails
//   - sendPunches always from 0 (the mark ignored)                  → H "three new punches → exactly those three" fails
//     (the second run alone does not catch it: an unchanged count skips the punch read before the mark is needed)
//   - no state retry on 409 DEVICE_SERIAL_UNKNOWN                  → S "409 → state → punches again" fails
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startSim, simEncodeTime } from './zkteco-sim.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const A = require(path.join(here, '..', 'dist', 'main', 'attendanceSync.js'));

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${String(d).slice(0, 800)}`); fail++; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const stop = (what) => (e) => { console.log(`  FAIL ${what}:`, e); console.log(`\n${pass} passed, ${fail + 1} failed\n`); process.exit(1); };
process.on('unhandledRejection', stop('unhandled rejection'));
process.on('uncaughtException', stop('uncaught exception'));

const USERS = [
  { uid: 1, userId: '1', name: 'Boss', privilege: 14, password: '9999' },
  { uid: 2, userId: '1002', name: 'Jane Wanjiku' },
  { uid: 3, userId: '1003', name: 'Otieno' },
];
const DEV1 = 'dddddddd-0000-4000-8000-000000000001';
const DEV2 = 'dddddddd-0000-4000-8000-000000000002';

// ── the fake cloud (routes/attendance.ts /node/*, the parts the branch server sees) ──────────────────────────────────
function fakeCloud(o) {
  const c = {
    offset: o.offset ?? 180, devices: o.devices, actions: o.actions ?? [], calls: [], stored: new Map(), acks: [], states: [],
    failStateOnce: new Set(o.failStateOnce ?? []), serialFixed: new Map(o.serialFixed ?? []), off: false,
  };
  const ans = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  c.get = async (p) => {
    c.calls.push(['GET', p]);
    if (c.off) return ans(403, { code: 'ATTENDANCE_OFF', error: 'off' });
    if (p !== '/api/attendance/node/config') return ans(404, {});
    return ans(200, { branch_id: 'br-1', utc_offset_minutes: c.offset,
      devices: c.devices.map((d) => ({ id: d.id, name: d.name, ip: '127.0.0.1', port: d.port, comm_key: 0, serial: d.serial ?? null })),
      people: [], actions: c.actions.filter((a) => a.status === 'pending').map(({ status, ...a }) => a) });
  };
  c.post = async (p, body) => {
    c.calls.push(['POST', p, body]);
    let m = p.match(/^\/api\/attendance\/node\/devices\/([^/]+)\/state$/);
    if (m) {
      const d = c.devices.find((x) => x.id === m[1]);
      if (!d) return ans(404, { code: 'DEVICE_NOT_FOUND' });
      c.states.push({ id: d.id, body });
      if (c.failStateOnce.has(d.id)) { c.failStateOnce.delete(d.id); return ans(503, { code: 'ATTENDANCE_BUSY', error: 'busy' }); }
      if (body.serial) {
        const fixed = c.serialFixed.get(d.id);
        if (fixed && fixed !== body.serial) return ans(409, { code: 'SERIAL_CHANGED', error: 'This is a different device from the one set up here - set it up again on the web.' });
        d.serial = body.serial;
      }
      return ans(200, { ok: true, queued: 0 });
    }
    if (p === '/api/attendance/node/punches') {
      const d = c.devices.find((x) => x.id === body.device_id);
      if (!d) return ans(404, { code: 'DEVICE_NOT_FOUND' });
      if (!d.serial) return ans(409, { code: 'DEVICE_SERIAL_UNKNOWN', error: 'Report the device\'s state (its serial number) before its punches.' });
      if (!Array.isArray(body.punches)) return ans(400, { code: 'BAD_PUNCHES' });
      if (body.punches.length > 500) return ans(413, { code: 'TOO_MANY_PUNCHES', error: 'At most 500 punches a call.' });
      let accepted = 0;
      for (const x of body.punches) {
        const k = `${d.serial}|${x.device_user_id}|${new Date(x.at).toISOString()}`;
        if (!c.stored.has(k)) { c.stored.set(k, x); accepted++; }
      }
      return ans(200, { accepted, duplicates: body.punches.length - accepted, unmatched: 0, refused: [] });
    }
    m = p.match(/^\/api\/attendance\/node\/actions\/([^/]+)\/ack$/);
    if (m) {
      const a = c.actions.find((x) => x.id === m[1]);
      if (!a) return ans(404, { code: 'ACTION_NOT_FOUND' });
      c.acks.push({ id: a.id, ...body });
      if (body.ok === true) a.status = 'done';
      return ans(200, { ok: true, status: a.status });
    }
    return ans(404, {});
  };
  c.count = (method, re) => c.calls.filter((x) => x[0] === method && re.test(x[1])).length;
  c.punchCalls = () => c.calls.filter((x) => x[0] === 'POST' && x[1] === '/api/attendance/node/punches');
  return c;
}

function deps(cloud, o = {}) {
  const kv = o.kv ?? new Map();
  return {
    kv,
    isServer: () => o.server ?? true,
    flagOn: () => o.flag ?? true,
    cloudReachable: () => o.reachable ?? true,
    cloudGet: (p) => cloud.get(p),
    cloudPost: (p, b) => cloud.post(p, b),
    kvGet: (k) => kv.get(k) ?? null,
    kvSet: (k, v) => { kv.set(k, v); },
    log: (line) => { if (process.env.ATT_VERBOSE) console.log('    log:', line); },
    zkTimeoutMs: o.zkTimeoutMs ?? 2000,
    deviceBudgetMs: o.deviceBudgetMs ?? 20_000,
  };
}

/** n punches from a local wall-clock start, every `stepS` seconds (crosses midnight), alternating the two staff. */
function punchesFrom(n, start, stepS) {
  const out = [];
  let t = Date.UTC(start[0], start[1] - 1, start[2], start[3], start[4], start[5]);   // month 1-12
  for (let i = 0; i < n; i++, t += stepS * 1000) {
    const d = new Date(t);
    const u = USERS[1 + (i % 2)];
    out.push({ uid: u.uid, userId: u.userId, t: [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()], status: 1, punch: i % 2 });
  }
  return out;
}
const isoLocalToUtc = (t, offsetMin) => new Date(Date.UTC(t[0], t[1] - 1, t[2], t[3], t[4], t[5]) - offsetMin * 60_000).toISOString();

// ── G: the gate ──────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\nG  the gate: nothing at all unless branch server + flag on + cloud reachable\n');
{
  const sim = await startSim({ users: USERS, punches: punchesFrom(5, [2026, 9, 1, 8, 0, 0], 600) });
  for (const [label, o, want] of [
    ['flag off', { flag: false }, 'flag_off'],
    ['not the branch server', { server: false }, 'not_server'],
    ['cloud unreachable', { reachable: false }, 'offline'],
  ]) {
    const cloud = fakeCloud({ devices: [{ id: DEV1, name: 'Front door', port: sim.port }] });
    const d = deps(cloud, o);
    const job = new A.AttendanceJob(d);
    const r = await job.runOnce();
    ok(`${label}: nothing runs (skipped ${want})`, r.ran === false && r.skipped === want, JSON.stringify(r));
    ok(`${label}: no cloud call at all`, cloud.calls.length === 0, JSON.stringify(cloud.calls));
    ok(`${label}: no device connection`, sim.state.log.length === 0, sim.state.log.length);
    ok(`${label}: nothing stored`, d.kv.size === 0);
    if (want !== 'offline') {
      ok(`${label}: the Tech page section is hidden`, job.visible() === false);
      const t = await job.testDevice(DEV1);
      ok(`${label}: Test connection refused without a call`, t.ok === false && cloud.calls.length === 0 && sim.state.log.length === 0, JSON.stringify(t));
      const s = await job.setDeviceTime(DEV1);
      ok(`${label}: Set device time refused without a call`, s.ok === false && cloud.calls.length === 0 && sim.state.log.length === 0);
    }
  }
  const cloud = fakeCloud({ devices: [] });
  ok('flag on + branch server: the Tech page section shows', new A.AttendanceJob(deps(cloud)).visible() === true);
  const offCloud = fakeCloud({ devices: [{ id: DEV1, name: 'Front door', port: sim.port }] });
  offCloud.off = true;
  const job = new A.AttendanceJob(deps(offCloud));
  const r = await job.runOnce();
  ok('the cloud says ATTENDANCE_OFF: no device touched, asked again later', r.ran === false && r.skipped === 'cloud_off' && sim.state.log.length === 0 && !!job.status().waitUntil);
  ok('…and the beat waits (not due)', job.due() === false);
  await sim.close();
}

// ── U + H: UTC, batches, the high-water mark ─────────────────────────────────────────────────────────────────────────
console.log('\nU  punches made UTC and sent ≤ 500 a call · H  the high-water mark\n');
{
  // 1,234 punches from 2026-09-30 20:00 local, every 7 min 3 s — crosses midnight and the month end
  const P = punchesFrom(1234, [2026, 9, 30, 20, 0, 0], 7 * 60 + 3);
  P.splice(0, 1, { uid: 2, userId: '1002', t: [2026, 10, 1, 8, 0, 0], status: 1, punch: 0 });
  P.splice(1, 1, { uid: 3, userId: '1003', t: [2026, 10, 2, 1, 30, 0], status: 1, punch: 0 });
  const sim = await startSim({ users: USERS, punches: P, frameSize: 900 });
  const cloud = fakeCloud({ devices: [{ id: DEV1, name: 'Front door', port: sim.port }] });
  const d = deps(cloud);
  const job = new A.AttendanceJob(d);
  const r = await job.runOnce('test');
  ok('the run completes, the device ok', r.ran && r.devices.length === 1 && r.devices[0].ok, JSON.stringify(r));
  const calls = cloud.punchCalls();
  const sizes = calls.map((x) => x[2].punches.length);
  ok('1,234 punches in three calls: 500 + 500 + 234', JSON.stringify(sizes) === '[500,500,234]', JSON.stringify(sizes));
  ok('every call ≤ 500 (the cloud\'s limit — no 413)', sizes.every((n) => n <= 500));
  ok('all 1,234 stored, none twice', cloud.stored.size === 1234 && r.devices[0].sent === 1234, `${cloud.stored.size} / ${r.devices[0].sent}`);
  const first = calls[0][2].punches[0], second = calls[0][2].punches[1];
  ok('08:00 at +180 is 05:00Z', first.at === '2026-10-01T05:00:00.000Z' && first.device_user_id === '1002', JSON.stringify(first));
  ok('01:30 at +180 is 22:30Z the day before', second.at === '2026-10-01T22:30:00.000Z', second.at);
  let allRight = true;
  const sent = calls.flatMap((x) => x[2].punches);
  P.forEach((p, i) => { if (sent[i].at !== isoLocalToUtc(p.t, 180) || sent[i].device_user_id !== p.userId) allRight = false; });
  ok('every one of the 1,234 at exactly local − 3 h, in the device\'s order', allRight);
  ok('status, punch and uid passed through', first.status === 1 && first.punch === 0 && first.uid === 2, JSON.stringify(first));
  const st = cloud.states[0]?.body;
  ok('state first: serial, model, firmware, drift, users (the admin flagged by privilege)', st && st.serial === 'K90P-SIM-0001' && st.model === 'K90 Pro'
    && /^Ver /.test(st.firmware) && Number.isInteger(st.clock_drift_s) && st.users.length === 3 && st.users.find((u) => u.device_user_id === '1').privilege === 14
    && st.error === null && st.punches_on_device === 1234, JSON.stringify(st)?.slice(0, 400));
  ok('state was sent before the first punches', cloud.calls.findIndex((x) => /\/state$/.test(x[1])) < cloud.calls.findIndex((x) => x[1] === '/api/attendance/node/punches'));
  ok('the device was enabled again after the reads', sim.state.disabled === 0);
  ok('the device\'s log is never cleared (still 1,234)', sim.state.punches.length === 1234);

  const before = cloud.punchCalls().length;
  const reads = sim.state.log.filter((x) => x[0] === 1503).length;
  const r2 = await job.runOnce('test');
  ok('H: a second run sends nothing (no punches call)', r2.devices[0].ok && r2.devices[0].sent === 0 && cloud.punchCalls().length === before, JSON.stringify(r2));
  ok('H: …and does not even read the punch log (the count did not move)', sim.state.log.filter((x) => x[0] === 1503).length - reads === 1, // only the users read
    sim.state.log.filter((x) => x[0] === 1503).length - reads);
  sim.state.punches.push(...punchesFrom(3, [2026, 10, 20, 9, 0, 0], 60));
  const r3 = await job.runOnce('test');
  const last = cloud.punchCalls().at(-1)[2].punches;
  ok('H: three new punches → exactly those three', r3.devices[0].sent === 3 && last.length === 3 && last[0].at === '2026-10-20T06:00:00.000Z', JSON.stringify(last));
  const job2 = new A.AttendanceJob(deps(cloud, { kv: d.kv }));
  const n = cloud.punchCalls().length;
  const r4 = await job2.runOnce('restart');
  ok('H: after a restart (a new job, the same store) nothing is sent again', r4.devices[0].sent === 0 && cloud.punchCalls().length === n);
  sim.state.punches = punchesFrom(2, [2026, 10, 21, 7, 0, 0], 60);
  const r5 = await job2.runOnce('cleared');
  ok('H: a log cleared on the device → the new log sent from the start', r5.devices[0].sent === 2 && cloud.stored.size === 1239, `${r5.devices[0].sent} / ${cloud.stored.size}`);
  await sim.close();

  // another offset (India, +330) — the offset is the cloud's, not a constant
  const sim2 = await startSim({ users: USERS, punches: [{ uid: 2, userId: '1002', t: [2026, 10, 1, 8, 0, 0] }] });
  const c2 = fakeCloud({ offset: 330, devices: [{ id: DEV1, name: 'Front door', port: sim2.port }] });
  await new A.AttendanceJob(deps(c2)).runOnce();
  ok('U: 08:00 at +330 is 02:30Z (the config\'s offset is used)', c2.punchCalls()[0]?.[2].punches[0].at === '2026-10-01T02:30:00.000Z', JSON.stringify(c2.punchCalls()[0]?.[2]));
  await sim2.close();
}

// ── A: actions ───────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\nA  write a user, delete a user, an admin refused\n');
{
  const sim = await startSim({ users: USERS });
  const cloud = fakeCloud({ devices: [{ id: DEV1, name: 'Front door', port: sim.port }], actions: [
    { id: 'act-w', device_id: DEV1, action: 'write_user', attendance_no: 1004, name: 'Achieng Odhiambo', status: 'pending' },
    { id: 'act-d', device_id: DEV1, action: 'delete_user', attendance_no: 1003, name: null, status: 'pending' },
    { id: 'act-admin', device_id: DEV1, action: 'write_user', attendance_no: 1, name: 'Not the boss', status: 'pending' },
    { id: 'act-other', device_id: DEV2, action: 'write_user', attendance_no: 1005, name: 'Elsewhere', status: 'pending' },
  ] });
  const r = await new A.AttendanceJob(deps(cloud)).runOnce();
  const u4 = sim.state.users.find((u) => u.userId === '1004');
  ok('write_user: 1004 Achieng Odhiambo on the device', !!u4 && u4.name === 'Achieng Odhiambo', JSON.stringify(sim.state.users));
  ok('…as a normal user (privilege 0)', u4?.privilege === 0);
  ok('…acked ok', cloud.acks.some((a) => a.id === 'act-w' && a.ok === true));
  ok('delete_user: 1003 gone from the device', !sim.state.users.some((u) => u.userId === '1003'));
  ok('…acked ok', cloud.acks.some((a) => a.id === 'act-d' && a.ok === true));
  const adm = cloud.acks.find((a) => a.id === 'act-admin');
  ok('a write onto the device admin\'s number: acked with an error', adm && adm.ok === false && /admin/i.test(adm.error ?? ''), JSON.stringify(adm));
  const boss = sim.state.users.find((u) => u.uid === 1);
  ok('…the admin untouched (name, privilege)', boss?.name === 'Boss' && boss?.privilege === 14, JSON.stringify(boss));
  ok('another device\'s action is not run or acked here', !cloud.acks.some((a) => a.id === 'act-other') && !sim.state.users.some((u) => u.userId === '1005'));
  ok('the run counts 2 done, 1 failed', r.devices[0].actionsDone === 2 && r.devices[0].actionsFailed === 1, JSON.stringify(r.devices[0]));
  ok('no fingerprint read or written (no template commands: 9 only as the users read via 1503, no 1503 with fct ≠ 5 except punches)',
    !sim.state.log.some((x) => x[0] === 9) && !sim.state.log.some((x) => x[0] === 61));
  const r2 = await new A.AttendanceJob(deps(cloud)).runOnce();
  ok('done actions are not run again (only the admin one, still pending, is tried)', cloud.acks.filter((a) => a.id === 'act-w').length === 1 && cloud.acks.filter((a) => a.id === 'act-admin').length === 2, JSON.stringify(cloud.acks));
  await sim.close();
}

// ── S: a device bought before ZapTill keeps its own people ──────────────────────────────────────────────────────────
// A real K40 (2026-10-28) held 138 people numbered from 1. An automatic write (overwrite false) never lands on someone
// else's number — their fingerprints would become our person's punches; a delete removes only the person it names.
console.log('\nS  someone else on the device: never overwritten, never deleted\n');
{
  const sim = await startSim({ users: USERS });
  const cloud = fakeCloud({ devices: [{ id: DEV1, name: 'Front door', port: sim.port }], actions: [
    { id: 's-strange', device_id: DEV1, action: 'write_user', attendance_no: 1002, name: 'Peter Kamau', overwrite: false, status: 'pending' },
    { id: 's-own', device_id: DEV1, action: 'write_user', attendance_no: 1003, name: 'Otieno Juma', overwrite: true, status: 'pending' },
    { id: 's-same', device_id: DEV1, action: 'write_user', attendance_no: 1002, name: 'Jane Wanjiku', overwrite: false, status: 'pending' },
    { id: 's-del-other', device_id: DEV1, action: 'delete_user', attendance_no: 1002, name: 'Peter Kamau', status: 'pending' },
  ] });
  await new A.AttendanceJob(deps(cloud)).runOnce();
  const jane = () => sim.state.users.find((u) => u.userId === '1002');
  const strange = cloud.acks.find((a) => a.id === 's-strange');
  ok('an automatic write onto someone else\'s number: refused, acked with an error naming them', strange?.ok === false && /someone else/.test(strange?.error ?? ''), JSON.stringify(strange));
  ok('…Jane Wanjiku still 1002 on the device', jane()?.name === 'Jane Wanjiku', JSON.stringify(jane()));
  ok('a write the cloud allows to overwrite (the manager chose it / already theirs): renamed', sim.state.users.find((u) => u.userId === '1003')?.name === 'Otieno Juma'
    && cloud.acks.some((a) => a.id === 's-own' && a.ok === true));
  ok('the same name: written (claims the slot), acked ok', cloud.acks.some((a) => a.id === 's-same' && a.ok === true));
  ok('a delete naming someone else: acked ok, Jane NOT deleted', cloud.acks.some((a) => a.id === 's-del-other' && a.ok === true) && !!jane());
  const c2 = fakeCloud({ devices: [{ id: DEV1, name: 'Front door', port: sim.port }], actions: [
    { id: 's-del-jane', device_id: DEV1, action: 'delete_user', attendance_no: 1002, name: 'Jane Wanjiku', status: 'pending' },
  ] });
  await new A.AttendanceJob(deps(c2)).runOnce();
  ok('a delete naming the person there: deleted', !jane() && c2.acks.some((a) => a.id === 's-del-jane' && a.ok === true));
  await sim.close();
}

// ── O: an offline device ─────────────────────────────────────────────────────────────────────────────────────────────
console.log('\nO  a device that does not answer: its error posted, the next device done\n');
{
  const dead = await startSim({ users: USERS, faults: { silentOn: new Set([1000]) } });
  const live = await startSim({ users: USERS, punches: punchesFrom(4, [2026, 10, 3, 8, 0, 0], 60), serial: 'K90P-SIM-0002' });
  const cloud = fakeCloud({ devices: [{ id: DEV1, name: 'Back door', port: dead.port }, { id: DEV2, name: 'Front door', port: live.port }], actions: [
    { id: 'act-dead', device_id: DEV1, action: 'write_user', attendance_no: 1009, name: 'Wanjiru', status: 'pending' },
  ] });
  const t0 = Date.now();
  const job = new A.AttendanceJob(deps(cloud, { zkTimeoutMs: 400 }));
  const r = await job.runOnce();
  const ms = Date.now() - t0;
  const e1 = cloud.states.find((s) => s.id === DEV1)?.body;
  ok('the silent device: state { error } posted, a short plain reason', e1 && typeof e1.error === 'string' && e1.error.length > 10 && e1.error.length <= 300 && !e1.serial, JSON.stringify(e1));
  ok('…the error names no comm key and says what to check', /No answer from the device/.test(e1?.error ?? ''), e1?.error);
  ok('…its action not acked (an unreachable device must not use up the tries)', !cloud.acks.some((a) => a.id === 'act-dead'));
  ok('the next device carried on: its 4 punches sent', r.devices.length === 2 && r.devices[0].ok === false && r.devices[1].ok === true && r.devices[1].sent === 4, JSON.stringify(r));
  ok('the silent device cost about its timeout, not the run (< 3 s)', ms < 3000, `${ms} ms`);
  const view = job.status().devices.find((x) => x.id === DEV1);
  ok('the Tech page shows the error and no contact', view?.lastError && view.lastContactAt === null, JSON.stringify(view));
  const refused = await startSim({});
  const port = refused.port; await refused.close();
  const c2 = fakeCloud({ devices: [{ id: DEV1, name: 'Gone', port }, { id: DEV2, name: 'Front door', port: live.port }] });
  const r2 = await new A.AttendanceJob(deps(c2)).runOnce();
  ok('nothing listening (refused): error posted, the next device still done', r2.devices[0].ok === false && /refused/i.test(c2.states.find((s) => s.id === DEV1)?.body.error ?? '') && r2.devices[1].ok, JSON.stringify(r2));
  await dead.close(); await live.close();
}

// ── S: 409s ──────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\nS  409 from punches → state first; 409 from state → no punches\n');
{
  const sim = await startSim({ users: USERS, punches: punchesFrom(3, [2026, 10, 4, 8, 0, 0], 60) });
  const cloud = fakeCloud({ devices: [{ id: DEV1, name: 'Front door', port: sim.port }], failStateOnce: [DEV1] });
  const r = await new A.AttendanceJob(deps(cloud)).runOnce();
  const seq = cloud.calls.filter((x) => x[0] === 'POST').map((x) => (/\/state$/.test(x[1]) ? 'state' : x[1].endsWith('/punches') ? 'punches' : 'ack'));
  ok('409 DEVICE_SERIAL_UNKNOWN → state → punches again', JSON.stringify(seq) === '["state","punches","state","punches"]', JSON.stringify(seq));
  ok('…and the punches are stored', r.devices[0].ok && r.devices[0].sent === 3 && cloud.stored.size === 3, JSON.stringify(r));
  await sim.close();

  const sim2 = await startSim({ users: USERS, punches: punchesFrom(3, [2026, 10, 4, 8, 0, 0], 60), serial: 'SWAPPED-9' });
  const c2 = fakeCloud({ devices: [{ id: DEV1, name: 'Front door', port: sim2.port, serial: 'K90P-SIM-0001' }], serialFixed: [[DEV1, 'K90P-SIM-0001']],
    actions: [{ id: 'act-x', device_id: DEV1, action: 'write_user', attendance_no: 1010, name: 'Kamau', status: 'pending' }] });
  const job = new A.AttendanceJob(deps(c2));
  const r2 = await job.runOnce();
  ok('409 on state (a different device): no punches sent for it', c2.punchCalls().length === 0 && r2.devices[0].ok === false, JSON.stringify(r2));
  ok('…its actions not run on the wrong device', !sim2.state.users.some((u) => u.userId === '1010') && c2.acks.length === 0);
  ok('…the reason shown on the Tech page', /different device/.test(job.status().devices[0].lastError ?? ''), job.status().devices[0].lastError);
  await sim2.close();
}

// ── T: Test connection, Set device time ──────────────────────────────────────────────────────────────────────────────
console.log('\nT  Test connection and Set device time\n');
{
  const ahead = new Date(Date.now() + 180 * 60_000 + 300_000);   // Kenya wall clock, 5 minutes fast
  const sim = await startSim({ users: USERS, time: simEncodeTime(ahead.getUTCFullYear(), ahead.getUTCMonth() + 1, ahead.getUTCDate(), ahead.getUTCHours(), ahead.getUTCMinutes(), ahead.getUTCSeconds()) });
  const cloud = fakeCloud({ devices: [{ id: DEV1, name: 'Front door', port: sim.port }] });
  const job = new A.AttendanceJob(deps(cloud));
  const t = await job.testDevice(DEV1);
  ok('Test connection: serial and the clock', t.ok && t.serial === 'K90P-SIM-0001' && typeof t.deviceTime === 'string', JSON.stringify(t));
  ok('…drift ≈ +300 s (over the 60 s warning)', Math.abs(t.driftS - 300) <= 2 && t.driftS > A.DRIFT_WARN_S, t.driftS);
  ok('…the config was asked first (no device list yet), nothing posted', cloud.count('GET', /config$/) === 1 && cloud.calls.filter((x) => x[0] === 'POST').length === 0);
  ok('…the device\'s users and punches untouched (no write)', !sim.state.log.some((x) => [8, 18, 202].includes(x[0])));
  const s = await job.setDeviceTime(DEV1);
  ok('Set device time: drift now ≈ 0', s.ok && Math.abs(s.driftS) <= 2, JSON.stringify(s));
  const w = new Date(Date.now() + 180 * 60_000);
  const want = simEncodeTime(w.getUTCFullYear(), w.getUTCMonth() + 1, w.getUTCDate(), w.getUTCHours(), w.getUTCMinutes(), w.getUTCSeconds());
  ok('…the device holds the PC\'s time at the business\'s local time (+180)', Math.abs(sim.state.time - want) <= 2, `${sim.state.time} vs ${want}`);
  const bad = await job.testDevice('not-a-device');
  ok('an unknown device id: a plain refusal, no connection', bad.ok === false && /not one of this branch/.test(bad.error ?? ''));
  const status = job.status();
  ok('the status never carries the comm key', !JSON.stringify(status).includes('comm_key'));
  await sim.close();
}

await wait(100);
const left = process.getActiveResourcesInfo().filter((r) => r === 'TCPSocketWrap' || r === 'TCPServerWrap');
ok('no sockets or servers left open', left.length === 0, left.join(','));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
