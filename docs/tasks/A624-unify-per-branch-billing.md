# A624 — Unify cloud billing on per-branch; retire the premium master switches

Owner, 2026-11-23: Analytics (and every premium add-on) is priced **per branch**. The billing page is confusing.
Both have the same root cause — two parallel models — so we fix them together.

Builds on A612 (per-branch cloud, migration 182) and A549/A580/A599/A617. Continues from [[A612-per-branch-cloud.md]].
Target: **dev only** until the owner says prod-ready (dev-until-production-ready).

---

## 1. The problem: two parallel models

Cloud entitlement is decided in **two** places today:

| Layer | Where | Scope |
|---|---|---|
| **Master switch** | `feature_flags` keys `analytics` / `attendance` / `themes` (A549/A599/A617), set in the admin **Features** section (`routes/admin.ts`) | per **business** |
| **Per-branch premium** | `branch_cloud_plans.premium[]` / `.package` (A612, migration 182), set in the admin **BranchBillingCard** | per **branch** |

The effective rule (branchBilling.ts:17): *a branch has a feature when the business's master switch is ON **AND** the branch pays for it (premium/package)* — but with a twist:

- **Business WITH branch rows** (`branchPlans` non-empty): feature ON ⇔ master switch ON **AND** that branch's `premium[]` contains it. `featureBranches()` returns the paying branches.
- **Business "billed as one"** (`branchPlans` empty): `featureBranches()` returns **null** → the **master switch alone** decides, for every branch.

Migration 182 filled branch rows (inheriting the business plan) **with empty `premium`** for every business that had a `cloud_plans` row at the time. Businesses created since, or with no plan, have **no** branch rows (billed as one). So the estate is split, and the master switch is both a second gate (per-branch clients) and the only gate (billed-as-one clients). That duality is what makes the billing page confusing and the master switch awkward.

### Where the switches are read/written
- Read: `analyticsAccess.ts` (`analyticsEnabled`), `themeAccess.ts`, `attendanceRules`/`attendance.ts`; gates in `routes/analytics.ts:130`, `routes/lossAlerts.ts:34`, `jobs/lossAlerts.ts` (65/216/284), plus Attendance (nav hidden on the business flag, `DashboardLayout.tsx:318`) and Themes.
- Written: admin **Features** toggles (`routes/admin.ts` FEATURES, feature_flags upsert).
- Per-branch path already built: `premiumOf()`, `featureBranches()` (branchBilling.ts), used in `analytics.ts:162`.

## 2. Target model: per-branch only

**One** model. Every branch has a `branch_cloud_plans` row; its `premium[]`/`package` is the **sole** entitlement for Analytics, Attendance and Themes. The `feature_flags` master switches for those three are **retired**. `featureBranches()` never returns null (every business has rows). The billing page shows one per-branch view — no "billed as one vs per branch" split, no separate premium toggles.

(Out of scope — unchanged: `web_hosting`, `cloud_backup`, `desktop_updates`, POS switches, `loyalty_enabled`, `themes_free`, stock-gate flags. Only the three **premium** master switches go.)

## 3. The access-preserving backfill (the keystone — must not change anyone's entitlement)

For each business `B` and feature `F ∈ {analytics, attendance, themes}`, let `masterOn = feature_flags(B, F).enabled`.

**Effective entitlement today, per (branch, F):**
```
hasRow(branch) ?  masterOn AND branch.premium ∋ F
               :  masterOn                         (billed as one: every branch)
```

**Migration sets each branch's new `premium[]` to exactly that effective set, then we drop the switches.** Concretely:

1. **Ensure rows exist.** For every branch of every business that has a `cloud_plans` row **or** any of the three master switches ON, create a `branch_cloud_plans` row if missing, inheriting the business plan exactly as migration 182 did (period, amount, currency, custom_until, paid_until = `web_access_expires_at`, billing_from, created_at). Idempotent (`ON CONFLICT DO NOTHING`). No plan to inherit → a trial/complimentary default row carrying only the premium (period 'monthly', amount 0, paid_until from web access if any).
2. **AND the switch into existing per-branch rows.** For a business that already had rows: if `masterOn` is false for F, strip F from every branch's `premium[]` (it had no access); if true, keep each branch's existing membership.
3. **Grant on the freshly-created (billed-as-one) rows.** For F where `masterOn`, add F to **every** branch's `premium[]`.
4. Leave `web_hosting` etc. untouched. Do **not** delete the `feature_flags` rows in the same migration — a later cleanup migration drops them once the code no longer reads them (so a rollback of code still finds them).

Package stays as-is (a branch on the package already implies all three).

## 4. Phases

1. **Migration 193** — rows-for-all + access-preserving premium backfill (section 3). Additive, idempotent, reversible. Tested against real Postgres (ci.yml) + a `tests/` migration test.
2. **Entitlement = per-branch only (server).**
   - `analytics.ts`: drop the `analyticsEnabled` gate (line 130); rely on `featureBranches('analytics')` which now covers every business (never null). An empty result → 403 ANALYTICS_OFF (already handled).
   - `lossAlerts.ts` (route + job): same — gate per branch on `featureBranches('analytics')` for the branch(es) in view, not the business switch.
   - Attendance + Themes gates: read per-branch premium, not the business switch.
   - Make `featureBranches()` total (no null path); update `premiumOf`/callers; keep `package`.
3. **Admin + dashboard.**
   - Remove the three premium toggles from admin **Features**; the per-branch **BranchBillingCard** checkboxes become the only control.
   - Dashboard: Attendance nav gate reads per-branch (any of the viewer's branches has it) instead of the business `attendance` flag.
4. **Billing-page redesign** (the confusion fix) — one per-branch table, drop the "Bill per branch" button and the billed-as-one copy. *Needs the owner's eye; mockups first.*
5. **Cleanup** — a later migration drops the retired `feature_flags` rows; delete `analyticsEnabled`/one-business code paths; update/extend tests.

## 5. Risks & rollout
- **Billing-critical:** the backfill must preserve every client's entitlement AND paid-until exactly (no wrong cut-off, no free time). Test on dev with prod-like data; diff entitlements before/after.
- **Order:** migration 193 must be applied **before** the server stops reading the switches, or per-branch businesses with empty premium would lose Analytics. Deploy migration first, then code.
- Dev first; prod only on the owner's go, migration applied with the deploy (as 182/185/192).

## 6. Open questions
- Billing-page redesign: what does "not confusing" look like to the owner? (mockups to follow)
- Trial/complimentary businesses with a premium switch but no plan: confirm the default row shape in §3.1.

## 7. Apply gotcha found on real psql (2026-11-24)
Migration 193 first failed on `node scripts/migrate.mjs`: `relation "_a624_eff" does not exist`. The runner applies each
file with `psql -f` in **autocommit** (one implicit transaction *per statement*), so a bare `CREATE TEMP TABLE … ON
COMMIT DROP` is dropped the moment its own statement commits — before the next statement reads it. The migration-test
harness (`scripts/test-migration-193.mjs`) and CI run the whole file as **one** PGlite `db.exec()` transaction, so the
temp table always survived there and the bug was invisible. **Fix:** wrap 193's body in `BEGIN; … COMMIT;` (matches
migrations 08–12/68) — the temp table lives until the final commit and the backfill is now all-or-nothing. Re-tested 10/10.

**Follow-up (not done — proposed):** close the test↔apply mismatch so this class of bug can't recur. Options, cheapest
first: (a) a lint over `migrations/*.sql` that fails if `CREATE TEMP`/`ON COMMIT` appears outside an explicit
`BEGIN;…COMMIT;` or a single `DO` block; (b) make the migration-test harness apply files statement-by-statement in
autocommit (needs dollar-quote-aware splitting); (c) give `migrate.mjs` a `--single-transaction` apply so every file is
atomic like the harness — simplest, but would break any migration that needs a non-transactional statement (e.g. `CREATE
INDEX CONCURRENTLY`), so audit first. (a) is the lowest-risk guard.

## 8. Second CI failure found while testing (2026-11-24): stale schema index + the TEMP spelling
The `Schema drift` job was red on **both** the A624/A625 commit (309c5558) and the migration-fix commit — the only red
job; everything else (server, offline, build, type-check, both Postgres-migration jobs) was green. Two causes, surfaced
in order because the job stops at the first failing step (`bash -e`):
1. **`schema-audit.py --strict`** failed: the server references `product_branches_hidden` (A625, `lib/branchMenu.ts`,
   `routes/products.ts`) but the **hand-maintained** `scripts/schema-index.json` was never regenerated for it — the A625
   work added the table + code but not the index snapshot. The index was also missing four already-live columns
   (`businesses.android_till_approved_version`, `.mobile_approved_version`, two `mpesa_queried_at`). **Fix:**
   `node scripts/build-schema-index.mjs --merge-migrations` added the table + the 9 columns (additive, nothing removed).
   Audit now green: 127 tables, `total: 0`. (`refresh-schema-index.mjs --from-db` against the live DB is the authoritative
   refresh and can be re-run before prod, but merge was correct here — `product_branches_hidden` is new and fully defined
   by migration 194, so there is no DB↔migration divergence to miss.)
2. **`check-schema-drift.mjs`** then flagged `_a624_eff` (193's working table) as "a table created in a migration, absent
   from the index." Its parser's regex matches the `CREATE TEMP ` abbreviation but **not** `CREATE TEMPORARY ` — so
   migration 176's `CREATE TEMPORARY TABLE a595_parts` is correctly ignored and my `CREATE TEMP TABLE` was not. **Fix:**
   193 now uses `CREATE TEMPORARY TABLE` (the house convention 176 already uses; an exact synonym, backfill unchanged,
   193 still 10/10). **Follow-up (not done):** harden `check-schema-drift.mjs` so it ignores a temp table by *either*
   spelling — treat the `TEMP`/`TEMPORARY`/`UNLOGGED` prefix in a capturing group and skip when it is `TEMP*` (UNLOGGED is
   a real persistent table and must stay tracked). Left for a deliberate change, not a mid-test edit to a shared gate.

## 9. Phase 4 — the billing page as a per-branch × per-feature matrix (owner, 2026-11-25) ✅ DONE
Owner: "the billing page is soo confusing." Redesigned `apps/admin/src/BranchBillingCard.tsx` (per-branch view) into a
matrix — **no new API, all from the existing `cloud-plan` view**:
- Columns: **Branch · Cloud · Analytics · Attendance · Themes · Per period · (Edit)**. The old joined "Premium" text column
  and the separate Plan / Paid-until / Where-it-stands columns fold into one **Cloud** status cell (`cloudCell()` →
  `expiryText()`, with `web_off`→"Disabled", no plan→"No cloud").
- **Cloud is the gate (owner's call, confirmed):** each add-on cell is ✓ (green) when on + active, amber ✓ when set but the
  branch has no active cloud, — when off. `cloudActive(b)` = has a plan, not `web_off`, standing not in {off, locked,
  not_interested}. In the Edit panel the premium/package checkboxes are **disabled** for a branch with no active cloud, with
  a note; the stale "Premium needs the business's own switch (Features)" line is gone.
- **Package** kept as the Edit-panel toggle (confirmed); a `package` badge marks a bundled branch in the matrix.
- **Totals footer:** branches-on-cloud count, a per-feature branch count, and the grand total billed per period.
- Kept intact: the Edit panel, Record-payment flow (`branch-payments/preview`), own-prices (A617), the themes-free deal.
  Both billing tests green (branch-billing-a612 22/22, a617 25/25); admin type-clean.

## 10. Phase 3 — retire the dead master toggles + per-branch nav ✅ DONE (2026-11-25)
- **Admin Features tab** (`AdminPortal.tsx`): removed the three business-wide toggles (App themes / Analytics / Attendance)
  — their `settingRow` rows, the `hasThemes/hasAnalytics/hasAttendance` vars and the `toggleThemes/Analytics/Attendance`
  handlers are gone, replaced by one read-only note (`data-testid="premium-per-branch-note"`) pointing to Plan & billing ›
  Cloud per branch. The "Other flags" filter already excluded these keys, so they appear nowhere as switches now.
- **Dashboard Attendance nav** → per-branch, server-side: `routes/flags.ts` now overrides `analytics/attendance/themes` in
  `GET /api/flags` with `anyBranchHasFeature(cloudFactsFor(...))`, so `DashboardLayout.tsx`'s `attendanceOn` reflects
  per-branch entitlement with **no dashboard change**. Only the Attendance nav reads these keys (Analytics nav is gated by
  the `reports.analytics` permission; StaffTab reads `approval_pin`; receipt code reads `receipt_*`), so the blast radius
  is exactly the nav.
- **Tests updated:** brand-colours-a597, admin-pos-options-a604, admin-owner-settings (assert the per-branch note + no
  handler call sites, instead of the retired toggles). All green, plus every `/api/flags`-consuming test re-run green.
- **Kept for rollback:** the `feature_flags` rows and the dead `*Enabled` functions + the admin server PATCH route
  `/clients/:id/features/:key` (still used by `web_hosting` / `themes_free` / eTIMS). **Phase 5** drops the dead rows +
  functions later, once this is proven in prod.

## 11. Phase 6 — one billing surface: hide the per-business Cloud plan card for per-branch clients (owner, 2026-11-25) ✅ DONE
Owner: "the billing page is confusing — cloud per branch AND cloud per business." The Plan & billing tab stacked two
plan/payment cards: **CloudPlanCard "Cloud plan (per business)"** and **BranchBillingCard "Cloud per branch"** — two
Record-payment flows, two "paid until", two standings. **Finding:** `per_branch = (business has any branch_cloud_plans
rows)` (cloudPlanAdmin `planView`), and migration 193 gave every cloud business branch rows, so "cloud per business" is
effectively dead. The per-branch **branch-payments** handler already does the whole job (`routes/cloudPlanAdmin.ts` ~545):
sets `businesses.web_access_expires_at`, `webAccessOn(...)`, `convertTrial(...)`, and raises/settles the invoice — so the
business-level Record-payment is pure duplication.
- **CloudPlanCard** now returns `null` when `view.per_branch` (added `per_branch` to its View). So an established client
  (every one, post-193) sees only the matrix; it stays as the **bootstrap** for a not-yet-per-branch client (a fresh cloud
  trial has no branch rows — `cloudTrial.ts` creates none), where it sets the first plan and records the first payment.
- **BranchBillingCard** gained a compact **Payments & reminders** section (from the same `cloud-plan` view's `payments[]` /
  `reminders[]`, which already carried every payment incl. per-branch ones) so nothing is lost when CloudPlanCard hides.
- **AdminPortal** "Web portal access" header: the trial **Convert to paid** / **Record payment** buttons now scroll to
  `[data-testid="pay-amount"], [data-testid="branch-pay-amount"]` — whichever Record-payment field is present.
- **Never two at once:** per-branch → matrix only; fresh trial → CloudPlanCard bootstrap only (the matrix shows just the
  "Bill per branch" note). No server change; all endpoints intact. Tests green (branch-billing-a612, a617, cloud-trial-a569
  updated for the combined scroll selector, billing-credit-a587). **Not done:** complimentary paid-until still lives in
  CloudPlanCard (shown for the bootstrap only); if a per-branch client needs it, surface it in the header — follow-up.
