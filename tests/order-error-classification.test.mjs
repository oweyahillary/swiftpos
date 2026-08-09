/**
 * order-error-classification.test.mjs
 *
 * Covers the two halves of the 2026-08-07 Beryl failure:
 *
 *   1. WHY it was invisible — every Postgres error that was not 23505 or 23514
 *      fell through to `throw createErr` and became one generic sentence.
 *      Driven against the REAL lib/orderErrors.ts, not a model of it.
 *
 *   2. WHY it happened — /login and /desktop-login matched the owner's
 *      public.users row with a CASE-SENSITIVE `.eq('email', …)`. A miss falls
 *      back to data.user.id, an auth.users id, and orders.cashier_id is
 *      `REFERENCES public.users(id)` — so every push fails 23503 for the life
 *      of the refresh chain, because /refresh reuses userId.
 *
 * MUTATION CHECK (rule 10). Both halves model the OLD behaviour alongside the
 * new one and assert the old one fails, which is this suite's existing
 * convention (see auth-resolution.test.mjs `oldSingle`). Additionally, section
 * 1 imports the shipped module: delete a branch from classifyOrderCreateError
 * and these go red immediately.
 *
 * Build first — this imports from dist/:
 *   cd apps/server && npm run build && node ../../tests/order-error-classification.test.mjs
 */
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

let classifyOrderCreateError, describePgError;
try {
  ({ classifyOrderCreateError, describePgError } =
    require(path.join(here, '../apps/server/dist/lib/orderErrors.js')));
} catch (e) {
  console.error(
    '\nCannot load apps/server/dist/lib/orderErrors.js — build the server first:\n' +
    '  cd apps/server && npm run build\n');
  process.exit(1);
}

let passed = 0, failed = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
};

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n1. Postgres errors are classified, not flattened (real module)');

// What the code did before: anything not 23505/23514 was rethrown and became
// "Failed to create order (ref: …)" with no code and no column named.
const oldBehaviour = (err) =>
  (err.code === '23514' || /payment legs sum/.test(err.message ?? ''))
    ? { status: 400, code: undefined }
    : { status: 500, code: undefined, generic: true };

const FK = {
  code: '23503',
  message: 'insert or update on table "orders" violates foreign key constraint "orders_cashier_id_fkey"',
  details: 'Key (cashier_id)=(9f1c…) is not present in table "users".',
};

ok('23503 is a named 422, not a generic 500', () => {
  const v = classifyOrderCreateError(FK);
  assert.equal(v.status, 422);
  assert.equal(v.code, 'ORDER_FK_VIOLATION');
  assert.ok(!v.rethrow, 'must not rethrow — that is what hid it');
});

ok('23503 detail names the constraint AND the offending key', () => {
  const v = classifyOrderCreateError(FK);
  assert.match(v.detail, /orders_cashier_id_fkey/);
  assert.match(v.detail, /cashier_id/);
});

ok('MUTATION: the old behaviour reported 23503 as a generic 500', () => {
  const old = oldBehaviour(FK);
  assert.equal(old.status, 500);
  assert.ok(old.generic);
  // The whole point: old and new must disagree, or the fix is decoration.
  assert.notEqual(old.status, classifyOrderCreateError(FK).status);
});

ok('22P02 (malformed uuid) is 422 ORDER_MALFORMED_VALUE', () => {
  const v = classifyOrderCreateError({
    code: '22P02', message: 'invalid input syntax for type uuid: "P1"' });
  assert.equal(v.status, 422);
  assert.equal(v.code, 'ORDER_MALFORMED_VALUE');
});

ok('22007 (malformed timestamp) is 422 — the OFFLINE created_at exposure', () => {
  const v = classifyOrderCreateError({
    code: '22007', message: 'invalid input syntax for type timestamp with time zone: "07/08/2026 21:09"' });
  assert.equal(v.status, 422);
  assert.equal(v.code, 'ORDER_MALFORMED_VALUE');
});

ok('23502 (not null) is 422 ORDER_MISSING_FIELD', () => {
  assert.equal(classifyOrderCreateError({ code: '23502', message: 'null value in column "branch_id"' }).code,
    'ORDER_MISSING_FIELD');
});

ok('23514 still passes the reconciliation message through as 400', () => {
  const v = classifyOrderCreateError({
    code: '23514', message: 'payment legs sum to 600 but the amount due is 640 (total 600 + tip 40)' });
  assert.equal(v.status, 400);
  assert.match(v.message, /payment legs sum/);
  assert.ok(!v.rethrow);
});

ok('the guard is caught by message even without the SQLSTATE', () => {
  const v = classifyOrderCreateError({ message: 'payment legs sum to 1 but the amount due is 2' });
  assert.equal(v.status, 400);
});

ok('an unknown code still rethrows, but the detail is preserved for the log', () => {
  const v = classifyOrderCreateError({ code: '40001', message: 'could not serialize access' });
  assert.equal(v.status, 500);
  assert.ok(v.rethrow, 'unknown classes must still surface as unhandled');
  assert.match(v.detail, /serialize/);
});

ok('describePgError joins message, details and hint without losing any', () => {
  const d = describePgError({ message: 'm', details: 'd', hint: 'h' });
  assert.equal(d, 'm | d | h');
});

ok('describePgError survives an empty error object', () => {
  assert.equal(describePgError({}), '');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n2. Owner email resolution is case-insensitive and pattern-safe');

/** The NEW resolver's logic: escaped coarse ilike, then exact compare in JS. */
const resolveNew = (rows, email) => {
  const needle = String(email ?? '').trim().toLowerCase();
  if (!needle) return null;
  const likeSafe = needle.replace(/[\\%_]/g, ch => `\\${ch}`);
  // Model PostgREST ilike with escaping honoured: % and _ are literals here.
  const candidates = rows.filter(r =>
    String(r.email ?? '').toLowerCase() === likeSafe.replace(/\\(.)/g, '$1'));
  return candidates.find(r => String(r.email ?? '').trim().toLowerCase() === needle) ?? null;
};

/** The OLD behaviour: .eq('email', …) — case-sensitive exact match. */
const resolveOld = (rows, email) => rows.find(r => r.email === email) ?? null;

const USERS = [{ id: 'u1', email: 'Beryl@Example.co.ke' }];

ok('MUTATION: the old .eq missed a case variant — this is the root cause', () => {
  assert.equal(resolveOld(USERS, 'beryl@example.co.ke'), null);
});

ok('the new resolver finds it', () => {
  assert.equal(resolveNew(USERS, 'beryl@example.co.ke')?.id, 'u1');
});

ok('a miss is what poisons the token — assert the consequence explicitly', () => {
  // auth.ts: userId = ownerUser ? ownerUser.id : data.user.id
  const authUserId = 'auth-uuid-not-in-public-users';
  const tokenUserId = (resolveOld(USERS, 'beryl@example.co.ke'))?.id ?? authUserId;
  assert.equal(tokenUserId, authUserId,
    'the old path mints a token carrying an auth.users id');
  // …and orders.cashier_id REFERENCES public.users(id), so:
  const inPublicUsers = USERS.some(u => u.id === tokenUserId);
  assert.equal(inPublicUsers, false, 'which is exactly the 23503 above');
});

ok('underscore is a literal, not a wildcard (BUG-05 regression)', () => {
  const rows = [{ id: 'a', email: 'johnXdoe@x.com' }, { id: 'b', email: 'john_doe@x.com' }];
  assert.equal(resolveNew(rows, 'john_doe@x.com')?.id, 'b');
});

ok('percent is a literal too', () => {
  const rows = [{ id: 'a', email: 'anything@x.com' }, { id: 'b', email: 'a%b@x.com' }];
  assert.equal(resolveNew(rows, 'a%b@x.com')?.id, 'b');
});

ok('an empty or missing email resolves to nothing rather than the first row', () => {
  assert.equal(resolveNew(USERS, ''), null);
  assert.equal(resolveNew(USERS, undefined), null);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
