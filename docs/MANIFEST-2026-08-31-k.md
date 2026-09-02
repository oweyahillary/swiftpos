# MANIFEST 2026-08-31-k — A189: seed hardening after run 2

**Base:** current `dev` with `-j` applied. Small follow-up — 3 files.

## Run 2 result
Service_role key fixed → `✓ auth user created` (GoTrue works). Next call: `✗ fetch
failed` — a connection-level error, i.e. the **local API isn't running on :4000** (the
onboarding target). Not a code bug; the seed's error message was just unhelpful.

## Files
| File | Change |
|---|---|
| `e2e/seed/seed-business.mjs` | Route all 3 calls through a `http()` wrapper that, on a connection failure, names the endpoint ("could not reach the API (onboarding) at … — is it running?") instead of a bare "fetch failed". Stable default owner creds (`e2e-owner@swiftpos.test`) so re-runs are idempotent and don't leave orphan auth users. |
| `docs/AUDIT-REGISTER.md` | A189: run-2 note. |
| `docs/MANIFEST-2026-08-31-k.md` | This file. |

## Verification (rule 7)
```
node --check e2e/seed/seed-business.mjs                → parses
node scripts/check-register-consistency.mjs / doc-refs → OK
```
Runtime path still needs a live API — see below.

## To get the next run through
```
# terminal 1 — boot the API against the dev Supabase
cd apps/server && npm run dev            # :4000
# terminal 2 — seed
cd e2e && SEED_ALLOW=1 npm run seed:business
```
If the API is deployed instead of local, set `API_BASE_URL=<that URL>` in `e2e/.env`.
Send the output — if onboarding now runs, we'll see whether its body needs any fix,
then owner login, then the CI job.

## Rollback
`git restore e2e/seed/seed-business.mjs docs/AUDIT-REGISTER.md && rm docs/MANIFEST-2026-08-31-k.md`
