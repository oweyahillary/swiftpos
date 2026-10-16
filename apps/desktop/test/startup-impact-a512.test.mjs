// A512 — ZapTill started twice at every Windows sign-in, and at "High" startup impact.
// Owner, 2026-10-16, Task Manager › Startup apps: "Why do we have two start up service of the same app?" — "and why are
// they high on impact". The HKCU Run entry is named after the app id when it is written: before 1.0.5 that was
// electron.app.ZapTill, from 1.0.5 com.swiftpos.desktop — a server set up before kept both. And every start ran a
// PowerShell (the BIOS serial) and a reg query for the machine's identity, which never changes.
//
//   cd apps/desktop && npm run build:main && node --no-warnings test/startup-impact-a512.test.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n       ${e.message}`); } };

console.log('\nA512 — one startup entry, no PowerShell at every start\n');
const sm = src('src/main/serverMode.ts');
await ok('the startup entry is written and removed under ONE fixed name', () => {
  // A513: written (or, where the installer's sign-in task is there, removed) from loginEntryPlan — still ONE name.
  assert.match(sm, /setLoginItemSettings\(\{ \.\.\.plan, name: loginItemName\(\) \}\)/);
  assert.match(sm, /setLoginItemSettings\(\{ openAtLogin: false, name: loginItemName\(\) \}\)/);
  assert.match(sm, /'com\.swiftpos\.desktop'/);
});
await ok('the entries from before 1.0.5 are removed, on every start of every machine', () => {
  assert.match(sm, /OLD_LOGIN_ITEM_NAMES = \['electron\.app\.ZapTill'/);
  assert.match(sm, /setLoginItemSettings\(\{ openAtLogin: false, name \}\)/);
  assert.match(src('src/main/index.ts'), /clearOldLoginItems\(\);\s+\/\/ A512/);
});

// The identity: read once (reg + PowerShell), then from the kept file.
const cp = require('child_process');
let spawned = [];
const realExecFile = cp.execFile;
cp.execFile = (cmd, args, _opts, cb) => {
  spawned.push(cmd);
  const out = cmd === 'reg' ? '    MachineGuid    REG_SZ    11111111-2222-3333-4444-555555555555\n' : 'SER123\n';
  setImmediate(() => cb(null, out, ''));
  return { kill() {} };
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a512-'));
const cache = path.join(dir, 'machine-identity.json');
const fresh = () => { delete require.cache[require.resolve(path.join(ROOT, 'dist/main/machineFingerprint.js'))]; return require(path.join(ROOT, 'dist/main/machineFingerprint.js')); };
await ok('first start: reg and PowerShell read the identity, and it is kept', async () => {
  spawned = [];
  const id = await fresh().loadMachineIdentity('win32', cache);
  assert.equal(id.machine_guid, '11111111-2222-3333-4444-555555555555'); assert.equal(id.serial, 'SER123');
  assert.deepEqual(spawned.sort(), ['powershell.exe', 'reg']);
  assert.ok(fs.existsSync(cache));
});
await ok('every later start: nothing is spawned — the kept identity is used', async () => {
  spawned = [];
  const id = await fresh().loadMachineIdentity('win32', cache);
  assert.equal(id.machine_guid, '11111111-2222-3333-4444-555555555555'); assert.equal(id.serial, 'SER123');
  assert.deepEqual(spawned, []);
});
await ok('a damaged kept file is read again, never trusted', async () => {
  fs.writeFileSync(cache, '{not json');
  spawned = [];
  await fresh().loadMachineIdentity('win32', cache);
  assert.ok(spawned.includes('powershell.exe'));
});
cp.execFile = realExecFile;
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
