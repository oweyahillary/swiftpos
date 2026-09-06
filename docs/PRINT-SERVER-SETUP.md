# SwiftPOS silent printing — setup & test (A235)

Silent thermal receipts need three things lined up: the **bridge running**, the **dashboard pointed at it**,
and the **till paired**. Do these once per till.

## 1. Run the print bridge (the till's Windows PC)
The bridge is `apps/print-server` (a zero-dependency Node HTTP server on `127.0.0.1:3001`).

**From source (fastest for tonight):**
```bash
# build the shared renderer once (the bridge renders receipts with it)
cd shared/printing && npm install && npm run build
# run the bridge, allowing your dashboard's origin through CORS
cd ../../apps/print-server
PRINT_BRIDGE_ORIGINS="https://swiftpos-three.vercel.app" node src/index.js
```
On first run it prints a **pairing token** and stores it at `~/.swiftpos-print-bridge-token`. Copy that token.

**As a service / .exe:** `npm run build:win` produces `SwiftPOS-PrintServer.exe`; run `install-windows-service.bat`
as Administrator (set `PRINT_BRIDGE_ORIGINS` in the service env). See `apps/print-server/README.md`.

> The bridge is loopback-only. For a deployed (https) dashboard to reach `http://localhost:3001`, the browser
> must allow the mixed/local request; Chrome permits localhost from https. If blocked, test with the dashboard
> run locally (`npm run dev` → http://localhost:5173, already allow-listed).

## 2. Point the dashboard at the bridge (build-time)
Set this env when building/serving the dashboard, then redeploy:
```
VITE_PRINT_SERVER_URL=http://localhost:3001
```
Without it, silent printing stays off and everything uses the browser dialog (by design).

## 3. Pair the till (in the app)
Settings → **Printers**. When the bridge is detected you'll see **Silent receipt printing**:
1. Paste the **pairing token** from step 1.
2. Pick the **Receipt printer** from the list.
3. **Send test receipt** → a receipt should print with no dialog.

## 4. Test a real sale
Ring up a sale → pay → the receipt prints silently to the chosen printer. If the bridge is down or unpaired,
it falls back to the browser print dialog automatically — the cashier is never blocked.

## Troubleshooting
- **Nothing prints / dialog appears:** bridge not running, `VITE_PRINT_SERVER_URL` unset, or no receipt printer chosen.
- **401 on test:** wrong/empty token — re-copy it from the bridge console (`~/.swiftpos-print-bridge-token`).
- **"origin not allowed":** set `PRINT_BRIDGE_ORIGINS` to your dashboard's exact origin and restart the bridge.
- **"render failed":** `shared/printing` isn't built — run `npm run build` in `shared/printing`.

---

## Building the double-click executable (`SwiftPOS-PrintServer.exe`)

For a till with no Node install, build a single-file executable. **Build it on Windows with Node ≥ 24**
(Node's Single Executable App doesn't cross-compile):

```bash
cd apps/print-server
npm install          # gets esbuild + postject (dev deps)
npm run build:win    # → build/SwiftPOS-PrintServer.exe
```

`build:win` runs `build-exe.mjs`, which: builds `shared/printing` → bundles it + `index.js` into one
self-contained file (Node SEA doesn't resolve dependencies, so they're inlined first) → generates the SEA
blob → copies the Node runtime → injects the blob with postject.

Then deploy the exe (see the Windows service option at the top): drop it in `C:\SwiftPOS\PrintServer\`,
set `PRINT_BRIDGE_ORIGINS`, and run `install-windows-service.bat` as admin.

**Signing:** the exe is unsigned, so Windows SmartScreen shows "unknown publisher" and some antivirus may
flag it. For a clean install, code-sign it (`signtool sign /fd sha256 /a SwiftPOS-PrintServer.exe`) with an
OV/EV certificate — a separate, optional step.

**mac/Linux:** `npm run build:exe` on that OS produces `SwiftPOS-PrintServer-<platform>` the same way.
