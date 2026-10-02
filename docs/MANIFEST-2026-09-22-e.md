# MANIFEST 2026-09-22-e — A310 · receipt logo slice 1 (shared/printing) · A314 opened

**Base commit:** `b4ec4fd` (origin/dev after -d). No shipped file has moved since; all ship whole.
**Register:** A310 FIX BUILT (new), A314 OPEN (new), A295 tracker row 4 updated. A-P3 19→21.
**Environment:** Linux, Node 22.22.2. `shared/printing` is pure TypeScript with no native or DOM
dependency, so this bench IS the environment its tests run in on CI. Paper is not (rule 16).
**Not a desktop change** — nothing under `apps/desktop` ships; the desktop build merely re-consumes the
package via its project reference (tsc 0). No version bump due.

## Files (10)

| File | Change |
|---|---|
| `shared/printing/src/raster.ts` | NEW. `MonoRaster`, `monoRasterFromRGBA` (alpha→white, Rec.601, threshold, box-average shrink to 384×240), `mono1:` string codec (null on malformed), ascii view, size constants. |
| `shared/printing/src/document.ts` | `ImageBlock` (`kind:'image'`) + `DocBuilder.image()`. |
| `shared/printing/src/escpos.ts` | `case 'image'`: `GS v 0` with xL/xH = bytes-per-row; malformed raster dropped, never sent. |
| `shared/printing/src/preview.ts` | `case 'image'`: centred `[logo WxH]` placeholder. |
| `shared/printing/src/render.ts` | `renderReceipt` prints `business.logoRaster` above the name. Receipts only. |
| `shared/printing/src/types.ts` | `BusinessConfig.logoRaster?: MonoRaster`. |
| `shared/printing/src/index.ts` | `export * from './raster'`. |
| `shared/printing/test/raster.test.ts` | NEW. 34 assertions. |
| `shared/printing/package.json` | `npm test` runs `raster.test.js`. Version field unchanged (rule 22). |
| `docs/AUDIT-REGISTER.md` | A310, A314, A295 row 4, header counts, changelog, Last-updated. |
| `docs/MANIFEST-2026-09-22-e.md` | This file. |

## Verification (rule 7)

```
BASELINE (before any edit, unchanged tree):
  node test-dist/test/bytes.js  →  Byte stream valid; md5 of out/*.bin captured
  node test-dist/test/sample.js →  text captured
  NOTE: both already differ from the COMMITTED SAMPLE-OUTPUT.txt / out/receipt-*.bin → A314

AFTER the change, no logo configured:
  md5 out/*.bin        IDENTICAL to baseline (5/5 files)
  sample.js text       IDENTICAL to baseline
  (out/ then restored to git state — the committed bins are NOT refreshed here, see A314)

shared/printing npm test:   spooler 18/0 · bridge-sim ok · receipt-footer 11/0 · routing 11/0 · a276 4/0 · raster 34/0
mutations (each restored after):
  M1 xL/xH = width, not bytes/row   → FAIL "xL xH = 3 bytes per row  20 0"
  M2 length guard removed           → FAIL "a malformed raster is DROPPED, not sent"
  M3 alpha composited onto black    → FAIL "transparent pixels print white (0x00)  255"
  M4 logo emitted in the kitchen path → FAIL "KITCHEN ticket never carries the logo"
  M5 threshold <= instead of <      → FAIL "128 is white at default 128"
  (M4's first attempt did not apply — a bad identifier broke the build silently; re-run explicitly
   and read: it bites. Recorded so nobody trusts a mutation that printed nothing.)
apps/desktop: tsc -b tsconfig.main.json --force   exit 0   (consumes the package)
check-test-registration OK · check-shared-sync OK (6 copies agree) · check-doc-refs OK
check-root-clean OK · check-register-consistency OK (A-P3 = 21 from the body)
```

One test expectation was wrong on first run (expected padding bits black); the packer was right — padding
must stay white or a bar prints down the right edge. Fixed the test, not the code.

## NOT verified (target-only)
- Paper. `GS v 0` on the client's actual printer models. The bin-file route in `test/bytes.ts` header is the
  way to prove it without wiring anything: once A312 produces a real raster, send `receipt-80.bin` at the
  printer.
- The dashboard `escposRenderer.js` bundle is untouched (A313 rebuilds it); web receipts print exactly as before.

## Rollback
```bash
git checkout b4ec4fd -- shared/printing/src/document.ts shared/printing/src/escpos.ts shared/printing/src/preview.ts shared/printing/src/render.ts shared/printing/src/types.ts shared/printing/src/index.ts shared/printing/package.json docs/AUDIT-REGISTER.md
git rm -q shared/printing/src/raster.ts shared/printing/test/raster.test.ts docs/MANIFEST-2026-09-22-e.md
```
