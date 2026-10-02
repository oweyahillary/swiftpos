/**
 * ipc-guard-optional.test.mjs — A297.
 *
 * A no-arg invoke (undefined payload) on a FULLY-OPTIONAL bag channel must be
 * accepted as an empty bag, so the Overview (salesSummary()/topProducts() with no
 * argument) and Item Mix reach their handlers instead of being rejected at the
 * boundary with "payload must be an object". A REQUIRED-field channel must still
 * reject an absent payload, and a non-object (array) must still be rejected — the
 * coercion is undefined/null -> {} only, never a loosening of a real requirement.
 *
 * MUTATION-CHECKED (rules 10, 23):
 *   - revert `payload ?? {}` back to `payload` in guardChannel  -> cases 1-3 FAIL
 *     (a no-arg optional call throws again — the exact Overview regression).
 *   - make the coercion skip the required-field check           -> case 5 FAILS
 *     (order:void would wrongly accept an empty bag).
 *   - coerce arrays/scalars to {} too                           -> case 4 FAILS.
 */
import assert from 'assert';
import { pathToFileURL, fileURLToPath } from 'url';
import path from 'path';

const here = path.dirname(fileURLToPath(import.meta.url));
const { guardChannel } = await import(
  pathToFileURL(path.join(here, '..', 'dist', 'main', 'ipcGuard.js')).href
);

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`FAIL  ${n}`); } };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

console.log('ipc guard — optional payload (A297)\n');

// 1-3: fully-optional report channels accept a no-arg (undefined) call.
ok('salesSummary accepts no payload', !throws(() => guardChannel('manager:salesSummary', undefined)));
ok('topProducts accepts no payload',  !throws(() => guardChannel('manager:topProducts', undefined)));
ok('recentOrders accepts no payload', !throws(() => guardChannel('manager:recentOrders', undefined)));

// 4: an array is still not a valid bag.
ok('salesSummary rejects an array payload', throws(() => guardChannel('manager:salesSummary', [1, 2])));

// 5: a required-field channel still rejects an absent payload (not weakened).
ok('order:void still rejects a missing payload', throws(() => guardChannel('order:void', undefined)));

// 6: a valid range still passes.
ok('salesSummary accepts a valid range', !throws(() => guardChannel('manager:salesSummary', { preset: 'today' })));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
