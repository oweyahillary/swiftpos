# MANIFEST 2026-09-05-l — A213 permission-catalogue self-heal (+ close A222)

**Base:** `origin/dev` @ `23033f9`. **Delivery:** zip, extract over root. No migration. Server + (no UI) change.

## What this does
- **A213 (built) — durable fix for the A211/A212/A220 class.** A canonical permission catalogue in code
  is registered into the live DB on every boot (idempotent, DO NOTHING on conflict, never grants/overwrites,
  global). Any DB missing a key self-heals on the next deploy, for every tenant. A new CI gate forces every
  code-referenced key into the canonical list. **Two latent gaps caught + closed:** `orders.create` and
  `invoice.create` (cashier keys registered by no migration).
- **A222 → CLOSED** (POS back-to-portal button confirmed in the browser). Counts P3 9→8.

## Files
| File | Change | Rollback |
|---|---|---|
| `apps/server/src/lib/permissionCatalogue.ts` | NEW — canonical catalogue + `ensurePermissionsRegistered()` | delete file |
| `apps/server/src/index.ts` | `void ensurePermissionsRegistered()` on boot | restore from `23033f9` |
| `scripts/check-permission-catalogue.mjs` | NEW — CI gate (referenced keys ⊆ catalogue) | delete file |
| `scripts/test-permission-catalogue.mjs` | NEW — PGlite self-heal proof (6/6, mutation-checked) | delete file |
| `docs/AUDIT-REGISTER.md` | A213 → FIX BUILT (+note); A222 → CLOSED; counts | restore from `23033f9` |
| `docs/MANIFEST-2026-09-05-l.md` | NEW — this manifest | delete file |

## What ran + output (rule 7)
```
scripts/test-permission-catalogue.mjs      all green (6 passed)  [PGlite]
  mutation (heal skips products.view)      FAIL → restored
scripts/check-permission-catalogue.mjs     OK (25/25 referenced keys catalogued)
  mutation (drop orders.create)            exit 1 → restored
check-permission-parity · check-register-consistency · check-doc-refs   exit 0
```
Server full `tsc` not runnable in sandbox (no server node_modules); `upsert(..,{onConflict,ignoreDuplicates})`
mirrors existing usage — type-correct by construction. Run pinned CI tsc.

## Could NOT verify here
- Boot behaviour on the real server: after deploy, confirm the log line
  `[permissionCatalogue] catalogue verified (25 keys ensured registered)`, and that a DB previously missing
  keys now has all 25.

## Apply
1. Extract over root; run the gates above (incl. `node scripts/test-permission-catalogue.mjs` and
   `node scripts/check-permission-catalogue.mjs`). 2. `git add` the 6 files; commit; push. 3. Deploy server.
