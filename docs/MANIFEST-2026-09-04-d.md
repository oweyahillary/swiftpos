# MANIFEST 2026-09-04-d — A203 stock-transfer "Mark received" fix + close A12/A202

**Base commit:** current `dev`. **Scope:** dashboard + one server route + register.
**Supersedes the earlier standalone A12/A202 close patch** — that never landed on `dev`; this batch
closes them (verified) alongside A203. Discard the old `Register: close A12 … A202` patch.
**Working rules:** unchanged — `HANDOFF-2026-08-08-evening.md §0`.

## A203 — the transfer-received bug (P2)
A single user despatching AND receiving a transfer (the common small-shop case) trips the server's
separation-of-duty guard (409 `same_user_receipt`). The frontend answered that 409 with a **native
`window.confirm()`**, which blocks the page and can't be dismissed by automation — so "Mark received"
appeared to **hang**, receipt never completed, and stock sat **debited at source / uncredited at
destination** (recoverable via Cancel, but reads as stranded). The status route also had **no
try/catch**, so any throw in the stock RPCs would hang the request in Express 4 regardless.

**Fix:**
- **Client:** an in-app confirmation **modal** replaces the native confirm — the same-user override is
  completed in-app (`advance(t, status, true)`), working for humans and automation.
- **Server:** the transfer status route is wrapped in **try/catch** → a failure returns 500 instead
  of hanging.

| File | Change |
|---|---|
| `apps/dashboard/src/pages/stock/StockTransfersPage.tsx` | Same-user modal state + JSX; `advance()` opens the modal instead of `window.confirm`. |
| `apps/server/src/routes/stock.ts` | Wrap `PATCH /transfers/:id/status` in try/catch → 500 on error, never a hang. |
| `tests/transfer-receive-hang.test.mjs` | 3 mutation-checked checks: no native confirm on the same-user path; modal completes the override; route wrapped. |
| `docs/AUDIT-REGISTER.md` | A203 opened + FIX BUILT; **A12 + A202 closed (verified)**; counts. |

## Register net
- **A12 → CLOSED** (Recipe-drawer live stock verified; migration 98 applied).
- **A202 → CLOSED** (owner Add-Ingredient button verified).
- **A203 → opened + FIX BUILT.**
- Counts: A-P1 17→16 (A12 out), A-P2 net 14 (A202 out, A203 in).

## Verification (rule 7)
- `apps/dashboard` tsc 0 + `vite build` exit 0; `apps/server` tsc 0.
- `tests/transfer-receive-hang.test.mjs` 3/3, mutation-checked.
- `check-register-consistency` (header agrees with body), `check-doc-refs`, `check-test-registration`,
  `check-root-clean`, `check-api-routes` — green.

**Could NOT verify here:** the browser — a single user completing Mark received via the modal, with
stock landing at the destination. That's A203's close check (re-run the A197 transfer verify).

## Land it (from repo root)
```bash
git checkout dev && git pull origin dev
git am 0001-*.patch 0002-*.patch
git push origin dev
```

## Rollback
```
git checkout <base> -- apps/dashboard/src/pages/stock/StockTransfersPage.tsx apps/server/src/routes/stock.ts docs/AUDIT-REGISTER.md
rm tests/transfer-receive-hang.test.mjs docs/MANIFEST-2026-09-04-d.md
```
