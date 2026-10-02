#!/usr/bin/env node
/**
 * run-migration-tests.mjs — run every migration test against real PostgreSQL (PGlite).
 *
 * WHY THIS EXISTS
 * ---------------
 * This repository has tested migrations against PGlite since migration 41, and had six
 * such scripts by 2026-08-10. **None of them ran in CI**, and the consequences were
 * exactly what you would expect from a test nothing invokes:
 *   * test-migration-47.mjs pointed at an absolute sandbox path and had never run — 19
 *     dead assertions.
 *   * Migration 74 shipped a CREATE OR REPLACE VIEW Postgres refuses (42P16) and reached
 *     the owner's database.
 *
 * DISCOVERY, NOT A LIST
 * ---------------------
 * Globbing scripts/test-migration*.mjs rather than enumerating them: a hand-kept list is
 * one more thing to forget. A new migration test is picked up by existing.
 *
 * PER-TEST TIMEOUT (A305)
 * -----------------------
 * On 2026-09-21 a single test whose async assertions were not awaited never printed its
 * summary and never exited; the sequential runner had no timeout, so the CI job hung for
 * ~30 minutes before anyone noticed. A hang must fail FAST and NAMED, not stall the job.
 * Every test now runs under a hard timeout (default 120s; a healthy test is a few seconds);
 * on timeout the child is SIGKILLed and the test is reported as a FAILURE.
 *
 * PARALLEL, BOUNDED
 * -----------------
 * PGlite instances are in-process, in-memory, port-less and file-less, so tests are fully
 * isolated and safe to run concurrently. A bounded pool (default min(cpus, 4)) cuts the
 * wall-clock of ~30 cold PGlite boots without exhausting RAM (~150 MB each). Each test
 * still runs in its own process so one crash cannot take the rest with it, and every
 * failure is reported rather than stopping at the first.
 *
 * Config: MIGRATION_TEST_TIMEOUT_MS (default 120000), MIGRATION_TEST_CONCURRENCY (default
 * min(cpus, 4)). `--self-test` proves the runner catches a failing AND a hanging test.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const TIMEOUT_MS = Number(process.env.MIGRATION_TEST_TIMEOUT_MS) || 120_000;
const CONCURRENCY = Math.max(1, Number(process.env.MIGRATION_TEST_CONCURRENCY)
  || Math.min(os.cpus().length || 1, 4));

/** Run one test file in its own process, under a hard timeout. Never rejects. */
function runOne(dir, file, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--no-warnings', path.join(dir, file)],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ t: file, status: 1, out: `${out}\nspawn error: ${err.message}`, timedOut: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // A timeout is a FAILURE, never a silent pass — that is the whole point (A305).
      resolve({ t: file, status: timedOut ? 1 : (code ?? 1), out, timedOut });
    });
  });
}

function summaryOf(out) {
  return (out.match(/(\d+) passed, (\d+) failed/) || [])[0]
    ?? (() => {
      const n = (out.match(/^PASS\b/gm) || []).length;
      const f = (out.match(/^FAIL\b/gm) || []).length;
      return n || f ? `${n} passed, ${f} failed` : '';
    })();
}

/** A bounded worker pool over `files`, printing each result as it finishes. */
async function runPool(dir, files, { timeoutMs = TIMEOUT_MS, concurrency = CONCURRENCY } = {}) {
  const failed = [];
  let idx = 0;
  const worker = async () => {
    while (idx < files.length) {
      const file = files[idx++];
      const r = await runOne(dir, file, timeoutMs);
      const label = r.timedOut ? `TIMED OUT after ${Math.round(timeoutMs / 1000)}s` : summaryOf(r.out);
      console.log(`  ${r.status === 0 ? 'ok  ' : 'FAIL'} ${file.padEnd(34)} ${label}`);
      if (r.status !== 0) failed.push(r);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  return failed;
}

async function selfTest() {
  // The mutation the runner must survive: a test that FAILS and a test that HANGS both have
  // to be reported red. A runner that lets either through is worse than no runner (A305 / rule 23).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-runner-selftest-'));
  fs.writeFileSync(path.join(tmp, 'test-migration-pass.mjs'), `console.log('1 passed, 0 failed'); process.exit(0);\n`);
  fs.writeFileSync(path.join(tmp, 'test-migration-fail.mjs'), `console.log('0 passed, 1 failed'); process.exit(1);\n`);
  fs.writeFileSync(path.join(tmp, 'test-migration-hang.mjs'), `setInterval(() => {}, 1000); // never exits\n`);

  const pass = await runOne(tmp, 'test-migration-pass.mjs', 3000);
  const fail = await runOne(tmp, 'test-migration-fail.mjs', 3000);
  const hang = await runOne(tmp, 'test-migration-hang.mjs', 1500);
  fs.rmSync(tmp, { recursive: true, force: true });

  const checks = [
    ['a passing test is reported ok',            pass.status === 0 && !pass.timedOut],
    ['a failing (exit 1) test is reported FAIL',  fail.status === 1 && !fail.timedOut],
    ['a hanging test is KILLED and reported FAIL', hang.status === 1 && hang.timedOut === true],
  ];
  let ok = true;
  for (const [name, cond] of checks) { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}`); if (!cond) ok = false; }
  console.log(`\nrun-migration-tests self-test: ${checks.filter(c => c[1]).length}/${checks.length} passed`);
  process.exit(ok ? 0 : 1);
}

if (process.argv.includes('--self-test')) {
  await selfTest();
} else {
  const tests = fs.readdirSync(HERE)
    .filter(f => /^test-migrations?[-\d].*\.mjs$/.test(f))
    .sort();
  if (tests.length === 0) {
    console.error('No migration tests found in scripts/ — has the naming changed?');
    process.exit(1);
  }
  console.log(`\nMigration tests against real PostgreSQL (PGlite) — ${tests.length} file(s), `
    + `${CONCURRENCY}-way, ${Math.round(TIMEOUT_MS / 1000)}s/test timeout\n`);

  const failed = await runPool(HERE, tests);

  if (failed.length) {
    for (const { t, out, timedOut } of failed) {
      console.error(`\n${'─'.repeat(70)}\n${t}${timedOut ? '  (TIMED OUT)' : ''}\n${'─'.repeat(70)}\n${out}`);
    }
    console.error(`\n${failed.length} of ${tests.length} migration test file(s) failed.\n`);
    process.exit(1);
  }
  console.log(`\nAll ${tests.length} migration test file(s) passed.\n`);
}
