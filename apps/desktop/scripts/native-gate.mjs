/**
 * native-gate.mjs — A590 (P0): a HARD gate before a desktop release is uploaded.
 *
 * The 1.0.20 (and earlier) installers' 32-bit app had no SQLite driver for its arch, and nothing noticed: the build
 * "succeeded", the 64-bit app worked, and a 32-bit POS could not open its database. This gate runs each arch's OWN
 * packaged ZapTill.exe as Node (ELECTRON_RUN_AS_NODE=1 — the 32-bit exe runs fine on a 64-bit Windows runner), has it
 * require better-sqlite3 the way the app does (from resources/app.asar, native file from app.asar.unpacked) and open
 * ':memory:' — and fails unless every arch loads it.
 *
 *   node scripts/native-gate.mjs dir <unpackedDir> <x64|ia32>      e.g. release/win-unpacked x64, release/win-ia32-unpacked ia32
 *   node scripts/native-gate.mjs installer <ZapTill-x.y.z.exe>      the exact payloads the installer carries
 *                                                                   ($PLUGINSDIR/app-64.7z → x64, app-32.7z → ia32; needs 7z)
 *
 * Exit 0 only when every checked arch passed. electron-builder.config.js also runs gateDir() in afterPack.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { archOfPe } from './native-driver.mjs';

// The probe runs INSIDE the packaged exe (as Node). It prints one line: A590-PROBE {json}.
const PROBE = String.raw`
const path = require('path');
const fs = require('fs');
const res = process.argv[2];
const out = { arch: process.arch, electron: process.versions.electron || null };
try {
  const asar = path.join(res, 'app.asar');
  const appRoot = fs.existsSync(asar) ? asar : path.join(res, 'app');
  out.from = appRoot;
  const Database = require(path.join(appRoot, 'node_modules', 'better-sqlite3'));
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  db.prepare('INSERT INTO t (v) VALUES (?)').run('a590');
  out.row = db.prepare('SELECT v FROM t').get().v;
  out.sqlite = db.prepare('SELECT sqlite_version() AS v').get().v;
  db.close();
  out.binding = Object.keys(require.cache).filter((k) => /\.node$/i.test(k));
  out.ok = out.row === 'a590';
} catch (e) { out.ok = false; out.error = String((e && e.stack) || e); }
console.log('A590-PROBE ' + JSON.stringify(out));
`;

function findExe(dir) {
  const exes = fs.readdirSync(dir).filter((f) => /\.exe$/i.test(f) && !/^uninstall/i.test(f));
  const named = exes.find((f) => /^ZapTill( Dev)?\.exe$/i.test(f));
  if (named) return path.join(dir, named);
  if (exes.length === 1) return path.join(dir, exes[0]);
  throw new Error(`no single app exe in ${dir} (found: ${exes.join(', ') || 'none'})`);
}

/**
 * Run `exe` as Node (ELECTRON_RUN_AS_NODE=1) with the probe against `resourcesDir` (holding app.asar or app/).
 * Returns the probe's answer, or { noAnswer } when the exe printed none (did not start, crashed, timed out).
 */
export function runProbe(exe, resourcesDir) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a590-'));
  const probe = path.join(tmp, 'probe.cjs');
  fs.writeFileSync(probe, PROBE);
  let r;
  try {
    r = spawnSync(exe, [probe, resourcesDir], {
      cwd: tmp, encoding: 'utf8', timeout: 90_000, windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1' },
    });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  const line = String(r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('A590-PROBE '));
  if (!line) return { noAnswer: `no probe answer (exit ${r.status ?? r.signal ?? r.error?.message}) ${String(r.stderr || '').slice(0, 800)}` };
  return JSON.parse(line.slice('A590-PROBE '.length));
}

/** Gate one unpacked app folder for `arch`. Returns { ok, lines }; never throws. */
export function gateDir(dir, arch) {
  const lines = [];
  const fail = (m) => { lines.push(`FAIL ${arch}: ${m}`); return { ok: false, lines }; };
  try {
    if (!fs.existsSync(dir)) return fail(`${dir} does not exist`);
    const exe = findExe(dir);
    const exeArch = archOfPe(exe);
    if (exeArch !== arch) return fail(`${path.basename(exe)} is ${exeArch ?? 'not a Windows exe'}, expected ${arch}`);
    const p = runProbe(exe, path.join(dir, 'resources'));
    if (p.noAnswer) return fail(p.noAnswer);
    if (!p.ok) return fail(`better-sqlite3 did not load in ${path.basename(exe)} (${p.arch}): ${String(p.error || '').split('\n')[0]}`);
    if (p.arch !== arch) return fail(`the exe ran as ${p.arch}, expected ${arch}`);
    const loaded = (p.binding || [])[0];
    if (!loaded) return fail('no native driver in require.cache');
    // Inside the app the path may read app.asar\…\x.node — Electron loads that file from app.asar.unpacked.
    const bin = /app\.asar[\\/]/i.test(loaded) ? loaded.replace(/app\.asar([\\/])/i, 'app.asar.unpacked$1') : loaded;
    if (!/app\.asar\.unpacked/i.test(bin) || !fs.existsSync(bin)) return fail(`driver not in app.asar.unpacked: ${loaded}`);
    const binArch = archOfPe(bin);
    if (binArch !== arch) return fail(`driver ${bin} is ${binArch}, expected ${arch}`);
    lines.push(`OK ${arch}: ${path.basename(exe)} (Electron ${p.electron}, ${p.arch}) opened :memory: with SQLite ${p.sqlite} via ${path.relative(dir, bin)}`);
    return { ok: true, lines };
  } catch (e) { return fail(String(e?.message ?? e)); }
}

function sevenZip() {
  for (const c of ['7z', 'C:\\Program Files\\7-Zip\\7z.exe']) {
    const r = spawnSync(c, ['i'], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0) return c;
  }
  throw new Error('7z not found (needed to open the installer) — the windows-latest runner has it; locally install 7-Zip');
}

/** Gate the payloads inside an NSIS installer: app-64.7z → x64, app-32.7z → ia32. */
export function gateInstaller(exe) {
  if (!fs.existsSync(exe)) return { ok: false, lines: [`FAIL: installer ${exe} does not exist`] };
  const z = sevenZip();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a590-inst-'));
  const lines = [];
  let ok = true;
  try {
    for (const [file, arch] of [['app-64.7z', 'x64'], ['app-32.7z', 'ia32']]) {
      const r1 = spawnSync(z, ['e', '-y', exe, `$PLUGINSDIR/${file}`, `-o${work}`], { encoding: 'utf8', windowsHide: true });
      const payload = path.join(work, file);
      if (r1.status !== 0 || !fs.existsSync(payload)) { ok = false; lines.push(`FAIL ${arch}: the installer carries no $PLUGINSDIR/${file}`); continue; }
      const dir = path.join(work, arch);
      const r2 = spawnSync(z, ['x', '-y', payload, `-o${dir}`], { encoding: 'utf8', windowsHide: true });
      fs.rmSync(payload, { force: true });
      if (r2.status !== 0) { ok = false; lines.push(`FAIL ${arch}: could not unpack ${file}`); continue; }
      const g = gateDir(dir, arch);
      ok = ok && g.ok;
      lines.push(...g.lines.map((l) => `${l} [installer ${file}]`));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
  return { ok, lines };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, a, b] = process.argv.slice(2);
  let res;
  if (mode === 'dir' && a && (b === 'x64' || b === 'ia32')) res = gateDir(path.resolve(a), b);
  else if (mode === 'installer' && a) {
    try { res = gateInstaller(path.resolve(a)); } catch (e) { res = { ok: false, lines: [`FAIL: ${e.message ?? e}`] }; }
  } else {
    console.error('usage: node scripts/native-gate.mjs dir <unpackedDir> <x64|ia32> | installer <ZapTill-x.y.z.exe>');
    process.exit(2);
  }
  for (const l of res.lines) console.log(l.startsWith('FAIL') ? `::error::${l}` : l);
  process.exit(res.ok ? 0 : 1);
}
