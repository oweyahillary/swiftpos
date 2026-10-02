# MANIFEST 2026-10-02-c — a client's own sign-in address with their logo (A378)

**Base:** origin/dev `c67b259`. **Delivered as:** `swiftpos-2026-10-02-tenant-signin.patch`. **Migration 114** (applied by
the production migrate run on merge to main). **Cloud + web only — no till update, no version bump** (stays 0.6.32).

Owner, 2026-10-02: "is there a way we can customize each client to use their subdomain eg africanfries … to log in we can
even add their logo on the sign in page". Decisions: a field of its own (not the QR menu name); on a client's address only
that client's people sign in; SwiftPOS sets it in the admin portal.

## What changes
- **Admin portal › client › Overview › Sign-in address:** set `africanfries` → the client signs in at
  `https://africanfries.<root>`. Change or clear it the same way. Reserved names (app, www, admin, api, mail, send, …)
  and an address another client has are refused.
- **On that address**, the dashboard sign-in (`/login`) and the web POS sign-in (`/pos`) show the client's logo (Settings ›
  Branding) and name in their accent colour, and admit only that client's owner and staff — anyone else: "Not this
  business" (dashboard) or "Invalid email or PIN" (web POS). An address no client has: "This address is not set up".
- The main address, the till and every client without an address: unchanged.

## Files
NEW `migrations/114_business_subdomain.sql`, `scripts/test-migration-114.mjs` (6), `shared/tenantHost.ts` (+ copies in
`apps/server/src/lib`, `apps/dashboard/src/lib`, `apps/admin/src/lib`; `scripts/check-shared-sync.mjs`),
`apps/server/src/lib/tenant.ts`, `apps/server/src/routes/tenant.ts`, `apps/dashboard/src/lib/tenant.ts`,
`apps/dashboard/src/components/TenantBrand.tsx`, `tests/tenant-signin.test.mjs` (16). CHANGED
`apps/server/src/routes/auth.ts` (/login, /pos-login), `routes/admin.ts` (PATCH + detail), `routes/index.ts`,
`src/index.ts` (CORS), `lib/env.ts`, `lib/schemas.ts`, `.env.example` (server + dashboard),
`apps/dashboard/src/pages/LoginPage.tsx`, `pages/pos/POSLoginScreen.tsx`, `apps/admin/src/AdminPortal.tsx`,
`scripts/schema-index.json`, `docs/AUDIT-REGISTER.md` (A378), this file.

## Rollout (owner)
1. Apply, commit, push to dev; CI green. Merge to main; the production migrate run applies 114 (green).
2. Deploy the cloud (Render), the dashboard and the admin portal (Vercel). Nothing changes yet — the feature is off.
3. When the domain is bought (e.g. `swiftpos.co.ke`):
   - Render: `TENANT_ROOT_DOMAIN=swiftpos.co.ke`. Vercel (dashboard project): `VITE_TENANT_ROOT_DOMAIN=swiftpos.co.ke`,
     then redeploy the dashboard (VITE_* values are baked in at build).
   - DNS: a wildcard record `*.swiftpos.co.ke` pointing at Vercel, and add `*.swiftpos.co.ke` as a domain on the
     dashboard's Vercel project (Vercel asks for the domain's nameservers to be on Vercel for a wildcard).
   - The email records (Resend / SendGrid) are separate names and do not clash with the wildcard.
4. Admin portal: set a test client's address, open `https://<it>.swiftpos.co.ke/login` — the logo and name show; the
   owner signs in; an owner of another client is refused; `/pos` shows the same and a cashier signs in with email + PIN.
