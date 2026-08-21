#!/usr/bin/env node
/**
 * check-api-schema-drift.mjs — does the SERVER's DB access match the schema?
 *
 * WHY THIS EXISTS
 * check-schema-drift.mjs compares migrations to the live DB. Nothing compared
 * the SERVER CODE (apps/server) to the schema at all, so a route could
 * `.from('stock_movements').eq('business_id', …)` on a column that does not
 * exist and PostgREST would 400 only at runtime, in one vertical, silently.
 * Two such drifts were found by hand (A136): stock_movements.business_id and
 * users.pin. This gate mechanises that check so the next one can't ship.
 *
 * GROUND TRUTH
 * The schema is built by replaying migrations/*.sql into PGlite (real Postgres,
 * in-process) and reading information_schema. This is NOT circular: the server
 * code is a separate artifact from the migrations, so comparing the two catches
 * real disagreement. (scripts/schema-index.json — the live-DB snapshot — is
 * currently stale at 16 tables, so it cannot be the ground truth here.)
 *
 * WHAT IT CHECKS, per apps/server/src/**:
 *   A. TABLES   every supabase.from('t') / chunkIn('t',…) / fetchAllIds('t',…)
 *               names a table that exists.
 *   B. RPCS     every supabase.rpc('fn') names a function that exists.
 *   C. COLUMNS  every column is scoped to the nearest enclosing table anchor and
 *               must exist on that table —
 *                 · FILTER  .eq/.neq/.gt/.gte/.lt/.lte/.is/.in/.order/.contains
 *                 · WRITE   keys of a direct .insert/.update/.upsert object
 *                           literal (variable args and the upsert options object
 *                           are skipped — they can't be verified statically)
 *                 · READ    bare columns of a .select('a, b, …') string (embeds,
 *                           aliases, casts, json paths and * are handled)
 *
 * ALLOWLIST holds drifts that are KNOWN and TRACKED (register IDs). A gate that
 * fails on a filed, un-fixed finding is noise; removing an allowlist entry is
 * the definition of fixing it. New drift is never allowlisted → it fails.
 *
 *   node scripts/check-api-schema-drift.mjs [--verbose] [--self-test]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, '/'));
const { PGlite } = require('@electric-sql/pglite');

const VERBOSE   = process.argv.includes('--verbose');
const SELF_TEST = process.argv.includes('--self-test');

// Known, tracked drifts. Each entry MUST cite a register ID. Removing an entry
// is how you "fix" it — the gate then enforces the corrected code stays correct.
const ALLOWLIST = new Set([
  'stock_movements.business_id', // A136 — fueltanks.ts, reports.ts (scopes by branch_id)
  'users.pin',                   // A136 — staff.ts PIN lookup (column is pin_hash)
]);

// ── build the schema in PGlite from migrations ───────────────────────────────
async function buildSchema() {
  const MIG = path.join(ROOT, 'migrations');
  const files = fs.readdirSync(MIG).filter(f => f.endsWith('.sql'))
    .sort((a, b) => (+a.split('_')[0]) - (+b.split('_')[0]) || a.localeCompare(b));
  // Strip only single-line pg_dump/psql artifacts; keep all real DDL.
  const sanitize = sql => sql.split('\n').filter(l => {
    const t = l.trim();
    return !(t.startsWith('\\')
      || /^CREATE SCHEMA public;/i.test(t)
      || /set_config\('search_path'/i.test(t)
      || /^SET\s+search_path/i.test(t));
  }).join('\n').replace(/uuid_generate_v4\(\)/gi, 'gen_random_uuid()');

  const db = new PGlite();
  // Supabase-provided objects the migrations assume exist.
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS auth; CREATE SCHEMA IF NOT EXISTS extensions;
    DO $$ BEGIN CREATE ROLE anon;          EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE service_role;  EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text);
    CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid  LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
    CREATE OR REPLACE FUNCTION auth.role() RETURNS text  LANGUAGE sql STABLE AS $$ SELECT 'service_role'::text $$;
    CREATE OR REPLACE FUNCTION auth.jwt()  RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
    CREATE OR REPLACE FUNCTION extensions.uuid_generate_v4() RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
    CREATE OR REPLACE FUNCTION extensions.gen_random_uuid()  RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
    CREATE OR REPLACE FUNCTION extensions.digest(text,text)  RETURNS bytea LANGUAGE sql AS $$ SELECT sha256($1::bytea) $$;
  `);
  await db.exec('SET search_path TO public, extensions, auth;');

  let applied = 0; const failed = [];
  for (const f of files) {
    const sql = sanitize(fs.readFileSync(path.join(MIG, f), 'utf8'));
    if (!sql.trim()) { applied++; continue; }
    try { await db.exec(sql); applied++; }
    catch (e) { failed.push({ f, err: String(e.message || e).split('\n')[0] }); try { await db.exec('ROLLBACK'); } catch {} }
  }
  if (failed.length) {
    // A migration that won't replay means the schema is incomplete → we cannot
    // trust a "clean" result, so fail loudly rather than pass on a partial DB.
    console.error(`✗ ${failed.length} migration(s) failed to replay — schema incomplete, cannot check:`);
    for (const x of failed) console.error(`    ${x.f}: ${x.err}`);
    process.exit(2);
  }
  const q = async s => (await db.query(s)).rows;
  const tabs = new Set((await q(`select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE'`)).map(r => r.table_name));
  const fns  = new Set((await q(`select routine_name from information_schema.routines where routine_schema='public'`)).map(r => r.routine_name));
  const colsByTable = {};
  for (const r of await q(`select table_name, column_name from information_schema.columns where table_schema='public'`))
    (colsByTable[r.table_name] ??= new Set()).add(r.column_name);
  return { tabs, fns, colsByTable, applied, total: files.length };
}

// ── parse the server for DB references ───────────────────────────────────────
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
const walk = d => { let o = []; for (const e of fs.readdirSync(d)) { const p = path.join(d, e); if (e === 'node_modules' || e === 'dist') continue; if (fs.statSync(p).isDirectory()) o.push(...walk(p)); else if (/\.ts$/.test(e)) o.push(p); } return o; };

const FILTERS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is', 'in', 'order', 'contains'];
// <[^(]*> (not <[^>]*>) so a NESTED generic like chunkIn<Record<string,unknown>>
// is still recognised as an anchor — otherwise its columns misattribute to the
// previous .from(). ANCHOR_SRC is shared by anchorsFor and the table check.
const ANCHOR_SRC = `(?:\\.from\\(\\s*|(?:chunkIn|fetchAllIds)\\s*(?:<[^(]*>)?\\s*\\(\\s*)['"\`]([a-z_]+)['"\`]`;

// Find every "table anchor" (a point where the active table becomes known) and
// the character offset it starts at, so columns can be scoped to the nearest
// preceding anchor. Anchors: .from('t'), chunkIn('t', fetchAllIds('t'.
function anchorsFor(src) {
  const anchors = [];
  for (const m of src.matchAll(new RegExp(ANCHOR_SRC, 'g'))) anchors.push({ at: m.index, table: m[1] });
  anchors.sort((a, b) => a.at - b.at);
  return anchors;
}
function tableAt(anchors, offset) {
  let t = null;
  for (const a of anchors) { if (a.at <= offset) t = a.table; else break; }
  return t;
}

// Skip one value expression from index i to the top-level ',' or '}' that ends
// it, respecting nested (){}[] and strings/templates. Used to walk past values
// when reading object keys so a value identifier is never mistaken for a key.
function skipValue(src, i) {
  let depth = 0, str = null, tmpl = false;
  for (; i < src.length; i++) {
    const c = src[i], p = src[i - 1];
    if (str)  { if (c === str && p !== '\\') str = null; continue; }
    if (tmpl) { if (c === '`' && p !== '\\') tmpl = false; continue; }
    if (c === "'" || c === '"') { str = c; continue; }
    if (c === '`') { tmpl = true; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === '}') { if (depth === 0) return i; depth--; }
    else if (c === ',' && depth === 0) return i;
  }
  return i;
}
// Top-level keys of a DIRECT object literal starting after `.insert(`/`.update(`.
// Returns null when the arg is a variable/expression (can't verify statically),
// which is what makes .update(row) and .upsert(row,{onConflict}) safe to ignore.
function objectKeys(src, i) {
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src[i] === '[') { i++; while (i < src.length && /\s/.test(src[i])) i++; }
  if (src[i] !== '{') return null;
  i++;
  const keys = [];
  while (i < src.length) {
    while (i < src.length && /\s/.test(src[i])) i++;
    const c = src[i];
    if (c === '}') break;
    if (c === ',') { i++; continue; }
    if (src.startsWith('...', i)) { i = skipValue(src, i); continue; } // spread
    let key = null;
    const q = /^(['"])([A-Za-z_][A-Za-z0-9_]*)\1/.exec(src.slice(i));
    if (q) { key = q[2]; i += q[0].length; }
    else {
      const id = /^[A-Za-z_$][A-Za-z0-9_]*/.exec(src.slice(i));
      if (id) { key = id[0]; i += id[0].length; }
      else if (src[i] === '[') { let d = 0; for (; i < src.length; i++) { if (src[i] === '[') d++; else if (src[i] === ']') { d--; if (d === 0) { i++; break; } } } }
      else { i++; continue; }
    }
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] === ':') { i++; if (key) keys.push(key); i = skipValue(src, i); } // key: value
    else if (key) keys.push(key);                                               // shorthand
  }
  return [...new Set(keys)];
}
// Bare column tokens from a PostgREST select string. Skips *, embeds table(...),
// then strips cast (::), json path (->) and alias (a:col) — in that order, so a
// cast like status::text is not mistaken for an alias.
function selectCols(arg) {
  const parts = []; let depth = 0, cur = '';
  for (const ch of arg) { if (ch === '(') depth++; else if (ch === ')') depth--; if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch; }
  if (cur.trim()) parts.push(cur);
  const cols = [];
  for (let tok of parts) {
    tok = tok.trim(); if (!tok || tok === '*') continue;
    if (tok.includes('(')) continue;                       // embed
    if (tok.includes('::')) tok = tok.split('::')[0].trim();
    if (tok.includes('->')) tok = tok.split('->')[0].trim();
    if (tok.includes(':'))  tok = tok.split(':').pop().trim();
    tok = tok.replace(/!inner|!left/g, '').trim();
    if (/^[a-z_][a-z0-9_]*$/.test(tok)) cols.push(tok);
  }
  return cols;
}

function collect() {
  const tableRefs = [], rpcRefs = [], colRefs = [];
  for (const f of walk(path.join(ROOT, 'apps/server/src'))) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    const rel = f.replace(path.join(ROOT, 'apps/server/src') + '/', '');
    const anchors = anchorsFor(src);
    for (const m of src.matchAll(new RegExp(ANCHOR_SRC, 'g')))
      tableRefs.push({ table: m[1], rel });
    for (const m of src.matchAll(/\.rpc\(\s*['"`]([a-z_]+)['"`]/g))
      rpcRefs.push({ fn: m[1], rel });
    // filter columns: .eq('col') etc.
    for (const m of src.matchAll(new RegExp(`\\.(${FILTERS.join('|')})\\(\\s*['"\`]([a-z_]+)['"\`]`, 'g'))) {
      const table = tableAt(anchors, m.index);
      if (table) colRefs.push({ table, col: m[2], op: m[1], rel });
    }
    // written columns: .insert({…}) / .update({…}) / .upsert({…})
    for (const m of src.matchAll(/\.(insert|update|upsert)\(/g)) {
      const table = tableAt(anchors, m.index); if (!table) continue;
      const keys = objectKeys(src, m.index + m[0].length); if (!keys) continue;
      for (const k of keys) colRefs.push({ table, col: k, op: m[1], rel });
    }
    // read columns: .select('a, b, c')
    for (const m of src.matchAll(/\.select\(\s*(['"`])([\s\S]*?)\1/g)) {
      const table = tableAt(anchors, m.index); if (!table) continue;
      for (const c of selectCols(m[2])) colRefs.push({ table, col: c, op: 'select', rel });
    }
  }
  return { tableRefs, rpcRefs, colRefs };
}

function analyse(schema, refs, extra = {}) {
  const missTable = new Set(), missRpc = new Set(), missCol = new Map();
  for (const { table, rel } of [...refs.tableRefs, ...(extra.tableRefs || [])])
    if (!schema.tabs.has(table)) missTable.add(`${table}  (${rel})`);
  for (const { fn, rel } of [...refs.rpcRefs, ...(extra.rpcRefs || [])])
    if (!schema.fns.has(fn)) missRpc.add(`${fn}  (${rel})`);
  for (const { table, col, op, rel } of [...refs.colRefs, ...(extra.colRefs || [])]) {
    if (!schema.colsByTable[table]) continue;          // unknown table handled above
    if (schema.colsByTable[table].has(col)) continue;  // exists → fine
    const key = `${table}.${col}`;
    if (!missCol.has(key)) missCol.set(key, `${key}  via .${op}()  (${rel})`);
  }
  return { missTable, missRpc, missCol };
}

// ── run ──────────────────────────────────────────────────────────────────────
const schema = await buildSchema();
if (VERBOSE) console.log(`schema: ${schema.tabs.size} tables, ${schema.fns.size} functions (${schema.applied}/${schema.total} migrations)`);

if (SELF_TEST) {
  let pass = 0, tot = 0;
  const t = (name, cond) => { tot++; if (cond) pass++; console.log(`${cond ? '✓' : '✗'} ${name}`); };

  // 1. schema matcher: a bogus table, rpc, and filter column are each caught.
  const r = analyse(schema, { tableRefs: [], rpcRefs: [], colRefs: [] }, {
    tableRefs: [{ table: 'totally_not_a_table', rel: 'self-test' }],
    rpcRefs:   [{ fn: 'totally_not_an_rpc',   rel: 'self-test' }],
    colRefs:   [{ table: 'orders', col: 'totally_not_a_column', op: 'eq', rel: 'self-test' }],
  });
  t('matcher detects bogus table', r.missTable.size === 1);
  t('matcher detects bogus rpc',   r.missRpc.size === 1);
  t('matcher detects bogus filter column', r.missCol.size === 1);

  // 2. extractors: injected bad insert/update/select columns are found, and
  //    valid patterns (shorthand, spread, variable arg, options, embed, cast)
  //    are NOT mis-flagged — the regression that would re-introduce noise.
  const ik = s => { const m = /\.(insert|update|upsert)\(/.exec(s); return objectKeys(s, m.index + m[0].length); };
  t('insert: bad key extracted',        (ik(`x.insert({ nope_ins: 1, total: 2 })`) || []).includes('nope_ins'));
  t('insert: shorthand keys extracted', JSON.stringify(ik(`x.insert({ id, total })`)) === JSON.stringify(['id', 'total']));
  t('insert: value ident not a key',    !(ik(`x.insert({ total: qty })`) || []).includes('qty'));
  t('insert: variable arg skipped',     ik(`x.insert(row)`) === null);
  t('upsert: options object ignored',   ik(`x.upsert(row, { onConflict: 'id' })`) === null);
  t('select: bad col extracted',        selectCols('id, nope_sel, total').includes('nope_sel'));
  t('select: embed ignored',            !selectCols('id, order_items(product_id)').includes('product_id'));
  t('select: cast not mistaken',        !selectCols('status::text').includes('text') && selectCols('status::text').includes('status'));

  console.log(`\n${pass}/${tot} self-tests passed`);
  process.exit(pass === tot ? 0 : 1);
}

const refs = collect();
const { missTable, missRpc, missCol } = analyse(schema, refs);

// Split column misses into allowlisted (tracked) and new (fatal).
const newCols = [], allowed = [];
for (const [key, line] of missCol) (ALLOWLIST.has(key) ? allowed : newCols).push(line);

let fatal = 0;
const section = (title, items) => { if (items.length) { fatal += items.length; console.error(`\n✗ ${title} — ${items.length}`); for (const x of items) console.error('    ' + x); } };
section('TABLES the server queries that do not exist', [...missTable]);
section('RPCS the server calls that do not exist', [...missRpc]);
section('COLUMNS the server filters on that do not exist (new drift)', newCols);

if (allowed.length && VERBOSE) {
  console.log(`\nℹ ${allowed.length} known drift(s) allowlisted (A136), not failing:`);
  for (const x of allowed) console.log('    ' + x);
}

if (fatal) { console.error(`\ncheck-api-schema-drift: ${fatal} un-tracked drift(s). Fix the code or, if intentional, file a register ID and allowlist it.`); process.exit(1); }
console.log(`check-api-schema-drift: OK — every server table/rpc/filter-column matches the schema (${allowed.length} known drift allowlisted under A136).`);
