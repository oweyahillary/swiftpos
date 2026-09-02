# MANIFEST 2026-09-01-f — A187 void 500 fix + A191 real fix (remove /kds realtime)

**Base:** dev @ fba45bb. **Cumulative** over `-d` (A144) + `-e` (A3): applying this brings
all of them. **Includes a file DELETION** — see below.

## A187 — Void 500 (schema FK)
`orders.voided_by` FKs to `auth.users(id)`; `refunded_by`/`authorized_by` FK to
`public.users(id)`. The handler writes `req.userId` (a public.users id), so void 500'd
while refund worked. Migration re-points `voided_by` → `public.users(id)`.

## A191 — owner logged out by /kds (real fix)
6th reproduction; the earlier "isolated realtime client" fix did NOT work. `ProtectedRoute`
gates on the Supabase GoTrue session, and the only thing /kds touches on a Supabase client
is realtime (which never delivered under RLS). Fix: remove the realtime subscription; /kds
runs on the 10s poll, new-ticket alert poll-driven. No Supabase interaction on /kds.

| File | Change |
|---|---|
| `migrations/96_orders_voided_by_fk.sql` | **NEW.** voided_by FK → public.users. **PROD-MIGRATE.** |
| `apps/dashboard/src/pages/kds/KDSPage.tsx` | Remove realtime subscription; 10s poll; poll-driven beep/flash. |
| `apps/dashboard/src/lib/kdsRealtime.ts` | **DELETE** — `git rm apps/dashboard/src/lib/kdsRealtime.ts` (now unused; unzip can't remove it). |
| (carried) `products.ts`, `ProductsPage.tsx` (A144 -d), `kitchen.ts` (A3 -e) | From -d/-e. |
| `docs/AUDIT-REGISTER.md`, `docs/MANIFEST-2026-09-01-{d,e,f}.md` | Notes + manifests. |

## Verification (rule 7)
```
apps/dashboard: npm run build   → exit 0 (kdsRealtime removed, no unused refs)
apps/server: tsc --noEmit       → exit 0
check-schema-drift              → OK (FK change not tracked in snapshot)
check-register-consistency / doc-refs → OK
```
NOTE: the void-500 fix is a schema change — verified by prod-migrate + browser retest.

## Apply
```
unzip -o <zip> -d .
git rm apps/dashboard/src/lib/kdsRealtime.ts          # important: remove the orphan
DATABASE_URL="<db>" node scripts/migrate.mjs           # applies migration 96
cd apps/dashboard && npm run build && cd ../..
```

## Browser-confirm
- A187: void an old order → succeeds (no 500), order moves to voided.
- A191: use /kds → return to dashboard → STILL LOGGED IN.
- A3: ring an order → ticket appears on /kds within ~10s.

## Rollback
Migration: `ALTER TABLE public.orders DROP CONSTRAINT orders_voided_by_fkey; ALTER TABLE public.orders ADD CONSTRAINT orders_voided_by_fkey FOREIGN KEY (voided_by) REFERENCES auth.users(id) ON DELETE SET NULL;`
Files: `git checkout fba45bb -- apps/dashboard/src/pages/kds/KDSPage.tsx docs/AUDIT-REGISTER.md && git checkout fba45bb -- apps/dashboard/src/lib/kdsRealtime.ts && rm migrations/96_orders_voided_by_fk.sql docs/MANIFEST-2026-09-01-f.md`
