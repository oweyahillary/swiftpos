# MANIFEST — 2026-08-11-f

**Supersedes `-a` … `-e`. Cumulative — apply this one only** (rule 3).
**Base:** `0215475` (`dev`) · No `version` field touched · No desktop file touched.

**HOTFIX for the migration 76 failure you reported.** One item: **A62**.

```
ERROR:  42P01: relation "role_permissions" does not exist
LINE 46: INSERT INTO role_permissions (role_id, permission_id)
```

| File | Change |
|---|---|
| `migrations/76_role_name_grant_backfill.sql` | **FIXED.** Line 46 qualified. |
| `migrations/75_permission_registry.sql` | **FIXED.** Was fully unqualified — same failure mode. |
| `migrations/77_increment_customer_spend.sql` | Re-checked; was already fully qualified. |
| `scripts/check-schema-drift.mjs` | **Check D** — unqualified DML targets, ratcheted. |
| `scripts/schema-qualify-baseline.json` | **NEW** — `{unqualified: 22}` |
| `docs/AUDIT-REGISTER.md` | A62 entry + changelog. |
| *(from `-e`, unchanged)* | everything else |

## What went wrong

The table exists. Your session's `search_path` does not include `public` —
Supabase's hardened default in several contexts. **Line 46 was the only
unqualified name in the whole file.** Every other reference was `public.`-qualified,
including one to the SAME table eleven lines below, inside the `NOT EXISTS`
guard. I mixed the two styles in one statement and shipped it.

**75 had the same flaw, worse.** It was fully unqualified — inherited from
migrations 24 and 49. It would fail identically in that session. So **if 75
appeared to succeed for you earlier, it ran somewhere with `public` on the
path**, and its section 3 grant is worth re-verifying (query below).

**The lucky part:** this aborted on its first statement, so nothing committed.
The shape to fear is a file whose early statements are qualified and whose later
ones are not — the early half commits, the run aborts part-way, and whether
`schema_migrations` records it depends on where the ledger INSERT sits. That is
a half-applied migration, and it is the hardest state to diagnose after the fact.

## What was run (rule 7)

**Reproduced first, then fixed** — `SET search_path TO ''` under PGlite gave the
identical `relation "role_permissions" does not exist`.

```
                                   search_path=public   search_path=''
75, 76, 77 run                     all three OK         all three OK
orders.view_all grants landed      3                    3
```

```
check-schema-drift          OK      check-sql-binds          OK
check-register-consistency  OK      check-table-usage        OK
check-permission-parity     OK      run-migration-tests      All 9 passed
```

## Mutation check (rules 10, 23)

| Defect | Result |
|---|---|
| Re-unqualify line 46 — the exact production bug | RED — *unqualified DML target "role_permissions" at line 46* |

Check D is **ratcheted at 22**, not pass/fail: 12 of 71 migrations predate this
rule and have already run. Demanding they change would be rewriting history to
make a gate green. Table names come from `schema-index.json` rather than a regex
guess, because a bare word match reports `OF`, `ON` and `TO` as tables, and a
gate that cries wolf gets switched off.

## Run order

**75, then 76, then 77.** All idempotent — re-running 75 is safe and expected.

Then confirm 75's grant actually landed:

```sql
SELECT b.name AS business, r.name AS role,
       bool_or(p.key = 'orders.view_all') AS orders_and_turnover_visible,
       bool_or(p.key = 'inventory.view')  AS inventory_visible
FROM   public.roles r
JOIN   public.businesses b ON b.id = r.business_id
LEFT JOIN public.role_permissions rp ON rp.role_id = r.id
LEFT JOIN public.permissions p
       ON p.id = rp.permission_id AND p.key IN ('orders.view_all','inventory.view')
WHERE  lower(r.name) NOT IN ('cashier','waiter','attendant')
GROUP  BY b.name, r.name
ORDER  BY b.name, r.name;
```

After 77: refresh `scripts/schema-index.json` from the live database and delete
the entry from `scripts/schema-pending.json`. The gate will tell you if you forget.
