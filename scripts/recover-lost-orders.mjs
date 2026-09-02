#!/usr/bin/env node
/**
 * recover-lost-orders.mjs — A181 recovery (one-off).
 *
 * Re-queues this till's orders that read `synced` locally but are ABSENT from the
 * cloud (they hit the order-number unique constraint and the old client wrongly
 * marked them synced). It diffs LOCAL order ids against the CLOUD id list below,
 * re-numbers only the missing ones with the till's CURRENT terminal code (which
 * must differ from the colliding one — the script refuses if the new number would
 * still collide), updates both the `orders` row and its `sync_queue` payload, and
 * flips them back to `pending` so the normal sync pushes them.
 *
 * SAFETY:
 *   • Dry-run by default. Pass --apply to write. Pass --db <path> to point at the DB.
 *   • On --apply it copies the DB to <db>.bak-<timestamp> first.
 *   • It NEVER touches an order whose id is already on the cloud, never changes an
 *     id, never deletes anything. Re-runnable.
 *   • The cloud upserts by id, so anything already up there is a safe no-op on push.
 *
 * Usage (on the till):
 *   node recover-lost-orders.mjs --db "%APPDATA%\\SwiftPOS Dev\\swiftpos.db"          (dry run)
 *   node recover-lost-orders.mjs --db "%APPDATA%\\SwiftPOS Dev\\swiftpos.db" --apply   (write)
 */
import fs from 'fs';
import Module from 'module';

// ── Cloud state (from the owner's query, 2026-08-27). Ids already on the cloud →
//    never re-pushed. Numbers already on the cloud → the new number must avoid them.
const CLOUD_IDS = new Set([
  '627c8a3e-cc4d-4460-bbe9-5b982563d1c3','d423bcc9-404b-4b31-b74f-419d577c8617',
  '37fa21ed-d06b-4152-8c80-5a1f406fbe3b','93fe4723-9f52-4d92-9213-1a1d39efe5f6',
  '98ef397a-bc4c-4c3e-bd79-55270df93c1b','5b9b9a5b-da82-48a5-aaeb-cecd0ca2d164',
  '9f2d403e-4c0c-40aa-aa74-7fb45c9b70c1','8c976bc6-29f5-4a9c-b110-25310c10f3b4',
  '66e004c1-3810-4e4e-ad9e-a394538a7989','ba3b984a-044b-4979-9ae1-66eb6fb97c30',
  '8b649e2e-e024-4518-a0d9-f6a34ca802e0','68c9eefb-5848-419f-816d-3de0c91d8a92',
  'f9ee1ae9-cfec-46d2-9537-29fe77714aa3','61c2618a-dc5d-4924-8c81-fbcb8d9ca829',
  '3c02e5dc-57f8-4f3d-a5b0-0ea279f08444','866564de-34bb-465f-a3e7-4ba061a0b33c',
  '83738b4d-70c4-41c0-8c9d-a7305d218958','5ce05297-22e5-4bc7-9e4a-69593a61918c',
  'c9e2f4c8-6f12-47c2-b752-4d12144828af','7ec1154b-91f2-4a8a-a701-d4b348420109',
  'fd515bff-eafb-4dbc-9342-f58d47cf072e','23a60393-f71f-4342-923e-ad9a7dab0690',
  'a377897d-ea5a-4f62-90e3-95c5c005b1d1','b5cfbec3-1d51-403c-83df-6902197be968',
  'b78f4a87-ab41-4750-8221-a8bb7666ab3e',
]);
const CLOUD_NUMBERS = new Set([
  'ORD-MT7IT64B-001TI',
  ...Array.from({ length: 25 }, (_, i) => `T1--${i + 1}`).filter(n => n !== 'T1--7'), // gap at 7
]);

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const dbPath = (() => { const i = args.indexOf('--db'); return i >= 0 ? args[i + 1] : null; })();
if (!dbPath) { console.error('Pass --db <path to swiftpos.db>'); process.exit(2); }
if (!fs.existsSync(dbPath)) { console.error('DB not found:', dbPath); process.exit(2); }

// Load the till's real better-sqlite3 (fallback to node:sqlite for a dry run).
let Database, usingBetter = true;
try { Database = Module.createRequire(process.cwd() + '/apps/desktop/package.json')('better-sqlite3'); }
catch { try { Database = (await import('node:sqlite')).DatabaseSync; usingBetter = false; }
  catch { console.error('No SQLite driver available'); process.exit(2); } }

if (APPLY) {
  const bak = `${dbPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(dbPath, bak);
  console.log(`Backup written: ${bak}\n`);
}

const db = usingBetter ? new Database(dbPath) : new Database(dbPath);
const code = (db.prepare(`SELECT terminal_code FROM device_config WHERE id=1`).get()?.terminal_code || '').trim();
if (!code) { console.error('This till has no terminal_code set — set one (e.g. T2) first.'); process.exit(2); }

// Local completed orders that are NOT on the cloud = the lost ones.
const local = db.prepare(`SELECT id, order_number, total, sync_status, created_at FROM orders WHERE status='completed' ORDER BY created_at ASC`).all();
const missing = local.filter(o => !CLOUD_IDS.has(o.id));

if (!missing.length) { console.log('Nothing to recover — every local order is already on the cloud.'); process.exit(0); }

// New number keeps the original sequence, swaps the prefix to the current code.
const seqOf = (n) => { const m = /--(\d+)$/.exec(n || ''); return m ? Number(m[1]) : null; };
const plan = missing.map(o => {
  const seq = seqOf(o.order_number);
  const newNum = seq != null ? `${code}--${seq}` : `${code}--R-${o.id.slice(0, 6)}`;
  return { ...o, newNum };
});

// Refuse if the new numbers would STILL collide (i.e. terminal code not changed).
const collide = plan.filter(p => CLOUD_NUMBERS.has(p.newNum));
if (collide.length) {
  console.error(`ABORT: ${collide.length} recovered number(s) would still collide with the cloud (e.g. ${collide[0].newNum}).`);
  console.error(`This till's terminal code is "${code}", which the cloud already uses. Set a DISTINCT code (e.g. T2) in Technician setup, then re-run.`);
  process.exit(1);
}

console.log(`Terminal code: ${code}   ·   ${missing.length} order(s) missing from the cloud:\n`);
let sum = 0;
for (const p of plan) { sum += Number(p.total) || 0; console.log(`  ${p.order_number.padEnd(10)} → ${p.newNum.padEnd(10)}  KES ${p.total}  (${p.sync_status})  ${p.created_at}`); }
console.log(`\n  total: KES ${sum.toFixed(2)}`);

if (!APPLY) { console.log(`\nDRY RUN — nothing written. Re-run with --apply to re-queue these for sync.`); process.exit(0); }

const upOrder = db.prepare(`UPDATE orders SET order_number=?, sync_status='pending' WHERE id=?`);
const getQ = db.prepare(`SELECT id, payload FROM sync_queue WHERE order_id=?`);
const upQ = db.prepare(`UPDATE sync_queue SET payload=?, status='pending', attempts=0, last_error=NULL WHERE order_id=?`);
const runner = () => {
  for (const p of plan) {
    upOrder.run(p.newNum, p.id);
    const q = getQ.get(p.id);
    if (q) {
      let payload; try { payload = JSON.parse(q.payload); } catch { payload = null; }
      if (payload && typeof payload === 'object') { payload.order_number = p.newNum; upQ.run(JSON.stringify(payload), p.id); }
      else upQ.run(q.payload, p.id); // couldn't parse — still re-queue; server reads order_number from a fresh push
    }
  }
};
if (usingBetter) db.transaction(runner)(); else runner();
console.log(`\nAPPLIED — ${plan.length} order(s) re-numbered and re-queued as pending. They will push on the next sync (or tap Force sync).`);
