-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 48 — retire the seeded super-admin (audit C4)
--
-- migrations/admin_portal.sql:69 and swiftpos_consolidated_migration.sql:643 both
-- seed admin_users with:
--
--     admin@swiftpos.co.ke / $2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/Lewm8mCWhBiQF7zO2
--     role super_admin
--
-- That bcrypt hash is a widely circulated tutorial example, so its plaintext must
-- be treated as public knowledge. Per the admin.ts route map, the account can
-- enumerate the fleet, read any client's detail, suspend or activate businesses,
-- toggle features, create billing records and mint tech access tokens. Every
-- install that ran either migration has it.
--
-- The migrations carry a comment saying to change it on first login. That is a
-- process control standing in for a technical one, and it has held for exactly
-- as long as somebody remembered to read it.
--
-- ── DISABLED AND SCRAMBLED, NOT DELETED ─────────────────────────────────────
-- Deleting the row risks removing the only admin account an operator has and
-- locking them out of their own portal. Disabling it closes the hole while
-- leaving the row visible, so the next person can see that it existed and what
-- was done to it rather than finding an unexplained absence.
--
-- The hash is ALSO scrambled to a value no password can produce. is_active alone
-- would be one UPDATE away from being a live public-password super-admin again —
-- someone re-enabling "the admin account that stopped working" would silently
-- restore the vulnerability. After this migration the row cannot authenticate
-- even if re-activated; it must go through reset-admin.
--
-- ── RECOVERY ────────────────────────────────────────────────────────────────
--     ADMIN_PASSWORD='<strong-password>' npx tsx src/scripts/reset-admin.ts
-- from apps/server. That upserts on email, so it repairs this exact row.
--
-- Purely additive to schema. Touches one data row and nothing else.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  seeded_hash CONSTANT text := '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/Lewm8mCWhBiQF7zO2';
  hit         record;
  n           integer := 0;
  remaining   integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'admin_users'
  ) THEN
    RAISE NOTICE 'migration 48: no admin_users table on this database — nothing to do.';
    RETURN;
  END IF;

  FOR hit IN
    SELECT id, email, role FROM public.admin_users WHERE password_hash = seeded_hash
  LOOP
    UPDATE public.admin_users
       SET is_active     = false,
           -- Not a hash of anything. bcrypt.compare against this returns false
           -- for every input, so the row cannot authenticate at all.
           password_hash = 'DISABLED-BY-MIGRATION-48-run-reset-admin',
           updated_at    = now()
     WHERE id = hit.id;

    n := n + 1;
    RAISE WARNING 'migration 48: DISABLED seeded admin % (role %). Its password was public.',
      hit.email, hit.role;
  END LOOP;

  IF n = 0 THEN
    RAISE NOTICE 'migration 48: no seeded admin present — nothing to disable.';
  ELSE
    SELECT count(*) INTO remaining FROM public.admin_users WHERE is_active;
    RAISE WARNING 'migration 48: disabled % account(s).', n;
    IF remaining = 0 THEN
      RAISE WARNING 'migration 48: THERE ARE NOW NO ACTIVE ADMIN ACCOUNTS. Restore access with:';
      RAISE WARNING '    cd apps/server && ADMIN_PASSWORD=''<strong-password>'' npx tsx src/scripts/reset-admin.ts';
    ELSE
      RAISE NOTICE 'migration 48: % active admin account(s) remain.', remaining;
    END IF;
  END IF;
END $$;

-- Belt and braces: if the seed is ever re-inserted — by re-running an older
-- migration file, or restoring an old dump — reject it at the database rather
-- than relying on anyone noticing.
--
-- Guarded on the table existing for the same reason as the block above: not
-- every database has run the admin portal migrations, and this file must not
-- fail on one that has not.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'admin_users'
  ) THEN
    RETURN;
  END IF;

  ALTER TABLE public.admin_users DROP CONSTRAINT IF EXISTS admin_users_no_seeded_hash;
  ALTER TABLE public.admin_users
    ADD CONSTRAINT admin_users_no_seeded_hash
    CHECK (password_hash <> '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/Lewm8mCWhBiQF7zO2');
END $$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('48_retire_seeded_admin',
        'Audit C4. Disabled and scrambled any admin_users row carrying the published seed hash, and added a CHECK constraint so it cannot be re-inserted. Recovery is scripts/reset-admin.ts with ADMIN_PASSWORD.')
ON CONFLICT (version) DO NOTHING;
