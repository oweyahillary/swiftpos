# MANIFEST 2026-08-27-k — A179: till expenses never sync (non-UUID id) + self-heal

**Base:** `d5bd396` + `-h` + `-i2` + `-i3` + `-j` (A178). **Desktop change → bump the
version + tag after the build (rule 15); not in this patch (rule 22).**
**Artifact:** `swiftpos-2026-08-27-k.patch`.

## What A178 revealed

With shift-push logging in place, the till's own log named the cause:

```
[sync] shift push rejected (HTTP 500): invalid input syntax for type uuid:
"exp_1787776714494_w0ash" | 22P02
```

The expense-create handler minted the id as `exp_<ts>_<rand>` — not a UUID — while
the cloud `expenses.id` is `uuid`. So every till-created expense 500s on push, and
because the cash records go up as one batch, that single bad row blocks the shifts,
days and float behind it. Orders were never affected (they already use `uuid()`).

## Fix

1. `ipcHandlers.ts` — the generator now uses `uuid()` (the same id source orders use).
2. `localDb.ts` — a startup **self-heal**: regenerate any `sync_status='pending'`
   expense whose id is not a UUID. Safe (such rows never synced; nothing references
   `expenses.id`) and idempotent. A till already stuck in the field unblocks its
   whole batch on the next start — no manual SQL.

## Files

| File | Change |
|------|--------|
| `apps/desktop/src/main/ipcHandlers.ts` | expense id `exp_…` → `uuid()`. |
| `apps/desktop/src/main/localDb.ts` | `import { randomUUID }`; startup self-heal for non-UUID pending expense ids. |
| `apps/desktop/test/expense-id-repair.test.mjs` | NEW. Repairs a bad pending id, leaves a good one and an already-synced bad one untouched, idempotent (5/5). |
| `apps/desktop/package.json` | `test:expenseid` in the `test:desktop` chain. |
| `docs/AUDIT-REGISTER.md` | A179 (open P1); counts + changelog; next free ID → A180. |
| `docs/MANIFEST-2026-08-27-k.md` | This file. |

## Verification (rule 7) and what is NOT (rule 16)

- Self-heal run against the REAL till DB: `exp_1787776714494_w0ash` → a valid UUID; idempotent.
- `expense-id-repair.test.mjs` 5/5. main `tsc` clean.
- NOT verified: the real till draining its 6 after this build (needs the install). That keeps A179 OPEN P1.

## What to expect on the till

Install this build; on start it repairs the stuck expense id, and the next sync
pass pushes all 6 records (the log will show `[sync] pushed N cash record(s)`). The
Technician "pending" breakdown should drop to 0.

## Recommended follow-up (not in this patch)

The server 500s the whole `/api/sync/push` batch on one bad row. It should reject
bad rows individually (the `rejected` array already exists for merit-based
refusals) so a single malformed record can never again strand a shop's shift/day
reconciliation. Cross-stack; worth its own slice.

## Apply / rollback

```
git apply --check swiftpos-2026-08-27-k.patch && git apply swiftpos-2026-08-27-k.patch
cd apps/desktop && npx tsc -b tsconfig.main.json --force && npm run test:expenseid
# rollback: git apply -R swiftpos-2026-08-27-k.patch
```
