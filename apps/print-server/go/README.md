# SwiftPOS Print Bridge (Go) — v4

A ~1.6 MB local byte-forwarder (UPX-compressed). The **browser renders** the
receipt to ESC/POS and POSTs the bytes here; this process writes them to the
printer. No embedded JS runtime → tiny installer.

## Endpoints (port 9911)
- `GET  /health`   → `{ok, version}` (open)
- `GET  /printers` → `{printers:[...]}` (open; Windows spooler names)
- `POST /print`      `{target, data: base64 ESC/POS}` (needs `X-Print-Token`)
- `POST /print/test` `{target|printer}` (needs `X-Print-Token`)

`target`: `printer:<name>` (Windows spooler/USB) · `\\host\name` (share) ·
`/dev/...` (unix) · `host[:port]` (network :9100).

Security: loopback-only + pairing token (`~/.swiftpos-print-bridge-token`, printed
on first run). CORS is open — the **token**, not the origin, protects printing —
so there is no per-deployment origin list to maintain.

## Zero-config pairing
The dashboard hard-codes `http://127.0.0.1:9911`, so there is **no Vercel env** to
set. Run the exe, paste the token in Settings → Printers, pick the printer. Moving
to a VPS / new domain changes nothing here.

## Build (Go ≥ 1.22; cross-compiles a Windows exe from any OS)
```bash
cd apps/print-server/go
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -ldflags="-s -w" -o SwiftPOS-PrintServer.exe .
upx --best --lzma SwiftPOS-PrintServer.exe        # 5 MB → ~1.6 MB (optional)
```
Unsigned → SmartScreen warns until code-signed.

Verified in CI/sandbox: /health, /print (token + network), /print/test, /printers
(stub off-Windows). The Windows spooler path (`printer:` → RAW) is exercised only
on a real Windows printer.
