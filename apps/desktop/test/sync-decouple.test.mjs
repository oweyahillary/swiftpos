/**
 * sync-decouple.test.mjs — A178.
 *
 * Before: syncPush ran the stages in a single try, so if pushLocalRecords threw
 * (e.g. a shifts SELECT hitting a missing column) the order push on the next line
 * was skipped — orders could sit pending while nothing was wrong with them. Now
 * each stage runs independently. This drives the REAL compiled engine on the REAL
 * till schema (dist/main/localDb, a temp userData, electron shimmed), then BREAKS
 * the shifts table (so the shift push throws) behind a working order endpoint,
 * and asserts the order still pushes and the shift throw reaches the durable log.
 *
 * The till's own schema, not a hand-made one: the hand-made schema this test used
 * to carry went stale as the order push grew (sales on account, A552) and every
 * stage failed for reasons unrelated to the one under test.
 *
 *   cd apps/desktop && npm run build:main && node test/sync-decouple.test.mjs
 */
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
if (!fs.existsSync(path.join(dist, 'syncEngine.js'))) { console.error('dist/main not built. Run:  npm run build:main'); process.exit(1); }
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-decouple-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.20' }, ipcMain: { handle() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => true } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return orig.call(this, req === 'electron' ? shim : req, parent, ...rest); };

const L = require(path.join(dist, 'localDb.js'));
const E = require(path.join(dist, 'syncEngine.js'));
const DC = require(path.join(dist, 'deviceConfig.js'));
const LF = require(path.join(dist, 'logFile.js'));
const durableLog = () => { try { LF._flushRepeats?.(); return fs.readFileSync(LF.getLogPath(), 'utf8'); } catch { return ''; } };

const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'u-owner', 'biz-1', 'Pollo', '2026-10-23T00:00:00Z')`).run();
DC.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'b1', device_id: 'd1', device_role: 'till', terminal_code: 'T1', device_name: 'Front' });

// A pending shift so the shift push's SELECT actually runs, then the shifts table is BROKEN: rebuilt with only three of
// its columns, so the real pushLocalRecords SELECT throws "no such column" — the exact class this decouples.
db.exec(`DROP TABLE shifts; CREATE TABLE shifts (id TEXT, sync_status TEXT, device_id TEXT);`);
db.prepare(`INSERT INTO shifts (id, sync_status, device_id) VALUES ('s1', 'pending', 'd1')`).run();

// A sale rung on this till: the order and its queue row, as the selling path writes them.
const at = new Date().toISOString();
db.prepare(`INSERT INTO orders (id, business_id, branch_id, order_number, subtotal, vat_amount, total, created_at, sync_status, device_id)
  VALUES ('o1', 'biz-1', 'b1', 'A-1', 100, 0, 100, ?, 'pending', 'd1')`).run(at);
db.prepare(`INSERT INTO sync_queue (order_id, payload, created_at, status) VALUES ('o1', ?, ?, 'pending')`)
  .run(JSON.stringify({ id: 'o1', branch_id: 'b1', order_number: 'A-1', items: [], payments: [] }), at);

// order endpoint succeeds (201); anything else 404
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (u) => String(u).includes('/api/orders') ? json(201, { orderId: 'o1' }) : json(404, {});
E.configureSyncEngine('http://cloud', 'tok', 'refresh');

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`FAIL  ${n}  ${d}`); } };

const r = await E.syncPush();
const orderRow = db.prepare(`SELECT status FROM sync_queue WHERE order_id='o1'`).get();
const log = durableLog();

ok('the order STILL pushed despite the shift-push throwing', orderRow?.status === 'synced', JSON.stringify({ orderRow, errors: r.errors }));
ok('syncPush reports pushed=1', r.pushed === 1, JSON.stringify(r));
ok('the shift-push throw was recorded in errors', r.errors.some(e => /shift push/i.test(e)), JSON.stringify(r.errors));
ok('the shift-push throw reached the durable log', /shift push stage threw/i.test(log));
ok('the order-push success reached the durable log', /pushed 1 order/i.test(log));

// breakdown surfaces what is pending
const st = E.getSyncStatus();
ok('getSyncStatus exposes a pending breakdown', !!st.pendingBreakdown && typeof st.pendingBreakdown.shifts === 'number');

console.log(`\n${pass} passed, ${fail} failed`);
try { L.closeLocalDb?.(); } catch { /* ignore */ }
process.exit(fail === 0 ? 0 : 1);
