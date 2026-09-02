# MANIFEST 2026-08-27-n — A181 recovery: re-queue orders missing from the cloud

**Base:** `d5bd396` + the A175–A181(part 1) chain. **Operational tool — not app
code; no version bump.** **Artifact:** `swiftpos-2026-08-27-n.patch`.

## What it recovers

The 26–27 Aug orders that read `synced` on the till but are absent from the cloud
(A181: their `T1--N` numbers collided with the prior till's, the old client marked
them synced anyway). ~KES 12,510.

## `scripts/recover-lost-orders.mjs`

Diffs the till's local `completed` orders against the cloud id list (embedded from
the owner's query), and for each one that is genuinely missing:

- computes a new number that keeps the sequence and uses the till's CURRENT
  terminal code (`T1--5` → `T2--5`);
- REFUSES if that would still collide (i.e. the terminal code hasn't been changed)
  — so you can't re-run the same collision;
- updates the `orders.order_number` and the matching `sync_queue.payload`, and
  flips both to `pending` so the normal sync pushes them.

Safety: **dry-run by default** (pass `--apply` to write); backs the DB up to
`<db>.bak-<ts>` before writing; never touches an order already on the cloud, never
changes an id, never deletes; re-runnable (the cloud upserts by id, so anything
already up there is a no-op on push).

## How to run it (on the till)

1. **Set this till's terminal code to a distinct value (e.g. `T2`)** in Technician
   setup — the script refuses otherwise.
2. Close SwiftPOS (so the DB isn't locked), then, from the repo root:
   ```
   node scripts/recover-lost-orders.mjs --db "%APPDATA%\SwiftPOS Dev\swiftpos.db"           # dry run — review the list
   node scripts/recover-lost-orders.mjs --db "%APPDATA%\SwiftPOS Dev\swiftpos.db" --apply    # write (makes a backup first)
   ```
3. Reopen SwiftPOS and tap **Force sync**. The recovered orders push as `T2--N`.
   Confirm on the cloud Orders page (26–27 Aug).

## Verification (rule 7)

Run against a copy of the real till DB: with `T2` set, the 5 × 26-Aug orders
re-number `T1--1…T1--5` → `T2--1…T2--5`, flip to `pending` with updated payloads,
a backup is written, and a re-run re-plans cleanly. With the code still `T1` it
aborts (would re-collide). On the till it also catches the 27th's orders.

## Note

Recovered orders get a new number (`T2--N`) on the cloud; the printed receipt kept
`T1--N`. That's cosmetic — the sale is now correctly recorded on the cloud, which
is the point. This is a one-off; the embedded cloud id list is a snapshot from
2026-08-27.

## Files

| File | Change |
|------|--------|
| `scripts/recover-lost-orders.mjs` | NEW. The recovery tool. |
| `docs/AUDIT-REGISTER.md` | A181 recovery marked done. |
| `docs/MANIFEST-2026-08-27-n.md` | This file. |
