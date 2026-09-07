# SwiftPOS Print Bridge (Go) — v4.2

A ~1.6 MB local byte-forwarder (UPX-compressed). The **browser renders** the
receipt to ESC/POS and POSTs the bytes here; this process writes them to the
printer. No embedded JS runtime → tiny installer.

## Endpoints (port 9911)
- `GET  /health`   → `{ok, version}` (no token; Host-locked)
- `GET  /printers` → `{printers:[...]}` (trusted origin OR `X-Print-Token`; Windows spooler names)
- `POST /print`      `{target, data: base64 ESC/POS}` (trusted origin OR `X-Print-Token`)
- `POST /print/test` `{target|printer}` (trusted origin OR `X-Print-Token`)

`target`: `printer:<name>` (Windows spooler/USB) · `\\host\name` (share) ·
`/dev/...` (unix) · `host[:port]` (network :9100).

## Security (v4.2)
A localhost daemon reachable from a browser over plain HTTP is a known target
(DNS rebinding, drive-by localhost requests). Three walls:
1. **Loopback-only bind** — not reachable from the network.
2. **Host allow-list** — every request (incl. `/health`) is 403'd unless its
   `Host` is `127.0.0.1`/`localhost`/`::1`. Defeats DNS rebinding (a page
   rebinds its own hostname to 127.0.0.1 and drives the bridge from the victim's
   browser; loopback binding alone does NOT stop that). GitHub Security / NCC.
3. **Origin allow-list** — `/print`, `/print/test`, `/printers` require the
   browser `Origin` to be a trusted SwiftPOS dashboard (exact aliases +, later,
   subdomains of a domain we own) OR a valid `X-Print-Token`. The browser sets
   `Origin` and page JS cannot forge it, so a random website is refused with no
   pairing needed. **Never** wildcard a shared suffix like `vercel.app` — that
   would trust every tenant's deployment. Preview URLs are intentionally excluded.
4. **Private Network Access header** — preflights from a trusted https origin get
   `Access-Control-Allow-Private-Network: true`, so Chrome's Local Network Access
   rollout does not silently block printing. Users may see a one-time permission
   prompt.

The pairing token still works (`~/.swiftpos-print-bridge-token`, on the console
banner) as a manual fallback / non-browser path, but a trusted dashboard needs
none — no copy-paste. To trust a new domain, add it to `allowedOrigins` /
`ownedDomains` in `main.go`.

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

## Auto-start at logon (per user)
Ship `install-startup.bat` beside the exe; double-clicking it registers a Task
Scheduler **logon** task that runs the bridge as the signed-in user (so it can
see that user's printers — a Windows *service* runs in session 0 under another
account and often can't). `uninstall-startup.bat` removes it. No admin needed.
For a silent background launch (no console window), build with an extra
`-H windowsgui` in `-ldflags` (the token still writes to the file for the manual
fallback).

Verified in CI/sandbox: /health, /print (token + network), /print/test, /printers
(stub off-Windows). The Windows spooler path (`printer:` → RAW) is exercised only
on a real Windows printer.
