/**
 * server-notice.test.mjs — A436: a till asking to join a branch server hidden in the tray is SEEN (the window comes
 * forward, a Windows notification), the till tells the technician to press Allow on the server, and a till already set
 * up but signed out can find the server too; A437: Windows shutting down closes ZapTill properly.
 * Owner, 2026-10-10: "proceed — on the till a message should tell the technician to accept on the server";
 * "proceed with your recommendation".
 *
 *   node test/server-notice.test.mjs
 *
 * RUNS the real src/main/serverJoin.ts (the listener) and src/renderer/lib/joinNotice.ts (the message), then pins the
 * Electron wiring (Electron is not run here).
 *
 * MUTATIONS TO CONFIRM BITE: the listener call removed from createJoinRequest → "the server is told of every new
 * request" fails; joinWaitNotice without the server's address → "where to go" fails; query-session-end calling
 * preventDefault → "never vetoes shutdown" fails; leaveServerMode without the quitting guard → "still starts with
 * Windows after a shutdown" fails; EnrolPage asking without rejoin → "keeps everything on it" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ipcHandlersSource } from '../../../scripts/lib/ipc-handler-files.mjs';   // D10: ipcHandlers.ts + ipc/*.ts

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.SN_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, SN_TS: '1' } });
  process.exit(r.status ?? 1);
}
const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(DESKTOP, p), 'utf8').replace(/\r\n/g, '\n');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n       ${e.message}`); } };

const J = await import(pathToFileURL(path.join(DESKTOP, 'src/main/serverJoin.ts')).href);
const N = await import(pathToFileURL(path.join(DESKTOP, 'src/renderer/lib/joinNotice.ts')).href);

console.log('\nThe server hears of every request (A436)\n');
ok('the server is told of every new request, with the till\'s name and address', () => {
  J._resetJoins();
  const heard = [];
  J.onJoinAsked((r) => heard.push(r));
  J.createJoinRequest({ device_id: 'dev-1', name: 'FRONT-PC' }, '192.168.1.31', 1000);
  assert.deepEqual(heard, [{ name: 'FRONT-PC', ip: '192.168.1.31' }]);
  J.createJoinRequest({ name: 'NO-ID' }, '192.168.1.32', 1000);   // refused (no device id): no notice
  assert.equal(heard.length, 1);
  J.onJoinAsked(null);
});
ok('a notice that fails never refuses the till', () => {
  J._resetJoins();
  J.onJoinAsked(() => { throw new Error('no notifications here'); });
  const r = J.createJoinRequest({ device_id: 'dev-2', name: 'BAR' }, '192.168.1.40', 1000);
  assert.ok(r.ok);
  J.onJoinAsked(null);
});

console.log('\nThe till says: go to the server and press Allow (A436)\n');
const srv = { ip: '192.168.1.20', server: 'Back office', business: 'Albaik' };
ok('where to go (the server\'s name and address), what they will see, what to press', () => {
  const n = N.joinWaitNotice('FRONT-PC', srv);
  assert.match(n.title, /branch server and press Allow/);
  assert.ok(n.steps[0].includes('"Back office" (192.168.1.20)'), n.steps[0]);
  assert.ok(n.steps[1].includes('A till wants to join this branch server') && n.steps[1].includes('"FRONT-PC"'), n.steps[1]);
  assert.match(n.steps[2], /Press Allow/);
});
ok('a server with no name: its address', () => {
  assert.ok(N.joinWaitNotice('T1', { ip: '10.0.0.5', server: null, business: null }).steps[0].includes('the branch server (10.0.0.5)'));
});
ok('the minutes left; run out says ask again', () => {
  assert.equal(N.joinWaitNotice('T1', srv).footer, 'The request waits 10 more minutes.');
  assert.equal(N.joinWaitNotice('T1', srv, 0.4).footer, 'The request waits 1 more minute.');
  assert.match(N.joinWaitNotice('T1', srv, 0).footer, /run out/);
});
ok('the till\'s 10 minutes are the server\'s 10 minutes', () => {
  assert.equal(N.JOIN_WAIT_MINUTES * 60_000, J.JOIN_TTL_MS);
});
ok('both setup screens show it while waiting', () => {
  for (const p of ['src/renderer/pages/InstallPage.tsx', 'src/renderer/pages/EnrolPage.tsx']) {
    // A489: with the security code to compare with the server's.
    assert.ok(read(p).includes('<JoinWaitPanel tillName={joinWait.tillName} srv={joinTarget} askedAt={joinWait.at} securityCode={joinWait.code} />'), p);
  }
});

console.log('\nThe sign-in-code screen finds the server too (A436)\n');
const enrol = read('src/renderer/pages/EnrolPage.tsx');
const ipc = ipcHandlersSource();
ok('"Find the branch server" on the screen a signed-out till shows', () => {
  assert.ok(enrol.includes("'Find the branch server'"));
  assert.ok(enrol.includes('posApi.install.findServers()'));
});
ok('it rejoins — keeps everything on it — and only the way to the server changes', () => {
  assert.ok(enrol.includes('posApi.install.requestJoin(srv.url, true)'));
  assert.ok(ipc.includes("const joined = await joinBusiness(String(g.business_id), String(g.code), true);"));
  // A502: a former branch server stepping down becomes a till in the same write (A503: the assertion follows the code).
  assert.ok(ipc.includes("saveDeviceConfig({ node_url: ask.url, node_secret: String(g.node_secret), ...(wasServer ? { device_role: 'till' } : {}) } as any);"));
});
ok('refused by the cloud: the old server address is put back', () => {
  assert.ok(ipc.includes("saveDeviceConfig({ node_url: before?.node_url ?? null, node_secret: before?.node_secret ?? null,"));
  assert.ok(ipc.includes('setTillPin(pinBefore);'));
});

console.log('\nThe server\'s window comes forward (A436)\n');
const mode = read('src/main/serverMode.ts');
const index = read('src/main/index.ts');
ok('a request shows the window, flashes it, and raises a notification that opens it', () => {
  const fn = mode.slice(mode.indexOf('export function announceJoin'), mode.indexOf('export function closeCleanlyOnSessionEnd'));
  // A513: the window that is OPEN comes forward and flashes; none is made for it (a server started at sign-in has none) —
  // the notification says it, and clicking it makes the window (showWindow makes one). Kept referenced (no GC).
  assert.ok(/if \(open\) \{\s*const win = showWindow\(\);\s*try \{ win\?\.flashFrame\(true\); \}/.test(fn));
  assert.ok(fn.includes('new Notification(') && fn.includes("n.on('click', () => { showWindow(); });") && fn.includes('joinNotice = n;') && fn.includes('n.show();'));
  assert.ok(index.includes('onJoinAsked(({ name, ip }) => announceJoin(name, ip));'));
});

console.log('\nWindows shutting down (A437)\n');
ok('never vetoes shutdown: the window is let close', () => {
  const m = mode.match(/win\.on\('query-session-end', \(([^)]*)\) => \{([^}]*)\}\);/);
  assert.ok(m, 'query-session-end handler');
  assert.ok(!/preventDefault/.test(m[2]) && /quitting = true/.test(m[2]), m[0]);
});
ok('on session-end the database is closed, then the app exits — on every till', () => {
  assert.ok(/win\.on\('session-end', \(\) => \{\s*quitting = true;\s*try \{ cleanup\(\); \}[^\n]*\n\s*app\.exit\(0\);/.test(mode));
  assert.ok(index.includes('closeCleanlyOnSessionEnd(win, () => { closeLocalDb(); });'));
});
ok('a server still starts with Windows after a shutdown (the way out never clears it)', () => {
  assert.ok(mode.includes('if (app.isPackaged && !quitting) {'));
  assert.ok(!index.includes('stopNodeServer(); closeLocalDb()'));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
