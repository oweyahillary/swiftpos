# MANIFEST — 2026-08-23-v

**Batch:** A142 — bulk product-image upload (preview & confirm). Dashboard-only.
**Cumulative:** follows -a…-u. Apply after -u.

**Base commit:** `f80f0e9` (`dev` tip). Applies on top of -a…-u.

**Working rules:** `HANDOFF-2026-08-08-evening.md` §0, rules 1–23.

---

## Files changed

| File | Change | Why |
|---|---|---|
| `apps/dashboard/src/pages/products/BulkImageUpload.tsx` | New. Multi-select images → auto-match filename→product (barcode → plu_code → name) → per-row product dropdown to confirm/fix → loops `uploadImage` and PATCHes each product's `image_url`. | A142 — bulk image attach, per the "preview & confirm" decision. |
| `apps/dashboard/src/pages/products/ProductsPage.tsx` | "Bulk images" toolbar button + modal hosting `BulkImageUpload` (fed the products list, refreshes on done). | Surface it. |
| `docs/AUDIT-REGISTER.md` | A142 `DECISION` + `SHIPPED` note. Stays **OPEN P3** pending a browser test; counts unchanged. | Rule 14. |
| `docs/MANIFEST-2026-08-23-v.md` | New (this file). | Rule 2. |

## Design

- **Owner decision (08-23):** preview & confirm — auto-match, user fixes mismatches. No rigid filename convention.
- **Matcher:** filename without extension, case-insensitive, tried against barcode, then plu_code, then name. First match wins; unmatched rows default to "skip". Every row is a dropdown the user can override before uploading.
- **Reuses the proven single-image path:** `uploadImage` (Cloudinary) then `PATCH /api/products/:id { image_url }`. No server change.
- Inherits `lib/upload.ts`'s cloud-only limitation (local/VPS branch is a TODO) — works wherever single-image upload already does.
- Object URLs for previews are revoked on change/unmount.

## Verification (rule 7, 8)

- `apps/dashboard` `tsc --noEmit` → 0; `vite build` → 0.
- `check-register-consistency` → green.
- Environment: Linux bench. **Browser test pending** (no Cloudinary/network from the bench).

## Pending browser test

Open Products → **Bulk images** → choose a few files named after product barcodes/names → confirm the auto-matches (fix any) → **Upload** → confirm the images appear on those products.

## Rollback

```
git apply -R A142-bulk-image-upload.patch
```
