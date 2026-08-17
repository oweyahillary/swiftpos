#!/usr/bin/env node
/**
 * verify-db-schema.mjs — hard-confirm a live database matches what the codebase
 * expects, by diffing it against scripts/schema-index.json.
 *
 * WHAT IT COMPARES
 *   Ground truth for the LIVE database is scripts/build-schema-index.sql — the
 *   same information_schema query that generates schema-index.json in the first
 *   place (build-schema-index.mjs --from-db). Comparing like with like means a
 *   difference is a real difference, not a formatting artefact.
 *
 * WHAT A FINDING MEANS
 *   • MISSING table/column  (in the index, not in the DB)  → CRITICAL. The code
 *     expects it; queries will fail at runtime. This is what a half-applied or
 *     out-of-date migration set looks like. Exit code 1.
 *   • TYPE/NULL mismatch     → CRITICAL. Same column, different shape. Exit 1.
 *   • EXTRA table/column     (in the DB, not in the index) → informational. The
 *     DB is ahead of the index (e.g. a new migration whose objects were never
 *     folded into schema-index.json). Not a failure on its own.
 *
 * ALSO CHECKED
 *   RLS coverage: any public BASE TABLE with row-level security disabled is
 *   listed. This app enables RLS on every table; a gap is worth seeing.
 *
 * USAGE
 *   export DATABASE_URL='postgresql://postgres.<ref>:PW@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require'
 *   node scripts/verify-db-schema.mjs           # exit 1 if the DB is missing anything
 *   node scripts/verify-db-schema.mjs --strict  # also fail on EXTRA / RLS gaps
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(HERE, 'schema-index.json');
const INTROSPECT_SQL = path.join(HERE, 'build-schema-index.sql');
const STRICT = process.argv.includes('--strict');

const DB = process.env.DATABASE_URL;
if (!DB) {
  console.error('✗ set DATABASE_URL (session-pooler connection string) before running.');
  process.exit(2);
}

// -- run a query and return stdout, or exit with guidance -----------------------
function psql(args, { input } = {}) {
  const res = spawnSync('psql', ['-X', '-A', '-t', '-q', '-d', DB, ...args],
    { input, encoding: 'utf8' });
  if (res.error) {
    console.error(`✗ could not run psql: ${res.error.message}\n  Is the PostgreSQL client on your PATH?`);
    process.exit(2);
  }
  if (res.status !== 0) {
    const err = (res.stderr || '').trim();
    console.error(`✗ psql failed: ${err}`);
    if (/could not translate host name|Unknown host/i.test(err)) {
      console.error('  The direct db.<ref>.supabase.co host is IPv6-only. Use the Session pooler string (port 5432).');
    }
    process.exit(2);
  }
  return res.stdout;
}

// -- 1. live schema, via the repo's authoritative introspection SQL -------------
const liveRaw = psql(['-f', INTROSPECT_SQL]).trim();
if (!liveRaw) {
  console.error('✗ introspection returned nothing — is the schema empty / wrong database?');
  process.exit(2);
}
let live, expected;
try { live = JSON.parse(liveRaw); }
catch (e) { console.error('✗ could not parse live schema JSON:', e.message); process.exit(2); }
try { expected = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8')); }
catch (e) { console.error(`✗ could not read ${INDEX_PATH}:`, e.message); process.exit(2); }

// -- 2. diff --------------------------------------------------------------------
const missingTables = [];
const missingColumns = [];   // "table.column"
const mismatches = [];        // "table.column: expected X / got Y"
const extraTables = [];
const extraColumns = [];      // "table.column"

for (const [table, cols] of Object.entries(expected)) {
  if (!(table in live)) { missingTables.push(table); continue; }
  for (const [col, type] of Object.entries(cols)) {
    if (!(col in live[table])) { missingColumns.push(`${table}.${col}`); continue; }
    if (live[table][col] !== type)
      mismatches.push(`${table}.${col}: index="${type}" db="${live[table][col]}"`);
  }
}
for (const [table, cols] of Object.entries(live)) {
  if (!(table in expected)) { extraTables.push(table); continue; }
  for (const col of Object.keys(cols))
    if (!(col in expected[table])) extraColumns.push(`${table}.${col}`);
}

// -- 3. RLS coverage ------------------------------------------------------------
const rlsOff = psql(['-c',
  "select tablename from pg_tables where schemaname='public' and not rowsecurity order by 1"])
  .split('\n').map(s => s.trim()).filter(Boolean);

// -- 4. report ------------------------------------------------------------------
const line = (label, arr) => {
  if (!arr.length) { console.log(`  ✓ ${label}: none`); return; }
  console.log(`  ✗ ${label}: ${arr.length}`);
  for (const x of arr) console.log(`      - ${x}`);
};

console.log(`\nDB schema vs scripts/schema-index.json`);
console.log(`  tables in index: ${Object.keys(expected).length}   tables in DB: ${Object.keys(live).length}\n`);

console.log('CRITICAL (code expects, DB lacks)');
line('missing tables', missingTables);
line('missing columns', missingColumns);
line('type / nullability mismatches', mismatches);

console.log('\nINFORMATIONAL (DB ahead of the index)');
line('extra tables', extraTables);
line('extra columns', extraColumns);

console.log('\nRLS');
line('public tables with RLS disabled', rlsOff);

const critical = missingTables.length + missingColumns.length + mismatches.length;
const soft = extraTables.length + extraColumns.length + rlsOff.length;

console.log('');
if (critical > 0) {
  console.log(`✗ FAIL — ${critical} critical difference(s). The migration set is not fully applied,`);
  console.log('  or the DB predates part of the code. Re-run scripts/setup-clean-db.sh and investigate.');
  process.exit(1);
}
if (STRICT && soft > 0) {
  console.log(`✗ FAIL (--strict) — ${soft} soft difference(s) (extra objects / RLS gaps).`);
  process.exit(1);
}
console.log('✓ PASS — every table and column the codebase expects is present in the database.');
if (soft > 0) console.log(`  (${soft} informational difference(s) above — DB is ahead of the index; usually fine.)`);
process.exit(0);
