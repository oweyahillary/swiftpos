// Audit 2026-10-14: three things the till's MAIN process now checks itself (a renderer-only gate is a suggestion — any
// code that reaches the bridge calls the handler directly):
//   • manager:setBranchPrice / clearBranchPrice — products.manage, or a manager by the till's rule;
//   • shift:forceClose — shifts.force_close or settings.manage (or '*', or the owner / admin);
//   • config:save — the install flow writes the till's identity before it is configured; afterwards the identity is the
//     technician console's and the money settings (VAT, the discount ceiling, ...) a settings.manage holder's.
// And the POS screen reads the session's permissions where they are (top-level), so a manager sees Force close.
//
// Registers the REAL compiled handlers (dist/main) with electron shimmed and no network.
//
//   cd apps/desktop && npm run build:main && node test/till-gates.test.mjs
//
// MUTATIONS TO CONFIRM BITE: drop the signedInHolds(FORCE_CLOSE_KEYS) line → "a cashier cannot force-close" fails; drop
// the mayPrice() check → "a cashier cannot set a branch price" fails; make configSaveRefusal return null → "once
// configured, the cloud address changes only from the technician console" fails.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-gates-'));
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
const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return String(e?.message ?? e); } };

// ── the pure rules ────────────────────────────────────────────────────────────
const G = require(path.join(dist, 'tillGates.js'));
ok('personHolds: a key, \'*\', the owner / admin role — yes; nothing, malformed JSON — no',
  G.personHolds('manager', '{"products.manage":true}', ['products.manage']) && G.personHolds('cashier', '{"*":true}', ['x'])
  && G.personHolds('Owner', '{}', ['x']) && !G.personHolds('cashier', '{"orders.create":true}', ['products.manage'])
  && !G.personHolds('cashier', '{not json', ['products.manage']) && !G.personHolds('manager', '{"products.manage":"yes"}', ['products.manage']));
const ctx = (o) => ({ configured: true, techSession: false, settingsManager: false, ...o });
ok('configSaveRefusal: the install flow (not configured) writes the identity with nobody signed in',
  G.configSaveRefusal({ deploy_mode: 'cloud', server_url: 'https://x', branch_id: 'b', device_role: 'till', node_url: null,
    node_secret: null, terminal_code: 'T1', device_name: 'Front', business_type: 'cafe', configured: true }, ctx({ configured: false })) === null);
ok('configSaveRefusal: once configured, identity needs the technician console; VAT / discount ceiling need settings.manage',
  G.configSaveRefusal({ server_url: 'https://evil' }, ctx({})) !== null
  && G.configSaveRefusal({ server_url: 'https://new' }, ctx({ techSession: true })) === null
  && G.configSaveRefusal({ max_discount_pct: 100 }, ctx({ techSession: true })) !== null
  && G.configSaveRefusal({ vat_rate: 0 }, ctx({ configured: false })) !== null
  && G.configSaveRefusal({ max_discount_pct: 20, vat_rate: 16 }, ctx({ settingsManager: true })) === null);
ok('configSaveRefusal: the till\'s id and the pull-owned keys never come from the screen',
  G.configSaveRefusal({ device_id: 'x' }, ctx({ configured: false, techSession: true, settingsManager: true })) !== null
  && G.configSaveRefusal({ pos_features: '{}' }, ctx({ techSession: true, settingsManager: true })) !== null
  && G.configSaveRefusal({ server_url: undefined }, ctx({})) === null);

// ── the real handlers ─────────────────────────────────────────────────────────
const L = require(path.join(dist, 'localDb.js'));
const db = L.getLocalDb();
globalThis.fetch = async () => { throw new TypeError('fetch failed'); };   // no network
require(path.join(dist, 'ipcHandlers.js')).registerIpcHandlers();
const H = global.__handlers;
const signIn = (role, perms) => {
  db.prepare(`DELETE FROM staff_session WHERE id=1`).run();
  db.prepare(`INSERT INTO staff_session (id, staff_id, staff_name, role_name, branch_id, branch_name, permissions, token, refresh_token, logged_in_at)
              VALUES (1, 'u-1', 'Pat', ?, 'br-1', 'Main', ?, 't', 'r', '2026-10-14T00:00:00Z')`).run(role, JSON.stringify(perms));
};

// The install flow, before anyone can sign in (fresh till: no config row).
const r1 = await refusal(() => H['config:save']({}, { deploy_mode: 'cloud', server_url: 'http://cloud', configured: false }));
const r2 = await refusal(() => H['config:save']({}, { deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1', device_role: 'till',
  node_url: null, node_secret: null, terminal_code: 'T1', device_name: 'Front', configured: true }));
ok('first-run install still works: both install saves pass with nobody signed in', r1 === null && r2 === null, JSON.stringify({ r1, r2 }));
db.prepare(`INSERT OR IGNORE INTO branches (id, name) VALUES ('br-1', 'Main')`).run();

signIn('cashier', { 'orders.create': true });
const evil = await refusal(() => H['config:save']({}, { server_url: 'http://evil' }));
const cfg = require(path.join(dist, 'deviceConfig.js')).getDeviceConfig();
ok('once configured, the cloud address changes only from the technician console', !!evil && cfg.server_url === 'http://cloud', String(evil));
const disc = await refusal(() => H['config:save']({}, { max_discount_pct: 100 }));
ok('a cashier cannot raise the discount ceiling or set VAT', !!disc && !!(await refusal(() => H['config:save']({}, { vat_rate: 0 }))), String(disc));
signIn('manager', { 'settings.manage': true });
ok('a settings.manage holder can', (await refusal(() => H['config:save']({}, { max_discount_pct: 20 }))) === null);

signIn('cashier', { 'orders.create': true });
const fc = await refusal(() => H['shift:forceClose']({}, { reason: 'left' }));
ok('a cashier cannot force-close a drawer (refused in main)', /force-close/.test(String(fc)), String(fc));
signIn('supervisor', { 'shifts.force_close': true });
const fc2 = await refusal(() => H['shift:forceClose']({}, { reason: 'left' }));
ok('a shifts.force_close holder passes the gate (then: no open shift here)', !!fc2 && !/force-close a drawer/.test(fc2), String(fc2));

signIn('cashier', { 'orders.create': true });
const pr = await refusal(() => H['manager:setBranchPrice']({}, { product_id: 'p-1', price: 1 }));
const cl = await refusal(() => H['manager:clearBranchPrice']({}, { product_id: 'p-1' }));
ok('a cashier cannot set or clear a branch price (refused in main)', /manages the menu/.test(String(pr)) && /manages the menu/.test(String(cl)), `${pr} / ${cl}`);
signIn('cashier', { 'products.manage': true });
const pr2 = await refusal(() => H['manager:setBranchPrice']({}, { product_id: 'p-1', price: 1 }));
ok('a products.manage holder passes the gate', !/manages the menu/.test(String(pr2)), String(pr2));
signIn('manager', {});
const pr3 = await refusal(() => H['manager:setBranchPrice']({}, { product_id: 'p-1', price: 1 }));
ok('a manager by the till\'s rule (role) passes the gate', !/manages the menu/.test(String(pr3)), String(pr3));

// ── the screen ────────────────────────────────────────────────────────────────
const pos = fs.readFileSync(path.join(here, '..', 'src', 'renderer', 'pages', 'POSPage.tsx'), 'utf8');
ok('the POS screen reads permissions where the session keeps them (top-level), not ss.staff.permissions',
  pos.includes('const perms = (ss?.permissions ?? {}) as Record<string, boolean>;') && !pos.includes('(ss?.staff as any)?.permissions'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
