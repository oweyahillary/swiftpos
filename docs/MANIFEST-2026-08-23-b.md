# MANIFEST — 2026-08-23-b

**Batch:** A143 (partial) — wire the two clean report-export buttons.
**Cumulative:** follows -a (A140–A148 register entries) in the same session; -b supersedes nothing in -a, it adds to it.

**Base commit:** `f80f0e9` (`dev` tip). The patch applies on top of a tree that already has the -a batch; if -a is not yet applied, apply it first (its register edits and this one do not overlap except that both live in `AUDIT-REGISTER.md`).

**Working rules:** `HANDOFF-2026-08-08-evening.md` §0, rules 1–23.

---

## Files changed

| File | Change | Why |
|---|---|---|
| `apps/dashboard/src/pages/ReportsPage.tsx` | Added an "↓ Export Excel" button to `HourlyTab` (→ `/api/reports/export/hourly`) and to `ItemMixTab` (→ `/api/reports/export/products`), each an exact copy of the existing `MasterTab` sales-export button. | A143 — the export endpoints were live but only `sales` had a UI caller. |
| `docs/AUDIT-REGISTER.md` | Appended a `PROGRESS 2026-08-23` note to the A143 entry. Entry stays **OPEN**; open counts unchanged. | Rule 14 — status ships with the code. The item is not closed: other export formats and the inventory report remain. |
| `docs/MANIFEST-2026-08-23-b.md` | New (this file). | Rule 2. |

## Scope / deliberately not done

- Only the two 1:1 tab↔endpoint matches were wired. `daily`, `audit`, `shifts`, `pnl`, `expenses` exports have no clean tab home, and `GET /api/reports/inventory` has no caller — left OPEN under A143, not padded with invented UI (rule 12).
- No permission-gating added to the buttons: the shipped `sales` button has none, so matching it keeps behaviour consistent. Export routes already enforce `requireWebSurface` + `reports.financial` server-side; a user without that permission gets a 403, same as today's sales button.
- No server change, so **no prod-migrate** and no deploy-order concern.

## Evidence / verification (rule 7, 9)

- `cd apps/dashboard && npx tsc --noEmit` → exit 0.
- `cd apps/dashboard && npx vite build` → exit 0 (ReportsPage chunk built).
- `node scripts/check-register-consistency.mjs` → green (A143 still OPEN; header agrees with body).
- Environment: Linux bench, Node, dashboard Vite build. **NOT verified in a browser (rule 16):** that the button actually triggers a file download and that the xlsx opens is a target-surface check, still open.

## Rollback

The patch is reversible in one command:

```
git apply -R A143-report-exports.patch
```

Or by file (if applied manually): revert `apps/dashboard/src/pages/ReportsPage.tsx` and `docs/AUDIT-REGISTER.md` to their pre-batch state and delete `docs/MANIFEST-2026-08-23-b.md`.
