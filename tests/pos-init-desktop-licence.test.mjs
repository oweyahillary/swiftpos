/**
 * pos-init-desktop-licence.test.mjs — proves /api/pos/init gates the desktop
 * licence on the branch the till is BOUND to, not the main branch (register D11).
 *
 *   node pos-init-desktop-licence.test.mjs
 *
 * No server, no DB. Two halves:
 *
 *   1. TRUTH TABLE — the licence decision is a pure function of (surface,
 *      boundBranch, mainBranch). It is copied here and kept in sync by hand, the
 *      same way discount-clamp.test.mjs copies the clamp. The decision is small;
 *      what matters is the truth table, which encodes exactly the bug: a till at
 *      a licensed branch B must be allowed even when the main branch A is
 *      unlicensed, and blocked when B itself is unlicensed even if A is fine.
 *
 *   2. SOURCE GUARD — the truth table is only meaningful if the route actually
 *      uses this decision. So the second half reads apps/server/src/routes/pos.ts
 *      and asserts the shape of the fix is still there: the licence gate keys off
 *      the resolved operating branch, a bound branch is fetched from the caller's
 *      branch_id carrying desktop_licensed, and the main branch is maybeSingle
 *      (the .single() that failed the whole pull closed on zero main branches is
 *      gone). If someone reverts to gating on the main branch, this half fails.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let pass = 0, fail = 0;
function ok(label, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}  ${detail}`); }
}

// ── copies of the route's licence decision (kept in sync by hand) ───────────
// pos.ts: const opBranch = boundBranch ?? mainBranch;
const resolveOperatingBranch = (boundBranch, mainBranch) => boundBranch ?? mainBranch;
// pos.ts: if (req.surface === 'desktop' && !opBranch?.desktop_licensed) -> 403
const isDesktopBlocked = (surface, opBranch) =>
  surface === 'desktop' && !opBranch?.desktop_licensed;

const A_unlicensed = { id: 'A', desktop_licensed: false }; // main
const A_licensed   = { id: 'A', desktop_licensed: true };
const B_licensed   = { id: 'B', desktop_licensed: true };  // bound
const B_unlicensed = { id: 'B', desktop_licensed: false };

// ── 1. Truth table ─────────────────────────────────────────────────────────
// The bug itself: a licensed bound branch under an unlicensed main branch.
ok('bound B licensed, main A unlicensed, desktop -> ALLOWED (the D11 fix)',
   isDesktopBlocked('desktop', resolveOperatingBranch(B_licensed, A_unlicensed)) === false);
// The mirror: an unlicensed bound branch must NOT ride the main branch's licence.
ok('bound B unlicensed, main A licensed, desktop -> BLOCKED',
   isDesktopBlocked('desktop', resolveOperatingBranch(B_unlicensed, A_licensed)) === true);
// Legacy caller with no branch_id falls back to the main branch.
ok('no bound branch, main licensed, desktop -> ALLOWED (fallback)',
   isDesktopBlocked('desktop', resolveOperatingBranch(null, A_licensed)) === false);
ok('no bound branch, main unlicensed, desktop -> BLOCKED',
   isDesktopBlocked('desktop', resolveOperatingBranch(null, A_unlicensed)) === true);
// Zero main branches (one_main_branch_per_business permits it): fail closed for
// desktop, but as a clean 403 rather than the old 500 that killed the pull.
ok('no branch resolvable at all, desktop -> BLOCKED (fail closed, not 500)',
   isDesktopBlocked('desktop', resolveOperatingBranch(null, null)) === true);
// Web is gated by web-access at login, never by the per-branch desktop licence.
ok('web surface, no branch -> not blocked (web is exempt here)',
   isDesktopBlocked('web', resolveOperatingBranch(null, null)) === false);
ok('web surface, unlicensed bound branch -> not blocked',
   isDesktopBlocked('web', resolveOperatingBranch(B_unlicensed, A_licensed)) === false);
// The bound branch wins over the main branch whenever it resolves.
ok('operating branch is the bound branch when present',
   resolveOperatingBranch(B_licensed, A_licensed).id === 'B');
ok('operating branch is the main branch when unbound',
   resolveOperatingBranch(null, A_licensed).id === 'A');

// ── 2. Source guard — the route still uses this decision ────────────────────
const src = fs.readFileSync(path.join(ROOT, 'apps/server/src/routes/pos.ts'), 'utf8');

ok('licence gate resolves the operating branch (bound ?? main)',
   /const\s+opBranch\s*=\s*boundBranch\s*\?\?\s*mainBranch/.test(src));
ok('licence gate keys off the operating branch, not the main branch',
   /req\.surface\s*===\s*'desktop'\s*&&\s*!opBranch\?\.desktop_licensed/.test(src));
ok('a bound branch is resolved from the caller\'s branch_id',
   /\.eq\('id',\s*requestedBranchId\)/.test(src));
ok('the bound-branch lookup carries desktop_licensed',
   /\.eq\('id',\s*requestedBranchId\)[\s\S]{0,200}desktop_licensed|desktop_licensed[\s\S]{0,200}\.eq\('id',\s*requestedBranchId\)/.test(src)
   || /select\('id, desktop_licensed'\)[\s\S]{0,120}\.eq\('id',\s*requestedBranchId\)/.test(src));
ok('the main-branch lookup is maybeSingle, not single (no fail-closed on zero rows)',
   /is_main['"],\s*true\)\s*\.maybeSingle\(\)/.test(src) &&
   !/is_main['"],\s*true\)\s*\.single\(\)/.test(src));

console.log(`\n${fail === 0
  ? `All ${pass} checks passed. The desktop licence gates on the bound branch.`
  : `${fail} FAILED (${pass} passed)`}`);
process.exit(fail === 0 ? 0 : 1);
