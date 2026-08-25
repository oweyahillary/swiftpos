# MANIFEST — 2026-08-25 batch -g — A159 enforce-readiness audit + A164 correction

**Base commit:** `189e597` (dev tip). **Supersedes MANIFEST-2026-08-25-f.md** (cumulative, rule 3).
**Register:** A159 · P2 · OPEN (allowlist gap closed; enforce-flip still the close condition).
**Deploy target:** the CLOUD SERVER (Render). No migration. No till change.

Two things: (1) an enforce-readiness audit of the A159 terminal write-guard that found and closed
one allowlist gap, so flipping `TERMINAL_WRITE_ENFORCE=true` won't break a live till; (2) a
correction to the A164 record — I mis-described the write-guard during that batch.

## A159 — the gap

The guard denies a `surface:'desktop'` WRITE unless its path is on a short allowlist. I static-traced
every desktop→cloud write in the current tree and checked each against the allowlist. All matched
except **`/api/shifts/:id/close` and `/api/shifts/:id/force-close`** — the till's own shift-close
writes (`syncEngine.ts:1655`), missed by the original trace because they go through a `fetch(url)`
variable rather than a literal path.

This matters more than it looks: the guard gates on `surface`, NOT `isOwner`, so it already applies
to today's owner-scoped till. The gap would have 403'd shift close on EVERY live till the instant
enforce flipped — not just after the A164 device-grant cutover. Closed with a tight entry
(`^/api/shifts/[^/]+/(close|force-close)`) so a shift DELETE/create from a till stays denied.

## A164 — correction (rule 7)

During batch -f I wrote that the A159 write-guard "skips owner tokens (`auth.ts:226`)" and that
`isOwner:false` is "what makes the write-guard apply." Wrong: `auth.ts:226` is `requireWebSurface`
(a different guard). The terminal write-guard (`terminalWriteDenied`, `auth.ts:256`) gates on
`surface === 'desktop'` alone and does not check `isOwner`, so it already bounds today's owner till.
The A164 code (`isOwner:false`) is unchanged and still correct — for branch-locking, blocking
web-only surface, and forcing the per-request status/pv recheck — just not for the write-guard.
Corrected in the register (A164), `deviceGrant.ts`, and `device-token.test.mjs`.

## Files this batch (-g edits 4)

| File | Change |
|------|--------|
| `apps/server/src/middleware/auth.ts` | Add `^/api/shifts/[^/]+/(close|force-close)` to the till write allowlist. |
| `tests/terminal-write-guard.test.mjs` | Extended 19 → 23: shift close/force-close allowed; shift DELETE/create still denied; source-assertion covers the shift path. |
| `apps/server/src/lib/deviceGrant.ts` | Corrected the `isOwner:false` security comment (batch -f error). |
| `tests/device-token.test.mjs` | Corrected the `isOwner:false` assertion label. |
| `docs/AUDIT-REGISTER.md` | A159 audit note; A164 correction. No count change (A159 already P2). |

Also in this cumulative zip (unchanged, earlier today): the A24/A19/A20 desktop legs and the A164
server device-grant, plus MANIFEST -a…-f.

## Verified on the bench (real server tsc — rule 9)

```
apps/server $ npx tsc                          → exit 0 (clean)
$ node tests/terminal-write-guard.test.mjs     → 23 passed, 0 failed
   mutation-check: drop the shift entry from the REAL allowlist → source assertion reddens
$ node tests/device-token.test.mjs             → 21 passed, 0 failed (label corrected)
$ node scripts/test-migration-92.mjs           → 9 passed, 0 failed
gates: register-consistency, test-registration, schema-drift, api-routes → OK
```

## The enforce-readiness verdict

With the shift gap closed, the allowlist covers every cloud write in the current desktop tree. The
guard is `surface`-gated, so flipping enforce affects today's tills immediately — which is why the
gap mattered. Before flipping `TERMINAL_WRITE_ENFORCE=true` in production, still confirm the DRY-RUN
logs show no `[terminal-write-guard] … would block` for a legitimate write — that catches older
field builds and anything static analysis can't see, and it stays A159's close condition.

## Rollback (this batch)

```
git checkout 189e597 -- apps/server/src/middleware/auth.ts tests/terminal-write-guard.test.mjs
# deviceGrant.ts / device-token.test.mjs: revert only the comment/label lines (A164 code unchanged).
rm docs/MANIFEST-2026-08-25-g.md
# the register is shared — revert only the A159/A164 lines, or roll the whole day back.
```
No runtime rollback risk: the guard remains DRY-RUN until the env flag is set, so this batch changes
what WOULD be blocked, not what is.
