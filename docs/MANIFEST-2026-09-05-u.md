# MANIFEST 2026-09-05-u — A235 finish web silent receipt printing

**Base:** `origin/dev` @ `20db143`. **Delivery:** zip, extract over root. Dashboard-only, no migration. Additive — the browser fallback is unchanged.

## What this does
Makes silent thermal receipts actually work with the print bridge. Adds a per-device pairing **token**
(sent as `X-Print-Token`), routes receipts to **`/print/receipt`** (Order JSON → bridge renders ESC/POS via
shared/printing), a device-local **receipt printer** setting, and a **pairing card** on the Printers page.
`PaymentModal` prints via the bridge when connected + paired, else falls back to the browser dialog.

## Files
| File | Change | Rollback |
|---|---|---|
| `apps/dashboard/src/lib/localPrintServer.ts` | token storage + `X-Print-Token` on all calls + `printReceiptViaServer` (/print/receipt) | restore from `20db143` |
| `apps/dashboard/src/hooks/usePrinterSettings.ts` | `receiptPrinterName` (device-local) | restore from `20db143` |
| `apps/dashboard/src/pages/pos/PaymentModal.tsx` | print via bridge when paired; browser fallback | restore from `20db143` |
| `apps/dashboard/src/pages/settings/PrintersPage.tsx` | pairing card: token + receipt printer + test | restore from `20db143` |
| `tests/silent-receipt.test.mjs` | NEW — source guards (7/7, mutation-checked) | delete file |
| `docs/PRINT-SERVER-SETUP.md` | NEW — run bridge + configure + test | delete file |
| `docs/AUDIT-REGISTER.md` | A235 entry; counts P2 19→20 | restore from `20db143` |
| `docs/MANIFEST-2026-09-05-u.md` | NEW — this manifest | delete file |

## What ran + output (rule 7)
```
tests/silent-receipt.test.mjs   7/7  (mutations: break /print/receipt payload → red · drop server path → red)
apps/dashboard  npx tsc --noEmit  exit 0
register · doc-refs · parity · catalogue   exit 0
```
**COULD NOT verify the actual thermal render** here — no bridge/printer in the sandbox. That's the live test
(see PRINT-SERVER-SETUP.md). The wiring, types, endpoint, payload shape and token are correct by construction.

## To test tonight (summary — full steps in PRINT-SERVER-SETUP.md)
1. `cd shared/printing && npm i && npm run build`
2. `cd apps/print-server && PRINT_BRIDGE_ORIGINS="<your dashboard origin>" node src/index.js`  → copy the printed token
3. Build/serve the dashboard with `VITE_PRINT_SERVER_URL=http://localhost:3001`
4. Settings → Printers → paste token, pick receipt printer, Send test receipt
5. Ring a sale → prints silently; bridge down → browser dialog fallback.

## Apply
1. Extract over root; run the gates + `node tests/silent-receipt.test.mjs`. 2. `git add` the files; commit; push. 3. Redeploy dashboard with `VITE_PRINT_SERVER_URL` set.
