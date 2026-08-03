#!/usr/bin/env node
/**
 * Tech read-only DB console. Behavioral where it matters (the readonly handle
 * and the masking run against real SQLite), source-pinned where wiring is the
 * claim (session gate, audit-before-run).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require_ = createRequire(path.join(ROOT, 'package.json'));
const Database = require_('better-sqlite3');
console.log('driver: better-sqlite3 (repo root) — the driver the app uses');

let passed = 0, failed = 0;
const ok = (name, cond, extra='') => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
};

// Re-implementation of runTechQuery's rules over a supplied path; section 0
// pins the module to the same constants and shapes.
const MASK_COLUMN = /pin|token|secret|password|hash|key/i;
const MAX_ROWS = 500;
function runQuery(dbPath, sql) {
  const trimmed = String(sql ?? '').trim().replace(/;\s*$/, '');
  if (!trimmed) return { ok: false, error: 'Enter a query.' };
  if (trimmed.includes(';')) return { ok: false, error: 'One statement at a time.' };
  if (!/^(select|with|explain)\b/i.test(trimmed)) return { ok: false, error: 'Read-only console: SELECT, WITH, or EXPLAIN only.' };
  const ro = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    let stmt;
    try { stmt = ro.prepare(trimmed); }
    catch (err) { return { ok: false, error: err.message }; }
    if (!stmt.reader) return { ok: false, error: 'That statement returns no rows — the console is read-only.' };
    const raw = stmt.all();
    const truncated = raw.length > MAX_ROWS;
    const page = truncated ? raw.slice(0, MAX_ROWS) : raw;
    const meta = stmt.columns();
    const columns = meta.map(c => c.name);
    const maskedColumns = meta.filter(c => MASK_COLUMN.test(c.column ?? c.name)).map(c => c.name);
    const rows = page.map(r => columns.map(c =>
      maskedColumns.includes(c) && r[c] != null ? '•••masked•••' : r[c] ?? null));
    return { ok: true, result: { columns, rows, rowCount: raw.length, truncated, maskedColumns } };
  } finally { ro.close(); }
}

// A database shaped like the sensitive parts of the till's.
const tmp = path.join(os.tmpdir(), `swiftpos-techq-${process.pid}.db`);
{
  const db = new Database(tmp);
  db.exec(`
    CREATE TABLE session (id INTEGER PRIMARY KEY, token TEXT, refresh_token TEXT, business_name TEXT);
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, pin_hash TEXT);
    CREATE TABLE device_config (id INTEGER PRIMARY KEY, node_secret TEXT, server_url TEXT);
    CREATE TABLE shifts (id TEXT PRIMARY KEY, status TEXT, sync_status TEXT);
  `);
  db.prepare(`INSERT INTO session VALUES (1,'owner-bearer-abc','refresh-xyz','Beryl')`).run();
  db.prepare(`INSERT INTO users VALUES ('u1','Eugene','$2b$10$fakehash')`).run();
  db.prepare(`INSERT INTO device_config VALUES (1,'BRANCH-SECRET-42','https://api')`).run();
  db.prepare(`INSERT INTO shifts VALUES ('sh1','open','pending')`).run();
  db.close();
}

// ── 0. Module parity ─────────────────────────────────────────────────────────
console.log('\n0. Harness matches techService.ts');
{
  const src = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/techService.ts'), 'utf8');
  ok('same mask pattern', src.includes('/pin|token|secret|password|hash|key/i'));
  ok('module masks on SOURCE column, not alias', src.includes('c.column ?? c.name'));
  ok('same row cap', src.includes('MAX_ROWS = 500'));
  ok('connection opened READONLY', src.includes('{ readonly: true, fileMustExist: true }'));
  ok('statement allowlist matches', src.includes('^(select|with|explain)\\b'));
  const ipc = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/ipcHandlers.ts'), 'utf8');
  ok('IPC gated on an active tech session in MAIN',
     /tech:query[\s\S]{0,200}getActiveSession\(\)\) return \{ ok: false/.test(ipc));
  ok('query audited BEFORE it runs',
     /tech:query[\s\S]{0,500}logTechAction\('db_query'[\s\S]{0,120}return runTechQuery/.test(ipc));
  ok('device:reset closes the readonly handle too', ipc.includes('closeTechReadonlyDb()'));
}

// ── 1. The engine refuses writes — not a parser, the connection ─────────────
console.log('\n1. Writes are refused by the connection itself');
{
  const ro = new Database(tmp, { readonly: true });
  let threw = '';
  try { ro.prepare(`UPDATE shifts SET status='closed'`).run(); }
  catch (e) { threw = e.message; }
  ok('a prepared UPDATE on the readonly handle throws', /readonly|attempt to write/i.test(threw), threw);
  ro.close();
  ok('and the console refuses it earlier with a reason',
     runQuery(tmp, `UPDATE shifts SET status='closed'`).error?.includes('SELECT'));
  ok('DELETE refused', runQuery(tmp, `DELETE FROM shifts`).ok === false);
  ok('multi-statement refused', runQuery(tmp, `SELECT 1; DELETE FROM shifts`).error === 'One statement at a time.');
  ok('a trailing semicolon alone is fine', runQuery(tmp, `SELECT 1;`).ok === true);
}

// ── 2. Secrets never leave ───────────────────────────────────────────────────
console.log('\n2. Sensitive columns are masked by name');
{
  const r = runQuery(tmp, `SELECT id, token, refresh_token, business_name FROM session`);
  ok('query runs', r.ok === true);
  const [row] = r.result.rows;
  ok('owner bearer token masked', row[1] === '•••masked•••');
  ok('refresh token masked', row[2] === '•••masked•••');
  ok('non-secret column intact', row[3] === 'Beryl');
  ok('masked columns are declared to the tech', r.result.maskedColumns.join(',') === 'token,refresh_token');

  const r2 = runQuery(tmp, `SELECT name, pin_hash FROM users`);
  ok('pin hash masked (offline-crackable PIN space)', r2.result.rows[0][1] === '•••masked•••');
  const r3 = runQuery(tmp, `SELECT node_secret FROM device_config`);
  ok('branch node_secret masked', r3.result.rows[0][0] === '•••masked•••');

  // The obvious dodge: alias the secret. Masking keys on the SOURCE column,
  // so the alias changes nothing. An EXPRESSION wrapping a secret can still
  // leak — that residue is deliberate and lands verbatim in the audit.
  const r4 = runQuery(tmp, `SELECT token AS t FROM session`);
  ok('aliasing a secret does NOT unmask it', r4.result.rows[0][0] === '•••masked•••');
  ok('and the alias is reported as masked', r4.result.maskedColumns.includes('t'));
}

// ── 3. Reads that matter still work ─────────────────────────────────────────
console.log('\n3. The console is actually useful');
{
  const r = runQuery(tmp, `SELECT id, status, sync_status FROM shifts`);
  ok('the debugging query this week needed works',
     r.ok && r.result.rows[0].join(',') === 'sh1,open,pending');
  ok('EXPLAIN allowed', runQuery(tmp, `EXPLAIN QUERY PLAN SELECT * FROM shifts`).ok === true);
  ok('WITH allowed', runQuery(tmp, `WITH x AS (SELECT 1 a) SELECT a FROM x`).ok === true);
}


// ── 4. The wipes are gated and audited ───────────────────────────────────────
console.log('\n4. Wipes require a tech session and leave a record');
{
  const ipc = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/ipcHandlers.ts'), 'utf8');
  ok('config:clear refuses without a session',
     /config:clear[\s\S]{0,900}getActiveSession\(\)\) \{\s*throw/.test(ipc));
  ok('config:clear is audited', /config:clear[\s\S]{0,1200}logTechAction\('device.config_clear'/.test(ipc));
  ok('device:reset refuses without a session',
     /device:reset[\s\S]{0,600}getActiveSession\(\)\) \{\s*throw/.test(ipc));
  {
    const iLog = ipc.indexOf("logTechAction('device.reset'");
    const iRm  = ipc.indexOf('rmSync', Math.max(iLog, 0));
    ok('device:reset audits BEFORE the file drops', iLog > -1 && iRm > iLog);
  }
  ok('the reset flush is capped at 3s — a wipe never hangs on a dead network',
     /Promise\.race[\s\S]{0,200}3_000/.test(ipc));
  ok('the unsynced-orders guard survived the gating', ipc.includes('or they are lost'));
  const tech = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/techService.ts'), 'utf8');
  {
    // Persistence is about persistSession's BODY, not source proximity: the
    // assignment legitimately sits two lines after the persist call.
    const pf = tech.slice(tech.indexOf('function persistSession'));
    const body = pf.slice(0, pf.indexOf('\n}') + 2);
    ok('raw token held in memory only, never persisted',
       tech.includes('let _rawToken') && !body.includes('_rawToken'));
  }
}

// ── 5. pump_id flows end to end ──────────────────────────────────────────────
console.log('\n5. Fuel sales keep their pump');
{
  const pos  = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/renderer/pages/POSPage.tsx'), 'utf8');
  const cart = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/renderer/lib/cart.ts'), 'utf8');
  const eng  = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/syncEngine.ts'), 'utf8');
  const srv  = fs.readFileSync(path.join(ROOT, 'apps/server/src/routes/orders.ts'), 'utf8');
  ok('cart line stores the pump', cart.includes('pumpId?: string') && pos.includes('pumpId: pump.id'));
  ok('order payload carries pump_id from the first fuel line',
     pos.includes("cart.find(i => i.isFuel && i.pumpId)?.pumpId"));
  ok('local insert writes pump_id', /INSERT INTO orders \([^)]*pump_id/.test(eng)
     && eng.includes('orderPayload.pump_id ?? null'));
  ok('server insert accepts pump_id', srv.includes('pump_id:         req.body?.pump_id'));
  ok('and the tank deduction that reads it still exists', srv.includes('order.pump_id'));
  // Column count parity on the local insert — the exact bug class check-sql-binds
  // exists for, asserted directly here for this statement.
  const m = eng.match(/INSERT INTO orders \(([^)]+)\)\s*VALUES \(([^)]+)\)/);
  const cols = m[1].split(',').length;
  const vals = (m[2].match(/\?/g) || []).length + (m[2].match(/'completed'|'pending'/g) || []).length;
  ok('insert columns match values (' + cols + ')', cols === vals, cols + ' cols vs ' + vals + ' vals');
}

fs.unlinkSync(tmp);
console.log(`\n${passed} passed, ${failed} failed — against the app's own driver`);
process.exit(failed ? 1 : 0);
