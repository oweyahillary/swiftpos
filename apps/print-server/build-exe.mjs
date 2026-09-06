#!/usr/bin/env node
/**
 * build-exe.mjs — build SwiftPOS-PrintServer(.exe): a single-file executable of
 * the print bridge, so a shop owner can double-click it with no Node install.
 *
 * Pipeline (Node's built-in Single Executable App):
 *   1. build shared/printing → dist
 *   2. esbuild-bundle src/index.js + shared/printing into ONE self-contained .cjs
 *      (Node SEA does NOT resolve dependencies, so we must inline them first)
 *   3. generate the SEA blob from that bundle
 *   4. copy the Node runtime to the output name
 *   5. inject the blob into the copy with postject
 *
 * Run this on the TARGET OS — the .exe is built ON Windows (SEA doesn't
 * cross-compile). Requires Node >= 24. Output lands in ./build/.
 *
 * The result is UNSIGNED: Windows SmartScreen will say "unknown publisher" until
 * you code-sign it (signtool + an OV/EV cert) — a separate, optional step.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here   = path.dirname(fileURLToPath(import.meta.url));
const root   = path.resolve(here, '../..');
const shared = path.join(root, 'shared', 'printing');
const isWin  = process.platform === 'win32';
const buildDir = path.join(here, 'build');
const outName  = isWin ? 'SwiftPOS-PrintServer.exe' : `SwiftPOS-PrintServer-${process.platform}`;

function run(cmd, args, opts = {}) {
  console.log(`\n> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: isWin, ...opts });
  if (r.status !== 0) { console.error(`\n✗ step failed: ${cmd} ${args.join(' ')}`); process.exit(1); }
}

const major = Number(process.versions.node.split('.')[0]);
if (major < 24) {
  console.error(`Node ${process.versions.node} detected — the single executable build needs Node >= 24.`);
  console.error(`Install Node 24+ on this machine and re-run. (Running from source works on any Node: npm start.)`);
  process.exit(1);
}

mkdirSync(buildDir, { recursive: true });

console.log('== 1/5  build shared/printing ==');
if (!existsSync(path.join(shared, 'node_modules'))) run('npm', ['install'], { cwd: shared });
run('npm', ['run', 'build'], { cwd: shared });

console.log('== 2/5  bundle into one self-contained file ==');
run('npx', ['--yes', 'esbuild', 'src/index.js', '--bundle', '--platform=node',
  '--target=node24', `--outfile=${path.join('build', 'bridge.cjs')}`], { cwd: here });

console.log('== 3/5  generate the SEA blob ==');
run(process.execPath, ['--experimental-sea-config', 'sea-config.json'], { cwd: here });

console.log('== 4/5  copy the Node runtime ==');
copyFileSync(process.execPath, path.join(buildDir, outName));

console.log('== 5/5  inject the blob (postject) ==');
const args = [outName, 'NODE_SEA_BLOB', 'bridge.blob', '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc2f8b3'];
if (process.platform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA');
run('npx', ['--yes', 'postject', ...args], { cwd: buildDir });

console.log(`\n✅ Built  ${path.join('build', outName)}`);
console.log(`   Unsigned — Windows SmartScreen will warn until code-signed. Test it by double-clicking; it prints a pair token and listens on :3001.`);
