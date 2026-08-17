# MANIFEST 2026-08-17-o — A124 purge Stage 1: detector + pre-purge export (non-destructive)

**Base:** built on top of **A120 + A121 + A122** (both code files cumulative).
Register ID **A124**. Implements **Stage 1** from SUSPEND-PURGE-PLAN.md — read-only,
**deletes nothing**. Depends on A122's `suspended_at` (migration 88).

> **Apply order:** k (A120) → l (A121) → **m (A122, incl. migration 88)** → **o (A124)**.
> A124's `admin.ts` + `AdminPortal.tsx` supersede the copies in k/l/m (supersets).
> Run **migration 88** (from m) so `suspended_at` exists, or the detector shows nothing.

## Files (2 code, cumulative + manifest)

| File | A124 change |
|---|---|
| `apps/server/src/routes/admin.ts` | `suspended_at` added to `GET /clients` list; new `GET /clients/:id/export` (read-only JSON of the client's **normal user data** — business, branches, products, categories, customers, staff; password/PIN hashes stripped; financial/tax records excluded, they're retained). Audited `business.export`. |
| `apps/admin/src/AdminPortal.tsx` | purge-due helpers (`isPurgeDue`, `daysSince`, 180-day grace); **"purge-due" badge** on clients-list rows suspended > 6 months; **suspension banner** on the client detail (days suspended, days-until-eligible or past-grace) with an **"Export data"** button. |

## What it does / doesn't

- **Detector:** filter the clients list by Suspended and rows past the 6-month grace
  show a "purge-due" badge; the client detail spells out the countdown.
- **Export:** hands back the normal user data due for purge (not the retained
  financials), so a client has their catalogue/customers/staff before deletion.
- **Deletes nothing.** Stage 2 (the actual purge) is not built and needs the
  sign-offs in SUSPEND-PURGE-PLAN.md (retention number, PII anonymisation, RETAIN list).

## Verified (bench)

- Server `tsc` clean; admin `vite build` clean; type errors unchanged at **65**
  (no new styled inputs). Gates green: supabase-catch, permission-parity, register,
  doc-refs, table-usage.

## NOT verified — click-test (admin app has no tests)

- Suspend a client → detail shows "Suspended N days ago" + Export button; Export
  downloads a JSON with business/branches/products/categories/customers/staff and
  **no** password hashes. A client suspended > 180 days shows the "purge-due" badge
  in the list and the amber past-grace banner.

## Rollback

Per file: `git checkout -- apps/server/src/routes/admin.ts apps/admin/src/AdminPortal.tsx`.
