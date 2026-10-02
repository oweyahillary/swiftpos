# MANIFEST 2026-09-07-a — A240–A243: harden + finish the A239 silent-print bridge

**Base:** `origin/dev` (A239 delivery `docs/MANIFEST-2026-09-05-y.md` applied).
**Delivery:** zip, extract over repo root. Dashboard + Go bridge; **no migration**.
Additive to the A239 checkout path (browser-dialog fallback preserved throughout).

## Why (from the pre-live A239 audit)
A239 shipped the customer-receipt path correctly, but the audit found four defects
that block calling it "done": the bridge was **DNS-rebinding-exploitable** and
leaked printer names (A240); the dashboard still read a build **env override** the
register claimed was gone, a silent-misroute trap, and the test asserted the
opposite of its own name (A241); **kitchen tickets** set to "⚡ Print Server"
silently 400'd because the KOT path still spoke the old QZ contract (A242); and
dead code / dropped `copies` / a wrong modifier field remained (A243).

## Files
| File | Change | ID |
|---|---|---|
| `apps/print-server/go/main.go` | `hostOK()` Host allow-list → 403 on all 4 handlers (DNS-rebinding wall); token now required on `/printers`; v4.0.0 → **v4.1.0**; banner | A240 |
| `apps/print-server/go/README.md` | documents the v4.1 three-wall security model | A240 |
| `apps/dashboard/src/lib/localPrintServer.ts` | URL **hard-coded** (no `import.meta.env`); `/printers` sends the token; removed dead `printToQZ`/`PrintConfig`/`printReceiptViaServer`/`RECEIPT_PATH`; refreshed docstring | A241, A243 |
| `apps/dashboard/src/lib/printKOT.ts` | new in-browser `buildKotEscPos()` → forwards bytes via `printBytesToServer`; browser fallback on any error; `printToQZ` gone | A242 |
| `apps/dashboard/src/lib/printReceipt.ts` | removed the dead QZ branch + `printToQZ`/`getQZStatus` imports + unused `qzPrinterName` param | A243 |
| `apps/dashboard/src/pages/pos/PaymentModal.tsx` | honour `printerSettings.copies` on the byte path | A243 |
| `apps/dashboard/src/lib/buildReceiptOrder.ts` | modifier field `m.name` → `m.optionName` (modifiers now show on receipts) | A243 |
| `tests/tiny-bridge-printing.test.mjs` | 5 → **14** source guards (Host validation, token-gated /printers, KOT byte path, hard-coded URL, dead-code removal, copies) | A240–A243 |
| `tests/silent-receipt.test.mjs` | **deleted** — stale A235 guard (superseded path); live assertions ported into tiny-bridge | A243 |
| `docs/AUDIT-REGISTER.md` | A240–A243 entries; Open A-P1 16→18, A-P2 23→24, A-P3 12→13 | — |

## What ran + output (rule 7)
```
Go: go vet clean · build linux OK · cross-build windows OK (spooler_windows.go compiles)
Bridge runtime (built binary), PROVEN:
  /health   correct Host                -> 200 {"version":"4.1.0"}
  /health   rebound Host (evil.com)     -> 403      (DNS-rebinding wall)
  /printers no token                    -> 401      (was 200 — enumeration closed)
  /printers with token                  -> 200
  /print    no token                    -> 401
  /print    rebound Host + valid token  -> 403      (Host beats a leaked token)
  /print    token -> TCP :9100          -> 200; listener received exactly 15 bytes
                                           1b 40 48 45 4c 4c 4f 2d 4b 4f 54 0a 1d 56 00
tests/tiny-bridge-printing.test.mjs     -> 14/14 green
  mutation-checked: drop a hostOK guard / re-add the env override / restore printToQZ
  -> each turns the matching assertion RED naming the right thing
changed dashboard .ts/.tsx                -> esbuild transpile-syntax clean (all 5)
register-consistency · doc-refs · root-clean -> green
```
**NOT verified here (rule 16 — stays FIX BUILT, not CLOSED):**
- A real thermal **receipt AND KOT** print + the Windows **spooler RAW** path — owner's live till test.
- **Full dashboard `tsc` / `vite build`** — no dashboard `node_modules` in this environment; changed TS was transpile-syntax checked only, not type-checked.

## Rollback (rule 2)
Single-commit revert. No schema/migration touched, so rollback is code-only:
`git revert <this commit>` (or restore the 9 files above from the prior commit) and
rebuild the dashboard + the `.exe`. The bridge and dashboard are a **paired**
change (token-on-`/printers`): roll back both together, never one alone.

## Apply
1. Extract over repo root, then remove the retired test: `git rm tests/silent-receipt.test.mjs`
   (a zip cannot carry a deletion — its live assertions were ported into `tiny-bridge-printing.test.mjs`).
2. Rebuild the bridge and hand over the new exe:
   `cd apps/print-server/go && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -ldflags="-s -w" -o SwiftPOS-PrintServer.exe . && upx --best --lzma SwiftPOS-PrintServer.exe`
3. `node --test tests/tiny-bridge-printing.test.mjs` + the register/doc/root gates.
4. `git add` the files; commit; push; redeploy the dashboard.
5. **Before closing A239:** confirm no `VITE_PRINT_SERVER_URL` is set on the
   dashboard/admin Vercel projects, then run the live receipt + KOT print test.
