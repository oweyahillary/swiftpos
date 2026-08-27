/**
 * check-notnull-writes.mjs — A170. The gate A167 earned.
 *
 * A167 was a literal `NULL` written into a `NOT NULL` local column
 * (`staff_session.token`), which threw `NOT NULL constraint failed` the instant
 * the offline path ran — invisible to `tsc` (a runtime constraint) and to the
 * offline-auth test (which modelled the routing, never the write). Rule 6 says
 * find the class and sweep it; this gate is that sweep, made permanent.
 *
 * It parses the NOT NULL columns out of localDb.ts's `CREATE TABLE` blocks and
 * flags any SQL in the till's main process that writes a *literal* `NULL` into
 * one of them — in an INSERT's VALUES (aligned by column position), an
 * UPDATE ... SET, or an ON CONFLICT ... DO UPDATE SET. It only inspects
 * statements that actually contain a bare `NULL`, so NULL-free SQL can never be
 * mis-parsed into a false positive. Bound-parameter NULLs (`?`, `@name`) are a
 * runtime value the gate cannot and does not judge — this catches the literal
 * class, which is the one that shipped.
 *
 * `--self-test` (rule 23): proves the gate fires on A167's exact shape and stays
 * silent on a legitimate NULL into a nullable column, using the SAME analyzer
 * the real run uses (rule 24 — test the real thing, not a copy).
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_FILE = path.join(ROOT, 'apps/desktop/src/main/localDb.ts');
const SCAN_DIR = path.join(ROOT, 'apps/desktop/src/main');

const CONSTRAINT_KEYWORDS = /^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i;

/** table -> Set(NOT NULL column names), parsed from CREATE TABLE blocks. */
export function parseNotNullColumns(schemaText) {
  const out = {};
  const re = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(\w+)\s*\(([\s\S]*?)\)\s*;/gi;
  let m;
  while ((m = re.exec(schemaText))) {
    const table = m[1];
    const body = m[2];
    const cols = new Set();
    for (const rawLine of body.split('\n')) {
      const line = rawLine.replace(/--.*$/, '').trim().replace(/,$/, '');
      if (!line || CONSTRAINT_KEYWORDS.test(line)) continue;
      const col = line.match(/^"?(\w+)"?/);
      if (col && /\bNOT\s+NULL\b/i.test(line)) cols.add(col[1]);
    }
    out[table] = cols;
  }
  return out;
}

/** Split a VALUES/args tuple on top-level commas, respecting () and quotes. */
function splitTopLevel(s) {
  const parts = [];
  let depth = 0, quote = null, cur = '';
  for (const ch of s) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim() !== '' || parts.length) parts.push(cur);
  return parts.map(p => p.trim());
}

const isBareNull = (v) => /^NULL$/i.test(v.trim());

/**
 * Analyze one SQL statement. Returns [{ table, column, kind }] for every literal
 * NULL that lands in a NOT NULL column. Statements without a bare NULL return [].
 */
export function analyzeSql(sql, notNull) {
  // Cheap gate: nothing to do unless a bare NULL appears that is not `NOT NULL`
  // / `IS NULL`. (We still parse structurally below; this just skips the rest.)
  if (!/(^|[^T])\bNULL\b/i.test(sql.replace(/NOT\s+NULL/gi, '').replace(/IS\s+NULL/gi, ''))) {
    return [];
  }
  const violations = [];
  const has = (t, c) => notNull[t] && notNull[t].has(c);

  // INSERT INTO t (cols) VALUES (vals)
  const ins = sql.match(/INSERT\s+INTO\s+(\w+)\s*\(([^)]*)\)\s*VALUES\s*\(([\s\S]*?)\)/i);
  if (ins) {
    const table = ins[1];
    const cols = splitTopLevel(ins[2]).map(c => c.replace(/["'`]/g, '').trim());
    const vals = splitTopLevel(ins[3]);
    for (let i = 0; i < cols.length; i++) {
      if (i < vals.length && isBareNull(vals[i]) && has(table, cols[i])) {
        violations.push({ table, column: cols[i], kind: 'INSERT VALUES' });
      }
    }
    // ON CONFLICT ... DO UPDATE SET col = NULL (same table)
    const doUpd = sql.match(/DO\s+UPDATE\s+SET\b([\s\S]*)$/i);
    if (doUpd) {
      for (const mm of doUpd[1].matchAll(/(\w+)\s*=\s*NULL\b/gi)) {
        if (has(table, mm[1])) violations.push({ table, column: mm[1], kind: 'ON CONFLICT SET' });
      }
    }
    return violations;
  }

  // UPDATE t SET ... col = NULL ... [WHERE ...]
  const upd = sql.match(/UPDATE\s+(\w+)\s+SET\b([\s\S]*?)(?:\bWHERE\b|$)/i);
  if (upd) {
    const table = upd[1];
    for (const mm of upd[2].matchAll(/(\w+)\s*=\s*NULL\b/gi)) {
      if (has(table, mm[1])) violations.push({ table, column: mm[1], kind: 'UPDATE SET' });
    }
  }
  return violations;
}

function lineOf(text, index) { return text.slice(0, index).split('\n').length; }

function scanTree(notNull) {
  const found = [];
  for (const file of readdirSync(SCAN_DIR).filter(f => f.endsWith('.ts'))) {
    const full = path.join(SCAN_DIR, file);
    const text = readFileSync(full, 'utf8');
    // Every backtick template literal (the SQL lives in db.prepare(`...`)).
    for (const m of text.matchAll(/`([^`]*)`/g)) {
      const sql = m[1];
      if (!/\b(INSERT|UPDATE)\b/i.test(sql)) continue;
      for (const v of analyzeSql(sql, notNull)) {
        found.push({ file, line: lineOf(text, m.index), ...v });
      }
    }
  }
  return found;
}

function selfTest() {
  const nn = { staff_session: new Set(['token', 'staff_id']), x: new Set() };
  const cases = [
    // [name, sql, expectViolationCount]
    ['A167 INSERT: NULL into NOT NULL token',
      `INSERT INTO staff_session (id, staff_id, token, refresh_token) VALUES (1, ?, NULL, NULL)`, 1],
    ['A167 UPDATE: token=NULL',
      `UPDATE staff_session SET token=NULL, refresh_token=NULL WHERE id=1`, 1],
    ['legit: NULL into nullable refresh_token only',
      `INSERT INTO staff_session (id, staff_id, token, refresh_token) VALUES (1, ?, '', NULL)`, 0],
    ['legit: NULL into a nullable column of x',
      `UPDATE x SET price=NULL WHERE id=1`, 0],
    ['ON CONFLICT SET token=NULL is caught',
      `INSERT INTO staff_session (id, staff_id, token) VALUES (1, ?, '') ON CONFLICT(id) DO UPDATE SET token=NULL`, 1],
    ['no NULL at all → nothing',
      `INSERT INTO staff_session (id, staff_id, token) VALUES (1, ?, ?)`, 0],
  ];
  let ok = 0, bad = 0;
  for (const [name, sql, want] of cases) {
    const got = analyzeSql(sql, nn).length;
    if (got === want) { ok++; console.log(`  ok  ${name}`); }
    else { bad++; console.log(`FAIL  ${name} — expected ${want}, got ${got}`); }
  }
  console.log(`\ncheck-notnull-writes self-test: ${ok} passed, ${bad} failed`);
  return bad === 0;
}

// ── main ───────────────────────────────────────────────────────────────────
if (process.argv.includes('--self-test')) {
  process.exit(selfTest() ? 0 : 1);
}

const notNull = parseNotNullColumns(readFileSync(SCHEMA_FILE, 'utf8'));
const tableCount = Object.keys(notNull).length;
const colCount = Object.values(notNull).reduce((n, s) => n + s.size, 0);
const violations = scanTree(notNull);

console.log(`check-notnull-writes: ${colCount} NOT NULL columns across ${tableCount} tables.`);
if (violations.length) {
  console.error('\nLiteral NULL written into a NOT NULL column — this throws at runtime\n'
    + '(the A167 class: invisible to tsc, fatal the moment the write runs):\n');
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.table}.${v.column}  (${v.kind})`);
  }
  console.error('\nWrite the column\'s real value (\'\' if the reader coerces it, as A167 did),\n'
    + 'or make the column nullable in localDb.ts. Do not remove this gate.');
  process.exit(1);
}
console.log('OK — no literal NULL is written into a NOT NULL column.');
