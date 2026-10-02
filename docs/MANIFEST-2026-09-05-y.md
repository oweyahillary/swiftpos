# MANIFEST 2026-09-05-y — A239 small-installer silent printing (browser-render + tiny Go bridge)

**Base:** `origin/dev` @ `30e5f45`. **Delivery:** zip, extract over root. Dashboard + Go bridge; no migration.
Additive to the checkout path (browser-dialog fallback preserved).

## The architecture (decided + built)
Rendering moves to the **browser**; the bridge just **forwards bytes**, so the installer is **1.61 MB** (not 57).
Zero-config: the dashboard hard-codes `http://127.0.0.1:9911`, and the bridge uses **open CORS + a token**, so
there is **no Vercel env and no origin list**. Moving to a VPS/domain changes nothing about printing.

## Files
| File | Change |
|---|---|
| `apps/print-server/go/main.go` | v4: `/health` `/printers` `/print` `/print/test`, open CORS, port 9911, test ticket |
| `apps/print-server/go/spooler_windows.go` | + `listPrinters()` (enumerate) |
| `apps/print-server/go/spooler_other.go` | + `listPrinters()` stub |
| `apps/print-server/go/README.md` | v4 docs + build (go + upx) |
| `scripts/escpos-renderer/entry.ts`, `buffer-shim.js` | renderer build inputs |
| `scripts/build-escpos-renderer.mjs` | regenerate the vendored renderer |
| `apps/dashboard/src/lib/escposRenderer.js` | NEW — generated self-contained browser renderer |
| `apps/dashboard/src/lib/escposRenderer.d.ts` | NEW — its types |
| `apps/dashboard/src/lib/localPrintServer.ts` | hard-coded URL (9911) + `printBytesToServer` |
| `apps/dashboard/src/pages/pos/PaymentModal.tsx` | render-in-browser → forward bytes to `/print` |
| `apps/dashboard/src/pages/settings/PrintersPage.tsx` | printer picker text-input fallback |
| `tests/tiny-bridge-printing.test.mjs` | NEW — source guards (5/5) |
| `docs/AUDIT-REGISTER.md` | A239; counts P2 22→23 |

## What ran + output (rule 7)
```
Go bridge: build (linux+win), /health, /printers, /print (401→print, network OK), /print/test   ✓
Windows exe: 5.00 MB stripped → 1.61 MB UPX (PE32+)   ✓  (handed over: SwiftPOS-PrintServer.exe)
Browser renderer (no Node Buffer): 1254-byte ESC/POS, ESC@ init   ✓
dashboard tsc clean · tests/tiny-bridge-printing.test.mjs 5/5 · register/doc-refs green
```
NOT verifiable here: Windows spooler RAW + a real thermal print (owner's live test).

## Setup (one-time per till — no domain/env config)
1. Run `SwiftPOS-PrintServer.exe` (double-click). It prints a pairing token, listens on :9911.
2. Settings → Printers → paste the token, pick/enter the receipt printer, **Send test receipt**.
3. Ring a sale → prints silently. Bridge down → browser dialog fallback.
Rebuild the exe: `cd apps/print-server/go && GOOS=windows GOARCH=amd64 go build -ldflags="-s -w" -o SwiftPOS-PrintServer.exe . && upx --best --lzma SwiftPOS-PrintServer.exe`

## Apply
Extract over root; run the test + gates; `git add` the files; commit; push; redeploy dashboard.
