# MANIFEST — 2026-08-24-a

**Base commit:** `fa35595` (`audit/2026-08-23` tip — batch -x, HANDOFF-2026-08-23).
**Register IDs:** **A153** (CLOSED — dead-code retirement) · **A154** (OPENED — P3 feature to build).
**Working rules:** `HANDOFF-2026-08-08-evening.md` §0, rules 1–23.
**Apply:** `git apply MANIFEST-2026-08-24-a.patch` · **Rollback:** `git apply -R MANIFEST-2026-08-24-a.patch`

This batch retires four confirmed-dead dashboard-POS prototypes (A153) and files the
kept admin migrations panel as a feature to build (A154). No behavioural code
changed; the four deletions are unreachable code, so nothing at runtime is affected.

---

## Files

| # | Change | File | What / why |
|---|--------|------|------------|
| 1 | **delete** | `apps/dashboard/src/pages/pos/OrderHistoryTab.tsx` (361) | Original-commit prototype, unrouted + imported nowhere. Live sibling `POSOrderHistoryTab.tsx` is the one wired into `ManagerDashboard` + `POSDrawer`. (A153) |
| 2 | **delete** | `apps/dashboard/src/pages/pos/VoidModal.tsx` (165) | Dead by association — sole importer was `OrderHistoryTab`; live `POSOrderHistoryTab` never used it. (A153) |
| 3 | **delete** | `apps/dashboard/src/pages/pos/BranchSelectScreen.tsx` (353) | Original-commit prototype. Its `SELECTED_BRANCH_KEY` / `swiftpos_selected_branch` sessionStorage contract is read/written nowhere in any app. Live selection is `components/BranchSelector.tsx`. (A153) |
| 4 | **delete** | `apps/dashboard/src/pages/pos/VariantModal.tsx` (258) | Dead dashboard copy (name-collides with the LIVE desktop `renderer/components/VariantModal.tsx`, which stays, wired in `POSPage.tsx`). This was the `VariantModal` in the 08-10 A8 sweep. (A153) |
| 5 | **edit** | `docs/AUDIT-REGISTER.md` | A153 entry (CLOSED) + A154 entry (OPEN, P3); header **Open** tally A-P3 `6 → 7`; Counts row `+A154`; Last-updated note. |
| 6 | **new** | `docs/MANIFEST-2026-08-24-a.md` | This manifest. |

**Not touched (rule 22):** no `package.json` version, no lockfile, no `CHANGELOG`.

## Deliberately left in place (additive, rule 13)
Deleting the dashboard `VariantModal` orphans `computeUnitPrice` / `computeLineTotal`
in `apps/dashboard/src/lib/cart.ts` (now zero consumers). **Kept**, flagged for
removal, so this batch is **deletions-only** and reverts by restoring four files.
Prune them in a follow-up if wanted.

## Kept, not deleted — A154
`apps/admin/src/MigrationsPage.tsx` (213) is a finished-but-unwired admin panel whose
`GET /api/admin/migrations` backend was never built. Kept per owner (2026-08-24) and
filed as A154 to finish, not retired.

## Evidence (rule 7 — what ran, what it printed; rule 9 — where)
Bench: **Linux, Node v22.22.2** (not the till target; static/type/build level only).

```
apps/dashboard  tsc --noEmit         0 errors
apps/dashboard  npm run build        ✓ built (vite, noEmitOnError)
typecheck-ratchet server/dashboard/admin   all 0 (baseline held)
check-register-consistency           OK — header agrees with body (118 entries)
run-all.mjs                          unit + migration + gates green
```

**Could NOT be verified here (rule 16 — but does not gate this batch):** nothing —
the deleted code was unreachable at runtime, so there is no on-target behaviour to
confirm. A browser smoke of the POS order-history / variant / branch-select flows
(which use the *live* siblings, untouched) is reassurance, not a close condition.

## Known gate state
`check-doc-refs` remains RED for **one pre-existing** reason unrelated to this batch:
`HANDOFF-2026-08-23.md` cites a live-test-checklist markdown file that lives in the
session outputs directory, not `docs/` (its own fix — deliberately not cited here so
this manifest does not add a second dangling reference to it). This batch's own
manifest reference resolves once `MANIFEST-2026-08-24-a.md` is in `docs/`.
