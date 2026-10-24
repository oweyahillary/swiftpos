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

test('the kitchen ticket prints the extra and the notes under the dish (A559)', () => {
  const lines = fresh.extras80.lines.map((l) => l.t);
  const burger = lines.findIndex((t) => /CHICKEN BURGER/.test(t));
  assert.ok(burger >= 0);
  assert.match(lines[burger + 1], /\+ Extra Cheese/);
  assert.match(lines[burger + 2], /\*\* No onions/);
  assert.ok(lines.some((t) => /\*\* Well done/.test(t)));
});

test('the shift close shows the KES 350 short', () => {
  const v = fresh.close80.lines.find((l) => /Variance/.test(l.t));
  assert.match(v.t, /short.*-350\.00/);
});

test('every slip is made-up demo data', () => {
  const all = JSON.stringify(fresh);
  assert.ok(all.includes('Mama Lishe Grill') && all.includes('Kijani Basket') && all.includes('Kifaru Fuel & Mart'));
  assert.ok(!/Tel: /.test(all), 'no phone number on a demo receipt');
  assert.ok(!/P0\d{8}[A-Z]/.test(all), 'no KRA PIN printed');
});

test('each demo receipt prints its brand logo above the name, and a shop prints no Kots line (A310, A580)', () => {
  for (const [k, id] of [['sale80', 'mama-lishe-grill'], ['shop80', 'kijani-basket'], ['fuel80', 'kifaru-fuel'], ['cafe58', 'mvua-cafe']]) {
    assert.equal(fresh[k].lines[0].logo, id, k);
  }
  assert.ok(!fresh.shop80.lines.some((l) => /^Kots:/.test(l.t)));
  assert.ok(fresh.sale80.lines.some((l) => /^Kots:/.test(l.t)));
});

test('the weighed beef prints as a measure (A577)', () => {
  assert.ok(fresh.shop80.lines.some((l) => /0\.640 kg @ 650\/kg/.test(l.t)));
});
