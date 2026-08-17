-- ─────────────────────────────────────────────────────────────────────────────
-- seed-admin.sql — create or reset the SwiftPOS admin-portal super_admin.
--
-- Works over the same psql/DATABASE_URL connection you used to build the DB, so
-- you do NOT need apps/server/.env configured. It produces a $2a$12$ bcrypt hash
-- via pgcrypto — the server's bcrypt.compare() accepts $2a/$2b/$2y — and it
-- never uses the retired tutorial hash, so the migration-48 CHECK constraint
-- (admin_users_no_seeded_hash) is satisfied.
--
-- USAGE  (choose a STRONG password, 10+ chars):
--   psql -d "$DATABASE_URL" \
--        -v email="admin@swiftpos.co.ke" \
--        -v pw="your-strong-password-here" \
--        -f scripts/seed-admin.sql
--
-- The alternative, app-maintained path is apps/server/src/scripts/reset-admin.ts
-- (needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in apps/server/.env).
-- ─────────────────────────────────────────────────────────────────────────────

-- pgcrypto lives in the `extensions` schema on Supabase; qualify the calls.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

INSERT INTO public.admin_users (email, name, password_hash, role, is_active)
VALUES (
  :'email',
  'SwiftPOS Admin',
  extensions.crypt(:'pw', extensions.gen_salt('bf', 12)),
  'super_admin',
  true
)
ON CONFLICT (email) DO UPDATE
  SET password_hash = EXCLUDED.password_hash,
      role          = 'super_admin',
      is_active     = true,
      updated_at    = now();

SELECT id, email, role, is_active, created_at
FROM public.admin_users
WHERE email = :'email';
