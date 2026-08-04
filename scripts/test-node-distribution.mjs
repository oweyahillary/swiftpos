#!/usr/bin/env node
/**
 * Phase 2a — distribution (the replicated star). Behavioral against real
 * SQLite for the collection/cursor mechanics; source-pinned for wiring.
 *
 * What must hold:
 *   1. The node serves OTHER devices' rows only — a requester is never offered
 *      its own rows back (applyPeerRows would rightly refuse a sender wearing
 *      the receiver's identity, so offering them would poison every pull).
 *   2. Origin device_id and origin seq are served exactly as held — the node
 *      is distribution, not authority.
 *   3. Per-origin cursors resume: a pull after `after` yields only newer rows,
 *      and a repeated pull with the advanced cursor yields nothing.
 *   4. The budget caps a pull and has_more says so — a till off for a day
 *      catches up in bounded rounds, not one unbounded response.
 *   5. Orders travel with their lines AND payments in the same batch.
 *   6. The receiving side runs batches through applyPeerRows under the
 *      ORIGIN's identity and advances cursors only to what applied.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require_ = createRequire(path.join(ROOT, 'package.json'));
let Database, driver;
try { Database = require_('better-sqlite3'); driver = "better-sqlite3 (repo root) — the driver the app uses"; }
catch {
  const { DatabaseSync } = await import('node:sqlite');
  Database = class { constructor(p){ const d=new DatabaseSync(p); this.prepare=s=>{const st=d.prepare(s);return{get:(...a)=>st.get(...a),all:(...a)=>st.all(...a),run:(...a)=>{const r=st.run(...a);return{changes:Number(r.changes)}}}}; this.exec=s=>d.exec(s);} };
  driver = 'node:sqlite (fallback — run once against better-sqlite3)';
}
console.log(`driver: ${driver}`);

let passed = 0, failed = 0;
const ok = (name, cond, extra='') => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
};

const SRC_NI = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/nodeIngest.ts'), 'utf8');
const SRC_NS = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/nodeServer.ts'), 'utf8');
const SRC_NC = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/nodeClient.ts'), 'utf8');
const SRC_IX = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/index.ts'), 'utf8');
const SRC_DB = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/localDb.ts'), 'utf8');

// Mirror of collectDistribution's per-(origin, table) SQL, pinned in section 0.
function collect(db, origins, requester, cursors, limit) {
  const batches = []; let budget = limit; let has_more = false;
  const set = new Set(origins); set.delete(requester);
  for (const origin of set) {
    for (const table of ['orders']) {
      if (budget <= 0) return { batches, has_more: true };
      const after = Number(cursors?.[origin]?.[table] ?? 0);
      const rows = db.prepare(
        `SELECT id, total, device_id, seq FROM orders
          WHERE COALESCE(device_id,'') = COALESCE(?,'') AND seq > ?
          ORDER BY seq LIMIT ?`).all(origin, after, budget + 1);
      if (!rows.length) continue;
      if (rows.length > budget) { has_more = true; rows.length = budget; }
      budget -= rows.length;
      batches.push({ device_id: origin, table, rows });
    }
  }
  return { batches, has_more };
}

// ── 0. Parity ────────────────────────────────────────────────────────────────
console.log('\n0. Harness matches nodeIngest.ts');
{
  ok('collection excludes the requester at the source', SRC_NI.includes('origins.delete(requesterDeviceId)'));
  ok('per-origin per-table query matches (origin scope + seq cursor)',
     SRC_NI.includes(`COALESCE(device_id,'') = COALESCE(?,'') AND seq > ?`));
  ok('budget over-fetches by one to detect has_more', SRC_NI.includes('budget + 1'));
  ok('orders carry _items and _payments in distribution',
     /collectDistribution[\s\S]{0,2500}r\._items = readItems\.all[\s\S]{0,200}r\._payments = readPays\.all/.test(SRC_NI));
  ok('apply goes through applyPeerRows under the ORIGIN identity',
     /applyDistribution[\s\S]{0,600}applyPeerRows\(b\.table, b\.device_id, b\.rows/.test(SRC_NI));
  ok('unknown tables from a newer node are skipped, not coerced',
     /applyDistribution[\s\S]{0,400}isReplicatedTable\(b\.table\)\) continue/.test(SRC_NI));
  ok('cursor advances only to what applied, never backwards',
     /r\.cursor > getCursor\(b\.device_id, b\.table\)/.test(SRC_NI));
}

// ── 1..4 behavioral: exclusion, fidelity, cursors, budget ────────────────────
console.log('\n1. The node never offers a till its own rows back');
const db = new Database(':memory:');
db.exec(`CREATE TABLE orders (id TEXT PRIMARY KEY, total REAL, device_id TEXT, seq INTEGER)`);
const seed = db.prepare(`INSERT INTO orders VALUES (?, ?, ?, ?)`);
seed.run('n1', 100, 'dev-NODE', 1);
seed.run('n2', 200, 'dev-NODE', 2);
seed.run('t2a', 300, 'dev-T2', 1);
seed.run('t2b', 400, 'dev-T2', 2);
seed.run('t3a', 500, 'dev-T3', 7);   // T3's counter is its own — seq 7 is fine
const ORIGINS = ['dev-NODE', 'dev-T2', 'dev-T3'];
{
  const r = collect(db, ORIGINS, 'dev-T2', {}, 100);
  const served = r.batches.flatMap(b => b.rows.map(x => x.id));
  ok('T2 gets NODE and T3 rows', served.includes('n1') && served.includes('t3a'));
  ok('and none of its own', !served.includes('t2a') && !served.includes('t2b'));
  const t3 = r.batches.find(b => b.device_id === 'dev-T3');
  ok('origin device_id served as held', t3.rows[0].device_id === 'dev-T3');
  ok('origin seq served as held, not re-minted', t3.rows[0].seq === 7);
}

console.log('\n2. Per-origin cursors resume, and an advanced cursor yields nothing');
{
  const first = collect(db, ORIGINS, 'dev-T3', {}, 100);
  const nodeRows = first.batches.find(b => b.device_id === 'dev-NODE').rows;
  ok('fresh pull sees both node rows', nodeRows.length === 2);
  const again = collect(db, ORIGINS, 'dev-T3', { 'dev-NODE': { orders: 2 }, 'dev-T2': { orders: 2 } }, 100);
  ok('caught-up cursors yield nothing', again.batches.length === 0 && !again.has_more);
  seed.run('n3', 600, 'dev-NODE', 3);
  const after = collect(db, ORIGINS, 'dev-T3', { 'dev-NODE': { orders: 2 }, 'dev-T2': { orders: 2 } }, 100);
  ok('only the new row arrives', after.batches.length === 1 && after.batches[0].rows[0].id === 'n3');
}

console.log('\n3. The budget bounds a pull and has_more is honest');
{
  const r = collect(db, ORIGINS, 'dev-T3', {}, 2);
  const total = r.batches.reduce((n, b) => n + b.rows.length, 0);
  ok('at most budget rows served', total === 2);
  ok('has_more raised', r.has_more === true);
  // Drain loop: successive pulls with advanced cursors terminate.
  let cursors = {}, rounds = 0, seen = 0;
  for (; rounds < 10; rounds++) {
    const p = collect(db, ORIGINS, 'dev-T3', cursors, 2);
    if (!p.batches.length) break;
    for (const b of p.batches) {
      seen += b.rows.length;
      const max = Math.max(...b.rows.map(x => x.seq));
      (cursors[b.device_id] ??= {})[b.table] = Math.max(cursors[b.device_id]?.[b.table] ?? 0, max);
    }
    if (!p.has_more) { rounds++; break; }
  }
  ok('drain terminates with every row seen exactly once', seen === 5, `saw ${seen} in ${rounds} rounds`);
}

// ── 5. Receiver-side wiring ──────────────────────────────────────────────────
console.log('\n4. The pull loop is actually wired, on the peer, bounded');
{
  ok('peers pull every 30s', /30_000\)/.test(SRC_IX) && SRC_IX.includes('pullNodeDistribution(distributionCursors())'));
  // Same invariant as the instruction poll: SERVING roles (node or office)
  // never pull from themselves.
  ok('serving roles do not pull from themselves',
     /isNodeRole\(cfg\.device_role\)\) return;[\s\S]{0,600}pullNodeDistribution/.test(SRC_IX));
  ok('has_more drains in bounded rounds', /round < 10/.test(SRC_IX));
  ok('node serves /node/since behind the pre-routing auth', SRC_NS.includes("url === '/node/since'"));
  ok('branch mismatch refused on the endpoint',
     /\/node\/since[\s\S]{0,600}branch mismatch/.test(SRC_NS));
  ok('client sends its cursors and identity', /node\/since[\s\S]{0,400}cursors, limit/.test(SRC_NC));
  ok('v47 indexes exist for the walk', SRC_DB.includes('idx_orders_device_seq'));
  {
    const local = Number((SRC_DB.match(/LOCAL_SCHEMA_VERSION = (\d+)/) || [])[1]);
    const req = Number((fs.readFileSync(path.join(ROOT, 'apps/server/src/lib/desktopSchema.ts'), 'utf8')
      .match(/REQUIRED_DESKTOP_SCHEMA = (\d+)/) || [])[1]);
    ok('schema at least v47 (this feature\'s floor) and both sides equal',
       local >= 47 && local === req, `${local}/${req}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed${driver.startsWith('better') ? " — against the app's own driver" : ''}`);
process.exit(failed ? 1 : 0);
