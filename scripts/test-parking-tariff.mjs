/**
 * test-parking-tariff.mjs — golden vectors for the parking pricing engine.
 *
 *     npx tsx scripts/test-parking-tariff.mjs
 *
 * These vectors are the contract. Both copies of parkingTariff.ts must produce
 * these numbers exactly; scripts/check-shared-sync.mjs asserts the copies are
 * identical, and this asserts the shared implementation is right.
 *
 * Every case here is a real situation an attendant will meet at a barrier, and
 * the expected figure is one you could defend to a driver. If a change makes a
 * vector fail, the question is not "update the vector" — it is "which of these
 * two numbers would you rather explain at 23:00 to someone who wants to leave".
 */

import { priceSession, centsToAmount } from '../shared/parkingTariff.ts';

// A typical Nairobi mall tariff: 15 min grace, 100 for the first hour, 50 an
// hour after, capped at 500 a day.
const MALL = {
  grace_minutes: 15,
  first_period_minutes: 60,
  first_period_price_cents: 10_000,
  increment_minutes: 60,
  increment_price_cents: 5_000,
  daily_cap_cents: 50_000,
  flat_daily_rate_cents: null,
  lost_ticket_fee_cents: 100_000,
};

// County street parking: one flat daily charge, no hourly ladder at all.
const STREET = {
  grace_minutes: 0,
  first_period_minutes: 0,
  first_period_price_cents: 0,
  increment_minutes: 60,
  increment_price_cents: 0,
  daily_cap_cents: null,
  flat_daily_rate_cents: 20_000,
  lost_ticket_fee_cents: 20_000,
};

// Motorbikes: 30-minute granularity, cheap, low cap.
const BODA = {
  grace_minutes: 10,
  first_period_minutes: 30,
  first_period_price_cents: 2_000,
  increment_minutes: 30,
  increment_price_cents: 1_000,
  daily_cap_cents: 10_000,
  flat_daily_rate_cents: null,
  lost_ticket_fee_cents: 20_000,
};

const MIN = 60_000;
const T0 = Date.UTC(2026, 7, 1, 8, 0, 0);

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  ok ? pass++ : fail++;
  const money = (c) => `KES ${centsToAmount(c).toFixed(2)}`;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(52)} ${money(actual)}${ok ? '' : `   expected ${money(expected)}`}`);
}

const price = (tariff, minutes, opts = {}) =>
  priceSession({ tariff, started_at_ms: T0, ended_at_ms: T0 + minutes * MIN, ...opts });

console.log('\nMALL — 15 min grace, 100 first hour, 50/hr after, 500 cap');
check('5 min — dropping someone off',            price(MALL, 5).total_cents, 0);
check('15 min — exactly the grace boundary',     price(MALL, 15).total_cents, 0);
check('16 min — one minute past grace, pays full first hour', price(MALL, 16).total_cents, 10_000);
check('60 min — the whole first hour',           price(MALL, 60).total_cents, 10_000);
check('61 min — one minute into hour two',       price(MALL, 61).total_cents, 15_000);
check('120 min — two hours',                     price(MALL, 120).total_cents, 15_000);
check('185 min — three hours five minutes',      price(MALL, 185).total_cents, 25_000);
check('9 hours — ladder still under the cap',    price(MALL, 540).total_cents, 50_000);
check('12 hours — cap holds it at 500',          price(MALL, 720).total_cents, 50_000);
check('23h59 — still one day',                   price(MALL, 1_439).total_cents, 50_000);
check('24h00 — still one rolling day',           price(MALL, 1_440).total_cents, 50_000);
check('24h01 — tips into a second day',          price(MALL, 1_441).total_cents, 100_000);
check('3 days — three caps, not 72 hours',       price(MALL, 4_320).total_cents, 150_000);
check('lost ticket beats elapsed time',          price(MALL, 45, { lost_ticket: true }).total_cents, 100_000);

console.log('\nSTREET — flat 200/day, no grace');
check('1 min — a flat rate charges from minute one', price(STREET, 1).total_cents, 20_000);
check('8 hours',                                 price(STREET, 480).total_cents, 20_000);
check('24h00',                                   price(STREET, 1_440).total_cents, 20_000);
check('24h01 — second day',                      price(STREET, 1_441).total_cents, 40_000);

console.log('\nBODA — 30 min granularity');
check('10 min — inside grace',                   price(BODA, 10).total_cents, 0);
check('30 min — first block',                    price(BODA, 30).total_cents, 2_000);
check('31 min — into the second block',          price(BODA, 31).total_cents, 3_000);
check('90 min',                                  price(BODA, 90).total_cents, 4_000);
check('all day — capped at 100',                 price(BODA, 720).total_cents, 10_000);

console.log('\nEdges');
check('zero elapsed',                            price(MALL, 0).total_cents, 0);
check('negative elapsed is clamped, not thrown', priceSession({ tariff: MALL, started_at_ms: T0, ended_at_ms: T0 - 5 * MIN }).total_cents, 0);
check('61 SECONDS rounds up to 2 minutes',       priceSession({ tariff: BODA, started_at_ms: T0, ended_at_ms: T0 + 61_000 }).elapsed_minutes, 2);
check('lost ticket with no fee configured',      price({ ...MALL, lost_ticket_fee_cents: null }, 45, { lost_ticket: true }).total_cents, 0);

console.log('\nProperties that must always hold');
{
  // Monotonic: staying longer can never cost less. A tariff that violates this
  // produces a queue of drivers waiting for the price to drop.
  let monotonic = true, prev = -1;
  for (let m = 0; m <= 3_000; m += 7) {
    const t = price(MALL, m).total_cents;
    if (t < prev) { monotonic = false; console.log(`      breaks at ${m} min: ${t} < ${prev}`); break; }
    prev = t;
  }
  monotonic ? pass++ : fail++;
  console.log(`  ${monotonic ? 'ok  ' : 'FAIL'} price never decreases as time increases`);

  // Integer cents throughout — no float dust reaching the drawer.
  let integral = true;
  for (let m = 1; m <= 2_000; m += 3) {
    const r = price(MALL, m);
    if (!Number.isInteger(r.total_cents)) { integral = false; break; }
    if (r.lines.reduce((s, l) => s + l.amount_cents, 0) !== r.total_cents) { integral = false; break; }
  }
  integral ? pass++ : fail++;
  console.log(`  ${integral ? 'ok  ' : 'FAIL'} totals are integer cents and lines always sum to the total`);

  // Determinism — the till and the server must agree on the same inputs.
  const a = JSON.stringify(price(MALL, 187));
  const b = JSON.stringify(price(MALL, 187));
  (a === b) ? pass++ : fail++;
  console.log(`  ${a === b ? 'ok  ' : 'FAIL'} pure — identical inputs give identical output`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
