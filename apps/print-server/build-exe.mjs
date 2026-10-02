#!/usr/bin/env node
/**
 * build-exe.mjs — build SwiftPOS-PrintServer(.exe): a single-file executable of
 * the print bridge, so a till needs no Node install.
 *
 * Pipeline:
 *   1. build shared/printing → dist
 *   2. esbuild-bundle src/index.js + shared/printing into ONE self-contained .cjs
 *   3. @yao-pkg/pkg wraps that bundle + the Node runtime into a single binary
 *
 * We use pkg (not Node's SEA/postject) because on Windows the official node.exe is
 * Authenticode-signed, which breaks postject's sentinel injection. pkg handles the
 * signed base binary itself and is a single step.
 *
 * Run on the target OS (build the .exe on Windows). pkg downloads a Node base for
 * the target on first run (needs internet once). Output lands in ./build/.
 * The exe is UNSIGNED -> Windows SmartScreen warns until code-signed (optional).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here   = path.dirname(fileURLToPath(import.meta.url));
const root   = path.resolve(here, '../..');
const shared = path.join(root, 'shared', 'printing');
const isWin  = process.platform === 'win32';
const buildDir = path.join(here, 'build');

const plat = { win32: 'win', darwin: 'macos', linux: 'linux' }[process.platform] ?? process.platform;
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const target = `node22-${plat}-${arch}`;
const outName = isWin ? 'SwiftPOS-PrintServer.exe' : `SwiftPOS-PrintServer-${plat}`;

function run(cmd, args, opts = {}) {
  console.log(`\n> ${cmd} ${args.join(' ')}`);
  // npm/npx are .cmd on Windows and need a shell; direct binaries must not (a shell
  // would split a path with spaces, e.g. "C:\Program Files\nodejs\node.exe").
  const useShell = opts.shell ?? isWin;
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts, shell: useShell });
  if (r.status !== 0) { console.error(`\n[x] step failed: ${cmd} ${args.join(' ')}`); process.exit(1); }
}

mkdirSync(buildDir, { recursive: true });

console.log('== 1/3  build shared/printing ==');
if (!existsSync(path.join(shared, 'node_modules'))) run('npm', ['install'], { cwd: shared });
run('npm', ['run', 'build'], { cwd: shared });

console.log('== 2/3  bundle into one self-contained file ==');
run('npx', ['--yes', 'esbuild', 'src/index.js', '--bundle', '--platform=node',
  '--target=node20', `--outfile=${path.join('build', 'bridge.cjs')}`], { cwd: here });

console.log(`== 3/3  package the executable (${target}) ==`);
run('npx', ['--yes', '@yao-pkg/pkg', path.join('build', 'bridge.cjs'),
  '--targets', target, '--output', path.join('build', outName)], { cwd: here });

console.log(`\n[ok] Built  apps/print-server/build/${outName}`);
console.log('     Unsigned - Windows SmartScreen will warn until code-signed.');
console.log('     Run it: it prints a pair token and listens on http://127.0.0.1:3001');
