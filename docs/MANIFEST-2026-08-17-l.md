# MANIFEST 2026-08-17-l — A121 admin portal: close/reopen branch (G2)

**Base:** built on top of **A120** (same two files; A120 not yet pushed when this
was built). Register ID **A121**. Implements **G2** from ADMIN-PORTAL-PLAN.md — the
other half of branch lifecycle. No new decision needed.

> **Cumulative note:** `admin.ts` and `AdminPortal.tsx` here include the A120
> (create-branch) changes too. Apply **A120 (k) first, then A121 (l)** — extracting
> A121's copies over A120 is safe (superset).

## Files (2 code + manifest)

| File | A121 change |
|---|---|
| `apps/server/src/routes/admin.ts` | new `PATCH /clients/:id/branches/:branchId` (requireAdmin): sets `status` active\|inactive; **main branch cannot be closed**; audited (`close_branch`/`reopen_branch`). |
| `apps/admin/src/AdminPortal.tsx` | per-branch **Close / Reopen** button (hidden for the main branch) → `toggleBranchStatus` with a confirm. |

## Behaviour notes

- Branch `status` is a **soft flag**: an inactive branch is hidden from the branch
  selector and excluded from active-branch operations. It does **not** by itself
  stop a licensed till — the hard "tills stop + billing stops" gate is the desktop
  **licence**. So the Close confirm, when the branch is still licensed, tells the
  admin to also click **Revoke**. Close and licence-revoke are kept as separate,
  visible actions rather than auto-coupled.
- The **main branch cannot be closed** (server guard + button hidden), matching the
  owner-side dashboard rule.

## Verified (bench)

- Server `tsc` clean; admin `vite build` clean.
- Type errors unchanged at **65** — G2 adds only buttons (no styled inputs), so
  **0 new** vs A120.
- Gates green: supabase-catch, permission-parity, register, doc-refs.

## NOT verified — needs a click-test (admin app has no tests)

- Close a non-main branch → StatusBadge flips to inactive, button reads "Reopen",
  persists on reload. Confirm the main branch has no Close button and the endpoint
  rejects closing it.

## Rollback

Per file: `git checkout -- apps/server/src/routes/admin.ts apps/admin/src/AdminPortal.tsx`.
