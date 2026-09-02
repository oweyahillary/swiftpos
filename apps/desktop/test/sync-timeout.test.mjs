/**
 * sync-timeout.test.mjs — A177.
 *
 * The P0 that stranded 6 orders in the field: sync fetches had no timeout, and
 * `_isSyncing` is cleared only in `finally`. A connection that opens but never
 * responds hung the await forever, so `finally` never ran, `_isSyncing` stayed
 * true, and EVERY later sync — the 60s flush, the post-sale flush, reconnect,
 * and the Force-sync button — returned "Sync already in progress." Orders sat
 * pending, 0 attempts, 0 failed, invisible, until the app restarted.
 *
 * This drives the REAL compiled syncEngine with a fetch that hangs until aborted
 * (like a real black-holed socket) and a short SYNC_FETCH_TIMEOUT_MS, and asserts
 * the wedge is impossible: the pass RESOLVES, the order is attempted, and a
 * following sync is never blocked.
 */
import assert from 'assert';
import fs from 'fs'; import os from 'os'; import path from 'path'; import Module from 'module';
import { pathToFileURL, fileURLToPath } from 'url';

process.env.SYNC_FETCH_TIMEOUT_MS = '300';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '..', 'dist', 'main');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synctimeout-'));
const w = (n, s) => { const p = path.join(tmp, n); fs.writeFileSync(p, s); return p; };

const require0 = Module.createRequire(path.join(DIST, '..', '..', 'package.json'));
let db, driver;
try { db = new (require0('better-sqlite3'))(':memory:'); driver = 'better-sqlite3'; }
catch { const { DatabaseSync } = await import('node:sqlite'); db = new DatabaseSync(':memory:'); driver = 'node:sqlite'; }

db.exec(`
  CREATE TABLE sync_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, attempts INTEGER DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL, status TEXT DEFAULT 'pending');
  CREATE TABLE orders (id TEXT PRIMARY KEY, sync_status TEXT DEFAULT 'pending');
  CREATE TABLE shifts (id TEXT, business_id TEXT, branch_id TEXT, cashier_id TEXT, opened_at TEXT, closed_at TEXT, status TEXT, opening_float REAL, closing_float REAL, expected_cash REAL, cash_variance REAL, notes TEXT, created_at TEXT, business_day_id TEXT, business_date TEXT, device_id TEXT, terminal_code TEXT, drawer_label TEXT, opened_by TEXT, sync_status TEXT);
  CREATE TABLE float_transactions (id TEXT, shift_id TEXT, branch_id TEXT, cashier_id TEXT, type TEXT, amount REAL, reason TEXT, created_at TEXT, device_id TEXT, sync_status TEXT);
  CREATE TABLE expenses (id TEXT, business_id TEXT, branch_id TEXT, expense_category_id TEXT, description TEXT, amount REAL, paid_by TEXT, expense_date TEXT, shift_id TEXT, created_at TEXT, device_id TEXT, sync_status TEXT);
  CREATE TABLE business_days (id TEXT, business_id TEXT, branch_id TEXT, device_id TEXT, terminal_code TEXT, business_date TEXT, opened_at TEXT, opened_by TEXT, closed_at TEXT, closed_by TEXT, status TEXT, counted_cash REAL, expected_cash REAL, cash_variance REAL, notes TEXT, sync_status TEXT);
  CREATE TABLE local_price_edits (product_id TEXT, price REAL, updated_at TEXT, updated_by TEXT, synced INTEGER DEFAULT 0);
`);
db.prepare(`INSERT INTO sync_queue (order_id,payload,created_at,status) VALUES ('o1',?,?,'pending')`).run(JSON.stringify({ branch_id: 'b1', order_number: 'A-1', items: [], payments: [] }), new Date().toISOString());
db.prepare(`INSERT INTO orders (id,sync_status) VALUES ('o1','pending')`).run();

const map = {
  electron: w('electron.cjs', `module.exports={app:{getPath:()=>${JSON.stringify(tmp)}},net:{isOnline:()=>true},safeStorage:{isEncryptionAvailable:()=>false}};`),
  './localDb': w('localDb.cjs', `module.exports={getLocalDb:()=>global.__db,LOCAL_SCHEMA_VERSION:52};`),
  './deviceConfig': w('deviceConfig.cjs', `module.exports={getDeviceConfig:()=>({device_id:'d1',branch_id:'b1',node_url:null}),saveDeviceConfig:()=>{},getServerUrl:()=>'http://127.0.0.1:9',canSell:()=>true,isNodeRole:()=>false};`),
  './nodeClient': w('nodeClient.cjs', `module.exports={hasNode:()=>false,pushRowsToNode:async()=>({}),measureNodeDrift:async()=>({}),fetchReferenceFromNode:async()=>null};`),
  './nodeIngest': w('nodeIngest.cjs', `module.exports=new Proxy({},{get:()=>()=>{}});`),
  './logFile': w('logFile.cjs', `module.exports={logLine:()=>{},getLogPath:()=>'x',describeResponse:async()=>''};`),
};
global.__db = db;
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...r) {
  const fd = parent?.filename?.startsWith(DIST);
  if (req === 'electron') return map.electron;
  if (fd && map[req]) return map[req];
  return orig.call(this, req, parent, ...r);
};

// A fetch that hangs until its AbortSignal fires — exactly what a black-holed
// connection does, and exactly what the old code hung on forever.
globalThis.fetch = (_u, o) => new Promise((_res, rej) => {
  if (o?.signal) o.signal.addEventListener('abort', () => rej(o.signal.reason || new Error('aborted')));
});

const engine = await import(pathToFileURL(path.join(DIST, 'syncEngine.js')).href);
engine.configureSyncEngine('http://127.0.0.1:9', 'tok', 'refresh');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`FAIL  ${name}`); } };
const attempts = () => db.prepare(`SELECT attempts FROM sync_queue WHERE order_id='o1'`).get().attempts;

console.log(`sync fetch timeout (driver: ${driver})\n`);

const t0 = Date.now();
const r1 = await engine.syncPush();            // old code: hangs forever here
const dt = Date.now() - t0;
ok('a hung fetch RESOLVES via the timeout (does not hang the pass)', dt < 5000);
ok('the order got a real attempt (not stranded at 0)', attempts() === 1);
ok('the failure names a timeout', /timed out/.test(JSON.stringify(r1.errors)));

const r2 = await engine.syncPush();            // old code: "Sync already in progress" forever
ok('a following sync is NOT wedged (Force sync still works)', !r2.errors.includes('Sync already in progress'));
ok('the second pass attempted again', attempts() === 2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
