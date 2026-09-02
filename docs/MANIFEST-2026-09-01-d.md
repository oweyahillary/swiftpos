# MANIFEST 2026-09-01-d — A144: bulk enable/disable stock tracking

**Base:** dev @ fba45bb. Additive.

## What
The re-test flagged "no way to track existing products." The per-product path already
existed (row Edit → "Track stock" toggle → PATCH /products/:id) — the agent missed the
Edit button. Added the bulk/discoverable path it wanted.

| File | Change |
|---|---|
| `apps/server/src/routes/products.ts` | **NEW** `PATCH /api/products/bulk-track/by-ids` ({ ids, track_stock }, business-scoped, single UPDATE…IN). |
| `apps/dashboard/src/pages/products/ProductsPage.tsx` | Selection bar gains **Track stock** / **Untrack** buttons → `bulkTrack()`. |
| `docs/AUDIT-REGISTER.md` | A144 tracking-fixed note. |
| `docs/MANIFEST-2026-09-01-d.md` | This file. |

## Verification (rule 7)
```
apps/dashboard: npm run build   → exit 0
apps/server: tsc --noEmit       → exit 0
check-api-routes                → OK (288; the new bulk-track call matches)
check-register-consistency / doc-refs → OK
```

## Browser-confirm
Products → select several untracked products → **Track stock** → they become tracked →
open POS drawer → Inventory → they now appear and their **min** threshold is editable
(the A144 threshold editor). **Untrack** reverses it. (Single-product tracking: row **Edit**
→ toggle — already worked.)

## Rollback
`git restore apps/server/src/routes/products.ts apps/dashboard/src/pages/products/ProductsPage.tsx docs/AUDIT-REGISTER.md && rm docs/MANIFEST-2026-09-01-d.md`
