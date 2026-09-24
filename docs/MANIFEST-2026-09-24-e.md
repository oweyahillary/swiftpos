# MANIFEST 2026-09-24-e — Phase 2 slice 2: `theme_id` + the `themes` flag, cloud to till (A325) · desktop v0.6.5 row

**Base commit:** `d8428bd` (origin/dev, delivery 2026-09-24-d; 7/7 checksums on the tip, gates exit 0, CI #392 green → A324 CLOSED).
**Register:** A325 NEW → FIX BUILT (P3); A324 → CLOSED; A323 tracker updated; Tree row → desktop **v0.6.5**, `LOCAL_SCHEMA_VERSION` **54**.
Counts unchanged (A324 −1, A325 +1): **18 P1 · 17 P2 · 19 P3**.
**Visible change:** none (screens use the value from slice 3). The admin portal gains a toggle.

## ⚠️ DEPLOY ORDER — this is the first slice where order matters
1. **Apply `migrations/106_branding_theme.sql`** to the database (additive, idempotent).
2. **Then deploy the cloud.** The new cloud SELECTs `business_branding.theme_id`; deployed before 106, `/api/pos/init` would
   fail for every till.
3. Deploy the admin portal (the toggle).
4. Desktop **0.6.5**: `npm version 0.6.5` is in Block 3; tag after CI is green (WORKING-METHOD §7).
Until a business's `themes` flag is turned on, nothing changes for it anywhere.
After 106 is applied: re-run `node scripts/build-schema-index.mjs --from-db <file>` when convenient (this delivery used the
documented `--merge-migrations` fallback: +1 column, nothing removed).

## What
**Cloud.** Migration 106 adds `business_branding.theme_id text` (nullable, no default, no CHECK — the registry is the one list).
`apps/server/src/lib/themes.ts` (4th synced copy). `themeRules.ts` (pure): `effectiveThemeId` (null while the flag is off; else the
chosen id or Ocean) and `themeWriteError` (null clears; a curated id only with the flag). `themeAccess.ts`: the one flag query
(`feature_flags` key `themes`). `GET /business/branding` + `theme_id`, `themes_enabled`; `PUT` validates `theme_id`; `/pos/init`
serves top-level `themeId`; **`/pos/catalogue-version` watches `feature_flags`** (a flag flip reaches tills in ~20 s, not 10 min);
`REQUIRED_DESKTOP_SCHEMA` 54.
**Till (schema 54).** `branding.theme_id` (CREATE + upgrade); `applyPulledTheme` writes only theme_id (undefined = keep; null = clear;
malformed → null); `getBranding`/`setBranding` report `themeId`; the pull reads `themeId` top-level. Not relayed through branch nodes —
the node bundle relays no branding today either (pre-existing; follow-up).
**Admin.** "App themes ON/OFF" beside web hosting (same audited flag endpoint; no invoice).

## Files (22)
| File | Change |
|---|---|
| `migrations/106_branding_theme.sql` | **NEW.** |
| `scripts/test-migration-106.mjs` | **NEW.** PGlite, 8 checks (runner globs it). |
| `apps/server/src/lib/themes.ts` | **NEW** synced copy. |
| `apps/server/src/lib/themeRules.ts` | **NEW.** Pure rules. |
| `apps/server/src/lib/themeAccess.ts` | **NEW.** Flag query. |
| `apps/server/src/routes/business.ts` | GET/PUT theme_id. |
| `apps/server/src/routes/pos.ts` | `/pos/init` themeId; catalogue-version + feature_flags. |
| `apps/server/src/lib/desktopSchema.ts` | Required schema 54. |
| `scripts/check-shared-sync.mjs` | themes.ts: 4 copies. |
| `scripts/schema-index.json` | + `business_branding.theme_id` (merge-migrations). |
| `tests/theme-access.test.mjs` | **NEW.** 17 checks. |
| `apps/desktop/src/main/localDb.ts` | Column, upgrade, schema 54, getter, `applyPulledTheme`, setBranding return. |
| `apps/desktop/src/main/syncEngine.ts` | Pull reads/stores `themeId`. |
| `apps/desktop/src/main/referenceBundle.ts` | Config type `themeId?`. |
| `apps/desktop/test/theme-pull.test.mjs` | **NEW.** 14 checks, real localDb. |
| `apps/desktop/test/catalogue-refresh-signal.test.mjs` | localDb shim exports `applyPulled*`. |
| `tests/branding-sync-pull.test.mjs` | Two exact-text pins moved by this slice, rewritten to their intent (receipt fields still selected; schema ≥ 53); both still bite. |
| `apps/desktop/package.json` | `test:theme-pull`. **Version field untouched here** — Block 3 runs `npm version 0.6.5`. |
| `.github/workflows/ci.yml` | Step "Desktop theme pull". |
| `apps/admin/src/AdminPortal.tsx` | Themes toggle. |
| `docs/AUDIT-REGISTER.md` | A325; A324 CLOSED; tracker; Tree row v0.6.5 / schema 54; header; changelog. |
| `docs/MANIFEST-2026-09-24-e.md` | This file. |

## Verification (rule 7)
```
node scripts/test-migration-106.mjs 8/8 · node scripts/run-migration-tests.mjs: all 29 passed
node tests/theme-access.test.mjs 17/17 (real built rules + route pins)
node apps/desktop/test/theme-pull.test.mjs 14/14 (real localDb; schema-53 file upgraded, colour/logo/toggle kept)
mutations: flag ignored in effectiveThemeId · write allowed without flag · feature_flags dropped from catalogue-version ·
  no upgrade step · undefined treated as clear · any string accepted → each bites
catalogue-refresh-signal 18/0 · syncEngine-failures 29/0 · branding-set 42/0 · test-print-business-name 9/0 · node-reference 25/0, 19/0
server build 0 · desktop main tsc 0 · renderer tsc 0 · admin tsc 0 + build 0 · typecheck-ratchet OK
check-shared-sync (11 copies) · check-schema-drift · check-api-schema-drift · check-table-usage · schema-parity (warnings unchanged, 2)
check-test-registration · check-reference-names · check-doc-refs · check-root-clean → OK
check-register-consistency: red until `npm version 0.6.5` is in the same commit (by design); rehearsed → OK
node scripts/run-all.mjs → 119 passed, 1 failed: check-register-consistency ONLY (Tree line stale — package.json 0.6.4 until npm version 0.6.5, by design)
```

## Not verified here (rule 16) — owner, after the deploys
1. Admin → the client → **Turn themes on** → within ~20 s, on the till: Technician mode › Database →
   `SELECT theme_id FROM branding` → `ocean`.
2. **Turn themes off** → `NULL` within ~20 s. The screens look exactly as before throughout.
3. The till shows **v0.6.5**.

## Rollback (before tagging)
```bash
git checkout d8428bd -- . && rm -f migrations/106_branding_theme.sql scripts/test-migration-106.mjs apps/server/src/lib/themes.ts \
  apps/server/src/lib/themeRules.ts apps/server/src/lib/themeAccess.ts tests/theme-access.test.mjs \
  apps/desktop/test/theme-pull.test.mjs docs/MANIFEST-2026-09-24-e.md
```
If migration 106 was already applied, it can stay: an unused nullable column is harmless (or `ALTER TABLE business_branding DROP COLUMN theme_id`).
After a tag is pushed, do not move it — cut v0.6.6 instead.
