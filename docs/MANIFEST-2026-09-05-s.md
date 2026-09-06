# MANIFEST 2026-09-05-s — A232 document logo + A233 stock-take count sheet

**Base:** `origin/dev` @ `6ca13ad`. **Delivery:** zip, extract over root. No migration (logo_url column already exists).

## What this does
- **A232 logo:** documents render the company logo. `logo_url` (already on `businesses`) is now in the
  print engine header, the PATCH whitelist, the dashboard `Business` type, and a **Logo image URL** field
  in Settings → Business profile. All PO/GRN/transfer/Z docs pick it up automatically.
- **A233 stock-take:** a **Print count sheet** button on the owner Inventory page prints a stock-take
  sheet — tracked products, System qty, and blank Counted/Variance columns to write in.

## Files
| File | Change | Rollback |
|---|---|---|
| `apps/dashboard/src/lib/printDocument.ts` | render `business.logo_url` in the header | restore from `6ca13ad` |
| `apps/server/src/routes/business.ts` | `logo_url` in the PATCH whitelist | restore from `6ca13ad` |
| `apps/dashboard/src/pages/settings/BusinessProfileTab.tsx` | Logo image URL field + saved | restore from `6ca13ad` |
| `apps/dashboard/src/types/index.ts` | `Business.logo_url` | restore from `6ca13ad` |
| `apps/dashboard/src/pages/inventory/InventoryPage.tsx` | Print count sheet button + sheet | restore from `6ca13ad` |
| `tests/logo-and-stocktake.test.mjs` | NEW — A232 + A233 guards (6/6, mutation-checked) | delete file |
| `docs/AUDIT-REGISTER.md` | A232/A233 entries; counts P3 8→10 | restore from `6ca13ad` |
| `docs/MANIFEST-2026-09-05-s.md` | NEW — this manifest | delete file |

## What ran + output (rule 7)
```
tests/logo-and-stocktake.test.mjs  6/6  (mutations: drop logo render → red · change count-sheet docType → red)
apps/dashboard  npx tsc --noEmit   exit 0
register · doc-refs · parity · catalogue   exit 0
```
Server full tsc not runnable in sandbox (one-line whitelist add, low risk). Could NOT verify here: rendered logo + count sheet (browser).

## Apply
1. Extract over root; run gates. 2. `git add` the 7 files; commit; push. 3. Deploy dashboard + server. 4. Settings → Business profile → paste a Logo image URL.
