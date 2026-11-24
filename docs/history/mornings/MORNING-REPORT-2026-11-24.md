# Morning report — overnight 2026‑11‑23 → 24

All on the **`dev` worktree** (`c:\swiftpos\pos-print`, branch `dev`). **Nothing committed, nothing deployed.**
Everything below builds clean and passes locally. **To test: apply migrations 193 + 194 to the dev DB BEFORE running the new server code** (the entitlement backfill must land first).

> **Fix applied 2026‑11‑24 (during testing):** migration 193 failed on the real `node scripts/migrate.mjs` apply —
> `relation "_a624_eff" does not exist`. Cause: `migrate.mjs` runs each file with `psql -f` in **autocommit**, so the
> `CREATE TEMP TABLE … ON COMMIT DROP` was dropped the instant its own statement committed, before the next statement
> read it. The migration‑test harness (and CI) run the file as **one** PGlite transaction, so they never saw it.
> Fix: wrap 193's body in `BEGIN; … COMMIT;` (the convention migrations 08–12/68 already use) — the temp table now lives
> until the final commit and the backfill is atomic. 193 re‑tested 10/10. Migration 194 has no temp table and is safe
> under autocommit (unchanged). **Re‑run `node scripts/migrate.mjs` — both apply cleanly now.** Follow‑up worth doing:
> a guard so the test path matches the real apply path (see the task doc).

---

## 1. A624 — the premium master switches retired (per‑branch is now the sole gate) ✅ DONE

Analytics, Attendance and Themes (and the Watch list / Loss Alerts) no longer gate on a per‑business `feature_flags`
switch — they gate on **per‑branch payment** (`branch_cloud_plans.premium` / the package), via `featureBranches()`.

- **Migration 193** `migrations/193_unify_per_branch_premium.sql` — backfills each branch's `premium` from the current
  switches **without changing anyone's access** (per‑branch kept; switch‑off strips; a billed‑as‑one business gets rows
  and the grant; a trial with a switch but no plan gets a KES‑0 row; a package branch is left as‑is, with a NOTICE if
  its business had a switch off). Tested: `scripts/test-migration-193.mjs` 10/10.
- **Code (server):** `featureBranches` is now total + `anyBranchHasFeature` (`lib/branchBilling.ts`). Converted:
  Analytics route (`routes/analytics.ts` — also an optimisation: owner "all branches" keeps the business‑wide
  aggregate when every branch pays), Loss‑Alerts route **and job** (`routes/lossAlerts.ts`, `jobs/lossAlerts.ts`),
  Attendance route + the `/clock` PIN‑refusal (`routes/staff.ts`) + `attendanceStaffChanged` (`lib/attendanceStore.ts`)
  + the POS pull's `attendanceDevice` (`routes/pos.ts`), Themes in the POS pull (`routes/pos.ts`) and the branding
  settings (`routes/business.ts`).
- **Verified green:** 15+ server test files — analytics a549/553/558/561/565/575/583, loss‑a576, owner‑decisions‑a580,
  attendance‑a599, theme‑access, brand‑colours‑a597, branch‑branding‑a544, partner‑a582, branch‑billing/cloud‑a612,
  web‑pos‑theme, pos‑init*, stock‑web‑pos. Server builds clean.
- **Kept on purpose (rollback safety):** the 3 `feature_flags` rows and the now‑dead `analyticsEnabled` /
  `attendanceEnabled` / `themesEnabled` functions. They're still read only by the admin **Features** toggles and the
  dashboard Attendance‑nav — harmless while the flags still exist.
- **Still to do (not urgent, no client impact):** Phase 3 — remove the admin Features premium toggles + the dashboard
  nav flag read; Phase 4 — the billing‑page redesign you asked for; Phase 5 — drop the `feature_flags` rows + dead fns.
- Spec: `docs/tasks/A624-unify-per-branch-billing.md`.

## 2. A625 — per‑branch menu (an item on Branch A's menu, not Branch B's) ✅ SERVER BASE DONE

Built to your approved defaults: a new branch gets the **whole** menu; **product‑level** for v1.

- **Migration 194** `migrations/194_product_branches_hidden.sql` — an **exclusion** table: a row = "this product is off
  this branch's menu." **No rows = every product on every branch, exactly as today** (no backfill, nothing changes for
  existing businesses). Tested: `scripts/test-migration-194.mjs` 7/7.
- **Code:** `lib/branchMenu.ts` (`hiddenProductsAt`, `branchMenuRefusal`). The POS pull (`routes/pos.ts`) drops the
  hidden products for the operating branch. A **live web sale** of a hidden product is refused `409 NOT_ON_MENU`
  (`routes/orders.ts`) — a till's offline/pushed sale is never refused (same rule as the A563 sold‑out gate). API to
  manage it: **`GET /api/products/branch-availability`** (branches + the hidden map) and
  **`PUT /api/products/:id/branches`** `{ hidden: [branchId…] }` (both `menu.edit`).
- **Verified:** `tests/a625-per-branch-menu.test.mjs` 7/7.
- **Remaining (for us, this morning):** the dashboard **Menu‑editor "Available at" control** (`apps/dashboard`). The
  endpoints are ready; I left the UI so we can shape the UX together — it's a small wiring job. You can already test the
  behaviour end‑to‑end via the two endpoints (hide a product at a branch → it drops off that branch's `/pos/init`).
- Spec: `docs/tasks/A625-per-branch-menu.md`.

## 3. Website (earlier, already live on `main`)
The marketing‑site work from earlier is on `main` (PRs #131/#132/#133): hospitality‑only guides, **per‑branch** cloud +
Analytics pricing, the per‑user‑licence point. Nothing outstanding there.

## 4. To try it in the morning
1. Apply migrations **193 then 194** to the dev DB (`scripts/migrate.mjs`, or however you apply to dev).
2. Build + run the dev server (`cd apps/server && npm run build`).
3. A624: existing premium clients keep exactly today's access (the backfill preserves it). Set a branch's premium in the
   admin Branch billing card and only that branch gets Analytics/Attendance/Themes.
4. A625: `PUT /api/products/:id/branches {"hidden":["<branchId>"]}`, then pull `/pos/init` for that branch — the product
   is gone there and still present elsewhere.

**Nothing is committed.** When you're happy, I'll share the commit commands (dev), then the PR text — your call on scope.
