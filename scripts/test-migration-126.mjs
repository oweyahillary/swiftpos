/**
 * test-migration-126.mjs — A413/A414: stock_batches, and wastage_entries.client_id / batch_id — run for real against the
 * WHOLE schema (every migration replayed into PGlite).
 *
 * MUTATIONS TO CONFIRM BITE: the item CHECK dropped → "its own id only" fails; batch_id without ON DELETE SET NULL →
 * "deleting the batch keeps the entry" fails.
 */
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
import assert from 'node:assert'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch { console.error('\n@electric-sql/pglite not installed — cannot run.\n'); process.exit(1); }
const MIG = path.join(ROOT, 'migrations');
const files = fs.readdirSync(MIG).filter(f => f.endsWith('.sql')).sort((a, b) => (+a.split('_')[0]) - (+b.split('_')[0]) || a.localeCompare(b));
const sanitize = sql => sql.split('\n').filter(l => { const t = l.trim(); return !(t.startsWith('\\') || /^CREATE SCHEMA public;/i.test(t) || /set_config\('search_path'/i.test(t) || /^SET\s+search_path/i.test(t)); }).join('\n').replace(/uuid_generate_v4\(\)/gi, 'gen_random_uuid()');
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
for (const f of files) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));   // every migration, in order — a failure fails the test

let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
const q = async (s, p = []) => (await db.query(s, p)).rows;
const one = async (s, p = []) => (await q(s, p))[0];
const count = async (t, w = 'true', p = []) => Number((await one(`SELECT count(*)::int AS n FROM public.${t} WHERE ${w}`, p)).n);

console.log('\nMigration 126 (stock batches, till wastage) — PGlite, every migration\n');
const B = '00000000-0000-0000-0000-0000000000b1', BR = '00000000-0000-0000-0000-0000000000a1';
const P = '00000000-0000-0000-0000-0000000000c1', I = '00000000-0000-0000-0000-0000000000d1';
await db.exec(`
  INSERT INTO public.businesses (id, name, type) VALUES ('${B}', 'B Foods', 'restaurant');
  INSERT INTO public.branches (id, business_id, name) VALUES ('${BR}', '${B}', 'Town');
  INSERT INTO public.products (id, business_id, name) VALUES ('${P}', '${B}', 'Milk 500ml');
  INSERT INTO public.ingredients (id, business_id, name) VALUES ('${I}', '${B}', 'Chicken');`);

const addBatch = (over = {}) => {
  const r = { business_id: B, branch_id: BR, item_kind: 'product', product_id: P, ingredient_id: null, expiry_date: '2026-10-20',
    quantity_received: 24, source: 'restock', ...over };
  const k = Object.keys(r);
  return db.query(`INSERT INTO public.stock_batches (${k.join(', ')}) VALUES (${k.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, k.map((x) => r[x]));
};
const refused = async (p) => { try { await p; return false; } catch { return true; } };

await ok('a batch: a product or an ingredient, its own id only, a quantity above 0, a known source', async () => {
  await addBatch();
  await addBatch({ item_kind: 'ingredient', product_id: null, ingredient_id: I, quantity_received: 2.5, source: 'grn', batch_no: 'LOT-7' });
  assert.ok(await refused(addBatch({ item_kind: 'product', product_id: null })), 'a product batch with no product');
  assert.ok(await refused(addBatch({ item_kind: 'product', ingredient_id: I })), 'a product batch naming an ingredient');
  assert.ok(await refused(addBatch({ quantity_received: 0 })), 'nothing received');
  assert.ok(await refused(addBatch({ source: 'magic' })), 'an unknown source');
  assert.ok(await refused(addBatch({ item_kind: 'drink' })), 'an unknown kind');
});
await ok('no expiry date and no batch number are allowed (either may be the one known)', async () => {
  await addBatch({ expiry_date: null, batch_no: 'ONLY-LOT' });
  assert.equal(await count('stock_batches', `business_id = '${B}'`), 3);
});
await ok('wastage keeps the till\'s id and the batch; deleting the batch keeps the entry', async () => {
  const { rows: [bt] } = await addBatch({ expiry_date: '2026-10-01' });
  const cid = '11111111-2222-3333-4444-555555555555';
  await db.query(`INSERT INTO public.wastage_entries (business_id, branch_id, ref, item_kind, product_id, name, quantity, value, reason, client_id, batch_id)
                  VALUES ($1, $2, 'WST-0001', 'product', $3, 'Milk 500ml', 2, 0, 'expired', $4, $5)`, [B, BR, P, cid, bt.id]);
  assert.equal(await count('wastage_entries', `client_id = '${cid}' AND batch_id = '${bt.id}'`), 1);
  await db.query(`DELETE FROM public.stock_batches WHERE id = $1`, [bt.id]);
  assert.equal(await count('wastage_entries', `client_id = '${cid}' AND batch_id IS NULL`), 1);
});
await ok('replaying 126 changes nothing (idempotent)', async () => {
  await db.exec(sanitize(fs.readFileSync(path.join(MIG, '126_stock_batches.sql'), 'utf8')));
  assert.equal(await count('stock_batches', `business_id = '${B}'`), 3);
});
await ok('the item gone from the catalogue takes its batches with it', async () => {
  await db.query(`DELETE FROM public.ingredients WHERE id = $1`, [I]);
  assert.equal(await count('stock_batches', `ingredient_id = '${I}'`), 0);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
