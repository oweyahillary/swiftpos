# MANIFEST 2026-09-04-b — A202: owner dashboard mirrors the server owner-wildcard

**Base commit:** current `dev` (post A12 Phase 6). **Scope:** one dashboard file + register.
No server change, no migration.
**Working rules:** unchanged — `HANDOFF-2026-08-08-evening.md §0`.

## The bug (found while investigating A12's empty Ingredients page)
The server treats the owner as all-access: `requirePermission()` bypasses on `req.isOwner`, and
migration 24 says owners aren't role-gated (they get a wildcard), so owner-only permissions
(`ingredients.manage`, `inventory.adjust`) are **not** explicitly granted to the owner role. But
`PermissionsContext` resolved the owner's rights by filtering to the owner role's **explicit**
`role_permissions` — so `can('ingredients.manage')` was **false** and the dashboard hid owner-only
features (the "+ Add Ingredient" button, inventory-adjust, …) that the server would happily allow.
A client/server authorization mismatch.

## Fix
`apps/dashboard/src/context/PermissionsContext.tsx`: the owner dashboard now sets
`permissionKeys = ['*']` (mirroring the server owner-bypass). `roles` + `allPermissions` are still
loaded for the Roles management screen. One-line behaviour change; the old explicit-grant filter is
removed.

## Files
| File | Change |
|---|---|
| `apps/dashboard/src/context/PermissionsContext.tsx` | Owner → wildcard `['*']`, matching the server. |
| `tests/owner-permissions-wildcard.test.mjs` | 3 mutation-checked checks: server owner-bypass, client wildcard, no explicit-grant filter. |
| `docs/AUDIT-REGISTER.md` | A202 opened + FIX BUILT. Counts A-P2 13→14. |

## Verification (rule 7)
- `apps/dashboard` `tsc` 0 errors, `vite build` exit 0.
- `tests/owner-permissions-wildcard.test.mjs` 3/3, mutation-checked (revert to explicit-grant filter → red).
- `check-register-consistency` (header agrees with body), `check-doc-refs`, `check-test-registration`,
  `check-root-clean` — green.

**Could NOT verify here:** the browser — that the owner now sees "+ Add Ingredient" (and other
owner-only actions). That's the close check, and it also unblocks the A12 verify.

## What this unblocks
- The A12 verify (needs the Add button to create a stocked ingredient → check the Recipe drawer).
- Any other owner-only feature that was silently hidden (inventory adjust, etc.).

## Rollback
```
git checkout <base> -- apps/dashboard/src/context/PermissionsContext.tsx docs/AUDIT-REGISTER.md
rm tests/owner-permissions-wildcard.test.mjs docs/MANIFEST-2026-09-04-b.md
```
