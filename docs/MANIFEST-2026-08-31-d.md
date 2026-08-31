# MANIFEST 2026-08-31-d — A187 Phase 1: owner-dashboard Orders view

**Base commit:** `189bfc2` (dev). **Cumulative** over `-b`/`-c`: this zip carries the
A186 entry and the 2026-08-31 reconciliation in `AUDIT-REGISTER.md` plus the b/c/d
manifests, so applying it over `189bfc2` (or over a HEAD that already has b/c) brings
you current either way — the register is a full-file replace (idempotent).

## Files
| File | Change |
|---|---|
| `apps/dashboard/src/pages/OrdersPage.tsx` | **NEW.** Read-only owner order history — paginated / searchable / status-filtered list via `GET /api/orders`, gated on `orders.view_all`, expandable payment detail. |
| `apps/dashboard/src/App.tsx` | Lazy-import `OrdersPage`; add `<Route path="orders">` (→ `/dashboard/orders`). |
| `apps/dashboard/src/components/DashboardLayout.tsx` | Add "Orders" nav item under Finance. |
| `docs/AUDIT-REGISTER.md` | A187 marked Phase 1 delivered; carries A186 + the -c reconciliation. |
| `docs/MANIFEST-2026-08-31-d.md` | This file. |
| `docs/MANIFEST-2026-08-31-b.md`, `docs/MANIFEST-2026-08-31-c.md` | Included for tree completeness. |

## Scope note
Phase 1 is the **view** half only. It needs **no server change** — `GET /api/orders`
already scopes owner-vs-staff via `branchScope`. **Void is deliberately not here**
(Phase 2): it is money-critical (`orders.void` + supervisor/authorizer PIN + shift/tax
reconciliation) and needs a design decision on the owner-void flow.

## Verification (rule 7)
```
cd apps/dashboard && npm run build   → exit 0, "✓ built in 10.92s", OrdersPage bundle emitted
node scripts/check-register-consistency.mjs → OK, header agrees with body
node scripts/check-doc-refs.mjs             → OK
```
Env: Linux, Node 22 — the dashboard's real target is the Linux/browser build, so
on-target. No `tsc` step in the build script; the page is a standard typed component.

## Could NOT be verified here (rule 16 — target-only)
Browser: log in as owner → **Finance → Orders**, confirm the list loads across
branches, search/status filters work, a row expands to show payments, and
`ORD-MTH76LLB-001WV` (KES 790) is visible. Confirm the nav item is hidden for a role
without `orders.view_all`.

## Rollback
Before commit:
```
git restore apps/dashboard/src/App.tsx apps/dashboard/src/components/DashboardLayout.tsx docs/AUDIT-REGISTER.md
rm apps/dashboard/src/pages/OrdersPage.tsx docs/MANIFEST-2026-08-31-d.md
```
After push: `git revert <sha> && git push origin dev`.

## Before you commit (rule 20)
```
cd apps/dashboard && npm run build
node scripts/run-all.mjs   # (migration suite may false-red on Windows — see A186)
```
