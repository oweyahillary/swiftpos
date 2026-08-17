# MANIFEST 2026-08-17-k — A120 admin portal: create branch (G1)

**Base:** clean `origin/dev` (8e70245, which has A118/A119). Register ID **A120**.
Implements **G1** from ADMIN-PORTAL-PLAN.md with **decision D1 = (a) admin-only**:
owners must never create branches (they're billed separately), so creation is a
SwiftPOS-agent operation in the admin portal. The dashboard 403 stays.

## Files (2 code + manifest)

| File | Change |
|---|---|
| `apps/server/src/routes/admin.ts` | new `POST /clients/:id/branches` (requireAdmin): validates name (≤100) + optional address/phone, inserts `is_main:false, status:'active'`, audited. Returns the branch in the same shape as the list. |
| `apps/admin/src/AdminPortal.tsx` | "+ Add branch" toggle in the Branch Licences card → inline form (name*/address/phone) → `createBranch` (POST) → appends to the list. |

## Behaviour notes

- The new branch shows "✗ Not licensed — desktop POS blocked" immediately (the
  existing list rendering), so the billing/licence step is visible. Billing follows
  via the existing per-branch **licence** flow — creating the record does not bill.
- Owner self-serve stays blocked: `apps/server/src/routes/branches.ts` `POST /` still
  returns 403 `BRANCH_CREATION_RESTRICTED` (unchanged).

## Verified (bench)

- Server `tsc` clean (pinned TS 5.9.3 via `npm ci`).
- Admin `vite build` clean.
- Type errors 62 → 65: **+3, all the benign `S.input` inline-style `CSSProperties`
  class** (the three form inputs), proven by stash-and-diff. No new error class.
- Gates green: supabase-catch, permission-parity, register, doc-refs, table-usage.

## NOT verified — needs a click-test (admin app has no tests)

- Open a client → Branch Licences → **+ Add branch** → name → Create → the branch
  appears in the list as "Not licensed", and persists on reload.

## Rollback

Per file: `git checkout -- apps/server/src/routes/admin.ts apps/admin/src/AdminPortal.tsx`.
