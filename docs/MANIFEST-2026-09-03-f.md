# MANIFEST 2026-09-03-f — A184 Tier 3 **Phase 2**: retire / restore a terminal (code)

**Base commit:** `31e943c` (`dev`, the `-e` tip). **Scope:** dashboard + `devices.ts`.
**Depends on Phase 1 (migration 97) being applied to the DB `dev` runs against.**
**Working rules:** unchanged — `HANDOFF-2026-08-08-evening.md §0`.

## ⚠️ One gate is RED on purpose
`schema-audit` reports `user_devices.retired_at` / `retired_by` as absent. That is **correct**:
`scripts/schema-index.json` is the LIVE Postgres schema, and migration 97 hasn't been applied to a
database yet, so the columns aren't live. The gate is enforcing the Phase 1→2 order. It clears the
moment you:

```bash
# 1. apply migration 97 to the DB your dev environment uses
psql "$DEV_DATABASE_URL" -1 -f migrations/97_user_devices_retire.sql
# 2. refresh the index from that live DB (authoritative)
psql "$DEV_DATABASE_URL" -f scripts/build-schema-index.sql > /tmp/live.json
node scripts/build-schema-index.mjs --from-db /tmp/live.json
git add scripts/schema-index.json && git commit -m "schema-index: refresh from live (post-97)"
```
After that, `schema-audit` is green **and** the code works at runtime (the fleet query / retire
endpoint read the column). Until then the feature would 500 at runtime — so don't test the retire
button before step 1.

*(Shortcut: if you've already applied 97 to the dev DB but can't re-introspect, `node
scripts/build-schema-index.mjs --merge-migrations` adds the columns from the migration file. Only do
this if the DB genuinely has the column — otherwise the index would lie, which is the one thing it
exists to prevent.)*

## Files
| File | New? | Change |
|---|---|---|
| `apps/server/src/routes/devices.ts` | edit | Fleet returns live-only (`retired_at IS NULL`) by default, `?retired=1` archive; `PATCH /:id/retire` (stamps when+who, 409 if already retired, owner-scoped) + `PATCH /:id/unretire` (reversible). |
| `apps/dashboard/src/pages/FleetPage.tsx` | edit | Live/Retired toggle; per-row Retire (confirm) / Restore; `retiredAt` on the type. |
| `tests/fleet-retire.test.mjs` | new | 5 mutation-checked guard checks. |
| `docs/AUDIT-REGISTER.md` | edit | A184 Tier 3 Phase 2 note. No count change. |

## Verification (rule 7)
- `apps/dashboard` `tsc --noEmit` **0 errors**, `vite build` **exit 0**; `apps/server` `tsc` **0 errors**.
- `tests/fleet-retire.test.mjs` **5/5**, mutation-checked (drop the retired filter or the who-stamp → red; restore → green).
- `check-api-routes` **288** (the retire/unretire routes resolve). `check-doc-refs`,
  `check-test-registration`, `check-root-clean` → green.
- `schema-audit` → **RED by design** (retired_at/retired_by absent from the live index) — see above.

**Could NOT verify here (rule 7):** runtime against a DB with 97 applied (no DB access), and the
browser (Live/Retired toggle, retire→row leaves the list, restore from the archive). Your dev pass
after applying 97.

## Rollback
```
git checkout 31e943c -- apps/server/src/routes/devices.ts apps/dashboard/src/pages/FleetPage.tsx docs/AUDIT-REGISTER.md
rm tests/fleet-retire.test.mjs docs/MANIFEST-2026-09-03-f.md
```
