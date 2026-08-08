// Token store (tokenStore.ts) - credentials wrapped at rest. Register D5.
//
// Drives the REAL compiled dist/main/tokenStore.js against a real SQLite table
// with safeStorage stubbed. Best run under Electron:
//   npm run test:token:electron
//
// The point of this suite is NOT "does it encrypt". It is that a naive version
// of this change is a LOCKOUT: wrap the credential, fail to unwrap it later,
// and the till has destroyed the only copy of something it cannot re-obtain -
// and offline the owner cannot sign in again to replace it.
//
// So the cases that matter are the failure ones:
//   * a wrap that cannot round-trip must NOT clear the plaintext
//   * no safeStorage must mean plaintext, not a broken session
//   * an install predating this change must keep working untouched
//   * a database copied to another machine must fall back, not lock out

import assert from 'assert';
import Module from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-tok-'));

if (!fs.existsSync(path.join(dist, 'tokenStore.js'))) {
  console.error('dist/main not built. Run:  npx tsc -b tsconfig.main.json --force');
  process.exit(1);
}

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

for (const t of ['session', 'staff_session']) {
  db.exec(`CREATE TABLE ${t} (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    token TEXT, refresh_token TEXT, token_enc TEXT, refresh_token_enc TEXT);`);
  db.prepare(`INSERT INTO ${t} (id, token, refresh_token) VALUES (1, '', '')`).run();
}

const w = (name, src) => { const p = path.join(tmp, name); fs.writeFileSync(p, src); return p; };

// safeStorage stand-in. `machine` simulates DPAPI's machine+user binding;
// `breakWrap` simulates an encrypt that cannot be read back.
const electronShim = w('electron.cjs', `
  let available = true, machine = 'A', breakWrap = false;
  module.exports = {
    app: { getPath: () => ${JSON.stringify(tmp)} },
    safeStorage: {
      isEncryptionAvailable: () => available,
      encryptString: (s) => Buffer.from((breakWrap ? 'CORRUPT' : machine) + '::' + s, 'utf8'),
      decryptString: (b) => {
        const raw = Buffer.from(b).toString('utf8');
        const i = raw.indexOf('::');
        if (raw.slice(0, i) !== machine) throw new Error('wrong machine');
        return raw.slice(i + 2);
      },
    },
    __ctl: { setAvailable: v => { available = v; }, setMachine: v => { machine = v; },
             setBreakWrap: v => { breakWrap = v; } },
  };`);
const localDbShim = w('localDb.cjs', `module.exports = { getLocalDb: () => global.__db, LOCAL_SCHEMA_VERSION: 51 };`);
const logFileShim = w('logFile.cjs', `global.__logs = [];
  module.exports = { logLine: (s,m) => global.__logs.push('['+s+'] '+m), getLogPath: () => 'x', describeResponse: async () => '' };`);

global.__db = db;
const map = { electron: electronShim, './localDb': localDbShim, './logFile': logFileShim };
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === 'electron') return map.electron;
  if (parent?.filename?.startsWith(dist) && map[req]) return map[req];
  return origResolve.call(this, req, parent, ...rest);
};

const ctl = createRequire(import.meta.url)(electronShim).__ctl;
const ts = await import(pathToFileURL(path.join(dist, 'tokenStore.js')).href);

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};
const raw = (t = 'session') => db.prepare(`SELECT * FROM ${t} WHERE id=1`).get();
const setPlain = (t, tok, ref) => db.prepare(
  `UPDATE ${t} SET token=?, refresh_token=?, token_enc=NULL, refresh_token_enc=NULL WHERE id=1`).run(tok, ref);

console.log('round trip\n');

ts.writeSessionTokens({ token: 'acc-1', refreshToken: 'ref-1' });

check('what is written comes back', () => {
  assert.deepStrictEqual(ts.readSessionTokens(), { token: 'acc-1', refreshToken: 'ref-1' });
});

check('the plaintext columns are emptied once wrapped', () => {
  const r = raw();
  assert.strictEqual(r.token, '', 'access token left in the clear');
  assert.strictEqual(r.refresh_token, '', 'REFRESH token left in the clear - the 30-day one');
});

check('what is on disk is not the credential', () => {
  const r = raw();
  assert.ok(!String(r.token_enc).includes('acc-1') || Buffer.from(r.token_enc, 'base64').length > 0);
  assert.notStrictEqual(r.token_enc, 'acc-1');
});

check('owner and staff stores are independent', () => {
  ts.writeStaffTokens({ token: 'staff-acc', refreshToken: 'staff-ref' });
  assert.deepStrictEqual(ts.readStaffTokens(), { token: 'staff-acc', refreshToken: 'staff-ref' });
  assert.deepStrictEqual(ts.readSessionTokens(), { token: 'acc-1', refreshToken: 'ref-1' });
});

console.log('\nthe lockout cases\n');

check('a wrap that cannot round-trip LEAVES the plaintext alone', () => {
  ctl.setBreakWrap(true);
  ts.writeSessionTokens({ token: 'acc-2', refreshToken: 'ref-2' });
  ctl.setBreakWrap(false);
  const r = raw();
  assert.strictEqual(r.token, 'acc-2', 'plaintext cleared despite an unverifiable wrap');
  assert.strictEqual(r.refresh_token, 'ref-2');
  assert.deepStrictEqual(ts.readSessionTokens(), { token: 'acc-2', refreshToken: 'ref-2' },
    'the till must still be able to use its own credential');
});

check('a failed wrap is logged, not silent', () => {
  assert.ok(global.__logs.some(l => l.includes('could not wrap')));
});

check('with no safeStorage it writes plaintext and still works', () => {
  ctl.setAvailable(false);
  ts.writeSessionTokens({ token: 'acc-3', refreshToken: 'ref-3' });
  assert.strictEqual(raw().token, 'acc-3');
  assert.deepStrictEqual(ts.readSessionTokens(), { token: 'acc-3', refreshToken: 'ref-3' },
    'no wrapping available must not mean no session');
  ctl.setAvailable(true);
});

check('an install predating this change reads its plaintext untouched', () => {
  setPlain('session', 'legacy-acc', 'legacy-ref');
  assert.deepStrictEqual(ts.readSessionTokens(), { token: 'legacy-acc', refreshToken: 'legacy-ref' });
});

check('a .db copied to ANOTHER machine falls back rather than locking out', () => {
  ts.writeSessionTokens({ token: 'acc-4', refreshToken: 'ref-4' });   // wrapped on machine A
  ctl.setMachine('B');
  const onB = ts.readSessionTokens();
  assert.deepStrictEqual(onB, { token: '', refreshToken: '' },
    'a copied database must not hand over a working credential');
  ctl.setMachine('A');
  assert.deepStrictEqual(ts.readSessionTokens(), { token: 'acc-4', refreshToken: 'ref-4' },
    'and the real machine must still work');
});

console.log('\nstartup migration\n');

check('plaintext left by an older build is wrapped at startup', () => {
  setPlain('session', 'old-acc', 'old-ref');
  setPlain('staff_session', 'old-sacc', 'old-sref');
  ts.migratePlaintextTokens();
  assert.strictEqual(raw('session').token, '', 'session plaintext survived the migration');
  assert.strictEqual(raw('staff_session').refresh_token, '', 'staff plaintext survived the migration');
  assert.deepStrictEqual(ts.readSessionTokens(), { token: 'old-acc', refreshToken: 'old-ref' });
  assert.deepStrictEqual(ts.readStaffTokens(), { token: 'old-sacc', refreshToken: 'old-sref' });
});

check('running the migration again is a no-op', () => {
  const before = raw().token_enc;
  ts.migratePlaintextTokens();
  assert.strictEqual(raw().token_enc, before);
  assert.deepStrictEqual(ts.readSessionTokens(), { token: 'old-acc', refreshToken: 'old-ref' });
});

check('migration with nothing to migrate does not throw', () => {
  setPlain('session', '', '');
  setPlain('staff_session', '', '');
  assert.doesNotThrow(() => ts.migratePlaintextTokens());
});

check('migration is skipped entirely without safeStorage', () => {
  setPlain('session', 'p-acc', 'p-ref');
  ctl.setAvailable(false);
  ts.migratePlaintextTokens();
  assert.strictEqual(raw().token, 'p-acc', 'migrated with no way to unwrap - that is a lockout');
  ctl.setAvailable(true);
});

check('an empty store reads as empty rather than throwing', () => {
  setPlain('session', '', '');
  assert.deepStrictEqual(ts.readSessionTokens(), { token: '', refreshToken: '' });
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed  -  ${driver}`);
process.exit(fail ? 1 : 0);
