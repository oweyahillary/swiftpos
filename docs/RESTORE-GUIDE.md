# Restoring a till's session / identity (A182)

Three ways to bring a till back to itself after a reset, reinstall, or new machine —
from fully automatic to fully manual.

## 1. Automatic — MAC binding (A182, once deployed)

Every till reports its machine MAC to the cloud. When a machine is reinstalled and
enrols again, the server recognises the MAC and hands back the machine's PREVIOUS
terminal code and name; the till adopts them, so it comes back as (say) "T2 / Front
till" instead of a blank till that gets re-named "T1" and collides on the cloud
(register A181).

Requirements: the cloud has migration 93 applied, and the machine reports the same
MAC as before (usually true; a swapped network card or MAC randomisation can change
it, in which case fall back to option 2 or 3).

Nothing to do — it happens during enrolment. Confirm afterwards in Technician mode
that the terminal code is the expected one.

## 2. Manual — set the terminal code

If the automatic restore didn't fire (older build, or the MAC changed), set the code
by hand so it matches what the cloud already knows this machine as, and does NOT
collide with a sibling till. With SwiftPOS CLOSED, from the repo root:

```
node scripts/recover-lost-orders.mjs --db "<path to swiftpos.db>" --set-code T2
```

`--set-code` also backs the DB up first. Pick a code that is UNIQUE at the branch
(each physical till needs its own — T1, T2, T3…). To see which codes/numbers the
cloud already holds:

```sql
SELECT DISTINCT split_part(order_number,'--',1) AS code, max(order_number)
FROM orders WHERE branch_id = '<branch id>' GROUP BY 1;
```

## 3. Manual — restore a whole session from a backup

Every write these tools make copies the database to `swiftpos.db.bak-<timestamp>`
next to it. To roll a till back to a prior state:

1. Close SwiftPOS.
2. Copy the chosen `swiftpos.db.bak-<timestamp>` over `swiftpos.db` (keep the current
   one aside first, e.g. rename it `swiftpos.db.broken`).
3. Reopen SwiftPOS and tap **Force sync**.

The database is the whole session — device identity, shifts, orders, queue. The
cloud upserts orders by id, so re-pushing after a restore never duplicates anything
already up there.

## Why any of this matters

A till's identity is its `device_id` (hard key) plus its terminal code (the `T1--N`
prefix on order numbers). Two tills sharing a terminal code collide on the cloud's
`UNIQUE (business_id, branch_id, order_number)` and silently drop sales (A181, now
fixed to surface instead of hide). Keeping each physical till's code stable and
distinct — automatically via the MAC binding, or manually here — is what prevents it.
