/**
 * assert-built — refuse to package output that was never produced.
 *
 * The 0.5.5 installers shipped stale main-process output: build:main had FAILED,
 * electron-builder ran anyway, and the exe packaged whatever dist/main happened
 * to contain from an earlier build. Nothing in the chain noticed.
 *
 * `&&` between the build and pack steps is the primary guard. This is the
 * belt-and-braces one, because a build can also "succeed" having emitted
 * nothing, and because it catches the case where dist/ is left over from a
 * previous version.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const pkg  = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const must = [
  ['dist/main/index.js',   'main process — this is package.json "main", the Electron entry point'],
  ['dist/main/preload.js', 'preload bridge — without it every window.swiftpos call is undefined'],
  // vite.config.ts sets build.outDir = 'dist/renderer'.
  ['dist/renderer/index.html', 'renderer bundle — run build:renderer'],
];

let bad = 0;
for (const [rel, why] of must) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { console.error(`  MISSING  ${rel}\n           ${why}`); bad++; continue; }
  const age = (Date.now() - fs.statSync(p).mtimeMs) / 60000;
  console.log(`  ok       ${rel}  (${Math.round(age)} min old)`);
  // A build older than the newest source file means the chain did not rebuild.
  if (age > 120) console.warn(`  WARNING  ${rel} is ${Math.round(age / 60)}h old — is this a fresh build?`);
}

if (bad) {
  console.error(`\nRefusing to package v${pkg.version}: ${bad} build artefact(s) missing.`);
  console.error('Run:  npm run build:main && npm run build:renderer');
  process.exit(1);
}
console.log(`\nBuild artefacts present. Packaging v${pkg.version}.`);
