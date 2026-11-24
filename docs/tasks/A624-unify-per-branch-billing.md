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
