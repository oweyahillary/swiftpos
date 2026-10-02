# MANIFEST 2026-09-03-d — A184 fleet identity (Tier 1) + active session (Tier 2); Tier 3 migration drafted

**Base commit:** `dev` tip after the `-c` batch lands (A193/A143). Apply `-c` first, then this.
**Scope:** dashboard + the existing `/fleet` server endpoint (read-only extension). **No migration
applied.** Tiers 1+2 stay **OPEN pending a browser pass** (rule 16); Tier 3 migration is a DRAFT for
review; Tier 4 deferred.
**Working rules:** unchanged — `HANDOFF-2026-08-08-evening.md §0`.

## Files

| File | New? | Change | Tier |
|---|---|---|---|
| `apps/server/src/routes/devices.ts` | edit | `/fleet` select adds `terminal_code, device_role, branch_id, mac_address`; branch-name lookup map; open-shift join (`shifts.device_id` + `status='open'`) → per-row `activeShift`. Read-only. | 1 + 2 |
| `apps/dashboard/src/pages/FleetPage.tsx` | edit | Terminal cell shows terminal code + role · branch + MAC; new **On shift** column (cashier + green dot); `FleetDevice` type extended. | 1 + 2 |
| `tests/fleet-identity.test.mjs` | new | 6 mutation-checked guard checks (identity select + mapping, open-shift join, UI column). | 1 + 2 |
| `docs/DRAFT-migration-97-user-devices-retire.sql` | new | **DRAFT, not applied** — additive `retired_at`/`retired_by` + partial index, with the wiring plan. Kept in `docs/` so the migration runner + drift gates don't see it. | 3 |
| `docs/AUDIT-REGISTER.md` | edit | FIX-BUILT note on A184 (Tiers 1+2 built; Tier 3 drafted/held; Tier 4 deferred). No count change. | — |

## Verification (rule 7)
- `apps/dashboard` `tsc --noEmit` **exit 0, 0 errors**; `vite build` **exit 0**.
- `apps/server` `tsc --noEmit` **exit 0, 0 errors**.
- `tests/fleet-identity.test.mjs` **6/6**, mutation-checked (drop the open-shift filter or the On-shift column → red; restored → green).
- Gates: `schema-audit` (0), `check-api-schema-drift` (OK), `check-api-routes` (289), `check-doc-refs`, `check-register-consistency`, `check-test-registration`, `check-root-clean` — **all exit 0**.

**Could NOT verify here (rule 7/16):** the browser — distinct code/role/branch/MAC per row and the
on-shift cashier. **MAC will be blank** on every till until the A182 desktop build (parked track)
ships and each till reports its MAC — the column is correct but sparse until then.

## Tier 3 — the drafted migration (review, then decide)
`docs/DRAFT-migration-97-user-devices-retire.sql` is **additive and reversible**: a nullable
`retired_at`/`retired_by` + a partial index. A retired till drops out of the fleet view and the
not-syncing banner but keeps all its history. To adopt: move it to `migrations/97_user_devices_retire.sql`,
add `scripts/test-migration-97.mjs`, apply on prod in a transaction, then wire the 4 code points
listed in the file header (a `.is('retired_at', null)` filter, a retire/unretire endpoint, and the
FleetPage action). **Not built in this batch — awaiting your go-ahead on the prod-migrate.**

## Rollback
```
git checkout <base> -- apps/server/src/routes/devices.ts apps/dashboard/src/pages/FleetPage.tsx docs/AUDIT-REGISTER.md
rm tests/fleet-identity.test.mjs docs/DRAFT-migration-97-user-devices-retire.sql docs/MANIFEST-2026-09-03-d.md
```
