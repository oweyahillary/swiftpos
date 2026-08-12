-- ─────────────────────────────────────────────────────────────────────────────
-- 00_prereqs_local.sql — bootstrap a BARE PostgreSQL 16 instance so the SwiftPOS
-- baseline dump (00_baseline.sql) can load.
--
-- WHY THIS IS NEEDED ON LOCAL/SELF-HOSTED POSTGRES BUT NOT ON SUPABASE
--   00_baseline.sql is a Supabase pg_dump. It ASSUMES the following already
--   exist and never creates them, because on Supabase they are always present:
--     • roles: authenticated, service_role (and anon, used by the grant model)
--     • schema `extensions` holding uuid-ossp   (baseline calls
--       extensions.uuid_generate_v4() 63 times)
--     • schema `auth` with a `users` table       (3 foreign keys point at it)
--     • function auth.uid()                       (150 RLS policies call it)
--     • pgcrypto                                  (admin seed uses crypt/gen_salt)
--   On bare Postgres none of these exist, so the dump fails without this prelude.
--
-- RUN IT FIRST, as a SUPERUSER (CREATE ROLE / CREATE EXTENSION require it):
--   createdb swiftpos
--   psql -d "postgresql://postgres:PW@localhost:5432/swiftpos" -f scripts/00_prereqs_local.sql
--   # then: ./scripts/setup-clean-db.sh
--
-- IMPORTANT SCOPE NOTE
--   This provisions the DATABASE SCHEMA only. Supabase Auth (the owner dashboard
--   login), the PostgREST auto-API, and Realtime are separate Supabase services
--   that a bare Postgres does not provide. Use this path only if either:
--     (a) you run self-hosted Supabase — in which case connect to its bundled
--         Postgres and follow the SUPABASE manual instead of this one; or
--     (b) your API server connects with a privileged / BYPASSRLS role and you do
--         not rely on Supabase Auth for sign-in.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Roles the policies and grants reference ──────────────────────────────
-- NOLOGIN: these are privilege groups, not login accounts. service_role gets
-- BYPASSRLS to mirror Supabase, so a server connecting as (or inheriting) it
-- sees every row regardless of the RLS policies the baseline installs.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
END $$;

-- ── 2. Extensions, in a schema named `extensions` (Supabase's convention) ────
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;  -- uuid_generate_v4()
CREATE EXTENSION IF NOT EXISTS pgcrypto    WITH SCHEMA extensions;  -- crypt()/gen_salt() for the admin seed
-- gen_random_uuid() is core in PostgreSQL 13+, so no extension is required for it.

-- ── 3. auth schema: a minimal stand-in for Supabase's GoTrue `auth` ─────────
CREATE SCHEMA IF NOT EXISTS auth;

-- The baseline has 3 foreign keys REFERENCES auth.users(id). A minimal table with
-- a uuid primary key satisfies them. If you later run real GoTrue against this
-- database, replace this stub with the genuine auth schema before going live.
CREATE TABLE IF NOT EXISTS auth.users (
  id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text
);

-- auth.uid(): on Supabase this returns the JWT `sub` claim. On bare Postgres
-- there is no JWT, so it reads a per-session GUC you can set for testing
-- (SET request.jwt.claim.sub = '<uuid>'), and returns NULL when unset. NULL means
-- auth.uid()-based policies deny by default — which is why the server must
-- connect with a BYPASSRLS/owner role (see the scope note above).
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

-- ── 4. Let the app roles reach these schemas ────────────────────────────────
GRANT USAGE ON SCHEMA auth, extensions TO anon, authenticated, service_role;

-- Done. Next: 00_baseline.sql then 01_schema_migrations.sql then the forward
-- migrations — all handled by scripts/setup-clean-db.sh.
