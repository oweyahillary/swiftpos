# MANIFEST 2026-10-01-b — the release number on every website and the cloud

**Base:** origin/dev `47a86c9` (v0.6.28). **Delivered as:** `swiftpos-2026-10-01-release-number.patch`. Website and cloud only — the
till is unchanged, so **no new tag**: it ships with v0.6.28 (deploy the cloud, the dashboard and the admin portal).

Owner, 2026-10-01: "can we add versioning on the website also so that i can tell which one i am running?"

## What you see
- **Dashboard** (sidebar, under Sign out), **web POS** (bottom of the ☰ drawer), **login page**, **admin portal** (sidebar, under
  Sign out): `SwiftPOS v0.6.28 · 47a86c9` — the release, and the commit Vercel built.
- Under it, `cloud v0.6.28 · abc1234` — the cloud's release and the commit Render built (`GET /api/version`).
- **Amber** "not the same release as this website" when the two differ: one was deployed, the other not yet.
- The till already shows its version (sign-in screen / manager screen); it is the same number.

## The rule
`shared/release.ts` holds `RELEASE`. It must equal `apps/desktop/package.json`'s version — bump both in the release commit (CI fails
`tests/release-version.test.mjs` otherwise). The commit comes from the host (Vercel: `VERCEL_GIT_COMMIT_SHA`; Render:
`RENDER_GIT_COMMIT`); a local build shows the release alone.

## Files
NEW `shared/release.ts` (+ copies in `apps/server/src/lib`, `apps/dashboard/src/lib`, `apps/admin/src/lib`; `check-shared-sync`),
NEW `apps/server/src/routes/version.ts` (+ `routes/index.ts`), NEW `apps/dashboard/src/components/ReleaseBadge.tsx`,
`DashboardLayout.tsx`, `pages/pos/POSDrawer.tsx`, `pages/LoginPage.tsx`, `main.tsx`, `index.css` (light-colours regenerated),
`apps/admin/src/AdminPortal.tsx`, `vite.config.ts`, `vite-env.d.ts`, NEW `tests/release-version.test.mjs` (8; 3 mutations bite),
`docs/AUDIT-REGISTER.md`, this file.

## Verification (bench)
release-version 8/8 · every cloud suite 150/150 (as CI) · every gate · typecheck ratchet · server, dashboard and admin builds.
