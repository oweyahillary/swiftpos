// A599 — attendance from a ZKTeco device (K90 Pro): the device client against a fake device.
// Owner, 2026-10-27: premium, ZKTeco first, model K90 Pro, punches pulled by the branch server, fingerprints never
// leave the device.
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/zkteco.test.mjs
//
// RUNS the real compiled dist/main/zkteco.js over real TCP against test/zkteco-sim.mjs (an in-process fake K90 Pro
// with its own framing, checksum and time code). Proves the wire format against hand-computed bytes, the comm key,
// both user record sizes, all three punch record sizes, 1,200 punches across chunks with exact times, time round
// trips, user write/delete with the admin guard, and that every fault gives a ZkError and leaves nothing open.
// NOT proven here: the real K90 Pro's choices (record sizes, free-sizes layout, comm-key bytes) — see zkteco.ts.
//
// MUTATIONS TO CONFIRM BITE (each made in dist/main/zkteco.js, seen to fail, rebuilt):
//   - checksum without the end-around carry (sum & 0xffff)          → "checksum: carry folded back" fails; the simulator answers ACK_ERROR, run stops
//   - decodeTime without the +1 on the day                           → "1,200 punches: every time exact" fails
//   - nextFrame's timeout not closing the socket (no this.fail)      → "a timeout closes the connection" fails
//   - writeUser not refusing privilege 14                            → "refuses to write an admin" fails
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startSim, simChecksum, simCommKey, simEncodeTime, simFrame, C } from './zkteco-sim.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const Z = require(path.join(here, '..', 'dist', 'main', 'zkteco.js'));

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let stray = 0;
// A stray error (from a socket event, or a step that threw outside rejects()) ends the run as a failure — never a hang.
const stop = (what) => (e) => { stray++; console.log(`  FAIL ${what}:`, e); console.log(`\n${pass} passed, ${fail + 1} failed\n`); process.exit(1); };
process.on('unhandledRejection', stop('unhandled rejection'));
process.on('uncaughtException', stop('uncaught exception'));

const hex = (b) => Buffer.from(b).toString('hex');
const USERS = [
  { uid: 1, userId: '1', name: 'Boss', privilege: 14, password: '9999' },
  { uid: 2, userId: '1002', name: 'Jane Wanjiku', password: '1234' },
  { uid: 3, userId: '1003', name: 'Otieno', card: 555 },
];
// 1,200 punches, 1 Jan 2026 onwards, every 37 min 13 s — crosses days, months and midnight.
const PUNCHES = [];
{
  let t = Date.UTC(2026, 0, 1, 6, 0, 0);
  for (let i = 0; i < 1200; i++, t += (37 * 60 + 13) * 1000) {
    const d = new Date(t);
    const u = USERS[1 + (i % 2)];
    PUNCHES.push({ uid: u.uid, userId: u.userId, t: [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()], status: 1, punch: i % 2 });
  }
}
const iso = (t) => `${t[0]}-${String(t[1]).padStart(2, '0')}-${String(t[2]).padStart(2, '0')}T${t.slice(3).map((n) => String(n).padStart(2, '0')).join(':')}`;
const sockets = (sim) => sim.state.sockets.size;

console.log('\nThe wire, against hand-computed bytes\n');
{
  ok('CMD_CONNECT, session 0, reply 0: 50 50 82 7d 08000000 e803 17fc 0000 0000',
    hex(Z.encodePacket(1000, 0, 0)) === '5050827d08000000e80317fc00000000', hex(Z.encodePacket(1000, 0, 0)));
  // 05df + 1234 + fffe = 11811 → carry folded = 1812; + 0d01 = 2513; + 7f (odd byte) = 2592; ~ = da6d
  const p = Buffer.from([0xdf, 0x05, 0, 0, 0x34, 0x12, 0xfe, 0xff, 0x01, 0x0d, 0x7f]);
  ok('checksum: carry folded back, odd last byte counted (0xda6d)', Z.checksum(p) === 0xda6d, Z.checksum(p).toString(16));
  ok('checksum: a sum of exactly 0xffff gives 0', Z.checksum(Buffer.from([0xff, 0xff, 0, 0, 0, 0, 0, 0])) === 0);
  let same = true;
  for (let i = 0; i < 200; i++) {
    const d = Buffer.alloc(i % 37); for (let j = 0; j < d.length; j++) d[j] = (i * 31 + j * 7) & 255;
    if (!Z.encodePacket(1500 + i, i * 97, 65535 - i, d).equals(simFrame(1500 + i, (i * 97) & 0xffff, 65535 - i, d))) same = false;
  }
  ok('200 packets byte-identical to the simulator\'s own encoder', same);
  const r = new Z.FrameReader();
  const two = Buffer.concat([Z.encodePacket(2000, 7, 1, Buffer.from('ab')), Z.encodePacket(1501, 7, 2, Buffer.alloc(300, 9))]);
  const got = [...r.push(two.subarray(0, 5)), ...r.push(two.subarray(5, 30)), ...r.push(two.subarray(30))];
  ok('frames torn across TCP reads come out whole', got.length === 2 && got[0].command === 2000 && got[1].data.length === 300 && got[0].sessionId === 7);
  const e = (() => { try { new Z.FrameReader().push(Buffer.from('HTTP/1.1 200 OK\r\n')); } catch (x) { return x; } })();
  ok('bytes that are not the protocol: ZkError PROTOCOL', e instanceof Z.ZkError && e.code === 'PROTOCOL');
}

console.log('\nTime and the comm key\n');
{
  ok('2000-01-01 00:00:00 is 0', Z.encodeTime({ year: 2000, month: 1, day: 1, hour: 0, minute: 0, second: 0 }) === 0);
  ok('one 31-day month later is 2000-02-01', Z.wallIso(Z.decodeTime(31 * 86400)) === '2000-02-01T00:00:00');
  // ((26*12*31) + 9*31 + 26) * 86400 + 8*3600 + 30*60 + 15 = 9977 * 86400 + 30615 = 862,043,415
  ok('2026-10-27 08:30:15 encodes to 862,043,415 (worked by hand)', Z.encodeTime({ year: 2026, month: 10, day: 27, hour: 8, minute: 30, second: 15 }) === 862043415);
  ok('…and decodes back', Z.wallIso(Z.decodeTime(862043415)) === '2026-10-27T08:30:15');
  ok('the simulator agrees', simEncodeTime(2026, 10, 27, 8, 30, 15) === 862043415);
  const w = { year: 2026, month: 10, day: 27, hour: 2, minute: 0, second: 0 };
  ok('Kenya: 02:00 on the device is 23:00 UTC the day before', Z.wallToDate(w, 180).toISOString() === '2026-10-26T23:00:00.000Z');
  ok('…and back', Z.wallIso(Z.dateToWall(new Date('2026-10-26T23:00:00Z'), 180)) === '2026-10-27T02:00:00');
  // key 0, session 0: 0 → xor ZKSO = 5a 4b 53 4f → halves swapped = 53 4f 5a 4b → ticks 0x32: 61 7d 32 79
  ok('comm key 0 / session 0 by hand: 61 7d 32 79', hex(Z.makeCommKey(0, 0)) === '617d3279', hex(Z.makeCommKey(0, 0)));
  let agree = true;
  for (const [k, s] of [[1, 1], [123456, 0x4abc], [999999, 0xffff], [0xffffffff, 3]]) if (!Z.makeCommKey(k, s).equals(simCommKey(k, s))) agree = false;
  ok('comm key agrees with the simulator for four keys', agree);
}

console.log('\nConnect, the comm key, simple reads\n');
{
  const sim = await startSim({ users: USERS });
  const zk = new Z.ZkClient({ host: '127.0.0.1', port: sim.port });
  await zk.connect();
  ok('connects with no comm key', zk.isOpen);
  ok('firmware version', (await zk.getFirmwareVersion()) === 'Ver 6.60 Sep 27 2019');
  ok('serial number (~SerialNumber)', (await zk.getSerialNumber()) === 'K90P-SIM-0001');
  ok('an option the device does not know is empty', (await zk.readOption('~Nope')) === '');
  await zk.setTime({ year: 2026, month: 12, day: 31, hour: 23, minute: 59, second: 58 });
  ok('time set / get round trip (wall clock)', Z.wallIso(await zk.getTime()) === '2026-12-31T23:59:58');
  await zk.setTime(new Date('2026-10-27T05:04:03Z'));
  ok('set from a Date writes Kenya time (08:04:03)', Z.wallIso(await zk.getTime()) === '2026-10-27T08:04:03');
  const fs = await zk.getFreeSizes();
  ok('free sizes: users / records / capacity', fs.users === 3 && fs.records === 0 && fs.usersCap === 3000, JSON.stringify(fs));
  await zk.disconnect();
  ok('disconnect sends CMD_EXIT and closes', !zk.isOpen && sim.state.log.at(-1)[0] === C.EXIT);
  await wait(30);
  ok('nothing left open on the device side', sockets(sim) === 0);
  ok('the session id is used after connect', sim.state.log.length > 3);
  await sim.close();

  const keyed = await startSim({ users: USERS, commKey: 123456 });
  const good = new Z.ZkClient({ host: '127.0.0.1', port: keyed.port, commKey: 123456 });
  await good.connect();
  ok('connects with the right comm key', (await good.getSerialNumber()) === 'K90P-SIM-0001');
  await good.disconnect();
  const auth = keyed.state.authsSeen[0];
  const raw = Buffer.alloc(4); raw.writeUInt32LE(123456, 0);
  ok('the key itself is not on the wire', !!auth && !auth.equals(raw) && !auth.toString('latin1').includes('123456'));
  const bad = new Z.ZkClient({ host: '127.0.0.1', port: keyed.port, commKey: 654321, timeoutMs: 1000 });
  const e = await rejects(bad.connect());
  ok('wrong comm key: ZkError UNAUTH', e instanceof Z.ZkError && e.code === 'UNAUTH', String(e));
  ok('…the message does not carry the key', !String(e?.message).includes('654321'));
  ok('…and the connection is closed', !bad.isOpen);
  const none = new Z.ZkClient({ host: '127.0.0.1', port: keyed.port, timeoutMs: 1000 });
  ok('no comm key on a keyed device: UNAUTH', (await rejects(none.connect()))?.code === 'UNAUTH');
  await wait(30);
  ok('nothing left open after the refusals', sockets(keyed) === 0);
  await keyed.close();
}

console.log('\nUsers, both record sizes\n');
{
  const sim = await startSim({ users: USERS, userFormat: 72, frameSize: 50 });
  const users = await Z.withZk({ host: '127.0.0.1', port: sim.port, chunkSize: 64 }, (zk) => zk.readUsers());
  const jane = users.find((u) => u.uid === 2);
  ok('72-byte: three users', users.length === 3);
  ok('72-byte: name, user id, password flag, card', jane?.name === 'Jane Wanjiku' && jane.userId === '1002' && jane.hasPassword && users[2].card === 555 && !users[2].hasPassword, JSON.stringify(users));
  ok('72-byte: the admin is seen as an admin', users[0].privilege === 14);
  ok('the password itself is never handed out', !('password' in jane) && !Object.values(jane).includes('1234'));
  ok('the device is enabled again after the read; the buffer freed', sim.state.disabled === 0 && sim.state.freed >= 1);
  await sim.close();

  const s28 = await startSim({ users: USERS, userFormat: 28 });
  const u28 = await Z.withZk({ host: '127.0.0.1', port: s28.port }, (zk) => zk.readUsers());
  ok('28-byte: names (8 bytes max), numeric user ids', u28.length === 3 && u28[1].name === 'Jane Wa' && u28[1].userId === '1002' && u28[2].card === 555, JSON.stringify(u28));
  await s28.close();
}

console.log('\nPunches: 1,200 across chunks, and the 8- and 16-byte records\n');
{
  const sim = await startSim({ users: USERS, punches: PUNCHES, punchFormat: 40, frameSize: 1000 });
  const zk = new Z.ZkClient({ host: '127.0.0.1', port: sim.port, chunkSize: 4096 });
  await zk.connect();
  const got = await zk.readAttendance();
  ok('1,200 punches', got.length === 1200, String(got.length));
  ok('read in chunks (48,004 bytes / 4,096 = 12)', sim.state.chunkReads === 12, String(sim.state.chunkReads));
  ok('1,200 punches: every time exact', got.every((p, i) => p.wallIso === iso(PUNCHES[i].t)), got.find((p, i) => p.wallIso !== iso(PUNCHES[i].t))?.wallIso);
  ok('every punch: user id, uid, in/out', got.every((p, i) => p.userId === PUNCHES[i].userId && p.uid === PUNCHES[i].uid && p.punch === PUNCHES[i].punch));
  ok('timestamp = wall clock at +3 (06:00 Kenya = 03:00 UTC)', got[0].timestamp.toISOString() === '2026-01-01T03:00:00.000Z', got[0].timestamp.toISOString());
  ok('the last one crosses into February', got[1199].wall.month === 2, got[1199].wallIso);
  await zk.disconnect();
  await sim.close();

  const few = PUNCHES.slice(0, 50);
  for (const fmt of [8, 16]) {
    const s = await startSim({ users: USERS, punches: few, punchFormat: fmt });
    const r = await Z.withZk({ host: '127.0.0.1', port: s.port, chunkSize: 100 }, (z) => z.readAttendance());
    ok(`${fmt}-byte: 50 punches, times exact, uid and user id both filled from the users`,
      r.length === 50 && r.every((p, i) => p.wallIso === iso(few[i].t) && p.userId === few[i].userId && p.uid === few[i].uid), JSON.stringify(r[0]));
    await s.close();
  }
  const direct = await startSim({ users: USERS, punches: few, directMax: 1e6 });
  const rd = await Z.withZk({ host: '127.0.0.1', port: direct.port }, (z) => z.readAttendance());
  ok('a small table answered in one CMD_DATA (no chunks)', rd.length === 50 && direct.state.chunkReads === 0);
  await direct.close();
  const empty = await startSim({ users: USERS });
  ok('no punches: an empty list', (await Z.withZk({ host: '127.0.0.1', port: empty.port }, (z) => z.readAttendance())).length === 0);
  await empty.close();
}

console.log('\nWriting and deleting users\n');
{
  const sim = await startSim({ users: USERS });
  const zk = new Z.ZkClient({ host: '127.0.0.1', port: sim.port, chunkSize: 128 });
  await zk.connect();
  const w = await zk.writeUser({ userId: 'ZT-0042', name: 'Achieng Odhiambo' });
  ok('a new user takes the next slot (4)', w.uid === 4 && w.privilege === 0);
  ok('…and is refreshed (CMD_REFRESHDATA after the write)', sim.state.log.at(-1)[0] === C.REFRESH && sim.state.log.at(-2)[0] === C.USER_WRQ);
  const back = (await zk.readUsers()).find((u) => u.userId === 'ZT-0042');
  ok('written, read back', back?.uid === 4 && back.name === 'Achieng Odhiambo' && back.privilege === 0);
  await zk.writeUser({ userId: '1002', name: 'Jane W. Kamau' });
  const jane = (await zk.readUsers()).find((u) => u.uid === 2);
  ok('an update keeps the slot and the device password', jane?.name === 'Jane W. Kamau' && jane.hasPassword && sim.state.users.find((u) => u.uid === 2).password === '1234');
  const long = await zk.writeUser({ userId: 'x', name: 'Ñ'.repeat(30) });
  ok('a long name is cut at a whole character', sim.state.users.find((u) => u.uid === long.uid).name === 'Ñ'.repeat(11));
  const before = sim.state.log.length;
  const e1 = await rejects(zk.writeUser({ userId: '9', name: 'Sneaky', privilege: 14 }));
  ok('refuses to write an admin (FORBIDDEN), nothing sent', e1?.code === 'FORBIDDEN' && sim.state.log.length === before, String(e1));
  const e2 = await rejects(zk.writeUser({ userId: '77', name: 'Over', uid: 1 }));
  ok('refuses to overwrite the admin\'s slot', e2?.code === 'FORBIDDEN' && sim.state.users.find((u) => u.uid === 1).name === 'Boss');
  const e3 = await rejects(zk.writeUser({ userId: '1', name: 'Boss renamed' }));
  ok('refuses to overwrite the admin by user id', e3?.code === 'FORBIDDEN');
  const e4 = await rejects(zk.deleteUser(1));
  ok('refuses to delete a device admin', e4?.code === 'FORBIDDEN' && sim.state.users.some((u) => u.uid === 1));
  ok('an unknown slot is not deleted', (await rejects(zk.deleteUser(999)))?.code === 'FORBIDDEN');
  await zk.deleteUser(3);
  ok('deletes a normal user', !(await zk.readUsers()).some((u) => u.uid === 3));
  await zk.startEnroll('ZT-0042', 0);
  ok('start enrolment is asked (model-dependent, untested on hardware)', sim.state.log.some(([c]) => c === C.STARTENROLL));
  ok('the device is enabled again after every write', sim.state.disabled === 0);
  await zk.disconnect();
  await sim.close();

  const s28 = await startSim({ users: USERS, userFormat: 28 });
  const z28 = new Z.ZkClient({ host: '127.0.0.1', port: s28.port });
  await z28.connect();
  await z28.readUsers();
  await z28.writeUser({ userId: '2001', name: 'Kip' });
  ok('a 28-byte device gets a 28-byte record', s28.state.users.find((u) => u.userId === '2001')?.name === 'Kip');
  ok('…and a non-numeric user id is refused there', (await rejects(z28.writeUser({ userId: 'ZT-1', name: 'x' })))?.code === 'FORBIDDEN');
  await z28.disconnect();
  await s28.close();
}

console.log('\nFaults: every one a ZkError, nothing left open\n');
{
  const sim = await startSim({ users: USERS, punches: PUNCHES, faults: { silentOn: new Set([C.GET_TIME]) } });
  const zk = new Z.ZkClient({ host: '127.0.0.1', port: sim.port, timeoutMs: 300 });
  await zk.connect();
  const t0 = Date.now();
  const e = await rejects(zk.getTime());
  ok('a device that never answers: TIMEOUT', e instanceof Z.ZkError && e.code === 'TIMEOUT' && Date.now() - t0 < 1500, String(e));
  ok('a timeout closes the connection', !zk.isOpen);
  ok('…and the next call says CLOSED at once', (await rejects(zk.getSerialNumber()))?.code === 'CLOSED');
  await zk.disconnect();
  await wait(50);
  ok('no socket left on the device side', sockets(sim) === 0);
  await sim.close();

  const s2 = await startSim({ users: USERS, faults: { silentOn: new Set([C.CONNECT]) } });
  const z2 = new Z.ZkClient({ host: '127.0.0.1', port: s2.port, timeoutMs: 300 });
  ok('no answer to CONNECT: TIMEOUT', (await rejects(z2.connect()))?.code === 'TIMEOUT');
  await wait(50);
  ok('…nothing left open', sockets(s2) === 0 && !z2.isOpen);
  await s2.close();

  const s3 = await startSim({ users: USERS, punches: PUNCHES, frameSize: 500, faults: { dropAfterChunks: 3 } });
  const z3 = new Z.ZkClient({ host: '127.0.0.1', port: s3.port, chunkSize: 2048, timeoutMs: 2000 });
  await z3.connect();
  const t1 = Date.now();
  const e3 = await rejects(z3.readAttendance());
  ok('dropped mid-read (torn frame): CLOSED, at once (no wait for the timeout)', e3 instanceof Z.ZkError && e3.code === 'CLOSED' && Date.now() - t1 < 1500, String(e3));
  ok('…three chunks had arrived', s3.state.chunkReads === 3);
  await z3.disconnect();
  await wait(50);
  ok('…nothing left open', sockets(s3) === 0 && !z3.isOpen);
  await s3.close();

  const s4 = await startSim({ faults: { garbage: true } });
  const z4 = new Z.ZkClient({ host: '127.0.0.1', port: s4.port, timeoutMs: 1000 });
  ok('something that is not a ZKTeco device: PROTOCOL', (await rejects(z4.connect()))?.code === 'PROTOCOL');
  await s4.close();

  const port = s4.port;   // closed now
  const z5 = new Z.ZkClient({ host: '127.0.0.1', port, timeoutMs: 1000 });
  const e5 = await rejects(z5.connect());
  ok('nothing listening: REFUSED', e5?.code === 'REFUSED', String(e5));

  const z6 = new Z.ZkClient({ host: '127.0.0.1', port });
  await z6.disconnect();
  ok('disconnect on a client never connected does not throw', true);
}

await wait(100);
const left = process.getActiveResourcesInfo().filter((r) => r === 'TCPSocketWrap' || r === 'TCPServerWrap' || r === 'Timeout');
ok('no open handles at the end (sockets, servers, timers)', left.length === 0, left.join(','));
ok('nothing thrown from a socket event (no unhandled rejection / exception)', stray === 0);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
