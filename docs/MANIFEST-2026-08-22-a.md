# MANIFEST 2026-08-22-a — register trueing-up + migration 68 recovery (A4)

**Register:** closes **A4, A68, A71, A72**; annotates A69, A70, D18 (kept OPEN).
**Base commit:** `6c7495b` (A139) · branch `dev`
**Environment of evidence:** Linux bench, Node v22.22.2, static/source reads only
(rule 9). No desktop run, no browser pass. Live DB signature confirmed by the
owner (see A4).

---

## What changed and why

### Code
- **`migrations/68_loyalty_rpc_parameter_name.sql` — NEW (recovered).** The file
  A4 says "exists only in production" was lost from git; recovered and committed
  so a fresh DB matches the live one. **No prod effect:** the ledger row
  `68_loyalty_rpc_parameter_name` was inserted into `public.schema_migrations`,
  so the migrate Action treats it as already applied and never touches the live
  function. Idempotent (`DROP IF EXISTS` + `CREATE`, `ON CONFLICT DO NOTHING`) if
  a fresh DB ever runs it. 68 was a numbering gap — no collision.

### Docs (`docs/AUDIT-REGISTER.md`)
- **A4 · P1 → CLOSED.** Migration 68 now in the repo; live signature is
  `p_customer_id uuid, p_points integer`, matching migration 53, `functions-index.json`,
  and what `orders.ts` sends on `dev` and `main`.
- **A68 · P3 → CLOSED.** Env deploy badge built + wired (`appFlavor.ts` in both
  web apps, called from `main.tsx`). Remaining step is an owner Vercel var.
- **A71 · P3 → CLOSED.** `DevicesTab.tsx` shows branch/role/last-active/version/enrolled.
- **A72 · P3 → CLOSED.** `DevicesTab.tsx` has rename + stale-sync badge.
- **A69, A70, D18 — annotated, kept OPEN.** Code-complete on dev; browser pass
  pending before close (rule 16).
- **Header trued to body:** `| Open |` A-P1 `10 → 9`, A-P3 `6 → 3`; `| Counts |`
  updated; dated note prepended to `| Last updated |`.

## Not closed, on purpose
A73 (register says nav link *restored*, not re-confirmed on bench), A12 (*FIX
APPLIED pending live check*), and everything else stay as they were. Nothing
closed on bench evidence alone.

## Verification (what was run, what it printed)
- `check-register-consistency` → `OK — no duplicate IDs, and the header agrees with the body.`
- `check-doc-refs` → `OK — every cited document is in the tree.`
- `check-schema-drift` → **now green** (`OK — the migrations and the database agree`,
  87 migrations / 100 tables / 17 functions). Was red at the start of the session
  (stale index missing `branch_settings`); regenerated — see below.
- `check-api-schema-drift`, `check-package` → green.

## Schema-index regeneration
`scripts/schema-index.json` was stale — `branch_settings` (migration 91, A139) was
absent, so `schema-audit.py` validated against a schema that no longer matched.
Regenerated with `node scripts/build-schema-index.mjs --merge-migrations` (added
`branch_settings` + 14 columns; removed nothing). This is the tool's sanctioned
best-effort mode for when the DB is unreachable. **Follow-up:** re-run
`--from-db` against the live cloud DB when reachable, per the tool's guidance.

## Handoff
`docs/HANDOFF-2026-08-22.md` — the missing catch-up handoff for **A112→A139**,
reconstructed from the commit log, interim manifests and the register changelog.
Leads with the `dev`/`main` divergence and the three pending prod migrates (89,
90, 91), which are the session's most important operational finding.

## Rollback
```
git checkout HEAD -- docs/AUDIT-REGISTER.md scripts/schema-index.json
git rm migrations/68_loyalty_rpc_parameter_name.sql docs/HANDOFF-2026-08-22.md docs/MANIFEST-2026-08-22-a.md
```
DB-side: the pre-seeded `schema_migrations` row is harmless to leave; remove with
`delete from public.schema_migrations where version='68_loyalty_rpc_parameter_name';`
only if you also drop the file.

## Still outstanding at the process level (not addressed here)
- **`dev`/`main` divergence** — production is 28 commits (A112→A139) behind, and
  migrations 89/90/91 are unapplied to prod. This is the top operational item;
  see `HANDOFF-2026-08-22.md` §0.
- Two migration files share number **90** (both the A129 delivery fix) — one is redundant.
- `schema-index.json` is green but was regenerated `--merge-migrations`; re-run
  `--from-db` when the cloud DB is reachable.
