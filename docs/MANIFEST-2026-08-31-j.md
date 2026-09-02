# MANIFEST 2026-08-31-j — A189: harden the business seed after run 1

**Base:** your current `dev` with `-i` applied (the seed you just ran). Small
follow-up — 3 files.

## Why
First local run: `create auth user failed (403) not_admin`. Diagnosis: the `.env`
`SUPABASE_SERVICE_ROLE_KEY` was the anon/publishable key, not the service_role key —
a config issue, not a code bug, and nothing was created. The target was also the live
project, which the seed should never touch.

## Files
| File | Change |
|---|---|
| `e2e/seed/seed-business.mjs` | Add `SEED_ALLOW=1` run-guard (refuses to seed without it — prevents accidental prod seeding); clear message for the 403/not_admin wrong-key case; clean exit via `process.exitCode` (sidesteps the A186 Windows teardown crash). |
| `docs/AUDIT-REGISTER.md` | A189: run-1 feedback + hardening recorded. |
| `docs/MANIFEST-2026-08-31-j.md` | This file. |

## Verification (rule 7)
```
node --check e2e/seed/seed-business.mjs                 → parses
SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node …       → refuses without SEED_ALLOW=1
node scripts/check-register-consistency.mjs / doc-refs  → OK
```

## To run it for real (against a TEST target, not prod)
1. Use the **service_role** secret key (Supabase → Settings → API → service_role, or
   `sb_secret_…`) in `SUPABASE_SERVICE_ROLE_KEY`. Keep it out of the repo/chat.
2. Point `SUPABASE_URL` / `API_BASE_URL` at a **test project or local stack**, not prod.
3. `cd e2e && SEED_ALLOW=1 npm run seed:business` (or add `SEED_ALLOW=1` to `e2e/.env`).
4. Send me what it prints — if createUser now succeeds, we'll see whether the token
   grant + onboarding body need any fixes, and move to the CI `supabase start` job.

## Rollback
`git restore e2e/seed/seed-business.mjs docs/AUDIT-REGISTER.md && rm docs/MANIFEST-2026-08-31-j.md`
