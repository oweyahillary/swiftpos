// rearm-till.mjs — replay this till's local history to the server.
//
// Run with the TILL APP CLOSED:
//     node rearm-till.mjs "C:\\Users\\USER\\AppData\\Roaming\\SwiftPOS\\swiftpos.db"
//
// Why: the server was emptied/reset, so the till's rows are marked
// synced/failed/conflict against a server that no longer has them. This flips
// the sync bookkeeping back to 'pending' so the next sync re-pushes EVERYTHING
// in dependency order (trading days -> shifts -> orders). Push is idempotent on
// the order id (X-Idempotency-Key), so anything the server already has is
// de-duplicated — this can never create a double. It does NOT touch the sales
// themselves, only their sync flags. Makes a .bak copy first.

import { DatabaseSync } from 'node:sqlite';
import { copyFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) { console.error('Usage: node rearm-till.mjs <path-to-swiftpos.db>'); process.exit(2); }

const bak = path.replace(/\.db$/i, '') + `.bak-${Date.now()}.db`;
copyFileSync(path, bak);
console.log('backup written:', bak);

const db = new DatabaseSync(path);
const count = (sql) => db.prepare(sql).get().c;

console.log('\nBEFORE:');
console.log('  sync_queue:', db.prepare("SELECT status, COUNT(*) c FROM sync_queue GROUP BY status").all());
console.log('  orders pending:', count("SELECT COUNT(*) c FROM orders WHERE sync_status='pending'"),
            '/ total', count("SELECT COUNT(*) c FROM orders"));

db.exec('BEGIN');
try {
  // 1. re-arm the order push queue (both failed and already-synced)
  db.exec("UPDATE sync_queue SET status='pending', attempts=0 WHERE status IN ('failed','synced')");
  // 2. re-arm the orders themselves
  db.exec("UPDATE orders SET sync_status='pending' WHERE sync_status IN ('synced','conflict')");
  // 3. re-arm parents so orders have days/shifts to attach to on the server
  db.exec("UPDATE business_days SET sync_status='pending' WHERE sync_status IN ('synced','conflict')");
  db.exec("UPDATE shifts        SET sync_status='pending' WHERE sync_status IN ('synced','conflict')");
  // 4. re-arm money movements that also live server-side
  for (const t of ['float_transactions','expenses']) {
    try { db.exec(`UPDATE ${t} SET sync_status='pending' WHERE sync_status IN ('synced','conflict')`); } catch {}
  }
  // 5. clear the stale "Sync rejected: ..." notes so the UI banner resets
  db.exec("UPDATE business_days SET notes = NULL WHERE notes LIKE '%Sync rejected:%'");
  db.exec("UPDATE shifts        SET notes = NULL WHERE notes LIKE '%Sync rejected:%'");
  db.exec('COMMIT');
} catch (e) { db.exec('ROLLBACK'); console.error('rolled back:', e.message); process.exit(1); }

console.log('\nAFTER:');
console.log('  sync_queue:', db.prepare("SELECT status, COUNT(*) c FROM sync_queue GROUP BY status").all());
console.log('  orders pending:', count("SELECT COUNT(*) c FROM orders WHERE sync_status='pending'"),
            '/ total', count("SELECT COUNT(*) c FROM orders"));
console.log('  business_days pending:', count("SELECT COUNT(*) c FROM business_days WHERE sync_status='pending'"),
            ' shifts pending:', count("SELECT COUNT(*) c FROM shifts WHERE sync_status='pending'"));
db.close();
console.log('\nDone. Reopen the till app and let it sync (or tap the sync button).');
