#!/usr/bin/env node
/**
 * migrate.mjs — apply OUTSTANDING forward migrations to an already-initialised
 * database, and record the run. This is the tool you point at production.
 *
 * WHAT IT DOES (and pointedly does NOT do)
 *   • Applies every migrations/NN_*.sql whose version is not yet in
 *     public.schema_migrations, in numeric order, and stamps each one.
 *   • Writes one row per run to public.schema_migration_runs (running → success
 *     / failed) so CI and any dashboard can see history and failures.
 *   • It has NO baseline path and NO --reset path. It cannot DROP or recreate
 *     anything. If the database was never initialised from the baseline it
 *     refuses and tells you to run setup-clean-db.sh — so this tool can never
 *     "set up" prod by surprise, only move it forward.
 *
 * SAFE TO RE-RUN. If nothing is pending it is a no-op (and records a no-op run).
 *
 * USAGE
 *   export DATABASE_URL='postgresql://postgres.<ref>:PW@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require'
 *   node scripts/migrate.mjs --plan     # list what WOULD apply, change nothing
 *   node scripts/migrate.mjs            # apply pending migrations
 *
 * OPTIONAL ENV (surfaced in the audit row; CI fills these automatically)
 *   MIGRATE_ENV     label, e.g. "production"
 *   GIT_SHA         commit being deployed
 *   TRIGGERED_BY    who/what launched it
 *
 * EXIT CODES  0 = applied or nothing to do   1 = a migration failed   2 = guard/preflight
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIG_DIR = path.join(HERE, '..', 'migrations');
const PLAN = process.argv.includes('--plan') || process.argv.includes('--dry-run');

const DB = process.env.DATABASE_URL;
if (!DB) { console.error('✗ set DATABASE_URL (session-pooler connection string).'); process.exit(2); }
if (/:6543\b/.test(DB)) {
  console.error('✗ that looks like the transaction pooler (:6543). Use session mode (:5432) for migrations.');
  process.exit(2);
}

const ENVLABEL = process.env.MIGRATE_ENV || 'unspecified';
const GIT_SHA  = process.env.GIT_SHA || process.env.GITHUB_SHA || '';
const ACTOR    = process.env.TRIGGERED_BY || process.env.GITHUB_ACTOR || '';

// ── psql helpers (conn string via -d so option order can't drop -f/-c) ────────
function psql(extra, { input } = {}) {
  return spawnSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, ...extra],
    { input, encoding: 'utf8' });
}
function val(sql) {                          // scalar read, '' if none / on error
  const r = spawnSync('psql', ['-X', '-A', '-t', '-q', '-d', DB, '-c', sql], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}
function exec(sql) {                          // write; throws on failure
  const r = psql(['-c', sql]);
  if (r.status !== 0) throw new Error((r.stderr || '').trim() || `psql exit ${r.status}`);
}
// SQL literal from a JS value. psql's `:'x'` interpolation is NOT applied to -c
// command strings on some builds (it fails with "syntax error at or near :"), so
// values are embedded here, single-quote-escaped. standard_conforming_strings is
// on by default (PG 9.1+), so doubling ' is sufficient and backslashes are literal.
function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

// ── preflight ────────────────────────────────────────────────────────────────
{
  const r = spawnSync('psql', ['-X', '-q', '-d', DB, '-c', 'select 1'], { encoding: 'utf8' });
  if (r.status !== 0) {
    const e = (r.stderr || '').trim();
    console.error(`✗ cannot connect: ${e}`);
    if (/translate host name|Unknown host/i.test(e))
      console.error('  db.<ref>.supabase.co is IPv6-only — use the Session pooler string (port 5432).');
    process.exit(2);
  }
}

// GUARD: this tool only moves an initialised DB forward. No schema_migrations
// table means the baseline was never applied — refuse rather than guess.
if (val("select to_regclass('public.schema_migrations')") === '') {
  console.error('✗ public.schema_migrations does not exist — this database has not been initialised.');
  console.error('  migrate.mjs only applies incremental migrations. Initialise first with scripts/setup-clean-db.sh.');
  process.exit(2);
}

// ── audit table (runner-owned infrastructure; safe to ensure every run) ──────
exec(`
  CREATE TABLE IF NOT EXISTS public.schema_migration_runs (
    id               uuid PRIMARY KEY,
    started_at       timestamptz NOT NULL DEFAULT now(),
    finished_at      timestamptz,
    status           text NOT NULL DEFAULT 'running'
                     CHECK (status IN ('running','success','failed','noop')),
    environment      text,
    git_sha          text,
    triggered_by     text,
    planned          int  NOT NULL DEFAULT 0,
    applied          int  NOT NULL DEFAULT 0,
    applied_versions jsonb NOT NULL DEFAULT '[]'::jsonb,
    failed_version   text,
    error            text
  );
  ALTER TABLE public.schema_migration_runs ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS schema_migration_runs_service_only ON public.schema_migration_runs;
  CREATE POLICY schema_migration_runs_service_only ON public.schema_migration_runs
    FOR ALL TO service_role USING (true) WITH CHECK (true);
  COMMENT ON TABLE public.schema_migration_runs IS
    'One row per migrate.mjs run. Read by CI and the admin dashboard for history/failures.';
`);

// ── compute pending, numeric order ───────────────────────────────────────────
const files = fs.readdirSync(MIG_DIR)
  .filter(f => /^\d+.*\.sql$/.test(f))
  .filter(f => !/^(00_baseline|01_schema_migrations)\.sql$/.test(f))
  .sort((a, b) => (parseInt(a) - parseInt(b)) || a.localeCompare(b));

const appliedSet = new Set(
  val('select version from public.schema_migrations').split('\n').map(s => s.trim()).filter(Boolean)
);
const pending = files.filter(f => !appliedSet.has(f.replace(/\.sql$/, '')));

console.log(`\nmigrate · env=${ENVLABEL}${GIT_SHA ? ` · sha=${GIT_SHA.slice(0, 7)}` : ''}`);
console.log(`  pending: ${pending.length}` + (pending.length ? '' : ' (nothing to do)'));
pending.forEach(f => console.log(`    • ${f.replace(/\.sql$/, '')}`));

if (PLAN) { console.log('\n(plan only — nothing applied)'); process.exit(0); }

// ── record the run ───────────────────────────────────────────────────────────
const runId = randomUUID();
exec(
  `INSERT INTO public.schema_migration_runs
     (id, status, environment, git_sha, triggered_by, planned)
   VALUES (${lit(runId)}::uuid, 'running', NULLIF(${lit(ENVLABEL)},''), NULLIF(${lit(GIT_SHA)},''), NULLIF(${lit(ACTOR)},''), ${lit(pending.length)}::int)`
);

if (pending.length === 0) {
  exec(`UPDATE public.schema_migration_runs SET finished_at=now(), status='noop' WHERE id=${lit(runId)}::uuid`);
  console.log('✓ up to date.');
  process.exit(0);
}

// ── apply ────────────────────────────────────────────────────────────────────
const done = [];
for (const f of pending) {
  const stem = f.replace(/\.sql$/, '');
  process.stdout.write(`  → ${stem} … `);
  const r = psql(['-f', path.join(MIG_DIR, f)]);
  if (r.status !== 0) {
    const err = (r.stderr || '').trim();
    console.log('FAILED');
    try {
      exec(
        `UPDATE public.schema_migration_runs
           SET finished_at=now(), status='failed', applied=${lit(done.length)}::int,
               applied_versions=${lit(JSON.stringify(done))}::jsonb, failed_version=${lit(stem)}, error=${lit(err)}
         WHERE id=${lit(runId)}::uuid`
      );
    } catch { /* logging must never mask the real failure */ }
    console.error(`\n✗ ${stem} failed:\n${err}`);
    console.error(`  ${done.length} migration(s) applied before the failure were committed and stamped.`);
    process.exit(1);
  }
  // stamp (harmless no-op for files that self-record via ON CONFLICT)
  exec(
    `INSERT INTO public.schema_migrations(version, notes)
     VALUES (${lit(stem)}, 'applied by migrate.mjs') ON CONFLICT (version) DO NOTHING`
  );
  done.push(stem);
  console.log('ok');
}

exec(
  `UPDATE public.schema_migration_runs
     SET finished_at=now(), status='success', applied=${lit(done.length)}::int, applied_versions=${lit(JSON.stringify(done))}::jsonb
   WHERE id=${lit(runId)}::uuid`
);
console.log(`\n✓ applied ${done.length} migration(s). Highest now: ${val("select version from public.schema_migrations where version ~ '^[0-9]' order by (split_part(version,'_',1))::int desc nulls last limit 1")}`);
process.exit(0);
