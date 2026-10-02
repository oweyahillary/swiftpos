# MANIFEST 2026-09-17-b  (desktop surface — cumulative, supersedes -e)

**Base commit:** dev HEAD. Extract over project root `/c/swiftpos/pos`. Apply THIS
one and the desktop side is complete — it carries the still-pending A288/A289/A290
PLUS the A291 desktop half. Pairs with the server delivery 2026-09-17-a (deploy that
to Render first, or together). Bench typecheck clean on the edited lines; CI does the
full typecheck (rule 9).

## Files
- `apps/desktop/electron-builder.config.js` — A288 (nsis-only) + A284 (extraMetadata) + A283 (nsis.include).
- `apps/desktop/src/main/index.ts` — A289 (title host-gate by flavour) + A291 (20s
  pullIfCatalogueChanged poll alongside the 60s/10-min sync intervals).
- `apps/desktop/src/main/syncEngine.ts` — A291: pullIfCatalogueChanged() — GETs
  /api/pos/catalogue-version, and runs syncAll() only when the version moved since the
  last successful pull. Fail-soft; reuses syncAll's in-flight/offline guards.
- `apps/desktop/src/main/managerReports.ts` — A290 (getTableOccupancy fails soft).
- `apps/desktop/src/renderer/pages/ManagerPage.tsx` — A290 (Promise.allSettled Overview).
- `docs/MANIFEST-2026-09-17-b.md` — this manifest.

## End-to-end deploy + test (the whole A291 feature)
1. SERVER (2026-09-17-a): commit + push dev → Render redeploys → curl
   /api/pos/catalogue-version returns a timestamp.
2. DESKTOP: apply this, commit, then cut the build (this is also D3 release 0.5.42):
       cd apps/desktop && npm version 0.5.42 --no-git-tag-version && cd ../..
       git add -A && git commit -m "desktop 0.5.42 — A288/A289/A290 + A291 poll"
       git tag v0.5.42 && git push origin dev && git push origin v0.5.42
   Publish the SINGLE draft (A288), install/auto-update the till to 0.5.42.
3. TEST end-to-end: on the web, edit a product price/name (or add one). Within ~20s
   the till's catalogue reflects it WITHOUT a manual sync or the 10-min wait. Also
   confirm on the till: Overview now shows sales (A290), title host gated (A289),
   ONE release draft (A288), %APPDATA%\SwiftPOS vs SwiftPOS Dev split (A284).

## Rollback
    git checkout -- apps/desktop/electron-builder.config.js apps/desktop/src/main/index.ts \
      apps/desktop/src/main/syncEngine.ts apps/desktop/src/main/managerReports.ts \
      apps/desktop/src/renderer/pages/ManagerPage.tsx
    # after commit: git revert <sha>

## Register (rule 14)
    A291 → FIX BUILT — instant web→till propagation: server /api/pos/catalogue-version
    (2026-09-17-a) + desktop 20s pullIfCatalogueChanged poll that pulls only on change;
    10-min floor retained. v1 covers trigger-backed tables; v2 (triggers for
    category_stations/variants/modifiers/combos) pending. Awaiting end-to-end on 0.5.42.
    A289/A290/A288/A284/A283 → as previously logged; confirm on 0.5.42.

## Not carried (rule 22)
- No package.json / version (the 0.5.42 bump is a separate commit at build time).
- Server file (pos.ts) ships in 2026-09-17-a — different deploy target (Render).
