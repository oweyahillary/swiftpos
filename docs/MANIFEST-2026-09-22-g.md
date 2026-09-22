# MANIFEST 2026-09-22-g — A312 · receipt logo slice 3: the till prints it

**Base commit:** `1e26459` (origin/dev after -f). No shipped file has moved since; all ship whole.
**Register:** A312 FIX BUILT (new). A295 row 4, header (A-P3 22→23), changelog.
**Environment:** Linux, Node 22.22.2. Guard and SQL proven on real code / node:sqlite (stand-in driver,
rule 9); Electron, the canvas, and paper are target-only.
**Desktop change** → version bump at build, tag after the build (rule 15). `package.json` NOT in this zip
(rule 22). No cloud change. No migration.

## Files (9)

| File | Change |
|---|---|
| `apps/desktop/src/main/brandingGuard.ts` | `logoRgba` (≤384×240, length w·h·4) + `receiptLogoEnabled` (boolean) validated; logo clear ⇒ raster clear. |
| `apps/desktop/src/main/localDb.ts` | `setBranding` thresholds pixels via shared `monoRasterFromRGBA` (outside the txn), stores `logo_receipt` + toggle, merges undefined-keeps/null-clears, returns `BrandingRow`. |
| `apps/desktop/src/main/ipcHandlers.ts` | `branding:set` forwards the two new fields; `resolveReceiptLogo()`; receipt `BusinessConfig.logoRaster` set only when toggle ON and a raster exists. |
| `apps/desktop/src/main/ipcSchemas.ts` | `branding:set` admits `logoRgba` (`any`, shape-checked in the guard) + `receiptLogoEnabled` (`boolean`). |
| `apps/desktop/src/renderer/lib/posApi.ts` | Types for the widened get/set. |
| `apps/desktop/src/renderer/lib/prepareRasterLogo.ts` | `logoPixelsForReceipt()` (canvas → RGBA ≤384×240, alpha kept); `monoStringToCanvas()` (display-only decode). |
| `apps/desktop/src/renderer/pages/BrandingEditor.tsx` | Sends pixels on save; "Print logo on customer receipts" toggle; WYSIWYG mono preview; clear resets all four. |
| `apps/desktop/test/branding-set.test.mjs` | 18→42. |
| `docs/AUDIT-REGISTER.md`, `docs/MANIFEST-2026-09-22-g.md` | Register + this file. |

## Verification (rule 7)

```
apps/desktop: node --no-warnings test/branding-set.test.mjs     42 passed, 0 failed
  M1 width/height cap removed          → FAIL "too wide is refused" + "too tall is refused"
  M2 logo clear no longer clears raster→ FAIL "clearing the logo ALSO clears the raster"
  M3 print path ignores the toggle     → FAIL "resolveReceiptLogo requires the toggle ON"
  M4 one bind dropped in setBranding   → FAIL "bind count matches placeholders (5 args, 6 ?)"
  M5 private threshold, not shared     → FAIL "setBranding uses the shared thresholder"
apps/desktop: tsc -b tsconfig.main.json --force exit 0 · tsc -p tsconfig.json --noEmit exit 0
check-ipc-parity OK (153/153) · check-ipc-validation OK
test-print-resilience 55/0 · test-office-role 26/0 · test-tech-db-console 38/0
tests/branding-sync-pull 26/0 · tests/branding-feed-wiring 8/0
desktop plain-node suites (logFile, syncEngine-failures, ref-bundle, ref-unpack, peer-relay, roster,
  idle-lock, manage-fetch, device-token): all exit 0
node scripts/run-all.mjs        == GREEN == 113 passed, 0 skipped
check-register-consistency OK (A-P3 = 23) · check-doc-refs OK · check-root-clean OK
```

## Paper proof — delivered alongside this zip, NOT in the repo
`receipt-with-logo-80.bin` (5133 bytes) and `receipt-with-logo-58.bin` (4629 bytes): the real
`renderTicket` + `toEscPos` with a synthetic 320×80 block-letter logo (transparent margin, light field,
mid-grey band — all three must print WHITE around black letters). Send at a printer with nothing installed:

    Windows   copy /b receipt-with-logo-80.bin \\localhost\<ReceiptPrinterShareName>
    Network   nc <printer-ip> 9100 < receipt-with-logo-80.bin

PASS = the word "SWIFT POS" in block letters above "KUDO KUDO", crisp, no grey bar under it, no bar down
the right edge, and the rest of the receipt identical to today's. FAIL of any kind = read the paper and
report what printed; the difference names the vendor quirk (bytes.ts header).

## NOT verified (target-only)
- The editor on screen: pick a logo → mono preview appears after Save → toggle → clear.
- A real upload round-trip under Electron (`branding:set` is NEEDS_LIVE_TEST): pixels over structured
  clone → main → `SELECT logo_receipt FROM branding` in the tech console shows a `mono1:` string.
- A sale ringing with the toggle ON printing the logo on the receipt and NOT on the kitchen ticket.
- Paper, as above.

## Rollback
```bash
git checkout 1e26459 -- apps/desktop/src/main/brandingGuard.ts apps/desktop/src/main/localDb.ts apps/desktop/src/main/ipcHandlers.ts apps/desktop/src/main/ipcSchemas.ts apps/desktop/src/renderer/lib/posApi.ts apps/desktop/src/renderer/lib/prepareRasterLogo.ts apps/desktop/src/renderer/pages/BrandingEditor.tsx apps/desktop/test/branding-set.test.mjs docs/AUDIT-REGISTER.md
git rm -q docs/MANIFEST-2026-09-22-g.md
```
