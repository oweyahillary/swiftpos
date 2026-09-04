# MANIFEST 2026-09-04-n — A208: read-only manager Menu tab

**Base:** stacks on the manager work. **Scope:** dashboard only.

Web menu editing stays owner-only (owner decision). This adds a **read-only** Menu tab for managers
(`ManagerMenuTab`, top-level, gated on `products.view`): products grouped by category with price +
active/inactive + search. **No edit control — zero mutating calls** (guard-test enforced). Editing
remains on the owner's Products screen.

| File | Change |
|---|---|
| `apps/dashboard/src/pages/manager/ManagerMenuTab.tsx` | new — read-only menu view. |
| `apps/dashboard/src/pages/manager/ManagerDashboard.tsx` | Menu nav item (top-level, products.view) + `case 'menu'` + import. |
| `tests/manager-menu-readonly.test.mjs` | 3 mutation-checked checks (reads products; zero mutations; gated read perm). |
| `docs/AUDIT-REGISTER.md` | A208 FIX BUILT. Counts A-P3 5→6. |

## Verification (rule 7)
dashboard tsc 0 · vite build 0 · test 3/3 mutation-checked · check-api-routes 289 · gates green.
**Could NOT verify:** the browser (manager PIN) — Menu tab lists products/prices, offers no edit.

## Rollback
```
git checkout <base> -- apps/dashboard/src/pages/manager/ManagerDashboard.tsx docs/AUDIT-REGISTER.md
rm apps/dashboard/src/pages/manager/ManagerMenuTab.tsx tests/manager-menu-readonly.test.mjs docs/MANIFEST-2026-09-04-n.md
```
