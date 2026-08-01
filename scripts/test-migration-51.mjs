import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
let p=0,f=0; const ok=(n,c,d='')=>{c?(p++,console.log(`  ok   ${n}`)):(f++,console.log(`  FAIL ${n}${d?' — '+d:''}`))};
const db=new PGlite();
await db.exec(`
  CREATE SCHEMA IF NOT EXISTS auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
  CREATE TABLE public.businesses (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid, type text);
  CREATE TABLE public.branches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid);
  CREATE TABLE public.parking_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL, branch_id uuid,
    bay_id uuid NOT NULL, order_id uuid, vehicle_plate text, vehicle_type text DEFAULT 'car' NOT NULL,
    rate_per_hour numeric(10,2) DEFAULT 200 NOT NULL, started_at timestamptz DEFAULT now() NOT NULL,
    ended_at timestamptz, billed_hours numeric(5,2), total_amount numeric(10,2),
    status text DEFAULT 'open' NOT NULL, created_at timestamptz DEFAULT now() NOT NULL);
  CREATE TABLE public.schema_migrations (version text PRIMARY KEY, notes text, applied_at timestamptz DEFAULT now());
`);
const pk=(await db.query(`INSERT INTO businesses (owner_id,type) VALUES (gen_random_uuid(),'parking') RETURNING id`)).rows[0].id;
const rt=(await db.query(`INSERT INTO businesses (owner_id,type) VALUES (gen_random_uuid(),'restaurant') RETURNING id`)).rows[0].id;
await db.query(`INSERT INTO parking_sessions (business_id,bay_id,rate_per_hour,total_amount,status,ended_at)
                VALUES ($1,gen_random_uuid(),150,450,'completed',now())`,[pk]);

await db.exec(fs.readFileSync(new URL('../migrations/51_parking_tariffs.sql', import.meta.url),'utf8'));

ok('tariff seeded for the parking business',(await db.query(`SELECT count(*)::int n FROM parking_tariffs WHERE business_id=$1`,[pk])).rows[0].n===1);
ok('NOT seeded for the restaurant business',(await db.query(`SELECT count(*)::int n FROM parking_tariffs WHERE business_id=$1`,[rt])).rows[0].n===0);
const s=(await db.query(`SELECT tariff_snapshot, total_cents FROM parking_sessions`)).rows[0];
ok('legacy session snapshotted at ITS OWN rate, not the new default', s.tariff_snapshot.first_period_price_cents===15000, JSON.stringify(s.tariff_snapshot.first_period_price_cents));
ok('legacy snapshot flagged as legacy', s.tariff_snapshot.legacy===true);
ok('total backfilled to cents', s.total_cents===45000, String(s.total_cents));
ok('RLS enabled on parking_tariffs',(await db.query(`SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='parking_tariffs'`)).rows[0].relrowsecurity===true);
ok('owner_all policy present',(await db.query(`SELECT count(*)::int n FROM pg_policies WHERE tablename='parking_tariffs' AND policyname='owner_all'`)).rows[0].n===1);
let neg=false; try{ await db.query(`INSERT INTO parking_tariffs (business_id,name,increment_price_cents) VALUES ($1,'Bad',-100)`,[pk]); }catch(e){neg=/non_negative/.test(e.message);}
ok('negative increment price refused',neg);
let cls=false; try{ await db.query(`INSERT INTO parking_tariffs (business_id,name,vehicle_class) VALUES ($1,'Bad','helicopter')`,[pk]); }catch(e){cls=/vehicle_class/.test(e.message);}
ok('unknown vehicle class refused',cls);
let again=true; try{ await db.exec(fs.readFileSync(new URL('../migrations/51_parking_tariffs.sql', import.meta.url),'utf8')); }catch(e){again=false;console.log('   ',e.message.slice(0,110));}
ok('re-runnable',again);
ok('re-run did not duplicate the seed',(await db.query(`SELECT count(*)::int n FROM parking_tariffs WHERE business_id=$1`,[pk])).rows[0].n===1);
console.log(`\n${p} passed, ${f} failed`); process.exit(f?1:0);
