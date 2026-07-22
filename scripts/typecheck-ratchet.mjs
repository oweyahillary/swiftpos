#!/usr/bin/env node
/**
 * typecheck-ratchet.mjs — a one-way gate on TypeScript errors.
 *
 * WHY THIS EXISTS
 *   apps/server used to build with `tsc ... || true`, so type errors never failed
 *   a build and 125 accumulated silently — several were live runtime bugs (a Zod
 *   v4 API change that turned every 400 into a 500, six `.catch()` calls on
 *   Supabase builders that threw TypeError, an inert auth rate limiter, and a
 *   fuel report that always returned zeros).
 *
 *   The server is now at 0 and `|| true` is gone: `npm run build` fails on any
 *   type error, so the server needs no ratchet. This still guards apps/dashboard
 *   and apps/admin, where `vite build` strips types WITHOUT checking them —
 *   nothing else there would ever catch a type error.
 *
 * BEHAVIOUR
 *   errors  >  baseline  -> exit 1  (you added new type errors)
 *   errors  <  baseline  -> exit 1  (you fixed some — lower the baseline, it's
 *                                    a one-line change; this keeps the ratchet
 *                                    tight instead of quietly drifting)
 *   errors === baseline  -> exit 0
 *
 * GOAL
 *   Drive dashboard to 0 too, then set strict:true and start the cycle again.
 *   (Measured on the server at time of writing: strictNullChecks costs +8,
 *   full strict +27 — a separate piece of work.)
 *
 * USAGE
 *   node scripts/typecheck-ratchet.mjs            # check all workspaces
 *   node scripts/typecheck-ratchet.mjs server     # check one
 *   node scripts/typecheck-ratchet.mjs --update   # rewrite baselines to current
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_FILE = resolve(ROOT, 'scripts/typecheck-baseline.json');

const WORKSPACES = {
  server:    'apps/server',
  dashboard: 'apps/dashboard',
  admin:     'apps/admin',
};

const args = process.argv.slice(2);
const update = args.includes('--update');
const only = args.filter(a => !a.startsWith('--'));

const baseline = existsSync(BASELINE_FILE)
  ? JSON.parse(readFileSync(BASELINE_FILE, 'utf8'))
  : {};

function countErrors(dir) {
  const cwd = resolve(ROOT, dir);
  if (!existsSync(resolve(cwd, 'node_modules'))) return { skipped: 'node_modules missing — run npm ci' };
  let out = '';
  try {
    out = execSync('npx tsc --noEmit', { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    // tsc exits non-zero when there are errors; that's the normal path here.
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  const errors = out.split('\n').filter(l => /error TS\d+:/.test(l));
  return { count: errors.length, errors };
}

const targets = only.length ? only : Object.keys(WORKSPACES);
let failed = false;
const next = { ...baseline };

console.log('TypeScript error ratchet\n' + '='.repeat(58));

for (const name of targets) {
  const dir = WORKSPACES[name];
  if (!dir) { console.error(`unknown workspace: ${name}`); process.exit(2); }

  const res = countErrors(dir);
  if (res.skipped) { console.log(`${name.padEnd(11)} SKIPPED — ${res.skipped}`); continue; }

  const { count } = res;
  const base = baseline[name];

  if (update || base === undefined) {
    next[name] = count;
    console.log(`${name.padEnd(11)} baseline set to ${count}`);
    continue;
  }

  const delta = count - base;
  if (delta > 0) {
    failed = true;
    console.log(`${name.padEnd(11)} ❌ ${count} errors (baseline ${base}, +${delta})`);
    // Show only the new ones' files so the author can find them fast.
    const files = [...new Set(res.errors.map(l => l.split('(')[0]))];
    console.log(`${' '.repeat(13)}files with errors: ${files.join(', ')}`);
  } else if (delta < 0) {
    failed = true;
    console.log(`${name.padEnd(11)} ✅ ${count} errors — ${Math.abs(delta)} fewer than baseline ${base}!`);
    console.log(`${' '.repeat(13)}Lower it: set "${name}": ${count} in scripts/typecheck-baseline.json`);
    console.log(`${' '.repeat(13)}(or run: node scripts/typecheck-ratchet.mjs --update)`);
  } else {
    console.log(`${name.padEnd(11)} ✓  ${count} errors (baseline held)`);
  }
}

if (update) {
  writeFileSync(BASELINE_FILE, JSON.stringify(next, null, 2) + '\n');
  console.log(`\nWrote ${BASELINE_FILE}`);
  process.exit(0);
}

console.log('='.repeat(58));
if (failed) {
  console.log('Ratchet failed. The error count must never rise; when it falls, lower the baseline.');
  process.exit(1);
}
console.log('Ratchet OK.');
