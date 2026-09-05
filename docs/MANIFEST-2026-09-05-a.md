# MANIFEST 2026-09-05-a — A211 catalogue repair + A212 Printers key (+A213–A215 filed)

**Base commit:** `e495e9d` (origin/dev tip; dashboard deploy verified byte-current).
**Delivery:** two patches, apply with `git apply` (NOT `git am` — no mailbox, no `0001-*` glob).
No renames or deletes. No version bumps (no desktop change — rule 22 N/A).

## What this closes / advances
- **A206 → CLOSED** (browser-verified in the owner-run manager-PIN pass: Open POS opens the terminal and stays; Lock returns to PIN).
- **A211 FIX BUILT** — the permission catalogue is missing 7 keys on this dump-seeded DB (`customers.view/manage`, `inventory.receive/adjust`, `ingredients.manage`, `reports.view/financial`). Root cause of the A133b + A205 verify failures.
- **A212 FIX BUILT** — manager Printers gated on owner-only `settings.manage`; re-pointed to `stations.manage`.
- **A213 / A214 / A215 OPEN** — filed (self-heal gate; branch-sync hang; ungated `inventory.ts` writes). Not built.

## Files
| File | Change | Why | Rollback |
|---|---|---|---|
| `migrations/99_permission_catalogue_repair.sql` | NEW | A211 — register the 7 missing keys (verbatim 09/24/27, `ON CONFLICT DO NOTHING`) + grant per tier mirroring `defaultRolePermissions`; A61-safe, `NOT EXISTS`-guarded, `public.`-qualified. | Delete file; on any DB it was applied to, run the ROLLBACK block in the file header. |
| `scripts/test-migration-99.mjs` | NEW | A211 — PGlite proof: registration, per-tier grants, A61 space-name coverage, idempotency, ledger. Auto-discovered by `run-migration-tests.mjs`. | Delete file. |
| `apps/dashboard/src/pages/manager/ManagerDashboard.tsx` | EDIT (1 line) | A212 — Printers nav `permission: 'settings.manage'` → `'stations.manage'`. | Revert the one line back to `'settings.manage'`. |
| `tests/manager-nav-grouped.test.mjs` | EDIT (+1 assertion) | A212 — pin Printers to `stations.manage`, forbid `settings.manage`. | Remove the added `ok('Printers gates on stations.manage …')` block. |
| `docs/AUDIT-REGISTER.md` | EDIT | A206 CLOSED; A211–A215 entries added; Counts line updated. | `git checkout -- docs/AUDIT-REGISTER.md`. |
| `docs/MANIFEST-2026-09-05-a.md` | NEW | This manifest. | Delete file. |

## What ran + output (rule 7)
```
node scripts/test-migration-99.mjs            all green (16 passed, 0 failed)   [PGlite, node 22]
  mutation A (neuter manager grant)           4 FAIL naming the manager-tier assertions
  mutation B (reintroduce A61 space-name bug) 1 FAIL — "Branch Manager" only; Manager/Supervisor stay green
  restored                                    16/16 green; file byte-identical to backup
node tests/manager-nav-grouped.test.mjs       all green (4 passed)  (incl. new A212 assertion)
  mutation (revert Printers flip)             FAIL naming the A212 assertion; restored → green
apps/dashboard: npx tsc --noEmit              exit 0
node scripts/check-register-consistency.mjs   see run below
node scripts/check-doc-refs.mjs               see run below
```

Environment: Linux, Node 22, PGlite (`@electric-sql/pglite`). No desktop/SQLite-under-Electron code here, so the Windows/Electron caveat (rule 9) does not apply to this batch.

## What could NOT be verified from here (rule 16)
- **Live apply on dev + browser-reverify** of A133/A205 (needs the migration applied, then the manager-PIN pass re-run). A211/A212 stay FIX BUILT until then.
- **Prod catalogue state** — run the blast-radius query against prod; if the same dump-seed gap exists, migration 99 is needed there too (planned apply).
- **A215** — the Render server's deployed commit was not confirmed against this source (only the dashboard deploy was verified current). Confirm before treating the ungated route as live-exploitable; do not fire a write at prod to test it.

## Apply steps (dev)
1. `git apply swiftpos-A211-A212-code-2026-09-05.patch && git apply swiftpos-A211-A215-register-docs-2026-09-05.patch`
2. `export DATABASE_URL='<dev session-pooler string>'; MIGRATE_ENV=dev npm run db:migrate` (applies 99).
3. Re-run `QA-VERIFY-MANAGER-2026-09-04.md` under a manager PIN → expect Receiving/Reports/Customers now present, Printers present, receive-transfer + GRN exercisable.
4. Run the blast-radius query on prod to decide the prod apply.

## Header changelog text (paste into AUDIT-REGISTER.md's top changelog cell — not machine-edited to avoid the §5 mega-cell corruption risk)
> 2026-09-05 — MANAGER-PIN VERIFY (owner-run browser pass) + FIXES. A206 CLOSED (Open POS opens the terminal, stays, Lock→PIN). A133/A205 FAILED — root-caused to **A211**: the live `permissions` catalogue is missing 7 keys (`customers.view/manage`, `inventory.receive/adjust`, `ingredients.manage`, `reports.view/financial`) first registered by 09/24/27; `schema_migrations` marks 09/24/27 applied but their rows are absent (dump-seed fingerprint: `swiftpos_consolidated_migration`/`all_phases_migration`/`pos_migration_v26..v30`/`40_correct_migration_log`), so requirePermission fails closed and the nav hides the tabs (A57 class, observed live). FIX BUILT: migration `99_permission_catalogue_repair` (register 7 verbatim + grant per tier, A61-safe, idempotent; PGlite test 16/16, mutation-checked). **A212** FIX BUILT: manager Printers was gated on owner-only `settings.manage`; re-pointed to `stations.manage` (managers hold it per mig 79) + source guard. Opened **A213** (no gate compares the live catalogue to code's keys — self-heal proposal), **A214** (manager Staff/Printers hangs on "Syncing branch…": branch-sync effect has no timeout/error path), **A215** (`inventory.ts` `POST /adjust` + `PATCH /threshold` ungated — any authenticated staffer can set branch stock; authz gap, from source). Counts: A-P1 +A211 +A215; A-P2 −A206 +A212 +A213 +A214. OPEN: apply 99 on dev + browser-reverify; blast-radius query on prod. Delivery: `docs/MANIFEST-2026-09-05-a.md`. `check-register-consistency` + `check-doc-refs` green.
