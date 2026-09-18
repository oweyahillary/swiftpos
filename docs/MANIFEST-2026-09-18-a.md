# Delivery manifest — 2026-09-18 (-a)

**Base commit:** `66418cc` (branch `dev`).
**Scope:** A296 (code — Item Mix date-range filter, desktop manager) + A297 (register-only
finding — ingested orders arrive without line items). One code file changed; the rest is docs.

Reviewable without extracting — the whole change is the one `TopItemsTab` edit below.

---

## Files

| File | Change | Why |
|---|---|---|
| `apps/desktop/src/renderer/pages/ManagerPage.tsx` | `TopItemsTab`: add a `range` state (default `today`), render the shared `ReportRangeBar` (`exportKind='products'`), reload on range change, keep the bar visible during loads, item cap 8 → 50, heading "Item Mix — today" → "Item Mix", empty text → "No sales in this date range." | A296 — give Item Mix the same range filter the Orders tab has. Renderer-only; `getTopProducts`/`manager:topProducts` already accept + resolve a range. |
| `docs/AUDIT-REGISTER.md` | Added `A296` (P3 · FIX BUILT) and `A297` (P1 · OPEN); header open counts A-P1 18 → 19, A-P3 11 → 12; Counts ID lists updated. | Rule 14 — code and finding get an ID and an entry in the same delivery. |
| `docs/MANIFEST-2026-09-18-a.md` | This file. | Rule 2. |

## Rollback

```
git checkout 66418cc -- apps/desktop/src/renderer/pages/ManagerPage.tsx
git checkout 66418cc -- docs/AUDIT-REGISTER.md
git rm docs/MANIFEST-2026-09-18-a.md
```

## Version (rules 15, 22)

Desktop code changed → bump **0.5.43 → 0.5.44** *at build time*, then tag after the build.
`apps/desktop/package.json` is deliberately **NOT** in this delivery (rule 22 — a delivery
carries the change, never the version). Restore version if needed: `0.5.43`.

## Verified on the bench (Linux, Node 22, no app node_modules — rule 9)

Repo Node gates re-run after the edit, all green:
`check-register-consistency`, `check-doc-refs`, `check-root-clean`, `check-ipc-parity`,
`check-ipc-validation`.

## NOT verified — target/CI only (rules 9, 16)

- Desktop renderer `tsc` and `vite build` — could not run (no node_modules / Electron on the
  bench). The change is small and uses only already-imported symbols (`ReportRangeBar`,
  `ReportRangeArg`), but that is a claim to check, not a green.
- On-screen: open Manager → Item Mix, switch Today / 7 days / 30 days / This month / Custom,
  confirm the table reloads and the CSV button exports.
- No desktop unit test added: `TopItemsTab` is pure UI with no logic branch worth a mutation
  check, and the range plumbing it uses (`getTopProducts(range)`) is already exercised. On-screen
  is the verification (rule 16).

## A297 — confirm on the till before any ingest fix (rules 7, 11)

A296 adds the filter but will NOT populate an empty Item Mix — the items aren't in the DB. To
pin A297's trigger, run on the affected machine:

```
SELECT device_role, terminal_code FROM device_config;
SELECT o.order_number, o.device_id,
       (SELECT COUNT(*) FROM order_items i WHERE i.order_id=o.id) AS items,
       (SELECT COUNT(*) FROM payments   p WHERE p.order_id=o.id) AS pays
FROM orders o ORDER BY o.created_at DESC LIMIT 10;
SELECT COUNT(*) AS total_items FROM order_items;
```

Expected if A297 holds: `device_role` is `node`/`office`; rows show `items = 0`, `pays >= 1`.
Also note the *selling* till's build version. No ingest/replication code ships until this is
known — a blind change there during the in-flight 0.5.43 release is rule 13.
