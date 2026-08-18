# MANIFEST 2026-08-17-r — A127 admin portal: Branches tab + tills/tech-audit drill-down

**Base:** `origin/dev` (97dbbb3, has A125+A126 code). Register ID **A127**. Additive.
Also folds in the **A125 + A126 register rows** that were missed when their code shipped.

## Files
| File | Change |
|---|---|
| `apps/server/src/routes/admin.ts` | `branchId` added to admin devices response; new `GET /clients/:id/devices/:deviceId/tech-audit` (reads `tech_audit_log` by device_id + business_id, newest first, limit 100, read-only). |
| `apps/admin/src/AdminPortal.tsx` | new **Branches** tab (between Overview and Features): branch list → click a branch → its **tills** (devices where `branchId` matches) → click a till → its **tech audit log** (action/tech/detail/time). Reuses existing branch actions + `revokeDevice`. |
| `docs/AUDIT-REGISTER.md` | A125, A126, A127 rows added. |

## Temporary duplication (deliberate)
Overview's "Branch Licences" card left in place rather than risk a blind extraction
from its two-col layout — branch management shows in both Overview and the Branches
tab until you confirm the tab renders, then the overview copy is a trivial removal.

## Verified (bench)
- Server `tsc` clean; admin `vite build` clean; type errors 65 → 68 (+3, all the
  benign `S.input` inline-style class from the add-branch inputs; stash-diff proven).
- Gates green: supabase-catch, permission-parity, register, doc-refs, table-usage.

## NOT verified — click-test
- Client → Branches → branch → tills → till → tech audit log (or empty state); back-buttons.

## Rollback
`git checkout -- apps/server/src/routes/admin.ts apps/admin/src/AdminPortal.tsx`.
