#!/usr/bin/env node
/**
 * build-schema-index.mjs — keep scripts/schema-index.json from going stale.
 *
 * schema-index.json is what scripts/schema-audit.py checks every select and
 * insert against. It was hand-maintained, drifted for eleven days, and took CI
 * red from 30 July 2026: business_days (migration 41), the migration 43 columns
 * on user_devices and shifts, and both migration 44 tables were all missing, so
 * the audit reported live tables as non-existent. A hand-maintained index does
 * not merely go wrong, it goes quietly wrong — a stale index still passes most
 * checks, which is what makes it worth automating.
 *
 * TWO MODES, and the difference matters.
 *
 *   --from-db <file>   AUTHORITATIVE. Takes the JSON produced by
 *                      build-schema-index.sql run against the live database and
 *                      writes it as the index. information_schema is ground
 *                      truth: it is what the code will actually hit at runtime.
 *                      Use this whenever you can.
 *
 *   --merge-migrations BEST EFFORT. Parses migrations/*.sql and ADDS anything
 *                      the index is missing. Never removes: a column the index
 *                      has and the migrations do not may be real and simply
 *                      predate the migration set. Use to unstick CI when you
 *                      cannot reach the database, then re-run --from-db later.
 *
 * Why not derive from migrations alone: the index exists to catch code naming a
 * column the DATABASE does not have. Deriving it from migrations would make it
 * agree with the migrations by construction, and the gap it is meant to detect
 * is precisely migrations-applied-or-not. scripts/schema-parity.mjs already
 * covers migrations vs the till's SQLite; this covers code vs Postgres.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MIGRATIONS = path.join(ROOT, 'migrations');
const INDEX = path.join(HERE, 'schema-index.json');

// ── information_schema spellings ────────────────────────────────────────────
// The existing index came from information_schema, so it says "character
// varying" where a migration says varchar. Matching that spelling keeps the
// diff of a --from-db regeneration honest instead of a whole-file rewrite.
const TYPE_MAP = {
  varchar: 'character varying',
  'character varying': 'character varying',
  char: 'character',
  timestamptz: 'timestamp with time zone',
  'timestamp with time zone': 'timestamp with time zone',
  timestamp: 'timestamp without time zone',
  'timestamp without time zone': 'timestamp without time zone',
  timetz: 'time with time zone',
  time: 'time without time zone',
  'time without time zone': 'time without time zone',
  int: 'integer',
  int4: 'integer',
  integer: 'integer',
  int2: 'smallint',
  smallint: 'smallint',
  int8: 'bigint',
  bigint: 'bigint',
  serial: 'integer',
  bigserial: 'bigint',
  bool: 'boolean',
  boolean: 'boolean',
  decimal: 'numeric',
  numeric: 'numeric',
  float8: 'double precision',
  'double precision': 'double precision',
  uuid: 'uuid',
  text: 'text',
  json: 'json',
  jsonb: 'jsonb',
  date: 'date',
  inet: 'inet',
  bytea: 'bytea',
};

const normaliseType = (raw) => {
  let t = raw.trim().replace(/\s+/g, ' ');
  if (/\[\]$/.test(t) || /^ARRAY$/i.test(t)) return 'ARRAY';
  t = t.replace(/\([^)]*\)/g, '').trim();          // varchar(50) -> varchar
  const key = t.toLowerCase();
  for (const spelling of Object.keys(TYPE_MAP).sort((a, b) => b.length - a.length)) {
    if (key === spelling || key.startsWith(spelling + ' ')) return TYPE_MAP[spelling];
  }
  return t.toLowerCase();
};

const fmt = (type, notNull) => `"${normaliseType(type)}"${notNull ? ' NOT NULL' : ''}`;

// ── Migration parsing (same approach as schema-parity.mjs) ──────────────────
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

const splitTopLevel = (body) => {
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
};

const CONSTRAINT_WORDS = /^(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK|EXCLUDE|LIKE)\b/i;

function parseColumnDef(line) {
  const l = line.trim();
  if (!l || CONSTRAINT_WORDS.test(l)) return null;
  const m = l.match(/^"?(\w+)"?\s+(.+)$/s);
  if (!m) return null;
  const rest = m[2];
  const type = rest.split(/\s+(?:NOT\s+NULL|NULL|DEFAULT|REFERENCES|GENERATED|PRIMARY|UNIQUE|CHECK|COLLATE)\b/i)[0];
  return { name: m[1], type, notNull: /\bNOT\s+NULL\b/i.test(rest) };
}

function parseMigrations() {
  const files = fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort((a, b) => {
    const na = parseInt(a, 10), nb = parseInt(b, 10);
    if (Number.isNaN(na) && Number.isNaN(nb)) return a.localeCompare(b);
    if (Number.isNaN(na)) return 1;
    if (Number.isNaN(nb)) return -1;
    return na - nb;
  });

  const tables = new Map();
  for (const f of files) {
    const sql = strip(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));

    for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?(\w+)"?\s*\(([\s\S]*?)\n\s*\)\s*;/gi)) {
      const [, name, body] = m;
      const cols = tables.get(name) ?? new Map();
      for (const line of splitTopLevel(body)) {
        const c = parseColumnDef(line);
        if (c) cols.set(c.name, c);
      }
      tables.set(name, cols);
    }

    // `IF EXISTS` must be consumed here or the capture group takes "IF" as the
    // table name — 00_baseline.sql:234 has an `alter table if exists %s` inside
    // a format() string, which produced a phantom table called `if`.
    for (const m of sql.matchAll(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?"?(\w+)"?\s+([\s\S]*?);/gi)) {
      const [, name, body] = m;
      const known = tables.has(name);
      const cols = tables.get(name) ?? new Map();
      const before = cols.size;
      for (const clause of splitTopLevel(body)) {
        const add = clause.match(/^ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?\s+([\s\S]+)$/i);
        if (add) {
          const rest = add[2];
          const type = rest.split(/\s+(?:NOT\s+NULL|NULL|DEFAULT|REFERENCES|GENERATED|PRIMARY|UNIQUE|CHECK|COLLATE)\b/i)[0];
          cols.set(add[1], { name: add[1], type, notNull: /\bNOT\s+NULL\b/i.test(rest) });
          continue;
        }
        const drop = clause.match(/^DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?/i);
        if (drop) cols.delete(drop[1]);
      }
      // An ALTER that only adds a constraint or index must not conjure a table
      // into the index. Register it only if it was already known, or if this
      // statement actually contributed a column.
      if (known || cols.size > before) tables.set(name, cols);
    }

    for (const m of sql.matchAll(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?"?(\w+)"?/gi)) {
      tables.delete(m[1]);
    }
  }
  return tables;
}

const writeIndex = (obj) => {
  const sorted = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
  fs.writeFileSync(INDEX, JSON.stringify(sorted, null, 2) + '\n');
};

// ── Modes ───────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

if (args[0] === '--from-db') {
  const src = args[1];
  if (!src) { console.error('usage: build-schema-index.mjs --from-db <result.json>'); process.exit(2); }
  const parsed = JSON.parse(fs.readFileSync(src, 'utf8'));
  const count = Object.keys(parsed).length;
  if (count < 50) {
    console.error(`refusing to write: only ${count} tables in ${src}. That looks like a truncated copy-paste, and overwriting the index with it would make the audit pass by knowing nothing.`);
    process.exit(2);
  }
  writeIndex(parsed);
  console.log(`schema-index.json written from the database — ${count} tables.`);
  process.exit(0);
}

if (args[0] === '--merge-migrations') {
  const existing = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  const parsed = parseMigrations();

  let addedTables = 0, addedCols = 0;
  const notes = [];
  for (const [table, cols] of parsed) {
    if (!existing[table]) { existing[table] = {}; addedTables++; notes.push(`+ table ${table}`); }
    for (const [col, def] of cols) {
      if (!(col in existing[table])) {
        existing[table][col] = fmt(def.type, def.notNull);
        addedCols++;
        if (addedTables === 0 || !notes.includes(`+ table ${table}`)) notes.push(`  + ${table}.${col}`);
      }
    }
  }
  writeIndex(existing);
  console.log(notes.join('\n'));
  console.log(`\nmerged: ${addedTables} table(s), ${addedCols} column(s) added. Nothing removed.`);
  console.log('This is best effort. Re-run --from-db against the live database when you can.');
  process.exit(0);
}

console.error(`usage:
  build-schema-index.mjs --from-db <result.json>   authoritative; see build-schema-index.sql
  build-schema-index.mjs --merge-migrations        best effort, offline`);
process.exit(2);
