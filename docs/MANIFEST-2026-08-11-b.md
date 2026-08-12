# MANIFEST — 2026-08-11-b

**Supersedes `-a`. Cumulative — apply this one only** (rule 3).
**Base:** `0215475` (`dev`) · **No `version` field touched** (rule 22).
**No desktop file touched**, so no version bump is due (rule 15).
**No migration** — nothing to run in Supabase. See A57 for why the seed migration
was deliberately NOT written here.

| File | Change |
|---|---|
| `scripts/check-permission-parity.mjs` | **NEW** — A56. The comparator A45 asks for. |
| `scripts/permission-parity-baseline.json` | **NEW** — `{unregistered: 6, ungated: 6, phantom: 2}` |
| `.github/workflows/ci.yml` | New step in the gates job. |
| `docs/AUDIT-REGISTER.md` | A56 closed. **A57 and A58 opened** — both found by the gate on its first run. |
| `apps/server/src/lib/mailer.ts` | *(from `-a`, unchanged)* A54. |
| `tests/mailer-transport.test.mjs` | *(from `-a`, unchanged)* A54. |
| `docs/MANIFEST-2026-08-11-a.md` | *(from `-a`)* retained — `-b` supersedes it for APPLICATION, not as a record. |

---

## Rollback

```
git checkout 0215475 -- .github/workflows/ci.yml docs/AUDIT-REGISTER.md \
  apps/server/src/lib/mailer.ts tests/mailer-transport.test.mjs
rm scripts/check-permission-parity.mjs scripts/permission-parity-baseline.json
rm docs/MANIFEST-2026-08-11-a.md docs/MANIFEST-2026-08-11-b.md
```

Nothing here changes runtime behaviour. The gate is a CI script; the two new
register entries are findings, not fixes. **Reverting loses the finding, not a fix.**

---

## What was run, and what it printed (rule 7)

Environment: **Linux, Node 22.22.2.** Nothing in this batch touches the desktop,
SQLite or Electron, so the platform gap does not weaken these greens (rule 9).

```
check-permission-parity OK  (new)   check-own-rows          OK
check-ipc-parity        OK          check-sql-binds         OK
check-header-keys       OK          check-row-attribution   OK
check-test-registration OK          check-rls-coverage      OK
check-table-usage       OK          check-shared-sync       OK
check-supabase-catch    OK          check-client-parity     OK
check-auth-retry        OK          check-schema-drift      OK

check-doc-refs          RED — PRE-EXISTING (BRANCH-SERVER-PLAN.md). Red before
                        this batch and after it. Not touched, not masked.

mailer-transport        26 passed, 0 failed
server tsc              OK
typecheck-ratchet       server 0, dashboard 0 — baseline held
```

Gate output on the current tree:

```
check-permission-parity: 13 key(s) enforced across 84 cloud file(s);
                         8 registered in 68 migration(s);
                         10 named by 148 UI file(s).
OK — no new permission divergence.
   (unregistered 6, ungated 6, phantom 2 — all at baseline.)
```

## Mutation checks (rules 10, 23)

Each mutation **confirmed present in the file** before its result was believed.

| # | Defect introduced | Result |
|---|---|---|
| M1 | A route enforcing an unregistered key | RED — `UNREGISTERED ROSE: 6 -> 7`, naming `audit.export` and its file:line |
| M2 | A UI gate misspelt (`reports.viwe`) | RED — `UNGATED ROSE: 6 -> 7` **and** listed under phantom |
| M3 | **A FIX** — seed `products.manage` | RED — `UNREGISTERED FELL: 6 -> 5. Good — now LOWER THE BASELINE` |
| M4 | Is `stripComments` load-bearing? | Raw source yields a phantom key `x` from a comment at `asyncHandler.ts:54` — so yes |

M3 failing is deliberate, not a bug: a ratchet that absorbs improvements silently
drifts back up with nobody noticing. Same semantics as `typecheck-ratchet.mjs`.

---

## Three defects in my own gate, caught before it shipped

Recorded because rule 23 says a gate that cannot fail is the thing it was built to
prevent, and two of these were exactly that.

1. **It walked `migrations/archive/**`.** Those files are never run, yet
   `printers.manage`, `printers.view` and `ingredients.view` were reported as
   registered on their strength. A49's shape precisely — a false claim in the one
   position where a false claim silences the gate. Counts were unaffected (none of
   the three is enforced); the correctness is the point, not the number.
2. **Phantom keys were a HARD FAIL on the assumption that there were none.** There
   are two, and they are A58. The assumption was wrong and the measurement
   corrected it. Ratcheted with the others rather than left permanently red.
3. **M1's first mutation passed because it used an alias** —
   `requirePermission as _rp` — which the scanner correctly does not match. My
   mutation was wrong, not the gate. Re-run with a literal call: red, naming the key.

---

## What only you can verify (rule 16) — ONE query, and it decides two findings

The gate reads the repository. **A57 and A58 both turn on what the live
`permissions` table actually holds**, which nothing here can see:

```sql
select key from public.permissions
where key in ('products.manage','settings.manage','staff.manage',
              'expenses.manage','expenses.view','orders.void',
              'orders.view_all','inventory.view')
order by key;
```

**Eight rows** — production is fully seeded, both findings are repo-rebuild gaps
only (still real: a new tenant or a staging rebuild is broken), and they drop to P2.

**Fewer than eight** — every missing key is a live field fault:
- a missing `products.manage` / `settings.manage` etc. means those routes are
  **owner-only right now**, and A45's suggested unblock ("grant the role
  `settings.manage`") **cannot work**, because the key cannot be granted at all;
- a missing `orders.view_all` / `inventory.view` means **no manager has ever seen
  the Orders, Turnover or Inventory tabs**.

**The thirty-second version of the same question, and worth asking first:** can a
manager currently open Orders, Turnover and Inventory on the manager dashboard? If
yes, those two keys are seeded. If no, A58 is confirmed in the field.

---

## What comes next, and why it is in this order

**A46 is now unblocked** — the guard rule 20 requires exists. The sequence the
register already names still holds, with one addition from A57:

1. **Settle the query above.** It changes A57/A58's severity and it changes what
   A46's migration must contain.
2. **A46's split**, seeding the seven new keys **and** the six unregistered ones in
   ONE migration. Seeding them separately is how two copies drift (rule 17).
3. Re-point UI gates, lowering the baseline as each divergence closes.

## Deliberately NOT done (rule 12)

**The A57 seed migration.** It is the obvious next keystroke and it is wrong to
make now: it needs the production query above, it must not collide with rows
production may already hold, and A46 is about to add seven more keys to the same
table. One migration, once, as part of A46.

**Any UI gate change for A58.** Three nav items are involved and I do not yet know
whether they are invisible in the field or fine. Changing a gate before knowing
which would be shipping something approximate to see what happens (rule 20).
