# Permission model — the decision, and the rule for splitting keys

**Decision, 2026-08-12 (owner).** Broad catch-all permissions are the anti-pattern.
`settings.manage` grew to mean "edit the whole business" — printers, receipt text,
tables, devices, tax — so granting it was all-or-nothing and the till could not
agree with the cloud about any one of them (register A45, A59). We move to
finer, operation-based permissions, and we do it **now, before the system is
operational**, because the cost is in remapping `role_permissions` on live
tenants — which today are ~none, and later are many.

## The rule (so "finer" does not become "unmaintainable")

Every permission key must agree across **four surfaces**, and every new key
multiplies that work:

1. **Registered** — a `permissions` row (a migration). Missing → `requirePermission`
   fails closed and the route is owner-only on any rebuilt DB (A57).
2. **Enforced** — named on the route(s) it guards (`requirePermission` /
   `requireAnyPermission`).
3. **Granted** — seeded to the roles that should hold it (`role_permissions`).
   Missing → nobody but the owner can ever hold it.
4. **Gated** — named by the UI that shows the action (dashboard `hasPermission`,
   till `has`). `check-permission-parity` is the gate that keeps these four in
   step; it now scans the till too (A59).

**So the test for splitting a key is one question:** *is there a real role that
needs one operation but not another?*

- **Yes → split**, by the operation the boundary cares about. A `domain.view` /
  `domain.manage` pair covers most cases; carve out a specific verb
  (`orders.void`, `products.price`, `staff.permissions`) when one sensitive
  action deserves its own grant.
- **No → keep it coarse.** A mechanical create/edit/delete split that no role
  ever grants selectively changes no answer and triples the four-surface upkeep.

Do **not** default to CRUD-per-resource. Default to the **inventory pattern**:
`inventory.view / receive / transfer / adjust` is split by real jobs, not by verbs
for their own sake, and it is the best-designed corner of this system. Copy it.

## The current 14 keys, classified

**Already split by real operation — the model to copy:**
- `inventory.view / receive / transfer / adjust`
- `expenses.view / manage`
- `orders.view_all / void`

**Domain keys extracted from `settings.manage` by A46 — finish wiring them
(enforce + grant + gate), do not re-bundle:**
- `stations.manage` (printers) — **DONE (migration 79):** granted to the manager roles, enforced additively on the station routes, and the till Printers tab gates on it. Was registered-only; this is
  the "printers hid inside settings" gap. Grant to manager roles, enforce on the
  station routes (or leave device-local), gate the till Printers tab on it.
- `receipt.manage`, `tables.manage`, `devices.approve`, `etims.manage`.

**Coarse `manage`, split where a boundary exists:**
| Key | Action |
|---|---|
| `products.manage` (29 routes) | carve out `products.price` (fraud vector); add `products.view` only if a see-not-edit role exists. Create/edit/delete: do NOT split. |
| `staff.manage` | carve out `staff.permissions` (granting permissions = privilege escalation); add `staff.view` for a roster-only role. |
| `tables.manage`, `stations.manage` | add `.view` if a shift-lead should see the layout/routing without editing. |
| `settings.manage` (residual 16 routes) | keep extracting *domains* (payments, tax, branding) where a role boundary exists — not CRUD. |

**Single sensitive actions — correct as-is, do not CRUD:**
- `orders.void`, `devices.approve`, `shifts.force_close`, `receipt.manage`,
  `etims.manage`.

## Naming convention

`domain.operation`, lower_snake, one dot. `operation` is a real operation:
`view`, `manage` (the umbrella "edit this domain"), or a specific verb
(`void`, `price`, `permissions`, `receive`, `transfer`, `adjust`, `approve`,
`force_close`). Keep `manage` as the umbrella grant for a domain; narrower keys
are additive carve-outs, and a role holding `manage` is treated as holding the
carve-outs (or the migration grants both). Reserve `create`/`edit`/`delete` for
the rare domain where a role genuinely gets one and not the others.

## How to roll it out (additive, reversible, pre-operational)

For each new key, in one migration batch per domain:
1. Register it (`INSERT INTO permissions … ON CONFLICT DO NOTHING`).
2. Grant it to exactly the roles that hold the umbrella today, so **no role loses
   access** — the A46/A59 additive rule. Verify with the seed / A58-style query.
3. Enforce it on the route(s): `requireAnyPermission(narrow, umbrella)` so an
   umbrella-holder still passes while the narrow key starts to matter.
4. Gate the UI on it (dashboard + till), then run `check-permission-parity`;
   fix the baseline if a count moves.

Because every step is additive and umbrella-compatible, the change is safe to
ship incrementally and safe to stop half-done. The one thing that is NOT cheap
later is step 2 on a live fleet — which is why this is a now decision.
