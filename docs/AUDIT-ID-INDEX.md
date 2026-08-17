# Audit ID index

**Generated 2026-08-10 by reading the tree. Not hand-maintained.**

## Why this file exists

`AUDIT-REGISTER.md` records that it was opened on 2026-08-07 with sections
`A1, B1-B5, C1-C6, D1-D3, E1-E4, F, G1-G2, H1-H2, I`. The 08-08 restructure —
*"open items first, closed items retained as evidence"* — kept **only A and D**.

Everything in B, C, E, F, G, H went with it, and **the code still cites those
IDs**. A reader who hits `// Audit H10` in `render.yaml` or `// audit C4` in
`index.ts` has nowhere to look.

**The originals are NOT recoverable from git.** The register's first committed
version (`a80c224`) already contained only A-section headings, so those entries
never reached the repository — they lived in a working copy or an external
document that was never committed. Reconstructing them would mean inventing
findings, which is worse than a gap you can see.

So this index does the one honest thing available: it lists every audit ID the
code cites and where, so a citation leads *somewhere* even when the original
text is gone.

## How to read the Status column

- **in register** — an entry exists in `AUDIT-REGISTER.md`; go read it.
- **cited only** — the code refers to it; the original text is not in this repo.
  Treat the surrounding comment as the only surviving description.

| ID | Status | Cites | Where |
|---|---|---|---|
| A9 | in register | 1 | `docs/AUDIT-REGISTER.md:1938` |
| B1 | **cited only** | 2 | `tests/pay-claim-and-loyalty.test.mjs:2`, `apps/server/src/routes/orders.ts:1624` |
| B2 | **cited only** | 1 | `apps/server/src/routes/orders.ts:1776` |
| B5 | **cited only** | 2 | `apps/dashboard/src/pages/pos/PaymentModal.tsx:57`, `apps/dashboard/src/pages/pos/PaymentModal.tsx:249` |
| B6 | **cited only** | 2 | `apps/server/src/jobs/dailySummary.ts:203`, `apps/server/src/jobs/lowStockChecker.ts:22` |
| C1 | **cited only** | 3 | `migrations/29_enable_rls_all_tables.sql:2`, `scripts/verify_rls_coverage.sql:1`, `apps/server/src/lib/pgQuery.ts:82` |
| C2 | **cited only** | 2 | `apps/server/src/lib/pgQuery.ts:91`, `apps/server/src/routes/business.ts:95` |
| C4 | **cited only** | 11 | `render.yaml:187`, `migrations/48_retire_seeded_admin.sql:2`, `migrations/48_retire_seeded_admin.sql:108`, `migrations/56_admin_portal.sql:70` |
| C5 | **cited only** | 3 | `apps/server/src/routes/orders.ts:1227`, `apps/server/src/routes/orders.ts:1534`, `apps/server/src/routes/orders.ts:1721` |
| C6 | **cited only** | 2 | `apps/desktop/src/main/syncEngine.ts:1000`, `apps/server/src/routes/sync.ts:274` |
| C7 | **cited only** | 4 | `apps/server/src/jobs/dailySummary.ts:227`, `apps/server/src/jobs/lowStockChecker.ts:45`, `apps/server/src/routes/discounts.ts:185`, `apps/server/src/routes/reports.ts:1795` |
| H1 | **cited only** | 1 | `apps/server/src/routes/orders.ts:27` |
| H2 | **cited only** | 6 | `shared/parkingTariff.ts:14`, `scripts/check-shared-sync.mjs:10`, `apps/desktop/src/shared/parkingTariff.ts:14`, `apps/server/src/shared/parkingTariff.ts:14` |
| H6 | **cited only** | 2 | `migrations/27_report_permissions.sql:2`, `apps/server/src/lib/defaultRolePermissions.ts:36` |
| H8 | **cited only** | 2 | `migrations/30_payment_exceptions.sql:2`, `apps/server/src/routes/mpesa.ts:594` |
| H9 | **cited only** | 1 | `scripts/encrypt_mpesa_secrets.mjs:4` |
| H10 | **cited only** | 5 | `render.yaml:30`, `render.yaml:124`, `apps/server/src/index.ts:4`, `apps/server/src/lib/env.ts:3` |
| H11 | **cited only** | 3 | `migrations/49_stock_transfer_control.sql:2`, `migrations/49_stock_transfer_control.sql:85`, `apps/server/src/routes/stock.ts:562` |
| H13 | **cited only** | 2 | `migrations/28_ingredient_cost_audit.sql:2`, `apps/server/src/routes/stock.ts:449` |
| H14 | **cited only** | 3 | `migrations/50_order_sync_status_and_idempotency.sql:2`, `migrations/50_order_sync_status_and_idempotency.sql:85`, `apps/server/src/routes/orders.ts:1423` |

## What to do about it

**Do not renumber anything.** The register's own rule is that IDs are stable and
never reused, and these citations are load-bearing comments explaining why code
is shaped the way it is.

When you touch a line citing a *cited only* ID, either resolve the reference into
the comment itself — say what the finding was, in place — or drop the citation.
A reference a reader cannot follow looks like documentation and is not, which is
exactly the reasoning behind the `check-doc-refs` gate for documents.

This file is generated. Regenerate rather than edit it.
