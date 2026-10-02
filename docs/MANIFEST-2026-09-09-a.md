# MANIFEST 2026-09-09-a — A270: clear CI red on `dev` (4 jobs)

**Base:** `origin/dev` @ `1ab6121`. **No migration. No exe rebuild. No runtime code path changed.**
Additive / behaviour-preserving: TypeScript declarations, one duplicate-line removal, two tooling
JSON files, and six test-guard repairs. Web/tooling only — nothing that ships to a till changes.

## Why (rule 5/7)
CI was RED on `dev` and had been since ~A261/A266/A269, while recent register entries claimed
"gates green" — those greens came from narrow local runs of the one or two suites each delivery
touched, not the full-suite run rules 8/20 require. Read all four CI logs verbatim and fixed each
failure at source. Two were real defects; the rest were stale tooling data / stale test guards
(the rule 23/24 failure mode).

## The four red jobs → cause → fix
### 1. Type-check (ratchet) — REAL (6 dashboard `tsc` errors, reproduced 6→0)
- `escposRenderer.d.ts` had drifted from its own generated bundle across A252→A269 (the bundle
  gained `stationHasContent`, `renderShiftReportEscPos`, a `type`/`proforma`-shaped station, and a
  4th optional `reprint` arg). The `.d.ts` still declared the old `{id,kind,paperWidthMm}` station
  and a 3-arg render. Rewrote the `.d.ts` to mirror the bundle exactly (source of truth = the
  generated `.js`). → 5 errors.
- `ReceiptBusinessConfig` in `buildReceiptOrder.ts` declared `branchName` **twice** (an A255
  copy-paste). Removed the bare duplicate, kept the documented one. → 1 error.

### 2. Schema drift — STALE tooling data (two failing steps; CI stopped at the first)
- `schema-audit.py --strict`: `stock_transfer_items.quantity_received` selected in `routes/stock.ts`
  is a REAL column (migration `101_transfer_received_quantity.sql` / A221) missing from a stale
  `scripts/schema-index.json`. Regenerated additively via `build-schema-index.mjs --merge-migrations`
  (+`quantity_received`, +`stock_transfers.receipt_note`; nothing removed).
- `check-schema-drift.mjs`: `scripts/schema-pending.json` still declared migration 77 (A55) pending,
  but its functions (`increment_customer_spend`, `adjust_customer_visits`) are live in
  `functions-index.json`. Cleared the entry per the gate's own self-clearing instruction — this
  RE-ENABLES signature checks on those functions; it does not silence.

### 3. Server suites — 6 failing subtests across 3 files (all STALE guards)
### 4. Desktop row scope — 1 failing subtest (STALE guard: `mailer-transport`)
Every guard fixed to match the CURRENT correct code and **mutation-checked** (reintroduce the real
defect → the guard reddens naming the right file):
- `tiny-bridge` A252 spec — A269 added `proforma` to the spec object; match the prefix + assert proforma.
- `tiny-bridge` PaymentModal fallback — A266 renamed `business.name` → `resolvedBusiness?.name ?? 'Receipt'`.
- `ui-reports` A261 — A269 added `proforma` to `renderTicket({…})` in `entry.ts`.
- `print-documents` ×4 docType — A234 moved the literals + Variance column into `documentSpecs.ts`.
- `reports-refunds` Exports hub — the guard demanded the OLD `window.open` (which 401'd, no token);
  the code correctly uses the authed `downloadFile`. Now asserts `downloadFile` AND forbids `window.open`.
- `mailer-transport` — A200 deliberately logs the diagnostic and returns a generic client message;
  the guard now enforces that contract (no raw `result.error` in the response body).
- `manager-receiving` — NOT a pure stale guard. A221/A228 deliberately added PO-creation and
  transfer-initiation to the tab (each covered by `manager-create-po` / `manager-initiate-transfer`),
  so the guard's "receive-only, no edit path" premise was false by design. Replaced the stale blanket
  with the invariant that still holds: the receiving tab must never directly ADJUST stock. Mutation-
  checked both ways (inject `/stock/adjust` → red; remove GRN receive → red).

## Files
| File | Change | ID |
|---|---|---|
| `apps/dashboard/src/lib/escposRenderer.d.ts` | mirror the generated bundle: add `stationHasContent`, `renderShiftReportEscPos`, `ReprintMeta`; `WebStation` → `{id,type,paperWidthMm,proforma?}`; render `reprint?` optional | A270 |
| `apps/dashboard/src/lib/buildReceiptOrder.ts` | remove duplicate `branchName` in `ReceiptBusinessConfig` | A270 |
| `scripts/schema-index.json` | +`stock_transfer_items.quantity_received`, +`stock_transfers.receipt_note` (from migration 101; additive) | A270 |
| `scripts/schema-pending.json` | clear the stale migration-77 entry (functions are live) | A270 |
| `tests/tiny-bridge-printing.test.mjs` | fix A252 spec + PaymentModal fallback guards | A270 |
| `tests/ui-reports-fixes.test.mjs` | fix A261 `renderTicket` guard (proforma) | A270 |
| `tests/print-documents.test.mjs` | read docType literals from `documentSpecs.ts` (A234) | A270 |
| `tests/reports-refunds-and-exports.test.mjs` | assert authed `downloadFile`, forbid `window.open` | A270 |
| `tests/mailer-transport.test.mjs` | enforce the A200 log-not-leak contract | A270 |
| `tests/manager-receiving.test.mjs` | GRN typed-call regex; no-stock-adjust invariant (A221/A228) | A270 |
| `docs/AUDIT-REGISTER.md` | A270 entry + changelog | — |
| `docs/MANIFEST-2026-09-09-a.md` | this delivery record | — |

**Not included (rule 22):** `package-lock.json` (touched only by a local `npm install`; reverted).

## What ran + output (rule 7)
```
dashboard tsc --noEmit          6 → 0 errors
server    npm run build (tsc)   OK (noEmitOnError)
ratchet   dashboard/server      0 errors (baseline held)
schema-audit.py --strict        total: 0
check-schema-drift.mjs          OK — migrations and database agree
check-api-schema-drift (+self)  OK ; 11/11 self-tests
tests/*.test.mjs                96/96 suites green (server built for the 3 dist-dependent suites)
run-migration-tests.mjs         All 25 migration test files passed
gates                           register-consistency, doc-refs, root-clean, test-registration,
                                client-parity, permission-parity, push-domain-parity, rls-coverage,
                                ipc-parity, header-keys, auth-retry, own-rows, sql-binds,
                                row-attribution, notnull-writes, permission-catalogue — all OK
```

### Mutation-checks (rule 10/23/24)
| Guard | Reintroduced defect | Result |
|---|---|---|
| tiny-bridge A252 | remove `proforma` from spec | RED (A252) |
| tiny-bridge fallback | revert to `business.name` | RED (fallback) |
| ui-reports A261 | remove `proforma` from `renderTicket` | RED (A261) |
| print-documents | break `PURCHASE ORDER` / `Variance` in documentSpecs | RED (right subtest) |
| reports-refunds exports | revert `downloadFile` → `window.open` | RED (Exports hub) |
| mailer-transport | put `result.error` back in the 502 body | RED (provider/safe-message) |
| manager-receiving | inject `/stock/adjust`; remove GRN receive | RED both ways |

## NOT verified here (rule 16)
- The `admin` workspace `tsc` was not run here (its deps weren't installed); it was not the failing
  ratchet workspace (the failure was dashboard `+6`). CI installs and checks all three.
- `schema-index.json` was refreshed by the offline `--merge-migrations` path (best effort). The
  authoritative refresh is `build-schema-index.sql` against the live DB (`--from-db`); re-run when
  convenient. The two added columns match migration 101 exactly.
- Nothing that prints or sells changed, so there is no till/runtime verification to do.

## Apply
```
git pull origin dev            # base 1ab6121
# extract this zip over the repo root, then:
cd apps/server && npm ci && npm run build && cd ../..   # for the 3 dist-dependent suites
node scripts/check-schema-drift.mjs
python3 scripts/schema-audit.py --strict
node scripts/check-register-consistency.mjs && node scripts/check-doc-refs.mjs
for f in tests/*.test.mjs; do node --no-warnings "$f" || echo "FAILED $f"; done
git add -A && git commit -m "A270: clear CI red on dev (type decls, schema-index, 6 stale guards)"
git push origin dev
```
Rollback: revert the A270 commit — every change is one-file restorable.
