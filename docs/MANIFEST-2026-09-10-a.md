# MANIFEST 2026-09-10-a — D1 CLOSED (last open P0)

**Base:** `origin/dev` @ `fa05e8f`. **Register only — NO code change.** Records that D1, the last
open P0, was already resolved by the A158 enrolment work and confirms it in source.

## Why (rule 5 — read the source, not the entry)
D1's register entry said both "owner login is a dead end when they own two businesses" AND
"Closed by the D4 enrolment work." The heading still said OPEN (P0). A code check settled it:
the dead-end cannot occur anymore.

## Evidence
- **Server** — `apps/server/src/routes/auth.ts:709`: `POST /api/auth/desktop-login` is **RETIRED
  (A158)** and returns **410 Gone**, tombstoned deliberately so an un-updated old build gets a
  clear error. The `409 MULTIPLE_BUSINESSES` (auth.ts:594) is now only on the web `/login` path,
  never the till.
- **Desktop** — `apps/desktop/src/renderer/pages/InstallPage.tsx`: activation uses
  `/enrol/redeem` — a one-time enrolment code that provisions the till for a specific business.
  No owner email/password, no business picker needed, so "owner owns two businesses" never
  arises on the till.
- **Renderer sweep** — the only password inputs are the 6-digit PIN (`LockCurtain`, `PinPage`);
  `PinPage.onBackToOwner` → `App.handleSignOut` returns to the ENROLMENT flow (`App.tsx`:
  "enrolment code — never the owner's email/password"), not a credential login.

No code path can produce the 409 dead-end → D1 is resolved. This clears the **last open P0**.

## Register changes
| Change | Detail |
|---|---|
| D1 | OPEN (P0) → **CLOSED 2026-09-10** with the source evidence above |
| Counts | D-P0 `D1` → `—`; summary `1 P0` → `0 P0` |
| Changelog | 2026-09-10 (a) line |

## Files
| File | Change |
|---|---|
| `docs/AUDIT-REGISTER.md` | D1 CLOSED + counts + changelog |
| `docs/MANIFEST-2026-09-10-a.md` | this record |

## What ran (rule 7)
```
check-register-consistency   OK — header agrees with body (D-P0 now 0)
check-doc-refs               OK — every cited document present
```
No code changed, so no tests/build needed. The closure rests on the source evidence above; if
you want belt-and-suspenders, on a till confirm that de-enrolling ("back to owner") lands on the
enrolment screen, not an email/password login — but the code leaves no other path.

## Open P0s remaining: NONE.
Remaining desktop opens: D9/D10 (P3), D18 (P2), and the offline/sync cluster (needs two tills).

## Apply
```
git pull origin dev
# extract this zip over the repo root, then:
node scripts/check-register-consistency.mjs && node scripts/check-doc-refs.mjs
git add docs/AUDIT-REGISTER.md docs/MANIFEST-2026-09-10-a.md
git commit -m "D1 CLOSED (last P0): dead-end already resolved by A158 enrolment; verified in source"
git push origin dev
```
Rollback: revert this commit — register only.
