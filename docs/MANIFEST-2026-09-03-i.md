# MANIFEST 2026-09-03-i — A143 build missing /export/expenses route; close A200; file A201

**Base commit:** `9a3d89c` (`dev`, the `-h` tip). **Scope:** one server route + register.
**Working rules:** unchanged — `HANDOFF-2026-08-08-evening.md §0`.

## Why
The 2026-09-03 export re-check confirmed the `-h` auth fix worked (7/8 hub exports + all 3 per-tab
buttons download real .xlsx), but surfaced two things:
1. **`/export/expenses` 404** — the route was documented in `reports-export.ts` and offered by the
   Exports hub, but was never implemented.
2. **A200 (test-email leak) — verified fixed** (clean generic message, no hosting internals).
3. A first-click-after-refresh **401 race** on downloads (filed as **A201**, P3, self-recovers).

## Changes
| File | Change | ID |
|---|---|---|
| `apps/server/src/routes/reports-export.ts` | New `router.get('/expenses')` — flat table (Date/Category/Description/Branch/Amount + Total), xlsx + csv, branch-scoped, `expense_date` + `expense_categories(name)` (mirrors `/pnl`'s expenses query and `/shifts`'s shape). | A143 |
| `tests/reports-export-routes.test.mjs` | 3 mutation-checked guard checks: every Exports-hub key has a real server route; `/expenses` exists; hub keys match the routes. | A143 |
| `docs/AUDIT-REGISTER.md` | A200 → CLOSED (browser-verified); A143 note (expenses route built); A201 opened (download 401 race). Counts A-P2 15→14, A-P3 4→5. | — |

## Verification (rule 7)
- `apps/server` `tsc --noEmit` **0 errors**.
- `tests/reports-export-routes.test.mjs` **3/3**, mutation-checked (rename the /expenses route → red).
- `schema-audit` (0), `check-api-schema-drift` (OK), `check-api-routes` (288),
  `check-register-consistency` (header agrees with body), `check-doc-refs`, `check-test-registration`,
  `check-root-clean` — green.

**Could NOT verify here (rule 7):** the Expenses export actually downloading a non-empty .xlsx in the
browser — that's the one re-check that closes A143.

## Register status after this batch
- **A200 — CLOSED** (verified).
- **A143 — OPEN**, one re-check from closed (only the Expenses download remains to confirm; the other
  7 + per-tab are verified).
- **A201 — OPEN** (P3, download 401 race; fix proposed, not built).

## Rollback
```
git checkout 9a3d89c -- apps/server/src/routes/reports-export.ts docs/AUDIT-REGISTER.md
rm tests/reports-export-routes.test.mjs docs/MANIFEST-2026-09-03-i.md
```
