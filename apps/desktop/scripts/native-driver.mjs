/**
 * native-driver.mjs — A590 (P0): every arch in the installer gets a SQLite driver that loads.
 *
 * better-sqlite3 13 is a Node-API module (ABI-stable: one binary serves Node and every Electron). It ships prebuilds
 * for win32-x64 / win32-arm64 / linux / darwin, and NONE for win32-ia32. Its loader (lib/binding.js) takes
 * prebuilds/<platform>-<arch>.node, else build/Release/better_sqlite3.node.
 *
 * Why the 1.0.20 32-bit POS had no driver: binding.gyp compiles nothing when `node lib/binding.js` finds a prebuild —
 * and that check runs on the HOST Node (x64), not the target arch. So electron-builder's per-arch @electron/rebuild
 * ("arch=ia32 buildFromSource=false … finished" in 2 s) ran node-gyp, which wiped build/ and built an empty target.
 * buildDependenciesFromSource would hit the same condition. The fix compiles the ia32 binary with force_build=1
 * (better-sqlite3's own "build-release" flag), against Electron's headers, and electron-builder no longer rebuilds
 * (npmRebuild: false in electron-builder.config.js) so nothing wipes it before packing.
 *
 *   node scripts/native-driver.mjs ensure ia32   build build/Release/better_sqlite3.node for 32-bit Windows if missing/stale
 *   node scripts/native-driver.mjs ensure x64    check the shipped win32-x64 prebuild
 *   node scripts/native-driver.mjs check         both, without building (exit 1 when either is missing)
 *
 * electron-builder.config.js calls ensureDriver(arch) in beforePack, so a local pack:installer gets it too. Building
 * needs the Visual Studio C++ build tools (x86 + x64) and Python — the GitHub windows-latest runner has both.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const require = createRequire(path.join(ROOT, 'package.json'));

/** PE machine types (IMAGE_FILE_HEADER.Machine). */
export const PE_MACHINE = { ia32: 0x014c, x64: 0x8664, arm64: 0xaa64 };

/** The machine type of a Windows PE file (.exe/.node), or null when it is not one. */
export function peMachine(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(64);
    if (fs.readSync(fd, head, 0, 64, 0) < 64 || head.readUInt16LE(0) !== 0x5a4d) return null;   // "MZ"
    const peOff = head.readUInt32LE(0x3c);
    const pe = Buffer.alloc(6);
    if (fs.readSync(fd, pe, 0, 6, peOff) < 6 || pe.readUInt32LE(0) !== 0x00004550) return null;  // "PE\0\0"
    return pe.readUInt16LE(4);
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function archOfPe(file) {
  const m = peMachine(file);
  return Object.keys(PE_MACHINE).find((a) => PE_MACHINE[a] === m) ?? null;
}

const moduleDir = (root = ROOT) => path.join(root, 'node_modules', 'better-sqlite3');

/** The file better-sqlite3's loader takes on 64-bit / 32-bit Windows (lib/binding.js). */
export function driverFileFor(arch, modDir = moduleDir()) {
  if (arch === 'x64' || arch === 'arm64') return path.join(modDir, 'prebuilds', `win32-${arch}.node`);
  return path.join(modDir, 'build', 'Release', 'better_sqlite3.node');
}

const STAMP = 'zaptill-native.json';
const versions = () => ({
  betterSqlite3: JSON.parse(fs.readFileSync(path.join(moduleDir(), 'package.json'), 'utf8')).version,
  electron: JSON.parse(fs.readFileSync(require.resolve('electron/package.json'), 'utf8')).version,
});

/** Is there a driver for `arch` of the right machine type (and, for the built one, of this better-sqlite3)? */
export function driverStatus(arch) {
  const file = driverFileFor(arch);
  if (!fs.existsSync(file)) return { ok: false, file, why: 'missing' };
  const got = archOfPe(file);
  if (got !== arch) return { ok: false, file, why: `built for ${got ?? 'not a Windows binary'}, not ${arch}` };
  if (arch === 'ia32') {
    let stamp = null;
    try { stamp = JSON.parse(fs.readFileSync(path.join(path.dirname(file), STAMP), 'utf8')); } catch { /* none */ }
    const v = versions();
    if (!stamp || stamp.arch !== 'ia32' || stamp.betterSqlite3 !== v.betterSqlite3) {
      return { ok: false, file, why: `stale (built for better-sqlite3 ${stamp?.betterSqlite3 ?? '?'}, installed ${v.betterSqlite3})` };
    }
  }
  return { ok: true, file };
}

function nodeGypBin() {
  for (const from of ['@electron/rebuild', 'app-builder-lib', './package.json']) {
    try {
      const r = createRequire(require.resolve(from));
      return r.resolve('node-gyp/bin/node-gyp.js');
    } catch { /* next */ }
  }
  throw new Error('node-gyp not found (it comes with @electron/rebuild — run npm ci in apps/desktop)');
}

/** Compile better-sqlite3 from source for 32-bit Windows (Electron headers, force_build=1), then tidy build/. */
export function buildIa32() {
  const dir = moduleDir();
  const v = versions();
  const args = [nodeGypBin(), 'rebuild', '--release', '--arch=ia32', `--target=${v.electron}`,
    '--dist-url=https://electronjs.org/headers', '--force_build=1'];
  console.log(`[native-driver] building better-sqlite3 ${v.betterSqlite3} for win32-ia32 (Electron ${v.electron} headers) …`);
  const r = spawnSync(process.execPath, args, { cwd: dir, stdio: 'inherit', env: { ...process.env, npm_config_arch: 'ia32' } });
  if (r.status !== 0) {
    throw new Error(`node-gyp failed (exit ${r.status ?? r.signal}) building the 32-bit SQLite driver. This needs the Visual `
      + 'Studio C++ build tools (x86/x64 MSVC + a Windows SDK) and Python. Without it the 32-bit POS cannot open its database.');
  }
  const out = driverFileFor('ia32');
  if (archOfPe(out) !== 'ia32') throw new Error(`node-gyp finished but ${out} is ${archOfPe(out) ?? 'missing'}, not ia32`);
  // Keep only the driver: intermediates (obj, .lib, .pdb, .iobj, test_extension, vcxproj …) never belong in the package.
  const build = path.join(dir, 'build');
  const keep = fs.readFileSync(out);
  fs.rmSync(build, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, keep);
  fs.writeFileSync(path.join(path.dirname(out), STAMP),
    `${JSON.stringify({ arch: 'ia32', ...v, builtAt: new Date().toISOString() }, null, 2)}\n`);
  console.log(`[native-driver] OK ${path.relative(ROOT, out)} (${keep.length} bytes, i386)`);
}

/** beforePack / CLI: make sure the driver for `arch` exists; build the ia32 one when missing or stale. */
export function ensureDriver(arch) {
  const s = driverStatus(arch);
  if (s.ok) { console.log(`[native-driver] ${arch}: ${path.relative(ROOT, s.file)} OK`); return; }
  if (arch !== 'ia32') throw new Error(`[native-driver] ${arch}: ${s.file} is ${s.why} — better-sqlite3 should ship this prebuild`);
  console.log(`[native-driver] ia32: ${path.relative(ROOT, s.file)} is ${s.why} — building it`);
  buildIa32();
  const again = driverStatus('ia32');
  if (!again.ok) throw new Error(`[native-driver] ia32 driver still ${again.why} after building`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, arch] = process.argv.slice(2);
  try {
    if (cmd === 'ensure' && (arch === 'ia32' || arch === 'x64')) ensureDriver(arch);
    else if (cmd === 'check') {
      let bad = 0;
      for (const a of ['x64', 'ia32']) {
        const s = driverStatus(a);
        console.log(`[native-driver] ${a}: ${s.ok ? 'OK' : s.why} (${path.relative(ROOT, s.file)})`);
        if (!s.ok) bad++;
      }
      process.exit(bad ? 1 : 0);
    } else { console.error('usage: node scripts/native-driver.mjs ensure <ia32|x64> | check'); process.exit(2); }
  } catch (e) { console.error(`::error::${e.message ?? e}`); process.exit(1); }
}
