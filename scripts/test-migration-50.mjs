import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
let pass=0,fail=0;
const ok=(n,c,d='')=>{c?(pass++,console.log(`  ok   ${n}`)):(fail++,console.log(`  FAIL ${n}${d?' — '+d:''}`))};
const db = new PGlite();
await db.exec(`
  CREATE TABLE public.orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL,
    branch_id uuid,
    idempotency_key text,
    sync_status text DEFAULT 'pending',
    total numeric DEFAULT 0
  );
  CREATE UNIQUE INDEX orders_idempotency_key_business_idx
    ON public.orders (business_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
  CREATE TABLE public.schema_migrations (version text PRIMARY KEY, notes text, applied_at timestamptz DEFAULT now());
`);
const biz='11111111-1111-1111-1111-111111111111';
// The exact shape that duplicates: dine-in orders with no key.
for (let i=0;i<5;i++) await db.query(`INSERT INTO orders (business_id, idempotency_key, sync_status) VALUES ($1, NULL, 'pending')`,[biz]);
await db.query(`INSERT INTO orders (business_id, idempotency_key, sync_status) VALUES ($1,'client-key-1','pending')`,[biz]);

console.log('\nbefore migration 50 — reproduce the duplication');
const before = (await db.query(`SELECT count(*)::int n FROM orders WHERE idempotency_key IS NULL`)).rows[0].n;
ok('5 orders carry a NULL key', before===5, String(before));
// Replay one: the partial index does not stop it.
await db.query(`INSERT INTO orders (business_id, idempotency_key, sync_status) VALUES ($1, NULL, 'pending')`,[biz]);
ok('a NULL-key order replays into a DUPLICATE (the bug)',
   (await db.query(`SELECT count(*)::int n FROM orders WHERE idempotency_key IS NULL`)).rows[0].n===6);

await db.exec(fs.readFileSync(new URL('../migrations/50_order_sync_status_and_idempotency.sql', import.meta.url),'utf8'));

console.log('\nafter migration 50');
ok('no null keys remain', (await db.query(`SELECT count(*)::int n FROM orders WHERE idempotency_key IS NULL`)).rows[0].n===0);
ok('client-supplied key preserved', (await db.query(`SELECT count(*)::int n FROM orders WHERE idempotency_key='client-key-1'`)).rows[0].n===1);
ok('nothing left pending', (await db.query(`SELECT count(*)::int n FROM orders WHERE sync_status='pending'`)).rows[0].n===0);

let notNull=false;
try { await db.query(`INSERT INTO orders (business_id, idempotency_key) VALUES ($1, NULL)`,[biz]); }
catch(e){ notNull=/not-null|null value/i.test(e.message); }
ok('an explicit NULL key is now refused', notNull);

const d = await db.query(`INSERT INTO orders (business_id) VALUES ($1) RETURNING idempotency_key`,[biz]);
ok('an omitted key gets a generated default', !!d.rows[0].idempotency_key);

let dup=false;
const k=(await db.query(`SELECT idempotency_key FROM orders LIMIT 1`)).rows[0].idempotency_key;
try { await db.query(`INSERT INTO orders (business_id, idempotency_key) VALUES ($1,$2)`,[biz,k]); }
catch(e){ dup=/duplicate key/i.test(e.message); }
ok('a replayed key is now refused by the index', dup);

let again=true;
try { await db.exec(fs.readFileSync(new URL('../migrations/50_order_sync_status_and_idempotency.sql', import.meta.url),'utf8')); } catch(e){ again=false; console.log('   ',e.message); }
ok('re-runnable', again);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
