# MANIFEST 2026-09-23-u — A321: open screens refresh on every landed pull; lock screen listens; 20-s check not silent

**Base commit:** `2cab94b` (origin/dev, delivery -t; 3/3 checksums on the tip, gates exit 0, CI #383 green).
**Register:** A321 OPEN → FIX BUILT (P2); note on A278. Header, changelog. Counts unchanged (FIX BUILT stays open).
**Deploy:** a **desktop build — 0.6.3** (rule 15; the version field is NOT in this zip, rule 22). It also carries A315's
till half (already on dev). No cloud or dashboard change, no migration.
**Environment:** Linux, Node 22; the engine is exercised compiled, under node with shims (as syncEngine-failures). Electron
IPC delivery and the React re-render are target-only (rule 16).

**The defect (owner, 2026-09-23: "the changes reflect but I have to login first then log out").** Web changes reached the
till's local DB, but (1) only the 20-s check raised `catalogue:changed`, and only to `getAllWindows()[0]` — the other seven
pull paths (10-min floor, startup, enrol, branch change, manual sync ×2, post-edit sync) were silent; (2) the 20-s check
dropped every non-OK answer as "no change" without refreshing the token, so it failed invisibly; (3) the lock screen read
branding once and never listened.

**Fix.**
- `syncEngine.ts` — `onCataloguePulled(cb)` listener set; `syncAll` notifies after any successful pull (the one point all
  eight paths share); a failed pull does not. The 20-s check: renew ahead of expiry, 401 → refresh → retry once, any other
  failure recorded (`version` scope, after `auth`/`sync`), cleared on recovery.
- `index.ts` — one listener → `catalogue:changed` to every non-destroyed window; the old send removed.
- `PinPage.tsx` — re-reads branding on the signal; null resets to the default.

## Files (9)
| File | Change |
|---|---|
| `apps/desktop/src/main/syncEngine.ts` | Listener set + notify in `syncAll`; 20-s check renew / 401-retry / record; `version` scope. |
| `apps/desktop/src/main/index.ts` | Registers the forward-to-every-window listener; old single send removed. |
| `apps/desktop/src/renderer/pages/PinPage.tsx` | Branding re-read on `catalogue:changed`; null → default. |
| `apps/desktop/test/catalogue-refresh-signal.test.mjs` | **NEW.** 18 checks, real compiled engine, genuine pull. |
| `apps/desktop/package.json` | `test:refresh` script. **Version field untouched (0.6.2).** |
| `.github/workflows/ci.yml` | Step "Desktop catalogue refresh signal" after "Desktop sync failure reporting". |
| `tests/catalogue-refresh.test.mjs` | A278's first assertion pinned the defective wiring → pins the new listener. 6/6. |
| `docs/AUDIT-REGISTER.md` | A321 FIX BUILT with evidence; A278 note; header; changelog. |
| `docs/MANIFEST-2026-09-23-u.md` | This file. |


## Verification (rule 7)
```
cd apps/desktop && npx tsc -b tsconfig.main.json --force && node test/catalogue-refresh-signal.test.mjs     18 passed, 0 failed
  a successful syncAll pull fires once · a FAILED pull does not · all listeners run past a throwing one · unsubscribe works
  20-s: new version pulls + fires; same version does nothing · 401 → refresh → retry → pulls, no failure left
  500 recorded ("…HTTP 500 — changes will arrive with the 10-minute sync instead") · network failure recorded · recovery clears
  index.ts forwards to every window; old [0] send gone · PinPage subscribes, null → default · POSPage still subscribes
mutations (clean build each): no notify → 5 FAIL · silent non-OK → 3 · no 401 retry → 1+ · old index.ts → 3 · read-once PinPage → 2
tip engine → "engine.onCataloguePulled is not a function"
node tests/catalogue-refresh.test.mjs 6/6 (fails on the tip index.ts, 1 FAIL)
neighbours: syncEngine-failures 29/0 · device-token-refresh 21/0 · sync-decouple 6/0 · sync-timeout 5/0 · manage-fetch-refresh 15/0 · branding-set 42/0
node scripts/run-all.mjs GREEN 117/117 · desktop main + renderer tsc 0 · check-test-registration OK
check-register-consistency / check-doc-refs / check-root-clean OK · ci.yml + package.json parse
```

## Not verified here (rule 16) — owner, on desktop 0.6.3
1. VERIFY **A2**: till on the PIN screen, change the accent on the web → the lock screen changes within ~30 s, no sign-in/out.
2. VERIFY **B1**: till on the POS grid, change a price on the web → it changes on the grid by itself (~20 s; ≤10 min worst case).
   If it is slow: Tech › sync status now names the reason (e.g. `catalogue-version check failed: HTTP …`).
3. A315 till half: a till receipt and the tech test print show the thank-you once.

## Rollback
```bash
git checkout 2cab94b -- apps/desktop/src/main/syncEngine.ts apps/desktop/src/main/index.ts apps/desktop/src/renderer/pages/PinPage.tsx \
  apps/desktop/package.json .github/workflows/ci.yml tests/catalogue-refresh.test.mjs docs/AUDIT-REGISTER.md && \
  git rm -q --ignore-unmatch apps/desktop/test/catalogue-refresh-signal.test.mjs docs/MANIFEST-2026-09-23-u.md && \
  rm -f apps/desktop/test/catalogue-refresh-signal.test.mjs docs/MANIFEST-2026-09-23-u.md
```
