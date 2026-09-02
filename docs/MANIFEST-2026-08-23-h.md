# MANIFEST — 2026-08-23-h

**Batch:** A145 re-scoped and raised P2→P1 after source re-verification. **Docs-only — no zip** (rule 18).
**Cumulative:** follows -a…-g. Apply after -g.

**Base commit:** `f80f0e9` (`dev` tip). Applies on top of -a…-g.

**Working rules:** `HANDOFF-2026-08-08-evening.md` §0, rules 1–23.

---

## Files changed

| File | Change | Why |
|---|---|---|
| `docs/AUDIT-REGISTER.md` | Rewrote the A145 entry; raised P2→P1; moved A145 P2→P1 in `\| Open \|` (A: 9→10 P1, 15→14 P2) and the `\| Counts \|` row; changelog note. | Rule 14 / 7 — the original "no UI caller, add a control" framing was wrong; corrected to the verified finding. |
| `docs/MANIFEST-2026-08-23-h.md` | New (this file). | Rule 2. |

## What re-verification found (rule 5, 17)

The two endpoints `POST /api/branches/:id/assign-user` and `DELETE /api/branches/:id/remove-user/:userId` are:

1. **Redundant.** Branch↔user assignment is already wired via the staff flow — `StaffTab` sends `branch_ids` on create/invite/edit, and `POST`/`PATCH /api/staff` write the `user_branches` rows (`PATCH` does an atomic delete-then-insert replace). Same shape as A144's branch-stock PUT.
2. **Under-guarded — an authz hole.** Both are `requireAuth` only: no `requirePermission('staff.manage')` and no business/branch scoping on `:id`/`user_id`, written via the service-role client (RLS bypassed). Every staff-path route requires `staff.manage` + business ownership. Result (silent): within-tenant privilege escalation (a user without `staff.manage` can change branch access) and cross-tenant `user_branches` writes/deletes. Reads stay JWT-`business_id`-gated, so it's a write/authz hole, not a direct read leak.

Zero callers in dashboard, admin, desktop, or shared.

## Recommendation (NOT shipped in this batch)

Retire both routes (delete). The safe capability exists via the staff path; a weaker duplicate writer is the liability (rule 20). This is a **server** change (no prod-migrate, ships with the server) and it's security-adjacent, so it's held for owner go-ahead per rule 12. The next batch (a code patch) would remove the two route blocks from `apps/server/src/routes/branches.ts` and typecheck the server.

## Priority note

Raised to **P1**: silent authz/isolation hole in a multi-tenant system. Downgrade to P2 if the blast radius (no direct read leak; requires an authenticated user) reads smaller to you.

## Verification (rule 7)

- Guards confirmed by reading `branches.ts` (both routes `requireAuth` only; no router-level scoping middleware) vs `staff.ts` (every route `requirePermission('staff.manage')`).
- Redundancy confirmed by reading `StaffTab.tsx` (sends `branch_ids` on create/invite/PATCH) and `staff.ts` (`user_branches` insert on POST/invite, delete+insert on PATCH).
- No callers: swept `apps/dashboard`, `apps/admin`, `apps/desktop`, `shared`.
- `node scripts/check-register-consistency.mjs` → green (A145 now P1; A: 10 P1 / 14 P2 / 6 P3; header agrees with body).

## Rollback

```
git apply -R A145-rescope.patch
```
