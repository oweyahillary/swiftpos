# MANIFEST 2026-08-31-h — E2E-in-CI plan + register reconciliation (CI reality)

**Base commit:** `189bfc2` (dev). **Docs only, no code.** Cumulative register file.

## Context
Investigating "set up CI" found CI already exists and is comprehensive
(`.github/workflows/ci.yml`: typecheck ratchet for server/dashboard/admin, builds for
all three, secret scan, schema-drift, server suites + migrations against real Postgres,
full desktop suite). The E2E/integration layer (`e2e/` Playwright + `tests/suites/`)
also already exists — it just runs nowhere. So this delivery captures the real remaining
work and reconciles the register to the CI reality, rather than duplicating CI.

## Changes
| Item | Change |
|---|---|
| `docs/E2E-CI-PLAN.md` | **NEW.** Plan to run the existing E2E/integration suites in CI; the Supabase-local-stack (Option A, no secrets) vs cloud-test-project (Option B) decision; staged build (business+owner seed first). |
| A189 (new, P2) | E2E/integration suites exist but run nowhere — no CI-reachable env. Points at the plan. |
| A186 (P2 → **P3**) | Mitigated: CI runs the migration suite green on Ubuntu, so it's the authoritative signal; the Windows crash is now local-only cosmetic. |
| A149 (**CLOSED**) | CI already type-checks (ratchet) + builds admin; the "no CI" finding is resolved. |
| Header Open + Counts | Re-derived to match. |
| `docs/MANIFEST-2026-08-31-h.md` | This file. |

## Verification (rule 7)
```
node scripts/check-register-consistency.mjs → OK, header agrees with body
node scripts/check-doc-refs.mjs             → OK
```
The CI facts above were read directly from `.github/workflows/ci.yml` (lines: admin
typecheck-ratchet + build; `server-suites` migrations against Postgres). No code changed.

## Rollback
Before commit: `git restore docs/AUDIT-REGISTER.md && rm docs/E2E-CI-PLAN.md docs/MANIFEST-2026-08-31-h.md`
After push: `git revert <sha> && git push origin dev`.
