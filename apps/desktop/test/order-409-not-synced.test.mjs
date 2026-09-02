/**
 * order-409-not-synced.test.mjs — A181.
 *
 * A 409 from /api/orders means an order-NUMBER collision — a DIFFERENT order
 * already holds this (business, branch, order_number). It does NOT mean the
 * server has THIS order. The old client marked such orders `synced`, silently
 * losing every sale whose number collided (a second till/install reusing T1--N).
 * This drives the real compiled engine with a 409 responder and asserts the order
 * is surfaced (escalates to failed), never marked synced.
 */
import assert from 'assert';
import fs from 'fs'; import os from 'os'; import path from 'path'; import Module from 'module';
import { pathToFileURL, fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '..', 'dist', 'main');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'o409-'));
const w = (n, s) => { const p = path.join(tmp, n); fs.writeFileSync(p, s); return p; };
const require0 = Module.createRequire(path.join(DIST, '..', '..', 'package.json'));
let db, driver;
try { db = new (require0('better-sqlite3'))(':memory:'); driver = 'better-sqlite3'; }
catch { const { DatabaseSync } = await import('node:sqlite'); db = new DatabaseSync(':memory:'); driver = 'node:sqlite'; }

db.exec(`
  CREATE TABLE sync_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, attempts INTEGER DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL, status TEXT DEFAULT 'pending');
  CREATE TABLE orders (id TEXT PRIMARY KEY, sync_status TEXT DEFAULT 'pending');
  CREATE TABLE shifts (id TEXT, sync_status TEXT, device_id TEXT);
  CREATE TABLE float_transactions (id TEXT, sync_status TEXT, device_id TEXT);
  CREATE TABLE expenses (id TEXT, sync_status TEXT, device_id TEXT);
  CREATE TABLE business_days (id TEXT, sync_status TEXT, device_id TEXT);
  CREATE TABLE local_price_edits (product_id TEXT, price REAL, updated_at TEXT, synced INTEGER DEFAULT 0);
`);
db.prepare(`INSERT INTO sync_queue (order_id,payload,created_at,status) VALUES ('o1',?,?,'pending')`).run(JSON.stringify({ branch_id: 'b1', order_number: 'T1--1', items: [], payments: [] }), new Date().toISOString());
db.prepare(`INSERT INTO orders (id,sync_status) VALUES ('o1','pending')`).run();

const logs = [];
const map = {
  electron: w('electron.cjs', `module.exports={app:{getPath:()=>${JSON.stringify(tmp)}},net:{isOnline:()=>true},safeStorage:{isEncryptionAvailable:()=>false}};`),
  './localDb': w('localDb.cjs', `module.exports={getLocalDb:()=>global.__db,LOCAL_SCHEMA_VERSION:52};`),
  './deviceConfig': w('deviceConfig.cjs', `module.exports={getDeviceConfig:()=>({device_id:'d1',branch_id:'b1',node_url:null}),saveDeviceConfig:()=>{},getServerUrl:()=>'http://127.0.0.1:9',canSell:()=>true,isNodeRole:()=>false};`),
  './nodeClient': w('nodeClient.cjs', `module.exports={hasNode:()=>false,pushRowsToNode:async()=>({}),measureNodeDrift:async()=>({}),fetchReferenceFromNode:async()=>null};`),
  './nodeIngest': w('nodeIngest.cjs', `module.exports=new Proxy({},{get:()=>()=>{}});`),
  './logFile': w('logFile.cjs', `module.exports={logLine:(s,m)=>global.__logs.push('['+s+'] '+m),getLogPath:()=>'x',describeResponse:async()=>''};`),
};
global.__db = db; global.__logs = logs;
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...r) { const fd = parent?.filename?.startsWith(DIST); if (req === 'electron') return map.electron; if (fd && map[req]) return map[req]; return orig.call(this, req, parent, ...r); };

// Server responds 409 (order-number collision) for the order push.
globalThis.fetch = async (u) => String(u).includes('/api/orders')
  ? { ok: false, status: 409, json: async () => ({ error: 'Order number already exists — please retry.' }), text: async () => '' }
  : { ok: false, status: 404, json: async () => ({}), text: async () => '' };

const engine = await import(pathToFileURL(path.join(DIST, 'syncEngine.js')).href);
engine.configureSyncEngine('http://127.0.0.1:9', 'tok', 'refresh');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`FAIL  ${n}`); } };

console.log(`order 409 not-synced (driver: ${driver})\n`);
for (let i = 0; i < 5; i++) await engine.syncPush();
const q = db.prepare("SELECT status, attempts, last_error FROM sync_queue WHERE order_id='o1'").get();

ok('a 409 NEVER marks the order synced', q.status !== 'synced');
ok('the local order is not marked synced either', db.prepare("SELECT sync_status FROM orders WHERE id='o1'").get().sync_status !== 'synced');
ok('after repeated collisions it escalates to failed (visible)', q.status === 'failed');
ok('the reason names the number conflict', /order number/i.test(q.last_error || ''));
ok('the 409 reached the durable log', logs.some(l => /rejected \(409\)/.test(l)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
