# SwiftPOS Print Bridge (Go)

A tiny (~5 MB) local print bridge — a byte-forwarder. The browser renders the
receipt (shared/printing) to ESC/POS and POSTs the bytes here; this process writes
them to the printer. Replaces the ~55 MB Node/pkg build.

## API
- `GET  /health` → `{ok, version, requiresToken}` (no token)
- `POST /print`  `{target, data: base64 ESC/POS}` + `X-Print-Token`

`target`: `printer:<name>` (Windows spooler RAW / USB) · `\\host\name` (share) ·
`/dev/...` (unix) · `host[:port]` (network, default :9100).

Security: loopback-only, exact-origin allowlist (`PRINT_BRIDGE_ORIGINS`), pairing
token at `~/.swiftpos-print-bridge-token` (printed on first run).

## Build (needs Go ≥ 1.22)
```bash
cd apps/print-server/go
# Windows exe (from any OS — Go cross-compiles):
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -ldflags="-s -w" -o SwiftPOS-PrintServer.exe .
# or for the host OS:
go build -ldflags="-s -w" -o SwiftPOS-PrintServer .
```
Unsigned → Windows SmartScreen warns until code-signed.

## NOTE — not yet wired end-to-end
This thin bridge only forwards bytes, so the dashboard must render ESC/POS in the
browser and POST them to `/print`. That dashboard change (a `shared/printing`
browser import + `Buffer` handling + `printBytesViaServer`) is the remaining step;
until then, use the Node/pkg bridge (`../build:win`) which renders server-side.

Verified: /health, token auth, and network printing. The Windows spooler path is
Windows-only and untested without a physical printer.
