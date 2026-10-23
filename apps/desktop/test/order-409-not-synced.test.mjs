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
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// The REAL compiled engine on the REAL till schema (dist/main/localDb on a temp userData, electron shimmed), and the
// REAL durable log (dist/main/logFile writing swiftpos.log in that userData). The hand-made schema this test used to
// carry went stale as the order push grew (sales on account, A552): the order stage threw before it reached the network.
//
//   cd apps/desktop && npm run build:main && node test/order-409-not-synced.test.mjs
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
if (!fs.existsSync(path.join(dist, 'syncEngine.js'))) { console.error('dist/main not built. Run:  npm run build:main'); process.exit(1); }
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-o409-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.20' }, ipcMain: { handle() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => true } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return orig.call(this, req === 'electron' ? shim : req, parent, ...rest); };

const L = require(path.join(dist, 'localDb.js'));
const engine = require(path.join(dist, 'syncEngine.js'));
const DC = require(path.join(dist, 'deviceConfig.js'));
const LF = require(path.join(dist, 'logFile.js'));
const durableLog = () => { try { LF._flushRepeats?.(); return fs.readFileSync(LF.getLogPath(), 'utf8'); } catch { return ''; } };

const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'u-owner', 'biz-1', 'Pollo', '2026-10-23T00:00:00Z')`).run();
DC.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'b1', device_id: 'd1', device_role: 'till', terminal_code: 'T1', device_name: 'Front' });

// A sale rung on this till whose number another order already holds on the cloud.
const at = new Date().toISOString();
db.prepare(`INSERT INTO orders (id, business_id, branch_id, order_number, subtotal, vat_amount, total, created_at, sync_status, device_id)
  VALUES ('o1', 'biz-1', 'b1', 'T1--1', 100, 0, 100, ?, 'pending', 'd1')`).run(at);
db.prepare(`INSERT INTO sync_queue (order_id, payload, created_at, status) VALUES ('o1', ?, ?, 'pending')`)
  .run(JSON.stringify({ id: 'o1', branch_id: 'b1', order_number: 'T1--1', items: [], payments: [] }), at);

// Server responds 409 (order-number collision) for the order push.
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (u) => String(u).includes('/api/orders')
  ? json(409, { error: 'Order number already exists — please retry.' })
  : json(404, {});

engine.configureSyncEngine('http://cloud', 'tok', 'refresh');

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`FAIL  ${n}  ${d}`); } };

console.log(`order 409 not-synced (real localDb)\n`);
for (let i = 0; i < 5; i++) await engine.syncPush();
const q = db.prepare("SELECT status, attempts, last_error FROM sync_queue WHERE order_id='o1'").get();

ok('a 409 NEVER marks the order synced', q.status !== 'synced', JSON.stringify(q));
ok('the local order is not marked synced either', db.prepare("SELECT sync_status FROM orders WHERE id='o1'").get().sync_status !== 'synced');
ok('after repeated collisions it escalates to failed (visible)', q.status === 'failed', JSON.stringify(q));
ok('the reason names the number conflict', /order number/i.test(q.last_error || ''), JSON.stringify(q));
ok('the 409 reached the durable log', /rejected \(409\)/.test(durableLog()));

console.log(`\n${pass} passed, ${fail} failed`);
try { L.closeLocalDb?.(); } catch { /* ignore */ }
process.exit(fail === 0 ? 0 : 1);
