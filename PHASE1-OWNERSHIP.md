# Phase 1 — row ownership · complete

All 34 sites classified and applied. `check-own-rows.mjs` green, both desktop
projects type-check clean.

## The design changed mid-way, for the better

I started with a new `origin_device_id` column. Dropped it: **orders, shifts and
business_days already carry `device_id`**, and `dayService.getOpenDay()` already
scoped on it correctly:

```sql
WHERE status='open' AND COALESCE(device_id,'') = COALESCE(?,'')
```

That is the house pattern. A parallel marker would have meant two ways to say one
thing, and Postgres carries `device_id` on the same rows — so this improves
parity instead of diverging from it.

**Two columns added** (`expenses`, `float_transactions`) instead of five.
`LOCAL_SCHEMA_VERSION` 43 → **44**.

## Classification

**OWN — scoped to this terminal (22)**

| Where | Why |
|---|---|
| `syncEngine` push collection ×5 | a till pushes its own; on a node, pushing a peer's double-pushes it |
| `syncEngine` header counts ×4 | a cashier cannot clear another terminal's backlog |
| `syncEngine` node_ack ×2, reconcile ×1 | only this till's orders are its to confirm |
| **`syncEngine:1064` `getOpenShift`** | **the sell gate reads this** |
| `ipcHandlers` resetPreview ×3 | warns what THIS wipe destroys |
| `ipcHandlers` open-shift ×3 | this till's drawer |
| `dayService` getConflictedShifts | this till's Close Day screen |
| `localDb` business_date backfill | its own comment says "written by THIS machine in local time" |

**BRANCH-WIDE — declared (11)**

`managerReports.ts` (10) marked once at file level — the manager's consolidated
view, where spanning terminals is the point. Marking ten queries individually
trains people to paste the marker without reading it.
`ipcHandlers` tech:status last-order — a tech wants the latest activity anywhere.

**BOTH — `dailySalesReport.ts` (6)**

One report, two scopes, **one query path**. `scopeClause(deviceId)` — null for
branch, set for a single till. Two separate report functions is how somebody ends
up with numbers that do not tie and no way to tell whether that is a bug or a
scope difference.

- Defaults to branch on a node, own-till elsewhere. Not a toggle on a plain
  till: it cannot produce a branch figure, and a greyed-out option teaches people
  the feature is broken.
- Header states `Terminals: All terminals — 3 reporting` or `Terminal T2`
- **Per-till figures must sum to the branch total.** If they do not, the report
  prints the discrepancy instead of a total that does not foot.
- **Staleness is named.** A terminal silent for 2h+ gets a line saying so. A
  branch report missing a till looks identical to a correct one otherwise.

## What the checker caught that I would not have

- **A runtime bug I introduced**: `dineInNet` bound a scope argument with no
  matching placeholder — better-sqlite3 throws "Too many parameter values were
  provided". Found before it ran.
- **A double predicate** on the float count from two overlapping edits, mixing
  named and positional parameters in one statement.
- **Two `SELECT id FROM shifts WHERE status='open'`** in `ipcHandlers`, not one.
- The real site count: **66**, not the 23 I estimated from a partial grep.

Three of those would have shipped. That is the argument for writing the guard
before the ingest code rather than after.

## Before this ships

`REQUIRED_DESKTOP_SCHEMA` in `apps/server/src/lib/desktopSchema.ts` must move
43 → 44 **in the same release**. A 43 till acting as the node would ingest peer
rows it cannot tell apart from its own — which is the entire failure this
prevents.

## Next in Phase 1

- `/node/sync` for shifts, floats, expenses, business_days
- A real queue for node pushes (currently fire-and-forget inside the cloud loop)
- Node serves its time; peers warn above 2 minutes' drift

Ownership is settled, so ingest can now be written against a rule that exists.
