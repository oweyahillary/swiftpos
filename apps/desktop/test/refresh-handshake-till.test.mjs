// A477 — the till's side of the renewal handshake, its machine binding, its back-off and its logs.
//
// Owner, 2026-10-14 (a branch server signed out on 2026-10-12: TOKEN_REPLAYED on every renewal, DEVICE_NO_SECRET, a
// technician rejoin, two days of shifts refused, callers retrying many times a minute, the two 1 MB logs rotated away
// the start): renewal like SYN / SYN-ACK / ACK; the key bound to the machine; no warnings piled on cashiers; logs big
// enough that nothing is skipped.
//
// Drives the REAL compiled dist/main (localDb, tokenStore, syncEngine.refreshAccessToken, machineFingerprint, nodeClient,
// logFile) on a REAL SQLite file in a temp userData, with a stand-in cloud (and branch server).
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json --force && node test/refresh-handshake-till.test.mjs
//
// MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
//   - doRefreshAccessToken reading `_refreshToken || persistedRefresh()` again (memory first) → "disk is the only source" fails
//   - keepRenewedPair writing the tokens only once the ack has answered                         → "written to disk BEFORE the ack" fails
//   - the gate check removed from doRefreshAccessToken                                          → "one attempt in 15 minutes" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ipcHandlersSource } from '../../../scripts/lib/ipc-handler-files.mjs';   // D10: ipcHandlers.ts + ipc/*.ts

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
if (!fs.existsSync(path.join(dist, 'syncEngine.js'))) { console.error('dist/main not built. Run:  npx tsc -b tsconfig.main.json --force'); process.exit(1); }
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a477-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '0.0.0' }, ipcMain: { handle() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => true } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return req === 'electron' ? shim : orig.call(this, req, parent, ...rest); };

const L = require(path.join(dist, 'localDb.js'));
const T = require(path.join(dist, 'tokenStore.js'));
const E = require(path.join(dist, 'syncEngine.js'));
const F = require(path.join(dist, 'machineFingerprint.js'));
const LOG = require(path.join(dist, 'logFile.js'));
const C = require(path.join(dist, 'deviceConfig.js'));
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };
const sha = (s) => createHash('sha256').update(String(s).trim().toLowerCase()).digest('hex');

const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, refresh_token, user_id, business_id, business_name, logged_in_at) VALUES (1, 'acc-0', 'ref-0', 'dev-T1', 'biz-1', 'Pollo', '2026-10-01T00:00:00Z')`).run();
C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1', device_id: 'dev-T1', device_role: 'node', terminal_code: 'T1', device_name: 'Till 1' });
T.writeSessionTokens({ token: 'acc-0', refreshToken: 'ref-0' });
T.writeDeviceSecret('sec-1');
F._setMachineIdentity({ mac: 'aa:bb:cc:dd:ee:ff', machine_guid: '6F1C2B3A-1111-2222-3333-444455556666', serial: 'PF3XYZ12' });

// ── the stand-in cloud ──
const cloud = { refresh: 'ok', ack: 'ok', grant: 'ok', n: 0, events: [], retryAfter: null, giveSecret: null };
const hdr = (init, k) => { const h = init.headers ?? {}; const key = Object.keys(h).find((x) => x.toLowerCase() === k.toLowerCase()); return key ? h[key] : undefined; };
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const body = init.body ? JSON.parse(init.body) : {};
  const json = (status, b, headers = {}) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json', ...headers } });
  const ev = { url: u, body, guid: hdr(init, 'x-device-guid'), serial: hdr(init, 'x-device-serial'), mac: hdr(init, 'x-device-mac'), missing: hdr(init, 'x-device-secret-missing'), raw: JSON.stringify(init.headers ?? {}) };
  if (u.endsWith('/api/auth/refresh')) {
    cloud.events.push({ kind: 'refresh', ...ev });
    if (cloud.refresh === 'stale') return json(401, { error: 'This sign-in key was already replaced', code: 'TOKEN_STALE' });
    if (cloud.refresh === 'limited') return json(429, { error: 'Too many renewals' }, cloud.retryAfter ? { 'retry-after': cloud.retryAfter } : {});
    cloud.n++;
    return json(200, { accessToken: `acc-${cloud.n}`, refreshToken: `ref-${cloud.n}`, token: `acc-${cloud.n}`, ack: true, ...(cloud.giveSecret ? { deviceSecret: cloud.giveSecret } : {}) });
  }
  if (u.endsWith('/api/auth/refresh/ack')) {
    // What is on disk at the moment the ack reaches the cloud.
    cloud.events.push({ kind: 'ack', ...ev, diskAtAck: T.readSessionTokens().refreshToken });
    if (cloud.ack === 'down') throw new TypeError('fetch failed');
    if (cloud.ack === '500') return json(500, { error: 'boom' });
    return json(200, { ok: true, acked: true });
  }
  if (u.endsWith('/api/auth/device-token')) {
    cloud.events.push({ kind: 'grant', ...ev });
    if (cloud.grant === 'refuse') return json(401, { error: 'This till\'s sign-in belongs to another computer.', code: 'DEVICE_MISMATCH' });
    cloud.n++;
    return json(200, { accessToken: `acc-g${cloud.n}`, refreshToken: `ref-g${cloud.n}` });
  }
  if (u.includes('/api/changes')) { cloud.events.push({ kind: 'changes', ...ev }); return json(401, { error: 'Invalid or expired token' }); }
  return json(404, {});
};
const count = (k) => cloud.events.filter((e) => e.kind === k).length;
const lastOf = (k) => [...cloud.events].reverse().find((e) => e.kind === k);

console.log('\nThe handshake, on the till\n');
{
  E.configureSyncEngine('http://cloud', 'acc-0', 'ref-STALE-IN-MEMORY');
  ok('a renewal succeeds', (await E.refreshAccessToken()) === true);
  ok('disk is the only source of the refresh token: the copy on disk was presented, not the one in memory',
    lastOf('refresh')?.body.refreshToken === 'ref-0', JSON.stringify(lastOf('refresh')?.body));
  await E._awaitAck();
  const ack = lastOf('ack');
  ok('the cloud asked for an ack → the till confirmed the NEW token', ack?.body.refreshToken === 'ref-1', JSON.stringify(ack?.body));
  ok('…written to disk BEFORE the ack was sent', ack?.diskAtAck === 'ref-1', String(ack?.diskAtAck));
}
{
  // Someone changed the disk behind the engine's back (a rejoin, another process): the disk wins again.
  T.writeSessionTokens({ token: 'acc-x', refreshToken: 'ref-ON-DISK' });
  await E.refreshAccessToken(); await E._awaitAck();
  ok('read right before each attempt: a token written to disk since is the one presented', lastOf('refresh')?.body.refreshToken === 'ref-ON-DISK');
}
{
  cloud.ack = 'down';
  const r = await E.refreshAccessToken(); await E._awaitAck();
  const kept = T.readSessionTokens().refreshToken;
  ok('an ack that fails is harmless: the renewal stands, the new token is kept', r === true && kept === `ref-${cloud.n}`, kept);
  cloud.ack = '500';
  await E.refreshAccessToken(); await E._awaitAck();
  ok('…the next renewal presents that new token (its implicit ack) — never the old one', lastOf('refresh')?.body.refreshToken === kept);
  cloud.ack = 'ok';
}

console.log('\nThe machine (hashed, never raw)\n');
{
  const r = lastOf('refresh');
  ok('the renewal says which machine: MAC as A182, MachineGuid and BIOS serial as SHA-256',
    r?.mac === 'aa:bb:cc:dd:ee:ff' && r?.guid === sha('6F1C2B3A-1111-2222-3333-444455556666') && r?.serial === sha('PF3XYZ12'), JSON.stringify(r));
  ok('…the raw guid and serial are nowhere in what is sent', !/6f1c2b3a|PF3XYZ12/i.test(cloud.events.map((e) => e.raw).join(' ')));
  ok('the ack carries them too', lastOf('ack')?.guid === sha('6F1C2B3A-1111-2222-3333-444455556666'));
  ok('a till that holds its device secret does not say it lost it', r?.missing === undefined);
  T.clearDeviceSecret();
  cloud.giveSecret = 'sec-NEW';
  await E.refreshAccessToken(); await E._awaitAck();
  ok('a till that lost its device secret says so (X-Device-Secret-Missing: 1) …', lastOf('refresh')?.missing === '1');
  ok('…and keeps the fresh one the cloud hands over', T.readDeviceSecret() === 'sec-NEW');
  cloud.giveSecret = null;
}
{
  ok('MachineGuid parsed from reg query', F.parseMachineGuid('\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    6f1c2b3a-1111-2222-3333-444455556666\r\n') === '6f1c2b3a-1111-2222-3333-444455556666'
    && F.parseMachineGuid('ERROR: The system was unable to find the specified registry key') === null && F.parseMachineGuid('') === null);
  ok('BIOS placeholders are not a serial', ['To be filled by O.E.M.', 'Default string', '0', 'System Serial Number', '00000000', 'None', ' ', 'FFFFFFFF']
    .every((x) => F.cleanSerial(x) === null) && F.cleanSerial(' PF3XYZ12\r\n') === 'PF3XYZ12');
  ok('not Windows → no guid, no serial (the MAC only)', await (async () => { F._setMachineIdentity(null); const id = await F.loadMachineIdentity('linux'); F._setMachineIdentity({ mac: 'aa:bb:cc:dd:ee:ff', machine_guid: '6F1C2B3A-1111-2222-3333-444455556666', serial: 'PF3XYZ12' }); return id.machine_guid === null && id.serial === null; })());
  ok('identity headers built from what was read (none when nothing was)', JSON.stringify(F.identityHeadersFor({ mac: null, machine_guid: null, serial: null })) === '{}');
}

console.log('\nOne gate for every caller\n');
{
  cloud.refresh = 'stale'; cloud.grant = 'refuse';
  const before = count('refresh');
  ok('the cloud refuses the renewal (TOKEN_STALE) and the device grant (DEVICE_MISMATCH)', (await E.refreshAccessToken()) === false);
  ok('…one renewal and one device grant were asked', count('refresh') === before + 1 && lastOf('grant')?.guid === sha('6F1C2B3A-1111-2222-3333-444455556666'));
  const grants = count('grant');
  await Promise.all([E.refreshAccessToken(), E.refreshAccessToken(), E.tillChangesPost([]).catch(() => null), E.rosterCloudGet('/api/staff').catch(() => null)]);
  for (let i = 0; i < 5; i++) await E.refreshAccessToken();
  ok('then nobody asks again — the sync loop, the PIN pad, the changes push, the roster: one attempt in 15 minutes',
    count('refresh') === before + 1 && count('grant') === grants, `${count('refresh') - before} renewals, ${count('grant') - grants} more grants`);
  ok('…the gate says until when', (() => { const u = E.renewalHeldUntil(); return u !== null && u - Date.now() > 14 * 60_000 && u - Date.now() <= 15 * 60_000; })());
  E._setSessionRefusedAt(Date.now() - 16 * 60_000);
  cloud.refresh = 'ok'; cloud.grant = 'ok';
  ok('after 15 minutes it asks again (and succeeds)', (await E.refreshAccessToken()) === true && count('refresh') === before + 2);
  await E._awaitAck();

  cloud.refresh = 'stale'; cloud.grant = 'refuse';
  await E.refreshAccessToken();
  const n = count('refresh');
  E.resetRenewalGate('a technician rejoined this till');
  cloud.refresh = 'ok'; cloud.grant = 'ok';
  ok('a technician\'s action opens the gate at once', (await E.refreshAccessToken()) === true && count('refresh') === n + 1);
  await E._awaitAck();
}
{
  cloud.refresh = 'limited'; cloud.retryAfter = '120';
  const n = count('refresh'), g = count('grant');
  ok('429 "Too many renewals" → no renewal now, and no device grant (it is not a refusal)', (await E.refreshAccessToken()) === false && count('grant') === g);
  const u = E.renewalHeldUntil();
  ok('…held for the Retry-After the cloud gave (120 s)', u !== null && u - Date.now() > 110_000 && u - Date.now() <= 120_000, String(u && u - Date.now()));
  await E.refreshAccessToken(); await E.refreshAccessToken();
  ok('…and nobody asks meanwhile', count('refresh') === n + 1);
  E.resetRenewalGate('test');
  ok('Retry-After as seconds, as an HTTP date, missing (15 min), absurd (capped at 1 h)', (() => {
    const h = (v) => ({ get: (k) => (k === 'retry-after' ? v : null) });
    const now = Date.parse('2026-10-14T10:00:00Z');
    return E.retryAfterMs(h('30'), now) === 30_000 && E.retryAfterMs(h('Tue, 14 Oct 2026 10:05:00 GMT'), now) === 300_000
      && E.retryAfterMs(h(null), now) === 15 * 60_000 && E.retryAfterMs(h('999999'), now) === 60 * 60_000;
  })());
  cloud.refresh = 'ok'; cloud.retryAfter = null;
}

console.log('\nA till behind a branch server (the A160 path)\n');
{
  C.saveDeviceConfig({ device_role: 'till', node_url: 'http://node:4000', node_secret: 'branch-code' });
  const seen = [];
  const cloudFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/node/cloud/')) throw new TypeError('fetch failed');   // the branch's way to the cloud is down …
    if (u.endsWith('/node/refresh')) { seen.push({ kind: 'node-refresh', guid: hdr(init, 'x-device-guid'), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ accessToken: 'acc-n', refreshToken: 'ref-n', ack: true }), { status: 200 }); }
    if (u.endsWith('/node/refresh/ack')) { seen.push({ kind: 'node-ack', guid: hdr(init, 'x-device-guid'), body: JSON.parse(init.body), disk: T.readSessionTokens().refreshToken });
      return new Response(JSON.stringify({ ok: true }), { status: 200 }); }
    return cloudFetch(url, init);
  };
  ok('… the branch server renews for the till', (await E.refreshAccessToken()) === true && T.readSessionTokens().refreshToken === 'ref-n');
  await E._awaitAck();
  const a = seen.find((x) => x.kind === 'node-ack');
  ok('the branch server is given the till\'s machine with the renewal', seen[0]?.guid === sha('6F1C2B3A-1111-2222-3333-444455556666'));
  ok('…and the ack goes through it too, after the disk write', a?.body.refreshToken === 'ref-n' && a?.disk === 'ref-n' && a?.guid === seen[0]?.guid, JSON.stringify(a));
  globalThis.fetch = cloudFetch;
  C.saveDeviceConfig({ device_role: 'node', node_url: null, node_secret: null });
}

console.log('\nThe logs\n');
{
  const authLog = path.join(userData, 'auth.log');
  const a = fs.readFileSync(authLog, 'utf8');
  ok('auth.log: renewals, acks, refusals with their code, device grants, the gate', /\[renewal-ok\]/.test(a) && /\[ack\]/.test(a) && /\[ack-failed\]/.test(a)
    && /\[renewal-refused\] TOKEN_STALE/.test(a) && /\[device-grant-refused\] DEVICE_MISMATCH/.test(a) && /\[renewal-limited\]/.test(a) && /\[gate-open\]/.test(a), a.slice(0, 400));
  ok('…and no token in it', !/ref-\d|acc-\d|sec-/.test(a));

  const logPath = LOG.getLogPath();
  const t0 = Date.parse('2026-10-14T08:00:00Z');
  let now = t0;
  LOG._setLogClock(() => now);
  LOG._flushRepeats();
  fs.writeFileSync(logPath, '');
  LOG.logLine('sync', 'catalogue pull failed: HTTP 401');
  for (let i = 1; i <= 40; i++) { now = t0 + i * 10_000; LOG.logLine('sync', 'catalogue pull failed: HTTP 401'); }
  let lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
  ok('a message repeated within 10 minutes is counted, not written', lines.length === 1, lines.join(' | '));
  now = t0 + 420_000;
  LOG.logLine('sync', 'catalogue pull ok');
  lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
  ok('another message → one line: "repeated N times between HH:MM and HH:MM", then the new one',
    lines.length === 3 && /\[sync\] the previous message repeated 40 times between 08:00 and 08:06/.test(lines[1]) && /catalogue pull ok/.test(lines[2]), lines.join(' | '));
  LOG.logLine('sync', 'tick'); now += 60_000; LOG.logLine('sync', 'tick');
  now += 11 * 60_000; LOG.logLine('sync', 'tick');
  lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
  ok('after 10 minutes the same message is written again (with the count of the window before)',
    lines.length === 6 && /repeated 1 time between/.test(lines[4]) && /\[sync\] tick$/.test(lines[5]), lines.join(' | '));
  LOG._setLogClock(null);
  LOG._flushRepeats();

  fs.writeFileSync(logPath, ''); fs.truncateSync(logPath, 5_000_001);
  LOG.logLine('sync', 'after a 5 MB file');
  ok('swiftpos.log rolls at 5 MB', fs.existsSync(`${logPath}.1`) && fs.statSync(logPath).size < 1000);

  for (let i = 0; i < 25; i++) { fs.writeFileSync(authLog, ''); fs.truncateSync(authLog, 2_000_001); LOG.authLog('renewal-ok', `roll ${i}`); }
  const kept = fs.readdirSync(userData).filter((f) => f.startsWith('auth.log'));
  ok('auth.log rolls at 2 MB and keeps 20 files (auth.log … auth.log.19) — months of sign-in history', kept.length === 20 && fs.existsSync(`${authLog}.19`) && !fs.existsSync(`${authLog}.20`), kept.join());
}

console.log('\nWired (source)\n');
{
  const src = (p) => fs.readFileSync(path.join(here, '..', 'src', p), 'utf8');
  const ipc = ipcHandlersSource();
  ok('enrolment / rejoin sends the machine and opens the gate (a technician\'s action)',
    /enrol\/redeem`, \{[\s\S]{0,400}\.\.\.\(await identityHeaders\(\)/.test(ipc) && /resetRenewalGate\(rejoin \?/.test(ipc));
  ok('the sign-in source goes to auth.log (cloud, branch server, the till itself)',
    /authLog\('sign-in', 'source=cloud'\)/.test(ipc) && /signInSource = 'node'/.test(ipc) && /authLog\('sign-in', `source=\$\{signInSource\}`\)/.test(ipc));
  const ns = src('main/nodeServer.ts');
  ok('the branch server forwards the ack and the till\'s X-Device-* headers', /url === '\/node\/refresh\/ack'/.test(ns) && /\/\^x-device-\/i\.test\(k\)/.test(ns));
  ok('no new cashier-facing warning: the renewal never touches the renderer', !/webContents|BrowserWindow|showMessageBox/.test(src('main/syncEngine.ts').split('async function doRefreshAccessToken')[1].split('async function doRefreshStaffToken')[0]));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
