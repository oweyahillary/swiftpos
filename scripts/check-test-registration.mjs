#!/usr/bin/env node
/**
 * check-test-registration.mjs — a test file nothing runs is not a test.
 *
 * WHY
 * ---
 * `apps/desktop/test/failover-cursors.test.mjs` was written, committed, and
 * never added to `npm run test:desktop`. The owner's target run on 2026-08-10
 * executed 92 tests across five suites under the real Electron ABI and the sixth
 * was silently absent — **register A31, which is A16 repeated inside the batch
 * that closed A16.**
 *
 * The same week, `scripts/test-migration-47.mjs` was found pointing at
 * `/home/claude/out4/migrations/…` — an absolute path from the sandbox it was
 * written in. Nineteen assertions that had never executed once since the day
 * they were committed (A32).
 *
 * Both looked like coverage. Neither was. Rule 10: a test that passes with the
 * bug present is decoration; a test nothing invokes is not even that.
 *
 * WHAT IT CHECKS
 * --------------
 * Every test file in a known test directory is reachable from at least one
 * runner — a package.json script, a CI step, or a discovering runner such as
 * scripts/run-migration-tests.mjs.
 *
 * Deliberately NOT clever: it looks for the file's basename appearing in any
 * runner text. A glob that happens to match is fine — the question is only
 * "does anything invoke this", not "is it invoked well".
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not `new URL(...).pathname` — the latter yields "/C:/…" on
// Windows and path.resolve then prepends the drive (A33).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** Directories whose *.test.mjs files must be invoked by something. */
const TEST_DIRS = ['tests', 'apps/desktop/test'];

/**
 * Files that legitimately nothing invokes directly. Keep this SHORT and give
 * every entry a reason — an allowlist that grows without justification is how
 * this gate stops meaning anything.
 */
const ALLOW = new Set([
  // Helper that RUNS other suites under Electron; invoked with an argument.
  'run-under-electron.mjs',
]);

function walk(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs)
    .filter(f => f.endsWith('.mjs') || f.endsWith('.test.js'))
    .map(f => ({ dir, file: f }));
}

/** Every place a test could be invoked from. */
function runnerText() {
  const parts = [];

  for (const pkg of ['package.json', 'apps/desktop/package.json', 'apps/server/package.json']) {
    const p = path.join(ROOT, pkg);
    if (!fs.existsSync(p)) continue;
    const scripts = JSON.parse(fs.readFileSync(p, 'utf8')).scripts ?? {};
    parts.push(Object.values(scripts).join('\n'));
  }

  const ci = path.join(ROOT, '.github/workflows');
  if (fs.existsSync(ci)) {
    for (const f of fs.readdirSync(ci)) {
      parts.push(fs.readFileSync(path.join(ci, f), 'utf8'));
    }
  }

  // Discovering runners: a script that globs a directory invokes everything in
  // it, so its glob counts as an invocation of each file.
  for (const r of ['scripts/run-migration-tests.mjs']) {
    const p = path.join(ROOT, r);
    if (fs.existsSync(p)) parts.push(fs.readFileSync(p, 'utf8'));
  }

  return parts.join('\n');
}

const runners = runnerText();

/**
 * Does anything invoke this file — by name, or by a pattern that would match it?
 *
 * Three ways a file counts as invoked, and the last two matter as much as the
 * first. The initial version of this gate only checked the NAME and reported 22
 * false positives on files a CI shell glob runs perfectly well. A gate that
 * cries wolf gets switched off, which is worse than no gate at all.
 */
function isInvoked(file, dir) {
  // 1. Named outright: `node test/logFile.test.mjs`.
  if (ALLOW.has(file)) return true;
  if (runners.includes(file)) return true;

  // 2. A SHELL GLOB over the file's directory, e.g. CI's
  //      for f in tests/*.test.mjs; do node "$f"; done
  //    Matched by directory + extension rather than by parsing shell.
  const ext = file.endsWith('.test.mjs') ? '*.test.mjs' : '*.mjs';
  for (const d of [dir, path.basename(dir)]) {
    if (runners.includes(`${d}/${ext}`)) return true;
  }

  // 3. A DISCOVERING RUNNER: a script that readdir's a directory and filters by
  //    a regex the file satisfies. scripts/run-migration-tests.mjs does this.
  for (const m of runners.matchAll(/readdirSync\([^)]*\)[\s\S]{0,200}?\.filter\(\s*\w+\s*=>\s*(\/[^/]+\/[a-z]*)\.test\(/g)) {
    try {
      const lit = m[1];
      const body = lit.slice(1, lit.lastIndexOf('/'));
      const flags = lit.slice(lit.lastIndexOf('/') + 1);
      if (new RegExp(body, flags).test(file)) return true;
    } catch { /* an unparseable literal is not a pass */ }
  }

  return false;
}

const orphans = [];
let total = 0;

for (const dir of TEST_DIRS) {
  for (const { file } of walk(dir)) {
    if (!file.includes('.test.') && !file.startsWith('test-')) continue;
    total++;
    if (!isInvoked(file, dir)) orphans.push(`${dir}/${file}`);
  }
}

console.log(`check-test-registration: ${total} test file(s) across ${TEST_DIRS.length} directories.\n`);

if (orphans.length) {
  console.error('WRITTEN BUT NEVER RUN:\n');
  for (const o of orphans) console.error(`  ${o}`);
  console.error(
    '\nAdd it to a package script or a CI step. A file in a test directory that\n' +
    'nothing invokes is not coverage — it only looks like it. See register A31.\n');
  process.exit(1);
}

console.log('OK — every test file is invoked by a script, a CI step or a discovering runner.');
