/**
 * order-number-per-device.test.mjs — A183 (the durable fix for A181).
 *
 *   node --no-warnings tests/order-number-per-device.test.mjs
 *
 * THE BUG (A181)
 * --------------
 * The cloud enforced UNIQUE (business_id, branch_id, order_number), but an order
 * number is a per-TILL display value (terminal_code--localSeq). Two tills at one
 * branch — a second machine, or a reinstall re-named "T1" — mint the SAME numbers,
 * so the second till's orders were rejected (409) and the client wrongly recorded
 * the 409 as "synced": the sale never reached the cloud.
 *
 * THE FIX (migration 94)
 * ----------------------
 * Replace the branch-wide constraint with a per-device unique index
 *   (business_id, branch_id, COALESCE(device_id, ''), order_number)
 * so two tills' identical numbers coexist by device, while a single till still
 * cannot mint a genuine duplicate, and NULL-device (web/legacy) orders keep their
 * branch-wide uniqueness because COALESCE(NULL,'') collapses them into one bucket.
 *
 * This suite builds the REAL index and runs REAL inserts, so a future schema
 * change that reopens the collision — or that over-tightens and rejects a second
 * till — is caught on the bench. The final block is the mutation (rules 10, 23):
 * it rebuilds the PRE-94 branch-wide constraint and proves the collision returns,
 * so the passing assertions above measure the index, not nothing.
 *
 * Engine note (rule 9): prefers better-sqlite3 — the driver the till actually
 * runs — and falls back to node:sqlite (CI installs better-sqlite3; this sandbox
 * uses the fallback). UNIQUE-constraint semantics and expression indexes are
 * standard SQLite and identical across both, so this is a strong claim about the
 * index. Postgres note: migration 94 writes COALESCE(device_id, ''::text); the
 * '::text' cast is Postgres-only, so the SQLite mirror below uses plain ''.
 * Target-only (rule 16): applying the DDL on the live cloud orders table was the
 * remaining step — done and verified on prod 2026-08-28.
 */

let makeDb, driver;
try {
  const Better = (await import('better-sqlite3')).default;
  makeDb = () => new Better(':memory:');
  driver = 'better-sqlite3';
} catch {
  const { DatabaseSync } = await import('node:sqlite');
  makeDb = () => new DatabaseSync(':memory:');
  driver = 'node:sqlite';
}

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`); }
};

// Minimal mirror of the columns migration 94's index touches (kept in sync by
// hand: if the orders shape drifts, update here and the index re-proves itself).
const ORDERS_COLS = `
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL,
  branch_id    TEXT NOT NULL,
  device_id    TEXT,
  order_number TEXT NOT NULL`;

// Post-migration-94 schema: branch-wide constraint gone, per-device index in.
const NEW_SCHEMA = `
  CREATE TABLE orders (${ORDERS_COLS});
  CREATE UNIQUE INDEX orders_biz_branch_device_ordernum_uidx
    ON orders (business_id, branch_id, COALESCE(device_id, ''), order_number);`;

// Pre-migration-94 schema (the A181 trap): branch-wide uniqueness, no device.
const OLD_SCHEMA = `
  CREATE TABLE orders (${ORDERS_COLS},
    UNIQUE (business_id, branch_id, order_number));`;

// Run the insert the till issues; return the thrown message, or null on success.
function insertOrder(db, o) {
  try {
    db.prepare(
      `INSERT INTO orders (id, business_id, branch_id, device_id, order_number)
       VALUES (?, ?, ?, ?, ?)`
    ).run(o.id, o.business_id, o.branch_id, o.device_id ?? null, o.order_number);
    return null;
  } catch (e) { return e.message; }
}
const isUnique = (msg) => msg !== null && /UNIQUE constraint failed/i.test(msg);

console.log(`(engine: ${driver})`);

// 1 + 2. THE FIX: two tills at one branch mint the same number and BOTH land.
{
  const db = makeDb(); db.exec(NEW_SCHEMA);
  const a = insertOrder(db, { id: 'o1', business_id: 'biz1', branch_id: 'br1', device_id: 'devA', order_number: 'T1--001' });
  const b = insertOrder(db, { id: 'o2', business_id: 'biz1', branch_id: 'br1', device_id: 'devB', order_number: 'T1--001' });
  ok('till A inserts order number T1--001', a === null);
  ok('till B (different device) inserts the SAME number — no collision', b === null);
}

// 3. Per-device uniqueness still holds: one till cannot re-use its own number.
{
  const db = makeDb(); db.exec(NEW_SCHEMA);
  insertOrder(db, { id: 'o1', business_id: 'biz1', branch_id: 'br1', device_id: 'devA', order_number: 'T1--001' });
  const dup = insertOrder(db, { id: 'o2', business_id: 'biz1', branch_id: 'br1', device_id: 'devA', order_number: 'T1--001' });
  ok('same till re-using its own number is rejected (UNIQUE)', isUnique(dup));
}

// 4. NULL-device (web/legacy) orders stay branch-unique via COALESCE(NULL,'').
{
  const db = makeDb(); db.exec(NEW_SCHEMA);
  insertOrder(db, { id: 'o1', business_id: 'biz1', branch_id: 'br1', device_id: null, order_number: 'W-100' });
  const dup = insertOrder(db, { id: 'o2', business_id: 'biz1', branch_id: 'br1', device_id: null, order_number: 'W-100' });
  ok('two NULL-device orders sharing a number are rejected (branch-unique)', isUnique(dup));
}

// 5. A NULL-device order and a real-device order may share a number — the ''
//    bucket and the device bucket are distinct.
{
  const db = makeDb(); db.exec(NEW_SCHEMA);
  const nul = insertOrder(db, { id: 'o1', business_id: 'biz1', branch_id: 'br1', device_id: null, order_number: 'X-1' });
  const dev = insertOrder(db, { id: 'o2', business_id: 'biz1', branch_id: 'br1', device_id: 'devA', order_number: 'X-1' });
  ok('NULL-device and a real device may share a number (distinct buckets)', nul === null && dev === null);
}

// 6. MUTATION (rules 10, 23): rebuild the PRE-94 branch-wide constraint and prove
//    the two-till collision returns. If this ever passes, the index is not the
//    thing preventing collisions and the assertions above are decoration.
{
  const db = makeDb(); db.exec(OLD_SCHEMA);
  insertOrder(db, { id: 'o1', business_id: 'biz1', branch_id: 'br1', device_id: 'devA', order_number: 'T1--001' });
  const collide = insertOrder(db, { id: 'o2', business_id: 'biz1', branch_id: 'br1', device_id: 'devB', order_number: 'T1--001' });
  ok('mutation: under the pre-94 constraint, two tills collide (A181 reproduced)', isUnique(collide));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
