# MANIFEST 2026-09-07-q — A256 backfill script (review-first) + A54 reconcile

**Base:** origin/dev @ 0825458 (fresh pull). **Docs/SQL only.** No code change, no auto-migration.

## What's in here
- **`docs/A256-permission-backfill.sql`** — a REVIEW-FIRST backfill: STEP 1 preview SELECT
  (no writes) → STEP 2 apply (commented until you confirm). Grants only POST-onboarding
  default permissions per the exact `defaultRolePermissions.ts` tiers, idempotent. Fixes the
  A141 root cause (a permission added after onboarding never reaches existing roles) without
  ever undoing a deliberate removal (the `created_at` date gate).
- Register reconciles: **A256 FIX BUILT** (script), **A54** (code already correct — owner sets
  `RESEND_API_KEY`).

## Why review-first (not an auto-migration)
Permission grants are security-sensitive, and `permissions.created_at` can be unreliable on
dump-seeded DBs (if every key shares one dump timestamp the date gate is meaningless). So the
owner runs the preview, confirms the grants look right, then applies — rather than a migration
firing on deploy. Matches the A159 dry-run-first posture.

## Files
| File | Change |
|---|---|
| `docs/A256-permission-backfill.sql` | **new** — preview + apply backfill |
| `docs/AUDIT-REGISTER.md` | A256 FIX BUILT; A54 reconcile |
| `docs/MANIFEST-2026-09-07-q.md` | this manifest |

## What ran + output (rule 7)
```
tier logic vs defaultRolePermissions.ts -> MANAGER_DENY (4 keys) + CASHIER (6 keys) match exactly
register-consistency · doc-refs · root-clean -> green
```
NOT run: the SQL against a DB (that's the owner's review — STEP 1 preview, then STEP 2 apply).

## Cloud bucket status after this sweep
- **A157** — validation wired (delivery -p), pending live auth/product test.
- **A256** — backfill script built, pending owner preview + apply.
- **A54 / A50** — mailer code correct + Resend path present → owner sets `RESEND_API_KEY`.
- **A146** — webhook + email observability wired → browser verify.
- **A159** — write-guard dry-run shipped → review "would block" logs, flip `TERMINAL_WRITE_ENFORCE`.
- **A141** — bulk import built → owner grants `ingredients.manage` (or run A256).

## Apply
1. Extract over repo root; commit the SQL + register + manifest.
2. In the DB, run STEP 1 (preview) from `docs/A256-permission-backfill.sql`; if the grants look
   right, uncomment + run STEP 2. Or, for B Fastfoods only: Settings → Roles → owner → enable
   "manage ingredients".
