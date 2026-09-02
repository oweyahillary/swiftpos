# MANIFEST 2026-08-31-e — A187 Phase 2a: owner self-authorised void/refund (server)

**Base commit:** `189bfc2` (dev). **Cumulative** over `-b`/`-c`/`-d`: applying this
zip over `189bfc2` brings A186 + the 2026-08-31 reconciliation + A187 Phase 1 (Orders
view) + Phase 2a (this). The register is a full-file replace (idempotent).

## What changed
An owner (`req.isOwner`) voiding or refunding from the dashboard **self-authorises** —
no supervisor PIN — while the **audit trail is preserved**: `voided_by`/`refunded_by =
req.userId`, a required reason, and `authorized_by`/`refund_authorized_by` = the same
owner. The **cashier/till path is unchanged** (still requires the override PIN). Void
remains bounded by the existing 30-minute window; anything past it is a refund.

## Files
| File | Change |
|---|---|
| `apps/server/src/routes/orders.ts` | Void + refund handlers: add an `req.isOwner` self-authorise branch (skips PIN, sets `authorized_by = req.userId`). Non-owner branch untouched. |
| `tests/owner-void-refund.test.mjs` | **NEW.** Source-level guard test: owner bypass exists on both handlers, audit fields recorded, reason required, cashier PIN path preserved. |
| `docs/AUDIT-REGISTER.md` | A187 Phase 2a recorded; ops-note correction (stranded order past the void window). |
| `docs/MANIFEST-2026-08-31-e.md` | This file. |
| `docs/MANIFEST-2026-08-31-{b,c,d}.md` | Included for tree completeness. |
| `apps/dashboard/src/pages/OrdersPage.tsx`, `App.tsx`, `components/DashboardLayout.tsx` | Carried from Phase 1 (unchanged). |

## Verification (rule 7 — what ran, what it printed)
```
apps/server: npm install (229 pkgs); ./node_modules/.bin/tsc --noEmit  → exit 0
node tests/owner-void-refund.test.mjs                                  → 6/6, all green
  MUTATION CHECK: break the void bypass (isPaid && req.isOwner → && false) → 1 FAILED
  restore → all green   (rule 23: the guard bites)
node scripts/check-test-registration.mjs  → OK (test discovered)
node scripts/check-api-routes.mjs          → OK
```
Env: Linux, Node 22/24. Server is the same on every OS — this is an on-target green.

## Design note
This is additive and safe: it only ADDS an owner path; the cashier/till void/refund is
byte-for-byte the same. Void stays inside the 30-min window (no separate shift-close
rule); refund covers everything after. eTIMS: a transmitted invoice should be corrected
by a credit note (the refund path), never a silent void.

## NOT in this delivery
Phase 2b — the Void/Refund **buttons + reason modal** on the owner Orders page
(client). Until 2b ships, the owner endpoints are reachable by API but have no UI.

## Rollback
Before commit:
```
git restore apps/server/src/routes/orders.ts docs/AUDIT-REGISTER.md
rm tests/owner-void-refund.test.mjs docs/MANIFEST-2026-08-31-e.md
```
After push: `git revert <sha> && git push origin dev`.

## Before you commit (rule 20)
```
cd apps/server && npm run build   # or ./node_modules/.bin/tsc --noEmit
node scripts/run-all.mjs          # migration suite may false-red on Windows — A186
```
