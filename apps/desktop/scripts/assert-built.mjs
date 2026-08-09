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

/**
 * Newest mtime under src/, which is what "stale" actually means.
 *
 * This used to compare the artefact against a flat 120-minute wall clock and
 * WARN. Two problems with that, and the comment above it claimed to do
 * something it did not:
 *
 *   - a long working session tripped it on output that was perfectly fresh, so
 *     the warning became noise to scroll past;
 *   - a dist built from three-hour-old sources passed silently, which is the
 *     case it existed to catch.
 *
 * Comparing artefact mtime to newest-source mtime is the real question. The
 * clock never enters into it.
 */
function newestSourceMtime(dir) {
  let newest = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      const m = fs.statSync(p).mtimeMs;
      if (m > newest) newest = m;
    }
  };
  walk(dir);
  return newest;
}

const must = [
  ['dist/main/index.js',   'main process — this is package.json "main", the Electron entry point'],
  ['dist/main/preload.js', 'preload bridge — without it every window.swiftpos call is undefined'],
  // vite.config.ts sets build.outDir = 'dist/renderer'.
  ['dist/renderer/index.html', 'renderer bundle — run build:renderer'],
];

const srcNewest = newestSourceMtime(path.join(ROOT, 'src'));
let missing = 0, stale = 0;

for (const [rel, why] of must) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { console.error(`  MISSING  ${rel}\n           ${why}`); missing++; continue; }
  const built = fs.statSync(p).mtimeMs;
  if (built < srcNewest) {
    const behindMin = Math.round((srcNewest - built) / 60000);
    console.error(`  STALE    ${rel}`);
    console.error(`           built ${behindMin} min BEFORE the newest file in src/`);
    stale++;
    continue;
  }
  console.log(`  ok       ${rel}`);
}

// A warning you can ignore is one you will ignore. The 0.5.5 installers shipped
// stale main-process output precisely because nothing in the chain refused.
if (missing || stale) {
  console.error(`\nRefusing to package v${pkg.version}: `
    + `${missing} artefact(s) missing, ${stale} stale.`);
  console.error('Run:  npm run build:all');
  process.exit(1);
}
console.log(`\nBuild artefacts present and newer than src/. Packaging v${pkg.version}.`);
