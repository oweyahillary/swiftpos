/**
 * add-release-scripts — one-time setup. Adds the version/release scripts to
 * apps/desktop/package.json WITHOUT touching version, dependencies, or the
 * electron-builder "build" block.
 *
 * Written as a patcher rather than shipping a whole package.json because that
 * file already carries the @swiftpos/printing dependency and your own version
 * number, and overwriting it would quietly undo both.
 *
 * Safe to run twice.
 *
 *   node scripts/add-release-scripts.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P    = path.join(ROOT, 'package.json');
const pkg  = JSON.parse(fs.readFileSync(P, 'utf8'));

const ADD = {
  'build:all':     'npm run build:main && npm run build:renderer',
  'version:patch': 'npm version patch --no-git-tag-version',
  'version:minor': 'npm version minor --no-git-tag-version',
  'version:major': 'npm version major --no-git-tag-version',
  'assert:built':  'node scripts/assert-built.mjs',
  'dist':          'npm run assert:built && npm run pack:installer && npm run pack:portable',
  // Build FIRST, bump only once it compiled, then package. Bumping first burns
  // a version number on every failed build — you end up with 0.5.7 in
  // package.json and no 0.5.7 installer anywhere.
  'release:patch': 'npm run build:all && npm run version:patch && npm run dist',
  'release:minor': 'npm run build:all && npm run version:minor && npm run dist',
  'release:major': 'npm run build:all && npm run version:major && npm run dist',
};

let added = 0, kept = 0;
for (const [k, v] of Object.entries(ADD)) {
  if (pkg.scripts[k] === v) { kept++; continue; }
  if (pkg.scripts[k]) console.log(`  replacing  ${k}\n    was: ${pkg.scripts[k]}\n    now: ${v}`);
  else                console.log(`  adding     ${k}`);
  pkg.scripts[k] = v; added++;
}

if (!pkg.scripts['build:main'] || !pkg.scripts['build:renderer']) {
  console.error('\nERROR: build:main or build:renderer is missing. Land the printing fix first.');
  process.exit(1);
}

fs.writeFileSync(P, JSON.stringify(pkg, null, 2) + '\n');
console.log(`\n${added} script(s) written, ${kept} already correct.`);
console.log(`version untouched at ${pkg.version} — bump it with: npm run release:patch`);
