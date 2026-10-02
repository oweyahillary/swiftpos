/**
 * A275 — cloud day-close relay endpoints. SOURCE-ASSERTION guard (routes need
 * Supabase to run; the live loop is a target confirm, rule 16). Mutation-checked.
 */
import assert from 'node:assert';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = p => fs.readFileSync(path.join(root, p), 'utf8');
const DC = 'apps/server/src/routes/day-close.ts';
const IX = 'apps/server/src/routes/index.ts';
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log('PASS ' + n); } catch (e) { fail++; console.log('FAIL ' + n + '\n   ' + e.message); } };

ok('A275: the route is mounted at /day-close', () => {
  assert.match(r(IX), /router\.use\('\/day-close',\s*dayCloseRoutes\)/);
  assert.match(r(IX), /import dayCloseRoutes\s+from '\.\/day-close'/);
});

ok('A275: manager endpoints are gated on shifts.force_close | settings.manage', () => {
  const s = r(DC);
  assert.match(s, /requireAnyPermission\('shifts\.force_close', 'settings\.manage'\)/);
  assert.match(s, /router\.post\('\/instruct', MANAGER,/);
  assert.match(s, /router\.get\('\/overview', MANAGER,/);
});

ok('A275: /instruct requires a real count and replaces any pending close for that till+day', () => {
  const s = r(DC);
  assert.match(s, /counted_cash must be 0 or more/);                        // no fabricated/empty count
  assert.match(s, /\.delete\(\)[\s\S]{0,240}\.eq\('status', 'pending'\)/);  // replace pending
  assert.match(s, /business_date: businessDate,/);                         // payload carries the date
});

ok('A275: /pending and /ack are scoped to the calling device (X-Device-Id)', () => {
  const s = r(DC);
  assert.match(s, /function deviceIdOf\(req: any\)/);
  const pending = /router\.get\('\/pending'[\s\S]{0,900}?res\.json\(rows/.exec(s)[0];
  assert.match(pending, /\.eq\('device_id', deviceId\)/);
  assert.match(pending, /\.eq\('status', 'pending'\)/);
  assert.match(pending, /delivered_at/); // marks delivered
  const ack = /router\.post\('\/ack'[\s\S]{0,900}?maybeSingle\(\)/.exec(s)[0];
  assert.match(ack, /\.eq\('device_id', deviceId\)/);   // a till can only ack its own
  assert.match(ack, /\.eq\('status', 'pending'\)/);     // and only a live one
});

ok('A275: overview reads OPEN business_days (never closes the cloud copy)', () => {
  const s = r(DC);
  assert.match(s, /\.from\('business_days'\)[\s\S]{0,200}\.eq\('status', 'open'\)/);
  // the relay must NOT write a business_days close anywhere
  assert.doesNotMatch(s, /\.from\('business_days'\)[\s\S]{0,160}\.update\(/);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
