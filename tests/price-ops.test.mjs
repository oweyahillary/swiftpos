/**
 * price-ops.test.mjs — A166, bulk price editing.
 *
 * The money math behind "all sodas +20 / +10% / round to nearest 10". A wrong
 * percent or a missing negative-guard mis-prices a whole menu, so the percent
 * calc, the round step, and the negative guard are mutation-checked.
 *
 * Imports the real built server dist (no DB). Skips if the server isn't built.
 *   node tests/price-ops.test.mjs
 */
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

let pass = 0, fail = 0;
const ok = (l, c) => { if (c) { pass++; console.log(`PASS  ${l}`); } else { fail++; console.log(`FAIL  ${l}`); } };

const dist = path.resolve('apps/server/dist/lib/priceOps.js');
if (!existsSync(dist)) { console.log('SKIP  build the server first'); process.exit(0); }
const { applyPriceOp, parsePriceOp } = await import(pathToFileURL(dist).href);
const nx = (cur, op) => { const r = applyPriceOp(cur, op); return 'next' in r ? r.next : `ERR:${r.error}`; };

// ── set ──
ok('set: 350 → 300', nx(350, { type: 'set', value: 300 }) === 300);
ok('set: 0 allowed (free item)', nx(120, { type: 'set', value: 0 }) === 0);
ok('set: negative → error', typeof nx(120, { type: 'set', value: -5 }) === 'string');

// ── plus / minus ──
ok('plus: 100 +20 → 120', nx(100, { type: 'plus', value: 20 }) === 120);
ok('minus: 100 -20 → 80', nx(100, { type: 'plus', value: -20 }) === 80);
ok('minus below zero → error (not silently 0)', typeof nx(10, { type: 'plus', value: -50 }) === 'string');

// ── percent (the calc that must be exact) ──
ok('percent: 100 +10% → 110', nx(100, { type: 'percent', value: 10 }) === 110);
ok('percent: 230 +10% → 253', nx(230, { type: 'percent', value: 10 }) === 253);
ok('percent: 100 -15% → 85 (discount)', nx(100, { type: 'percent', value: -15 }) === 85);
ok('percent: rounds to 2dp (33.33 +10% → 36.66)', nx(33.33, { type: 'percent', value: 10 }) === 36.66);
ok('percent: -100% → 0', nx(100, { type: 'percent', value: -100 }) === 0);
ok('percent: discount > 100% → error', typeof nx(100, { type: 'percent', value: -150 }) === 'string');

// ── round to nearest step ──
ok('round: 253 to nearest 10 → 250', nx(253, { type: 'round', value: 10 }) === 250);
ok('round: 256 to nearest 10 → 260', nx(256, { type: 'round', value: 10 }) === 260);
ok('round: 112 to nearest 5 → 110', nx(112, { type: 'round', value: 5 }) === 110);
ok('round: step 0 → error', typeof nx(100, { type: 'round', value: 0 }) === 'string');

// ── guards ──
ok('invalid current → error', typeof nx(-1, { type: 'plus', value: 10 }) === 'string');
ok('non-finite value → error', typeof nx(100, { type: 'plus', value: NaN }) === 'string');

// ── parsePriceOp ──
ok('parse: valid', (() => { const p = parsePriceOp({ type: 'percent', value: '10' }); return 'type' in p && p.type === 'percent' && p.value === 10; })());
ok('parse: bad type → error', 'error' in parsePriceOp({ type: 'multiply', value: 2 }));
ok('parse: non-numeric value → error', 'error' in parsePriceOp({ type: 'set', value: 'abc' }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
