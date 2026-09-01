# MANIFEST 2026-08-31-i — A189 step 1: from-scratch business+owner seed (E2E-in-CI)

**Base commit:** `189bfc2` (dev). **Cumulative** over `-b`..`-h`. Register full-file replace.

## What changed
Decision recorded: **Option A** (Supabase local stack, no secrets) — aligned with
self-hosting the Supabase *stack* on a VPS (recommended over a full rip-out: 241
`.from()` sites + GoTrue owner auth make a rewrite a poor trade for a live business).
Step 1 of the E2E-in-CI plan built: a from-scratch business+owner seed.

| File | Change |
|---|---|
| `e2e/seed/seed-business.mjs` | **NEW.** Dependency-free seed: GoTrue admin createUser → `/api/onboarding` → writes OWNER_EMAIL/PASSWORD to `e2e/.env`. Portable to a self-hosted stack / fresh VPS. |
| `e2e/package.json` | Add `seed:business` script (`node --env-file=.env seed/seed-business.mjs`). |
| `docs/AUDIT-REGISTER.md` | A189: approach chosen (A) + step 1 recorded. |
| `docs/MANIFEST-2026-08-31-i.md` | This file. |
| (carried, unchanged) prior source + docs | From A185/reconciliation/A187/A188/A189-plan. |

## Verification (rule 7)
```
node --check e2e/seed/seed-business.mjs        → parses clean
node e2e/seed/seed-business.mjs (no env)       → "✗ SUPABASE_URL is required" (guard fires)
node scripts/check-register-consistency.mjs    → OK
node scripts/check-doc-refs.mjs                → OK
```

## NOT verified here (honest — rule 7)
The GoTrue admin + onboarding HTTP calls were **not run against a live stack** (no
Docker/Supabase in the sandbox). This is **iteration 1**. Validate locally:
```
cd e2e && cp .env.example .env
# set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, API_BASE_URL (your local API)
npm run seed:business        # creates the owner + business, writes creds to .env
npm run seed:users           # staff PINs
npm test                     # Playwright
```
Expect small fixes on first run (field names, status-code handling) — then it feeds
the CI `supabase start` job (E2E-CI-PLAN steps 2-4).

## Rollback
Before commit: `git restore e2e/package.json docs/AUDIT-REGISTER.md && rm e2e/seed/seed-business.mjs docs/MANIFEST-2026-08-31-i.md`
After push: `git revert <sha> && git push origin dev`.
