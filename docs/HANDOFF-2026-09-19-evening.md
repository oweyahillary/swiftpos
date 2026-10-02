# HANDOFF — 2026-09-19 evening

Working rules unchanged: see HANDOFF-2026-08-08-evening.md §0 (rules 1-24). The
register (docs/AUDIT-REGISTER.md) wins over any handoff if they disagree.

Branch: `dev`  ·  HEAD: `402ca5a`  ·  desktop version: **0.5.49** (NOT tagged — see §5)
Cloud: Render (API) + Vercel (web), main=production, dev=development. Prod is BEHIND
dev on migrations (see A280 in §1). Test business: "B Foods" / branch "Mama Ngina" — single till.

---

## 0. Goal

With the desktop close-out done (2026-09-18), take the backlog rocks that DON'T need the
two-till rig — **A281** (deploy branch-flow) and **A280** (a clean rebuild not reproducing
production, the DR risk) — plus the quick **rule-21 rename** and README fix, and get **A295**
client branding scoped to build-ready. A19 §3 stays deferred (needs the rig).

## 1. Current state

All on `origin/dev` at `402ca5a`, all repo gates green, working tree LF (patches apply with
plain `git apply` now — the CRLF fix from yesterday held all session).

- **A281 — FIX BUILT.** Web build stamp shipped: `vite define` injects commit SHA/branch/time,
  shown on the login footer + logged on boot (so a lagging web is a glance). SETUP clarified by
  owner: there are TWO Vercel projects — production tracks `main` (always fine), development
  tracks `dev`; the only friction was the DEV project needing a MANUAL promote, which the owner
  fixed (dev project now auto-tracks `dev`). Real production was never split. Closes on one
  confirmation: a dev push auto-refreshes the dev URL's stamp.
- **A280 — FIX BUILT (bench); prod verify done; closes on the next prod deploy.** Reproduced the
  rebuild failure in pglite (0 migrations failed, all 7 items absent). Three causes: (1) six
  columns migrations 58/60 declared inside `CREATE TABLE IF NOT EXISTS` that skipped because
  44/baseline already made the tables → **migration 103** adds them idempotently
  (category_stations add-nullable → backfill → SET NOT NULL, safe on the seeded table); (2)
  `ingredients.current_stock` — not drift, migration 98 drops it; the schema-index entry was
  stale → **removed**; (3) `schema_migration_runs` — not drift, `migrate.mjs` bootstraps it.
  Bench-verified: replay + 103 matches the corrected index for all 7. **PROD VERIFY** (owner ran
  verify-db-schema vs prod): prod is BEHIND on migrations — 97, 98, 101, 102 unapplied, plus the
  6 columns (103). Every prod-missing item maps to an unapplied migration; no new skip-gap.
  fuel_tanks/parking_sessions confirmed EMPTY on prod → 103 safe. See §5 to close.
- **A300 — FIX BUILT.** Rule 21: `getServerUrl()` → `getCloudUrl()` (function + all 20 call
  sites across 5 desktop files; `server_url` COLUMN kept + commented). README "77 migrations" →
  99. Desktop bumped to 0.5.49. NOT tsc'd on the bench (CI does not type-check the desktop) —
  run `build:all` before any release.
- **A295 — spec refined, still OPEN/scoped, build-ready.** Reviewed two real client logos
  (Taste Town — bright yellow, solid black artwork; KUDO KUDO — red + gradient, white bg). Added
  to SCOPE-A295-branding.md: a contrast-vetted 8-accent palette, an ADAPTIVE button-text rule
  (black/white by accent luminance, so a bright brand colour is usable legibly), logo-on-a-chip
  for the dark lock screen + a MANDATORY receipt preview for mono, and both clients as worked
  examples. Build after prod provisioning for the web upload page; desktop half can start anytime.
- **isNodeRole (managerReports.ts:145) — FALSE ALARM, retracted.** The `role` var is normalised
  through `isNodeRole()` (node OR office), so `coversBranch = role === 'node'` correctly includes
  office. Code is correct; yesterday's flag misread it. No change made.

## 2. Active files (touched this session)

- Web/dashboard (A281): `apps/dashboard/vite.config.ts`, `src/main.tsx`, `src/pages/LoginPage.tsx`,
  `src/vite-env.d.ts`.
- Desktop (A300): `apps/desktop/src/main/{deviceConfig,syncEngine,index,techService,ipcHandlers}.ts`;
  `apps/desktop/package.json` (0.5.48 → 0.5.49).
- DB (A280): `migrations/103_reconcile_a280_columns.sql` (new); `scripts/schema-index.json`.
- Docs: `docs/AUDIT-REGISTER.md` (A281/A280/A300 entries + A295 changelog + Tree line v0.5.49);
  `docs/SCOPE-A295-branding.md` (addendum); `README.md` (count); per-delivery manifests
  `docs/MANIFEST-2026-09-19-a.md`, `docs/MANIFEST-2026-09-19-b.md`, `docs/MANIFEST-2026-09-19-c.md`.

## 3. Changes made — the reasoning trail

- **A281**: the "till-picker missing" pain was the dev web lagging the dev API during testing,
  because the dev Vercel project needed a manual promote. The build stamp makes any future lag a
  glance; the owner's dashboard change removed the manual step. Real prod was never the problem.
- **A280**: reproduced before touching anything (pglite replay), which turned the register's note
  into fact and separated the three causes. Chose an additive reconcile migration over the
  register's "regenerate baseline from a prod snapshot" — no prod dump needed, immutable history,
  no-op on prod where columns exist. Prod verify then showed prod is simply behind on migrations.
- **A300**: pure mechanical rename; verified 0 `getServerUrl` remain, 20 `getCloudUrl`.
- **A295**: two real logos drove two spec upgrades — adaptive button text (so yellow works with
  black text) and logo-on-a-chip (so a light-bg logo survives the dark screen). Vetted the palette
  with actual WCAG contrast math.

## 4. Failed attempts / dead ends (so they're NOT repeated)

- **A280 pglite replay** first died — the baseline needs Supabase roles/extensions and one error
  aborts the pglite transaction. Fixed by reusing `check-api-schema-drift`'s preamble (create
  auth/extensions/roles) + ROLLBACK-after-each-failure. Reuse that harness for any local replay.
- **A281 register note — three wrong versions** before it was right: "Vercel=main" (imprecise) →
  "Option 1, Vercel dev manual promote" → the correct "TWO Vercel projects; dev project needed the
  promote." I mis-modelled the deploy topology from partial info twice; the owner's screenshot +
  explanation corrected it. Lesson: get the actual dashboard/topology from the owner, don't infer.
- **Patch collisions**: rebuilt the A281 register patch several times because deliveries interleaved
  with the owner's applies and a superseded patch got applied first. Lesson (now habit): always
  rebuild against the CURRENT `origin/dev` and `git apply --check` before sending.
- **Wrong assumption caught by prod verify**: I had assumed prod already had the six A280 columns
  (so 103 would be a no-op). Prod verify showed prod LACKS them and is behind on migrations. Good
  that A280 required a prod check before closing rather than trusting the index.
- **isNodeRole**: flagged as a bug on 2026-09-18, verified correct and retracted today.

## 5. Next steps

Do first — **close A280 (a deliberate prod release):**
- Merge `dev → main` so the prod (Render/main) deploy runs `migrate.mjs`, applying 97, 98, 101,
  102, 103 in order → prod catches up.
- It's a FULL prod release of everything accumulated on dev — **take a prod backup first, review
  dev-vs-main, then merge and watch the migrate step.** Migration 98 DROPS a column, so it is
  coupled to the reader-free code and must go via the deploy (not migrate-only).
- Re-run `verify-db-schema` against prod after → green → **A280 CLOSED.**

Then — **A295 build (client branding), when picked up:**
- Desktop half needs no prod: local `branding` table + `PinPage` two-column reflow + accent +
  adaptive-text/contrast guard + receipt mono raster; plus the migration + server CRUD.
- The **web upload page** (client picks accent / uploads logo) waits on **prod being provisioned**.
- Build order: SCOPE-A295-branding.md §10 + the addendum. Owner still to confirm: the 8-accent
  palette (or per-client colours — Taste Town yellow, KUDO red), logo constraints, business scope.
- Optional first: mock the two lock screens (Taste Town / KUDO) to eyeball "our look + their brand".

Deferred by design — **A19 §3** (offline-peer sales → cloud): needs the two-till rig; latent while
single-till. Plan in the A19 register entry + PHASE5 §3.

Quick confirmations (close already-shipped items):
- **A298** — build SHA on the desktop Tech screen. **A299** — force a renderer error + a sale, both
  appear in swiftpos.log. **A281** — a dev push auto-refreshes the dev web. **A300** — run
  `cd apps/desktop && npm ci && npm run build:all` once, expect `Packaging v0.5.49` (desktop tsc
  isn't in CI, so this is the proof the rename is complete before any desktop release).

## 6. Environment note (rule 9)

Linux bench, Node 22, no app `node_modules` (pglite + esbuild installed ad hoc). On the bench this
session: reproduced A280 (pglite replay), vetted the A295 palette (WCAG contrast math), ran all
repo gates. CANNOT build Electron, run desktop suites, or reach prod — desktop `tsc`/build, the
on-till confirmations, and the prod `verify-db-schema` are owner/CI. Delivery via patches, applied
from the owner's `../patch files/` folder; plain `git apply` works now (CRLF fixed 2026-09-18).

## 7. Process notes — what worked

- **Reproduce before fixing** (A280 pglite replay) and **verify prod-facing claims against prod**
  (the prod verify caught a wrong assumption). The index is not a substitute for prod.
- **Rebuild patches against current `origin/dev` + `apply --check` before sending** — killed the
  patch-collision churn once adopted.
- The anti-drift **Tree-line gate** caught my own 0.5.49 bump before it drifted — the guardrails are
  earning their keep. Keep the register matching reality.
