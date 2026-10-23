/**
 * test-migration-153.mjs — A535: stock levels in the change log (topic stock), run for real against the WHOLE schema (every
 * migration before 153 replayed into PGlite, 151 included).
 *
 * Owner, 2026-10-19: "this should only happen when there is a change, no need to keep asking for the same item" — the till
 * re-read the branch's whole stock list every 30 minutes because the log (151) did not carry stock.
 *
 *   - 153 runs twice, recorded once; the functions are not callable by anon / authenticated.
 *   - a level written (adjust_product_stock, as a sale does): ONE entry stock:<product>:stock:upsert at ITS branch, of the
 *     branch's business; an update that changes only updated_at writes nothing; a delete is a delete.
 *   - volume: a 10-line sale (10 tracked products, each line its own transaction — routes stockEffects) writes 10 entries;
 *     the next sale of the same products REPLACES them (the log still holds 10); one transaction writing a level 3 times
 *     writes it once.
 *   - another branch's level: at its branch — sync_changes_since for this branch leaves it out; another business: its own.
 *   - sync_changes_heads_by_branch: per business AND branch.
 *   - CHANGE_TABLES.stock (shared/syncTopics.ts) names the table the trigger sits on.
 *   - a trigger that cannot write never fails the stock write.
 *
 * MUTATIONS TO CONFIRM BITE (checked by hand, 2026-10-20):
 *   - the DELETE of the older entry removed                       → "the next sale REPLACES them" fails
 *   - the transaction flag removed                                → "one transaction: once" fails
 *   - the updated_at-only check removed                           → "updated_at alone writes nothing" fails
 *   - v_branch left NULL (every branch)                           → "another branch's level" fails
 *   - the EXCEPTION handler re-raising                            → "never fails the write" fails
 */
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
import assert from 'node:assert'; import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch { console.error('\n@electric-sql/pglite not installed — cannot run.\n'); process.exit(1); }
const { CHANGE_TABLES, SYNC_TOPICS, CRITICAL_TOPICS } = await import(pathToFileURL(path.join(ROOT, 'shared/syncTopics.ts')).href);
const MIG = path.join(ROOT, 'migrations');
const num = (f) => +f.split('_')[0];
const files = fs.readdirSync(MIG).filter(f => f.endsWith('.sql') && Number.isFinite(num(f))).sort((a, b) => num(a) - num(b) || a.localeCompare(b));
const BS = String.fromCharCode(92);
const sanitize = sql => sql.split('\n').filter(l => { const t = l.trim(); return !(t.startsWith(BS) || /^CREATE SCHEMA public;/i.test(t) || /set_config\('search_path'/i.test(t) || /^SET\s+search_path/i.test(t)); }).join('\n').replace(/uuid_generate_v4\(\)/gi, 'gen_random_uuid()');
const db = new PGlite();
await db.exec(`CREATE SCHEMA IF NOT EXISTS auth; CREATE SCHEMA IF NOT EXISTS extensions;
  DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text);
  CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
  CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'service_role'::text $$;
  CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
  CREATE OR REPLACE FUNCTION extensions.uuid_generate_v4() RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
  CREATE OR REPLACE FUNCTION extensions.gen_random_uuid() RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
  CREATE OR REPLACE FUNCTION extensions.digest(text,text) RETURNS bytea LANGUAGE sql AS $$ SELECT sha256($1::bytea) $$;`);
await db.exec('SET search_path TO public, extensions, auth;');
const THIS = '153_sync_stock_changes.sql';
for (const f of files.filter((f) => num(f) < 153)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
const q = async (s, p = []) => (await db.query(s, p)).rows;
const one = async (s, p = []) => (await q(s, p))[0];
const colsOf = new Map();
const put = async (table, row) => {
  if (!colsOf.has(table)) colsOf.set(table, await q(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [table]));
  const full = { ...row };
  for (const c of colsOf.get(table)) {
    if (c.is_nullable === 'YES' || c.column_default !== null || c.column_name in full) continue;
    const t = c.data_type;
    full[c.column_name] = t === 'uuid' ? crypto.randomUUID() : /int|numeric|double|real/.test(t) ? 0 : t === 'boolean' ? false
      : /timestamp/.test(t) ? '2026-10-01T10:00:00Z' : t === 'date' ? '2026-10-01' : t === 'jsonb' || t === 'json' ? '{}' : t === 'ARRAY' ? '{}' : `x-${crypto.randomUUID().slice(0, 8)}`;
  }
  const k = Object.keys(full);
  return (await db.query(`INSERT INTO public.${table} (${k.join(',')}) VALUES (${k.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, k.map((x) => full[x]))).rows[0];
};
const maxSeq = async () => Number((await one(`SELECT COALESCE(max(seq), 0) AS m FROM public.sync_changes`)).m);
const since = async (from) => (await q(`SELECT seq, business_id, branch_id, topic, table_name, row_id, op FROM public.sync_changes WHERE seq > $1 ORDER BY seq`, [from]))
  .map((r) => ({ ...r, seq: Number(r.seq) }));
const stockLog = async (biz) => Number((await one(`SELECT count(*) AS n FROM public.sync_changes WHERE table_name = 'stock' AND business_id = $1`, [biz])).n);
const brief = (rows) => rows.map((r) => `${r.table_name}:${r.row_id.slice(-3)}:${r.topic}:${r.op}${r.branch_id ? `@${r.branch_id.slice(-2)}` : ''}`);
const sell = (pid, branch, n = 1) => db.query(`SELECT * FROM public.adjust_product_stock($1, $2, $3, 0)`, [pid, branch, -n]);

console.log('\nMigration 153 (stock in the change log) — PGlite, every migration\n');
const id = (n) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;
const A = id(0xa), B = id(0xb);
const BR = id(0xa1), BR2 = id(0xa5), BRB = id(0xb1), CAT = id(0xa4), CATB = id(0xb4);
await put('businesses', { id: A, name: 'KRUNCH & CO', type: 'restaurant' });
await put('businesses', { id: B, name: 'Other', type: 'retail' });
await put('branches', { id: BR, business_id: A, name: 'Main' });
await put('branches', { id: BR2, business_id: A, name: 'Westlands' });
await put('branches', { id: BRB, business_id: B, name: 'Other main' });
await put('categories', { id: CAT, business_id: A, name: 'Drinks' });
await put('categories', { id: CATB, business_id: B, name: 'Theirs' });
const P = [];
for (let i = 0; i < 10; i++) P.push((await put('products', { business_id: A, category_id: CAT, name: `Soda ${i}`, base_price: 100, track_stock: true })).id);
const PB = (await put('products', { business_id: B, category_id: CATB, name: 'Their soda', base_price: 80, track_stock: true })).id;
for (const p of P) await put('stock_levels', { product_id: p, branch_id: BR, quantity: 50 });

const sql = sanitize(fs.readFileSync(path.join(MIG, THIS), 'utf8'));
await ok('153 runs (and again — idempotent), recorded once; nothing written by the migration itself', async () => {
  const s = await maxSeq();
  await db.exec(sql); await db.exec(sql);
  assert.equal(Number((await one(`SELECT count(*) AS n FROM public.schema_migrations WHERE version = '153_sync_stock_changes'`)).n), 1);
  assert.equal(await maxSeq(), s);
  assert.equal((await one(`SELECT public.sync_stock_ready() AS r`)).r, true);
});
await ok('the functions are not callable by anon or authenticated (the service role only)', async () => {
  for (const f of ['public.sync_changes_heads_by_branch(bigint)', 'public.sync_stock_ready()']) {
    for (const role of ['anon', 'authenticated']) assert.equal((await one(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS x`, [role, f])).x, false, `${role} ${f}`);
    assert.equal((await one(`SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS x`, [f])).x, true, f);
  }
});
await ok('the topic map: stock is a topic, critical (applied at once), CHANGE_TABLES.stock names the trigger table', async () => {
  assert.ok(SYNC_TOPICS.includes('stock') && CRITICAL_TOPICS.includes('stock'));
  const have = (await q(`SELECT DISTINCT event_object_table AS t FROM information_schema.triggers WHERE trigger_name = $1`, [CHANGE_TABLES.stock.trigger])).map((r) => r.t);
  assert.deepEqual(have, [...CHANGE_TABLES.stock.from]);
});
await ok('a sale of one item: ONE entry — stock:<product> (topic stock, upsert) at ITS branch, of its business', async () => {
  const s = await maxSeq();
  await sell(P[0], BR);
  const got = await since(s);
  assert.deepEqual(brief(got), [`stock:${P[0].slice(-3)}:stock:upsert@a1`]);
  assert.equal(got[0].business_id, A);
});
await ok('an update that changes only updated_at writes nothing', async () => {
  const s = await maxSeq();
  await db.query(`UPDATE public.stock_levels SET updated_at = now() + interval '1 minute' WHERE product_id = $1 AND branch_id = $2`, [P[0], BR]);
  assert.deepEqual(await since(s), []);
});
let perSale = 0;
await ok('a 10-line sale (10 tracked products, one transaction per line as stockEffects does): 10 entries', async () => {
  const s = await maxSeq();
  for (const p of P) await sell(p, BR, 2);
  perSale = (await since(s)).length;
  assert.equal(perSale, 10);
});
await ok('the next sale of the same 10 products REPLACES them — the log still holds 10 stock entries (one per level)', async () => {
  await sell(P[3], BR); await sell(P[3], BR);
  for (const p of P) await sell(p, BR);
  assert.equal(await stockLog(A), 10);
  const newest = await one(`SELECT max(seq) AS m FROM public.sync_changes WHERE row_id = $1`, [P[9]]);
  assert.equal(Number(newest.m), await maxSeq());
});
await ok('one transaction writing a level three times (a sale with the same item on three lines): once', async () => {
  const s = await maxSeq();
  await db.transaction(async (tx) => {
    for (let i = 0; i < 3; i++) await tx.query(`SELECT * FROM public.adjust_product_stock($1, $2, -1, 0)`, [P[5], BR]);
    await tx.query(`SELECT * FROM public.adjust_product_stock($1, $2, -1, 0)`, [P[6], BR]);
  });
  const got = await since(s);
  assert.equal(got.length, 2, brief(got).join(' '));
  assert.equal(await maxSeq(), s + 2, 'written once each (not written three times and two removed)');
});
await ok('another branch\'s level: at ITS branch — sync_changes_since for this branch leaves it out; another business: its own', async () => {
  await db.exec(`UPDATE public.sync_changes SET changed_at = now() - interval '1 hour'`);   // out of the 120 s window
  const s = await maxSeq();
  await sell(P[1], BR2);          // Westlands
  await sell(PB, BRB);            // the other business
  const got = await since(s);
  assert.equal(got.length, 2);
  assert.equal(got[0].branch_id, BR2); assert.equal(got[0].business_id, A);
  assert.equal(got[1].business_id, B);
  await db.exec(`UPDATE public.sync_changes SET changed_at = now() - interval '1 hour'`);
  const atMain = await q(`SELECT * FROM public.sync_changes_since($1, $2, $3, 500)`, [A, s, BR]);
  assert.equal(atMain.length, 0, JSON.stringify(atMain));
  const atWest = await q(`SELECT * FROM public.sync_changes_since($1, $2, $3, 500)`, [A, s, BR2]);
  assert.equal(atWest.length, 1);
});
await ok('a deleted level is a delete', async () => {
  const s = await maxSeq();
  await db.query(`DELETE FROM public.stock_levels WHERE product_id = $1 AND branch_id = $2`, [P[1], BR2]);
  assert.deepEqual(brief(await since(s)), [`stock:${P[1].slice(-3)}:stock:delete@a5`]);
});
await ok('sync_changes_heads_by_branch: per business and branch — the newest entry, how many, the topics', async () => {
  await db.exec(`UPDATE public.sync_changes SET changed_at = now() - interval '1 hour'`);
  const s = await maxSeq();
  await sell(P[2], BR); await sell(P[4], BR); await sell(P[2], BR2);
  const heads = await q(`SELECT * FROM public.sync_changes_heads_by_branch($1)`, [s]);
  const main = heads.find((h) => h.branch_id === BR); const west = heads.find((h) => h.branch_id === BR2);
  assert.equal(heads.length, 2);
  assert.equal(Number(main.n), 2); assert.deepEqual([...main.topics], ['stock']);
  assert.equal(Number(west.n), 1); assert.equal(Number(west.max_seq), await maxSeq());
});
await ok('a trigger that cannot write never fails the stock write (sync_changes gone: the sale still deducts)', async () => {
  await db.exec(`ALTER TABLE public.sync_changes RENAME TO sync_changes_away`);
  try {
    const before = Number((await one(`SELECT quantity FROM public.stock_levels WHERE product_id = $1 AND branch_id = $2`, [P[7], BR])).quantity);
    await sell(P[7], BR);
    assert.equal(Number((await one(`SELECT quantity FROM public.stock_levels WHERE product_id = $1 AND branch_id = $2`, [P[7], BR])).quantity), before - 1);
  } finally { await db.exec(`ALTER TABLE public.sync_changes_away RENAME TO sync_changes`); }
});
console.log(`\n  volume: a 10-line sale writes ${perSale} stock entries; the log holds one per product and branch however many sales`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
