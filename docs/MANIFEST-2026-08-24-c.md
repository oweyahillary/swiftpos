# MANIFEST — 2026-08-24-c

**Base commit:** batch -b (`4179413`), on `audit/2026-08-23`. Applies **on top of -b**.
**Register IDs:** **A156** (CLOSED — retire orphaned helper exports) · **A157** (OPENED,
P2 — validation schemas written but unwired).
**Working rules:** `HANDOFF-2026-08-08-evening.md` §0, rules 1–23.
**Apply:** `git apply MANIFEST-2026-08-24-c.patch` · **Rollback:** `git apply -R MANIFEST-2026-08-24-c.patch`

Retires 12 dead value-exports found by a repo-wide sweep (A156), and files the
unused-validation-schema finding (A157) that surfaced during it. **No behavioural code
changed** — every removed symbol had zero callers tree-wide.

---

## Files (code — all deletions of unreferenced exports)

| # | File | Removed |
|---|------|---------|
| 1 | `apps/dashboard/src/lib/api.ts` | `clearSwiftPOSToken` (logout uses `clearAllTokens`) |
| 2 | `apps/dashboard/src/lib/localDate.ts` | `localDateStrDaysAgo` |
| 3 | `apps/dashboard/src/lib/localPrintServer.ts` | `getAvailablePrinters`, `disconnectQZ` (QZ module stays) |
| 4 | `apps/dashboard/src/pages/pos/cashier/POSSkeletons.tsx` | `SkeletonLine`, `PageSkeleton` (live skeletons untouched) |
| 5 | `apps/desktop/src/main/idleMonitor.ts` | `stopIdleMonitor` (was never called; monitor already never stopped) |
| 6 | `apps/desktop/src/renderer/hooks/usePrinterSettings.ts` | `getPrinterSettings` |
| 7 | `apps/desktop/src/renderer/lib/heldOrders.ts` | `heldOrderCount` |
| 8 | `apps/desktop/src/renderer/lib/thermal.ts` | `metaRow` |
| 9 | `apps/server/src/lib/adminSeedGuard.ts` | `DISABLED_ADMIN_HASH` (`SEEDED_ADMIN_HASH`/`isSeededAdminHash` stay) |
| 10 | `apps/server/src/lib/whatsapp.ts` | `whatsAppEnabledGlobally` |

## Files (docs)

| # | File | Change |
|---|------|--------|
| 11 | `docs/AUDIT-REGISTER.md` | A156 (CLOSED) + A157 (OPEN, P2); Open tally A-P2 `14 → 15`; Counts `+A157`; Last-updated. |
| 12 | `docs/MANIFEST-2026-08-24-c.md` | This manifest. |

**Not touched (rule 22):** no `package.json` version, no lockfile.

## Excluded from deletion — flagged, not removed (safety)
The repo-wide scan (all tracked files, not just app source) found two more
declaration-only exports that are **cited in docs**, so they got a flag, not a delete:
- `getLocalSchemaVersion` (`desktop/main/localDb.ts`) — described in
  `docs/LOCAL-SCHEMA-VERSIONS.md`; may want *wiring* as a diagnostic, not deletion.
- `isTerminalCodeTaken` (`server/lib/deviceBinding.ts`) — appears in
  `docs/history/applied/WIRING.md` as once-wired; resolve the history before removing.

## Class C deliberately NOT auto-wired (the "no breakage" instruction)
A157 records four written-but-unwired validation schemas. They were **not** wired in
this batch because `validate()` does `req.body = result.data` and the schemas are
incomplete — wiring `LoginSchema` would strip `device_id`/`app_version`/`terminal_code`/
`device_role` on sign-in and **break device binding**. Wiring safely needs per-route
field reconciliation + a live/target test (rule 16), so it is filed for a decision
rather than forced. Full analysis in A157.

## Evidence (rule 7 — what ran; rule 9 — where)
Bench: **Linux, Node v22.22.2** (static/type/build only).

```
files changed                        exactly the 10 intended (no scope creep — verified via git status)
typecheck-ratchet server/dash/admin  all 0 (baseline held)
desktop renderer tsc                  clean
desktop main tsc                      unchanged — its 4 pre-existing implicit-any errors
                                       (escposBridge/printWorker, untouched) exist at the -b baseline too
apps/dashboard  npm run build         ✓ built (vite)
run-all.mjs                           40 passed / 0 failed
```

## Could NOT be verified here (rule 16)
Nothing gating for A156 — removed code had zero callers, so there is no runtime
behaviour to confirm. A157's fix (if pursued) is what needs the target/live pass.
