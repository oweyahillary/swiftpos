/**
 * A273 — GET /api/shifts/terminals lists a branch's tills for the web till
 * picker (Option B). This is a SOURCE-ASSERTION guard (the route needs Supabase
 * to run); the live query is a target confirm (rule 16). Mutation check
 * (rules 10, 23): drop any scoping clause below and the matching assertion reds.
 */
import assert from 'node:assert';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = p => fs.readFileSync(path.join(root, p), 'utf8');
const SH = 'apps/server/src/routes/shifts.ts';
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log('PASS ' + n); } catch (e) { fail++; console.log('FAIL ' + n + '\n   ' + e.message); } };

ok('A273: the /terminals route exists', () => {
  assert.match(r(SH), /router\.get\('\/terminals'/);
});

ok('A273: it is scoped to the caller business AND the requested branch', () => {
  const s = r(SH);
  const m = /router\.get\('\/terminals'[\s\S]{0,900}?res\.json\(tills\)/.exec(s);
  assert.ok(m, '/terminals handler not found');
  const h = m[0];
  assert.match(h, /\.eq\('business_id', req\.businessId\)/); // never another business's devices
  assert.match(h, /\.eq\('branch_id', branchId\)/);          // this branch only
  assert.match(h, /req\.query\.branch_id/);                  // branch comes from the query
});

ok('A273: only live, keyable tills are returned (approved, not retired, has device_id)', () => {
  const s = r(SH);
  const h = /router\.get\('\/terminals'[\s\S]{0,900}?res\.json\(tills\)/.exec(s)[0];
  assert.match(h, /\.eq\('status', 'approved'\)/);
  assert.match(h, /\.is\('retired_at', null\)/);
  assert.match(h, /\.not\('device_id', 'is', null\)/);
});

ok('A273: the shape is minimal — device_id/terminal_code/device_label, no telemetry or cash', () => {
  const s = r(SH);
  const h = /router\.get\('\/terminals'[\s\S]{0,900}?res\.json\(tills\)/.exec(s)[0];
  assert.match(h, /device_id:\s+d\.device_id/);
  assert.match(h, /terminal_code: d\.terminal_code/);
  assert.match(h, /device_label:\s+d\.device_label/);
  assert.doesNotMatch(h, /last_seen_at|app_version|cash|expected/); // scope stays minimal
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
