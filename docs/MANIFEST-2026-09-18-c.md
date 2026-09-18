# Delivery manifest — 2026-09-18 (-c) · release 0.5.45 (A297 real fix)

**Base commit:** `c208ee4` (branch `dev`, i.e. current tip / after the 0.5.44 tag).
**Scope:** the **actual** Overview fix — the A297 ipcGuard change that did NOT make it into 0.5.44.
0.5.44 shipped the version bump + A296 (Item Mix) only, via the superseded `-b` patch whose
stale-build theory was wrong. This delivery carries the real one-line fix + its test, and bumps
to 0.5.45.

Includes the version bump (release cut).

## Why 0.5.44 didn't fix the Overview
0.5.44 (tag `v0.5.44`, commit `c208ee4`) contains no `payload ?? {}` in `ipcGuard.ts`. Item Mix
worked because A296 (already on `dev`) makes it send an object; the Overview still calls with no
argument, which A271's guard rejects. Confirmed by inspecting the tag, not by inference.

## Files

| File | Change | Why |
|---|---|---|
| `apps/desktop/src/main/ipcGuard.ts` | `guardChannel` object-bag branch → `assertPayload(spec, payload ?? {})`. | A297 — an absent payload is an empty bag, so fully-optional schemas accept a no-arg call; required-field channels still reject `{}`. |
| `apps/desktop/test/ipc-guard-optional.test.mjs` | New mutation-checked test. | Rules 10, 23. |
| `apps/desktop/package.json` | `version` 0.5.44 → **0.5.45**; add `test:ipcguard`. | Rule 15 + register the test. |
| `docs/AUDIT-REGISTER.md` | Rewrote **A297** in place to the verified IPC-validation cause + this fix; OPEN → **FIX BUILT** (still P1, counts unchanged); records that 0.5.44 shipped without the fix. | A60 — edit in place; keep the honest trail. |
| `docs/MANIFEST-2026-09-18-c.md` | This file. | Rule 2. |

## Rollback

```
git checkout c208ee4 -- apps/desktop/src/main/ipcGuard.ts apps/desktop/package.json docs/AUDIT-REGISTER.md
git rm apps/desktop/test/ipc-guard-optional.test.mjs docs/MANIFEST-2026-09-18-c.md
# if tagged:  git push --delete origin v0.5.45 ; git tag -d v0.5.45
```

## Cut the release (rule 15 — tag AFTER a verified build)

```bash
# from /c/swiftpos/pos
git apply --check "../patch files/swiftpos-0.5.45-A297-ipcguard.patch"
git apply "../patch files/swiftpos-0.5.45-A297-ipcguard.patch"
git add -A
git commit -m "0.5.45: fix Overview — IPC guard accepts no-arg optional payload (A297); +test"
git push origin dev

# VERIFY before tagging:
cd apps/desktop
npm ci
npm run build:all
npm run assert:built
npm run test:ipcguard          # must print all ok, exit 0
cd ../..

# only if clean:
git tag v0.5.45
git push origin v0.5.45
```

## Verified on the bench (Linux, Node 22, no app node_modules — rule 9)

`check-register-consistency`, `check-doc-refs`, `check-root-clean`, `check-ipc-parity`,
`check-ipc-validation`, `check-test-registration` re-run green.

## NOT verified — target/CI only (rules 9, 16)

- Desktop `tsc`/`build:all` + `test:ipcguard` (imports `dist`) — run on Windows before tagging.
- The fix: **after the till reports 0.5.45, the Overview must show KES 650 / 1 order / cash +
  the payment split.** That closes A297. Quick pre-check: DevTools on the 0.5.44 Overview should
  still show `IpcValidationError: payload must be an object` (same error = fix simply not shipped
  yet, exactly as this delivery addresses).
