# MANIFEST 2026-09-07-ad — A267: refresh-token fallback (ROOT fix for the 401 cascade)

**Base:** origin/dev @ caabdc7. **Web-only (dashboard).** One-line auth fix. No server, no migration.

## Why (root cause)
Console: `401 Unauthorized` on /api/business, /api/pos/init, /api/tables, /api/shifts/current,
/api/promotions/active — all `api`-client calls. The client refreshes on 401, and A260 made the
ACCESS-token lookup fall back to any stored token — but the REFRESH-token lookup
(`getStoredRefreshToken`) stayed surface-keyed. A manager on the dashboard surface has
`refreshKey()` = the absent OWNER refresh token, so refresh threw "No refresh token"; once the
POS access token expired, every call 401'd. That is the real cause of `useBusiness()` being null
(blank receipt A266, "SwiftPOS" documents A260) — the /api/business fetch fallbacks 401'd too.

## Fix
`getStoredRefreshToken()` falls back to whichever refresh token exists (the POS one the manager
holds), mirroring A260 for the access token. Refresh then succeeds → the access token renews →
the 401 cascade stops.

## Files
| File | Change |
|---|---|
| `apps/dashboard/src/lib/api.ts` | refresh-token fallback |
| `tests/pos-cart-parity.test.mjs` | guard (7) |
| `docs/AUDIT-REGISTER.md` | A267 entry |
| `docs/MANIFEST-2026-09-07-ad.md` | this manifest |

## What ran (rule 7)
```
tests/pos-cart-parity.test.mjs -> 7/7 ; esbuild transpile api.ts -> clean ; gates green
```
NOT verified here (rule 16): a live session past the access-token TTL on the till — the
definitive check is: keep the POS open past ~token expiry and confirm no 401s (business, tables,
receipt all keep working).

## Apply
Extract over repo root; `node --test tests/pos-cart-parity.test.mjs` -> 7 green; gates; deploy
the dashboard. The POS should no longer 401 after the access token expires.
