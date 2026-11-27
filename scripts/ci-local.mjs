#!/usr/bin/env node
/**
 * ci-local — run the OFFLINE CI gates locally, in CI's order, with the two fixes that make the signal trustworthy on a dev
 * box (both learned the hard way on 2026-11-27):
 *
 *   1. BUILD THE SERVER FIRST, so the runtime suites import current source. A stale apps/server/dist passed login-otp.test
 *      locally while CI failed it — the miss that started this script.
 *   2. TOLERATE THE WINDOWS LIBUV TEARDOWN CRASH: a native-SQLite test can print "N passed, 0 failed" and then exit
 *      non-zero with "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING) ... src\\win\\async.c". That is a PASS — CI's
 *      Linux runners never hit it. For the test suites we read the "passed, failed" tally, not the exit code.
 *
 * It does NOT run the jobs that need things a laptop hasn't got — migrations against a real Postgres, the gitleaks secret
 * scan, the dashboard/admin/electron app builds. Those run only in GitHub CI. This is the pre-commit "did I break anything
 * offline" pass.  Run:  npm run ci-local   (or: node scripts/ci-local.mjs)
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';
const t0 = Date.now();

const results = [];   // { label, ok, detail }

function sh(label, cmd, args, opts = {}) {
  process.stdout.write(`\n── ${label}\n`);
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  return { code: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
const lastLines = (out, n = 2) => out.trim().split('\n').slice(-n).join(' / ');

// A test file passes if its own tally says 0 failed — even if the process then crashed on exit (Windows libuv teardown).
function testVerdict(out, code) {
  const m = [...out.matchAll(/(\d+)\s+passed,\s+(\d+)\s+failed/g)].pop();
  if (m) return { ok: Number(m[2]) === 0, failed: Number(m[2]) };
  if (/\bFAIL\b/.test(out)) return { ok: false };
  if (code === 0) return { ok: true };
  // non-zero with no tally: a pass only if it clearly ran and crashed on teardown
  return { ok: /UV_HANDLE_CLOSING/.test(out) && /\bpassed\b/.test(out) };
}

function record(label, ok, detail = '') {
  results.push({ label, ok, detail });
  process.stdout.write(`   ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? '  — ' + detail : ''}\n`);
}

// ── 1. Type-check ratchet ─────────────────────────────────────────────────────
{
  const { code, out } = sh('Type-check ratchet (server dashboard admin)', 'node', ['scripts/typecheck-ratchet.mjs', 'server', 'dashboard', 'admin']);
  record('typecheck-ratchet', code === 0, code === 0 ? '' : lastLines(out, 3));
}

// ── 2. Build the server FIRST (so the runtime suites are not stale) ────────────
{
  const { code, out } = sh('Build server', npm, ['run', 'build'], { cwd: path.join(ROOT, 'apps/server'), shell: isWin });
  record('build-server', code === 0, code === 0 ? '' : lastLines(out, 3));
}

// ── 3. Desktop type-check, and BUILD the main process ──────────────────────────
// The renderer is type-checked (noEmit); the main process is built to dist/main because the apps/desktop/test suites
// require() the COMPILED main (shiftService, localDb, syncEngine…). Skip this and those tests run against stale dist — the
// miss that let a shift-report change through local checks while CI caught it (2026-11-27).
{
  const { code, out } = sh('Desktop type-check (renderer + main)', npm, ['run', 'type-check'], { cwd: path.join(ROOT, 'apps/desktop'), shell: isWin });
  record('desktop-type-check', code === 0, code === 0 ? '' : lastLines(out, 3));
}
{
  const { code, out } = sh('Build desktop main (dist/main, for the desktop test suite)', npm, ['exec', '--', 'tsc', '-b', 'tsconfig.main.json'], { cwd: path.join(ROOT, 'apps/desktop'), shell: isWin });
  record('build-desktop-main', code === 0, code === 0 ? '' : lastLines(out, 3));
}

// ── 4. The check-* sweep + the non-check gates (the full sweep, per CI) ────────
const checks = fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => /^check-.*\.mjs$/.test(f)).sort();
for (const f of checks) {
  const { code, out } = sh(`scripts/${f}`, 'node', [`scripts/${f}`]);
  record(f, code === 0, code === 0 ? '' : lastLines(out));
}
const gates = [
  ['build-light-colours.mjs --check', ['scripts/build-light-colours.mjs', '--check']],
  ['build-escpos-renderer.mjs --check', ['scripts/build-escpos-renderer.mjs', '--check']],
  ['schema-parity.mjs', ['scripts/schema-parity.mjs']],
  ['ops-audit-summary.mjs --self-test', ['scripts/ops-audit-summary.mjs', '--self-test']],
  ['run-migration-tests.mjs --self-test', ['scripts/run-migration-tests.mjs', '--self-test']],
];
for (const [label, args] of gates) {
  const { code, out } = sh(label, 'node', args);
  record(label, code === 0, code === 0 ? '' : lastLines(out));
}

// ── 5. Offline suites: tests/*.test.mjs and the desktop units (Windows crash tolerated) ──
// A few desktop suites can't run RELIABLY on a Windows dev box — CI's Linux runners cover them, so they are SKIPPED here,
// not failed. SQLite's `localtime` resolves differently on Windows (these assert local-hour buckets), and theme-vars reads
// CSS that is only produced by the app build (not run here). If you add a Windows-incompatible suite, list it with its why.
const CI_ONLY = new Map([
  ['apps/desktop/test/money-reports.test.mjs',     'SQLite localtime differs on Windows (asserts local-hour buckets)'],
  ['apps/desktop/test/silent-update-a508.test.mjs', 'SQLite localtime differs on Windows (asserts local-hour buckets)'],
  ['apps/desktop/test/theme-vars.test.mjs',        'reads compiled CSS (produced only by the app build)'],
]);
const skipped = [];
function suite(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return;
  for (const f of fs.readdirSync(abs).filter((x) => x.endsWith('.test.mjs')).sort()) {
    const rel = `${dir}/${f}`;
    if (CI_ONLY.has(rel)) { skipped.push(rel); process.stdout.write(`\n── ${rel}\n   SKIP ${rel}  — CI-only: ${CI_ONLY.get(rel)}\n`); continue; }
    const { code, out } = sh(rel, 'node', ['--no-warnings', rel]);
    const v = testVerdict(out, code);
    const crashed = code !== 0 && v.ok;
    record(rel, v.ok, !v.ok ? (v.failed != null ? `${v.failed} failed` : lastLines(out)) : (crashed ? 'passed (ignored Windows teardown crash)' : ''));
  }
}
suite('tests');
suite('apps/desktop/test');

// ── Summary ────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
const secs = Math.round((Date.now() - t0) / 1000);
process.stdout.write(`\n${'='.repeat(64)}\n`);
process.stdout.write(`ci-local: ${results.length - failed.length}/${results.length} gates OK${skipped.length ? `, ${skipped.length} skipped (CI-only)` : ''}  (${secs}s)\n`);
if (failed.length) process.stdout.write(`FAILED:\n${failed.map((r) => `  - ${r.label}${r.detail ? '  — ' + r.detail : ''}`).join('\n')}\n`);
if (skipped.length) process.stdout.write(`SKIPPED (Windows can't run these; GitHub CI does): ${skipped.map((s) => s.split('/').pop()).join(', ')}\n`);
process.stdout.write(`${'='.repeat(64)}\n`);
process.stdout.write(`NOT run here (GitHub CI only): migrations vs a real Postgres, the gitleaks secret scan, the dashboard/admin/electron app builds, and the Windows-incompatible desktop suites above.\n`);
process.exit(failed.length ? 1 : 0);
