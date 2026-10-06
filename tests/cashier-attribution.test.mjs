/**
 * cashier-attribution.test.mjs — A169, A415.
 *
 * Who a sale is credited to. Runs the REAL exported decision the order route uses
 * (apps/server/src/lib/cashier.ts), not a model of it (rule 24). The DB
 * validation that produces `claimValid` lives in the route and mirrors verify-pin
 * (active user in this business with access to this branch) — that part is
 * integration/target-verified; here we prove the decision around it.
 *
 * A415: the till's own session names no person (subject null). A sale it pushes is credited to the cashier it names
 * when the roster validates the claim — and to NOBODY otherwise: never the owner.
 *
 * MUTATIONS TO CONFIRM BITE: the route passing mayClaim from isOwner alone → "the till's own session may name the
 * cashier" pin fails; pickCashier crediting an invalid claim → the load-bearing guard fails.
 */
import fs from 'node:fs';
import { pickCashier, claimNeedsValidation } from '../apps/server/src/lib/cashier.ts';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`); } };

const OWNER = 'user-owner';
const CASHIER = 'user-cashier';

// ── A person's PIN token (online): the subject IS the cashier, authoritative, never overridden ──
ok('a person\'s PIN token ignores any claim',
  pickCashier({ mayClaim: false, subject: CASHIER, claimed: 'user-someone-else', claimValid: true }) === CASHIER);

// ── The till's own session (A415): no person; the till names the cashier ──
ok('till session + valid claim → that cashier',
  pickCashier({ mayClaim: true, subject: null, claimed: CASHIER, claimValid: true }) === CASHIER);
ok('till session + invalid claim → nobody (never the owner)',
  pickCashier({ mayClaim: true, subject: null, claimed: CASHIER, claimValid: false }) === null);
ok('till session + no claim → nobody',
  pickCashier({ mayClaim: true, subject: null, claimed: null, claimValid: false }) === null);

// ── An owner's own web session may name a cashier the same way ──
ok('owner session + valid claim → that cashier',
  pickCashier({ mayClaim: true, subject: OWNER, claimed: CASHIER, claimValid: true }) === CASHIER);
ok('owner session + claim == subject → the owner (they rang it)',
  pickCashier({ mayClaim: true, subject: OWNER, claimed: OWNER, claimValid: false }) === OWNER);

// ── claimNeedsValidation (avoids needless DB reads) ──
ok('till session with a claim → validate',
  claimNeedsValidation({ mayClaim: true, subject: null, claimed: CASHIER }) === true);
ok('a person\'s PIN token → never validate',
  claimNeedsValidation({ mayClaim: false, subject: CASHIER, claimed: 'x' }) === false);
ok('no claim → no read', claimNeedsValidation({ mayClaim: true, subject: null, claimed: null }) === false);

// The load-bearing guard: an INVALID claim must NEVER be credited.
ok('GUARD: an invalid claim is never credited',
  pickCashier({ mayClaim: true, subject: null, claimed: CASHIER, claimValid: false }) !== CASHIER);

// ── The route ──
const R = fs.readFileSync(new URL('../apps/server/src/routes/orders.ts', import.meta.url), 'utf8');
ok('the till\'s own session (or an owner\'s) may name the cashier; a person\'s token may not',
  /const mayClaim = !!req\.isTill \|\| !!req\.isOwner;/.test(R)
  && /claimNeedsValidation\(\{ mayClaim, subject: req\.userId \?\? null, claimed: claimedCashier \}\)/.test(R)
  && /mayClaim, subject: req\.userId \?\? null, claimed: claimedCashier, claimValid,/.test(R));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
