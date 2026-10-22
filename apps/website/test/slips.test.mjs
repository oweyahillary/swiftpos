// The slips on the site are what the printer prints: src/lib/slips.generated.json must match a fresh render through
// shared/printing (scripts/render-slips.mjs). If shared/printing changes the paper, re-run the script and commit both.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderSlips, SLIPS_FILE } from '../scripts/render-slips.mjs';

const saved = JSON.parse(readFileSync(SLIPS_FILE, 'utf8'));
const fresh = renderSlips();

test('the saved slips match the print renderer, line for line', () => {
  assert.deepEqual(saved, JSON.parse(JSON.stringify(fresh)));
});

test('the receipt prints each variant on the item\'s own line (A551)', () => {
  const lines = fresh.sale80.lines.map((l) => l.t);
  assert.ok(lines.some((t) => t.startsWith('Chips Masala - Spicy')), 'Chips Masala - Spicy on one line');
  assert.ok(lines.some((t) => t.startsWith('Chicken Burger - Spicy')), 'the repeated name is folded (Chicken Burger - Spicy)');
  assert.ok(!lines.some((t) => /^\s+Spicy/.test(t)), 'no second row for the variant');
});

test('the receipt carries the large BUY GOODS block (A551/A557)', () => {
  const big = fresh.sale80.lines.filter((l) => l.s === 'tall').map((l) => l.t.trim());
  assert.ok(big.includes('BUY GOODS:'));
  assert.ok(big.includes('123456'));
});

test('the kitchen ticket is food only, with the variant on the line', () => {
  const lines = fresh.kitchen80.lines.map((l) => l.t);
  assert.ok(lines.some((t) => /CHIPS MASALA - SPICY/.test(t)));
  assert.ok(!lines.some((t) => /PASSION JUICE/.test(t)), 'drinks go to dispatch, not the kitchen');
  assert.ok(fresh.dispatch80.lines.some((l) => /PASSION JUICE/.test(l.t)));
});

test('the shift close shows the KES 350 short', () => {
  const v = fresh.close80.lines.find((l) => /Variance/.test(l.t));
  assert.match(v.t, /short.*-350\.00/);
});

test('every slip is made-up demo data', () => {
  const all = JSON.stringify(fresh);
  assert.ok(all.includes('Mama Lishe Grill') && all.includes('Demo Mini Mart'));
  assert.ok(!/P0\d{8}[A-Z]/.test(all), 'no KRA PIN printed');
});
