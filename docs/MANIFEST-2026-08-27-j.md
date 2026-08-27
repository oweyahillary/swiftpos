# MANIFEST 2026-08-27-j — A178: sync visibility + decouple + tech-menu diagnostics

**Base:** `d5bd396` + `-h` + `-i2` (A177). **Desktop change → bump the version +
tag after the build (rule 15); not in this patch (rule 22).**
**Artifact:** `swiftpos-2026-08-27-j.patch`.

## Why

Reading the field till's own `swiftpos.db` showed the scare was smaller than it
looked — **all orders were `synced`**; the "6 pending" were 2 shifts, 2
business-days, 1 float, 1 expense. But the code pushing those (`pushLocalRecords`)
logged nothing, and the push stages were coupled, so the situation was both
invisible and fragile.

## What ships

**1. Decouple the push stages.** `runPushStages()` runs shift → price → order →
reconcile → node independently; a throw in one is caught + logged and the rest
still run. The order push is no longer gated behind the shift push (or its
pre-`try` SELECTs).

**2. Make the pushes visible.** Shift/price push rejections and throws now write to
`swiftpos.log` (`[sync] shift push rejected (HTTP …)`, `[sync] price push failed:
…`), matching A177's order logging. Successes log counts (`pushed N order(s)`,
`pushed N cash record(s)`, `pushed N price edit(s)`).

**3. Tech-menu powers.** `getSyncStatus().pendingBreakdown` (orders/shifts/floats/
expenses/days); TechPage shows it; new **Test connection** (`testConnection()` +
`tech:testConnection`) reaches the server and reports HTTP + ms (the "Online" badge
is only `net.isOnline()`); new **View log** (`tech:logTail`) reads the durable log
on the device with copy. Both read-only.

## Files

| File | Change |
|------|--------|
| `apps/desktop/src/main/syncEngine.ts` | `runPushStages()`; `testConnection()`; shift/price/order push logging; `pendingBreakdown` in `getSyncStatus`. |
| `apps/desktop/src/main/ipcHandlers.ts` | `tech:testConnection`, `tech:logTail`; `breakdown` added to `tech:status`. |
| `apps/desktop/src/main/preload.ts` | expose `tech.testConnection`, `tech.logTail`. |
| `apps/desktop/src/renderer/lib/posApi.ts` | types for the two new tech methods. |
| `apps/desktop/src/renderer/pages/TechPage.tsx` | pending breakdown line; Test connection + View log (with copy). |
| `apps/desktop/test/sync-decouple.test.mjs` | NEW. Real engine, broken shift schema → order still pushes; logging + breakdown asserted (6/6). |
| `apps/desktop/package.json` | `test:syncdecouple` in the `test:desktop` chain. |
| `docs/AUDIT-REGISTER.md` | A178 (closed); changelog; next free ID → A179. |
| `docs/MANIFEST-2026-08-27-j.md` | This file. |

## Verification (rule 7) and what is NOT (rule 16)

- `sync-decouple.test.mjs` 6/6 (order pushes despite a shift-push throw; shift/order log lines; breakdown present).
- Regressions: `test:synctimeout` 5/0, `test:sync` 29/0, `test:pin` 17/0, `test:peerrelay` 28/0.
- `apps/desktop` main **and** renderer `tsc` clean.
- NOT verified: the TechPage buttons/rendering on a real device (Test connection, View log, breakdown line) — target-only.

## What this does for the live issue

Once on this build, the Technician screen will show the 6 broken down by type, a
**Test connection** will say whether the till can actually reach Render (vs the
misleading Online badge), and **View log** + the new push-logging will show, in
plain text, whether the shift push is being rejected — and why. If it's the cloud
schema drift, the log will name the missing column.

## Apply / rollback

```
git apply --check swiftpos-2026-08-27-j.patch && git apply swiftpos-2026-08-27-j.patch
cd apps/desktop && npx tsc -b tsconfig.main.json --force && npm run test:syncdecouple
# rollback: git apply -R swiftpos-2026-08-27-j.patch
```
