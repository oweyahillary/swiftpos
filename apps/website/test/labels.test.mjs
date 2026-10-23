// The labels on the site are what ZapTill prints: src/lib/labels.generated.json must match a fresh render through
// shared/labels.ts and shared/barcode.ts (scripts/render-labels.mjs). If the label code changes, run `npm run labels`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderLabels, LABELS_FILE } from '../scripts/render-labels.mjs';

const saved = JSON.parse(readFileSync(LABELS_FILE, 'utf8'));
const fresh = renderLabels();

test('the saved labels match the label code, mark for mark', () => {
  assert.deepEqual(saved, JSON.parse(JSON.stringify(fresh)));
});

test('every label carries a barcode (A574) and its in-store EAN-13 code is valid', () => {
  for (const r of fresh.rolls) {
    assert.match(r.svg, /shape-rendering="crispEdges"><rect /, `${r.name} has bars`);
    assert.match(r.code, /^20\d{11}$/, 'an in-store code starts with 20');
    const digits = r.code.split('').map(Number);
    const sum = digits.slice(0, 12).reduce((a, d, i) => a + d * (i % 2 ? 3 : 1), 0);
    assert.equal((10 - (sum % 10)) % 10, digits[12], `${r.code} check digit`);
  }
  for (const svg of fresh.sheet.svgs) assert.match(svg, /crispEdges"><rect /);
});

test('the labels are made-up demo data', () => {
  const all = JSON.stringify(fresh);
  assert.ok(all.includes('Cooking Oil 1L'));
  assert.ok(fresh.rolls.some((r) => r.svg.includes('Demo Mini Mart')), 'the 58 x 40 label shows the demo shop name');
});
