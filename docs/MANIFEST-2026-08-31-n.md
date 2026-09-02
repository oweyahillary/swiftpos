# MANIFEST 2026-08-31-n — A3 fault 1 (KDS per-branch token) — server slice

**Base commit:** `189bfc2` (dev). Server only, additive. No DB, no migration.

## What
Option (a): a per-branch KDS display token so the headless `/kds` screen can
authenticate. It's a long-lived (365d), branch-scoped SwiftPOS JWT marked
`surface:'kds'`, confined to the kitchen router.

| File | Change |
|---|---|
| `apps/server/src/routes/kitchen.ts` | `POST /kds-token` (owner-only, branch-validated) mints the token. Router now accepts a `surface:'kds'` token (branch derived from it) and delegates every other caller to `requireAuth`. |
| `apps/server/src/middleware/auth.ts` | `requireAuth` rejects `surface:'kds'` (403) — a KDS token is valid only on the kitchen router, so a leak can't read orders/payments/etc. Placed before the `!isOwner` user lookup (a kds token has no userId). |
| `tests/kds-token.test.mjs` | **NEW.** Guard test: token minted (owner-only, branch-scoped, surface:kds), accepted on the kitchen router, confined elsewhere. |
| `docs/AUDIT-REGISTER.md` | A3: fault-1 server slice recorded. |
| `docs/MANIFEST-2026-08-31-n.md` | This file. |

## Verification (rule 7)
```
apps/server: ./node_modules/.bin/tsc --noEmit      → exit 0
node tests/kds-token.test.mjs                        → 3/3, all green
  MUTATION: drop the confinement in auth.ts → 1 FAILED; restore → green (rule 23)
node scripts/check-api-routes.mjs                    → OK (284 calls)
node scripts/check-test-registration.mjs             → OK (test discovered)
node scripts/check-register-consistency.mjs / doc-refs → OK
```
Additive: existing tokens/behaviour unchanged; only a new token type + a new route.

## NOT in this slice (fault 1 client + fault 3)
- **Client (slice 2):** `/kds` must send the token (`Authorization: Bearer`) on its
  ticket fetches + status PATCH, and an owner "Generate KDS link" UI. Until then the
  display still 401s.
- **Realtime (fault 3):** after migration 95, live-verify whether events arrive on the
  anon subscription; if not, that's a separate follow-up (KDS still works on the 30s poll).

## Rollback
```
git restore apps/server/src/routes/kitchen.ts apps/server/src/middleware/auth.ts docs/AUDIT-REGISTER.md
rm tests/kds-token.test.mjs docs/MANIFEST-2026-08-31-n.md
```
