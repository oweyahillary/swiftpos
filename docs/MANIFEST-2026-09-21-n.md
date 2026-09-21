# MANIFEST 2026-09-21-n — desktop: A278 web→till changes without a restart

**Supersedes 2026-09-21-m** (Rule 3).

**Base commit:** `c7bbc52` (`dev` tip — synced to v0.6.1).
**Scope:** `apps/desktop` (main + renderer) + one root test + the register. No server, no migration.
**Working rules:** unchanged. **Register ID:** A278. Ships in the **next desktop release**.

## Why / diagnosis

A278 asked for "real-time push (web → till)". Tracing it showed a push channel isn't the gap: the
**A291 fast-poll already runs every 20s** (`index.ts` → `pullIfCatalogueChanged`) and pulls web
edits into the local SQLite. The real gap: the running **POS loads the catalogue once on mount**
(`POSPage` `pos.init`) and is **never told to reload** — so the data was ~20s-fresh in the DB but
the screen stayed stale until a restart. (Same shape as A276/A277: the mechanism was there; a link
was missing.)

## What changed

| File | Change | ID |
|---|---|---|
| `apps/desktop/src/main/index.ts` | When the 20s fast-poll's pull actually lands (`r.pulled`), `webContents.send('catalogue:changed')` to the window. | A278 |
| `apps/desktop/src/main/preload.ts` | `pos.onCatalogueChanged(cb)` — subscribe to the push, returns unsubscribe (mirrors `escpos.onChanged`). | A278 |
| `apps/desktop/src/renderer/lib/posApi.ts` | Type for `pos.onCatalogueChanged`. | A278 |
| `apps/desktop/src/renderer/pages/POSPage.tsx` | Extract the catalogue loader into `loadCatalogue` (useCallback); call it on mount **and** on `catalogue:changed`. | A278 |
| `tests/catalogue-refresh.test.mjs` | **new** — 6 source-guards (notify-on-pull, preload bridge, posApi type, POS extract+subscribe+mount). Auto-registered by the CI glob. | A278 |
| `docs/AUDIT-REGISTER.md` | A278 `OPEN`→`FIX BUILT` + diagnosis/fix note + `2026-09-21 (livecat)` changelog line. (P2 count unchanged — FIX BUILT still counts as open.) | A278 |

**Design decision:** kept the 20s poll + reload rather than a persistent push socket to every till.
The socket would give sub-second updates but is a much larger build (persistent connections,
reconnection, scaling, auth); ~20s meets the owner's actual need ("no restart"). Only the POS
screen subscribes; other screens can add the same one-liner if wanted. `catalogue:changed` is a
main→renderer *send* (like `idle:lock`/`escpos:changed`), so it's outside the invoke/handle IPC
gates by design.

## Verification (Rule 7)

Bench, Linux/Node 22:
- **`node tests/catalogue-refresh.test.mjs` → 6/6** (the notify-on-pull mutation was confirmed to
  turn the assertion red, then restored).
- **Desktop `tsc` (main + renderer) → 0 errors** on the changed files.
- `check-ipc-parity` / `check-ipc-validation` still OK; register-consistency OK.

**Could NOT verify here (target-only, Rule 16 — this CLOSES A278):** on a running till, edit a
product/price/menu item on the web, and confirm the till adopts it within ~20s with **no restart**
(and that an in-progress cart is unaffected).

## Rollback (Rule 2)

```bash
git checkout c7bbc52 -- apps/desktop/src/main/index.ts apps/desktop/src/main/preload.ts \
  apps/desktop/src/renderer/lib/posApi.ts apps/desktop/src/renderer/pages/POSPage.tsx docs/AUDIT-REGISTER.md
rm -f tests/catalogue-refresh.test.mjs
```

## Commit (direct to dev, explicit paths — never `git add -A`; NO package.json)

```bash
git checkout dev && git pull                     # confirm c7bbc52
git add apps/desktop/src/main/index.ts apps/desktop/src/main/preload.ts \
        apps/desktop/src/renderer/lib/posApi.ts apps/desktop/src/renderer/pages/POSPage.tsx \
        tests/catalogue-refresh.test.mjs docs/AUDIT-REGISTER.md docs/MANIFEST-2026-09-21-n.md
git status --short                               # expect exactly these seven
node tests/catalogue-refresh.test.mjs && node scripts/check-register-consistency.mjs
git commit -m "feat(desktop): A278 live catalogue refresh — web edits reach a running till in ~20s, no restart"
git push
```

Ships in the next desktop release (e.g. v0.6.2) — it's a desktop change, so tills get it on
auto-update, and it's verifiable the moment a web edit lands on a running till.
