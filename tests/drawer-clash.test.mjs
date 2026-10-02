/**
 * drawer-clash.test.mjs — A338 (2026-09-27): a sale whose drawer is not on the cloud yet is told to wait, not failed.
 *
 *   node tests/drawer-clash.test.mjs
 *
 * The till side runs for real in apps/desktop/test/drawer-clash-sync.test.mjs (compiled engine + SQLite against a
 * stand-in cloud); the index change runs on real Postgres in scripts/test-migration-107.mjs. This pins the cloud route
 * by source (Express + the database are not run here).
 *
 * MUTATIONS TO CONFIRM BITE:
 *   - the drawer check removed from POST /api/orders          → "unknown drawer → 424 shift_not_synced" fails
 *   - the check moved after the create                        → "…BEFORE the sale is written" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const o = read('apps/server/src/routes/orders.ts');
const route = o.slice(o.indexOf("router.post('/', async (req, res) => {"), o.indexOf("router.get('/', async (req, res) => {"));
const guard = route.indexOf("res.status(424).json({ code: 'shift_not_synced'");

ok('unknown drawer → 424 shift_not_synced, looked up by id inside the caller\'s business', () => {
  assert.ok(guard > 0, 'no 424 guard in POST /api/orders');
  assert.match(route, /\.from\('shifts'\)\.select\('id'\)\.eq\('id', resolvedShiftId\)\.eq\('business_id', req\.businessId\)\.maybeSingle\(\)/);
});
ok('…BEFORE the sale is written (create_order_atomic), so the foreign key never fails as a 500/422', () => {
  const create = route.indexOf("rpc('create_order_atomic'");
  assert.ok(create > 0, 'create_order_atomic call not found');
  assert.ok(guard < create);
});
ok('the till recognises exactly that status and keeps the sale pending', () => {
  const se = read('apps/desktop/src/main/syncEngine.ts');
  assert.match(se, /\} else if \(res\.status === 424\) \{[\s\S]{0,700}UPDATE sync_queue SET last_error=\? WHERE id=\?/);
});
ok('migration 107 replaces the unique index with a plain one', () => {
  const m = read('migrations/107_open_shifts_never_block_sync.sql');
  assert.match(m, /DROP INDEX IF EXISTS public\.shifts_one_open_per_terminal;/);
  assert.match(m, /CREATE INDEX IF NOT EXISTS shifts_open_by_terminal/);
  assert.doesNotMatch(m, /CREATE UNIQUE INDEX/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
