# MANIFEST 2026-09-07-w — A261b: Reprint receipt on the manager's Orders (card) view

**Base:** origin/dev @ 6e38865. **Web-only (dashboard).** No migration.

## Why
A261 added "Reprint receipt" to `OrdersPage.tsx` — but that's the OWNER's table view. The
manager's Orders tab renders `POSOrderHistoryTab` (a card view), so the button never showed
for the manager. Added it there too.

## Files
| File | Change |
|---|---|
| `apps/dashboard/src/pages/pos/POSOrderHistoryTab.tsx` | "Reprint receipt" button in the expanded order card |
| `tests/ui-reports-fixes.test.mjs` | guard now asserts both views |
| `docs/AUDIT-REGISTER.md` | A261b note |
| `docs/MANIFEST-2026-09-07-w.md` | this manifest |

Uses the existing `reprintOrderReceipt` (reprintReceipt.ts); `api` reaches the manager via the
A260 token fallback. Reuse, not a new design.

## What ran (rule 7)
```
tests/ui-reports-fixes.test.mjs -> 7/7 green
esbuild transpile (POSOrderHistoryTab) -> clean
register/doc/root gates -> green
```
NOT verified here (rule 16): the button on the manager screen + a physical reprint on the till.

## Apply
1. Extract over repo root; `node --test tests/ui-reports-fixes.test.mjs` -> 7 green; gates.
2. Deploy dashboard. Manager → Orders → expand an order → "Reprint receipt" now appears and
   prints a Duplicate copy on the till.
