# MANIFEST — 2026-08-23-g

**Batch:** A150 — refresh the stale `apps/server/.env.example`.
**Cumulative:** follows -a…-f. Apply after -f.

**Base commit:** `f80f0e9` (`dev` tip). Applies on top of -a…-f.

**Working rules:** `HANDOFF-2026-08-08-evening.md` §0, rules 1–23.

---

## Files changed

| File | Change | Why |
|---|---|---|
| `apps/server/.env.example` | Rewritten from current source. Removed the retired `TECH_HMAC_SECRET`; added every other variable the server reads, grouped required-to-boot / required-in-production / recommended / optional, with key-generation commands and a first-admin (`reset-admin.ts`) note. | A150 — the old example omitted the production-required set and listed a retired var; a fresh deploy following it would fail `validateEnv()` at boot. |
| `docs/AUDIT-REGISTER.md` | Added `### A150 · P3 · CLOSED 2026-08-23`; changelog note; "Next free ID" → A151. | Rule 14. Closed same-batch (static file, nothing to verify on a target). |
| `docs/MANIFEST-2026-08-23-g.md` | New (this file). | Rule 2. |

## What the new example covers (grouped)

- **Required to boot:** `PORT`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET`, `ADMIN_JWT_SECRET`.
- **Required in production:** `TECH_SIGNING_PRIVATE_KEY`, `TECH_SIGNING_PUBLIC_KEY`, `MPESA_ENVIRONMENT`.
- **Supabase auth:** `SUPABASE_ANON_KEY`, `SUPABASE_JWT_SECRET`.
- **Recommended:** `APP_ENCRYPTION_KEY`, `CORS_ORIGINS`, `DASHBOARD_URL`, `MPESA_CALLBACK_BASE_URL`.
- **Mail (optional):** `RESEND_API_KEY`, `SMTP_*`, `NOTIFY_FROM_EMAIL`.
- **Optional / feature-gated:** `MPESA_ALLOWED_IPS`, `MAX_DISCOUNT_PCT`, `DAILY_SUMMARY_CRON`, `ETIMS_RETRY_CRON`, `ETIMS_PROVIDER` + `ETIMS_*`, `WHATSAPP_PROVIDER` + `WHATSAPP_*`/`TWILIO_*`, `NODE_ENV`.
- **Deprecated note:** `TECH_HMAC_SECRET` (do not set).

## Verification (rule 7)

- Completeness: diffed the example's keys against every `process.env.*` the server reads (`apps/server/src` + `shared`). The only two read vars not present are `ADMIN_EMAIL`/`ADMIN_PASSWORD`, which are CLI-only (`scripts/reset-admin.ts`) and intentionally not runtime env — documented as a comment instead. `TECH_HMAC_SECRET` confirmed no longer read anywhere.
- `node scripts/check-register-consistency.mjs` → green (A150 CLOSED; header unchanged, counts unaffected).
- No runtime code touched → nothing to type-check/build for this batch.

## Rollback

```
git apply -R A150-env-example-refresh.patch
```
