# MANIFEST 2026-09-13-d — A22 split-brain made loud

**Base:** `4fcddc8` (`dev`), on top of deliveries -a/-b/-c. **No `version` field
touched** (rule 22). **No migration** — the conflict columns already exist
(migration 74). Additive.

## What this delivers
- **A22 → FIX BUILT** (P2): two branch servers on one branch is now said **loudly**.
  Detection already existed (`confirmServingRole` records `role_conflict_at`); this
  adds the promote-time guard and the owner-facing surface.

## Files
| File | Change | Why |
|---|---|---|
| `apps/desktop/src/main/ipcHandlers.ts` | `tech:promoteToNode` probes the current `node_url` before the role flip; refuses (`code: 'node_reachable'`) if a live node answers | You can't create a second server while the first is still up |
| `apps/server/src/routes/devices.ts` | `GET /fleet` selects `role_conflict_at`/`role_conflict_with` and exposes `servingConflict`/`conflictAt` | The recorded conflict reaches the owner instead of only the server console |
| `apps/dashboard/src/pages/FleetPage.tsx` | Loud red "Split-brain — two servers on this branch" badge on a conflicted device | The reconnect-after-promotion case (recorded by confirmServingRole) is now visible |
| `tests/split-brain-surfacing.test.mjs` | NEW — 3 guards (mutation-checked) | Pin the probe-refusal + the two surfaces |
| `docs/AUDIT-REGISTER.md` | A22 → FIX BUILT + changelog | Rule 14 |
| `docs/MANIFEST-2026-09-13-d.md` | NEW — this file | Rule 2 |

## Verification (rule 7)
- `node tests/split-brain-surfacing.test.mjs` → **3 passed**.
- Mutation check (rule 10/23): forced the promote-probe branch to never fire → the
  probe-refusal assertion went **red**; restored → green.
- `check-register-consistency`, `check-doc-refs`, `check-root-clean`,
  `check-test-registration` → **green**.

## NOT verified here — target-only (rule 16)
- Live two-node scenario: promoting while the old node is up is refused on a real
  till; a reconnected old node lights the fleet badge for the owner.
- **server tsc** + **dashboard tsc** (no `node_modules` on the bench).

## Follow-up (noted, not built)
- A node-**local** banner: surface the conflict in the sync response so the conflicted
  node warns on its own screen, not only in the owner's fleet view. Small, but
  Electron-bound to verify — deferred rather than shipped blind.

## Rollback
```
git checkout 4fcddc8 -- apps/desktop/src/main/ipcHandlers.ts apps/server/src/routes/devices.ts apps/dashboard/src/pages/FleetPage.tsx docs/AUDIT-REGISTER.md
git rm tests/split-brain-surfacing.test.mjs docs/MANIFEST-2026-09-13-d.md
```
