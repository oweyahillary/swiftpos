#!/usr/bin/env node
/**
 * schema-parity.mjs — does the desktop's SQLite schema still match Postgres?
 *
 * THE PROBLEM THIS EXISTS FOR
 *   There are two schemas. Postgres is defined by migrations/*.sql; the till's
 *   SQLite is hardcoded in apps/desktop/src/main/localDb.ts. Sync moves DATA
 *   only — it never reconciles structure — so the two drift by hand, silently,
 *   and `shifts` really did sit for months with closed_by/close_method locally
 *   and neither column in Postgres.
 *
 *   Drift fails in two opposite ways, and neither is obvious:
 *
 *     • A column added to Postgres that the till does not read is INVISIBLE.
 *       Both pull and push name their columns explicitly, so nothing errors —
 *       the feature just does not exist on the terminal, indefinitely.
 *
 *     • A NOT NULL column with no default, or a narrowed CHECK, on a table the
 *       till PUSHES is fatal: /api/sync/push is rejected on every pass and the
 *       terminal stops syncing altogether. Discovered at 06:00, not at deploy.
 *
 *   So this compares the two and fails CI on divergence. It is deliberately
 *   derived from the MIGRATION FILES rather than from scripts/schema-index.json,
 *   because that index is hand-maintained — it is the artefact that went stale
 *   for eleven days and made 24 of 29 audit findings false. A new guarantee
 *   built on it would inherit that.
 *
 * WHAT IT DOES NOT DO
 *   It does not compare types. Local uses TEXT where Postgres uses uuid and
 *   timestamptz, by design, and flagging that would produce noise nobody reads.
 *   Divergence in the SET OF COLUMNS is what breaks sync; naming is what breaks
 *   it silently.
 *
 *   Usage:  node scripts/schema-parity.mjs [--json]
 *   Exit:   0 = parity, 1 = divergence, 2 = the script could not parse enough
 *           to make a claim (see PARSE FLOOR below).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = path.join(ROOT, 'migrations');
const LOCAL_DB = path.join(ROOT, 'apps', 'desktop', 'src', 'main', 'localDb.ts');
const EXCEPTIONS = path.join(ROOT, 'scripts', 'schema-parity-exceptions.json');
const SYNC_ENGINE = path.join(ROOT, 'apps', 'desktop', 'src', 'main', 'syncEngine.ts');

// PARSE FLOOR — the anti-false-green guard.
//
// The worst outcome for a checker like this is passing because it parsed
// nothing. If a refactor changes how localDb.ts declares tables, or the
// migration style changes, a naive regex parser silently finds zero tables and
// reports perfect parity forever. So the script asserts it found at least this
// much, and exits 2 (distinct from both pass and fail) if it did not.
const MIN_PG_TABLES = Number(process.env.PARITY_MIN_PG ?? 40);
const MIN_LOCAL_TABLES = Number(process.env.PARITY_MIN_LOCAL ?? 15);
const MIN_SHARED_TABLES = Number(process.env.PARITY_MIN_SHARED ?? 10);

/**
 * Remove SQL comments, including TRAILING ones, without touching string literals.
 *
 * The first version only stripped comments that occupied a whole line. A trailing
 * comment therefore stayed attached to the text after the next comma, so
 *
 *     type   TEXT NOT NULL,   -- 'float_in' | 'float_out'
 *     amount REAL NOT NULL,
 *
 * split into a chunk beginning "-- 'float_in'…\n amount REAL NOT NULL", which
 * failed the column-name match and made `amount` invisible. The check then
 * reported it as missing locally and demanded it be added — a column that was
 * already there. A checker that fabricates work is abandoned within a week, so
 * this is quote-aware rather than a broader regex: `--` inside a literal such as
 * DEFAULT 'a--b' must survive.
 */
const strip = (sql) => {
  let out = '';
  let quote = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; out += ch; continue; }
    if (ch === '-' && sql[i + 1] === '-') {          // line comment
      while (i < sql.length && sql[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {          // block comment
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 1;
      out += ' ';
      continue;
    }
    out += ch;
  }
  return out;
};

// ── Postgres, from the migration files in version order ─────────────────────
function parsePostgres() {
  const files = fs.readdirSync(MIGRATIONS)
    .filter(f => f.endsWith('.sql'))
    .sort((a, b) => {
      const na = parseInt(a, 10), nb = parseInt(b, 10);
      if (Number.isNaN(na) && Number.isNaN(nb)) return a.localeCompare(b);
      if (Number.isNaN(na)) return 1;      // non-numbered files last
      if (Number.isNaN(nb)) return -1;
      return na - nb;
    });

  const tables = new Map();   // name -> Map(col -> { notNull, hasDefault })

  for (const f of files) {
    const sql = strip(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));

    // CREATE TABLE [IF NOT EXISTS] [public.]name ( ... );
    const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?(\w+)"?\s*\(([\s\S]*?)\n\s*\)\s*;/gi;
    for (const m of sql.matchAll(createRe)) {
      const [, name, body] = m;
      const cols = tables.get(name) ?? new Map();
      for (const line of splitTopLevel(body)) {
        const col = parseColumnDef(line);
        if (col) cols.set(col.name, col);
      }
      tables.set(name, cols);
    }

    // ALTER TABLE ... ADD COLUMN [IF NOT EXISTS] name type ... (comma-separated)
    const alterRe = /ALTER\s+TABLE\s+(?:ONLY\s+)?(?:public\.)?"?(\w+)"?\s+([\s\S]*?);/gi;
    for (const m of sql.matchAll(alterRe)) {
      const [, name, body] = m;
      const cols = tables.get(name) ?? new Map();
      for (const clause of splitTopLevel(body)) {
        const add = clause.match(/^ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?\s+([\s\S]+)$/i);
        if (add) {
          cols.set(add[1], {
            name: add[1],
            notNull: /\bNOT\s+NULL\b/i.test(add[2]),
            hasDefault: /\bDEFAULT\b/i.test(add[2]),
          });
          continue;
        }
        const drop = clause.match(/^DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?/i);
        if (drop) cols.delete(drop[1]);
      }
      tables.set(name, cols);
    }

    for (const m of sql.matchAll(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?"?(\w+)"?/gi)) {
      tables.delete(m[1]);
    }
  }
  return tables;
}

/** Split a parenthesised body on top-level commas only. */
function splitTopLevel(body) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

const CONSTRAINT_WORDS = /^(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK|EXCLUDE|LIKE)\b/i;

function parseColumnDef(line) {
  const l = line.trim();
  if (!l || CONSTRAINT_WORDS.test(l)) return null;
  const m = l.match(/^"?(\w+)"?\s+(.+)$/s);
  if (!m) return null;
  return {
    name: m[1],
    notNull: /\bNOT\s+NULL\b/i.test(m[2]),
    hasDefault: /\bDEFAULT\b/i.test(m[2]),
  };
}

// ── Local SQLite, from localDb.ts ───────────────────────────────────────────
function parseLocal() {
  const src = fs.readFileSync(LOCAL_DB, 'utf8');
  const tables = new Map();

  const cleaned = strip(src);
  for (const m of cleaned.matchAll(
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?\s*\(([\s\S]*?)\n\s*\)\s*;/gi)) {
    const [, name, body] = m;
    const cols = tables.get(name) ?? new Set();
    for (const line of splitTopLevel(body)) {
      const col = parseColumnDef(line);
      if (col) cols.add(col.name);
    }
    tables.set(name, cols);
  }

  // migrateColumns(db, 'table', [ ['col','TYPE'], ... ]) — the additive path for
  // existing installs. Missing these would report false divergence on any column
  // added after a table was first created.
  for (const m of cleaned.matchAll(
    /migrateColumns\s*\(\s*db\s*,\s*'(\w+)'\s*,\s*\[([\s\S]*?)\]\s*\)/g)) {
    const [, name, body] = m;
    const cols = tables.get(name) ?? new Set();
    for (const c of body.matchAll(/\[\s*'(\w+)'/g)) cols.add(c[1]);
    tables.set(name, cols);
  }
  return tables;
}

// ── Sync direction, read from syncEngine.ts ─────────────────────────────────
//
// Severity depends entirely on direction, and without this the check is noise.
//
//   PULL tables (products, categories, users…) — the till holds a deliberate
//   SUBSET of a server-owned table. It never writes them back, so a Postgres
//   column absent locally is a design decision, not a defect, and a local-only
//   column is bookkeeping. Nothing here can break sync.
//
//   PUSH tables (orders, shifts, payments…) — the till ORIGINATES these rows and
//   sends them to Postgres. Here the asymmetries bite: a NOT NULL column with no
//   default that the till does not send is rejected on every push, and a
//   local-only column that gets sent is rejected as unknown.
//
// Read from the source rather than duplicated here, so adding a table to
// SYNC_DIRECTION automatically brings it into scope.
function parseSyncDirection() {
  const src = fs.readFileSync(SYNC_ENGINE, 'utf8');
  const block = src.match(/SYNC_DIRECTION[^=]*=\s*\{([\s\S]*?)\n\}/);
  const dir = new Map();
  if (!block) return dir;
  for (const m of strip(block[1]).matchAll(/(\w+)\s*:\s*'(pull|push)'/g)) {
    dir.set(m[1], m[2]);
  }
  return dir;
}

// ── Compare ─────────────────────────────────────────────────────────────────
const exceptions = fs.existsSync(EXCEPTIONS)
  ? JSON.parse(fs.readFileSync(EXCEPTIONS, 'utf8'))
  : { localOnlyColumns: [], localOnlyTables: [], postgresOnlyTables: [], ignoreColumns: {} };

const localOnlyCols = new Set(exceptions.localOnlyColumns ?? []);
const pg = parsePostgres();
const local = parseLocal();
const direction = parseSyncDirection();

const shared = [...local.keys()].filter(t => pg.has(t)).sort();

if (direction.size < 10) {
  console.error(
    `schema-parity: could not read SYNC_DIRECTION from syncEngine.ts (found ${direction.size} entries).\n` +
    `Severity depends on direction, so refusing to guess.`);
  process.exit(2);
}

if (pg.size < MIN_PG_TABLES || local.size < MIN_LOCAL_TABLES || shared.length < MIN_SHARED_TABLES) {
  console.error(
    `schema-parity: PARSE FLOOR NOT MET — pg=${pg.size} local=${local.size} shared=${shared.length}\n` +
    `Expected at least pg>=${MIN_PG_TABLES}, local>=${MIN_LOCAL_TABLES}, shared>=${MIN_SHARED_TABLES}.\n` +
    `The parser probably stopped matching after a refactor. Refusing to report parity — ` +
    `a checker that passes because it parsed nothing is worse than no checker.`);
  process.exit(2);
}

const critical = [];   // breaks sync outright
const warnings = [];   // silent feature gaps

const info = [];      // intentional subsetting on pull tables
const unsynced = [];  // tables the till has that sync ignores entirely

for (const table of shared) {
  const pgCols = pg.get(table);
  const localCols = local.get(table);
  const ignore = new Set(exceptions.ignoreColumns?.[table] ?? []);
  const dir = direction.get(table);

  // Not in SYNC_DIRECTION at all: the till keeps its own copy and never
  // exchanges it (sync_queue, device_config, session…). Structure cannot break
  // anything, so it is reported for visibility only.
  if (!dir) {
    unsynced.push(table);
    continue;
  }

  for (const [col, def] of pgCols) {
    if (localCols.has(col) || ignore.has(col)) continue;

    if (dir === 'pull') {
      // The till deliberately holds a subset of a server-owned table. It never
      // writes back, so a missing column is a feature it does not implement.
      info.push({ table, col, why: 'not mirrored locally (pull table — subset by design)' });
    } else if (def.notNull && !def.hasDefault) {
      critical.push({ table, col, why: 'NOT NULL, no default, and the till does not send it — every push will be rejected' });
    } else {
      warnings.push({ table, col, why: 'in Postgres, missing locally — the till cannot populate it' });
    }
  }

  for (const col of localCols) {
    if (pgCols.has(col) || localOnlyCols.has(col) || ignore.has(col)) continue;
    if (dir === 'pull') {
      info.push({ table, col, why: 'local-only column on a pull table — never sent, harmless' });
    } else {
      critical.push({ table, col, why: 'local-only on a PUSH table — Postgres rejects unknown columns' });
    }
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ shared: shared.length, critical, warnings, info, unsynced }, null, 2));
} else {
  console.log(`schema-parity: ${pg.size} Postgres tables, ${local.size} local, ${shared.length} shared\n`);
  if (critical.length) {
    console.log(`CRITICAL (${critical.length}) — these break sync:`);
    for (const c of critical) console.log(`  ${c.table}.${c.col}  ${c.why}`);
    console.log('');
  }
  if (warnings.length) {
    console.log(`WARN (${warnings.length}) — push tables where the till cannot fill a Postgres column:`);
    for (const w of warnings) console.log(`  ${w.table}.${w.col}  ${w.why}`);
    console.log('');
  }
  if (process.argv.includes('--verbose')) {
    console.log(`INFO (${info.length}) — pull-table subsetting, expected:`);
    for (const i of info) console.log(`  ${i.table}.${i.col}  ${i.why}`);
    console.log(`\nNot in SYNC_DIRECTION (local-only, structure irrelevant): ${unsynced.join(', ') || 'none'}\n`);
  } else {
    console.log(`(${info.length} pull-table differences and ${unsynced.length} unsynced tables hidden — pass --verbose)\n`);
  }
  console.log(critical.length ? 'FAIL' : warnings.length ? 'PASS (with warnings)' : 'PASS — schemas agree');
}

process.exit(critical.length ? 1 : 0);
