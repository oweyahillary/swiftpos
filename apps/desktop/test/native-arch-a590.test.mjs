// A590 (P0) — every arch in the installer gets a SQLite driver that loads, and a release cannot be uploaded otherwise.
//
// The 32-bit app of every combined installer (0.6.32 … 1.0.20) carried no better-sqlite3 binary for its arch:
// better-sqlite3 13 ships no win32-ia32 prebuild, and its binding.gyp builds nothing when the HOST (x64) has one, so
// electron-builder's per-arch rebuild "finished" for ia32 in 2 s having compiled nothing. A 32-bit POS could not open
// its database. Now: npmRebuild off, beforePack builds the ia32 driver from source (scripts/native-driver.mjs),
// afterPack runs each arch's own exe on it (scripts/native-gate.mjs), and release.yml builds with --publish never,
// gates both arches (unpacked + the installer's payloads), and only then uploads.
//
//   cd apps/desktop && node test/native-arch-a590.test.mjs
//   (optional, the real proof after a local build:  A590_UNPACKED=<output dir holding win-unpacked + win-ia32-unpacked>)
//
// MUTATIONS TO CONFIRM BITE:
//   - release.yml back to --publish always                      → "builds with --publish never" fails
//   - the ia32 gate line dropped from release.yml               → "gates x64 AND ia32" fails
//   - the publish step moved above the gate                     → "build → gate → publish → verify" fails
//   - npmRebuild: false removed (the per-arch rebuild wipes build/) → "electron-builder never rebuilds" fails
//   - beforePack not calling ensureDriver                       → "beforePack builds the driver" fails
//   - gateDir ignoring the exe's arch                           → "a wrong-arch exe is refused" fails
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, '..');
const root = path.join(desktop, '..', '..');
const require = createRequire(import.meta.url);
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let pass = 0, fail = 0;
async function ok(name, fn) {
  try { await fn(); pass++; console.log(`  ok    ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${e?.message ?? e}`); }
}

const wf = read('.github/workflows/release.yml');
const driver = await import(pathToFileURL(path.join(desktop, 'scripts', 'native-driver.mjs')).href);
const gate = await import(pathToFileURL(path.join(desktop, 'scripts', 'native-gate.mjs')).href);

console.log('release workflow');
await ok('builds with --publish never (electron-builder uploads nothing)', () => {
  assert.match(wf, /npx electron-builder --win nsis --x64 --ia32 --config electron-builder\.config\.js --publish never/);
  assert.ok(!/--publish always/.test(wf), 'a --publish always is left');
  assert.ok(!/EP_GH_IGNORE_TIME/.test(wf), 'electron-builder upload settings are left');
});
await ok('gates x64 AND ia32 — both unpacked apps and the installer it is about to upload', () => {
  assert.match(wf, /node scripts\/native-gate\.mjs dir release\/win-unpacked x64/);
  assert.match(wf, /node scripts\/native-gate\.mjs dir release\/win-ia32-unpacked ia32/);
  assert.match(wf, /node scripts\/native-gate\.mjs installer "release\/ZapTill-\$V\.exe"/);
  assert.match(wf, /node scripts\/native-driver\.mjs ensure ia32/);
});
await ok('order: driver → build → gate → publish → verify; latest.yml uploaded after the installer', () => {
  const at = (s) => { const i = wf.indexOf(s); assert.ok(i > 0, `missing: ${s}`); return i; };
  const drv = at('native-driver.mjs ensure ia32');
  const build = at('--publish never');
  const g = at('native-gate.mjs dir release/win-ia32-unpacked ia32');
  const up = at('gh release upload "$TAG" --repo "$GITHUB_REPOSITORY" --clobber "release/ZapTill-$V.exe"');
  const yml = at('--clobber release/latest.yml');
  const verify = at('releases exist for $TAG');
  assert.ok(drv < build && build < g && g < up && up < yml && yml < verify, 'steps out of order');
  // No other upload path: the only gh uploads are the two after the gate.
  assert.equal((wf.match(/gh release upload/g) || []).length, 2);
});
await ok('the published names are unchanged (the cloud feed and the admin download read them)', () => {
  assert.match(wf, /for f in latest\.yml "ZapTill-\$V\.exe"; do/);
  assert.match(wf, /"release\/ZapTill-\$V\.exe" "release\/ZapTill-\$V\.exe\.blockmap"/);
});

console.log('electron-builder config');
delete process.env.SWIFTPOS_ENV;
const cfg = require(path.join(desktop, 'electron-builder.config.js'));
await ok('both arches in the one NSIS installer', () => {
  assert.deepEqual(cfg.win.target, [{ target: 'nsis', arch: ['x64', 'ia32'] }]);
});
await ok('electron-builder never rebuilds native deps per arch (it wiped build/ and compiled nothing)', () => {
  assert.equal(cfg.npmRebuild, false);
  assert.ok(!cfg.buildDependenciesFromSource, 'buildDependenciesFromSource would run the same empty rebuild');
});
await ok('beforePack builds/checks the driver for the arch being packed; afterPack gates it and throws on failure', () => {
  const src = read('apps/desktop/electron-builder.config.js');
  assert.equal(typeof cfg.beforePack, 'function');
  assert.equal(typeof cfg.afterPack, 'function');
  assert.match(src, /beforePack: async \(ctx\) => \{[\s\S]*?ensureDriver\(arch\);/);
  assert.match(src, /afterPack: async \(ctx\) => \{[\s\S]*?gateDir\(ctx\.appOutDir, arch\)[\s\S]*?if \(!g\.ok\) throw new Error/);
  assert.match(src, /'!node_modules\/better-sqlite3\/build\/Release\/zaptill-native\.json'/);
});
await ok('the hooks skip non-Windows targets', async () => {
  await cfg.beforePack({ electronPlatformName: 'linux', arch: 1 });
  await cfg.afterPack({ electronPlatformName: 'linux', arch: 1, appOutDir: '/nowhere' });
});

console.log('native-driver');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a590-test-'));
const fakePe = (file, machine) => {
  const b = Buffer.alloc(0x100);
  b.writeUInt16LE(0x5a4d, 0); b.writeUInt32LE(0x80, 0x3c); b.writeUInt32LE(0x00004550, 0x80); b.writeUInt16LE(machine, 0x84);
  fs.writeFileSync(file, b);
  return file;
};
await ok('reads the PE machine type: i386 / AMD64 / not a Windows binary', () => {
  assert.equal(driver.archOfPe(fakePe(path.join(tmp, 'a.node'), 0x014c)), 'ia32');
  assert.equal(driver.archOfPe(fakePe(path.join(tmp, 'b.node'), 0x8664)), 'x64');
  fs.writeFileSync(path.join(tmp, 'c.node'), 'not a PE');
  assert.equal(driver.archOfPe(path.join(tmp, 'c.node')), null);
  assert.equal(driver.archOfPe(path.join(tmp, 'missing.node')), null);
});
await ok("maps each arch to the file better-sqlite3's loader takes", () => {
  const m = path.join('x', 'better-sqlite3');
  assert.equal(driver.driverFileFor('x64', m), path.join(m, 'prebuilds', 'win32-x64.node'));
  assert.equal(driver.driverFileFor('ia32', m), path.join(m, 'build', 'Release', 'better_sqlite3.node'));
});
const binding = path.join(desktop, 'node_modules', 'better-sqlite3', 'lib', 'binding.js');
if (fs.existsSync(binding)) {
  await ok('better-sqlite3 still has no ia32 prebuild and falls back to build/Release (re-check this fix on an upgrade)', () => {
    const src = fs.readFileSync(binding, 'utf8');
    assert.match(src, /const PREBUILD_ARCHS = \['x64', 'arm64'\];/);
    assert.match(src, /path\.join\(__dirname, '\.\.', 'build', 'Release', 'better_sqlite3\.node'\)/);
    const s = driver.driverStatus('x64');
    assert.ok(s.ok, `the shipped win32-x64 prebuild: ${s.why}`);
  });
} else console.log('  SKIPPED  better-sqlite3 loader pins (node_modules not installed)');

console.log('native-gate');
await ok('a missing folder, a folder with no exe, and a wrong-arch exe are refused', () => {
  assert.equal(gate.gateDir(path.join(tmp, 'nope'), 'x64').ok, false);
  const empty = fs.mkdtempSync(path.join(tmp, 'empty-'));
  assert.equal(gate.gateDir(empty, 'x64').ok, false);
  const wrong = fs.mkdtempSync(path.join(tmp, 'wrong-'));
  fakePe(path.join(wrong, 'ZapTill.exe'), 0x8664);
  const g = gate.gateDir(wrong, 'ia32');
  assert.equal(g.ok, false);
  assert.match(g.lines.join('\n'), /is x64, expected ia32/);
});
await ok('a missing installer is refused (never a pass)', () => {
  assert.equal(gate.gateInstaller(path.join(tmp, 'ZapTill-0.0.0.exe')).ok, false);
});

// The probe itself, under this machine's Electron as Node, against a resources/app holding better-sqlite3.
let electronExe = null;
try { electronExe = require('electron'); } catch { /* not installed */ }
if (process.platform === 'win32' && typeof electronExe === 'string' && fs.existsSync(electronExe)
    && fs.existsSync(path.join(desktop, 'node_modules', 'better-sqlite3'))) {
  await ok('the probe opens :memory: in Electron-as-Node and names the driver it loaded', () => {
    const res = path.join(tmp, 'resources');
    fs.mkdirSync(path.join(res, 'app', 'node_modules'), { recursive: true });
    fs.symlinkSync(path.join(desktop, 'node_modules', 'better-sqlite3'), path.join(res, 'app', 'node_modules', 'better-sqlite3'), 'junction');
    fs.symlinkSync(path.join(desktop, 'node_modules', 'node-addon-api'), path.join(res, 'app', 'node_modules', 'node-addon-api'), 'junction');
    const p = gate.runProbe(electronExe, res);
    assert.ok(!p.noAnswer, p.noAnswer);
    assert.equal(p.ok, true, p.error);
    assert.equal(p.row, 'a590');
    assert.equal(p.arch, process.arch);
    assert.match(String(p.binding?.[0] ?? ''), /better-sqlite3[\\/]prebuilds[\\/]win32-x64\.node$/);
  });
} else console.log('  SKIPPED  probe under Electron (Windows + installed electron + better-sqlite3 needed)');

// The real proof after a local package: A590_UNPACKED=<dir with win-unpacked and win-ia32-unpacked>.
if (process.env.A590_UNPACKED) {
  for (const [sub, arch] of [['win-unpacked', 'x64'], ['win-ia32-unpacked', 'ia32']]) {
    await ok(`packaged ${arch} app loads its own driver (${sub})`, () => {
      const g = gate.gateDir(path.join(process.env.A590_UNPACKED, sub), arch);
      assert.ok(g.ok, g.lines.join('; '));
      console.log(`        ${g.lines.join('\n        ')}`);
    });
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
