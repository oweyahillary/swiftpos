#!/usr/bin/env node
/**
 * check-rls-coverage.mjs — fail the build when a migration creates a table in
 * the public schema without saying anything about Row Level Security.
 *
 * Migration 29 enabled RLS everywhere on the reasoning that the anon key ships
 * inside every dashboard bundle. Migrations 44 and 45 then created three tables
 * and said nothing, and nobody noticed for a day, because the convention lived
 * only in the head of whoever wrote 29. scripts/verify_rls_coverage.sql was
 * written to catch exactly this and its own header records why it never ran: CI
 * has no database connection.
 *
 * So this checks the MIGRATIONS rather than the database. It cannot tell you
 * what is true in production — verify_rls_coverage.sql still does that, and
 * should be run after every deploy — but it does not need credentials, so it can
 * run on every push, which is the difference between a check that exists and a
 * check that runs.
 *
 * A table passes if any migration mentions it in an RLS statement, whether
 * spelled directly or inside one of migration 29's FOREACH ARRAY[...] loops.
 * Deliberate exclusions belong in rls-coverage-exceptions.json with a reason —
 * the reason is the point, so nobody has to re-derive it later.
 *
 * NOTE: public.rls_auto_enable() exists in 00_baseline.sql and would enable RLS
 * on every newly created table automatically — but no CREATE EVENT TRIGGER
 * registers it anywhere in the migration set, so nothing here assumes it runs.
 * If it turns out to be live in production, this check is redundant but
 * harmless; if it is not, it is the only thing standing between you and another
 * unprotected table.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MIGRATIONS = path.join(ROOT, 'migrations');
const EXCEPTIONS = path.join(HERE, 'rls-coverage-exceptions.json');

const strip = (sql) => {
  let out = '', inLine = false, inBlock = false, inStr = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i], next = sql[i + 1];
    if (inLine) { if (ch === '\n') { inLine = false; out += ch; } continue; }
    if (inBlock) { if (ch === '*' && next === '/') { inBlock = false; i++; } continue; }
    if (inStr) { out += ch; if (ch === "'") inStr = false; continue; }
    if (ch === '-' && next === '-') { inLine = true; continue; }
    if (ch === '/' && next === '*') { inBlock = true; i++; continue; }
    if (ch === "'") { inStr = true; out += ch; continue; }
    out += ch;
  }
  return out;
};

const files = fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort((a, b) => {
  const na = parseInt(a, 10), nb = parseInt(b, 10);
  if (Number.isNaN(na) && Number.isNaN(nb)) return a.localeCompare(b);
  if (Number.isNaN(na)) return 1;
  if (Number.isNaN(nb)) return -1;
  return na - nb;
});

const created = new Map();   // table -> migration file that created it
const dropped = new Set();
const rlsNamed = new Set();  // tables named in any RLS statement

for (const f of files) {
  const sql = strip(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));

  for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?(\w+)"?\s*\(/gi)) {
    if (!created.has(m[1])) created.set(m[1], f);
  }
  for (const m of sql.matchAll(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?"?(\w+)"?/gi)) {
    dropped.add(m[1]);
  }

  // Direct: ALTER TABLE [IF EXISTS] [public.]x ENABLE ROW LEVEL SECURITY
  for (const m of sql.matchAll(
    /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?"?(\w+)"?\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi)) {
    rlsNamed.add(m[1]);
  }

  // Migration 29's shape: a DO block that loops an ARRAY[...] of table names and
  // EXECUTEs the ALTER with format(). Credit every name in an array inside a
  // block that mentions RLS.
  for (const block of sql.matchAll(/DO\s*\$\$([\s\S]*?)\$\$\s*;/gi)) {
    const body = block[1];
    if (!/ENABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(body)) continue;
    for (const arr of body.matchAll(/ARRAY\s*\[([\s\S]*?)\]/gi)) {
      for (const lit of arr[1].matchAll(/'([a-zA-Z_][\w]*)'/g)) rlsNamed.add(lit[1]);
    }
  }
}

let exceptions = {};
if (fs.existsSync(EXCEPTIONS)) {
  const raw = JSON.parse(fs.readFileSync(EXCEPTIONS, 'utf8'));
  // Keys starting with _ are documentation, not table names. Without this the
  // file's own README counted as an exception, inflating the reported number and
  // — worse — silently excepting any table that happened to share its name.
  exceptions = Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith('_')));
}

const missing = [];
for (const [table, file] of created) {
  if (dropped.has(table)) continue;
  if (rlsNamed.has(table)) continue;
  if (table in exceptions) continue;
  missing.push({ table, file });
}

console.log(`check-rls-coverage: ${created.size} tables created across ${files.length} migrations, ` +
            `${rlsNamed.size} named in an RLS statement, ${Object.keys(exceptions).length} excepted.`);

// The parser's own failure mode is matching nothing and declaring success.
if (created.size < 40) {
  console.error(`\nrefusing to pass: only ${created.size} CREATE TABLE statements found. ` +
                `The migration set is far larger than that, so the parse is broken.`);
  process.exit(2);
}

if (missing.length) {
  console.error(`\nFAIL — ${missing.length} table(s) created with no RLS statement:\n`);
  for (const { table, file } of missing) console.error(`  ${table.padEnd(30)} created in ${file}`);
  console.error(`\nAdd "ALTER TABLE public.<t> ENABLE ROW LEVEL SECURITY" plus an owner_all policy,`);
  console.error(`following migrations/29_enable_rls_all_tables.sql. If a table genuinely should not`);
  console.error(`have RLS, add it to scripts/rls-coverage-exceptions.json with the reason.`);
  process.exit(1);
}

console.log('\nOK — every table created in a migration states its RLS.');
