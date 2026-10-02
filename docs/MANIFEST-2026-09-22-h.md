# MANIFEST 2026-09-22-h — A313 · receipt logo slice 4 (last): web page toggle + receipt preview; web receipts carry it

**Base commit:** `362c045` (origin/dev after -g). No shipped file has moved since; all ship whole.
**Register:** A313 FIX BUILT (new). A295 rows 4 + 5, header (A-P3 23→24), changelog.
**Environment:** Linux, Node 22.22.2. The bundle and its byte-level checks run here exactly as on CI;
the browser page and paper are target-only.
**Dashboard-only change** (no desktop, no cloud, no migration). Deploys with the next web deploy.

## Files (13)

| File | Change |
|---|---|
| `scripts/escpos-renderer/entry.ts` | Exports the shared raster helpers + size constants. |
| `apps/dashboard/src/lib/escposRenderer.js` | REBUILT from the A310 tree (`node scripts/build-escpos-renderer.mjs`): image block + `GS v 0` + raster helpers. Reproducible: rebuild md5 == shipped. |
| `apps/dashboard/src/lib/escposRenderer.d.ts` | Types for the new exports + `MonoRaster`. |
| `apps/dashboard/src/lib/buildReceiptOrder.ts` | `ReceiptBusinessConfig.logoRaster?`; builder `extra.logoRaster`. |
| `apps/dashboard/src/pages/pos/cashier/types.ts` | `POSInitResponse.branding`. |
| `apps/dashboard/src/pages/pos/cashier/usePOSData.ts` | Resolves `receiptLogo` from init with the till's gate; returned beside `receiptHeader`. |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx` | Threads `receiptLogo` to PaymentModal and printRouted (inserted BEFORE `receiptHeader` — the A265 guard pins the header/footer/businessMode sequence). |
| `apps/dashboard/src/pages/pos/PaymentModal.tsx` | Prop + passed to the builder. |
| `apps/dashboard/src/lib/printRouted.ts` | Arg + passed to the builder. |
| `apps/dashboard/src/lib/reprintReceipt.ts` | Fetches `/api/business/branding`; same gate. |
| `apps/dashboard/src/pages/settings/BrandingTab.tsx` | Toggle, threshold-at-upload via the bundled rule, `ReceiptPreview`, save/reset carry the two fields, business name for the preview, header note corrected. |
| `tests/branding-web-page.test.mjs` | 7→26. |
| `docs/AUDIT-REGISTER.md`, `docs/MANIFEST-2026-09-22-h.md` | Register + this file. |

## Verification (rule 7)

```
bundle: md5 before rebuild == md5 after rebuild  (b865619396ed)   → reproducible
bundle vs HEAD bundle, no logo, same fixture: 80 mm 1899 B == 1899 B · 58 mm 1427 B == 1427 B (identical)
node --no-warnings tests/branding-web-page.test.mjs   26 passed, 0 failed
  (executable checks re-run with shared/printing/test-dist HIDDEN → still 3/3 — not decoration on CI)
  M1 page saves toggle unconditionally     → FAIL "saving without a logo forces raster null + toggle off"
  M2 web POS ignores the toggle            → FAIL "usePOSData resolves … SAME gate as the till"
  M3 reprint drops the branding fetch      → FAIL "reprint fetches branding and applies the same gate"
  M4 builder drops logoRaster              → FAIL "ReceiptBusinessConfig accepts logoRaster"
  M5 bundle built without the exports      → FAIL "bundle exports the shared raster helpers" (then TypeError)
apps/dashboard: tsc --noEmit exit 0 · npm run build "✓ built" (esbuild — the A265 class)
tests: tiny-bridge-printing 29/0 · receipt-escpos-format 3/0 · pos-cart-parity 9/0
check-api-routes OK (299/299) · check-client-parity OK · check-test-registration OK
node scripts/run-all.mjs   == GREEN == 113 passed, 0 skipped
check-register-consistency OK (A-P3 = 24) · check-doc-refs OK · check-root-clean OK
```

Rule-20 note: `pos-cart-parity` went red on my first placement of `receiptLogo` in CashierScreen's
destructure (it split the pinned `receiptHeader, receiptFooter, businessMode:` text). Moved the line; the
guard is unchanged.

## NOT verified (target-only)
- Settings › Business › Branding in a browser: upload → mono preview → toggle → Save → reload shows both.
- A web POS sale with the toggle ON printing the logo via the Go bridge; a reprint doing the same.
- Paper (see -g).

## Rollback
```bash
git checkout 362c045 -- scripts/escpos-renderer/entry.ts apps/dashboard/src/lib/escposRenderer.js apps/dashboard/src/lib/escposRenderer.d.ts apps/dashboard/src/lib/buildReceiptOrder.ts apps/dashboard/src/pages/pos/cashier/types.ts apps/dashboard/src/pages/pos/cashier/usePOSData.ts apps/dashboard/src/pages/pos/CashierScreen.tsx apps/dashboard/src/pages/pos/PaymentModal.tsx apps/dashboard/src/lib/printRouted.ts apps/dashboard/src/lib/reprintReceipt.ts apps/dashboard/src/pages/settings/BrandingTab.tsx tests/branding-web-page.test.mjs docs/AUDIT-REGISTER.md
git rm -q docs/MANIFEST-2026-09-22-h.md
```
