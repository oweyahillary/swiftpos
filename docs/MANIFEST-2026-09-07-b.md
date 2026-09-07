# MANIFEST 2026-09-07-b — A245: token-free printing (trust the dashboard origin) + Chrome LNA + auto-start

**Base:** on top of `docs/MANIFEST-2026-09-07-a.md` (A240–A243). **Ship together.**
**Delivery:** zip, extract over root. Dashboard + Go bridge; **no migration**.

## Why
The pairing-token copy-paste (find the exe console, copy the token, paste it into
the Printers page) is cumbersome, and running the bridge as a service makes the
token file land in a different account — worse, not better. But the token is the
wall that stops any website the till visits from printing / enumerating printers
(open CORS + Host-lock alone don't stop a plain cross-origin POST). So we replace
the token with something equally strong and zero-friction: an **Origin allow-list**.

## What changed (design)
- **Auth = trusted Origin OR token (token now optional).** The browser sets the
  `Origin` header and page JS cannot forge it, so the real dashboard prints with
  no token; a random website is refused. Allow-list is **exact** (prod + test
  `.vercel.app` aliases + loopback dev). A parsed-host suffix matcher
  (`host == d || HasSuffix(host, "."+d)`) is staged for a future **owned** domain
  and its subdomains. It **never** wildcards `vercel.app` — that shared suffix
  would trust every tenant, including an attacker's `*.vercel.app`.
- **Chrome Private Network Access / Local Network Access.** The bridge now returns
  `Access-Control-Allow-Private-Network: true` on trusted-origin preflights, so as
  Chrome finishes rolling out LNA it does not silently block the dashboard →
  127.0.0.1 request. (Users may see a one-time permission prompt.)
- **Auto-start.** `install-startup.bat` registers a Task Scheduler **logon** task
  that runs the bridge as the signed-in user (printer visibility); `uninstall-startup.bat`
  removes it. Runs without admin. (A Windows *service* in session 0 often can't
  see user-installed printers — deliberately avoided.)

## Files
| File | Change | ID |
|---|---|---|
| `apps/print-server/go/main.go` | `originOK`/`authorized` (Origin allow-list, token optional); PNA header; v4.1.0 → **v4.2.0** | A245 |
| `apps/print-server/go/README.md` | v4.2 security model + auto-start section | A245 |
| `apps/print-server/go/install-startup.bat` | **new** — per-user logon startup task | A245 |
| `apps/print-server/go/uninstall-startup.bat` | **new** — remove the startup task | A245 |
| `apps/dashboard/src/pages/pos/PaymentModal.tsx` | receipt silent gate no longer needs a token (+ A243 copies) | A245 |
| `apps/dashboard/src/lib/printKOT.ts` | KOT silent gate no longer needs a token (+ A242) | A245 |
| `apps/dashboard/src/pages/settings/PrintersPage.tsx` | token field optional; setup copy points at `install-startup.bat` | A245 |
| `tests/tiny-bridge-printing.test.mjs` | 14 → **17** guards (origin allow-list, no vercel wildcard, PNA, token-optional) | A245 |
| `docs/AUDIT-REGISTER.md` | A245 entry; A-P2 24 → 25 | — |

## What ran + output (rule 7)
```
Go: go vet clean · build linux OK · cross-build windows OK
Bridge runtime (built binary), PROVEN:
  /printers  prod origin,  NO token         -> 200
  /printers  test origin,  NO token         -> 200
  /printers  evil-x.vercel.app, NO token    -> 403   (no vercel wildcard hole)
  /printers  no origin, no token            -> 403
  /printers  no origin, valid token         -> 200   (manual fallback intact)
  /print     prod origin, NO token          -> 200/502(no printer) — auth passed
  /print     evil origin                    -> 403
  rebound Host + trusted origin             -> 403   (Host wall still wins)
  OPTIONS preflight, trusted origin         -> Access-Control-Allow-Private-Network: true
  OPTIONS preflight, evil origin            -> no ACAO / no PNA header
tests/tiny-bridge-printing.test.mjs         -> 17/17 green
  mutation-checked (backups, not git checkout): vercel wildcard / authorized() /
  PNA header / token-optional gate — each turns the matching assertion RED.
changed dashboard .tsx/.ts                    -> esbuild transpile-syntax clean
register-consistency · doc-refs · root-clean · test-registration -> green
```
**NOT verified here (rule 16 — stays FIX BUILT):** a real thermal print; the
one-time Chrome LNA permission prompt on a real till; full dashboard `tsc`/`vite
build` (no dashboard node_modules — transpile-syntax checked only).

## Rollback (rule 2)
Code-only, no schema. `git revert <this commit>` (and the A240–A243 commit if
rolling the whole feature back) and rebuild the dashboard + `.exe`. Bridge and
dashboard are a paired change — roll both together.

## Apply
1. Extract over root (after or with the `-a` delivery).
2. Rebuild + hand over the exe (add `-H windowsgui` for a silent background build):
   `cd apps/print-server/go && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -ldflags="-s -w" -o SwiftPOS-PrintServer.exe . && upx --best --lzma SwiftPOS-PrintServer.exe`
3. Ship `install-startup.bat` + `uninstall-startup.bat` beside the exe.
4. `node --test tests/tiny-bridge-printing.test.mjs` + register/doc/root gates.
5. Redeploy the dashboard. On the till: run `install-startup.bat`, open Settings →
   Printers, pick the receipt printer — no token needed.
6. **To trust a new domain later:** add it to `allowedOrigins` (exact) or
   `ownedDomains` (its subdomains) in `main.go` and rebuild. Never add `vercel.app`.
