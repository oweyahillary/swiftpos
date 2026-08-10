#!/usr/bin/env node
/**
 * check-doc-refs.mjs — a comment must not cite a document that is not here.
 *
 * WHY
 * ---
 * `BRANCH_AUTHORITY_AND_SYNC_DESIGN.md` was cited BY SECTION in six source files
 * and existed in neither the repository nor its git history (register A39). The
 * citations made it look present: anyone on a clone read "See
 * BRANCH_AUTHORITY_AND_SYNC_DESIGN.md §6", found nothing, and lost the reasoning
 * behind branch_prices, the effective-price COALESCE and the updated_by stamp.
 *
 * Worse, that document specified most of what the audit register spent a week
 * rediscovering — A19, A24, offline PIN login, branch-local settings — and
 * `syncEngine.ts:1138-1151` records a deliberate move away from its §1 and §3
 * with no sign of knowing a design said otherwise. **That is what an untracked
 * specification costs.**
 *
 * This is the cheap gate that would have caught it the day the citation was
 * written.
 *
 * WHAT IT CHECKS
 * --------------
 * Every `Something.md` mentioned in our own source or docs resolves to a file in
 * the tree. Vendor noise (node_modules, electron-builder's own docs) is excluded
 * by only scanning our directories, and a small allowlist covers files that are
 * legitimately external.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** Only our own code and docs — never node_modules. */
// docs/history/ is deliberately EXCLUDED. A past handoff naming a document that
// no longer exists is an accurate record of what happened, not a broken
// reference — and rewriting history to satisfy a gate would be the wrong fix.
// This checks live code and live docs, which are what a reader follows today.
const SCAN_DIRS = ['apps', 'shared', 'scripts', 'migrations', 'docs', 'tests', 'e2e'];
const SKIP_PATHS = [path.join('docs', 'history')];
const SCAN_EXT  = new Set(['.ts', '.tsx', '.mjs', '.js', '.sql', '.md', '.yml', '.yaml']);

/**
 * Cited but legitimately not ours. Keep this list SHORT and justified — every
 * entry is a citation a reader cannot follow.
 */
const ALLOW = new Set([
  'README.md',        // repo root, and every package has one
  'readme.md',
  'LICENSE.md',
  'CHANGELOG.md',     // referenced generically in release tooling
  'BUILDING.md',
  // Not a real citation: prose in the register and this gate's own description
  // use "Something.md" as a PLACEHOLDER for "any document". Allowlisted rather
  // than reworded, because the phrasing is the clearest way to say what the
  // gate checks and a future writer will reach for it again.
  'Something.md',
]);

function walk(dir, out = [], applySkips = true) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    if (applySkips && SKIP_PATHS.some(sp => path.relative(ROOT, p).startsWith(sp))) continue;
    if (e.isDirectory()) walk(p, out, applySkips);
    else if (SCAN_EXT.has(path.extname(e.name))) out.push(p);
  }
  return out;
}

// Every .md that exists anywhere in the tree, by basename. NOT skip-filtered:
// docs/history/ is excluded from being SCANNED for citations, but a document
// living there still counts as present — a live doc pointing at an archived
// handoff is a reference a reader CAN follow.
const present = new Set();
for (const f of walk(ROOT, [], false)) {
  if (f.endsWith('.md')) present.add(path.basename(f));
}

const files = SCAN_DIRS.flatMap(d => walk(path.join(ROOT, d)));
const missing = new Map();   // doc -> [ "file:line", ... ]
let citations = 0;

for (const file of files) {
  const rel = path.relative(ROOT, file);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    // Require a leading capital so this does not fire on lowercase vendor
    // filenames. Skip this file's own explanatory prose — a gate that fails on
    // its own documentation trains people to ignore it.
    for (const m of line.matchAll(/\b([A-Za-z][A-Za-z0-9_.-]*\.md)\b/g)) {
      const doc = m[1];
      if (ALLOW.has(doc)) continue;
      if (rel === path.join('scripts', 'check-doc-refs.mjs')) continue;
      // Skip anything that looks like a URL path rather than a repo document.
      if (/https?:\/\/[^\s]*$/.test(line.slice(0, m.index))) continue;
      citations++;
      if (present.has(doc)) continue;
      if (!missing.has(doc)) missing.set(doc, []);
      missing.get(doc).push(`${rel}:${i + 1}`);
    }
  });
}

console.log(`check-doc-refs: ${citations} document citation(s) across ${files.length} files.`);

if (missing.size === 0) {
  console.log('\nOK — every cited document is in the tree.');
  process.exit(0);
}

console.error('\nCITED BUT NOT PRESENT:\n');
for (const [doc, where] of [...missing].sort()) {
  console.error(`  ${doc}`);
  for (const w of where.slice(0, 6)) console.error(`      ${w}`);
  if (where.length > 6) console.error(`      … and ${where.length - 6} more`);
  console.error('');
}
console.error(
  'A citation a reader cannot follow is worse than no citation: it looks present.\n' +
  'Add the document to docs/, or remove the reference. See register A39.\n');
process.exit(1);
