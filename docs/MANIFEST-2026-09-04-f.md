# MANIFEST 2026-09-04-f — A145 (retire, already done) + A148 (modifier-option add) + A129/dup-90 (archive)

**Base commit:** current `dev`. **Three items, three independent commits** (each reverts on its own).
**Working rules:** unchanged — `HANDOFF-2026-08-08-evening.md §0`.

## A145 — CLOSED (already retired; register was stale)
The two redundant + under-guarded routes (`POST /branches/:id/assign-user`,
`DELETE /branches/:id/remove-user/:userId`) were already removed — `branches.ts` carries a comment
block where they were, and a repo grep confirms no handlers and **zero callers**. Register corrected
+ closed. Counts A-P1 16→15. No code change.

## A148 — PARTIAL: the one clean sub-item built; the rest parked by decision
- **Built:** add an option to a **saved** modifier group. `VariantsDrawer` gains a per-group
  "+ Add option" (name + price) calling the live, guarded `POST /api/modifiers/options`.
- **Parked (not building):** `PUT /flags/:key` (owners don't self-manage flags), `GET/PATCH /qr/settings`,
  `GET /loyalty/settings` — each needs a new low-value settings surface. Recorded as deferred.

## A129 / duplicate-90 — RESOLVED (rogue archived)
Two files were numbered 90; `90_restore_order_types.sql` (8-value, admits aggregator/other against
the A129 decision) is **archived** to `migrations/archive/`, leaving the authoritative
`90_order_type_delivery_check.sql` (6-value, delivery only). On already-migrated DBs delivery stays
admitted (no change); a fresh migrate now lands the decided 6-value. Removes the ambiguity flagged
since 2026-08-22. **A129 still needs the prod-migrate + a delivery-sync live check to close** —
owner-side.

## Files
| File | Change | Item |
|---|---|---|
| `apps/dashboard/src/pages/products/VariantsDrawer.tsx` | per-saved-group "+ Add option" → `POST /api/modifiers/options`. | A148 |
| `tests/modifier-option-add.test.mjs` | 3 mutation-checked checks (endpoint guarded; client wires it + refreshes; control renders). | A148 |
| `migrations/90_restore_order_types.sql` → `migrations/archive/90_restore_order_types.sql` | archived (rogue duplicate). | A129 |
| `docs/AUDIT-REGISTER.md` | A145 CLOSED; A148 partial note; A129 dup-90 resolved note. | — |

## Verification (rule 7)
- A145: verified in source (handlers absent, zero callers).
- A148: `tests/modifier-option-add.test.mjs` 3/3, mutation-checked; dashboard tsc 0 + `vite build` 0.
- dup-90: `test-migration-90.mjs` 9/9 (tests the authoritative delivery_check); `schema-audit`,
  `check-api-schema-drift`, `check-doc-refs` (archive didn't break refs), `check-api-routes`,
  `check-register-consistency`, `check-test-registration`, `check-root-clean` — all green.

**Could NOT verify here:** A148 in the browser (add an option to a saved group → it appears);
A129's prod-migrate + a delivery sale reaching the cloud (owner-side).

## Rollback (per item)
```
# A148
git checkout <base> -- apps/dashboard/src/pages/products/VariantsDrawer.tsx
rm tests/modifier-option-add.test.mjs
# A129 dup-90 archive
git mv migrations/archive/90_restore_order_types.sql migrations/90_restore_order_types.sql
# register
git checkout <base> -- docs/AUDIT-REGISTER.md
rm docs/MANIFEST-2026-09-04-f.md
```
