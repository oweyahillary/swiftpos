# MANIFEST 2026-08-14-e — enrolment issuance → admin, branch-bound (A69)

**Supersedes -d** (cumulative, rule 3). -e adds the A69 work; everything from
-a…-d is still included in the zip.

**Base commit:** `c474cf2`. Whole files shipped against that base (rule 4) —
`git status` first; the larger server/admin files (`admin.ts`, `AdminPortal.tsx`,
`AUDIT-REGISTER.md`) are the ones to reconcile by hand if your tree has moved.

**Register:** A69 opened (P2, OPEN). Header P2 count A 4→5.

---

## A69 — what changed and why

Issuance of enrolment codes moves from the **owner** to the **admin portal**, so
a client can't self-provision a till (provisioning is the billable act). The
**redeem** path is untouched. Desktop licensing is **unchanged** — one-off per
branch, unlimited tills, no trial, exactly as it was.

### New / edited in -e
| File | New/edit | What |
|---|---|---|
| `apps/server/src/lib/enrolCode.ts` | new | Shared code mint/hash/expiry (rejection-sampled, upper-cased hash). |
| `apps/server/src/lib/ownerBusiness.ts` | edit | `resolveOwnerUserId()` — owner `public.users.id` via businesses.email. |
| `apps/server/src/routes/admin.ts` | edit | `POST /clients/:id/branches/:branchId/enrol-code` — admin-authed, branch-bound, licence-gated, owner-resolved, audited. |
| `apps/server/src/routes/enrol.ts` | edit | Owner `POST /enrol/code` retired → 410 `ENROL_ISSUE_MOVED`. |
| `apps/desktop/src/renderer/pages/InstallPage.tsx` | edit | Locks the branch when the code carried one (was pre-select only). |
| `apps/admin/src/AdminPortal.tsx` | edit | "Enrol till" button per licensed branch + code result box (shown once). |
| `tests/enrol-endpoints.test.mjs` | edit | Rewritten for the relocation — 25 checks, mutation-checked. |
| `docs/AUDIT-REGISTER.md` | edit | A69 entry + header counts. |
| `docs/DEVICE-ENROLMENT-D4.md` | edit | Header note: issuance moved to admin. |
| `docs/MANIFEST-2026-08-14-e.md` | new | this file. |

**Billing:** nothing new. The branch-licence handler already auto-creates an
`invoices` row when `invoice_amount` is passed, and the admin UI already prompts
for the one-off desktop fee. The branch licence is the billable unit; enrolment
codes are provisioning.

**No migration.** `device_enrolment_codes` (migration 81) already has
`business_id`, `branch_id`, `code_hash`, `created_by`, `expires_at`, `status` —
the admin path just fills `branch_id` (always) and `created_by` (the owner).

**No package.json change in -e.** Still 0.5.30 from -d. But InstallPage is a
**desktop** change, so your next `release:both` should bump it (rule 15) and the
tills need the new build for branch-locking to take effect on the terminal.

---

## Apply

```bash
cd /c/swiftpos/pos
git status                                    # reconcile any locally-edited file first
unzip -o ~/Downloads/swiftpos-2026-08-14-e.zip
# server: redeploy (Render) — new admin route + retired owner route
# desktop: rebuild so tills get the branch-lock — npm run release:both
```

---

## Verified on the bench (rule 7 — Linux, Node 20; rule 9)
- `apps/server` `tsc --noEmit`: **0 errors** project-wide (incl. all A69 files).
- `tests/enrol-endpoints.test.mjs`: **25/25**, run. The licence-gate guard was
  **mutation-checked** — removing the gate block turns it red naming the file;
  its first version was too loose (matched a mutated string) and was tightened
  (rule 23).
- Gates green: `check-register-consistency` (header==body), `check-doc-refs`,
  `check-supabase-catch`, `check-table-usage`, `check-own-rows`.
- Desktop renderer `tsc`: clean for InstallPage. Admin `tsc`: my additions add
  no new errors (58 pre-existing, unchanged).

## NOT verified here — the live test (rules 9, 16) — closes A69
1. Admin issues a code for a **licensed** branch → gets Business ID + code.
2. Issuing for an **unlicensed** branch → refused `BRANCH_NOT_LICENSED`.
3. A till redeems → enrolls; the **branch is locked** on step 3 of the install.
4. The **same code again** → refused `ENROL_INVALID`. A code left 15 min → dead.
5. The old owner `POST /api/enrol/code` → `410 ENROL_ISSUE_MOVED`.
6. `node scripts/run-all.mjs` before shipping.
