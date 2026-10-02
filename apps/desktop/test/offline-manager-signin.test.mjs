// A339 (2026-09-27) — a manager signing in OFFLINE reaches the manager screen, as online.
// Owner: "i was offline while trying to log in as a manager it was taking me to cashier screen not managers screen".
//
// Cause: the PIN screen routes on the TOP-LEVEL `role` of the sign-in answer (renderer App.tsx hasManagerRights). The
// online answer carries it; the offline answer (signInLocal — the saved-credential, node and node-roster paths) carried the
// role only inside `staff`. A manager has neither '*' nor (since migration 59) settings.manage, so they fell to the till.
//
// Registers the REAL compiled IPC handlers (dist/main/ipcHandlers.js) with electron shimmed, caches a manager's credential
// the way an online sign-in does (real pinCache, real bcrypt), takes the network away, and calls the real auth:verifyPin.
// The routing rule itself is renderer code (not run here): it is re-applied below from the same list the source declares.
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/offline-manager-signin.test.mjs
//
// MUTATION TO CONFIRM BITE: drop `role: staff.roleName` from signInLocal → "the offline answer carries the role" and
// "…so the manager is routed to the manager screen" fail.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-a339-'));
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
    net: { isOnline: () => false },
  };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === 'electron') return shim;
  return orig.call(this, req, parent, ...rest);
};

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const L = require(path.join(dist, 'localDb.js'));
const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 'owner-tok', 'u-owner', 'biz-1', 'Your Business', '2026-09-27T00:00:00Z')`).run();
require(path.join(dist, 'deviceConfig.js')).saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1',
  device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Front Counter' });
const tokenStore = require(path.join(dist, 'tokenStore.js'));
try { tokenStore.writeSessionTokens?.({ token: 'owner-tok', refreshToken: 'r' }); } catch { /* the session row above carries it */ }

// An online sign-in earlier cached these two (what the cloud's verify-pin returns as offlineAuth.pinHash).
const bcrypt = require('bcryptjs');
const P = require(path.join(dist, 'pinCache.js'));
P.cacheStaffCredential({ staffId: 'u-mary', name: 'Mary', roleName: 'manager', permissions: { 'orders.void': true, 'reports.view': true } },
  bcrypt.hashSync('4321', 4), 'br-1');
P.cacheStaffCredential({ staffId: 'u-tom', name: 'Tom', roleName: 'cashier', permissions: { 'orders.create': true } },
  bcrypt.hashSync('1111', 4), 'br-1');

// No network.
globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
require(path.join(dist, 'ipcHandlers.js')).registerIpcHandlers();
const verify = global.__handlers['auth:verifyPin'];
ok('setup: the real auth:verifyPin handler is registered', typeof verify === 'function');

// The PIN screen's rule (App.tsx) — the list is read from the source so it cannot drift from what ships.
const app = fs.readFileSync(path.join(here, '..', 'src', 'renderer', 'App.tsx'), 'utf8');
const MANAGER_ROLES = JSON.parse(app.match(/const MANAGER_ROLES = (\[[^\]]*\]);/)[1].replace(/'/g, '"'));
const routesToManager = (s) => MANAGER_ROLES.includes((s.role ?? '').toLowerCase()) || s.permissions?.['*'] === true || s.permissions?.['settings.manage'] === true;
ok('the PIN screen still routes on the top-level role', /MANAGER_ROLES\.includes\(\(s\.role \?\? ''\)\.toLowerCase\(\)\)/.test(app));

const mary = await verify({}, { pin: '4321', branch_id: 'br-1' });
ok('offline: the manager\'s PIN is accepted from the saved credential', mary?.offline === true && mary.staff?.name === 'Mary', JSON.stringify(mary));
ok('the offline answer carries the role at the top level, like the online one', mary?.role === 'manager', JSON.stringify(mary));
ok('…so the manager is routed to the manager screen', routesToManager(mary));

const tom = await verify({}, { pin: '1111', branch_id: 'br-1' });
ok('a cashier offline still goes to the till', tom?.role === 'cashier' && !routesToManager(tom), JSON.stringify(tom));
ok('the session row keeps the role too (what a restart reads)',
  db.prepare(`SELECT role_name FROM staff_session WHERE id=1`).get()?.role_name === 'cashier');

let wrong = null; try { await verify({}, { pin: '9999', branch_id: 'br-1' }); } catch (e) { wrong = e; }
ok('a wrong PIN offline is still refused', wrong && /Invalid PIN/.test(wrong.message), wrong?.message);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
