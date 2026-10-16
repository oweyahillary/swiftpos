// A496 — what electron-updater really does under Electron, on a till behind a branch server (A489 TLS, A443 share).
//
// Runs a real Electron main process (not ELECTRON_RUN_AS_NODE: Chromium's network stack is the point) against a real
// HTTPS server using the branch server's own certificate (dist/main/lanTls.makeServerIdentity):
//   - net.request on the 'electron-updater' session, with the A489 certificate check (trustPinnedNodeIn's rule), ACCEPTS
//     the pinned certificate and REFUSES another one — update downloads over the pinned TLS hop work;
//   - without the check, Chromium refuses it (so the check is what makes it work);
//   - electron-updater's OWN executor never times out a stalled download — its timeout waits for a 'socket' event that
//     Electron's requests never emit (root cause 3 in update-delivery.test.mjs). Cancelling its token is what ends it.
//
//   cd apps/desktop && npm run build:main && node test/update-delivery-electron.test.mjs
// Skips (exit 0, said so) where Electron cannot start: not installed, or Linux without a display.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
let electron;
try { electron = require('electron'); } catch { electron = null; }
if (!electron || typeof electron !== 'string' || !fs.existsSync(electron)) { console.log('SKIPPED — electron is not installed here'); process.exit(0); }
if (process.platform === 'linux' && !process.env.DISPLAY) { console.log('SKIPPED — no display for Electron (run under xvfb-run)'); process.exit(0); }

const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a496-electron-'));
fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'a496-probe', main: 'main.cjs' }));
fs.writeFileSync(path.join(appDir, 'main.cjs'), `
const { app, session, net } = require('electron');
const https = require('https');
const path = require('path');
const dist = ${JSON.stringify(dist)};
const desktop = ${JSON.stringify(path.join(here, '..'))};
const out = (k, v) => console.log('PROBE ' + k + '=' + JSON.stringify(v));
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  try {
    const { makeServerIdentity, certDer } = require(path.join(dist, 'lanTls.js'));
    const id = makeServerIdentity(), other = makeServerIdentity();
    let stalled = null;
    const srv = https.createServer({ key: id.key, cert: id.cert }, (req, res) => {
      if (req.url === '/stall') { res.writeHead(200, { 'content-length': '1000000' }); res.write(Buffer.alloc(1000)); stalled = res; return; }
      res.writeHead(200); res.end('hello');
    });
    const impostor = https.createServer({ key: other.key, cert: other.cert }, (req, res) => { res.writeHead(200); res.end('impostor'); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    await new Promise((r) => impostor.listen(0, '127.0.0.1', r));
    const s = session.fromPartition('electron-updater', { cache: false });
    // trustPinnedNodeIn's rule: the pinned certificate, byte for byte, for the branch server's host only.
    s.setCertificateVerifyProc((req, cb) => {
      const a = certDer(req.certificate && req.certificate.data), b = certDer(id.cert);
      cb(a && b && a.equals(b) && req.hostname === '127.0.0.1' ? 0 : -3);
    });
    const get = (u, sess) => new Promise((resolve) => {
      const r = net.request({ url: u, session: sess, redirect: 'manual' });
      let socketEvent = false;
      r.on('socket', () => { socketEvent = true; });
      r.on('response', (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b, socketEvent })); });
      r.on('error', (e) => resolve({ error: e.message, socketEvent }));
      r.end();
    });
    out('pinned', await get('https://127.0.0.1:' + srv.address().port + '/latest.yml', s));
    out('impostor', await get('https://127.0.0.1:' + impostor.address().port + '/latest.yml', s));
    out('no_check', await get('https://127.0.0.1:' + srv.address().port + '/x', session.fromPartition('a496-plain', { cache: false })));
    const euDir = path.dirname(require.resolve('electron-updater', { paths: [desktop] }));
    const { ElectronHttpExecutor } = require(path.join(euDir, 'electronHttpExecutor.js'));
    const { CancellationToken } = require(require.resolve('builder-util-runtime', { paths: [euDir] }));
    const tok = new CancellationToken();
    const dest = path.join(app.getPath('temp'), 'a496-' + process.pid + '.bin');
    const dl = new ElectronHttpExecutor().download(new URL('https://127.0.0.1:' + srv.address().port + '/stall'), dest, { cancellationToken: tok, headers: {}, timeout: 1000 })
      .then(() => 'resolved', (e) => 'rejected: ' + (e && e.message));
    out('stalled_after_4s_with_1s_timeout', await Promise.race([dl, new Promise((r) => setTimeout(() => r('pending'), 4000))]));
    tok.cancel();
    out('after_cancel', await Promise.race([dl, new Promise((r) => setTimeout(() => r('pending'), 3000))]));
    try { stalled && stalled.destroy(); } catch {}
    srv.close(); impostor.close();
  } catch (e) { out('error', String(e && e.stack || e)); }
  app.exit(0);
});
`);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const r = spawnSync(electron, [appDir, '--no-sandbox'], { env, encoding: 'utf8', timeout: 60_000 });
const got = {};
for (const line of String(r.stdout ?? '').split(/\r?\n/)) {
  const m = /^PROBE ([a-z_0-9]+)=(.*)$/.exec(line);
  if (m) got[m[1]] = JSON.parse(m[2]);
}
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };
if (got.error) console.log(got.error);
console.log('\nUnder Electron (Chromium\'s network stack)\n');
ok('A489: the updater\'s session downloads from the branch server over its pinned certificate', got.pinned?.status === 200 && got.pinned.body === 'hello', JSON.stringify(got.pinned));
ok('…and refuses a server with another certificate', /ERR_CERT/.test(got.impostor?.error ?? ''), JSON.stringify(got.impostor));
ok('…which is the certificate check\'s doing (a session without it refuses the real server too)', typeof got.no_check === 'object' && /ERR_CERT/.test(got.no_check?.error ?? ''), JSON.stringify(got.no_check));
ok('A496: Electron\'s requests never emit "socket", so electron-updater\'s timeout never arms', got.pinned?.socketEvent === false);
ok('A496: a stalled download is still pending long after its 1 s timeout (root cause 3)', got.stalled_after_4s_with_1s_timeout === 'pending', JSON.stringify(got.stalled_after_4s_with_1s_timeout));
ok('…and cancelling its token ends it (what the stall watchdog does)', /rejected: cancelled/.test(got.after_cancel ?? ''), JSON.stringify(got.after_cancel));
try { fs.rmSync(appDir, { recursive: true, force: true }); } catch { /* temp */ }
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
