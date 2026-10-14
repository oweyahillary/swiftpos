// A480 (owner, 2026-10-14, screenshots from two clients' branch servers): the yellow "What this branch server holds —
// Sign in as a manager to see every till" line on a manager's Overview, and "No branch bound to this till" on the update
// bar's Manager-PIN restart — "that happens to all tills which are trying to update".
//
// Causes: a LOCAL sign-in (offline, a slow line, a refused till, through the branch server) answered `branch: { id }` while
// the screens read `branchId`, so the update bar had no branch; and a manager signed in locally stayed local for good once
// the held PIN was gone (a restart), so the Overview kept its fallback line.
//
// Registers the REAL compiled handlers (dist/main) with electron shimmed and no network.
//
//   cd apps/desktop && npm run build:main && node test/local-signin-branch.test.mjs
//
// MUTATIONS TO CONFIRM BITE: drop `branchId: branch_id` from signInLocal → "a local sign-in names its branch as the
// screens read it" fails; drop the holdOfflinePin in auth:unlock → "unlocking a local session holds the PIN" fails.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-a480-'));
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
Module._resolveFilename = function (req, parent, ...rest) { return orig.call(this, req === 'electron' ? shim : req, parent, ...rest); };

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const L = require(path.join(dist, 'localDb.js'));
const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 'till-tok', 'dev-S', 'biz-1', 'Krunch', '2026-10-14T00:00:00Z')`).run();
db.prepare(`INSERT INTO branches (id, name) VALUES ('br-1', 'Main')`).run();
require(path.join(dist, 'deviceConfig.js')).saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1',
  device_id: 'dev-S', device_role: 'node', terminal_code: 'S1', device_name: 'Server' });
try { require(path.join(dist, 'tokenStore.js')).writeSessionTokens?.({ token: 'till-tok', refreshToken: 'r' }); } catch { /* the row carries it */ }
const bcrypt = require('bcryptjs');
require(path.join(dist, 'pinCache.js')).cacheStaffCredential(
  { staffId: 'u-abdi', name: 'Abdi', roleName: 'manager', permissions: {} }, bcrypt.hashSync('2468', 4), 'br-1');

globalThis.fetch = async () => { throw new TypeError('fetch failed'); };   // no network
const O = require(path.join(dist, 'offlineSession.js'));
require(path.join(dist, 'ipcHandlers.js')).registerIpcHandlers();
const H = global.__handlers;

const s = await H['auth:verifyPin']({}, { pin: '2468', branch_id: 'br-1' });
ok('a local sign-in names its branch as the screens read it (branchId / branchName), as the online answer does',
  s?.offline === true && s.branchId === 'br-1' && s.branchName === 'Main' && s.branch?.id === 'br-1', JSON.stringify(s));

O.clearOfflinePin();   // as after a restart: the held PIN is gone
const u = await H['auth:unlock']({}, { pin: '2468' });
const held = O.heldOfflinePin();
ok('unlocking a local session holds the PIN again, so it becomes a cloud sign-in by itself',
  u?.ok === true && held?.staffId === 'u-abdi' && held.branchId === 'br-1', JSON.stringify({ u, held }));

const app = fs.readFileSync(path.join(here, '..', 'src', 'renderer', 'App.tsx'), 'utf8');
ok('the update bar reads either shape of the branch', app.includes('<UpdateBanner branchId={staff?.branchId ?? (staff as any)?.branch?.id ?? null} />'));
const mp = fs.readFileSync(path.join(here, '..', 'src', 'renderer', 'pages', 'ManagerPage.tsx'), 'utf8');
ok('a branch server\'s own records are said quietly (gray), amber only for "this till only"',
  mp.includes('const calm = cloud || day.localCoversBranch;') && mp.includes("{cloud ? ' · from the cloud' : !day.localCoversBranch && day.fallbackReason"));
const bd = fs.readFileSync(path.join(here, '..', 'src', 'main', 'branchDay.ts'), 'utf8');
ok('no "Sign in as a manager" said to a manager', !bd.includes('Sign in as a manager to see every till'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
