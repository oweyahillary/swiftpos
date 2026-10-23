// Checks the leak calculator's maths (src/lib/leak.ts). Run: npm test (Node 22.18+ strips the types).
import test from 'node:test';
import assert from 'node:assert/strict';
import { leak, clean, LEAK_DEFAULTS, DAYS_PER_MONTH } from '../src/lib/leak.ts';

test('defaults: 2 cashiers short 200 a day, 1% wastage on 40,000 a day', () => {
  const r = leak(LEAK_DEFAULTS, 3000);
  assert.equal(DAYS_PER_MONTH, 30);
  assert.equal(r.cashLeak, 12000);   // 2 x 200 x 30
  assert.equal(r.wastage, 12000);    // 40,000 x 1% x 30
  assert.equal(r.monthlyLeak, 24000);
  assert.equal(r.timesPrice, 8);     // 24,000 / 3,000
  assert.equal(r.difference, 21000);
});

test('the WORKPLAN example: one cashier short 200 a day is 6,000 a month', () => {
  const r = leak({ dailySales: 0, cashiers: 1, shortagePerCashier: 200, wastagePct: 0 }, 3000);
  assert.equal(r.monthlyLeak, 6000);
  assert.equal(r.timesPrice, 2);
});

test('a leak smaller than the price gives a negative difference', () => {
  const r = leak({ dailySales: 10000, cashiers: 1, shortagePerCashier: 50, wastagePct: 0 }, 3000);
  assert.equal(r.monthlyLeak, 1500);
  assert.equal(r.difference, -1500);
  assert.equal(r.timesPrice, 0.5);
});

test('bad input is treated as zero, never as a negative leak', () => {
  const r = leak({ dailySales: -5, cashiers: NaN, shortagePerCashier: 'abc', wastagePct: '' }, 3000);
  assert.equal(r.monthlyLeak, 0);
  assert.equal(clean('12,500'), 12500);
  assert.equal(clean(' 7 '), 7);
  assert.equal(clean(250, 100), 100);
});

test('fractional cashiers round down; wastage is capped at 100%', () => {
  const r = leak({ dailySales: 1000, cashiers: 2.9, shortagePerCashier: 100, wastagePct: 400 }, 3000);
  assert.equal(r.cashLeak, 6000);   // 2 x 100 x 30
  assert.equal(r.wastage, 30000);   // 1,000 x 100% x 30
});

test('a zero price does not divide by zero', () => {
  assert.equal(leak(LEAK_DEFAULTS, 0).timesPrice, 0);
});
