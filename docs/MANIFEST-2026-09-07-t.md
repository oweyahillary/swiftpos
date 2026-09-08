# MANIFEST 2026-09-07-t — A260 (documents show business name) + A261 (reprint receipt)

**Base:** origin/dev @ 0825458 (fresh pull). **Web-only (dashboard).** No migration. No exe build.
Ships after -s. A262 (shift report) still open — next.

## Fixes
- **A260** — documents (GRN / delivery / PO) printed "SwiftPOS". Root cause: `accessKey()`
  returns the owner token on the dashboard, but a manager only holds a POS token, so
  `/api/business` 401'd and `BusinessContext.business` was null → the print fallback.
  `getStoredAccessToken()` now falls back to whichever token exists → the business loads →
  documents print the real name. One-line root fix (also unblocks other manager `api` calls).
- **A261** — "Reprint receipt" on the Orders row. `renderReceiptEscPos` takes an optional
  `reprint` marker; `lib/reprintReceipt.ts` re-renders the stored order via the SAME renderer
  as a "Duplicate Print" and sends it to the branch receipt printer through the bridge (till
  only). Reuse, not a redesign.

## Files
| File | Change | ID |
|---|---|---|
| `apps/dashboard/src/lib/api.ts` | token lookup falls back to any available token | A260 |
| `scripts/escpos-renderer/entry.ts` | `renderReceiptEscPos` accepts a `reprint` marker | A261 |
| `apps/dashboard/src/lib/escposRenderer.js` | regenerated — byte-reproducible | A261 |
| `apps/dashboard/src/lib/reprintReceipt.ts` | **new** — order → duplicate receipt via bridge | A261 |
| `apps/dashboard/src/pages/OrdersPage.tsx` | "Reprint receipt" button + status banner | A261 |
| `tests/ui-reports-fixes.test.mjs` | +2 guards (5) | A260/A261 |
| `docs/AUDIT-REGISTER.md` | A260/A261 FIX BUILT | — |
| `docs/MANIFEST-2026-09-07-t.md` | this manifest | — |

## What ran + output (rule 7)
```
smoke: reprint -> "Duplicate Print" + B Fastfoods + RePrint timestamp + order items/total
       normal receipt -> no "Duplicate Print"
tests/ui-reports-fixes.test.mjs -> 5/5 green
esbuild transpile (api, entry, reprintReceipt, OrdersPage) -> clean
escposRenderer.js -> byte-reproducible ; register/doc/root gates -> green
```
NOT verified here (rule 16): a GRN/delivery print on the manager surface (A260) and a physical
reprint on the till (A261).

## Rollback (rule 2)
Web-only. `git revert <this commit>`.

## Apply
1. Extract over repo root.
2. `node --test tests/ui-reports-fixes.test.mjs` -> 5 green; gates.
3. Deploy dashboard. Check: a GRN/delivery print shows the business name; on Orders, expand an
   order → "Reprint receipt" prints a Duplicate copy on the till.
