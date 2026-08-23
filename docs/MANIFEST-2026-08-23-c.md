# MANIFEST — 2026-08-23-c

**Batch:** A140 — surface the existing product bulk CSV import on the general Products page (was reachable only for `minimart`).
**Cumulative:** follows -a (register A140–A148) and -b (A143 report exports) in the same session. Apply -a, then -b, then -c.

**Base commit:** `f80f0e9` (`dev` tip). This patch applies on top of -a + -b.

**Working rules:** `HANDOFF-2026-08-08-evening.md` §0, rules 1–23.

---

## Files changed

| File | Change | Why |
|---|---|---|
| `apps/dashboard/src/pages/products/BulkProductImport.tsx` | **New.** The bulk-import panel (template download, CSV parse/validate, preview, `POST /api/products/bulk`) extracted verbatim into a self-contained component with optional `onImported` / `onToast` callbacks. | Rule 17 — reuse, don't duplicate. One implementation, two hosts. |
| `apps/dashboard/src/pages/settings/MinimartSettingsPage.tsx` | Removed the inline import state, `handleFile`, `runImport`, and the tab JSX; the Import tab now renders `<BulkProductImport onImported={loadData} onToast={showToast} />`. Dropped the now-unused `useRef` import. | Dedupe against the extracted component; behaviour preserved (same refresh + toast). |
| `apps/dashboard/src/pages/products/ProductsPage.tsx` | Added an "Import CSV" toolbar button and a modal hosting `<BulkProductImport onImported={fetchAll} />`. | A140 — make the importer reachable for every product-carrying business type. |
| `docs/AUDIT-REGISTER.md` | Appended a `PROGRESS 2026-08-23` note to A140. Entry stays **OPEN**; counts unchanged. | Rule 14 / rule 16 — status ships with code, but the target-surface check isn't done. |
| `docs/MANIFEST-2026-08-23-c.md` | New (this file). | Rule 2. |

## Design notes / scope

- Both `ProductsPage` and `MinimartSettingsPage` are hardcoded-dark (`bg-gray-900`, `bg-black/60` modals), so the extracted panel renders identically in both — no theming change needed.
- No server change; the CSV template and `/api/products/bulk` endpoint are unchanged. So **no prod-migrate** and no deploy-order concern.
- The importer's fields (`barcode`, `plu_code`, `sold_by`, …) are general product columns; empty values are valid for non-minimart types, so no per-type gating was added (rule 12 — no scope creep).

## Evidence / verification (rule 7, 9)

- `cd apps/dashboard && npx tsc --noEmit` → exit 0 (no duplicate defs, no unused `useRef`, no type errors).
- `cd apps/dashboard && npx vite build` → exit 0.
- `grep` sweep: no dangling references to `importRows`/`runImport`/`handleFile`/`fileRef`/`useRef` remain in `MinimartSettingsPage`.
- `node scripts/check-register-consistency.mjs` → green (A140 still OPEN).
- Environment: Linux bench, Node, dashboard Vite build. **NOT browser-verified (rule 16):** that the "Import CSV" button appears and an import runs end-to-end on a non-minimart business, and that minimart's Import tab is visually unchanged.

## Rollback

```
git apply -R A140-bulk-import.patch
```

(Reverses all three code files and the register note, and removes the new component and this manifest.)
