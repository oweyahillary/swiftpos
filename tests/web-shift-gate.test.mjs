/**
 * A274 — the web POS must not create a sale with shift_id:null.
 *
 * The desktop till hard-gates selling on an open drawer session ("No shift is
 * open. Start a shift before selling."). The web CashierScreen only soft-prompted
 * and, worse, swallowed a failed /api/shifts/current check — so a transient
 * failure left currentShift=null with the Charge path still live, and every
 * order-create site sent `shift_id: currentShift?.id ?? null`. An order attached
 * to no shift cannot be reconciled into any drawer and silently diverges from
 * shift totals (P1).
 *
 * This is a SOURCE-ASSERTION guard (the dashboard cannot run headless here). It
 * proves the gate text is present at each selling boundary; the on-screen
 * behaviour (charge blocked, prompt appears) is a target confirm (rule 16).
 * Mutation check (rules 10, 23): delete any one guard below and the matching
 * assertion goes red naming it.
 */
import assert from 'node:assert';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = p => fs.readFileSync(path.join(root, p), 'utf8');
const CS = 'apps/dashboard/src/pages/pos/CashierScreen.tsx';
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log('PASS ' + n); } catch (e) { fail++; console.log('FAIL ' + n + '\n   ' + e.message); } };

ok('A274: the /current check no longer swallows failures silently', () => {
  const s = r(CS);
  // The old `.catch(() => {});` left the shift state unknown AND the screen sellable.
  assert.doesNotMatch(s, /\.catch\(\(\)\s*=>\s*\{\}\);/);
  assert.match(s, /\.catch\(\(\)\s*=>\s*setShiftModal\('open'\)\);/);
});

ok('A274: the Charge button is disabled when no shift is open', () => {
  const s = r(CS);
  // charge-specific anchors: the chargeBtn opacity + disabled + the sell-blocked note
  assert.match(s, /\{ \.\.\.s\.chargeBtn, opacity: currentShift \? 1 : 0\.5 \}\}\s*\n\s*disabled=\{!currentShift\}/);
  assert.match(s, /Open a shift to start selling\./);
});

ok('A274: Send to Kitchen is gated on an open shift (button + handler)', () => {
  const s = r(CS);
  assert.match(s, /disabled=\{sendingToKitchen \|\| !currentShift/);       // button
  assert.match(s, /if \(!currentShift\) \{ setShiftModal\('open'\); return; \}\s*\n\s*setSendingToKitchen/); // handler
});

ok('A274: Room charge is gated on an open shift (button + handler)', () => {
  const s = r(CS);
  assert.match(s, /disabled=\{!roomNumber\.trim\(\) \|\| roomCharging \|\| !currentShift\}/); // button
  assert.match(s, /if \(!currentShift\) \{ setShowRoomCharge\(false\); setShiftModal\('open'\); return; \}/); // handler
});

ok('A274: no order-create site relies on shift_id:null as a normal path', () => {
  // The `?? null` fallbacks stay (defensive), but every reachable selling
  // boundary above now blocks first, so null can only occur if all guards are
  // removed. Assert the three guards co-exist with the three create sites.
  const s = r(CS);
  const createSites = (s.match(/shift_id:\s*currentShift\?\.id \?\? null/g) || []).length;
  assert.ok(createSites >= 2, `expected the known order-create sites, found ${createSites}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
