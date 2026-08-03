#!/usr/bin/env node
/**
 * Phase 4 — central day close. Runs the instruction lifecycle against real
 * SQLite and pins the module's load-bearing choices with source assertions.
 *
 * What must hold:
 *   1. An instruction is re-offered until ACKED — delivery alone never retires
 *      it, so a peer that crashes between collecting and executing is asked
 *      again.
 *   2. Queueing a second close for the same peer REPLACES the pending one —
 *      two pending instructions with two counted amounts is a question with
 *      two answers.
 *   3. Only an ack changes status, and it lands acked/failed by the peer's
 *      verdict.
 *   4. The executor is idempotent: no open day → ok:true already_closed, and a
 *      date mismatch is a named refusal, not a close of the wrong day.
 *   5. closeDay keeps its local isManager gate; closeDayInstructed exists and
 *      does NOT re-check it (the instruction is the authority).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require_ = createRequire(path.join(ROOT, 'package.json'));

let Database, driver;
try { Database = require_('better-sqlite3'); driver = 'better-sqlite3 (repo root) — the driver the app uses'; }
catch {
  const { DatabaseSync } = await import('node:sqlite');
  Database = class { constructor(p){ const d=new DatabaseSync(p); this.prepare=s=>{const st=d.prepare(s);return{get:(...a)=>st.get(...a),all:(...a)=>st.all(...a),run:(...a)=>{const r=st.run(...a);return{changes:Number(r.changes),lastInsertRowid:Number(r.lastInsertRowid)}}}}; this.exec=s=>d.exec(s);} };
  driver = 'node:sqlite (fallback — run once against better-sqlite3)';
}
console.log(`driver: ${driver}`);

let passed = 0, failed = 0;
const ok = (name, cond, extra='') => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
};

const SRC_BC = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/branchClose.ts'), 'utf8');
const SRC_DS = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/dayService.ts'), 'utf8');
const SRC_IX = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/index.ts'), 'utf8');
const SRC_NS = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/nodeServer.ts'), 'utf8');
const SRC_DB = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/localDb.ts'), 'utf8');

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE node_instructions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
      created_by TEXT, created_at TEXT NOT NULL, delivered_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending', ack TEXT, acked_at TEXT);
    CREATE TABLE node_peer_state (
      device_id TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at TEXT NOT NULL);
  `);
  return db;
}

// Mirrors of the module's SQL (parity pinned in section 0).
const create = (db, dev, payload) => {
  db.prepare(`DELETE FROM node_instructions WHERE device_id = ? AND kind = 'close_day' AND status = 'pending'`).run(dev);
  return db.prepare(`INSERT INTO node_instructions (device_id, kind, payload, created_by, created_at)
                     VALUES (?, 'close_day', ?, NULL, ?)`).run(dev, JSON.stringify(payload), new Date().toISOString());
};
const collect = (db, dev) => {
  const rows = db.prepare(`SELECT id, kind, payload FROM node_instructions WHERE device_id = ? AND status = 'pending' ORDER BY id`).all(dev);
  const now = new Date().toISOString();
  for (const r of rows) db.prepare(`UPDATE node_instructions SET delivered_at = COALESCE(delivered_at, ?) WHERE id = ?`).run(now, r.id);
  return rows;
};
const ack = (db, id, okFlag) =>
  db.prepare(`UPDATE node_instructions SET status = ?, ack = ?, acked_at = ? WHERE id = ? AND status = 'pending'`)
    .run(okFlag ? 'acked' : 'failed', '{}', new Date().toISOString(), id);

// ── 0. Parity — the harness runs the module's SQL, not its own idea of it ────
console.log('\n0. Harness matches branchClose.ts');
{
  ok('replace-then-insert on create', SRC_BC.includes(`kind = 'close_day' AND status = 'pending'`)
                                    && SRC_BC.includes(`INSERT INTO node_instructions`));
  ok('collect keeps status pending (delivery never retires)',
     /UPDATE node_instructions SET delivered_at = COALESCE\(delivered_at, \?\) WHERE id = \?/.test(SRC_BC)
     && !/collectInstructions[\s\S]{0,600}status\s*=\s*'delivered'/.test(SRC_BC));
  ok('ack updates only pending rows', SRC_BC.includes(`WHERE id = ? AND status = 'pending'`));
  ok('local schema creates both tables', SRC_DB.includes('node_instructions') && SRC_DB.includes('node_peer_state'));
  ok('LOCAL_SCHEMA_VERSION is 46', /LOCAL_SCHEMA_VERSION = 46/.test(SRC_DB));
}

// ── 1. Re-offered until acked ────────────────────────────────────────────────
console.log('\n1. Delivery never retires an instruction — only an ack does');
{
  const db = freshDb();
  create(db, 'dev-T2', { business_date: '2026-08-03', counted_cash: 5000 });
  const first = collect(db, 'dev-T2');
  ok('collected once', first.length === 1);
  const again = collect(db, 'dev-T2');
  ok('a crashed peer is offered it AGAIN', again.length === 1 && again[0].id === first[0].id);
  ack(db, first[0].id, true);
  ok('after the ack it is retired', collect(db, 'dev-T2').length === 0);
  ok('and recorded acked', db.prepare(`SELECT status FROM node_instructions WHERE id=?`).get(first[0].id).status === 'acked');
}

// ── 2. A second close replaces the pending first ─────────────────────────────
console.log('\n2. One live close per peer — a corrected amount replaces, never stacks');
{
  const db = freshDb();
  create(db, 'dev-T2', { business_date: '2026-08-03', counted_cash: 5000 });
  create(db, 'dev-T2', { business_date: '2026-08-03', counted_cash: 5500 });
  const rows = collect(db, 'dev-T2');
  ok('exactly one instruction survives', rows.length === 1);
  ok('and it carries the corrected amount', JSON.parse(rows[0].payload).counted_cash === 5500);
  ack(db, rows[0].id, true);
  create(db, 'dev-T2', { business_date: '2026-08-03', counted_cash: 100 });
  ok('an ACKED instruction is history, not replaced',
     db.prepare(`SELECT COUNT(*) n FROM node_instructions WHERE device_id='dev-T2'`).get().n === 2);
}

// ── 3. Failed verdicts land as failed ────────────────────────────────────────
console.log('\n3. The peer\'s refusal is recorded as a refusal');
{
  const db = freshDb();
  create(db, 'dev-T3', { business_date: '2026-08-03', counted_cash: 0 });
  const [ins] = collect(db, 'dev-T3');
  ack(db, ins.id, false);
  const row = db.prepare(`SELECT status FROM node_instructions WHERE id=?`).get(ins.id);
  ok('status is failed, visible on the manager screen', row.status === 'failed');
  ok('a failed instruction is not re-offered', collect(db, 'dev-T3').length === 0);
}

// ── 4. Executor semantics, pinned in source ──────────────────────────────────
console.log('\n4. The executor is idempotent and refuses a date mismatch by name');
{
  ok('no open day acks SUCCESS with already_closed (not an error)',
     /if \(!day\) \{\s*return \{ ok: true, already_closed: true \};/.test(SRC_BC));
  ok('a date mismatch is refused, not closed',
     SRC_BC.includes(`not \${payload.business_date}`) && SRC_BC.includes('Check the clocks'));
  ok('executeCloseDay never throws — the ack is the error channel',
     /executeCloseDay[\s\S]{0,300}try \{/.test(SRC_BC) && /catch \(err: any\) \{\s*return \{ ok: false/.test(SRC_BC));
}

// ── 5. Authority: local close still gated, instructed close is not ───────────
console.log('\n5. closeDay keeps its manager gate; the instruction is its own authority');
{
  ok('closeDay still checks isManager()',
     /export function closeDay\([\s\S]{0,200}isManager\(\)/.test(SRC_DS));
  ok('closeDayInstructed exists and does not re-check isManager',
     /export function closeDayInstructed\(/.test(SRC_DS)
     && !/export function closeDayInstructed\([\s\S]{0,900}isManager\(\)/.test(SRC_DS));
  ok('the central close is named in the notes',
     SRC_DS.includes('Closed centrally from the branch server'));
  ok('open-drawer refusal survives in the shared core',
     /closeDayCore[\s\S]{0,700}liveShift/.test(SRC_DS));
}

// ── 6. Peer loop wiring ──────────────────────────────────────────────────────
console.log('\n6. The peer side is actually wired');
{
  ok('peers poll every 15s, not on the 60s sync tick', /15_000\)/.test(SRC_IX) && /pollNodeInstructions/.test(SRC_IX));
  ok('the node itself does not poll', /device_role === 'node'\) return/.test(SRC_IX));
  ok('an unacked outcome is retried, not dropped', /pendingAcks/.test(SRC_IX));
  ok('unknown instruction kinds are named, not ignored', SRC_IX.includes('older build'));
  ok('node serves the poll and ack endpoints',
     SRC_NS.includes('/node/instructions/poll') && SRC_NS.includes('/node/instructions/ack'));
  ok('poll piggybacks peer state', /recordPeerState\(deviceId, body\.state\)/.test(SRC_NS.replace(/\s+/g,' ')) || SRC_NS.includes('recordPeerState(deviceId, body.state)'));
}

console.log(`\n${passed} passed, ${failed} failed${driver.startsWith('better') ? ' — against the app\'s own driver' : ''}`);
process.exit(failed ? 1 : 0);
