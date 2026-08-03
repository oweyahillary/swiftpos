import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
let p=0,f=0; const ok=(n,c,d='')=>{c?(p++,console.log(`  ok   ${n}`)):(f++,console.log(`  FAIL ${n}${d?' — '+d:''}`))};
const db=new PGlite();
await db.exec(`
  CREATE TABLE public.branches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
  CREATE TABLE public.user_devices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, business_id uuid NOT NULL,
    fingerprint text NOT NULL, device_label text, status text DEFAULT 'pending' NOT NULL,
    device_id text, created_at timestamptz DEFAULT now());
  CREATE TABLE public.schema_migrations (version text PRIMARY KEY, notes text, applied_at timestamptz DEFAULT now());
`);
const biz='11111111-1111-1111-1111-111111111111';
const west=(await db.query(`INSERT INTO branches (name) VALUES ('Westlands') RETURNING id`)).rows[0].id;
const karen=(await db.query(`INSERT INTO branches (name) VALUES ('Karen') RETURNING id`)).rows[0].id;
await db.query(`INSERT INTO user_devices (user_id,business_id,fingerprint,status,device_id) VALUES (gen_random_uuid(),$1,'fp1','approved','dev-1')`,[biz]);

await db.exec(fs.readFileSync(new URL('../migrations/52_device_branch_binding.sql', import.meta.url),'utf8'));
console.log('\nmigration 52');
ok('existing device survives, unbound',(await db.query(`SELECT branch_id FROM user_devices WHERE device_id='dev-1'`)).rows[0].branch_id===null);

await db.query(`UPDATE user_devices SET branch_id=$1, terminal_code='T1', bound_at=now() WHERE device_id='dev-1'`,[west]);

console.log('\nterminal codes');
let dup=false;
try{ await db.query(`INSERT INTO user_devices (user_id,business_id,fingerprint,status,device_id,branch_id,terminal_code) VALUES (gen_random_uuid(),$1,'fp2','approved','dev-2',$2,'T1')`,[biz,west]); }
catch(e){ dup=/terminal_code_unique/.test(e.message); }
ok('a second T1 at the SAME branch is refused',dup);

let lower=false;
try{ await db.query(`INSERT INTO user_devices (user_id,business_id,fingerprint,status,device_id,branch_id,terminal_code) VALUES (gen_random_uuid(),$1,'fp3','approved','dev-3',$2,'t1')`,[biz,west]); }
catch(e){ lower=/terminal_code_unique/.test(e.message); }
ok('case-insensitive — lowercase t1 also refused',lower);

await db.query(`INSERT INTO user_devices (user_id,business_id,fingerprint,status,device_id,branch_id,terminal_code) VALUES (gen_random_uuid(),$1,'fp4','approved','dev-4',$2,'T1')`,[biz,karen]);
ok('T1 at a DIFFERENT branch is allowed',true);

await db.query(`INSERT INTO user_devices (user_id,business_id,fingerprint,status,device_id,branch_id,terminal_code) VALUES (gen_random_uuid(),$1,'fp5','pending','dev-5',$2,'T1')`,[biz,west]);
ok('a PENDING duplicate does not collide',true);

console.log('\ndevice identity');
let ddup=false;
try{ await db.query(`INSERT INTO user_devices (user_id,business_id,fingerprint,status,device_id) VALUES (gen_random_uuid(),$1,'fp6','approved','dev-1')`,[biz]); }
catch(e){ ddup=/device_id_unique/.test(e.message); }
ok('the same device cannot register twice',ddup);

console.log('\nrelocation');
// Karen already has a T1 (dev-4), so moving dev-1 there must be REFUSED, not
// silently allowed — otherwise both are T1 at Karen.
let clash=false;
try{ await db.query(`UPDATE user_devices SET previous_branch_id=branch_id, branch_id=$1, branch_changed_at=now(), branch_change_count=branch_change_count+1 WHERE device_id='dev-1'`,[karen]); }
catch(e){ clash=/terminal_code_unique/.test(e.message); }
ok('a move into a branch that already has this terminal code is refused',clash);

// Rename first, then the move succeeds. This is the path a manager follows.
await db.query(`UPDATE user_devices SET terminal_code='T9' WHERE device_id='dev-1'`);
await db.query(`UPDATE user_devices SET previous_branch_id=branch_id, branch_id=$1, branch_changed_at=now(), branch_change_count=branch_change_count+1 WHERE device_id='dev-1'`,[karen]);
const r=(await db.query(`SELECT branch_id, previous_branch_id, branch_change_count FROM user_devices WHERE device_id='dev-1'`)).rows[0];
ok('new branch recorded',r.branch_id===karen);
ok('previous branch retained',r.previous_branch_id===west);
ok('move counted',r.branch_change_count===1);

let again=true; try{ await db.exec(fs.readFileSync(new URL('../migrations/52_device_branch_binding.sql', import.meta.url),'utf8')); }catch(e){again=false;console.log('  ',e.message.slice(0,100));}
ok('re-runnable',again);
console.log(`\n${p} passed, ${f} failed`); process.exit(f?1:0);
