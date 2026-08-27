# MANIFEST 2026-08-27-l — A180: one bad row no longer 500s the whole sync-push batch

**Base:** `d5bd396` + the A175–A179 chain. **Server-side change — deploys on its
own cadence; no desktop version bump (rule 15 is desktop-only).**
**Artifact:** `swiftpos-2026-08-27-l.patch`.

## Why (the general form of A179)

A179 fixed the specific cause (a non-UUID expense id). This fixes the *class*: the
server should never let one malformed row sink a whole batch. `/api/sync/push`
already upserts business_days, shifts and floats **per row** and reports failures
in a `rejected` array — but **expenses** were a single batch `upsert(rows)` that
`sendError`'d (500) on any error. So one bad expense (22P02) failed the entire
push, and the client — which leaves the whole payload pending on a non-2xx —
stranded every shift/day/float behind it.

## Fix

`apps/server/src/routes/sync.ts` — the expenses branch now:
1. Partitions incoming rows by valid id (`partitionByValidId`): a non-UUID id is
   rejected up front (`code:'invalid_id'`, `table:'expenses'`) — which the till
   already parks as `conflict` — instead of poisoning the pre-check `.in('id', …)`
   or the upsert.
2. Upserts the valid rows **per row**, adding any per-row failure to `rejected`.

Same contract floats/shifts/days already use, so a bad expense is now the row's own
problem and the good rows in the same push still land.

## Files

| File | Change |
|------|--------|
| `apps/server/src/lib/syncPush.ts` | NEW. Pure `isUuid` + `partitionByValidId`. |
| `apps/server/src/routes/sync.ts` | Expenses: partition + per-row upsert (was batch + 500). |
| `tests/sync-push-partition.test.mjs` | NEW. Runs the real guard: 8/8 incl. a mutation check (no bad id leaks into `valid`). |
| `docs/AUDIT-REGISTER.md` | A180 (closed); changelog; next free ID → A181. |
| `docs/MANIFEST-2026-08-27-l.md` | This file. |

## Verification (rule 7) and what is NOT (rule 16)

- `sync-push-partition.test.mjs` 8/8 (accepts a UUID, rejects `exp_…` and non-strings, isolates bad rows, mutation-checked). `apps/server` tsc clean. All gates green.
- NOT verified here: the live upsert path against real Postgres (needs a running server + DB). The row-isolation *decision* is unit-tested; the upsert mirrors the floats path that already ships.

## Interaction with A179

With A179 on the till, a bad expense id is self-healed at startup before it ever
reaches the server, so this guard rarely fires for an up-to-date fleet. Its value
is mixed fleets: an un-upgraded till pushing a bad expense no longer takes its own
shifts/days/floats down with it.

## Apply / rollback

```
git apply --check swiftpos-2026-08-27-l.patch && git apply swiftpos-2026-08-27-l.patch
node tests/sync-push-partition.test.mjs
cd apps/server && npx tsc --noEmit
# rollback: git apply -R swiftpos-2026-08-27-l.patch
```
