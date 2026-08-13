# SwiftPOS — clean database setup

Brings a **fresh** database up to the current schema: applies the full baseline
dump, creates the migration-tracking table, then applies every outstanding
forward migration in order and records each one.

## Requirements
- `psql` 16.x  (the baseline uses the `\restrict` meta-command — the Supabase
  SQL editor cannot run it)
- The project's **direct** connection string (role `postgres`), not a pooler role

## Run

```bash
cd swiftpos-db-setup

export DATABASE_URL='postgresql://postgres:PASSWORD@db.<ref>.supabase.co:5432/postgres?sslmode=require'

# 1) see the plan without touching the DB
./scripts/setup-clean-db.sh --dry-run

# 2) apply to a brand-new / empty project (non-destructive)
./scripts/setup-clean-db.sh
```

Use `./scripts/setup-clean-db.sh --reset` **only** to rebuild a dirty project:
it runs `DROP SCHEMA public CASCADE` first (prompts for the DB name to confirm),
then rebuilds and restores the Supabase `anon`/`authenticated`/`service_role`
grants.

The script is idempotent and resumable — re-run it if it stops partway; already
applied migrations are skipped.

## Expected result (clean run)
- ~85 tables in `public`, RLS enabled on all of them
- ~35 forward migrations applied (19, 20, and 39+)
- files 33–38 are already inside the baseline and are skipped automatically

## Known gap
Migrations **68 and 72** are applied in production but their files are not in the
repo, so a from-scratch build will not be byte-identical to production. Fine for
a clean dev/test DB; resolve with the production DB owner if you need an exact
match.

---

## Verify the build (recommended)

Confirms every table and column the codebase expects (scripts/schema-index.json)
is present in the live database, and lists any table with RLS disabled.

```bash
node scripts/verify-db-schema.mjs           # exit 1 if the DB is missing anything
node scripts/verify-db-schema.mjs --strict  # also fail on extra objects / RLS gaps
```

PASS means the migration set is fully applied. "Missing" findings are critical
(a table/column the code needs is absent — usually a half-applied migration or
the 68/72 gap). "Extra" findings just mean the DB is ahead of the index and are
normally fine.

## Seed the admin password

Creates/resets the admin-portal `super_admin`. Pick a strong password (10+ chars).

Option A — over your existing psql connection (no server env needed):
```bash
psql -d "$DATABASE_URL" \
     -v email="admin@swiftpos.co.ke" \
     -v pw="your-strong-password-here" \
     -f scripts/seed-admin.sql
```

Option B — the app-maintained script (needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
in apps/server/.env):
```bash
cd apps/server
ADMIN_PASSWORD='your-strong-password-here' npx tsx src/scripts/reset-admin.ts
```

Both write a bcrypt-cost-12 hash the server accepts and both satisfy the
migration-48 constraint that blocks the old public tutorial hash.
