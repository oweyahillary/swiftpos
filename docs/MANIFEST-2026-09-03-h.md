# MANIFEST 2026-09-03-h — A143 exports auth fix + A200 (test-email leak) + register closes

**Base commit:** `f925cee` (`dev`). **Scope:** dashboard + one server route + register.
**Working rules:** unchanged — `HANDOFF-2026-08-08-evening.md §0`.

## Code changes
| File | Change | ID |
|---|---|---|
| `apps/dashboard/src/lib/api.ts` | New authed `downloadFile(path, filename)` — fetches with the auth + branch headers and saves the blob. | A143 |
| `apps/dashboard/src/pages/ReportsPage.tsx` | All 8 exports (Exports hub + Sales/Hourly/Item-Mix per-tab) now use `downloadFile` instead of `window.open` (which sent no token → 401). Hub gains busy/error state. Removed the now-unused `API_URL` import. | A143 |
| `apps/server/src/routes/notifications.ts` | `test-email` no longer returns the raw mailer diagnostic to the client; it `console.error`s it server-side and returns a clean generic message. | A200 |
| `tests/reports-export-auth.test.mjs` | 5 mutation-checked guard checks (downloadFile carries auth; no `window.open` export remains; no `result.error` to the client). | A143, A200 |

## Register changes
- **CLOSED (browser-verified, 2026-09-03):** A192, A195, A194, A193, A190, A185 — from the QA pass.
- **A200 opened + FIX BUILT** — the Send-test-email debug-info leak (SMTP ports / Render plan /
  "CHECK THE LIVE INSTANCE TYPE" surfaced to the UI).
- **A143** — Inventory tab verified PASS; the exports auth fix is FIX BUILT (stays OPEN pending a
  browser re-check that each .xlsx downloads).
- **A146** — webhook delivery log confirmed already built (batch -j, needs an endpoint to show data);
  leak split to A200; **email delivery stays OPEN, tracked under A54** (needs a verified sending
  domain — owner buying one, finishing email last).
- **A188** — stays OPEN: QA saw a tappable grid but on a branch with a real (grid-shaped) layout;
  the true no-layout fallback wasn't exercised.
- Counts: A-P2 18→15, A-P3 6→4.

## Verification (rule 7)
- `apps/dashboard` `tsc` 0 errors, `vite build` exit 0; `apps/server` `tsc` 0 errors.
- `tests/reports-export-auth.test.mjs` 5/5, mutation-checked.
- `check-register-consistency` (164 entries, header agrees with body), `check-doc-refs`,
  `check-test-registration`, `check-root-clean`, `check-api-routes` — green.

**Could NOT verify here (rule 7):** the browser — each export downloading a non-empty .xlsx, and the
clean test-email error message. Those are the re-check that closes A143 and A200.

## Rollback
```
git checkout f925cee -- apps/dashboard/src/lib/api.ts apps/dashboard/src/pages/ReportsPage.tsx apps/server/src/routes/notifications.ts docs/AUDIT-REGISTER.md
rm tests/reports-export-auth.test.mjs docs/MANIFEST-2026-09-03-h.md
```
