# HANDOFF — 2026-09-17 evening

Working rules unchanged: see HANDOFF-2026-08-08-evening.md §0 (rules 1-24). The
register (docs/AUDIT-REGISTER.md) wins over any handoff if they disagree.

Branch: `dev`  ·  HEAD: `63dcdd2`  ·  desktop version: **0.5.43** (tag `v0.5.43`)
Cloud (test): `swiftpos-20c2.onrender.com` (Render, from `dev`) · web from `main` (Vercel).
Test business: "B Foods" / branch "Mama Ngina".

---

## 0. Goal

Close the desktop punch-list (D-items + open printing/desktop A-items), then handle
several live issues the owner surfaced during trade-testing, plus scope two new
features. Priority through the session: get the desktop trustworthy end-to-end.

## 1. Current state

Everything below is committed to `origin/dev` and verified BY CONTENT at HEAD
`63dcdd2`. 0.5.43 is tagged; the on-till verification of that build is the only
open confirmation.

Closed on target (real Windows till, this + prior session):
- **D3** — auto-update self-updated 0.5.40 -> 0.5.41 on quit; dev flavour offered nothing.
- **D4** — enrolment code redeemed, branch bound, single-use burn confirmed.
- **D18** — full `st2.` token pasted at reveal, reached token step, tech session opened.

Fixed + committed, awaiting on-till confirm on 0.5.43:
- **A276** — soda-on-kitchen was a STALE BUILD (A281), not a code bug. Current code
  routes standalone drinks to dispatch; mutation-checked test added and green on
  Windows (shared/printing). Live print confirm still pending a printer.
- **A282** — removed a dangling `nsis.include` that broke the first release build.
- **A283** — committed the real `build/installer.nsh` (branch-node firewall rule,
  TCP 4100-4103 private) past `.gitignore` and restored the include.
- **A284** — per-flavour `extraMetadata.productName` so dev/prod get separate
  `%APPDATA%` (SwiftPOS vs SwiftPOS Dev) and separate `swiftpos.db`. Ends the
  shared-folder bug.
- **A288** — `win.target` reduced to `['nsis']`; stops the duplicate portable draft
  per tag. (One draft per release now.)
- **A289 (revised)** — window title is a pure flavour gate: PROD never shows the
  cloud host (clean client title), DEV always shows it. `PROD_CLOUD_HOSTS` removed.
- **A290** — desktop Overview no longer blanks when one KPI query throws:
  `getTableOccupancy` fail-soft + renderer uses `Promise.allSettled`.
- **A293** — Overview still showed 0 after A290 because `getSalesSummary` itself
  rejected when a sibling sub-query (payments JOIN / hourly) threw on a migrated
  schema, taking the revenue row down too. Isolated payments + hourly (revenue row
  always returns); `getTopProducts` fail-soft.
- **A291** — instant web->till propagation: server `GET /api/pos/catalogue-version`
  (cheap freshness signal) + desktop 20s `pullIfCatalogueChanged` poll that pulls
  only when the version moved; 10-min full pull kept as the floor.

Resolved (data / config):
- **A285** — orders rung 2026-09-16 were absent from cloud; root cause a STALE OPEN
  SHIFT (see A287) blocking sync. Closed the shift; orders recovered (cloud shows
  KES 2,780 that day). Recurrence prevented by A284.

Scoped, NOT built:
- **A295** — client branding, both phases. Full spec: `docs/SCOPE-A295-branding.md`.

## 2. Active files (touched this session)

- `apps/desktop/electron-builder.config.js` — A283 include, A284 extraMetadata, A288 nsis-only.
- `apps/desktop/src/main/index.ts` — A289 flavour-gate title, A291 20s poll wiring.
- `apps/desktop/src/main/syncEngine.ts` — A291 `pullIfCatalogueChanged()`.
- `apps/desktop/src/main/managerReports.ts` — A290 `getTableOccupancy` soft, A293
  `getSalesSummary` sub-query isolation + `getTopProducts` soft.
- `apps/desktop/src/renderer/pages/ManagerPage.tsx` — A290 `Promise.allSettled`.
- `apps/desktop/build/installer.nsh` — A283 (now committed).
- `apps/server/src/routes/pos.ts` — A291 `/api/pos/catalogue-version` endpoint.
- `shared/printing/test/a276-soda-routing.test.ts` + `package.json` — A276 test.
- `.gitignore` — A283 un-ignore of the installer script.
- `docs/AUDIT-REGISTER.md` — entries (see §5 note).
- `docs/SCOPE-A295-branding.md` — new.
- `docs/MANIFEST-2026-09-16-*.md`, `docs/MANIFEST-2026-09-17-*.md` — delivery manifests.

## 3. Changes made — the reasoning trail

- The whole printing/Overview thread hinged on one environment fact: dev and prod
  packaged flavours shared `%APPDATA%\SwiftPOS` (static `productName`), so a
  migrated/old-schema local db caused report sub-queries to throw. A284 fixed the
  isolation; A290 + A293 made the report queries fail-soft so one bad sibling table
  can't blank the whole Overview.
- A276 turned out to be a stale front-end (A281 branch split), proven by a
  mutation-checked test rather than a code change.
- A291 reuses the same freshness mechanism for branding sync later (A295).

## 4. Failed attempts / dead ends (so they're not repeated)

- **Diagnosed A276 as a data/status/routing bug several times before the truth.**
  Sequence that did NOT hold: category `is_kitchen` (all false), `category_stations`
  (none), combo `is_kitchen`, order status set. Actual cause = stale build.
- **Overview zero misattributed twice**: first to the shared render catch (A290 —
  real but not the whole cause), then to a status/range mismatch (wrong — cloud +
  local both `completed`, window correct). Real cause = `getSalesSummary` sibling
  sub-query throw (A293). Lesson: with `allSettled`, an empty KPI card means the
  top-level call REJECTED; look inside it for an unguarded sibling query.
- **`npm version patch` does not commit/tag here** — it edits the file only. Use
  `npm version <x> --no-git-tag-version` then explicit `git tag` + `git push origin <tag>`.
  `git push --follow-tags` pushed nothing when the tag didn't exist.
- **First release failed** on a gitignored `build/installer.nsh` (A282/A283).
- **Every tag produced TWO draft releases** until A288 (portable target).
- **Draft releases are invisible to electron-updater** — must Publish the NSIS draft
  (the one with `latest.yml` + `.blockmap`), delete the portable duplicate.
- **`git add <file>` then commit repeatedly said "nothing to commit"** for the
  register — because the lines were never pasted into the file first.

## 5. Next steps

Do first (tonight / next session, no code):
1. **Publish the single 0.5.43 draft** (the one carrying `latest.yml` + `.blockmap`).
   Let the till auto-update. Then confirm on-till:
   - ONE release draft (A288), prod title has NO url (A289), Overview shows
     KES 21,870 / 6 / payment split (A293), a web product edit reaches the till in
     ~20s (A291 end-to-end, needs Render redeploy of the server half — it is committed).
2. **Kitchen routing (config)**: on the cloud,
   `UPDATE categories SET is_kitchen = true WHERE name IN
   ('Burgers','Combos','Family Meals','Hot Sides','Sandwiches','Kids');`
   then Sync on the till and ring a cooked item — kitchen ticket should print
   (cooked only; no sodas/sauces). Adjust the cooked/cold split to the real menu.
3. **A276 live print** when a printer is available -> then CLOSE A276.
4. **Register hygiene**: the A291/A293/A289/A295 lines were APPENDED to the bottom of
   docs/AUDIT-REGISTER.md. Re-home them into §A and run `check-register-consistency`
   so the header counts stay honest. (Rule 14 is satisfied; ordering is not.)

Skipped on purpose (do NOT do late/tired):
- **A295 branding build** — big, multi-surface; build Phase 1 before Phase 2, both
  after this queue clears. Spec is ready.
- **A291 v2 triggers** — a prod DB migration (adds `updated_at` triggers to
  `category_stations`, variant_*, modifier_*, `combo_items` for full sub-30s
  coverage). Run deliberately through the db-migrate-prod flow, not at night.
- **A287** — surface the shift-rejection reason on the till sync panel; disambiguate
  the order-number 409 from the device-branch 409 (`checkDeviceBranch`, orders.ts);
  investigate the always-expired device-token refresh cadence; add a keepalive to
  the Render NODE (the DB has one, the API does not — cold-start is the "sync takes
  long" cause). Real debugging, its own session.

Proposed (owner input needed):
- **A289 follow-up** — none needed now (pure flavour gate). If a prod-side wrong-cloud
  warning is ever wanted, add a one-time first-launch banner, not a title badge.
- **A294** — menu import should set `is_kitchen` on cooked categories so a new
  business does not hit the blank-kitchen surprise. Fix in the importer.
- **A295 inputs** — curated ACCENT set (Phase 1) and curated THEME set (Phase 2),
  ~6-8 each, owner-supplied; contrast-vetted at authoring. Confirm logo constraints
  and that business-scope (not per-branch) is enough for Phase 1 launch.
- **Prod cloud host** — when provisioned, that same web app hosts the branding
  upload UI (A295).

## 6. Environment note (rule 9)

All code this session was authored + syntax/type-checked on a Linux bench (external
imports resolved only in CI). The A276 test is the sole item RUN green on Windows.
Nothing above is a verified on-target green except D3/D4/D18 and A285's data recovery
— 0.5.43 is the build that turns the rest from FIX BUILT into CLOSED.
