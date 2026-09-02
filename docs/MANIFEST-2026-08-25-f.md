# MANIFEST — 2026-08-25 batch -f — A164 (cloud device-grant, Phase 1 server half)

**Base commit:** `189e597` (dev tip). **Supersedes MANIFEST-2026-08-25-e.md** (cumulative, rule 3).
**Register:** A164 · P1 · OPEN.
**Deploy target:** the CLOUD SERVER (Render) + a **PROD-MIGRATE (91→92)** — distinct from the
desktop legs earlier today (A24/A19/A20), which deploy in the till build. Nothing on any till
changes in this batch: the endpoint is inert until the desktop cutover (a later slice).

The cloud can now issue and honour a per-device grant, so a till will (in the cutover slice) recover
its own session without an owner re-login. This is also a real security fix: it establishes the
`isOwner:false` device principal that A159's write-guard can actually bound.

## The security issue this addresses

A till runs on the OWNER token from `/enrol/redeem` (`isOwner:true`, `['*']`). The A159 write-guard
skips owner tokens (`middleware/auth.ts:226`), so a stolen till token can currently write dashboard
data. The device-grant mints `isOwner:false` — the only mode the guard bounds — which is the fix.
It keeps `['*']` so RBAC still lets the till operate; the guard (once `TERMINAL_WRITE_ENFORCE=true`)
is the real bound on dashboard writes.

## Files this batch (-f adds 4, edits 2)

| File | Change |
|------|--------|
| `migrations/92_device_grant_secret.sql` | **NEW. PROD-MIGRATE.** Nullable `user_devices.device_secret_hash` + `device_secret_set_at`; additive, idempotent, self-records. |
| `apps/server/src/lib/deviceGrant.ts` | **NEW pure.** secret generate/hash/constant-time-verify, grantable-status gate, and the `isOwner:false` branch-bound token-claims builder. |
| `apps/server/src/routes/auth.ts` | `/enrol/redeem` also issues + stores + returns a per-device secret (best-effort, additive); new `POST /api/auth/device-token` (verify → mint device-scoped session). |
| `tests/device-token.test.mjs` | **NEW.** 21 asserts, mutation-checked. |
| `scripts/test-migration-92.mjs` | **NEW.** 9 asserts, real PGlite, additive + idempotent. |
| `docs/AUDIT-REGISTER.md` | A164 entry; header Open A-P1 16→17; A164 in Counts. |

Also in this cumulative zip (unchanged, earlier today): the A24 reference channel, A19 relay, A20
roster channel, and MANIFEST -a…-e. Not shipped: any lockfile (rule 22).

## Verified on the bench — a STRONGER green than the desktop legs (rule 9)

Unlike the desktop reshapes (Linux/Node-22 stand-in for Windows/Electron), this is server code run in
its real form:

```
apps/server $ npx tsc --noEmit                → exit 0 (clean)
$ node tests/device-token.test.mjs            → 21 passed, 0 failed
   mutation-checks: mint isOwner:true → 1 named FAIL; verify accepts any secret → 2 named FAILs
$ node scripts/test-migration-92.mjs          → 9 passed, 0 failed (real Postgres via PGlite)
gates: schema-drift, api-schema-drift, table-usage, sql-binds, supabase-catch, api-routes,
       test-registration, rls-coverage, register-consistency → all OK
```

## STILL TO BUILD — the desktop cutover (next slice, the risky half)

The till stores its returned `deviceSecret` (safeStorage) and, on refresh failure, calls
`/device-token` before dropping to the enrol screen. That switches the till to an `isOwner:false`
principal, which must be verified on real hardware (the till must still sell and read branch data as
a non-owner, branch-locked by rbac), and MUST ship only after `TERMINAL_WRITE_ENFORCE=true` — else
the reduced token is unbounded, because the guard only logs in dry-run. A node-side revocation path
is required before Phase 3 (node-mint).

## NOT verified here — target-only (rule 16)

The prod-migrate 91→92; the endpoint end-to-end against a real database; the desktop cutover on two
tills (recover a lapsed session without owner re-login; till still sells + pulls catalogue as a
device principal).

## Rollback (this batch)

```
rm apps/server/src/lib/deviceGrant.ts tests/device-token.test.mjs scripts/test-migration-92.mjs \
   migrations/92_device_grant_secret.sql docs/MANIFEST-2026-08-25-f.md
git checkout 189e597 -- apps/server/src/routes/auth.ts
# the register is shared with -a…-e — revert only the A164 lines, or roll the whole day back.
```
The migration is additive + idempotent; if 92 was already applied to a database, the column is
harmless (nullable, unread by the old code). No down-migration is required to make the old code safe.
