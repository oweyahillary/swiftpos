# MANIFEST 2026-09-04-e — A201: export download refresh-retry on 401

**Base commit:** the `-d` (A203) tip. **This batch stacks on `-d`** — apply `-d` first (or apply the
combined 4-patch sequence delivered together). **Scope:** one dashboard file + register.
**Working rules:** unchanged — `HANDOFF-2026-08-08-evening.md §0`.

## Fix
`downloadFile` (the A143 authed export helper) did a single fetch, so the first export click right
after a page load — before the access token is hydrated/refreshed — could 401. It now mirrors
`api.request()`: on a 401 with a stored token it `refreshAccessToken()`s and retries once (guarded by
`isRetry` so it can't loop); a failed refresh signals session-expiry.

| File | Change |
|---|---|
| `apps/dashboard/src/lib/api.ts` | `downloadFile(path, filename, isRetry=false)` — 401 → refresh → retry once. |
| `tests/download-401-retry.test.mjs` | 3 mutation-checked checks (isRetry guard; refresh+retry; sign-out on refresh-fail). |
| `docs/AUDIT-REGISTER.md` | A201 FIX BUILT. No count change (stays OPEN P3 pending re-check). |

## Verification (rule 7)
- `apps/dashboard` tsc 0 + `vite build` exit 0.
- `tests/download-401-retry.test.mjs` 3/3, mutation-checked (remove the retry → red).
- register/doc/test gates green.

**Could NOT verify here:** the race in the browser (it was intermittent / not reproducible in the QA
run). The fix is defensive and mirrors the proven request() path.

## Rollback
```
git checkout <base> -- apps/dashboard/src/lib/api.ts docs/AUDIT-REGISTER.md
rm tests/download-401-retry.test.mjs docs/MANIFEST-2026-09-04-e.md
```
