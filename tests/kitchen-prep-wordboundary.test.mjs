/**
 * kitchen-prep-wordboundary.test.mjs — proves the kitchen prep-line filter drops
 * the built-in drinks/sauces terms AND the owner's own terms, matching on WORD
 * BOUNDARIES so a term never clips an unrelated word (register A84).
 *
 *   node tests/kitchen-prep-wordboundary.test.mjs
 *
 * No Electron. Mirrors kitchenPrepLines in
 * apps/desktop/src/renderer/lib/ticketLines.ts (self-contained, in the style of
 * offline-dating / sync-stock-merge). The property under test is the one the
 * owner worried about: the OLD substring match made "ice" clip "rice"/"spice"
 * and "water" clip "watermelon"; word boundaries fix that.
 */

import assert from 'node:assert';

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}  ${detail}`); }
};

// ── mirror of ticketLines.ts ──────────────────────────────────────────────────
const KITCHEN_NOTE_EXCLUDE =
  /\b(sauces?|dips?|soft\s*drinks?|sodas?|drinks?|juices?|water|coke|fanta|sprite|krest|stoney|minute\s*maid)\b/i;
const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function kitchenPrepLines(noteLines, extraTerms) {
  const extras = String(extraTerms ?? '')
    .split(/\r?\n/).map(t => t.trim()).filter(Boolean)
    .map(t => new RegExp(`\\b${escapeRegex(t)}\\b`, 'i'));
  return (noteLines ?? []).filter(l =>
    !KITCHEN_NOTE_EXCLUDE.test(l) && !extras.some(re => re.test(l)));
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── the MEGA 20PCS example, verbatim from the menu ────────────────────────────
{
  const desc = ['20pc chicken', '4 sauces', '2 large fries', '1L soft drink'];
  ok('MEGA 20PCS kitchen ticket drops sauces + soft drink',
     eq(kitchenPrepLines(desc, ''), ['20pc chicken', '2 large fries']),
     JSON.stringify(kitchenPrepLines(desc, '')));
}

// ── built-in rule ─────────────────────────────────────────────────────────────
ok('built-in drops "coke 500ml"',     eq(kitchenPrepLines(['coke 500ml'], ''), []));
ok('built-in drops "1L soft drink"',  eq(kitchenPrepLines(['1L soft drink'], ''), []));
ok('built-in keeps "20pc chicken"',   eq(kitchenPrepLines(['20pc chicken'], ''), ['20pc chicken']));

// ── owner terms, word-boundary (the fix) ─────────────────────────────────────
ok('owner "cole slaw" drops the side, keeps "coleslaw wrap"',
   eq(kitchenPrepLines(['cole slaw', 'coleslaw wrap'], 'cole slaw'), ['coleslaw wrap']),
   JSON.stringify(kitchenPrepLines(['cole slaw', 'coleslaw wrap'], 'cole slaw')));

ok('owner "water" drops "water 500ml", keeps "watermelon slice"',
   eq(kitchenPrepLines(['water 500ml', 'watermelon slice'], 'water'), ['watermelon slice']),
   JSON.stringify(kitchenPrepLines(['water 500ml', 'watermelon slice'], 'water')));

// The exact over-match the old substring code produced: "ice" clipped rice/spice.
ok('owner "ice" drops "ice cubes" but NOT "fried rice"/"spice mix"',
   eq(kitchenPrepLines(['ice cubes', 'fried rice', 'spice mix'], 'ice'), ['fried rice', 'spice mix']),
   JSON.stringify(kitchenPrepLines(['ice cubes', 'fried rice', 'spice mix'], 'ice')));

// ── multi-line owner list + regex-special safety ─────────────────────────────
ok('multi-term owner list applies each',
   eq(kitchenPrepLines(['popcorn', 'gravy', 'chicken'], 'popcorn\ngravy'), ['chicken']));

ok('a term with regex chars is matched literally, not as a pattern',
   eq(kitchenPrepLines(['a+b side', 'plain side'], 'a+b'), ['plain side']));

// ── empties ───────────────────────────────────────────────────────────────────
ok('no note lines → empty', eq(kitchenPrepLines(undefined, 'x'), []));
ok('blank owner terms → only built-in applies',
   eq(kitchenPrepLines(['chicken', 'soda'], '   \n  '), ['chicken']));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
