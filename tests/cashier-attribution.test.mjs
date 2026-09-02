/**
 * cashier-attribution.test.mjs — A169.
 *
 * Who a sale is credited to. Runs the REAL exported decision the order route uses
 * (apps/server/src/lib/cashier.ts), not a model of it (rule 24). The DB
 * validation that produces `claimValid` lives in the route and mirrors verify-pin
 * (active user in this business with access to this branch) — that part is
 * integration/target-verified; here we prove the decision around it.
 */
import { pickCashier, claimNeedsValidation } from '../apps/server/src/lib/cashier.ts';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`); } };

const OWNER = 'user-owner';
const CASHIER = 'user-cashier';

// ── pickCashier ─────────────────────────────────────────────────────────────
// Staff-PIN token (online): the subject IS the cashier, authoritative, never overridden.
ok('staff token → subject, even if a claim is present',
  pickCashier({ isOwner: false, subject: CASHIER, claimed: 'user-someone-else', claimValid: true }) === CASHIER);

// Owner token + valid claim (offline): credit the real cashier.
ok('owner token + valid claim → cashier',
  pickCashier({ isOwner: true, subject: OWNER, claimed: CASHIER, claimValid: true }) === CASHIER);

// Owner token + INVALID claim: fall back to the owner (never credit an unvalidated id).
ok('owner token + invalid claim → owner (fallback)',
  pickCashier({ isOwner: true, subject: OWNER, claimed: CASHIER, claimValid: false }) === OWNER);

// Owner token, no claim (owner rang it directly): owner.
ok('owner token + no claim → owner',
  pickCashier({ isOwner: true, subject: OWNER, claimed: null, claimValid: false }) === OWNER);

// Owner token, claim echoes the subject: owner (no spurious override).
ok('owner token + claim == subject → subject',
  pickCashier({ isOwner: true, subject: OWNER, claimed: OWNER, claimValid: false }) === OWNER);

// ── claimNeedsValidation (avoids needless DB reads) ─────────────────────────
ok('validate only when owner + real, differing claim',
  claimNeedsValidation({ isOwner: true, subject: OWNER, claimed: CASHIER }) === true);
ok('no DB read for a staff token',
  claimNeedsValidation({ isOwner: false, subject: CASHIER, claimed: 'x' }) === false);
ok('no DB read when claim echoes subject',
  claimNeedsValidation({ isOwner: true, subject: OWNER, claimed: OWNER }) === false);
ok('no DB read when no claim',
  claimNeedsValidation({ isOwner: true, subject: OWNER, claimed: null }) === false);

// ── MUTATION (rules 10, 23) ─────────────────────────────────────────────────
// The load-bearing guard: an INVALID claim must NEVER be credited. If pickCashier
// ever returned `claimed` regardless of claimValid, this flips.
ok('mutation guard: invalid claim is never credited',
  pickCashier({ isOwner: true, subject: OWNER, claimed: CASHIER, claimValid: false }) !== CASHIER);
// And a staff order must never be reattributable by a payload claim.
ok('mutation guard: staff subject is never overridden',
  pickCashier({ isOwner: false, subject: CASHIER, claimed: OWNER, claimValid: true }) !== OWNER);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
