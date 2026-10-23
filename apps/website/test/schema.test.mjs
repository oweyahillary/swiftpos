// The structured data (src/lib/schema.ts) stays inside the claims check: no ratings or reviews, the real phone number,
// FAQ answers as plain text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { organization, softwareApplication, faqPage } from '../src/lib/schema.ts';
import { PRICING_FAQ, RESTAURANT_FAQ } from '../src/lib/faq.ts';

test('Organization carries the phone number', () => {
  const o = organization();
  assert.equal(o['@type'], 'Organization');
  assert.equal(o.telephone, '+254717675635');
});

test('SoftwareApplication has no ratings, reviews or draft prices', () => {
  const s = JSON.stringify(softwareApplication('x'));
  assert.ok(!/aggregateRating|review|offers/i.test(s));
});

test('FAQPage answers are plain text, one per question', () => {
  for (const items of [PRICING_FAQ, RESTAURANT_FAQ]) {
    const f = faqPage(items);
    assert.equal(f.mainEntity.length, items.length);
    for (const q of f.mainEntity) assert.ok(!/[<>]/.test(q.acceptedAnswer.text), q.name);
  }
});
