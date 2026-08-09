// Offline sign-in cache (pinCache.ts).
//
// Drives the REAL compiled dist/main/pinCache.js with electron's safeStorage
// stubbed and a real SQLite database underneath. bcryptjs is the real thing —
// it is pure JS, which is why it was chosen over native bcrypt.
//
// Best run under Electron so better-sqlite3 is the real driver:
//   npm run test:pin:electron
//
// The cases that matter are not "does a correct PIN work". They are:
//   * an EXPIRED cache must refuse
//   * two cached staff sharing a PIN must refuse, not guess
//   * a credential wrapped on another machine must not authenticate anyone
//   * the override PIN must never be cacheable
//   * logout must remove the offline way in

import assert from 'assert';
import Module from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-pin-'));

if (!fs.existsSync(path.join(dist, 'pinCache.js'))) {
  console.error('dist/main not built. Run:  npx tsc -b tsconfig.main.json --force');
  process.exit(1);
}

// ── driver ──────────────────────────────────────────────────────────────────
let db, driver;
try {
  db = new (createRequire(import.meta.url)('better-sqlite3'))(':memory:');
  driver = process.versions.electron
    ? `better-sqlite3 under Electron ${process.versions.electron} - REAL driver and ABI`
    : 'better-sqlite3 under node - real driver';
} catch {
  const { DatabaseSync } = await import('node:sqlite');
  db = new DatabaseSync(':memory:');
  driver = 'node:sqlite (STAND-IN - see register A13)';
}
console.log(`driver: ${driver}\n`);

db.exec(`
  CREATE TABLE IF NOT EXISTS staff_pin_cache (
    staff_id     TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    role_name    TEXT,
    branch_id    TEXT NOT NULL,
    permissions  TEXT NOT NULL DEFAULT '{}',
    pin_hash_enc TEXT NOT NULL,
    cached_at    TEXT NOT NULL
  );
`);

// ── shims ───────────────────────────────────────────────────────────────────
const w = (name, src) => { const p = path.join(tmp, name); fs.writeFileSync(p, src); return p; };

// safeStorage stand-in. Real DPAPI is machine+user bound; `wrapKey` lets a test
// simulate a database copied to a different machine.
const electronShim = w('electron.cjs', `
  let available = true, wrapKey = 'machine-A';
  module.exports = {
    app: { getPath: () => ${JSON.stringify(tmp)} },
    safeStorage: {
      isEncryptionAvailable: () => available,
      encryptString: (s) => Buffer.from(wrapKey + '::' + s, 'utf8'),
      decryptString: (b) => {
        const raw = Buffer.from(b).toString('utf8');
        const sep = raw.indexOf('::');
        if (raw.slice(0, sep) !== wrapKey) throw new Error('cannot decrypt on this machine');
        return raw.slice(sep + 2);
      },
    },
    __ctl: {
      setAvailable: (v) => { available = v; },
      setMachine:   (v) => { wrapKey = v; },
    },
  };`);

const localDbShim = w('localDb.cjs', `module.exports = { getLocalDb: () => global.__db, LOCAL_SCHEMA_VERSION: 51 };`);
const logFileShim = w('logFile.cjs', `
  global.__logs = [];
  module.exports = { logLine: (s, m) => global.__logs.push('[' + s + '] ' + m), getLogPath: () => 'x', describeResponse: async () => '' };`);

global.__db = db;
const map = { electron: electronShim, './localDb': localDbShim, './logFile': logFileShim };
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === 'electron') return map.electron;
  if (parent?.filename?.startsWith(dist) && map[req]) return map[req];
  return origResolve.call(this, req, parent, ...rest);
};

const ctl = createRequire(import.meta.url)(electronShim).__ctl;
const bcrypt = createRequire(import.meta.url)('bcryptjs');
const pin = await import(pathToFileURL(path.join(dist, 'pinCache.js')).href);

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};
const rows = () => db.prepare('SELECT * FROM staff_pin_cache').all();
const BR = 'branch-1';
const hashOf = (p) => bcrypt.hashSync(p, 8);

console.log('caching\n');

check('nothing is cached before an online sign-in', () => {
  assert.strictEqual(rows().length, 0);
  const v = pin.verifyPinOffline('1234', BR);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reason, 'no_cache');
});

pin.cacheStaffCredential({ staffId: 'u1', name: 'Amina', roleName: 'Cashier', permissions: { 'pos.sell': true } }, hashOf('1234'), BR);

check('an online sign-in caches that user', () => {
  assert.strictEqual(rows().length, 1);
  assert.strictEqual(rows()[0].name, 'Amina');
});

check('the stored hash is wrapped, not plaintext', () => {
  const stored = rows()[0].pin_hash_enc;
  assert.ok(!stored.startsWith('$2'), 'bcrypt hash written in the clear');
  assert.ok(stored.includes('machine-A') || Buffer.from(stored, 'base64').toString().includes('machine-A'));
});

check('a NON-bcrypt (legacy) hash is refused', () => {
  pin.cacheStaffCredential({ staffId: 'u-legacy', name: 'Old', roleName: null, permissions: {} }, 'a1b2c3d4e5f6', BR);
  assert.strictEqual(rows().find(r => r.staff_id === 'u-legacy'), undefined,
    'caching a weaker hash format to widen offline coverage is the wrong trade');
});

check('a missing hash is a no-op, not a crash', () => {
  assert.doesNotThrow(() => pin.cacheStaffCredential({ staffId: 'u-none', name: 'N', roleName: null, permissions: {} }, null, BR));
  assert.strictEqual(rows().find(r => r.staff_id === 'u-none'), undefined);
});

check('re-signing in updates rather than duplicating', () => {
  pin.cacheStaffCredential({ staffId: 'u1', name: 'Amina K', roleName: 'Cashier', permissions: {} }, hashOf('1234'), BR);
  assert.strictEqual(rows().filter(r => r.staff_id === 'u1').length, 1);
  assert.strictEqual(rows().find(r => r.staff_id === 'u1').name, 'Amina K');
});

console.log('\nverifying offline\n');

check('the right PIN signs the right person in', () => {
  const v = pin.verifyPinOffline('1234', BR);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.staff.staffId, 'u1');
  assert.strictEqual(v.staff.name, 'Amina K');
});

check('a wrong PIN is refused', () => {
  const v = pin.verifyPinOffline('9999', BR);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reason, 'no_match');
});

check('permissions survive, so offline is not a privilege escalation', () => {
  pin.cacheStaffCredential({ staffId: 'u2', name: 'Boss', roleName: 'Manager', permissions: { 'reports.view': true } }, hashOf('4321'), BR);
  const v = pin.verifyPinOffline('4321', BR);
  assert.deepStrictEqual(v.staff.permissions, { 'reports.view': true });
});

check('a credential for another BRANCH is not usable here', () => {
  pin.cacheStaffCredential({ staffId: 'u3', name: 'Other', roleName: null, permissions: {} }, hashOf('5555'), 'branch-2');
  const v = pin.verifyPinOffline('5555', BR);
  assert.strictEqual(v.ok, false);
});

console.log('\nthe refusals that matter\n');

check('two cached staff sharing a PIN is REFUSED, not guessed', () => {
  pin.cacheStaffCredential({ staffId: 'dup1', name: 'One', roleName: null, permissions: {} }, hashOf('7777'), BR);
  pin.cacheStaffCredential({ staffId: 'dup2', name: 'Two', roleName: null, permissions: {} }, hashOf('7777'), BR);
  const v = pin.verifyPinOffline('7777', BR);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reason, 'ambiguous',
    'guessing books one cashier sales to another - the server refuses here too');
  db.prepare(`DELETE FROM staff_pin_cache WHERE staff_id IN ('dup1','dup2')`).run();
});

check('an EXPIRED cache refuses even with the correct PIN', () => {
  const old = new Date(Date.now() - (pin.PIN_CACHE_TTL_DAYS + 1) * 86400000).toISOString();
  db.prepare(`UPDATE staff_pin_cache SET cached_at = ?`).run(old);
  const v = pin.verifyPinOffline('1234', BR);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reason, 'expired',
    'a till off the network for a fortnight must stop being a way in');
  db.prepare(`UPDATE staff_pin_cache SET cached_at = ?`).run(new Date().toISOString());
});

check('a database copied to ANOTHER machine authenticates nobody', () => {
  ctl.setMachine('machine-B');                 // same rows, different DPAPI scope
  const v = pin.verifyPinOffline('1234', BR);
  assert.strictEqual(v.ok, false,
    'the wrap is machine-bound; a copied .db must be inert');
  assert.strictEqual(v.reason, 'no_match');
  ctl.setMachine('machine-A');
  assert.strictEqual(pin.verifyPinOffline('1234', BR).ok, true, 'and works again on the right machine');
});

check('an unwrappable credential is logged, not silently skipped', () => {
  ctl.setMachine('machine-C');
  pin.verifyPinOffline('1234', BR);
  ctl.setMachine('machine-A');
  assert.ok(global.__logs.some(l => l.includes('could not be unwrapped')));
});

check('with no safeStorage, nothing is cached and sign-in refuses', () => {
  ctl.setAvailable(false);
  pin.cacheStaffCredential({ staffId: 'u-nowrap', name: 'X', roleName: null, permissions: {} }, hashOf('1111'), BR);
  assert.strictEqual(rows().find(r => r.staff_id === 'u-nowrap'), undefined,
    'failing closed beats writing credentials in the clear');
  const v = pin.verifyPinOffline('1234', BR);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reason, 'unavailable');
  ctl.setAvailable(true);
});

check('logout removes the offline way in', () => {
  assert.ok(rows().length > 0);
  pin.clearPinCache();
  assert.strictEqual(rows().length, 0);
  assert.strictEqual(pin.verifyPinOffline('1234', BR).reason, 'no_cache');
});

console.log(`\n${pass} passed, ${fail} failed  -  ${driver}`);
process.exit(fail ? 1 : 0);
