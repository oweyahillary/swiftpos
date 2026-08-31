# MANIFEST 2026-08-31-l — A3 (KDS realtime, part 1) + A141 diagnosis

**Base commit:** `189bfc2` (dev). One migration (**PROD-MIGRATE**) + docs.

## A3 — KDS realtime / RLS (BUG-21): diagnosed, part 1 fixed
Was "unknown, not known-good" for a long time. Now precisely diagnosed — three faults:
1. **Auth mismatch (dominant):** `/kds` is a public standalone route (no login) but
   `/api/kitchen/tickets` is `requireAuth` → the display 401s on load. Needs a decision
   on how a headless kitchen display authenticates (per-branch KDS token / device
   enrolment / branch-scoped read endpoint).
2. **Realtime publication gap:** `kitchen_tickets` was in no `supabase_realtime`
   publication → `postgres_changes` never fired. **Fixed here.**
3. **Realtime RLS/anon:** the client subscribes with the anon key + no user token, and
   the table has branch-scoped RLS. Live-verify after (2); may need a valid token.

Migration 95 removes blocker 2. KDS still won't work until the display-auth decision
(fault 1) is made — flagged in the register, not built here.

## A141 — resolved diagnosis (no code)
The owner seeing no ingredient CTA is a permission-grant gap (onboarded before
`ingredients.manage` existed), not a bug. Immediate fix: toggle "manage ingredients" on
the owner role in Settings → Roles. Systemic candidate (a permission backfill) noted.

## Files
| File | Change |
|---|---|
| `migrations/95_kitchen_tickets_realtime.sql` | **NEW.** Idempotent, guarded: add `kitchen_tickets` to `supabase_realtime`. **PROD-MIGRATE.** |
| `docs/AUDIT-REGISTER.md` | A3 full diagnosis + part-1 fix; A141 resolved-diagnosis. |
| `docs/MANIFEST-2026-08-31-l.md` | This file. |

## Verification (rule 7)
```
node scripts/check-schema-drift.mjs          → OK (92 migrations, agrees; publication-only, no drift)
node scripts/check-register-consistency.mjs  → OK
node scripts/check-doc-refs.mjs              → OK
```
Migration 95 alters only a publication (no table/function change), so it does not drift
the schema snapshot and needs no `schema-pending.json` entry.

## Apply / prod-migrate
```
# after committing, apply to the DB the KDS reads from:
DATABASE_URL="<that db>" node scripts/migrate.mjs
```
Then browser-check `/kds`: realtime still won't deliver until fault 1 (display auth) is
built, but this is the prerequisite. See A3 for the decision.

## Rollback
Migration: `ALTER PUBLICATION supabase_realtime DROP TABLE public.kitchen_tickets;`
Files: `git restore docs/AUDIT-REGISTER.md && rm migrations/95_kitchen_tickets_realtime.sql docs/MANIFEST-2026-08-31-l.md`
