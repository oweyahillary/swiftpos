# MANIFEST 2026-09-21-j — desktop: A306 auto-update UX (banner + manager-gated restart)

**Supersedes 2026-09-21-i** (Rule 3).

**Base commit:** `11bad03` (`dev` tip). If `dev` moved, apply the register edits by hand.
**Scope:** `apps/desktop` (main + renderer) + one root test + the register. **No `package.json`
version bump** — that happens at the next release build (Rules 15, 22).
**Working rules:** unchanged. **Register ID:** A306.

## Why

The first prod auto-update (v0.6.0) worked, but showed the UX gap `autoUpdate.ts` itself had
flagged for follow-up: the till installs on quit **silently**, so the operator saw the app close
and the desktop shortcut briefly "refers to a link that does not exist" during the NSIS swap, with
no sign it was updating. On a client-facing till that reads as a fault.

## What changed and why

| File | New? | Change | ID |
|---|---|---|---|
| `apps/desktop/src/main/autoUpdate.ts` | edit | Tracks update state and **broadcasts** it (`update:status` push). Keeps `autoInstallOnAppQuit` (still updates on a normal/overnight close — never mid-service). Adds `getUpdateStatus()` and `installUpdateNow()` → `quitAndInstall(false, true)` (installer progress **visible** + relaunch), a no-op unless an update is downloaded. | A306 |
| `apps/desktop/src/main/ipcHandlers.ts` | edit | `update:getStatus` + `update:installNow` handlers. | A306 |
| `apps/desktop/src/main/preload.ts` | edit | `update.getStatus` / `installNow` / `onStatus` (push subscribe + unsubscribe). | A306 |
| `apps/desktop/src/main/ipcSchemas.ts` | edit | Schemas for the two invoke channels (the status push is a send, not a handled channel). | A306 |
| `apps/desktop/src/renderer/lib/posApi.ts` | edit | `update` types. | A306 |
| `apps/desktop/src/renderer/pages/UpdateBanner.tsx` | **new** | Non-blocking banner: "Downloading…" / "Update ready — installs when you close the app". "Restart & update now" is **manager/tech-PIN-gated** (`auth.verifyPin` → `MANAGER_ROLES`) → `update.installNow()`. "Later" hides it for 2h then re-surfaces (gentle reminder). | A306 |
| `apps/desktop/src/renderer/App.tsx` | edit | Mounts `<UpdateBanner/>` alongside the lock curtain (visible only while staff are logged in). | A306 |
| `tests/update-ux-wiring.test.mjs` | **new** | 13 source-guard checks; auto-registered by the CI `tests/*.test.mjs` glob. | A306 |
| `docs/AUDIT-REGISTER.md` | edit | A306 entry + Open `20 P3`→`21 P3` + Counts `…A305 A306` + a `2026-09-21 (update-ux)` line. **Also trues the Tree row `desktop v0.5.49`→`v0.6.0`.** | A306 |

> **Heads-up — this also fixes a currently-red `dev`.** The v0.6.0 release bump set
> `apps/desktop/package.json` to 0.6.0 but left the register's Tree row at v0.5.49, so
> `check-register-consistency` has been FAILING on `dev` since that commit
> (`TREE LINE STALE: header says desktop v0.5.49, package.json is 0.6.0`). This delivery trues the
> Tree row, so pushing it brings `dev` green again. If you want `dev` green immediately without the
> rest of A306, that one-line fix alone is: set `desktop **v0.5.49**` → `desktop **v0.6.0**` in the
> Tree row and commit.

Owner decisions honoured: **banner + gentle periodic reminder** (2h re-surface), and **manager/tech
PIN only** for the manual restart.

## Verification (Rule 7 — what was run)

Bench, Linux/Node 22 (weak green, Rule 9):
- **`node tests/update-ux-wiring.test.mjs` → 13/13**; the **manager-gate mutation** (remove
  `verifyPin`/`MANAGER_ROLES`) was confirmed to turn the "restart gated behind a manager PIN"
  assertion red, then restored.
- **`check-ipc-parity` + `check-ipc-validation` → OK** (the two new invokes bridged/handled/schema'd;
  the `update:status` push is a send, outside the parity gate).
- **Desktop `tsc` (main + renderer) → 0 errors** on the changed files.

**Could NOT verify here (target-only, Rule 16):** the on-screen banner, the manager-PIN flow, and
the **visible installer progress + relaunch** on a real Windows till. These need Electron on the
till — best checked on the next release (the banner appears when a newer version is published).

## Rollback (Rule 2)

```bash
git checkout 11bad03 -- apps/desktop/src/main/ipcHandlers.ts apps/desktop/src/main/preload.ts \
  apps/desktop/src/main/ipcSchemas.ts apps/desktop/src/renderer/lib/posApi.ts \
  apps/desktop/src/renderer/App.tsx docs/AUDIT-REGISTER.md
git checkout 11bad03 -- apps/desktop/src/main/autoUpdate.ts
rm -f apps/desktop/src/renderer/pages/UpdateBanner.tsx tests/update-ux-wiring.test.mjs
```

## Commit (direct to dev, explicit paths — never `git add -A`; NO package.json)

```bash
git checkout dev && git pull                    # confirm 11bad03; else re-apply the register edits
git add apps/desktop/src/main/autoUpdate.ts apps/desktop/src/main/ipcHandlers.ts \
        apps/desktop/src/main/preload.ts apps/desktop/src/main/ipcSchemas.ts \
        apps/desktop/src/renderer/lib/posApi.ts apps/desktop/src/renderer/pages/UpdateBanner.tsx \
        apps/desktop/src/renderer/App.tsx tests/update-ux-wiring.test.mjs \
        docs/AUDIT-REGISTER.md docs/MANIFEST-2026-09-21-j.md
git status --short                              # expect exactly these ten — and NOT package.json
node tests/update-ux-wiring.test.mjs
git commit -m "feat(desktop): A306 auto-update UX — status banner + manager-gated visible restart"
git push
```

This ships in the **next** release. To see it: cut a release after this lands (e.g. tag `v0.6.1`);
tills on 0.6.0 will show the banner as the new version downloads, and a manager can restart with
visible progress instead of the app vanishing.
