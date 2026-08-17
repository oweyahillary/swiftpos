# MANIFEST 2026-08-17-h — A115 health monitoring + direct Supabase keep-alive

**Base:** apply on top of A108–A114. Register ID **A115**. Docs + one CI
workflow. No app code changed — the `/health` endpoint was already well-built.

Addresses "Supabase paused at ~day 15 despite an UptimeRobot `/health` monitor":
the `/health` keep-warm only reaches Supabase *through* Render, and a cold or
hour-capped free Render instance can drop the ping before it touches Postgres.

## Files (3)

| File | Change | Why |
|---|---|---|
| `.github/workflows/supabase-keepalive.yml` | **NEW** — scheduled (every 3 days) + manual job that hits Supabase REST **directly** | keeps a dormant free Supabase project warm independent of Render. Needs secrets `SUPABASE_URL`, `SUPABASE_ANON_KEY`. |
| `docs/RUNBOOK.md` | **new §6** — health endpoints, the two UptimeRobot monitors, the Supabase-chain caveat, and the paid-tier fix | so the monitoring setup isn't tribal knowledge. |
| `docs/AUDIT-REGISTER.md` | A115 entry | rule 14. |

## Owner action required

- Add repo secrets **`SUPABASE_URL`** and **`SUPABASE_ANON_KEY`**
  (Settings → Secrets and variables → Actions). Then Actions → "Supabase
  keep-alive" → Run workflow to smoke-test it once.
- Second UptimeRobot monitor on **`/health/schema`** (drift alarm): interval
  15–30 min, timeout ≥ 60s, and **exclude it from your uptime %** (a 503 there
  means "run the prod migration", not "site down").
- Confirm the existing `/health` monitor uses a **≥ 60s timeout** (a cold Render
  start is ~50s and a shorter timeout false-alarms on wake).

## Verified (bench)

- Workflow YAML lints; doc-refs + register gates green.

## NOT verified here

- The workflow's live run needs the two GitHub secrets set (bench can't).
- Keep-warm on free tier is best-effort; Render paid / Supabase Pro are the
  guaranteed fix if cold-starts/pauses ever hurt operations.

## Rollback

`git checkout -- docs/RUNBOOK.md docs/AUDIT-REGISTER.md` and delete
`.github/workflows/supabase-keepalive.yml`.
