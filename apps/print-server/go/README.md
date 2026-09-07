# SwiftPOS Print Bridge (Go) — v4.1

A ~1.6 MB local byte-forwarder (UPX-compressed). The **browser renders** the
receipt to ESC/POS and POSTs the bytes here; this process writes them to the
printer. No embedded JS runtime → tiny installer.

## Endpoints (port 9911)
- `GET  /health`   → `{ok, version}` (no token; Host-locked)
- `GET  /printers` → `{printers:[...]}` (needs `X-Print-Token`; Windows spooler names)
- `POST /print`      `{target, data: base64 ESC/POS}` (needs `X-Print-Token`)
- `POST /print/test` `{target|printer}` (needs `X-Print-Token`)

`target`: `printer:<name>` (Windows spooler/USB) · `\\host\name` (share) ·
`/dev/...` (unix) · `host[:port]` (network :9100).

## Security (v4.1)
Three walls, because a localhost daemon reachable from a browser over plain HTTP
is a known target (DNS rebinding):
1. **Loopback-only bind** — not reachable from the network.
2. **Host allow-list** — every request (incl. `/health`) is rejected with 403
   unless its `Host` is `127.0.0.1`/`localhost` (+`::1`). This defeats DNS
   rebinding, where a malicious page rebinds its own hostname to 127.0.0.1 and
   drives the bridge from the victim's browser; loopback binding alone does NOT
   stop that. See GitHub Security / NCC Group write-ups on DNS rebinding.
3. **Pairing token** (`X-Print-Token`, stored at `~/.swiftpos-print-bridge-token`,
   printed on first run) on `/print`, `/print/test`, and `/printers` — so printer
   names are not enumerable by an arbitrary origin either.

CORS is open by design (the token + Host-lock protect the bridge, not an origin
list), so there is no per-deployment origin config to maintain.

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
