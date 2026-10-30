/**
 * parkingTariff.ts — parking price calculation.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 *  SHARED FILE. Byte-identical copies live at:
 *      apps/server/src/shared/parkingTariff.ts
 *      apps/desktop/src/shared/parkingTariff.ts
 *  scripts/check-shared-sync.mjs fails CI if they diverge. Edit one, copy to the
 *  other, run the golden vectors. Do not "fix" one side in place.
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS FILE EXISTS AT ALL
 *
 * Audit H2 happened because two code paths computed the same money differently:
 * /open priced an order one way, /pay another, and VAT was overstated on every
 * discounted sale for months. Parking has the same shape with worse odds — the
 * till must price a session OFFLINE (a gate booth in a basement is the worst
 * connectivity in the business), and the server must price it again on sync.
 * Two implementations of a tariff would drift within a month.
 *
 * So there is exactly one implementation, it is pure, it has no imports, and CI
 * asserts both copies are identical.
 *
 * ── INTEGER CENTS, NOT FLOATS ───────────────────────────────────────────────
 * Every intermediate value here is integer cents. The restaurant module stores
 * money as REAL in SQLite and accumulates float error that shows up as a 0.01
 * drawer variance nobody can explain. Parking multiplies a rate by an increment
 * count, which is exactly where that compounds. Integers throughout; one
 * division at the boundary.
 *
 * ── THE TARIFF IS SNAPSHOTTED, NOT LOOKED UP ────────────────────────────────
 * `priceSession` takes a tariff object, never an id. The session row carries the
 * exact tariff it was opened under as JSONB. A manager who raises the rate at
 * 14:00 must not retroactively reprice a car that entered at 09:00 — and the
 * till must be able to close a session with no network and no tariff table.
 * Snapshotting solves both. It is also what makes a disputed bill answerable:
 * the rules that produced the number are stored beside the number.
 */

export interface ParkingTariff {
  /** Free-exit window. See GRACE below — it is a window, not a deduction. */
  grace_minutes: number;
  /** Length of the opening block, e.g. 60. Set 0 to price purely by increment. */
  first_period_minutes: number;
  /** Price of that opening block, in cents. */
  first_period_price_cents: number;
  /** Billing granularity after the first period, e.g. 30 or 60. */
  increment_minutes: number;
  /** Price per increment, in cents. */
  increment_price_cents: number;
  /** Ceiling per rolling 24h, in cents. Null = uncapped. */
  daily_cap_cents: number | null;
  /** When set, ignores everything above: price = ceil(days) * this. */
  flat_daily_rate_cents: number | null;
  /** Charged instead of elapsed time when the ticket is lost, in cents. */
  lost_ticket_fee_cents: number | null;
}

export interface PriceInput {
  tariff: ParkingTariff;
  /** Epoch ms. From the device clock when offline — see clock trust in the doc. */
  started_at_ms: number;
  ended_at_ms: number;
  /** Bill the lost-ticket fee instead of elapsed time. */
  lost_ticket?: boolean;
}

export interface PriceLine {
  /** Machine-readable so the UI and receipt can label it in any language. */
  kind: 'grace' | 'first_period' | 'increments' | 'flat_daily' | 'lost_ticket' | 'cap_adjustment';
  quantity: number;
  unit_price_cents: number;
  amount_cents: number;
  label: string;
}

export interface PriceResult {
  elapsed_minutes: number;
  /** Minutes actually charged for. Equals elapsed unless grace or a cap applied. */
  billable_minutes: number;
  total_cents: number;
  /** True when the daily cap reduced the figure. Surface this on the receipt. */
  capped: boolean;
  /** Rolling 24h periods, used by the cap. 25 hours is 2. */
  days: number;
  lines: PriceLine[];
}

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_DAY = 1_440;

/** Whole minutes, rounded up. 61 seconds is 2 minutes — parking always rounds toward the operator. */
function elapsedMinutes(fromMs: number, toMs: number): number {
  return Math.max(0, Math.ceil((toMs - fromMs) / MS_PER_MINUTE));
}

/**
 * Price a parking session.
 *
 * Pure: same inputs always give the same output, on any machine, online or off.
 * Never throws on plausible input — an invalid tariff yields a zero-priced result
 * with a reason rather than an exception, because throwing at a gate barrier at
 * 23:00 is not a recoverable situation for the attendant.
 *
 * ── GRACE IS A WINDOW, NOT A DEDUCTION ──────────────────────────────────────
 * Leave inside grace_minutes and it is free. Stay one minute past it and you pay
 * from the moment you entered — the grace is not subtracted. This is how mall
 * and street parking behaves everywhere, and the alternative produces a bill
 * that changes shape at the boundary in a way no attendant can defend to a
 * driver. It must be printed on the ticket.
 */
export function priceSession(input: PriceInput): PriceResult {
  const { tariff, started_at_ms, ended_at_ms, lost_ticket } = input;

  const elapsed = elapsedMinutes(started_at_ms, ended_at_ms);
  const days = Math.max(1, Math.ceil(elapsed / MINUTES_PER_DAY));
  const lines: PriceLine[] = [];

  const base = (over: Partial<PriceResult> = {}): PriceResult => ({
    elapsed_minutes: elapsed, billable_minutes: 0, total_cents: 0,
    capped: false, days, lines, ...over,
  });

  // Lost ticket short-circuits everything. The whole point is that the elapsed
  // time is unknown or untrusted, so no time-based figure would be honest.
  if (lost_ticket) {
    const fee = Math.max(0, Math.round(tariff.lost_ticket_fee_cents ?? 0));
    lines.push({
      kind: 'lost_ticket', quantity: 1, unit_price_cents: fee, amount_cents: fee,
      label: 'Lost ticket',
    });
    return base({ billable_minutes: elapsed, total_cents: fee });
  }

  if (elapsed <= Math.max(0, tariff.grace_minutes)) {
    lines.push({
      kind: 'grace', quantity: elapsed, unit_price_cents: 0, amount_cents: 0,
      label: `Within ${tariff.grace_minutes} min grace period`,
    });
    return base();
  }

  // Flat daily: some operators (and Nairobi County street parking) charge per
  // calendar-ish day regardless of hours. Overrides the hourly ladder entirely.
  if (tariff.flat_daily_rate_cents != null && tariff.flat_daily_rate_cents > 0) {
    const rate = Math.round(tariff.flat_daily_rate_cents);
    const total = rate * days;
    lines.push({
      kind: 'flat_daily', quantity: days, unit_price_cents: rate, amount_cents: total,
      label: days === 1 ? 'Daily rate' : `Daily rate × ${days} days`,
    });
    return base({ billable_minutes: elapsed, total_cents: total });
  }

  // ── Hourly ladder ─────────────────────────────────────────────────────────
  let total = 0;

  const firstMinutes = Math.max(0, tariff.first_period_minutes);
  const firstPrice = Math.max(0, Math.round(tariff.first_period_price_cents));
  if (firstMinutes > 0) {
    total += firstPrice;
    lines.push({
      kind: 'first_period', quantity: 1, unit_price_cents: firstPrice, amount_cents: firstPrice,
      label: `First ${firstMinutes} min`,
    });
  }

  const remaining = elapsed - firstMinutes;
  const incMinutes = Math.max(1, Math.round(tariff.increment_minutes));
  const incPrice = Math.max(0, Math.round(tariff.increment_price_cents));
  if (remaining > 0) {
    const increments = Math.ceil(remaining / incMinutes);
    const amount = increments * incPrice;
    total += amount;
    lines.push({
      kind: 'increments', quantity: increments, unit_price_cents: incPrice, amount_cents: amount,
      label: `${increments} × ${incMinutes} min`,
    });
  }

  // ── Daily cap ─────────────────────────────────────────────────────────────
  // Applied per rolling 24h from entry, not per calendar day. A car in from
  // 22:00 to 02:00 has crossed midnight but has been there four hours, and
  // charging it two days' cap for that would be indefensible at the barrier.
  let capped = false;
  if (tariff.daily_cap_cents != null && tariff.daily_cap_cents >= 0) {
    const ceiling = Math.round(tariff.daily_cap_cents) * days;
    if (total > ceiling) {
      lines.push({
        kind: 'cap_adjustment', quantity: 1,
        unit_price_cents: ceiling - total, amount_cents: ceiling - total,
        label: days === 1 ? 'Daily maximum applied' : `Daily maximum × ${days} days`,
      });
      total = ceiling;
      capped = true;
    }
  }

  return base({ billable_minutes: elapsed, total_cents: total, capped });
}

/** Cents to a 2dp major-unit number, at the boundary only. */
export function centsToAmount(cents: number): number {
  return Math.round(cents) / 100;
}

/** Major-unit to cents. Use when reading a tariff a human typed. */
export function amountToCents(amount: number): number {
  return Math.round(amount * 100);
}
