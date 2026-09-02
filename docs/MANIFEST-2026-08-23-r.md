# MANIFEST — 2026-08-23-r

**Batch:** A130 — retire the dead Aggregators report + tab (owner approved retire).
**Cumulative:** follows -a…-q. Apply after -q.

**Base commit:** `f80f0e9` (`dev` tip). Applies on top of -a…-q.

**Working rules:** `HANDOFF-2026-08-08-evening.md` §0, rules 1–23.

---

## Files changed

| File | Change | Why |
|---|---|---|
| `apps/dashboard/src/pages/ReportsPage.tsx` | Removed the `AggregatorTab` component, its `AggregatorReport` interface, the `PLATFORM_LABELS`/`PLATFORM_COLORS` helpers, the `{ id: 'aggregator', label: 'Aggregators' }` tab entry, and its render line (~201 lines). | **A130** — the Aggregators report read `order_type='aggregator'`, which no path writes; a dead report/tab. |
| `apps/server/src/routes/reports.ts` | Removed `GET /api/reports/aggregator`; left a tombstone. | **A130** — the report endpoint had no data source and its only consumer (the tab) is gone. |
| `docs/AUDIT-REGISTER.md` | A130 `RETIRED` note (OPEN pending promote + prod 404). Counts unchanged (A130 was already OPEN P2). | Rule 14 / 16. |
| `docs/MANIFEST-2026-08-23-r.md` | New (this file). | Rule 2. |

## Scope decision (rule 17)

Retired only the **dedicated** Aggregators report/tab (the dead standalone report A130 flagged). **Kept** the `aggregator` bucket in the order-type MIX report (a category label in a broader breakdown — always zero today, but it would auto-populate if aggregator orders are ever created, and removing it would reshape an unrelated report). Re-add the dedicated report only alongside an aggregator-order writer (a channel integration).

## Verification (rule 7, 8, 9)

- `apps/dashboard` `tsc --noEmit` → 0 errors; `vite build` → exit 0.
- `apps/server` `tsc --noEmit` → 0 errors; `npm run build` → exit 0.
- `GET /api/reports/aggregator` has no remaining caller; `AggregatorTab` / `'aggregator'` tab-id have 0 refs in the dashboard.
- `check-permission-parity` → green; `check-table-usage` → green; `check-register-consistency` → green.
- Environment: Linux bench. **Not run against a live target** — the only outstanding check is that `/api/reports/aggregator` 404s in prod after promote (rule 16).

## Rollback

```
git apply -R A130-retire-aggregator-report.patch
```
