# MANIFEST — 2026-08-23-i

**Batch:** A145 — retire the redundant, under-guarded branch↔user assignment routes.
**Cumulative:** follows -a…-h. Apply after -h.

**Base commit:** `f80f0e9` (`dev` tip). Applies on top of -a…-h.

**Working rules:** `HANDOFF-2026-08-08-evening.md` §0, rules 1–23.

---

## Files changed

| File | Change | Why |
|---|---|---|
| `apps/server/src/routes/branches.ts` | Deleted `POST /:id/assign-user` and `DELETE /:id/remove-user/:userId`; left a tombstone comment explaining the retirement and pointing to the staff flow. | A145 — redundant with the staff path AND under-guarded (`requireAuth` only → within-tenant privilege escalation + cross-tenant `user_branches` writes). |
| `docs/AUDIT-REGISTER.md` | `RETIREMENT SHIPPED` note on A145. Stays **OPEN** (P1) pending promote + a prod 404 check; counts unchanged. | Rule 14 / 16. |
| `docs/MANIFEST-2026-08-23-i.md` | New (this file). | Rule 2. |

## Safety (rule 13 — deletion during a divergence window)

Confirmed zero callers before deleting, in BOTH versions that can be live during a promote:
- dev working tree (dashboard/admin/desktop/shared/tests/scripts/e2e): none.
- deployed `origin/main`: none (the routes exist there but nothing calls them).

So removing them cannot break any client, old or new. The capability (assign a user to branches) remains available and safe via the staff endpoints (`POST`/`PATCH /api/staff`, gated by `staff.manage` + business/branch scoping).

## Verification (rule 7, 8, 9)

- `apps/server` `npx tsc --noEmit` → exit 0, **0 errors** (server baseline is 0; imports `sendError`/`supabase`/`requireAuth` still used by other routes).
- `apps/server` `npm run build` (tsc emit) → exit 0 — the deletion compiles into the shipped artifact.
- `node scripts/check-permission-parity.mjs` → green.
- `node scripts/check-table-usage.mjs` → green (`user_branches` still written by the staff path).
- `node scripts/check-api-schema-drift.mjs` → could NOT run on the bench: needs `@electric-sql/pglite`, and fails identically on the untouched baseline. It is a CI gate; expect green there. (rule 9)
- Environment: Linux bench, Node 22. No target/browser needed for a deletion; the only outstanding check is that the endpoints 404 in prod after promote.

## No prod-migrate

Pure route removal — ships with the normal server deploy/promote to `main`, no DB migration.

## Rollback

```
git apply -R A145-retire-routes.patch
```
