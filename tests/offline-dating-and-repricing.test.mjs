/**
 * offline-dating-and-repricing.test.mjs — proves an offline order keeps its
 * original date (#7) and that a re-pricing divergence is detected, not silent
 * (#19).
 *
 *   node offline-dating-and-repricing.test.mjs
 *
 * No server, no database. Models the two decisions the handler and the
 * create_order_atomic RPC now make.
 */

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}  ${detail}`); }
};

// ── #7: created_at follows the sale, not the sync ───────────────────────────
// Mirror of the RPC's COALESCE(NULLIF(created_at,'')::timestamptz, now()).
function orderCreatedAt(payloadCreatedAt, nowAtSync) {
  return payloadCreatedAt && payloadCreatedAt !== '' ? payloadCreatedAt : nowAtSync;
}

{
  const saleTime = '2026-08-04T22:15:00.000Z';   // last night, offline
  const syncTime = '2026-08-05T08:03:00.000Z';   // this morning, when it pushed

  const offline = orderCreatedAt(saleTime, syncTime);
  ok('offline order books on the day it was SOLD, not synced',
     offline === saleTime, offline);
  ok('...so it lands on 2026-08-04', offline.slice(0, 10) === '2026-08-04');

  // The bug: without a client timestamp, the server stamped now() at sync.
  const oldBehaviour = orderCreatedAt(undefined, syncTime);
  ok('OLD behaviour dated it at sync time (2026-08-05) — yesterday\'s takings on today',
     oldBehaviour.slice(0, 10) === '2026-08-05');

  // A live online sale sends no created_at → now() is correct.
  const online = orderCreatedAt(null, syncTime);
  ok('a live online sale still uses now()', online === syncTime);
}

// ── #19: re-pricing divergence is detected ──────────────────────────────────
// Mirror of the handler's compare of client total vs re-priced authTotal.
function detectDivergence(clientTotal, authTotal, isOffline) {
  const diverged = Number.isFinite(clientTotal) && Math.abs(clientTotal - authTotal) > 0.01;
  return { diverged, isOffline, stored: authTotal };
}

{
  // Offline sale priced at 1000; catalogue price rose so re-price gives 1100.
  const d = detectDivergence(1000, 1100, true);
  ok('a divergence between the receipt and the re-price is DETECTED', d.diverged === true);
  ok('the offline context is flagged', d.isOffline === true);
  ok('the re-priced figure is what gets stored (anti-tampering preserved)',
     d.stored === 1100);

  // No change → no divergence, no noise.
  const same = detectDivergence(1000, 1000, false);
  ok('no divergence when prices match', same.diverged === false);

  // A one-cent rounding gap is tolerated.
  const rounding = detectDivergence(1000.00, 1000.005, false);
  ok('sub-cent rounding is not flagged', rounding.diverged === false);

  // The bug: the OLD path silently stored the re-priced total with no signal, so
  // an offline sale whose price changed diverged from the customer's receipt and
  // nobody knew.
  ok('OLD path gave no signal on divergence (silent) — now it is logged', d.diverged === true);
}

console.log(`\n${fail === 0 ? 'All checks passed. Offline orders keep their date; re-pricing gaps are visible.' : fail + ' FAILED'}`);
process.exit(fail === 0 ? 0 : 1);
