# MANIFEST — 2026-08-24-h

**Base commit:** batch -g (A158) on `dev` (`a36d1dc`). Applies **on top of -g**.
**Register ID:** **A159** (P2, security hardening) — **DRY-RUN shipped**; OPEN pending
enforce-flip + verification.
**Working rules:** `HANDOFF-2026-08-08-evening.md` §0, rules 1–23.
**Apply:** `git apply MANIFEST-2026-08-24-h.patch` · **Rollback:** `git apply -R MANIFEST-2026-08-24-h.patch`

Phase 2 of the terminal-credential work. A158 removed the owner *password* from tills;
this stops a *stolen* till token from writing dashboard data. Ships in dry-run so it
cannot break sync — enforcement is a one-line env flip after the logs are clean.

---

## Files

| # | Change | File | What |
|---|--------|------|------|
| 1 | edit | `apps/server/src/middleware/auth.ts` | New `terminalWriteDenied()` + `terminalWriteBlocked()` guard, called inside `requireAuth` (single point, covers every authenticated route). Denies a `surface:'desktop'` WRITE unless the path is in the till allowlist. `TERMINAL_WRITE_ENFORCE` env flag; **dry-run by default**. |
| 2 | new | `tests/terminal-write-guard.test.mjs` | 19 assertions (dashboard writes denied; till writes/reads/web allowed) + source checks of the real allowlist and dry-run default. Mutation-checked. |
| 3 | edit | `docs/AUDIT-REGISTER.md` | A159 entry; Open tally **A-P2 15→16**; Counts + Last-updated. |
| 4 | new | `docs/MANIFEST-2026-08-24-h.md` | This manifest. |

**Not touched (rule 22):** no version, no lockfile, no migration. Touches only server auth.

## The gap this closes
The till's enrolment token is owner-scoped (`isOwner`), and `requireWebSurface` bypasses
on `isOwner` — so a till token extracted from a device could POST/PATCH/DELETE dashboard
data across **179 write routes**. The guard gates on the `surface:'desktop'` claim
*directly*, independent of owner-scope, so the stolen token is denied dashboard writes
while its legitimate till writes still pass.

## Design: default-deny by surface (not a 179-endpoint audit)
The till's write set is a short, traced allowlist — `/api/orders`, `/api/sync/push`,
`/api/branch-prices/sync`, `/api/auth/*`, `/api/tech/*` (from `syncEngine.ts`). Everything
else written from a desktop surface is denied. A *new* dashboard endpoint is denied to
terminals by default; the blast radius is the allowlist, not the whole write API.

## Why DRY-RUN (rule 20 — don't break a money system)
`TERMINAL_WRITE_ENFORCE` is unset by default → the guard logs
`[terminal-write-guard] DRY-RUN … would block` and lets the request through. So even if
the allowlist misses a legitimate till write, **sync is not broken** — the miss just
shows up in the logs. Enforcement is opt-in once the logs are clean.

## Evidence (rule 7 / rule 9 — Linux, Node 22 bench)
```
server tsc                     clean
terminal-write-guard.test      19/0 (mutation-checked)
auth/permission suites         unaffected (dry-run is transparent)
check-register-consistency     OK (A-P2 16 agrees with body)
```

## To CLOSE (owner) — the enforce path
1. Deploy with dry-run; watch the `would block` logs for a few days of real till traffic.
2. Add any legitimate till write that appears to the allowlist (`TILL_WRITE_ALLOWLIST`).
3. Set `TERMINAL_WRITE_ENFORCE=true`; confirm on a till that sales/sync still work and a
   crafted desktop-surface `POST /api/products` returns 403 `TERMINAL_WRITE_FORBIDDEN`.

## Could NOT be done here (rule 16)
The dry-run→enforce flip and its till verification are target-side; the guard logic and
allowlist are proven on the bench.
