# MANIFEST 2026-09-13-f — CI fix round 2 (RLS + root-clean)

**Base:** the `-e` commit. **No `version` field touched.** No behaviour change.

## Why
After -e, two jobs stayed red:
- **RLS coverage (Schema drift job)** — `check-rls-coverage`: migration 102 created
  `day_close_instructions` with no RLS statement. Every table created in a migration must
  enable RLS + a policy (or be excepted).
- **Repo root is clean / rule 19 (Desktop row scope job)** — `VERIFY-CLOSEOUT-2026-09-14.md`
  was committed to the **repo root**. That's the flat file I shared without a `docs/` path —
  my mistake. It belongs in `docs/`.

## Files (in this zip)
| File | Change | Why |
|---|---|---|
| `migrations/102_day_close_instructions.sql` | Add `ALTER TABLE … ENABLE ROW LEVEL SECURITY` + `owner_all` policy (payment_methods/86 pattern; no GRANTs — all access is server-side service_role) | Fixes `check-rls-coverage` |
| `scripts/test-migration-102.mjs` | Bootstrap `auth.uid()` + `public.businesses` before running the migration (mirrors `test-migration-86`) | The RLS policy references them, so PGlite needs them to run the migration |
| `docs/AUDIT-REGISTER.md` | Changelog `-f` note | Rule 14 |
| `docs/MANIFEST-2026-09-13-f.md` | NEW — this file | Rule 2 |

## Separate action NOT in this zip — the root-clean fix
`VERIFY-CLOSEOUT-2026-09-14.md` is a **move**, not a file to extract:
```
git mv VERIFY-CLOSEOUT-2026-09-14.md docs/VERIFY-CLOSEOUT-2026-09-14.md
```
(If `git mv` complains it's untracked or already gone, just ensure the file lives at
`docs/VERIFY-CLOSEOUT-2026-09-14.md` and nothing named `VERIFY-CLOSEOUT-*.md` sits in the root.)
While you're there, confirm `VERIFY-SHIFT-DAY-PARITY.md` is under `docs/` too, not the root.

## Verification (rule 7)
- `node scripts/check-rls-coverage.mjs` → **OK (102/102 tables state their RLS)**.
- `node scripts/check-schema-drift.mjs` → OK; `python3 scripts/schema-audit.py --strict` → total 0.
- `check-register-consistency`, `check-doc-refs`, `check-root-clean` (my clone) → green.

## NOT verified here — confirm on CI (rule 16)
- **server tsc** and **`run-migration-tests`** incl. `test-migration-102` — no `node_modules`
  /Postgres on the bench. The RLS block + test bootstrap mirror the passing `86_payment_methods`
  exactly, so PGlite should run it clean; re-confirm on the pipeline.

## Rollback
```
git checkout <-e commit> -- migrations/102_day_close_instructions.sql scripts/test-migration-102.mjs docs/AUDIT-REGISTER.md
git rm docs/MANIFEST-2026-09-13-f.md
```
