# HANDOFF — 2026-09-06 — Silent receipt printing (small installer)

## GitHub status — ✅ UP TO DATE
- `origin/dev` tip: **`a37b12a`** — "A239: small-installer silent printing…"
- Working tree == `origin/dev` (no uncommitted/unpushed changes).
- All of today's work is pushed: **A231–A239** are on `origin/dev`, in order:
  `A231` Z report · `A232` logo · `A233` stock-take · `A234` DRY doc specs ·
  `A235` silent receipt (server-render, superseded) · `A236` pkg exe (superseded) ·
  `A237` first Go bridge (superseded) · `A238` manager Printers branch fix · **`A239` tiny-bridge printing (current)**.
- Gates green on `a37b12a`: `tiny-bridge-printing.test.mjs` 5/5, register/doc-refs OK, dashboard tsc clean.

---

## GOAL
A **small (<a few MB), zero-config, silent receipt printer** for the web POS (dashboard on Vercel;
till = Windows + Chrome + a thermal printer). Competitors ship <1 MB print helpers; the owner will not ship
a 57 MB one. Must survive moving the dashboard to a VPS/new domain without reconfiguring every till.

## CURRENT STATE (what A239 delivered — the chosen architecture)
**The browser renders ESC/POS; a tiny native bridge just forwards the bytes to the printer.** That is the
only path to a small binary, and it also removed all the connection config.
- **Installer:** `SwiftPOS-PrintServer.exe` = **1.61 MB** (Go, `-ldflags="-s -w"` → 5 MB, then UPX → 1.6 MB).
  Cross-compiled from Linux; a built copy was handed to the owner.
- **Bridge (Go v4.0.0, `apps/print-server/go`):** loopback `127.0.0.1:9911`.
  - `GET /health` `{ok,version}` (open) · `GET /printers` `{printers:[…]}` (open, Windows spooler names) ·
    `POST /print {target,data:base64 ESC/POS}` (token) · `POST /print/test {target|printer}` (token).
  - **Open CORS** (reflects any origin) — the **pairing token** protects printing, not an origin list.
  - Token at `~/.swiftpos-print-bridge-token`, printed on first run.
  - `target`: `printer:<name>` (Windows spooler RAW / USB) · `\\host\name` · `/dev/…` · `host[:port]` (:9100).
- **Dashboard:** hard-codes `http://127.0.0.1:9911` (**no Vercel env**), renders the receipt in-browser
  (`escposRenderer.js`), base64s the bytes, POSTs to `/print`. Browser-dialog fallback preserved.

**Verified in the sandbox:** bridge `/health`, `/print` (401 without token → prints with token, network path),
`/print/test`; the Windows exe is a valid 1.61 MB PE32+; the browser renderer produces a 1254-byte ESC/POS
receipt with **no Node Buffer** (the thing that blocked earlier attempts).

**NOT yet verified (the first task tomorrow):** an actual **thermal print on Windows** — specifically the
**spooler RAW path** (`printer:<name>` → `alexbrainman/printer`) and `/printers` enumeration on real hardware.
No Windows/printer exists in the build sandbox.

---

## ACTIVE FILES
Bridge (Go):
- `apps/print-server/go/main.go` — HTTP bridge, endpoints, CORS, token, transport (network/share/device)
- `apps/print-server/go/spooler_windows.go` — Windows spooler RAW + `listPrinters()` (`//go:build windows`)
- `apps/print-server/go/spooler_other.go` — non-Windows stubs
- `apps/print-server/go/{go.mod,go.sum,README.md}` — module + build/run docs (go build + upx)

Browser renderer (generated + inputs):
- `apps/dashboard/src/lib/escposRenderer.js` — **generated** self-contained bundle (do not hand-edit)
- `apps/dashboard/src/lib/escposRenderer.d.ts` — its types
- `scripts/escpos-renderer/entry.ts`, `scripts/escpos-renderer/buffer-shim.js` — build inputs
- `scripts/build-escpos-renderer.mjs` — regenerate the bundle (run after changing shared/printing render)

Dashboard wiring:
- `apps/dashboard/src/lib/localPrintServer.ts` — hard-coded URL (9911), `printBytesToServer`, token, health
- `apps/dashboard/src/pages/pos/PaymentModal.tsx` — `handlePrint`: render → forward bytes → `/print`
- `apps/dashboard/src/pages/settings/PrintersPage.tsx` — pairing card (token + printer picker w/ text fallback)
- `apps/dashboard/src/lib/buildReceiptOrder.ts` — maps a web sale to the shared/printing Order (unchanged today)
- `shared/printing/src/{render,escpos,receiptPreset,…}.ts` — the ESC/POS renderer (source of the bundle)

Tests / docs:
- `tests/tiny-bridge-printing.test.mjs` — source guards (5/5)
- `docs/MANIFEST-2026-09-05-y.md` — A239 delivery notes
- `docs/AUDIT-REGISTER.md` — A239 entry (P2), header `1 P0 · 16 P1 · 23 P2 · 12 P3`

---

## CHANGES MADE (today, chronological)
1. Documents polish: **A231** Z report, **A232** company logo, **A233** stock-take sheet, **A234** DRY doc-spec builders.
2. **A235** silent receipt — first attempt: dashboard sends the Order to the Node bridge's `/print/receipt`
   (server renders). Fixed the token (`X-Print-Token`) that was never sent.
3. **A236** package the Node bridge as an exe (pkg) — hit Windows issues (below); ended ~57 MB.
4. **A237** first Go bridge (5 MB byte-forwarder) — but incompatible with the A235 dashboard (see failures).
5. **A238** manager Printer Setup was stuck on "Select a branch" (BranchContext is owner-only) → pass the
   manager's session branch as a prop. **Fixed** — the Printers page now renders for managers.
6. **A239 (current)** — re-architected to browser-render + tiny bridge (see CURRENT STATE). Supersedes the
   A235 print path and the A236/A237 bridges.

## FAILED ATTEMPTS (so we don't repeat them)
- **Node/pkg exe → 57 MB.** ~99% is the embedded Node runtime + ICU. Too big; rejected by owner.
- **Node SEA + postject on Windows → fails.** Official `node.exe` is Authenticode-signed; postject can't find
  its injection sentinel ("could not find the sentinel"). Needs signtool to strip the signature — fragile.
- **pkg base build-from-source on the till.** pkg tried to compile Node from source (needed NASM) after a
  flaky base download. Fixed by pre-caching the base, but the whole pkg path is heavy.
- **5 MB Go bridge with the A235 dashboard → nothing prints.** Contract mismatch: the dashboard calls
  `/print/receipt` (server render) and `/printers`; the thin Go bridge had neither. Root cause of "nothing
  shows." Resolved in A239 by moving rendering to the browser (bridge only needs `/print`).
- **Cross-package import for browser rendering (`import … from '../../../shared/printing/src/…'`).** `tsc`
  (dashboard) couldn't resolve it, and `escpos.ts` uses Node `Buffer`. **Solved** by esbuild-bundling the
  renderer into a self-contained file with a `Buffer→Uint8Array` shim (`escposRenderer.js`).
- **Connection config friction (`VITE_PRINT_SERVER_URL` + `PRINT_BRIDGE_ORIGINS` + https→localhost).** Caused
  repeated "Print Server Not Found". **Removed** in A239: hard-coded URL + open CORS.

## NEXT STEPS (tomorrow)
1. **LIVE TEST on the real till (highest priority):** run `SwiftPOS-PrintServer.exe` (v4, port 9911), reload
   Settings → Printers → badge should go 🟢 → paste token → the printer should appear in `/printers` (or type
   it) → **Send test receipt** → then ring a real sale. Confirm the **spooler RAW** path actually prints.
2. If `/printers` is empty on Windows: check `alexbrainman/printer.ReadNames()`; the text-input fallback lets
   you proceed by typing the exact Windows printer name meanwhile.
3. Verify **auto-cut** and **cash-drawer kick** on the real printer (the ESC/POS includes `GS V 0` cut; drawer
   kick may need adding to the render if the shop uses one).
4. **Code-sign** the exe (`signtool sign /fd sha256 …`, OV/EV cert) to kill the SmartScreen "unknown publisher"
   warning before shipping to shops.
5. Once a receipt prints silently end-to-end: **close A239** in the register (browser/live pass).

## SKIPPED / PROPOSED (decisions parked)
- **Chrome `--kiosk-printing`** (no bridge at all; `window.print()` goes silent): the simplest possible option,
  proposed but **not chosen** — it prints via the Windows GDI driver (not raw ESC/POS), so cut/drawer/logo
  depend on the driver. Keep as a fallback for shops that don't need raw ESC/POS.
- **Rust bridge for <1 MB.** Go+UPX is 1.6 MB; Rust could reach <1 MB but its Windows-spooler path was
  untestable here. Revisit only if 1.6 MB is still too big.
- **WebUSB / cloud-poll printers (Star CloudPRNT, Epson Server Direct Print).** Zero-install alternatives for
  specific hardware; not needed unless a shop's printers demand it.
- **A214 auth root:** the owner-only `/api/printers` list is still empty for a PIN-authed manager. Not blocking
  (the device-local pairing card doesn't use it), but worth fixing if managers need the full printer config.

## HOW TO REBUILD THE EXE (if needed)
```bash
cd apps/print-server/go
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -ldflags="-s -w" -o SwiftPOS-PrintServer.exe .
upx --best --lzma SwiftPOS-PrintServer.exe    # optional: 5 MB → ~1.6 MB
```
Regenerate the browser renderer after changing shared/printing: `node scripts/build-escpos-renderer.mjs`.
