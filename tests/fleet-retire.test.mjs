/**
 * fleet-retire.test.mjs — A184 Tier 3 Phase 2 (retire / restore a terminal).
 *
 * Phase 1 (migration 97) added user_devices.retired_at. Phase 2 uses it: the fleet
 * shows LIVE terminals only by default (retired ones leave the health view + the
 * not-syncing count), an owner can retire a dead till and restore it, and a Retired
 * tab lists the archive. Reversible; history is kept.
 *
 * Source-level; mutation-checkable. NOTE: this passes the schema gates only once
 * retired_at is in the live scripts/schema-index.json (i.e. after migration 97 is
 * applied + the index refreshed) — that is the Phase 1→2 ordering, by design.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = fs.readFileSync(path.join(root, 'apps/server/src/routes/devices.ts'), 'utf8');
const page   = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/FleetPage.tsx'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n       ${e.message}`); }
};

ok('server: fleet is LIVE-only by default, ?retired=1 shows the archive', () => {
  assert.match(server, /const showRetired = String\(req\.query\.retired \?\? ''\) === '1'/,
    'the fleet must read a retired flag');
  assert.match(server, /showRetired \? query\.not\('retired_at', 'is', null\) : query\.is\('retired_at', null\)/,
    'default excludes retired (retired_at IS NULL); ?retired=1 returns only retired');
});

ok('server: retire sets retired_at + retired_by, owner-scoped, guarded', () => {
  assert.match(server, /router\.patch\('\/:id\/retire'/, 'the retire endpoint must exist');
  assert.match(server, /\.update\(\{ retired_at: new Date\(\)\.toISOString\(\), retired_by: req\.userId \}\)/,
    'retire must stamp when + who');
  assert.match(server, /\.eq\('business_id', req\.businessId\)/, 'retire must be scoped to the owner\'s business');
  assert.match(server, /already retired/, 'a second retire must 409, not silently re-stamp');
});

ok('server: unretire is reversible (clears retired_at)', () => {
  assert.match(server, /router\.patch\('\/:id\/unretire'/, 'the unretire endpoint must exist');
  assert.match(server, /\.update\(\{ retired_at: null, retired_by: null \}\)/, 'unretire must clear the retirement');
});

ok('client: a Live/Retired toggle refetches the right list', () => {
  assert.match(page, /const \[showRetired, setShowRetired\] = useState\(false\)/, 'a showRetired toggle state');
  assert.match(page, /\/api\/devices\/fleet\$\{showRetired \? '\?retired=1' : ''\}/,
    'load must request the retired archive when toggled');
});

ok('client: retire and restore call the endpoints', () => {
  assert.match(page, /\/api\/devices\/\$\{id\}\/\$\{retire \? 'retire' : 'unretire'\}/,
    'the action must PATCH retire/unretire');
  assert.match(page, /confirm\(/, 'retire must confirm (it is a destructive-looking action)');
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
