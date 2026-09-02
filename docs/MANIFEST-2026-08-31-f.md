# MANIFEST 2026-08-31-f — A187 Phase 2b: Void/Refund UI on the owner Orders page

**Base commit:** `189bfc2` (dev). **Cumulative** over `-b`..`-e`: applying this zip
over `189bfc2` brings A186 + the reconciliation + A187 Phase 1 (view) + Phase 2a
(server) + Phase 2b (this). Register is a full-file replace (idempotent).

## What changed
The owner Orders page gains per-order actions, gated on `orders.void`:
- **Void** on orders within the 30-minute window; **Refund** on completed sales past
  it (`actionFor()` mirrors the server rule).
- Each opens a **reason modal** (reason required) that POSTs to
  `/api/orders/:id/void` or `/:id/refund`. The owner self-authorises server-side
  (Phase 2a) — no PIN — and the audit trail (who + why) is recorded.
- On success the list refreshes; voided/refunded orders show their status and no action.

## Files
| File | Change |
|---|---|
| `apps/dashboard/src/pages/OrdersPage.tsx` | Add eligibility helpers, action state, submit handler, Action column + Void/Refund buttons, and the reason modal. |
| `docs/AUDIT-REGISTER.md` | A187 Phase 2b recorded — all phases built, pending browser. |
| `docs/MANIFEST-2026-08-31-f.md` | This file. |
| `apps/server/src/routes/orders.ts`, `tests/owner-void-refund.test.mjs` | Carried from Phase 2a (unchanged). |
| `apps/dashboard/src/App.tsx`, `components/DashboardLayout.tsx` | Carried from Phase 1 (unchanged). |
| `docs/MANIFEST-2026-08-31-{b,c,d,e}.md` | Included for tree completeness. |

## Verification (rule 7)
```
cd apps/dashboard && npm run build   → exit 0, "✓ built in 11.79s", OrdersPage 8.31 kB
node scripts/check-register-consistency.mjs → OK
node scripts/check-doc-refs.mjs             → OK
```
Env: Linux — the dashboard's real target is the Linux/browser build, so on-target.

## Could NOT be verified here (rule 16 — browser)
As owner → Finance → Orders:
- **Void** a fresh order → reason required, no PIN, order drops from sales, list refreshes.
- **Refund** an older completed order → reason required, sale stays with a reversal.
- Confirm the reason + your name are recorded (expand the order / voids report).
- Confirm Void/Refund buttons are hidden for a role without `orders.void`.
- Clear `ORD-MTH76LLB-001WV` via **Refund** (it's past the void window).

## Rollback
Before commit: `git restore apps/dashboard/src/pages/OrdersPage.tsx docs/AUDIT-REGISTER.md && rm docs/MANIFEST-2026-08-31-f.md`
After push: `git revert <sha> && git push origin dev`.

## Before you commit (rule 20)
```
cd apps/dashboard && npm run build
node scripts/run-all.mjs   # migration suite may false-red on Windows — A186
```
