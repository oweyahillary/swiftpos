# MANIFEST 2026-10-02-b — desktop 0.6.32: one installer for 64-bit and 32-bit Windows (A377)

**Base:** origin/dev `70236cf`. **Delivered as:** `swiftpos-2026-10-02-v0.6.32.patch` — includes the version bump
(apps/desktop and `shared/release.ts` → 0.6.32). **No migration. No app-code change** — build settings only.

Owner, 2026-10-02: a client's till is Windows 10 32-bit, 4 GB RAM — "use combined installer".

## What changes
- The Windows installer is now ONE file for 64-bit and 32-bit Windows: **`SwiftPOS-<version>.exe`** (was
  `SwiftPOS-<version>-x64.exe`). It installs the build that fits the machine.
- Auto-update follows it: the cloud's feed serves the approved release's installer whatever its name; a 32-bit till
  keeps getting 32-bit builds, a 64-bit till 64-bit ones. The download is about twice the size of before.
- Not covered: Windows 7/8 (Electron 43 does not run there). The web-POS print bridge (Go) stays 64-bit.

## Files
`apps/desktop/electron-builder.config.js` (NSIS x64 + ia32, fixed name), `.github/workflows/release.yml` (build
`--x64 --ia32`; the check looks for `SwiftPOS-<v>.exe`), `apps/desktop/package.json` (`pack:installer`; 0.6.32) + lock,
`apps/desktop/scripts/release-both.mjs` (comment), `apps/server/src/routes/desktopUpdate.ts` (comment), `shared/release.ts`
(+ copies) 0.6.32; NEW `tests/desktop-installer-32bit.test.mjs` (5); `docs/AUDIT-REGISTER.md` (A377), this file.

## Rollout (owner)
1. Apply, commit, push; CI green. (Merge to main when convenient — nothing for the cloud to deploy except the comment.)
2. Tag **v0.6.32** → Release desktop green: the release has `latest.yml` and `SwiftPOS-0.6.32.exe`.
3. **32-bit till (new install):** download `SwiftPOS-0.6.32.exe` from the GitHub release, install, enrol, ring a sale,
   print a receipt. Task Manager → Details: `SwiftPOS.exe` shows "32-bit" (Platform column).
4. **64-bit tills:** approve 0.6.32 for a client; T1 updates as usual (one larger download), opens, sells.
