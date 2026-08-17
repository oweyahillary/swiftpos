#!/usr/bin/env node
/**
 * check-schema-drift.mjs — the gate that would have caught the last three bugs.
 *
 * WHY THIS EXISTS
 * Three separate production defects, all the same shape: the migration files and
 * the live database disagreed, and nothing compared them.
 *
 *   1. increment_loyalty_points was (p_customer_id, p_delta) in the database and
 *      (p_customer_id, p_points) in migrations/53. PostgREST resolves an RPC by
 *      its NAMED ARGUMENT SET, so the name IS the call signature. PostgreSQL
 *      refuses to rename a parameter through CREATE OR REPLACE, so re-running
 *      the migration failed every time and the two definitions drifted apart in
 *      silence. Fixed by migration 68.
 *
 *   2. create_order_atomic inserted pump_id as raw text into a uuid column.
 *      Present in migration 65 and in 66. EVERY order failed at runtime:
 *          column "pump_id" is of type uuid but expression is of type text
 *      Fixed by migration 69.
 *
 *   3. schema-index.json — which schema-audit.py checks 475 selects against —
 *      held 16 tables while the database had 98. A stale index does not fail
 *      loudly; it passes, on a picture of a database that no longer exists.
 *
 * The common cause is that a plpgsql function body is NOT type-checked when the
 * function is created. CREATE OR REPLACE reports success, schema_migrations
 * records it, and the failure only surfaces on the first real sale. Nothing
 * between running a migration and taking money would have flagged any of these.
 *
 * WHAT IT CHECKS
 *   A. CAST SAFETY   Every INSERT inside a migration: for each target column,
 *                    does the expression yield a type the column can accept?
 *                    ->> yields TEXT, and PostgreSQL has no assignment cast from
 *                    text to uuid / numeric / integer / timestamptz / boolean /
 *                    date. This is check #2, mechanised.
 *   B. FUNCTION      CREATE FUNCTION signatures in migrations vs the live
 *      SIGNATURES    database. This is check #1, mechanised.
 *   C. INDEX         Is schema-index.json plausibly current? This is check #3.
 *      FRESHNESS
 *
 * GROUND TRUTH
 *   scripts/schema-index.json     tables and column types   <- build-schema-index.sql
 *   scripts/functions-index.json  function signatures       <- build-functions-index.sql
 * Both come FROM THE DATABASE, never from the migrations. Deriving them from
 * migrations would make them agree by construction and detect nothing — which is
 * the whole point. Same reasoning as build-schema-index.mjs.
 *
 *   node scripts/check-schema-drift.mjs [--verbose]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT       = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = path.join(ROOT, 'migrations');
const VERBOSE    = process.argv.includes('--verbose');

const readJson = (p, what) => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8')); }
  catch { console.error(`  cannot read ${p} — ${what}`); return null; }
};

const schemaIndex    = readJson('scripts/schema-index.json',    'run build-schema-index.sql, then build-schema-index.mjs --from-db');
const functionsIndex = readJson('scripts/functions-index.json', 'run build-functions-index.sql and save the result there');

/**
 * Remove SQL comments before parsing. Without this, an inline comment inside an
 * argument list is absorbed into the parameter it follows, e.g.
 *     p_amount numeric,   -- signed delta
 *     p_method text,
 * parses as one argument "p_amount numeric, -- signed delta p_method text" and
 * reports a signature conflict that does not exist. Quote-aware so a '--' or
 * '/*' inside a string literal is left alone.
 */
function stripComments(sql) {
  let out = '', i = 0, q = false, dq = false;
  while (i < sql.length) {
    const c = sql[i], n = sql[i + 1];
    if (!q && !dq && c === '-' && n === '-') { while (i < sql.length && sql[i] !== '\n') i++; continue; }
    if (!q && !dq && c === '/' && n === '*') { i += 2; while (i < sql.length && !(sql[i] === '*' && sql[i+1] === '/')) i++; i += 2; continue; }
    if (!dq && c === "'") q = !q;
    if (!q && c === '"') dq = !dq;
    out += c; i++;
  }
  return out;
}

const findings = [];
const add = (sev, file, msg, detail) => findings.push({ sev, file, msg, detail });

// ── types PostgreSQL will NOT implicitly accept a text expression into ───────
// varchar/text take text happily. These do not.
const STRICT = new Set([
  'uuid', 'numeric', 'integer', 'bigint', 'smallint', 'boolean', 'date', 'real',
  'double precision', 'jsonb', 'json', 'inet', 'bytea',
  'timestamp with time zone', 'timestamp without time zone', 'time without time zone',
]);

const colType = (table, col) => {
  const t = schemaIndex?.[table];
  if (!t || !t[col]) return null;
  const m = /^"([^"]+)"/.exec(t[col]);
  return m ? m[1] : null;
};

/**
 * What type does this SQL expression yield?
 * Returns 'text' | '<cast type>' | null (unknown — not flagged).
 * Deliberately conservative: only report when confident, or the check becomes
 * noise and gets switched off.
 */
function exprType(raw) {
  const e = raw.trim().replace(/,$/, '');
  if (!e) return null;
  // an explicit cast anywhere at the end wins:  NULLIF(x,'')::uuid, (x)::numeric
  const cast = /::\s*([a-z ]+?)\s*$/i.exec(e);
  if (cast) return cast[1].trim().toLowerCase();
  // COALESCE(<something>::type, ...) — take the first cast inside
  const inner = /::\s*([a-z ]+?)\s*[,)]/i.exec(e);
  if (inner) return inner[1].trim().toLowerCase();
  // ->> yields text. This is the pump_id bug.
  if (/->>/.test(e)) return 'text';
  return null;   // variables, literals, function calls — unknown, do not guess
}

/** Split a parenthesised list on top-level commas. */
function splitTop(s) {
  const out = []; let depth = 0, cur = '', q = false;
  for (const ch of s) {
    if (ch === "'") q = !q;
    if (!q && ch === '(') depth++;
    if (!q && ch === ')') depth = Math.max(0, depth - 1);
    if (!q && ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

// ── A. CAST SAFETY ──────────────────────────────────────────────────────────
function checkCasts(file, sql) {
  // Do NOT swallow a leading '(' here. An earlier version had \(? after
  // SELECT|VALUES, which ate the opening paren of (p_order->>'business_id')::uuid
  // and left the depth counter unbalanced, so splitTop stopped splitting and
  // every INSERT was silently skipped as "count mismatch". The check reported
  // OK on a migration that was broken. Exactly the failure mode this file exists
  // to prevent, in the file itself.
  const re = /INSERT\s+INTO\s+(?:public\.)?(\w+)\s*\(([^;]*?)\)\s*(SELECT|VALUES)\s+([\s\S]*?)(?=\n\s*(?:RETURNING|FROM|ON CONFLICT|;))/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const table = m[1];
    if (!schemaIndex?.[table]) continue;           // unknown table -> the freshness check owns that
    const cols  = splitTop(m[2]).map(s => s.trim().replace(/["\n]/g, ''));
    let body = m[4].trim();
    // VALUES (...) wraps the whole list in one paren pair; SELECT does not.
    if (m[3].toUpperCase() === 'VALUES' && body.startsWith('(') && body.endsWith(')')) {
      body = body.slice(1, -1);
    }
    const exprs = splitTop(body);
    if (cols.length !== exprs.length) {
      if (VERBOSE) add('warn', file, `INSERT INTO ${table}: ${cols.length} columns vs ${exprs.length} expressions — not analysed`);
      continue;
    }
    cols.forEach((col, i) => {
      const target = colType(table, col);
      const got    = exprType(exprs[i]);
      if (!target || !got) return;
      if (got === 'text' && STRICT.has(target)) {
        add('error', file,
          `${table}.${col} is ${target} but the expression yields text`,
          `${exprs[i].trim().slice(0, 72)}\n     -> PostgreSQL has no assignment cast from text to ${target}. ` +
          `This fails at RUNTIME, on every call. A plpgsql body is not type-checked at CREATE time, ` +
          `so the migration will apply cleanly and then break the first sale.\n` +
          `     fix: NULLIF(${/->>/.test(exprs[i]) ? exprs[i].trim().replace(/,$/, '') : 'expr'},'')::${target}`);
      }
    });
  }
}

// ── B. FUNCTION SIGNATURES ──────────────────────────────────────────────────
function collectMigrationFunctions(file, sql) {
  const out = [];
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?(\w+)\s*\(([\s\S]*?)\)\s*\n?\s*RETURNS/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const args = splitTop(m[2]).map(a => {
      const p = a.trim().split(/\s+/);
      return p.length >= 2 ? `${p[0]} ${p.slice(1).join(' ').toLowerCase()}` : a.trim();
    }).filter(Boolean).join(', ');
    out.push({ name: m[1], args, file });
  }
  return out;
}

// ── main ────────────────────────────────────────────────────────────────────
// Numbered migrations sort by number; unnumbered ones sort last, which is how
// they are applied in practice. Plain .sort() would put 'swiftpos_...' before
// '68_...' on some inputs and silently pick the wrong "current" declaration.
const migOrder = f => {
  const n = /^(\d+)/.exec(f);
  return n ? [0, Number(n[1]), f] : [1, 0, f];
};
const files = fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql'))
  .sort((a, b) => { const [x1,y1,z1] = migOrder(a), [x2,y2,z2] = migOrder(b);
                    return x1 - x2 || y1 - y2 || z1.localeCompare(z2); });

const declared = new Map();   // name -> latest declaration
const allDecls = new Map();   // name -> every declaration, for conflict detection

for (const f of files) {
  const sql = stripComments(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
  if (schemaIndex) checkCasts(f, sql);
  for (const fn of collectMigrationFunctions(f, sql)) {
    declared.set(fn.name, fn);
    if (!allDecls.has(fn.name)) allDecls.set(fn.name, []);
    allDecls.get(fn.name).push(fn);
  }
}

// ── B0. THE SAME FUNCTION DECLARED TWICE, DIFFERENTLY ───────────────────────
// This is how increment_loyalty_points ended up as p_delta in the database and
// p_points in migrations/53: swiftpos_consolidated_migration.sql declares it
// with p_delta, and a later file declares it with p_points. Whichever ran last
// on a given database wins, so two databases built from the same repo can
// disagree — and re-running the loser fails with
//     ERROR: cannot change name of input parameter
// which is silent unless somebody is reading migration output.
const norm0 = s => s.replace(/\bint\b/g, 'integer').replace(/\s+/g, ' ').trim().toLowerCase();
for (const [name, decls] of allDecls) {
  const shapes = new Map();
  for (const d of decls) {
    const k = norm0(d.args);
    if (!shapes.has(k)) shapes.set(k, []);
    shapes.get(k).push(d.file);
  }
  if (shapes.size > 1) {
    add('error', [...decls.map(d => d.file)].join(', '),
      `function ${name} is declared with ${shapes.size} DIFFERENT signatures across migrations`,
      [...shapes.entries()].map(([sig, fl]) => `${name}(${sig})\n       in ${fl.join(', ')}`).join('\n     ') +
      `\n     -> which one a database ends up with depends on the order the files were run. ` +
      `Two databases built from this repo can disagree. Re-running the loser fails with ` +
      `"cannot change name of input parameter", so the drift is permanent until a DROP + CREATE.`);
  }
}

if (functionsIndex) {
  // ── PENDING MIGRATIONS ────────────────────────────────────────────────────
  // A migration written but not yet run in production is NOT drift — it is a
  // known window, and every new function migration hits it. Reporting it as
  // drift leaves CI red on a correct commit, which teaches people to ignore the
  // one gate built to catch three production defects.
  //
  // So a migration file may be declared pending in schema-pending.json. The
  // declaration is DELIBERATELY SELF-CLEARING and cannot become a place to
  // silence this check: the moment the function DOES appear in the snapshot,
  // the stale entry fails the gate and must be deleted. A pending entry buys
  // the window between writing a migration and running it, and nothing more.
  let pending = {};
  try {
    pending = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/schema-pending.json'), 'utf8')).pending ?? {};
  } catch { /* absent is fine — nothing pending */ }

  for (const [file, note] of Object.entries(pending)) {
    const fns = [...declared].filter(([, fn]) => fn.file === file);
    if (fns.length === 0) {
      add('error', 'scripts/schema-pending.json',
        `"${file}" is declared pending but declares no functions in migrations/`,
        'The entry names a file that does not exist or has no CREATE FUNCTION. ' +
        'A pending declaration that matches nothing is a silencer with no subject.');
      continue;
    }
    if (fns.every(([name]) => functionsIndex[name] !== undefined)) {
      add('error', 'scripts/schema-pending.json',
        `"${file}" is declared pending but every one of its functions IS in the database`,
        'The migration has been applied, so this entry is stale and is now ' +
        'suppressing real signature checks on those functions. Delete it. ' +
        `(reason on file: ${note})`);
    }
  }

  for (const [name, fn] of declared) {
    const live = functionsIndex[name];
    if (live === undefined) {
      if (pending[fn.file]) {
        add('note', fn.file, `function ${name}(${fn.args}) not yet in the database — DECLARED PENDING`,
          `${pending[fn.file]}\n     This is a declared window, not drift. The declaration in ` +
          'scripts/schema-pending.json must be removed once the migration is run and ' +
          'schema-index.json is refreshed — the gate fails if it is left behind.');
        continue;
      }
      add('error', fn.file, `function ${name}(${fn.args}) is in the migrations but NOT in the database`,
        'Either the migration was never applied, or it failed. Re-running it may not help: ' +
        'CREATE OR REPLACE cannot rename a parameter, so a signature change needs DROP + CREATE. ' +
        'If it is simply not run yet, declare it in scripts/schema-pending.json.');
      continue;
    }
    const norm = s => s.replace(/\bint\b/g, 'integer').replace(/\s+/g, ' ').trim().toLowerCase();
    if (norm(live) !== norm(fn.args)) {
      add('error', fn.file, `function ${name} SIGNATURE DRIFT`,
        `migration: ${name}(${fn.args})\n     database:  ${name}(${live})\n` +
        `     -> PostgREST resolves an RPC by its NAMED ARGUMENT SET, so a caller written ` +
        `against one will get PGRST202 from the other. This is the p_delta / p_points bug.`);
    }
  }
} else {
  add('warn', '-', 'no scripts/functions-index.json — function signature drift is NOT being checked',
    'Run scripts/build-functions-index.sql against the live database and save the result.');
}

// ── C. INDEX FRESHNESS ──────────────────────────────────────────────────────
if (schemaIndex) {
  // Net CREATE against DROP in migration order: a table created in baseline and
  // dropped in a later migration (e.g. 80 drops the dead sync_queue, D15) must
  // NOT be expected in the index. Processing in order also handles the
  // create → drop → recreate case correctly (the last op wins).
  const created = new Set();
  const ordered = [...files].sort((a, b) => {
    const na = parseInt(a, 10), nb = parseInt(b, 10);
    return (Number.isNaN(na) ? -1 : na) - (Number.isNaN(nb) ? -1 : nb) || a.localeCompare(b);
  });
  for (const f of ordered) {
    const sql = stripComments(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
    for (const m of sql.matchAll(/CREATE\s+(?:UNLOGGED\s+|TEMP\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?(\w+)"?/gi)) {
      // 'CREATE TABLE x AS SELECT' and 'CREATE TABLE OF' would otherwise add a
      // table literally named AS / OF.
      if (!/^(as|of|only)$/i.test(m[1])) created.add(m[1]);
    }
    for (const m of sql.matchAll(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?"?(\w+)"?/gi)) {
      created.delete(m[1]);
    }
  }
  const missing = [...created].filter(t => !schemaIndex[t]).sort();
  if (missing.length) {
    add('error', 'scripts/schema-index.json',
      `${missing.length} table(s) created in a migration are absent from the index`,
      `${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ` … +${missing.length - 12} more` : ''}\n` +
      `     -> the index is STALE. schema-audit.py checks every select against it, so it is ` +
      `currently validating against a database that no longer exists. Regenerate:\n` +
      `        run scripts/build-schema-index.sql, then node scripts/build-schema-index.mjs --from-db result.json`);
  }
}

// ── report ──────────────────────────────────────────────────────────────────
// ── D. SCHEMA-QUALIFIED DML TARGETS ────────────────────────────────────────
//
// WHY (register A62). Migration 76 failed in production with:
//
//     ERROR: 42P01: relation "role_permissions" does not exist
//     LINE 46: INSERT INTO role_permissions (role_id, permission_id)
//
// The table exists. The session's search_path did not include `public`, which is
// Supabase's hardened default in several contexts. Line 46 was the ONLY
// unqualified name in that file — every other reference, including one to the
// SAME table eleven lines below, was written `public.role_permissions`.
//
// This fails LOUDLY when the first statement is unqualified, which is the lucky
// case. The dangerous shape is a migration whose early statements are qualified
// and whose later ones are not: the early half commits, the run aborts, and
// schema_migrations may or may not record it depending on where the ledger
// insert sits. That is a half-applied migration, which is the hardest state to
// diagnose later.
//
// RATCHETED, not pass/fail: 12 of 71 migrations predate this rule and have
// already run, so demanding they change would be rewriting history to make a
// gate green. New ones may not add to the count.
//
// Table names come from schema-index.json rather than a regex guess, because a
// bare word match reports SQL keywords (OF, ON, TO) as tables and a gate that
// cries wolf gets switched off.
{
  const liveTables = new Set(Object.keys(schemaIndex ?? {}));
  const unqualified = [];
  for (const f of files) {
    let sql = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');
    sql = stripComments(sql).replace(/\$\$[\s\S]*?\$\$/g, ' ');
    for (const m of sql.matchAll(
      /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|ALTER\s+TABLE(?:\s+ONLY)?)\s+([a-z_][a-z0-9_]*)\b/gi)) {
      const tbl = m[2].toLowerCase();
      if (!liveTables.has(tbl)) continue;          // not a real table -> not our business
      const line = sql.slice(0, m.index).split('\n').length;
      unqualified.push({ file: f, tbl, line });
    }
  }
  const BASE = path.join(ROOT, 'scripts/schema-qualify-baseline.json');
  let want = null;
  try { want = JSON.parse(fs.readFileSync(BASE, 'utf8')).unqualified; } catch {}
  if (process.argv.includes('--update-qualify')) {
    fs.writeFileSync(BASE, JSON.stringify({ unqualified: unqualified.length }, null, 2) + '\n');
    console.log(`schema-qualify baseline written: ${unqualified.length}`);
  } else if (want === null) {
    add('error', 'scripts/schema-qualify-baseline.json', 'no baseline',
      'Run: node scripts/check-schema-drift.mjs --update-qualify');
  } else if (unqualified.length > want) {
    for (const u of unqualified.slice(-(unqualified.length - want))) {
      add('error', u.file, `unqualified DML target "${u.tbl}" at line ${u.line}`,
        `Write public.${u.tbl}. A session whose search_path excludes public fails with ` +
        `42P01 "relation does not exist" even though the table is there — and if earlier ` +
        `statements in the file WERE qualified, they have already committed. Register A62.`);
    }
  } else if (unqualified.length < want) {
    add('error', 'scripts/schema-qualify-baseline.json',
      `unqualified DML targets FELL: ${want} -> ${unqualified.length}`,
      'Good — now lower the baseline: node scripts/check-schema-drift.mjs --update-qualify');
  }
}

const errors = findings.filter(f => f.sev === 'error');
const warns  = findings.filter(f => f.sev === 'warn');
console.log(`check-schema-drift: ${files.length} migrations, ` +
            `${Object.keys(schemaIndex ?? {}).length} tables and ` +
            `${Object.keys(functionsIndex ?? {}).length} functions in the live snapshot.\n`);

for (const f of [...errors, ...warns]) {
  console.log(`  ${f.sev === 'error' ? 'DRIFT' : f.sev === 'note' ? 'note ' : 'warn '}  ${f.file}`);
  console.log(`         ${f.msg}`);
  if (f.detail) console.log(`     ${f.detail.split('\n').join('\n     ')}`);
  console.log();
}

if (errors.length) {
  console.error(`FAIL — ${errors.length} drift finding(s). The migrations and the database disagree.`);
  process.exit(1);
}
console.log(warns.length
  ? `OK with ${warns.length} warning(s) — no drift between the migrations and the database.`
  : 'OK — the migrations and the database agree.');
