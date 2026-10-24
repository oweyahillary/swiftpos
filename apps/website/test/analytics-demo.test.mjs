// The Analytics demo cards, for every trade, keep the owner's rules (2026-10-22, 2026-10-23): never a price rise, a
// warning carries no shilling figure, and each trade's cards are in that trade's own words.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CARDS_BY_TRADE, DEMO_TRADES, DEMO_FOUND_BY_TRADE } from '../src/lib/analyticsDemo.ts';

const all = Object.values(CARDS_BY_TRADE).flat();

test('no card, for any trade, suggests raising a price', () => {
  for (const c of all) {
    const text = `${c.title} ${c.body} ${c.assumes} ${c.instead ?? ''}`;
    assert.ok(!/\braise\b|price rise|charge more|increase (the|your) price|put .* price up/i.test(text), c.title);
  }
});

test('a warning has no estimate', () => {
  for (const c of all.filter((x) => x.warning)) assert.equal(c.estimate, undefined, c.title);
});

test('every trade has cards and its own found line', () => {
  for (const t of DEMO_TRADES) {
    assert.ok(CARDS_BY_TRADE[t.id].length >= 5, t.id);
    assert.ok(DEMO_FOUND_BY_TRADE[t.id].length > 20, t.id);
  }
});

test('shop and petrol cards use their trade\'s words, never a kitchen\'s', () => {
  const shop = JSON.stringify(CARDS_BY_TRADE.shop);
  const petrol = JSON.stringify(CARDS_BY_TRADE.petrol);
  for (const s of [shop, petrol]) assert.ok(!/\b(dish|menu|kitchen|table|combo)\b/i.test(s));
  assert.match(shop, /next to/);
  assert.match(petrol, /at the pumps/);
});
