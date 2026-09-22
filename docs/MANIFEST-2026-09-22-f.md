# MANIFEST 2026-09-22-f — A311 · receipt logo slice 2: toggle column, served + pulled, schema 53

**Base commit:** `1286f0e` (origin/dev after -e). No shipped file has moved since; all ship whole.
**Register:** A311 FIX BUILT (new). A295 row 4, header (A-P3 21→22), Tree row (migrations → 105), changelog.
**Environment:** Linux, Node 22.22.2. PGlite = real Postgres for the migration; `node:sqlite` for the
local upsert (stand-in driver — the statement is the real one, the driver is not; rule 9).
**Desktop change** (`localDb.ts`, `syncEngine.ts`, `referenceBundle.ts`) → version bump at build, tag
after (rule 15). `package.json` NOT in this zip (rule 22). `LOCAL_SCHEMA_VERSION` 52→53.
**Cloud change** (`pos.ts`, `business.ts`, `desktopSchema.ts`) — deploy order: **cloud first, then migration
105, then tills** (a till on 53 pulling from a cloud without 105 simply keeps its local values; a cloud on
105 serving a till on 52 is ignored by that till — both directions are safe, but `REQUIRED=53` will show
52-tills as "behind" until they update).
**PROD-MIGRATE owed:** `migrations/105_receipt_logo_toggle.sql` — additive, idempotent, safe on live.

## Files (12)

| File | Change |
|---|---|
| `migrations/105_receipt_logo_toggle.sql` | NEW. `receipt_logo_enabled boolean NOT NULL DEFAULT false` + column comments + ledger row. |
| `scripts/test-migration-105.mjs` | NEW. PGlite, 7 assertions, all awaited (A305). Auto-discovered by the runner. |
| `scripts/schema-index.json` | `business_branding.receipt_logo_enabled` added. |
| `apps/desktop/src/main/localDb.ts` | Column in CREATE TABLE + `migrateColumns`; `LOCAL_SCHEMA_VERSION = 53`; `BrandingRow` type; `getBranding` returns the two fields; `applyPulledBranding` upserts them (absent = keep, null = clear). |
| `apps/desktop/src/main/syncEngine.ts` | Init-response mapping distinguishes absent from null (`'k' in`). |
| `apps/desktop/src/main/referenceBundle.ts` | Branding type widened (optional fields). |
| `apps/server/src/lib/desktopSchema.ts` | `REQUIRED_DESKTOP_SCHEMA = 53`. |
| `apps/server/src/routes/pos.ts` | `/init` selects + returns `logoReceipt`, `receiptLogoEnabled`. |
| `apps/server/src/routes/business.ts` | GET returns both; PUT validates `logo_receipt` shape + boolean toggle. |
| `tests/branding-sync-pull.test.mjs` | 15→26: real upsert SQL + real bind derivation extracted from source and executed. |
| `docs/LOCAL-SCHEMA-VERSIONS.md` | Row 53. |
| `docs/AUDIT-REGISTER.md` | A311; A295 row; header; Tree; changelog. |
| `docs/MANIFEST-2026-09-22-f.md` | This file. |

## Verification (rule 7)

```
node scripts/test-migration-105.mjs                     7 passed, 0 failed  (PGlite)
node --no-warnings tests/branding-sync-pull.test.mjs   26 passed, 0 failed
  M1 one bind dropped                 → FAIL "bind count matches placeholder count (8 args, 9 ?)"
  M2 absent treated as clear          → FAIL "a cloud WITHOUT the fields keeps the local raster and toggle"
  M3 cloud toggle no longer wins      → FAIL "cloud toggle OFF wins (remote-wins)"
  M4 server `!!` instead of `=== true`→ FAIL "server /init returns receiptLogoEnabled as a strict boolean"
  (M2/M3 did NOT bite on the first test version, which recomputed the keep-flags itself. The test
   now extracts and executes the source's own derivation block. Rule 24.)
apps/server  tsc --noEmit                exit 0
apps/desktop tsc -b tsconfig.main.json   exit 0 · tsc -p tsconfig.json --noEmit exit 0
check-schema-drift OK · schema-parity PASS (warnings only) · check-api-schema-drift OK
schema-audit --strict total 0 · check-push-domain-parity PASS · check-rls-coverage OK
check-notnull-writes OK · check-sql-binds OK · check-own-rows OK
LOCAL==REQUIRED pins: branch-close 28/0 · events 27/0 · maintenance 20/0 · node-distribution 25/0 · node-ingest 50/0
npm run test:migrations                 All 28 migration test file(s) passed
node scripts/run-all.mjs                == GREEN == 113 passed, 0 skipped
check-register-consistency OK · check-doc-refs OK (with this manifest present) · check-root-clean OK
```

## NOT verified (target-only)
- Migration 105 on the prod database.
- A real till pulling from a cloud on 105 and the row landing (`SELECT * FROM branding` in the tech console).
- Nothing PRINTS yet: the desktop print path does not read these fields until A312. Flipping the toggle
  today changes no receipt anywhere. That is deliberate — data first, then the consumer.

## Rollback
```bash
git checkout 1286f0e -- apps/desktop/src/main/localDb.ts apps/desktop/src/main/syncEngine.ts apps/desktop/src/main/referenceBundle.ts apps/server/src/lib/desktopSchema.ts apps/server/src/routes/pos.ts apps/server/src/routes/business.ts scripts/schema-index.json tests/branding-sync-pull.test.mjs docs/LOCAL-SCHEMA-VERSIONS.md docs/AUDIT-REGISTER.md
git rm -q migrations/105_receipt_logo_toggle.sql scripts/test-migration-105.mjs docs/MANIFEST-2026-09-22-f.md
```
(The prod column, once applied, stays — it is harmless and unread by a rolled-back build.)
