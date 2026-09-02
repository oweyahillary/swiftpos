# E2E-in-CI plan — make the existing E2E/integration suites run automatically (A189)

## Where we are
The tests already exist and are good:
- `e2e/` — Playwright, 10 tests across owner `/dashboard`, `/pos`, `/manager`, public.
- `tests/suites/` + `tests/runner.mjs` — API/integration suites (auth, orders,
  permissions, restaurant, petrol, reports, security, stress).

Neither runs in CI. Both need a **reachable target**: a dashboard + API + a seeded
test business with a known owner (and staff PINs). CI has none, so today they only
run when someone runs them by hand — which is the single-point-of-failure this is
meant to remove.

## The constraint that shapes everything
The API is coupled to **hosted Supabase**: it talks to Supabase (PostgREST) via
`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`, and **owner login goes through Supabase
Auth (GoTrue)**. So a bare Postgres container is not enough — the target must speak the
Supabase API and auth. There is currently no Supabase-local tooling in the repo
(no `supabase/config.toml`); migrations are applied via `scripts/migrate.mjs` against
`DATABASE_URL`.

## The decision (pick one before we build)

**Option A — ephemeral Supabase local stack in the CI job (recommended).**
Use the Supabase CLI (`supabase start`) to bring up Postgres + PostgREST + GoTrue in
the runner. Apply `migrations/*.sql` to its DB, seed a fresh business+owner, boot the
API + dashboard against the local stack, run Playwright, tear down.
- **Pros:** no secrets — everything is created fresh per run and discarded (serves the
  credential-hygiene and bus-factor goals directly); nothing shared to corrupt.
- **Cons:** more setup (adopt the Supabase CLI, get GoTrue auth + migration application
  working in CI); validated by iterating CI runs, not in one shot.

**Option B — a dedicated cloud test Supabase project + scoped secrets.**
Point the suites at a persistent staging project via GitHub Environment secrets.
- **Pros:** faster to wire.
- **Cons:** needs real secrets in CI (against the no-secrets goal), shared mutable
  state across runs, ongoing cost/upkeep.

Recommendation: **Option A.**

## Build steps (Option A), in order — each verified before the next
1. **From-scratch seed** — a script that creates a test business + owner from nothing
   (via `POST /api/onboarding` or direct inserts + a GoTrue user), then the existing
   `e2e/seed/seed-users.setup.ts` for staff PINs. This is the prerequisite and step one;
   the E2E README today assumes an owner already exists.
2. **`supabase/config.toml`** + a CI step that runs `supabase start`, then
   `DATABASE_URL=<local> node scripts/migrate.mjs` to apply the schema.
3. **Boot API + dashboard** against the local stack (dummy-free, real local URLs), seed
   from step 1.
4. **New `e2e` job in `ci.yml`** — runs Playwright and `tests/runner.mjs` against the
   local target. Start it **non-blocking** (`continue-on-error`) until it's stable over
   a few runs, then make it required.

## Honest note on validation
This is infrastructure that proves itself by running in GitHub Actions, not on a
developer sandbox. Expect the first few CI runs to fail on setup details (CLI version,
GoTrue config, seed timing) and to tighten over 2–4 iterations. That is normal for
E2E-in-CI and is why step 4 lands non-blocking first.

## Not this
CI itself is already comprehensive (typecheck ratchet, builds, secret scan, schema
drift, server suites + migrations against Postgres, desktop suites). This plan is only
about the E2E/integration layer that runs nowhere — see A189.
