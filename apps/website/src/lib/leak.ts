/**
 * The leak calculator's maths (Pricing page). Pure, so test/leak.test.mjs can check it.
 *
 * It is an ESTIMATE built only on the visitor's own numbers. Nothing is stored or sent.
 *
 *   cash leak a month     = cashiers x shortage per cashier per day x days
 *   wastage a month       = daily sales x wastage % / 100 x days
 *   monthly leak          = cash leak + wastage
 *   times ZapTill's price = monthly leak / ZapTill's monthly price
 *
 * Plain TypeScript with erasable syntax only, so Node can import it directly in the test.
 */

export const DAYS_PER_MONTH = 30;

export interface LeakInputs {
  dailySales: number;
  cashiers: number;
  shortagePerCashier: number;
  wastagePct: number;
}

export interface LeakResult {
  cashLeak: number;
  wastage: number;
  monthlyLeak: number;
  zaptillMonthly: number;
  /** How many times ZapTill's monthly price the leak is (0 when the price is 0). */
  timesPrice: number;
  /** The leak minus ZapTill's price; negative means ZapTill costs more than the leak. */
  difference: number;
}

/** A visitor's input as a safe, non-negative number (blank, minus or text -> 0). */
export function clean(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').replace(/[, ]/g, ''));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, max);
}

export function leak(inputs: LeakInputs, zaptillMonthly: number, days = DAYS_PER_MONTH): LeakResult {
  const dailySales = clean(inputs.dailySales);
  const cashiers = Math.floor(clean(inputs.cashiers, 500));
  const shortage = clean(inputs.shortagePerCashier);
  const wastagePct = clean(inputs.wastagePct, 100);

  const cashLeak = Math.round(cashiers * shortage * days);
  const wastage = Math.round((dailySales * wastagePct * days) / 100);
  const monthlyLeak = cashLeak + wastage;
  const price = clean(zaptillMonthly);
  const timesPrice = price > 0 ? Math.round((monthlyLeak / price) * 10) / 10 : 0;

  return { cashLeak, wastage, monthlyLeak, zaptillMonthly: price, timesPrice, difference: monthlyLeak - price };
}

/** The defaults the form opens with: a modest two-cashier restaurant. */
export const LEAK_DEFAULTS: LeakInputs = {
  dailySales: 40000,
  cashiers: 2,
  shortagePerCashier: 200,
  wastagePct: 1,
};
