// A473 (owner, 2026-10-14): "sometimes it takes up to 8-12 sec for the desktop app to unlock".
//
// Cause (the till's own log): the cloud had refused this till's session (TOKEN_REPLAYED, then DEVICE_NO_SECRET — a
// technician must rejoin it), and every PIN sign-in still asked the cloud, waited for the same renewal and device
// sign-in to fail, and only then checked the PIN on the till. A slow line also held a PIN the till already knows for the
// full 8 s, and the renewal after a 401 had no time limit at all.
//
// Registers the REAL compiled handlers (dist/main) with electron shimmed and a stubbed network, and times auth:verifyPin.
//
//   cd apps/desktop && npm run build:main && node test/fast-unlock.test.mjs
//
// MUTATIONS TO CONFIRM BITE: drop the tillSessionRefusedRecently() early return → "a refused session: the PIN is checked
// on the till at once" fails; wait 8 s for a known PIN → "a slow cloud holds a known PIN at most ~4 s" fails.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-a473-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `
  const handlers = (global.__handlers = {});
  module.exports = {
    app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '0.0.0', on() {}, isPackaged: false },
    ipcMain: { handle(ch, fn) { handlers[ch] = fn; }, on() {}, removeHandler() {} },
    BrowserWindow: class { static getAllWindows() { return []; } static getFocusedWindow() { return null; } },
    dialog: {}, shell: {}, screen: {}, Menu: {}, powerMonitor: { on() {}, getSystemIdleTime: () => 0 },
    safeStorage: { isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from('w:' + s), decryptString: (b) => Buffer.from(b).toString().slice(2) },
    net: { isOnline: () => true },
  };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return orig.call(this, req === 'electron' ? shim : req, parent, ...rest); };

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const L = require(path.join(dist, 'localDb.js'));
const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 'owner-tok', 'u-owner', 'biz-1', 'Your Business', '2026-10-14T00:00:00Z')`).run();
require(path.join(dist, 'deviceConfig.js')).saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1',
  device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Front Counter' });
const tokenStore = require(path.join(dist, 'tokenStore.js'));
try { tokenStore.writeSessionTokens?.({ token: 'owner-tok', refreshToken: 'r' }); } catch { /* the session row carries it */ }

const bcrypt = require('bcryptjs');
require(path.join(dist, 'pinCache.js')).cacheStaffCredential(
  { staffId: 'u-tom', name: 'Tom', roleName: 'cashier', permissions: { 'orders.create': true } }, bcrypt.hashSync('1111', 4), 'br-1');

let calls = [];
let mode = 'hang';
globalThis.fetch = async (url, init = {}) => {
  calls.push(String(url));
  if (mode === 'hang') {
    return new Promise((_, rej) => init.signal?.addEventListener('abort', () => rej(new Error('aborted'))));
  }
  throw new TypeError('fetch failed');
};
const S = require(path.join(dist, 'syncEngine.js'));
require(path.join(dist, 'ipcHandlers.js')).registerIpcHandlers();
const verify = global.__handlers['auth:verifyPin'];

console.log('\nA refused session\n');
{
  S._setSessionRefusedAt(Date.now());
  calls = [];
  const t0 = Date.now();
  const r = await verify({}, { pin: '1111', branch_id: 'br-1' });
  const ms = Date.now() - t0;
  ok('a refused session: the PIN is checked on the till at once — the cloud is not asked',
    r?.offline === true && r.staff?.name === 'Tom' && !calls.some((u) => u.includes('/api/auth/')) && ms < 1500, `${ms} ms ${JSON.stringify(calls)}`);
  S._setSessionRefusedAt(Date.now() - 2 * 60_000);
  ok('…only while recent: a refusal over a minute old asks the cloud again', S.tillSessionRefusedRecently() === false);
  S._setSessionRefusedAt(null);
}

console.log('\nA slow cloud\n');
{
  calls = [];
  const t0 = Date.now();
  const r = await verify({}, { pin: '1111', branch_id: 'br-1' });
  const ms = Date.now() - t0;
  ok('a slow cloud holds a PIN the till knows at most ~4 s, then the till decides', r?.offline === true && ms >= 3500 && ms < 6000, `${ms} ms`);
  ok('…the cloud was asked first', calls.some((u) => u.includes('/api/auth/verify-pin')));
}

console.log('\nWired (source)\n');
{
  const se = fs.readFileSync(path.join(here, '..', 'src', 'main', 'syncEngine.ts'), 'utf8');
  ok('the refusal is remembered only when the renewal AND the device sign-in said no',
    /if \(res\.status === 401 && await tryDeviceGrant\(\)\) return true;\n\s*if \(res\.status === 401\) _sessionRefusedAt = Date\.now\(\);/.test(se));
  ok('…and cleared by every successful renewal of the till\'s session', (se.match(/clearInboundFailure\('auth'\); _sessionRefusedAt = null;/g) ?? []).length === 3);
  const ih = fs.readFileSync(path.join(here, '..', 'src', 'main', 'ipcHandlers.ts'), 'utf8');
  ok('the whole cloud exchange is bounded (the renewal after a 401 included)',
    /res = await withinMs\(tillFetch\('\/api\/auth\/verify-pin'/.test(ih) && /knownHere \? 4_000 : 8_000\), knownHere \? 5_000 : 10_000\)/.test(ih));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
