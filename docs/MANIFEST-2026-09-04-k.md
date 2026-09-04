# MANIFEST 2026-09-04-k — A205: manager web-POS stock receiving (slice 1: incoming transfers)

**Base commit:** current `dev`. **Delivered together with A133 Slice 2** (same ManagerDashboard
file). **Scope:** dashboard only. **Working rules:** unchanged.

## The gap
The permission model intends managers RECEIVE but never ADJUST (`defaultRolePermissions` denies
`inventory.adjust`/`ingredients.manage`, grants `inventory.receive`/`inventory.transfer`). But the
manager dashboard had **no receive UI** — `POSInventoryTab` is read-only, and the Overview pointed
at a non-existent "receive it in Inventory" action. So managers couldn't receive despite holding the
permission.

## Fix (slice 1 — incoming transfers)
New **Receiving** tab (`ManagerReceivingTab`, in the manager nav's Inventory group, gated on
`inventory.receive`) that lists transfers **in transit to this branch** and marks them received
(`PATCH /api/stock/transfers/:id/status`, gated on `inventory.transfer`). No adjust/edit path — the
tab makes exactly one mutating call (the receive). The Overview's broken promise now points to
Receiving.

| File | Change |
|---|---|
| `apps/dashboard/src/pages/manager/ManagerReceivingTab.tsx` | **new** — incoming-transfer receiving. |
| `apps/dashboard/src/pages/manager/ManagerDashboard.tsx` | Receiving nav item (Inventory group) + `case 'receiving'` + Overview text fix. (Also carries A133 Slice 2's grouped nav.) |
| `tests/manager-receiving.test.mjs` | 4 mutation-checked checks (permission model; in-transit-to-branch only; one mutation / no edit; nav+render+overview). |
| `docs/AUDIT-REGISTER.md` | A205 opened + FIX BUILT; A133 Slice 2 note. Counts A-P2 13→14. |

## Product decision recorded
The **desktop till deliberately has no inventory receive/adjust** — receiving/adjusting is a
**premium, online-only capability** (drives subscription), not a gap. Recorded in A205 so it isn't
re-flagged.

## Verification (rule 7)
- dashboard `tsc` 0, `vite build` exit 0.
- `tests/manager-receiving.test.mjs` 4/4 + `tests/manager-nav-grouped.test.mjs` 3/3, mutation-checked.
- `check-api-routes` 289, register/doc/test gates green.
- **Could NOT verify here:** the browser — a manager sees Receiving, marks an incoming transfer
  received, and has no adjust/edit control.

## Next
**Slice 2 — supplier deliveries / GRN** (`inventory.receive`): receive against a delivery/PO in the
same Receiving tab.

## Rollback
```
git checkout <base> -- apps/dashboard/src/pages/manager/ManagerDashboard.tsx docs/AUDIT-REGISTER.md
rm apps/dashboard/src/pages/manager/ManagerReceivingTab.tsx tests/manager-receiving.test.mjs
rm tests/manager-nav-grouped.test.mjs docs/MANIFEST-2026-09-04-j.md docs/MANIFEST-2026-09-04-k.md
```
