#!/usr/bin/env node
/**
 * run-all.mjs — the full pre-ship suite, in ONE Node process.
 *
 * Why this exists: an inline bash `for f in tests/*; do node "$f" >/tmp/x 2>&1 ...`
 * loop trips a Git Bash / MINGW redirect quirk on Windows ("stdout is not a tty",
 * every command fails identically before the test runs). This runner spawns each
 * child itself and captures output in-process, so there is no shell redirect to
 * mangle — it behaves the same on Windows, macOS and Linux.
 *
 * Runs: server build → unit tests → migration tests → gates → type-checks.
 * node:sqlite tests are skipped (not failed) when the runtime lacks the module
 * (Node < 22.5), the same way CI splits them onto its Node-22 lane.
 *
 *   node scripts/run-all.mjs
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const NODE = process.execPath;

let pass = 0, fail = 0, skip = 0;
const say = (s = '') => process.stdout.write(s + '\n');
const tail = (out, n) => out.split('\n').filter(Boolean).slice(-n).map(l => '        ' + l).join('\n');

// Run a node script; capture output in-process (no shell redirect).
function node(args, { cwd = ROOT } = {}) {
  return spawnSync(NODE, args, { cwd, encoding: 'utf8' });
}

// node:sqlite exists only on Node >= 22.5 — probe once.
const hasSqlite = node(['-e', "require('node:sqlite')"]).status === 0;
say(`\nNode ${process.version} — node:sqlite ${hasSqlite ? 'available' : 'NOT available (those tests will skip)'}`);

// ── 0. Build the server (dist/ is needed by the tests that import from it) ────
say('\n── Building server (for dist-dependent tests) ──');
{
  const r = spawnSync('npm', ['run', 'build'], { cwd: path.join(ROOT, 'apps/server'), encoding: 'utf8', shell: true });
  if (r.status === 0) say('  OK    apps/server built');
  else { fail++; say('  FAIL  apps/server build'); say(tail((r.stdout || '') + (r.stderr || ''), 8)); }
}

// ── 1. Unit tests ────────────────────────────────────────────────────────────
say('\n── Unit tests (tests/*.test.mjs) ──');
const testDir = path.join(ROOT, 'tests');
for (const f of readdirSync(testDir).filter(f => f.endsWith('.test.mjs')).sort()) {
  const full = path.join(testDir, f);
  // Skip only files that genuinely IMPORT node:sqlite — not ones that merely
  // mention it in a comment (that false-skips register-status-parse on Node 20).
  const importsSqlite = /(?:from|require\()\s*['"]node:sqlite['"]/.test(readFileSync(full, 'utf8'));
  if (!hasSqlite && importsSqlite) {
    skip++; say(`  SKIP  ${f}  (needs Node 22 — node:sqlite)`); continue;
  }
  const r = node(['--no-warnings', full]);
  if (r.status === 0) { pass++; say(`  PASS  ${f}`); }
  else { fail++; say(`  FAIL  ${f}`); say(tail((r.stdout || '') + (r.stderr || ''), 6)); }
}

// ── 2. Migration tests ─────────────────────────────────────────────────────────
say('\n── Migration tests (PGlite) ──');
{
  const r = node([path.join(ROOT, 'scripts', 'run-migration-tests.mjs')]);
  const last = (r.stdout || '').trim().split('\n').slice(-1)[0] || '';
  if (r.status === 0) { pass++; say(`  PASS  ${last.trim()}`); }
  else { fail++; say('  FAIL  migration tests'); say(tail((r.stdout || '') + (r.stderr || ''), 8)); }
}

// ── 3. Gates ──────────────────────────────────────────────────────────────────
say('\n── Gates (scripts/check-*.mjs) ──');
const scriptDir = path.join(ROOT, 'scripts');
for (const f of readdirSync(scriptDir).filter(f => /^check-.*\.mjs$/.test(f)).sort()) {
  const r = node([path.join(scriptDir, f)]);
  if (r.status === 0) say(`  OK    ${f}`);
  else { fail++; say(`  FAIL  ${f}`); say(tail((r.stdout || '') + (r.stderr || ''), 4)); }
}

// ── 4. Type-checks ────────────────────────────────────────────────────────────
say('\n── Type-checks ──');
function tsc(dir, args, label) {
  const r = spawnSync('npx', ['tsc', ...args], { cwd: path.join(ROOT, dir), encoding: 'utf8', shell: true });
  if (r.status === 0) say(`  OK    ${label}`);
  else { fail++; say(`  FAIL  ${label}`); say(tail((r.stdout || '') + (r.stderr || ''), 8)); }
}
tsc('apps/server', ['--noEmit'], 'server tsc');
tsc('apps/desktop', ['-p', 'tsconfig.json', '--noEmit'], 'renderer tsc (main tsconfig.main has known pre-existing errors)');

// ── Summary ───────────────────────────────────────────────────────────────────
say('\n' + '─'.repeat(64));
say(fail === 0
  ? `  == GREEN ==  ${pass} passed, ${skip} skipped${skip ? ' (run under Node 22 to cover them)' : ''}`
  : `  == ${fail} FAILED ==  (${pass} passed, ${skip} skipped) — see above`);
process.exit(fail === 0 ? 0 : 1);
