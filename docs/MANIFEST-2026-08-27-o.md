# MANIFEST 2026-08-27-o — A182: bind a machine MAC so a reinstalled till keeps its identity

**Base:** `d5bd396` + the A175–A181 chain. **Cross-stack: server (deploys on its
own) + desktop (version bump + tag after build, rule 15).**
**Artifact:** `swiftpos-2026-08-27-o.patch`. Requested overnight; attacks the ROOT
of A181 (a reinstalled till re-named "T1" and colliding).

## What it does

A till's `device_id` is regenerated on reset/reinstall, so the cloud sees a NEW
device and the operator re-names it by hand — usually "T1" again, which collides.
Now the machine's **MAC** is reported and bound on the cloud, so a reinstall is
recognised and handed its PREVIOUS terminal code + name.

- **Desktop** `machineFingerprint.ts`: a stable, deterministic MAC (skips
  loopback/virtual/zero; lowest wins so the same box always yields the same value).
  Sent as `X-Device-Mac` on pushes and `mac_address` on enrol. On enrol, if the
  server returns a prior identity, the till adopts it (fills terminal code/name only
  when the operator hasn't set them).
- **Cloud**: migration 93 adds `user_devices.mac_address` (+ partial index);
  `deviceRegistry` stores it (missing-column fallback for a DB without 93);
  `findPriorTerminalByMac` + pure `pickPriorTerminal` pick the most-recently-seen
  OTHER device sharing the MAC; `/api/auth/enrol/redeem` returns
  `restore: { terminal_code, device_label }`.

## Files

| File | Change |
|------|--------|
| `apps/desktop/src/main/machineFingerprint.ts` | NEW. Stable MAC read (`selectStableMac` pure + cached getter). |
| `apps/desktop/src/main/syncEngine.ts` | send `X-Device-Mac` on pushes. |
| `apps/desktop/src/main/ipcHandlers.ts` | send `mac_address` on enrol; adopt the `restore` hint. |
| `apps/server/src/lib/deviceRestore.ts` | NEW. Pure `pickPriorTerminal` + `isMac`. |
| `apps/server/src/lib/deviceRegistry.ts` | store `mac_address`; `findPriorTerminalByMac`; strip mac on missing-column retry. |
| `apps/server/src/routes/auth.ts` | pass `macAddress`; return `restore` on enrol. |
| `migrations/93_device_mac_binding.sql` | NEW. `user_devices.mac_address` + index. |
| `apps/desktop/test/machine-fingerprint.test.mjs` | NEW (8/8). `apps/desktop/package.json` → `test:macfp`. |
| `tests/device-mac-restore.test.mjs` | NEW (7/7). |
| `docs/RESTORE-GUIDE.md` | NEW. Session-restore guide (the 2nd ask). |
| `docs/AUDIT-REGISTER.md` | A182; counts + changelog; next free ID → A183. |
| `docs/MANIFEST-2026-08-27-o.md` | This file. |

## Verification (rule 7) and what is NOT (rule 16)

- `machine-fingerprint.test.mjs` 8/8 (deterministic, skips loopback/virtual/zero,
  null-safe). `device-mac-restore.test.mjs` 7/7 (ignores own id, most-recent wins,
  nothing-to-restore → null). server + desktop `tsc` clean. Regressions green.
- NOT verified: a Windows reinstall actually reporting the same MAC; the InstallPage
  PRE-FILLING from the restored `device_config.terminal_code` (the enrol handler
  sets it, but the setup screen should show it) — an on-device pass. Migration 93
  must be applied on the cloud.

## Deploy

1. Apply migration 93 on the cloud (adds `user_devices.mac_address`).
2. Deploy the server (returns `restore`, stores the MAC).
3. Build + install the desktop (reports the MAC, adopts the restore). Version bump +
   tag after the build (rule 15).

Safe rollout: all parts are additive and MAC-optional — an older till sends no MAC
and behaves exactly as before; a server without migration 93 degrades to "no restore
offered". Nothing regresses if only part ships.

## Apply / rollback

```
git apply --check swiftpos-2026-08-27-o.patch && git apply swiftpos-2026-08-27-o.patch
cd apps/desktop && npx tsc -b tsconfig.main.json --force && npm run test:macfp
node tests/device-mac-restore.test.mjs && (cd apps/server && npx tsc --noEmit)
# rollback: git apply -R swiftpos-2026-08-27-o.patch
```
