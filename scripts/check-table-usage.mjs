#!/usr/bin/env node
/**
 * check-table-usage.mjs — the gate that would have caught the low-stock bug.
 *
 * WHAT WENT WRONG THAT THIS EXISTS FOR
 * The live schema carries BOTH `stock` and `stock_levels`. Every sale writes
 * `stock_levels`. `lowStockChecker.ts` and `dailySummary.ts` read `stock`.
 * So the low-stock alert queried a table nothing had written since the two
 * diverged, found nothing, and returned silently — `if (!levels?.length) return`.
 * Alerts were dead for months and every existing gate stayed green, because:
 *
 *   - schema-audit passes: both tables exist in schema-index.json with valid
 *     columns, so `.from('stock')` is a legal query.
 *   - tsc passes: supabase-js types `.from(x)` as `any`.
 *   - RLS coverage passes: both tables state their RLS.
 *
 * Nothing compared WHO WRITES a table against WHO READS it. That is this file.
 *
 * WHAT IT REPORTS
 *   READ-ONLY   a table read in code and never written in code.
 *   WRITE-ONLY  a table written in code and never read.
 *   TWINS       two tables with near-identical column sets, where one is
 *               written and the other read — the `stock` / `stock_levels`
 *               shape specifically.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * Read-only is NORMAL for reference data seeded by migration (permissions,
 * plans) and for tables written only by a trigger or an RPC. Write-only is
 * normal for append-only audit tables nothing in the app reads back. So this
 * FAILS only on TWINS, which is the actually-dangerous shape, and prints the
 * other two as information. Exceptions live in table-usage-exceptions.json so
 * the intentional cases are stated once rather than argued every run.
 *
 * Usage:  node scripts/check-table-usage.mjs [--verbose]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE    = path.dirname(fileURLToPath(import.meta.url));
const ROOT    = path.resolve(HERE, '..');
const VERBOSE = process.argv.includes('--verbose');

const schemaIndex = JSON.parse(
  fs.readFileSync(path.join(HERE, 'schema-index.json'), 'utf8'));

const EXC_PATH = path.join(HERE, 'table-usage-exceptions.json');
const exceptions = fs.existsSync(EXC_PATH)
  ? JSON.parse(fs.readFileSync(EXC_PATH, 'utf8'))
  : { readOnly: [], writeOnly: [], twins: [] };

// ── collect source ───────────────────────────────────────────────────────────
const SRC_DIRS = ['apps/server/src', 'apps/dashboard/src', 'apps/admin/src'];
const files = [];
for (const d of SRC_DIRS) {
  const base = path.join(ROOT, d);
  if (!fs.existsSync(base)) continue;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name)) files.push(p);
    }
  };
  walk(base);
}

/**
 * A supabase-js chain is `.from('t')` followed by the verb. The verb can be
 * several lines down, so match on the whole chain rather than one line:
 * everything from `.from('t')` to the next `.from(` or a blank-line-terminated
 * statement. A window of 400 chars covers every chain in this codebase and
 * costs nothing to widen.
 */
const WRITE_VERBS = /\.(insert|upsert|update|delete)\s*\(/;
const READ_VERBS  = /\.(select|count)\s*\(/;

const reads  = new Map();   // table -> Set(file:line)
const writes = new Map();
const add = (m, t, where) => { if (!m.has(t)) m.set(t, new Set()); m.get(t).add(where); };

/**
 * Comments are stripped before scanning. Otherwise a comment EXPLAINING that a
 * table used to be read here — which is exactly the comment a fix leaves
 * behind — reads as a live query and the gate reports the bug it just verified
 * was fixed. Caught on the first run after the stock_levels fix landed.
 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))   // keep line count
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));

for (const p of files) {
  const raw   = fs.readFileSync(p, 'utf8');
  const text  = stripComments(raw);
  const rel   = path.relative(ROOT, p);
  const lines = text.split('\n');
  const lineOf = (idx) => text.slice(0, idx).split('\n').length;

  for (const m of text.matchAll(/\.from\(\s*['"`]([a-z0-9_]+)['"`]\s*\)/g)) {
    const table = m[1];
    if (!schemaIndex[table]) continue;          // not a known table — schema-audit's job
    const ln     = lineOf(m.index);
    const window = text.slice(m.index, m.index + 400);
    // stop the window at the next .from( so verbs don't bleed across chains
    const next   = window.slice(1).search(/\.from\(/);
    const chain  = next === -1 ? window : window.slice(0, next + 1);

    const where = `${rel}:${ln}`;
    if (WRITE_VERBS.test(chain)) add(writes, table, where);
    if (READ_VERBS.test(chain))  add(reads,  table, where);
    // A bare `.from('t')` with neither verb in range is a select in
    // supabase-js only when .select() follows; if neither matched, count it as
    // a read rather than losing the site entirely.
    if (!WRITE_VERBS.test(chain) && !READ_VERBS.test(chain)) add(reads, table, where);
  }
  void lines;
}

// ── classify ─────────────────────────────────────────────────────────────────
const touched  = new Set([...reads.keys(), ...writes.keys()]);
const readOnly  = [...touched].filter(t => reads.has(t)  && !writes.has(t)).sort();
const writeOnly = [...touched].filter(t => writes.has(t) && !reads.has(t)).sort();

/** Column-set similarity, ignoring id/timestamps that every table carries. */
const NOISE = new Set(['id', 'created_at', 'updated_at', 'business_id']);
const colsOf = (t) => new Set(Object.keys(schemaIndex[t] ?? {}).filter(c => !NOISE.has(c)));
const jaccard = (a, b) => {
  const inter = [...a].filter(x => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : inter / union;
};

const twins = [];
const allTables = Object.keys(schemaIndex);
for (let i = 0; i < allTables.length; i++) {
  for (let j = i + 1; j < allTables.length; j++) {
    const [a, b] = [allTables[i], allTables[j]];
    const sim = jaccard(colsOf(a), colsOf(b));
    if (sim < 0.8) continue;
    if (colsOf(a).size < 2) continue;           // trivially similar stubs
    // Only dangerous when one is written and the other is read.
    const aW = writes.has(a), bW = writes.has(b);
    const aR = reads.has(a),  bR = reads.has(b);
    if ((aW && !bW && bR) || (bW && !aW && aR)) {
      twins.push({ a, b, sim, written: aW ? a : b, read: aW ? b : a });
    }
  }
}

const isExcepted = (list, t) => (exceptions[list] ?? []).some(e => (e.table ?? e) === t);
const liveTwins  = twins.filter(t =>
  !(exceptions.twins ?? []).some(e => (e.pair ?? []).includes(t.a) && (e.pair ?? []).includes(t.b)));

// ── report ───────────────────────────────────────────────────────────────────
const show = (label, list, m) => {
  const kept = list.filter(t => !isExcepted(label === 'READ-ONLY' ? 'readOnly' : 'writeOnly', t));
  console.log(`\n${label} (${kept.length}${kept.length !== list.length ? ` of ${list.length}, rest excepted` : ''})`);
  for (const t of kept) {
    const where = [...(m.get(t) ?? [])].slice(0, VERBOSE ? 99 : 2).join(', ');
    console.log(`  ${t.padEnd(32)} ${where}`);
  }
};

console.log(`check-table-usage: ${touched.size} tables touched in code, ` +
            `${allTables.length} in the schema index.`);

if (VERBOSE) {
  show('READ-ONLY', readOnly, reads);
  show('WRITE-ONLY', writeOnly, writes);
}

if (liveTwins.length) {
  console.error(`\nTWIN TABLES — one written, the other read. This is the ` +
                `stock / stock_levels shape:\n`);
  for (const t of liveTwins) {
    console.error(`  ${t.a}  ~  ${t.b}   (${Math.round(t.sim * 100)}% column overlap)`);
    console.error(`     WRITTEN: ${t.written}  ${[...(writes.get(t.written) ?? [])].slice(0, 3).join(', ')}`);
    console.error(`     READ:    ${t.read}  ${[...(reads.get(t.read) ?? [])].slice(0, 3).join(', ')}`);
    console.error(`     → the reader sees whatever was in ${t.read} when the two diverged.\n`);
  }
  console.error(`If a pair is deliberate, add it to scripts/table-usage-exceptions.json`);
  console.error(`with a reason. Do not add it without one.`);
  process.exit(1);
}

console.log(`\nOK — no table is written under one name and read under another.`);
if (!VERBOSE) console.log(`   (--verbose lists read-only and write-only tables too.)`);
