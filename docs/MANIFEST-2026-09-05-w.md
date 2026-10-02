# MANIFEST 2026-09-05-w — A237 tiny Go print bridge (byte-forwarder)

**Base:** `origin/dev` @ `c370d91`. **Delivery:** zip, extract over root. Additive — new component only; changes no existing behaviour.

## What this adds
`apps/print-server/go/` — a ~5 MB Go print bridge that forwards ESC/POS bytes to a printer. Mirrors the
existing bridge's API/security. Cross-compiles a Windows exe from any OS. Verified: /health, token auth,
network printing. NOT yet wired end-to-end (needs the dashboard to render ESC/POS in-browser — see README).
The Node/pkg bridge (A236) stays the working server-render path meanwhile.

## Files
| File | Change | Rollback |
|---|---|---|
| `apps/print-server/go/main.go` | NEW — HTTP bridge + transport (network/share/device) | delete |
| `apps/print-server/go/spooler_windows.go` | NEW — Windows spooler RAW (alexbrainman/printer) | delete |
| `apps/print-server/go/spooler_other.go` | NEW — non-Windows stub | delete |
| `apps/print-server/go/go.mod` / `go.sum` | NEW — module + deps | delete |
| `apps/print-server/go/README.md` | NEW — API + build + the pending-integration note | delete |
| `docs/AUDIT-REGISTER.md` | A237 entry; counts P3 11→12 | restore from `c370d91` |
| `docs/MANIFEST-2026-09-05-w.md` | NEW — this manifest | delete |

## What ran + output (rule 7)
```
go build (linux) → 5.0 MB; go build GOOS=windows → 5.2 MB PE32+  ✓
bridge: /health {ok}, no-token → 401, token → prints; fake network printer received the bytes  ✓
renderTicket+toEscPos (node) → 1258 bytes valid ESC/POS  ✓
```
NOT verified: Windows spooler (no physical printer); the browser-render dashboard wiring (not in this batch).

## Apply
1. Extract over root; `git add apps/print-server/go docs/AUDIT-REGISTER.md docs/MANIFEST-2026-09-05-w.md`; commit; push.
2. (No app behaviour change yet — the Node/pkg bridge remains the working path.)
