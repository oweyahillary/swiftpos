// A348 (2026-09-28) — a till updates only to the version the cloud approved for its business; held by default.
// Owner: "can i find a way of picking only one client to run the update not all the clients?" → "hold by default, per
// business, build 0.6.16".
//
// RUNS the real compiled autoUpdate.js (electron + electron-updater shimmed): runUpdateCheck against a fake cloud and a
// fake updater, and pins that nothing else checks the old GitHub feed. The cloud's side is tests/desktop-update.test.mjs.
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/update-approval.test.mjs
//
// MUTATIONS TO CONFIRM BITE:
//   - decideUpdate treats null as "update to latest"            → "held → nothing checked" fails
//   - decideUpdate allows an older approved version (downgrade)  → "approved OLDER → nothing" fails
//   - requestHeaders not set                                     → "…with the till's token" fails
//   - the old `autoUpdater.checkForUpdates()` poll put back       → "no GitHub poll left" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-a348-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = {
  app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '0.6.16', getName: () => 'SwiftPOS', on() {}, isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('w:' + s), decryptString: (b) => Buffer.from(b).toString().slice(2) },
  net: { isOnline: () => false }, ipcMain: { handle() {}, on() {} }, BrowserWindow: class { static getAllWindows() { return []; } } };`);
const updaterShim = path.join(userData, 'updater-shim.cjs');
fs.writeFileSync(updaterShim, `module.exports = { autoUpdater: { on() {}, checkForUpdates: async () => null, setFeedURL() {} } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === 'electron') return shim;
  if (req === 'electron-updater') return updaterShim;
  return orig.call(this, req, parent, ...rest);
};

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };
const U = require(path.join(dist, 'autoUpdate.js'));

// A fake cloud + updater, recording what the till did.
const make = ({ approved = null, status = 200, running = '0.6.16', throws = false, first401 = false, token = 'tok-1' } = {}) => {
  const log = { asks: [], feed: null, headers: null, checks: 0, refreshed: 0 };
  let tok = token, n = 0;
  const deps = {
    updater: { setFeedURL(o) { log.feed = o; }, requestHeaders: null, async checkForUpdates() { log.checks++; } },
    fetch: async (url, init) => {
      log.asks.push({ url, auth: init?.headers?.Authorization });
      if (throws) throw new TypeError('fetch failed');
      n++;
      if (first401 && n === 1) return new Response('{}', { status: 401 });
      return new Response(JSON.stringify({ approvedVersion: approved, held: approved === null }), { status });
    },
    cloudUrl: () => 'https://cloud.example/',
    token: () => tok,
    refresh: async () => { log.refreshed++; tok = 'tok-2'; return true; },
    running,
  };
  Object.defineProperty(log, 'headers', { get: () => deps.updater.requestHeaders });
  return { deps, log };
};

// The decision on its own.
ok('decide: null (held) → hold', U.decideUpdate(null, '0.6.16') === 'hold');
ok('decide: newer approved → update', U.decideUpdate('0.6.17', '0.6.16') === 'update' && U.decideUpdate('0.6.10', '0.6.9') === 'update');
ok('decide: same or older approved → current (never a downgrade)', U.decideUpdate('0.6.16', '0.6.16') === 'current' && U.decideUpdate('0.6.15', '0.6.16') === 'current');
ok('decide: garbage → hold', U.decideUpdate('latest', '0.6.16') === 'hold' && U.decideUpdate(17, '0.6.16') === 'hold');

{
  const { deps, log } = make({ approved: null });
  const r = await U.runUpdateCheck(deps);
  ok('held → nothing checked, no feed opened', r.decision === 'hold' && log.checks === 0 && log.feed === null, JSON.stringify(r));
  ok('…the till asked its own cloud, with its token', log.asks[0]?.url === 'https://cloud.example/api/desktop-update/status' && log.asks[0]?.auth === 'Bearer tok-1', JSON.stringify(log.asks));
}
{
  const { deps, log } = make({ approved: '0.6.17' });
  const r = await U.runUpdateCheck(deps);
  ok('approved NEWER → the feed is the cloud\'s, for exactly that version', r.decision === 'update'
    && log.feed?.provider === 'generic' && log.feed?.url === 'https://cloud.example/api/desktop-update/v/0.6.17/', JSON.stringify(log.feed));
  ok('…with the till\'s token, and one check', log.headers?.Authorization === 'Bearer tok-1' && log.checks === 1, JSON.stringify(log.headers));
}
{
  const { deps, log } = make({ approved: '0.6.15' });
  const r = await U.runUpdateCheck(deps);
  ok('approved OLDER → nothing (never a downgrade)', r.decision === 'current' && log.checks === 0 && log.feed === null);
}
{
  const { deps, log } = make({ approved: '0.6.17', first401: true });
  const r = await U.runUpdateCheck(deps);
  ok('an expired token: refreshed once, asked again, then updates with the NEW token', r.decision === 'update' && log.refreshed === 1
    && log.asks[1]?.auth === 'Bearer tok-2' && log.headers?.Authorization === 'Bearer tok-2', JSON.stringify(log.asks));
}
{
  const { deps, log } = make({ throws: true });
  const r = await U.runUpdateCheck(deps);
  ok('offline → hold quietly (no error, nothing checked)', r.decision === 'unreachable' && log.checks === 0);
}
{
  const { deps, log } = make({ status: 404 });
  const r = await U.runUpdateCheck(deps);
  ok('an older cloud without the route (404) → hold', r.decision === 'unreachable' && log.checks === 0);
}
{
  const { deps, log } = make({ token: null });
  const r = await U.runUpdateCheck(deps);
  ok('not signed in yet (no token) → nothing asked', r.decision === 'unreachable' && log.asks.length === 0);
}

// ── Source pins: the old GitHub poll is gone ──
const src = fs.readFileSync(path.join(here, '..', 'src', 'main', 'autoUpdate.ts'), 'utf8');
ok('no GitHub poll left: the only checkForUpdates is inside runUpdateCheck', (src.match(/\.checkForUpdates\(\)/g) || []).length === 1
  && /await d\.updater\.checkForUpdates\(\)/.test(src) && !/autoUpdater\.checkForUpdates\(/.test(src));
ok('initAutoUpdate runs the cloud check at launch and hourly; no differential download', /void check\(\);\s*setInterval\(\(\) => \{ void check\(\); \}, ONE_HOUR\);/.test(src)
  && /autoUpdater\.disableDifferentialDownload = true;/.test(src));
ok('the dev flavour and unpackaged builds still never update', /if \(!app\.isPackaged\) return;/.test(src) && /includes\('dev'\)/.test(src));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
