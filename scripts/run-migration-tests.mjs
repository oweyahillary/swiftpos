#!/usr/bin/env node
/**
 * run-migration-tests.mjs — run every migration test against real PostgreSQL.
 *
 * WHY THIS EXISTS
 * ---------------
 * This repository has tested migrations against PGlite since migration 41, and
 * had six such scripts by 2026-08-10. **None of them ran in CI**, and the
 * consequences were exactly what you would expect from a test nothing invokes:
 *
 *   * `test-migration-47.mjs` pointed at `/home/claude/out4/migrations/…` — an
 *     absolute path from the sandbox it was written in. It had never run
 *     anywhere else since the day it was committed. Nineteen assertions, none
 *     of which had ever executed.
 *   * Migration 74 shipped with a `CREATE OR REPLACE VIEW` that Postgres refuses
 *     (42P16) and reached the owner's database, because the practice existed but
 *     nothing made it habitual.
 *
 * DISCOVERY, NOT A LIST
 * ---------------------
 * Globbing `scripts/test-migration*.mjs` rather than enumerating them, because a
 * hand-kept list is one more thing to forget — which is the entire failure this
 * file addresses. A new migration test is picked up by existing.
 *
 * Runs each in its own process so one crash cannot take the rest with it, and
 * reports every failure rather than stopping at the first: when several break at
 * once it is usually one cause, and seeing all of them is how you spot it.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not `new URL(...).pathname` — the latter yields "/C:/…" on
// Windows and path.resolve then prepends the drive. Every other script here
// already does it this way.
const HERE = path.dirname(fileURLToPath(import.meta.url));

const tests = fs.readdirSync(HERE)
  .filter(f => /^test-migrations?[-\d].*\.mjs$/.test(f))
  .sort();

if (tests.length === 0) {
  console.error('No migration tests found in scripts/ — has the naming changed?');
  process.exit(1);
}

console.log(`\nMigration tests against real PostgreSQL (PGlite) — ${tests.length} file(s)\n`);

const failed = [];
for (const t of tests) {
  const r = spawnSync(process.execPath, [path.join(HERE, t)], {
    encoding: 'utf8',
    // Inherit stdin/stderr but capture stdout so the summary stays readable;
    // a failing test's output is printed in full below.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;

  // Two summary conventions exist in this directory. Most files print
  // "N passed, N failed"; test-migrations-41-42 prints PASS/FAIL lines and ends
  // with "all green". Reading only the first left that file showing a blank
  // summary, which looks indistinguishable from a file that asserted nothing —
  // and given test-migration-47 had never actually run, "looks like it did
  // nothing" is not a reassuring thing for a runner to display.
  //
  // The exit status is what decides pass or fail; this is only for the summary.
  const summary =
    (out.match(/(\d+) passed, (\d+) failed/) || [])[0]
    ?? (() => {
      const n = (out.match(/^PASS\b/gm) || []).length;
      const f = (out.match(/^FAIL\b/gm) || []).length;
      return n || f ? `${n} passed, ${f} failed` : '';
    })();

  if (r.status === 0) {
    console.log(`  ok   ${t.padEnd(34)} ${summary}`);
  } else {
    console.log(`  FAIL ${t.padEnd(34)} ${summary}`);
    failed.push({ t, out });
  }
}

if (failed.length) {
  for (const { t, out } of failed) {
    console.error(`\n${'─'.repeat(70)}\n${t}\n${'─'.repeat(70)}\n${out}`);
  }
  console.error(`\n${failed.length} of ${tests.length} migration test file(s) failed.\n`);
  process.exit(1);
}

console.log(`\nAll ${tests.length} migration test file(s) passed.\n`);
