# MANIFEST 2026-08-27-h — A175 + A176: revive two rotted desktop test suites

**Base:** `d5bd396` (dev tip after A174). **Test-only — no app code, no version bump (rule 15 not triggered).**
**Artifact:** `swiftpos-2026-08-27-h.patch`.

## What this fixes

Two desktop suites had been silently red (they don't run in CI, so nobody saw
them). Both were **stale shims**, not feature regressions — a feature added a
dependency the test harness never picked up:

- **A175 · `test:pin`** (8 failed → 17/0). A17 added `getDeviceConfig()?.node_url`
  to `verifyPinOffline` (node-configured tills don't time-expire their cache), but
  the test never shimmed `deviceConfig`, so the real one threw
  `no such table: device_config`. Fixed by shimming `deviceConfig` (standalone
  default) + a new test for the A17 no-expiry branch. This is the automated guard
  for the offline-auth area A167 fixes, so it mattered most.
- **A176 · `test:sync`** (11 failed → 29/0). A24 put an unconditional
  `fetchReferenceFromNode()` at the top of `pullCatalogue()`; the `nodeClient`
  shim lacked it, so `syncAll()` threw before reaching the cloud pull the
  "inbound failure capture" tests exercise. Fixed by adding it to the shim
  (returns null → falls through to cloud, as a no-node till does).

## Files

| File | ID | Change |
|------|----|--------|
| `apps/desktop/test/pinCache.test.mjs` | A175 | Add `deviceConfig` shim (standalone default) + A17 node-no-expiry test. |
| `apps/desktop/test/syncEngine-failures.test.mjs` | A176 | Add `fetchReferenceFromNode: async () => null` to the `nodeClient` shim. |
| `docs/AUDIT-REGISTER.md` | — | A175/A176 entries (CLOSED) + changelog; next free ID → A177. Open counts unchanged. |
| `docs/MANIFEST-2026-08-27-h.md` | — | This file. |

## Verification (rule 7)

Built `dist/main` and ran on the bench (`better-sqlite3` real driver / `node:sqlite` stand-in):
- `test:pin` → **17 passed, 0 failed** (was 8/8).
- `test:sync` → **29 passed, 0 failed** (was 18/11).
- Regression sweep of the other bench-runnable desktop suites: `test:managefetch` 15/0, `test:devicetoken` 21/0, `test:idlelock` 27/0, `test:failover` 12/0, `test:peerrelay` 28/0, `test:token` 14/0, `test:refbundle` 25/0, `test:refunpack` 19/0, `test:roster` 16/0 — all green. So these two were the only rotted suites.
- Register/doc/test gates green.

After applying, confirm on your box:
```
cd apps/desktop
npx tsc -b tsconfig.main.json --force
npm run test:pin && npm run test:sync    # expect 17/0 and 29/0
```
The full `test:desktop` chain will now run past `test:sync` (it had been dying there); the `*:electron` variants still need your Windows box.

## Root cause worth addressing separately

Both rotted for the same reason: **desktop tests don't run in CI**, so a feature
change that outdates a shim goes unnoticed. The bench-runnable subset (everything
except the `*:electron` variants) runs headless under `node:sqlite`/better-sqlite3
and could be wired into CI to stop this recurring. That's a larger, careful change
(dist build + native-dep handling) — flagged, not bundled here.

## Rollback

```
git apply -R swiftpos-2026-08-27-h.patch
```
