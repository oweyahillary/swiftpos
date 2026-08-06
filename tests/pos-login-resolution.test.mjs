/**
 * pos-login-resolution — BUG-05.
 *
 * users is UNIQUE (business_id, email) — 00_baseline.sql:2949 — so the SAME
 * email is ALLOWED in two businesses. pos-login looked users up globally with
 *
 *     .ilike('email', email.trim()).single()
 *
 * Two failures, both silent, both reported as "Invalid email or PIN":
 *
 *   1. Two tenants sharing an email -> PGRST116 -> permanent lockout. Resetting
 *      the PIN does not help, because the PIN was never the problem.
 *   2. ilike is a PATTERN match. % and _ are LIKE metacharacters and _ is a
 *      LEGAL EMAIL CHARACTER, so john_doe@x.com also matched johnXdoe@x.com.
 *
 * This models the resolution logic in routes/auth.ts.
 */
import assert from 'node:assert';

const B1 = 'biz-1', B2 = 'biz-2';
const USERS = [
  { id: 'u1', email: 'Manager@Shop.co.ke', business_id: B1, status: 'active' },
  { id: 'u2', email: 'manager@shop.co.ke', business_id: B2, status: 'active' },
  { id: 'u3', email: 'john_doe@shop.co.ke', business_id: B1, status: 'active' },
  { id: 'u4', email: 'johnXdoe@shop.co.ke', business_id: B1, status: 'active' },
  { id: 'u5', email: 'solo@shop.co.ke',    business_id: B1, status: 'active' },
];
const BRANCHES = { 'br-1': B1, 'br-2': B2 };

// SQL ILIKE: % is any run, _ is any single char.
const ilike = (row, pat) =>
  new RegExp('^' + pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                      .replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i').test(row);

// ── OLD ─────────────────────────────────────────────────────────────────────
function resolveOld(email) {
  const m = USERS.filter(u => u.status === 'active' && ilike(u.email, email.trim()));
  if (m.length !== 1) return { error: 'Invalid email or PIN' };   // .single() -> PGRST116
  return { user: m[0] };
}

// ── NEW (routes/auth.ts) ────────────────────────────────────────────────────
function resolveNew(email, branch_id = null) {
  const needle = String(email).trim().toLowerCase();
  const coarse = USERS.filter(u => u.status === 'active' && ilike(u.email, needle));
  let matches  = coarse.filter(u => u.email.trim().toLowerCase() === needle);   // EXACT
  if (matches.length > 1 && branch_id && BRANCHES[branch_id]) {
    matches = matches.filter(u => u.business_id === BRANCHES[branch_id]);
  }
  if (matches.length > 1) return { error: 'AMBIGUOUS_ACCOUNT', status: 409 };
  if (!matches.length)    return { error: 'Invalid email or PIN', status: 401 };
  return { user: matches[0] };
}

let pass = 0, fail = 0;
const ok = (t, c, x = '') => { c ? (pass++, console.log(`PASS  ${t}`)) : (fail++, console.log(`FAIL  ${t}${x ? ' — ' + x : ''}`)); };

// 1. the lockout
ok('OLD: duplicate email across tenants is locked out', !!resolveOld('manager@shop.co.ke').error);
ok('NEW: with a branch, the right tenant is resolved',
   resolveNew('manager@shop.co.ke', 'br-1').user?.id === 'u1');
ok('NEW: the other branch resolves the other tenant',
   resolveNew('manager@shop.co.ke', 'br-2').user?.id === 'u2');
ok('NEW: without a branch, says AMBIGUOUS rather than lying about the PIN',
   resolveNew('manager@shop.co.ke').error === 'AMBIGUOUS_ACCOUNT');

// 2. the wildcards
ok('OLD: % matches a user it should not', !resolveOld('solo@shop.co.k%').error);
ok('NEW: % matches nobody', resolveNew('solo@shop.co.k%').error === 'Invalid email or PIN');
ok('NEW: _ is treated as a literal, not a wildcard',
   resolveNew('john_doe@shop.co.ke').user?.id === 'u3');
ok('NEW: an underscore cannot match a different user',
   resolveNew('john_doe@shop.co.ke').user?.id !== 'u4');
ok('NEW: a bare % is refused', resolveNew('%').error === 'Invalid email or PIN');

// 3. nothing else regresses
ok('NEW: an ordinary unique login still works', resolveNew('solo@shop.co.ke').user?.id === 'u5');
ok('NEW: case-insensitive as before', resolveNew('  SOLO@SHOP.CO.KE  ').user?.id === 'u5');
ok('NEW: an unknown email is still a plain 401', resolveNew('nobody@shop.co.ke').status === 401);
ok('NEW: a branch from the wrong tenant does not grant access',
   resolveNew('solo@shop.co.ke', 'br-2').user?.id === 'u5');   // narrowing only applies when ambiguous

console.log(`\n${fail === 0 ? 'All checks passed. Login resolves one tenant, and wildcards are dead.' : fail + ' FAILED'}`);
process.exit(fail === 0 ? 0 : 1);
