# MANIFEST 2026-08-17-r — A127 admin portal: Branches tab (branch → tills → tech log)

**Base:** `origin/dev` (97dbbb3, which has A125+A126 **code**). Register ID **A127**.
Additive (server + one UI tab). Adds the Branches tab you asked for, with drill-down.

## Files (2 code + manifest)

| File | Change |
|---|---|
| `apps/server/src/routes/admin.ts` | devices response now includes `branchId` (so tills can be filtered per branch); new `GET /clients/:id/devices/:deviceId/tech-audit` (reads `tech_audit_log` for a till — action / tech / detail / time, scoped by business + device, latest 100). |
| `apps/admin/src/AdminPortal.tsx` | new **"Branches"** tab between Overview and Features. Three-level drill-down: **branch list** (name, licence state, till count, + Add branch, per-branch Enrol/Licence/Close) → click a branch or **Tills →** → **that branch's tills** → **Tech log →** → **the till's tech audit log**. |

## Behaviour

- Branch list shows each branch with its till count; clicking the row or "Tills →"
  drills in. Tills view lists devices where `branchId` matches, with "Tech log →"
  and Revoke. Tech-log view lists the till's recorded tech actions (newest first).
- All branch-management actions reuse the existing G1/G2/licence/enrol functions.

## Deliberate choice — overview branch card left in place (for now)

The old "Branch Licences" card in the **Overview** tab is **not removed** in this
change — extracting it from the overview's two-column layout is div-surgery I can't
visually verify on the bench, and I'd rather not risk the working overview blind. So
branch management currently appears in **both** Overview and the new Branches tab
(same shared functions, harmless). Once you confirm the Branches tab renders right,
removing the overview duplicate is a trivial one-block follow-up.

## Verified (bench)

- Server `tsc` clean; admin `vite build` clean.
- Type errors 65 → 68: **+3, all the benign `S.input` inline-style class** (the
  add-branch form fields), proven by stash-diff. No new class.
- Gates green: supabase-catch, permission-parity, register, doc-refs, table-usage.

## NOT verified — click-test (admin app has no tests)

- Open a client → **Branches** tab → branch list shows with till counts → click a
  branch → its tills list → **Tech log →** → the till's tech actions appear (or
  "No tech actions logged"). Back buttons return up each level.

## Rollback

Per file: `git checkout -- apps/server/src/routes/admin.ts apps/admin/src/AdminPortal.tsx`.
