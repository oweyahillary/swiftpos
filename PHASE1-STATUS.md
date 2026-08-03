# Phase 1 — where it stands

## What is built

**`origin_device_id` on the five replicated tables** (`localDb.ts`), with partial
indexes on the two hot "mine" predicates. `LOCAL_SCHEMA_VERSION` 43 → **44**.

NULL means this till created the row. Non-null is the `device_id` of the peer it
was ingested from, on a till acting as the branch node.

**`scripts/check-own-rows.mjs`** — CI guard. Every query on a replicated table
must either filter `origin_device_id IS NULL`, or carry `-- branch-wide: <why>`.
Keyed lookups (`WHERE id=?`) are exempt: they identify one row whoever owns it.

## What the guard found

**35 queries need a decision** — three times what I estimated from a partial
grep, and the reason Phase 1 is bigger than three days:

| File | Sites | What they are |
|---|---|---|
| `syncEngine.ts` | 11 | pending counts, push collection — almost certainly **own** |
| `managerReports.ts` | 10 | the manager's view — almost certainly **branch-wide** |
| `ipcHandlers.ts` | 6 | mixed; needs reading one by one |
| `dailySalesReport.ts` | 5 | probably branch-wide, but it feeds a printed report |
| `dayService.ts` | 2 | the day gate — **own**, and the most dangerous to get wrong |
| `localDb.ts` | 1 | schema-side |

## Why this matters more than the count suggests

`getOpenShift()` is:

```sql
SELECT * FROM shifts WHERE status='open' ORDER BY opened_at DESC LIMIT 1
```

On a node ingesting peers, that stops meaning *my open drawer* and starts meaning
*the newest open drawer anywhere at this branch*. The sell gate is built on it.
The node till would believe it has a drawer open belonging to a cashier at
another terminal, and sell against it.

The failure is silent, appears on exactly one till per branch, and only once
replication is switched on — so it would be found by a client, not by us.

## The next decision, and it is not mine to make

Each of the 35 is *own* or *branch-wide*, and several are genuinely arguable:

- Does the **Z-report** cover this drawer, or the branch? (Own — it reconciles a
  cash drawer that physically exists at one terminal.)
- Does the **Daily Sales Report** cover the till or the branch? It is printed and
  handed to an owner, so whichever it is must be **stated on the report itself**.
- The **failed/pending sync counts** in the POS header — own, surely; a cashier
  cannot act on another terminal's sync backlog.
- `getConflictedShifts` — branch-wide by definition, that is what it is for.

I can go through all 35 and propose a call on each, but they should be reviewed
rather than accepted: getting one wrong produces a number that is plausible and
incorrect, which is the worst kind.

## Not yet started in Phase 1

- `/node/sync` endpoint for shifts, floats, expenses, business_days
- A real queue for node pushes (currently fire-and-forget inside the cloud loop)
- Node serves its time; peers warn at >2 minutes' drift

These are straightforward once ownership is settled. Doing them first would mean
writing ingest code against a rule that does not exist yet.

## Revised estimate

Phase 1 was **3 days**. With 35 sites to classify and test, **5-6 days** is
honest. The guard means the work is bounded and cannot silently regress, which
was the point of writing it before the ingest code.
