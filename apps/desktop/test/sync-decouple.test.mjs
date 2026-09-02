/**
 * sync-decouple.test.mjs — A178.
 *
 * Before: syncPush ran the stages in a single try, so if pushLocalRecords threw
 * (e.g. a shifts SELECT hitting a missing column) the order push on the next line
 * was skipped — orders could sit pending while nothing was wrong with them. Now
 * each stage runs independently. This drives the REAL compiled engine with a
 * BROKEN shifts schema (so the shift push throws) and a working order endpoint,
 * and asserts the order still pushes and the shift throw is logged.
 */
import assert from 'assert';
import fs from 'fs'; import os from 'os'; import path from 'path'; import Module from 'module';
import { pathToFileURL, fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '..', 'dist', 'main');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'decouple-'));
const w = (n, s) => { const p = path.join(tmp, n); fs.writeFileSync(p, s); return p; };
const require0 = Module.createRequire(path.join(DIST, '..', '..', 'package.json'));
let db; try { db = new (require0('better-sqlite3'))(':memory:'); } catch { const { DatabaseSync } = await import('node:sqlite'); db = new DatabaseSync(':memory:'); }

// NOTE: shifts is deliberately MISSING business_id (and most columns) so the real
// pushLocalRecords SELECT throws "no such column" — the exact class this decouples.
db.exec(`
  CREATE TABLE sync_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, attempts INTEGER DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL, status TEXT DEFAULT 'pending');
  CREATE TABLE orders (id TEXT PRIMARY KEY, sync_status TEXT DEFAULT 'pending');
  CREATE TABLE shifts (id TEXT, sync_status TEXT, device_id TEXT);            -- intentionally broken
  CREATE TABLE float_transactions (id TEXT, sync_status TEXT, device_id TEXT);
  CREATE TABLE expenses (id TEXT, sync_status TEXT, device_id TEXT);
  CREATE TABLE business_days (id TEXT, sync_status TEXT, device_id TEXT);
  CREATE TABLE local_price_edits (product_id TEXT, price REAL, updated_at TEXT, synced INTEGER DEFAULT 0);
`);
db.prepare(`INSERT INTO shifts (id,sync_status,device_id) VALUES ('s1','pending','d1')`).run();  // forces the SELECT to run
db.prepare(`INSERT INTO sync_queue (order_id,payload,created_at,status) VALUES ('o1',?,?,'pending')`).run(JSON.stringify({ branch_id: 'b1', order_number: 'A-1', items: [], payments: [] }), new Date().toISOString());
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

// order endpoint succeeds (201); anything else 404
globalThis.fetch = async (u) => String(u).includes('/api/orders')
  ? { ok: true, status: 201, json: async () => ({ id: 'o1' }), text: async () => '' }
  : { ok: false, status: 404, json: async () => ({}), text: async () => '' };

const engine = await import(pathToFileURL(path.join(DIST, 'syncEngine.js')).href);
engine.configureSyncEngine('http://127.0.0.1:9', 'tok', 'refresh');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`FAIL  ${n}`); } };

const r = await engine.syncPush();
const orderRow = db.prepare(`SELECT status FROM sync_queue WHERE order_id='o1'`).get();

ok('the order STILL pushed despite the shift-push throwing', orderRow.status === 'synced');
ok('syncPush reports pushed=1', r.pushed === 1);
ok('the shift-push throw was recorded in errors', r.errors.some(e => /shift push/i.test(e)));
ok('the shift-push throw reached the durable log', logs.some(l => /shift push stage threw/i.test(l)));
ok('the order-push success reached the durable log', logs.some(l => /pushed 1 order/i.test(l)));

// breakdown surfaces what is pending
const st = engine.getSyncStatus();
ok('getSyncStatus exposes a pending breakdown', !!st.pendingBreakdown && typeof st.pendingBreakdown.shifts === 'number');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
