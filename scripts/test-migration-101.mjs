/**
 * test-migration-101.mjs — transfer received-qty columns, against real Postgres (PGlite).
 * Pins A221's schema: stock_transfer_items.quantity_received + stock_transfers.receipt_note
 * are added, idempotently, without touching the existing `quantity` (sent) column.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); }
catch { console.error('\n@electric-sql/pglite not installed — cannot run.\n'); process.exit(1); }

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SQL  = fs.readFileSync(path.join(ROOT, 'migrations/101_transfer_received_quantity.sql'), 'utf8');

let pass = 0, fail = 0;
const ok = (n, fn) => { try { fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };

const colType = async (db, table, col) => {
  const r = await db.query(
    `SELECT data_type FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 AND column_name=$2`, [table, col]);
  return r.rows[0]?.data_type ?? null;
};

console.log('\nMigration 101 (transfer received quantity) — PGlite\n');
await (async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE public.stock_transfers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid, status text, notes text);
    CREATE TABLE public.stock_transfer_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), transfer_id uuid NOT NULL,
      product_id uuid NOT NULL, quantity numeric(12,3) NOT NULL, created_at timestamptz DEFAULT now());
    CREATE TABLE public.schema_migrations (version text PRIMARY KEY, notes text, applied_at timestamptz DEFAULT now());
  `);

  // pre-state: neither new column exists
  const beforeItems = await colType(db, 'stock_transfer_items', 'quantity_received');
  const beforeXfers = await colType(db, 'stock_transfers', 'receipt_note');
  ok('quantity_received absent before migration', () => assert.strictEqual(beforeItems, null));
  ok('receipt_note absent before migration', () => assert.strictEqual(beforeXfers, null));

  await db.exec(SQL);

  const qr = await colType(db, 'stock_transfer_items', 'quantity_received');
  const rn = await colType(db, 'stock_transfers', 'receipt_note');
  const sent = await colType(db, 'stock_transfer_items', 'quantity');
  ok('quantity_received added as numeric', () => assert.strictEqual(qr, 'numeric'));
  ok('receipt_note added as text', () => assert.strictEqual(rn, 'text'));
  ok('the sent quantity column is untouched', () => assert.strictEqual(sent, 'numeric'));

  // a row can carry sent + received independently
  await db.exec(`INSERT INTO public.stock_transfers (id, status) VALUES ('00000000-0000-0000-0000-0000000000aa','received');`);
  await db.exec(`INSERT INTO public.stock_transfer_items (transfer_id, product_id, quantity, quantity_received)
                 VALUES ('00000000-0000-0000-0000-0000000000aa','00000000-0000-0000-0000-0000000000bb', 5, 3);`);
  const row = (await db.query(`SELECT quantity, quantity_received FROM public.stock_transfer_items`)).rows[0];
  ok('sent 5 / received 3 co-exist on a line', () => {
    assert.strictEqual(Number(row.quantity), 5);
    assert.strictEqual(Number(row.quantity_received), 3);
  });

  // idempotent
  await db.exec(SQL);
  const stillQr = await colType(db, 'stock_transfer_items', 'quantity_received');
  ok('re-running is a no-op (idempotent)', () => assert.strictEqual(stillQr, 'numeric'));

  const ledger = (await db.query(`SELECT 1 FROM public.schema_migrations WHERE version='101_transfer_received_quantity'`)).rows.length;
  ok('records itself in schema_migrations', () => assert.strictEqual(ledger, 1));

  console.log(`\n${fail ? 'FAILURES' : 'all green'}  (${pass} passed, ${fail} failed)\n`);
  process.exit(fail ? 1 : 0);
})();
