# MANIFEST 2026-08-17-f — A113 tech-access hardening (retire v1 HMAC)

**Base:** apply on top of A108–A112. Register ID **A113**. Server + prod-config
only; no behaviour change to the live v2 Ed25519 tech-token path.

Retires the legacy v1 HMAC tech-token path (accepted but unminted — a forgery
surface) and the hardcoded default `TECH_HMAC_SECRET` in `admin.ts` (used only by
dead code). All changes are deletions.

## Files (6)

| File | Change |
|---|---|
| `apps/server/src/routes/tech.ts` | `verifyTechToken` now `st2.`-Ed25519 only; removed the v1 HMAC branch and the `TECH_HMAC_SECRET` const/guard. |
| `apps/server/src/routes/admin.ts` | removed the dead v1 `generateTechToken` + hardcoded default secret. |
| `apps/server/src/lib/env.ts` | dropped the now-dead `TECH_HMAC_SECRET` requirement. |
| `apps/server/src/lib/envGuard.ts` | comment now cites a secret that still throws at import. |
| `render.yaml` | removed the dead `TECH_HMAC_SECRET` env var (`TECH_SIGNING_*` keys remain). |
| `docs/AUDIT-REGISTER.md` | A113 entry. |

## Verified (Node 22 bench)

- `apps/server` `tsc` clean; no functional `TECH_HMAC_SECRET` references remain
  (only a retirement comment).
- Mode-switch tokens unaffected — they are random codes looked up by sha256
  hash, never HMAC.
- `render.yaml` valid YAML; `TECH_SIGNING_PRIVATE_KEY`/`PUBLIC_KEY` intact.
- Register + doc-refs + supabase-catch gates green. No test fed a v1 token.

## NOT done (owner / optional)

- Confirm `TECH_SIGNING_PRIVATE_KEY` + `TECH_SIGNING_PUBLIC_KEY` are set in Render
  prod, and the desktop's cached public key matches (mismatch → offline verify
  fails).
- Optional: a test asserting a v1-shaped token is now rejected (mutation-style).
- Low-sev residue: offline revocation lags to the 48h token expiry — rotate the
  branch reveal code when a tech's access should end.

## Rollback

Per file: `git checkout -- <path>`.
