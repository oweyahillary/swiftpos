#!/usr/bin/env node
/**
 * check-push-domain-parity.mjs — the gate schema-parity.mjs deliberately does not.
 *
 * WHY THIS EXISTS
 * ---------------
 * `schema-parity.mjs` compares the SET OF COLUMNS between the till's SQLite
 * (localDb.ts) and the cloud's Postgres (migrations/*.sql), weighted by sync
 * direction. It says so itself: "It does not compare types … flagging that would
 * produce noise nobody reads." That is the right call for TEXT-vs-uuid. But it
 * leaves one shape uncovered, and that shape has now bitten twice:
 *
 *   A128 — cloud `payments.method` was CHECK-constrained to a fixed value list
 *          (cash|mpesa|card|credit|glovo) and varchar(20); local `method` is free
 *          TEXT. A95's per-business custom tenders write codes like `coop_card`.
 *          The column is present in BOTH schemas, so schema-parity is silent — but
 *          the INSERT fails 23514 in the cloud, the order parks, retries, and the
 *          sale never leaves the till. Fixed by migration 89.
 *
 *   A129 — cloud `orders.order_type` was NARROWED by migration 58 to
 *          {dine_in, takeaway, retail, parking_session, fuel_sale}, dropping the
 *          baseline `delivery`. But `delivery` is a live POS selectable
 *          (POSPage chooseOrderType), Zod-accepted (schemas.ts), and the server
 *          sets a delivery_person for it. Same 23514, same silent loss. Fixed by
 *          migration 90.
 *
 * Both are the register's recurring shape: two things that must agree, and nothing
 * comparing them. schema-parity checks PRESENCE; this checks DOMAIN.
 *
 * WHAT IT CHECKS
 * --------------
 * For every column on a PUSH table (SYNC_DIRECTION in syncEngine.ts) that the
 * cloud constrains with a fixed-value CHECK, it compares that value list against
 * the set of values the PRODUCERS can actually emit — declared, with a source
 * citation, in scripts/push-domain-producers.json. Any producible value the cloud
 * CHECK would reject is a silent-sync-loss defect and fails the gate.
 *
 * It resolves the FINAL constraint after all migrations, honouring
 * ADD/DROP CONSTRAINT (so migration 58's narrowing and 89's enum→format swap both
 * land correctly). Format checks (regex, e.g. payments.method after A128) and
 * length limits are reported for the record but only a fixed-value list can be
 * diffed against a producer set, so only that mismatch fails.
 *
 * WHY A PRODUCER MANIFEST, NOT AUTO-INFERENCE
 * -------------------------------------------
 * The producing values live across TS union types, Zod enums and string literals
 * in two apps; inferring them by regex would be its own stale index (the eleven-day
 * lesson). The manifest is small, reviewed, and every entry cites where the value
 * comes from — so a new emitted value is a deliberate one-line edit, and the diff
 * against the cloud is exact rather than approximate.
 *
 *   Usage:  node scripts/check-push-domain-parity.mjs [--json] [--verbose]
 *   Exit:   0 = every producible value is admitted by the cloud
 *           1 = a producible value would be rejected (silent sync loss)
 *           2 = parse floor not met (refuses to pass on having parsed nothing)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = path.join(ROOT, 'migrations');
const SYNC_ENGINE = path.join(ROOT, 'apps', 'desktop', 'src', 'main', 'syncEngine.ts');
const MANIFEST = path.join(ROOT, 'scripts', 'push-domain-producers.json');

// Parse floor — never pass because we parsed nothing (the schema-parity lesson).
const MIN_CHECKS = Number(process.env.PDP_MIN_CHECKS ?? 6);

// Quote-aware comment strip (borrowed from schema-parity.mjs — same reasoning).
const strip = (sql) => {
  let out = '', quote = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) { out += ch; if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; out += ch; continue; }
    if (ch === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i++; out += '\n'; continue; }
    if (ch === '/' && sql[i + 1] === '*') { const e = sql.indexOf('*/', i + 2); i = e === -1 ? sql.length : e + 1; out += ' '; continue; }
    out += ch;
  }
  return out;
};

function migrationsInOrder() {
  return fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort((a, b) => {
    const na = parseInt(a, 10), nb = parseInt(b, 10);
    if (Number.isNaN(na) && Number.isNaN(nb)) return a.localeCompare(b);
    if (Number.isNaN(na)) return 1;
    if (Number.isNaN(nb)) return -1;
    return na - nb;
  });
}

// Split a parenthesised table body on top-level commas only.
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

// SQL keywords that can lead a CHECK body but are never the column name.
const NOT_A_COL = new Set(['not', 'null', 'and', 'or', 'true', 'false', 'check', 'constraint']);

// The constrained column is the first bare identifier in the CHECK body, after
// peeling leading parens and ignoring cast noise. Bodies come in two shapes:
//   ((order_type)::text = ANY (ARRAY[...]))     -> order_type
//   order_type = ANY (ARRAY[ 'dine_in'::... ])  -> order_type
//   close_method IS NULL OR close_method = ...   -> close_method
//   type IN ('charge','payment','adjustment')    -> type
function firstCol(body) {
  const m = body.match(/[A-Za-z_][A-Za-z0-9_]*/);
  if (!m) return null;
  const id = m[0];
  return NOT_A_COL.has(id.toLowerCase()) ? null : id;
}

// Pull the value list out of `= ANY (ARRAY[ ... ])` or `col IN ( ... )`.
function valueListFrom(body) {
  const anyIdx = body.search(/=\s*ANY\s*\(\s*ARRAY\s*\[/i);
  if (anyIdx !== -1) {
    const open = body.indexOf('[', anyIdx);
    let depth = 0, seg = '';
    for (let i = open; i < body.length; i++) {
      const ch = body[i];
      if (ch === '[') { depth++; if (depth === 1) continue; }
      if (ch === ']') { depth--; if (depth === 0) break; }
      seg += ch;
    }
    const vals = [...seg.matchAll(/'([^']*)'/g)].map(m => m[1]);
    if (vals.length) return [...new Set(vals)];
  }
  const inM = body.match(/\bIN\s*\(([^)]*)\)/i);
  if (inM) {
    const vals = [...inM[1].matchAll(/'([^']*)'/g)].map(m => m[1]);
    if (vals.length) return [...new Set(vals)];
  }
  return null;
}

// Resolve, per "table.column", the FINAL cloud constraint after every migration.
// Named CHECKs are tracked by name (so DROP/ADD across migrations resolve); the
// current state is then folded to table.col. Unnamed inline CHECKs key on
// table.col directly (a later migration overwrites an earlier one).
function resolveCloudDomains() {
  const byName = new Map();   // constraintName -> { table, col, kind, values?, regex? }
  const byCol  = new Map();   // "table.col"    -> { table, col, kind, values?, regex? }  (unnamed)
  const lengths = new Map();  // "table.col"    -> n

  const record = (target, key, table, body) => {
    const col = firstCol(body);
    if (!col) return;
    const rx = body.match(/~\s*'([^']*)'/);
    const vals = valueListFrom(body);
    if (vals) target.set(key, { table, col, kind: 'values', values: vals });
    else if (rx) target.set(key, { table, col, kind: 'format', regex: rx[1] });
  };

  for (const f of migrationsInOrder()) {
    const sql = strip(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));

    for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?(\w+)"?\s*\(([\s\S]*?)\n\s*\)\s*;/gi)) {
      const table = m[1], body = m[2];
      for (const clause of splitTopLevel(body)) {
        // lengths: `col varchar(n)` / `col character varying(n)`
        const lm = clause.match(/^"?(\w+)"?\s+(?:character varying|varchar)\s*\(\s*(\d+)\s*\)/i);
        if (lm) lengths.set(`${table}.${lm[1]}`, Number(lm[2]));

        const named = clause.match(/^CONSTRAINT\s+(\w+)\s+CHECK\s*\(([\s\S]*)\)\s*$/i);
        if (named) { record(byName, named[1], table, named[2]); continue; }

        // unnamed inline column CHECK: `col TYPE ... CHECK ( ... )`
        if (/^[A-Za-z_]/.test(clause) && /\bCHECK\s*\(/i.test(clause) && !/^CONSTRAINT\b/i.test(clause)) {
          const col = clause.match(/^"?(\w+)"?/)[1];
          const chk = clause.match(/CHECK\s*\(([\s\S]*)\)\s*$/i);
          if (chk) {
            const vals = valueListFrom(chk[1]);
            const rx = chk[1].match(/~\s*'([^']*)'/);
            if (vals) byCol.set(`${table}.${col}`, { table, col, kind: 'values', values: vals });
            else if (rx) byCol.set(`${table}.${col}`, { table, col, kind: 'format', regex: rx[1] });
          }
        }
      }
    }

    for (const m of sql.matchAll(/ALTER\s+TABLE\s+(?:ONLY\s+)?(?:public\.)?"?(\w+)"?\s+ALTER\s+COLUMN\s+"?(\w+)"?\s+TYPE\s+(?:character varying|varchar)\s*\(\s*(\d+)\s*\)/gi)) {
      lengths.set(`${m[1]}.${m[2]}`, Number(m[3]));
    }
    // DROP before ADD within a file: migrations write `DROP …_check; ADD …_check;`
    // (drop the old definition, add the new) — often the SAME name (58, 41). If we
    // added first and dropped second we would erase the very constraint just added.
    for (const m of sql.matchAll(/ALTER\s+TABLE\s+(?:ONLY\s+)?(?:public\.)?"?(\w+)"?\s+DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?(\w+)/gi)) {
      byName.delete(m[2]);
    }
    for (const m of sql.matchAll(/ALTER\s+TABLE\s+(?:ONLY\s+)?(?:public\.)?"?(\w+)"?\s+ADD\s+CONSTRAINT\s+(\w+)\s+CHECK\s*\(([\s\S]*?)\)\s*;/gi)) {
      record(byName, m[2], m[1], m[3]);
    }
  }

  // Fold to one entry per table.col — a named constraint (current) wins over any
  // unnamed inline of the same column.
  const constraints = new Map();
  for (const c of byCol.values()) constraints.set(`${c.table}.${c.col}`, c);
  for (const c of byName.values()) constraints.set(`${c.table}.${c.col}`, c);
  return { constraints, lengths };
}

function parsePushTables() {
  const src = fs.readFileSync(SYNC_ENGINE, 'utf8');
  const block = src.match(/SYNC_DIRECTION[^=]*=\s*\{([\s\S]*?)\n\}/);
  const push = new Set();
  if (block) for (const m of strip(block[1]).matchAll(/(\w+)\s*:\s*'push'/g)) push.add(m[1]);
  return push;
}

// ── run ──────────────────────────────────────────────────────────────────────
const { constraints, lengths } = resolveCloudDomains();
const push = parsePushTables();
const manifest = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : { producers: {} };
const producers = manifest.producers ?? {};

// Every fixed-value CHECK that lands on a push table.
const valueChecks = [...constraints.values()]
  .filter(c => c.kind === 'values' && c.col && push.has(c.table))
  .map(c => ({ ...c, key: `${c.table}.${c.col}` }));

if (valueChecks.length < MIN_CHECKS) {
  console.error(
    `check-push-domain-parity: PARSE FLOOR NOT MET — found ${valueChecks.length} value-list CHECK(s) on push tables, expected >= ${MIN_CHECKS}.\n` +
    `The migration parser probably stopped matching. Refusing to pass on nothing.`);
  process.exit(2);
}

const failures = [];   // producible value the cloud rejects
const unreviewed = []; // constrained push column with no producer entry — must be reviewed
const okCols = [];

for (const c of valueChecks) {
  const declared = producers[c.key];
  if (!declared) { unreviewed.push(c); continue; }
  const allowed = new Set(c.values);
  const rejected = (declared.emits ?? []).filter(v => !allowed.has(v));
  if (rejected.length) failures.push({ ...c, rejected, source: declared.source });
  else okCols.push(c);
}

// An unreviewed constrained push column is itself a gap: nobody has confirmed the
// producers stay inside the cloud domain. Treat as failure — the A128 default is
// "prove it agrees", not "assume it does".
const hardFail = failures.length || unreviewed.length;

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ failures, unreviewed, ok: okCols.map(c => c.key) }, null, 2));
} else {
  console.log(`check-push-domain-parity: ${valueChecks.length} value-list CHECK(s) on push tables\n`);
  if (failures.length) {
    console.log(`FAIL (${failures.length}) — a producible value the cloud CHECK rejects (silent sync loss):`);
    for (const f of failures) {
      console.log(`  ${f.key}  emits {${f.rejected.join(', ')}} — cloud admits only {${f.values.join(', ')}}`);
      console.log(`      producer: ${f.source}`);
    }
    console.log('');
  }
  if (unreviewed.length) {
    console.log(`UNREVIEWED (${unreviewed.length}) — constrained push column with no producer entry in push-domain-producers.json:`);
    for (const u of unreviewed) console.log(`  ${u.key}  cloud admits {${u.values.join(', ')}} — add a reviewed 'emits' set`);
    console.log('');
  }
  if (process.argv.includes('--verbose')) {
    console.log(`OK (${okCols.length}) — producers within the cloud domain:`);
    for (const c of okCols) console.log(`  ${c.key}  {${c.values.join(', ')}}`);
    const fmt = [...constraints.values()].filter(c => c.kind === 'format' && push.has(c.table));
    if (fmt.length) { console.log(`\nFORMAT checks (shape, not a list — reported only):`); for (const c of fmt) console.log(`  ${c.table}.${c.col}  ~ ${c.regex}`); }
    console.log('');
  }
  console.log(hardFail ? 'FAIL' : 'PASS — every producible value is admitted by the cloud');
}

process.exit(hardFail ? 1 : 0);
