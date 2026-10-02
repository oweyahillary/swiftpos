# MANIFEST 2026-09-21-f — cloud: A303 business_branding table + server CRUD

**Supersedes 2026-09-21-e** (Rule 3). Code + register ship together (Rule 14).

**Base commit:** `25804fb` (`dev` tip — the A302 feed). If `dev` moved, apply the register edits
(below) by hand rather than extracting the full register.
**Scope:** cloud only — migration + schema-index + one server route file + a migration test +
the register entry. No desktop code, no version bump (Rules 15, 22).
**Working rules:** unchanged — `HANDOFF-2026-08-08-evening.md §0`.
**Register ID:** A303. **NEEDS PROD-MIGRATE: apply migration 104 on the prod DB (owner).**

## Why

A301 (write path) + A302 (feed) write the *local* branding row; there was no cloud store. This
is the cloud source of truth + write API — the cloud half of the A295 sync (SCOPE §3, §7, §10
step 1). The sync-down (pos/init serve + desktop pull into the local mirror, remote-wins) is the
next slice, A304.

## What changed and why

| File | New? | Change | ID |
|---|---|---|---|
| `migrations/104_business_branding.sql` | **new** | `business_branding` (business_id PK/FK CASCADE, accent_hex, logo_png base64, logo_receipt reserved, updated_at + created_at). `set_updated_at` BEFORE UPDATE trigger (A291 signal). RLS + business-member policy + grants, mirroring branch_settings (91). Idempotent (`DROP … IF EXISTS` before CREATE POLICY/TRIGGER — migration-102 lesson). Self-registers in schema_migrations. | A303 |
| `apps/server/src/routes/business.ts` | edit | `GET /branding` (any member reads) + `PUT /branding` (gated `receipt.manage`\|`settings.manage`), validated at the persist boundary like the desktop guard: hex accent, PNG/JPEG data-URI ≤250 KB, **SVG rejected**. Omit = keep, null = clear. | A303 |
| `scripts/schema-index.json` | edit | Add `business_branding` (keeps `check-schema-drift` green). | A303 |
| `scripts/test-migration-104.mjs` | **new** | PGlite test (8): columns/types, RLS enabled, PK, trigger overrides updated_at, FK cascade, self-registration, idempotent re-run. Auto-discovered by the CI `test-migration*.mjs` runner. | A303 |
| `docs/AUDIT-REGISTER.md` | edit | A303 entry + Open `17 P3`→`18 P3` + Counts `…A302 A303` + Tree `migrations → 104` + a `2026-09-21 (cloud)` changelog line. | A303 |

**Design decision (noted so SCOPE-A295 can be trued):** logo is stored **base64 in the row**,
not SCOPE §3's `logo_asset_id` + Supabase Storage bucket. A ≤250 KB cap (A301) does not justify
an asset subsystem, and SCOPE §4 explicitly permits base64 for small logos. Row shape matches the
local mirror. Same class of spec-correction as the SVG-sanitiser note.

## Verification (Rule 7 — what was run)

Bench, Linux/Node 22 (weak green, Rule 9):
- **`node scripts/test-migration-104.mjs` → 8/8 on real Postgres (PGlite)** — columns/types, RLS
  enabled, PK is business_id, the `set_updated_at` trigger overrides a written-old updated_at to
  now() (proves the A291 signal), FK cascade removes branding when the business is deleted,
  self-registration, and an idempotent second run.
- **Server `tsc --noEmit` → 0 errors** (business.ts clean).
- **`check-api-schema-drift`, `check-rls-coverage`, `check-api-routes` → OK**; schema-index valid
  JSON. Full static gate set green incl. register-consistency (A303, P3→18) and doc-refs (finds -f).

**Could NOT verify here (target/CI, Rule 16):** applying migration 104 on the prod DB (owner, in a
transaction — additive/reversible); the live GET/PUT endpoints against real Supabase; the A291
propagation timing. No desktop consumer yet (that's A304).

## Rollback (Rule 2)

```bash
git checkout 25804fb -- apps/server/src/routes/business.ts scripts/schema-index.json docs/AUDIT-REGISTER.md
rm -f migrations/104_business_branding.sql scripts/test-migration-104.mjs
```
On prod (if 104 was applied and must be undone): `DROP TABLE IF EXISTS public.business_branding;`
then `DELETE FROM public.schema_migrations WHERE version='104_business_branding';` (no other table
references it — safe).

## Commit (direct to dev, explicit paths — never `git add -A`)

```bash
git checkout dev && git pull                    # confirm 25804fb; else re-apply the register edits
git add migrations/104_business_branding.sql scripts/test-migration-104.mjs \
        scripts/schema-index.json apps/server/src/routes/business.ts \
        docs/AUDIT-REGISTER.md docs/MANIFEST-2026-09-21-f.md
git status --short                              # expect exactly these six
node scripts/check-register-consistency.mjs && node scripts/check-doc-refs.mjs
git commit -m "feat(cloud): A303 business_branding table + server CRUD (migration 104) + register"
git push
```

Then: CI green on `dev`, and **apply migration 104 on prod** before the A304 sync-down ships.
