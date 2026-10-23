/**
 * test-migration-156.mjs — A544: branch_branding (a branch's override of the business's theme, brand colour and receipt
 * footer), run for real against the WHOLE schema (every migration before 156 replayed into PGlite, 150 and 151 included).
 *
 * Owner, 2026-10-21: "phase 2 branding — we need to do it before value add" … "yes start" (per-branch branding;
 * docs/SCOPE-A295-branding.md §14–15).
 *
 *   - 156 runs twice, recorded once; the columns match scripts/schema-index.json; three triggers (updated_at, the change
 *     log, the catalogue version); log_branch_branding_sync_change is not callable by anon / authenticated.
 *   - the key is the branch (one row per branch; a branch that does not exist is refused; a branch removed takes its row).
 *   - accent_hex is #rrggbb (anything else refused); receipt_footer at most 300 characters.
 *   - RLS: on; a member of the business reads its branches' rows, never another business's.
 *   - sync: a new override writes ONE entry (branch_branding, the branch, topic look, AT that branch) and moves the
 *     catalogue version; an update is one entry; an update that changes nothing writes nothing; one transaction writes a
 *     branch once; a delete is an entry too (the cloud answers it with no override).
 *   - the trigger never fails the write (sync_changes refusing the entry: the override still saves).
 *
 * MUTATIONS TO CONFIRM BITE (checked by hand, 2026-10-21):
 *   - ON DELETE CASCADE removed from branch_id                   → "a branch removed takes its row" fails
 *   - the entry written with branch_id NULL                      → "AT that branch" fails (every branch would be told)
 *   - the updated_at-only check removed                          → "changes nothing writes nothing" fails
 *   - the coalescing flag removed                                → "one transaction: once" fails
 *   - the catalogue-version trigger block removed                → "moves the catalogue version" fails
 *   - RAISE instead of RAISE WARNING in the handler              → "never fails the write" fails
 *   - the policy without the business filter (USING (true))      → "never another business's" fails
 */
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
import assert from 'node:assert'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch { console.error('\n@electric-sql/pglite not installed — cannot run.\n'); process.exit(1); }
const MIG = path.join(ROOT, 'migrations');
const num = (f) => +f.split('_')[0];
const files = fs.readdirSync(MIG).filter(f => f.endsWith('.sql') && Number.isFinite(num(f))).sort((a, b) => num(a) - num(b) || a.localeCompare(b));
const BS = String.fromCharCode(92);
const sanitize = sql => sql.split('\n').filter(l => { const t = l.trim(); return !(t.startsWith(BS) || /^CREATE SCHEMA public;/i.test(t) || /set_config\('search_path'/i.test(t) || /^SET\s+search_path/i.test(t)); }).join('\n').replace(/uuid_generate_v4\(\)/gi, 'gen_random_uuid()');
const db = new PGlite();
// auth.uid() reads a test setting, so the RLS case can sign in as a member (NULL otherwise, as the other tests).
await db.exec(`CREATE SCHEMA IF NOT EXISTS auth; CREATE SCHEMA IF NOT EXISTS extensions;
  DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text);
  CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
  CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'service_role'::text $$;
  CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
  CREATE OR REPLACE FUNCTION extensions.uuid_generate_v4() RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
  CREATE OR REPLACE FUNCTION extensions.gen_random_uuid() RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
  CREATE OR REPLACE FUNCTION extensions.digest(text,text) RETURNS bytea LANGUAGE sql AS $$ SELECT sha256($1::bytea) $$;`);
await db.exec('SET search_path TO public, extensions, auth;');
const THIS = '156_branch_branding.sql';
for (const f of files.filter((f) => num(f) < 156)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
const q = async (s, p = []) => (await db.query(s, p)).rows;
const one = async (s, p = []) => (await q(s, p))[0];
const colsOf = new Map();
const fill = async (table, row) => {
  if (!colsOf.has(table)) colsOf.set(table, await q(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [table]));
  const full = { ...row };
  for (const c of colsOf.get(table)) {
    if (c.is_nullable === 'YES' || c.column_default !== null || c.column_name in full) continue;
    const t = c.data_type;
    full[c.column_name] = t === 'uuid' ? crypto.randomUUID() : /int|numeric|double|real/.test(t) ? 0 : t === 'boolean' ? false
      : /timestamp/.test(t) ? '2026-10-01T10:00:00Z' : t === 'date' ? '2026-10-01' : t === 'jsonb' || t === 'json' ? '{}' : t === 'ARRAY' ? '{}' : `x-${crypto.randomUUID().slice(0, 8)}`;
  }
  return full;
};
const put = async (table, row) => {
  const full = await fill(table, row);
  const k = Object.keys(full);
  return (await db.query(`INSERT INTO public.${table} (${k.join(',')}) VALUES (${k.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, k.map((x) => full[x]))).rows[0];
};
const maxSeq = async () => Number((await one(`SELECT COALESCE(max(seq), 0) AS m FROM public.sync_changes`)).m);
const since = async (from) => (await q(`SELECT table_name, row_id, topic, op, branch_id FROM public.sync_changes WHERE seq > $1 ORDER BY seq`, [from]))
  .map((r) => `${r.table_name}:${r.row_id}:${r.topic}:${r.op}@${r.branch_id ?? 'every'}`);
const ver = async (biz) => Number((await one(`SELECT version FROM public.sync_versions WHERE business_id = $1 AND topic = 'catalogue'`, [biz]))?.version ?? -1);

console.log('\nMigration 156 (branch_branding) — PGlite, every migration\n');
const id = (n) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;
const A = id(0xa), B = id(0xb), BR1 = id(0xa1), BR2 = id(0xa2), BRB = id(0xb1), GONE = id(0xa9);
await put('businesses', { id: A, name: 'Test Grill', type: 'restaurant' });
await put('businesses', { id: B, name: 'Other', type: 'restaurant' });
await put('branches', { id: BR1, business_id: A, name: 'Westlands' });
await put('branches', { id: BR2, business_id: A, name: 'Kilimani' });
await put('branches', { id: BRB, business_id: B, name: 'Theirs' });
await put('branches', { id: GONE, business_id: A, name: 'Closing' });

const sql = sanitize(fs.readFileSync(path.join(MIG, THIS), 'utf8'));
await ok('156 runs (and again — idempotent), recorded once; three triggers', async () => {
  await db.exec(sql); await db.exec(sql);
  assert.equal(Number((await one(`SELECT count(*) AS n FROM public.schema_migrations WHERE version = '156_branch_branding'`)).n), 1);
  const trg = (await q(`SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.branch_branding'::regclass AND NOT tgisinternal ORDER BY tgname`)).map((r) => r.tgname);
  assert.deepEqual(trg, ['branch_branding_set_updated_at', 'trg_log_branch_branding_sync_change', 'trg_sync_version_catalogue']);
});
await ok('the columns match scripts/schema-index.json', async () => {
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/schema-index.json'), 'utf8'));
  assert.ok(idx.branch_branding, 'branch_branding missing from schema-index.json');
  const cols = (await q(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'branch_branding'`)).map((r) => r.column_name).sort();
  assert.deepEqual(Object.keys(idx.branch_branding).sort(), cols);
});
await ok('RLS on; log_branch_branding_sync_change not callable by anon or authenticated', async () => {
  assert.equal((await one(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.branch_branding'::regclass`)).relrowsecurity, true);
  assert.equal(Number((await one(`SELECT count(*) AS n FROM pg_policies WHERE tablename = 'branch_branding' AND policyname = 'branch_branding_business_member'`)).n), 1);
  for (const role of ['anon', 'authenticated']) {
    assert.equal((await one(`SELECT has_function_privilege($1, 'public.log_branch_branding_sync_change()', 'EXECUTE') AS x`, [role])).x, false, role);
  }
});

await ok('a new override: ONE entry (branch_branding, the branch, topic look, AT that branch) and the catalogue version moves', async () => {
  const s = await maxSeq(); const v = await ver(A);
  await put('branch_branding', { branch_id: BR1, theme_id: 'violet' });
  assert.deepEqual(await since(s), [`branch_branding:${BR1}:look:upsert@${BR1}`]);
  assert.ok(await ver(A) > v, 'catalogue version moved');
});
await ok('the key is the branch: one row per branch; a branch that does not exist is refused', async () => {
  await assert.rejects(() => put('branch_branding', { branch_id: BR1, accent_hex: '#f5b800' }), /duplicate|unique|primary/i);
  await assert.rejects(() => put('branch_branding', { branch_id: id(0xdead), accent_hex: '#f5b800' }), /foreign key|violates/i);
});
await ok('accent_hex is #rrggbb (anything else refused); receipt_footer at most 300 characters', async () => {
  await assert.rejects(() => db.query(`UPDATE public.branch_branding SET accent_hex = 'red' WHERE branch_id = $1`, [BR1]), /check/i);
  await assert.rejects(() => db.query(`UPDATE public.branch_branding SET accent_hex = '#F5B800' WHERE branch_id = $1`, [BR1]), /check/i);
  await assert.rejects(() => db.query(`UPDATE public.branch_branding SET receipt_footer = $2 WHERE branch_id = $1`, [BR1, 'x'.repeat(301)]), /check/i);
  await db.query(`UPDATE public.branch_branding SET receipt_footer = $2 WHERE branch_id = $1`, [BR1, 'x'.repeat(300)]);
  await db.query(`UPDATE public.branch_branding SET receipt_footer = NULL WHERE branch_id = $1`, [BR1]);
});
await ok('an update: ONE entry; an update that changes nothing writes nothing', async () => {
  const s = await maxSeq();
  await db.query(`UPDATE public.branch_branding SET accent_hex = '#f5b800' WHERE branch_id = $1`, [BR1]);
  assert.deepEqual(await since(s), [`branch_branding:${BR1}:look:upsert@${BR1}`]);
  const s2 = await maxSeq();
  await db.query(`UPDATE public.branch_branding SET accent_hex = '#f5b800' WHERE branch_id = $1`, [BR1]);
  assert.deepEqual(await since(s2), []);
});
await ok('one transaction: a branch changed three times is written once', async () => {
  const s = await maxSeq();
  await db.transaction(async (tx) => {
    await tx.query(`INSERT INTO public.branch_branding (branch_id, theme_id) VALUES ($1, 'teal')`, [BR2]);
    await tx.query(`UPDATE public.branch_branding SET receipt_footer = 'Karibu Kilimani' WHERE branch_id = $1`, [BR2]);
    await tx.query(`UPDATE public.branch_branding SET theme_id = 'sky' WHERE branch_id = $1`, [BR2]);
  });
  assert.deepEqual(await since(s), [`branch_branding:${BR2}:look:upsert@${BR2}`]);
});
await ok('a delete (the override cleared) is an entry too — the cloud answers it with no override', async () => {
  const s = await maxSeq();
  await db.query(`DELETE FROM public.branch_branding WHERE branch_id = $1`, [BR2]);
  assert.deepEqual(await since(s), [`branch_branding:${BR2}:look:upsert@${BR2}`]);
});
await ok('a branch removed takes its row (ON DELETE CASCADE)', async () => {
  await put('branch_branding', { branch_id: GONE, receipt_footer: 'Last days' });
  await db.query(`DELETE FROM public.branches WHERE id = $1`, [GONE]);
  assert.equal(await one(`SELECT branch_id FROM public.branch_branding WHERE branch_id = $1`, [GONE]), undefined);
});
await ok('RLS: a member of the business reads its branches’ rows, never another business’s', async () => {
  await put('branch_branding', { branch_id: BRB, theme_id: 'orchid' });
  const MEMBER = id(0xa0a);
  await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'member@test') ON CONFLICT DO NOTHING`, [MEMBER]);
  await put('users', { id: MEMBER, business_id: A, name: 'Member', email: 'member@test' });
  await db.exec(`GRANT USAGE ON SCHEMA auth TO authenticated; GRANT SELECT ON public.users TO authenticated; GRANT SELECT ON public.branches TO authenticated;`);
  // users / branches have their own policies; this case is about branch_branding's, so the member may read those two.
  await db.exec(`ALTER TABLE public.users DISABLE ROW LEVEL SECURITY; ALTER TABLE public.branches DISABLE ROW LEVEL SECURITY;`);
  try {
    await db.exec(`SET row_security = on; SET test.uid = '${MEMBER}'; SET ROLE authenticated;`);
    const seen = (await q(`SELECT branch_id FROM public.branch_branding ORDER BY branch_id`)).map((r) => r.branch_id);
    await db.exec(`RESET ROLE; RESET test.uid;`);
    assert.deepEqual(seen, [BR1], `saw ${seen.join(', ')}`);
  } finally {
    await db.exec(`RESET ROLE;`);
    await db.exec(`ALTER TABLE public.users ENABLE ROW LEVEL SECURITY; ALTER TABLE public.branches ENABLE ROW LEVEL SECURITY;`);
  }
});
await ok('the trigger never fails the write (sync_changes refusing the entry: the override still saves)', async () => {
  await db.exec(`ALTER TABLE public.sync_changes ADD CONSTRAINT no_bb_here CHECK (table_name <> 'branch_branding') NOT VALID`);
  try {
    await put('branch_branding', { branch_id: BR2, receipt_footer: 'Still saves' });
    assert.ok(await one(`SELECT branch_id FROM public.branch_branding WHERE receipt_footer = 'Still saves'`));
  } finally { await db.exec(`ALTER TABLE public.sync_changes DROP CONSTRAINT no_bb_here`); }
});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
