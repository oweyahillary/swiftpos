# A612 — The cloud and premium billed per branch; an unpaid branch cut off completely

**Owner, 2026-10-30:** "monthly subscription should be per branch for premium services or web — if a branch does not pay
it should not view its data and the owner should not see it too, it cuts across all users" · "if a branch has not paid
it's cut off completely, nothing syncs" · "even price change online should not sync".

Status: **ALL FOUR PHASES BUILT** (2026-10-30, overnight); not deployed — nothing deployable until all four are in. Replaces A581 /
A584's "charged PER BUSINESS" (owner, 2026-10-23).

## 1. The decisions

| # | Decision |
|---|---|
| 1 | The cloud subscription (web dashboard, sync, backup) is **per branch**: each branch has its own period, amount, paid-until, invoices and lock. |
| 2 | **Premium is per branch** too (images, variants, offers, stock, analytics, brand colours, customer screen, attendance): a paid branch with premium has it, an unpaid one doesn't, in the same business. |
| 3 | An unpaid branch (past its 7 unpaid days — A584's ladder, unchanged, now per branch) is **cut off completely, both directions**: its POS send nothing up and receive nothing down — not even a price or menu change made on the web. They keep selling offline on their last menu and prices. |
| 4 | **Nobody sees an unpaid branch's data**: the owner, partners, managers, every user. Its sales, drawers, days, stock, reports, its lines inside a customer's or supplier's history, and its share of every business total. It leaves the branch picker. |
| 5 | **Shared lists** (products, menu, customers, suppliers, staff, settings) stay usable while **at least one branch is paid**. Every branch unpaid → the whole dashboard paused, as today. |
| 6 | **Paying again:** the branch's sales from the cut-off upload in quiet hours (A602's backfill); nothing is lost. A587's pay-as-you-go stands per branch: the locked time is never charged. |
| 7 | **Existing clients:** every branch inherits the business's current paid-until and period, so nobody is locked by the change. Each branch's amount starts at the business's current amount; the admin adjusts it per branch. |

## 2. How it fits what is there

- **Today:** `cloud_plans` is one row per business (migration 170); the paid-until is `businesses.web_access_expires_at`;
  `lib/cloudPlan.ts` `cloudStanding()` gives the business's standing; `middleware/auth.ts` `cloudLapseBlocked()` refuses a
  locked business's POS writes (503 `CLOUD_SUBSCRIPTION_ENDED`) and, from the lock, every web request (403
  `CLOUD_ACCESS_PAUSED`). Premium is business-wide (`feature_flags`, the online licence, `lib/webAccess.ts`).
- **The lever for hiding a branch: A582's branch set.** A partner's "All my branches" already narrows every read to a set
  of branches (`req.branchSet`, `branchFilter()` / `byBranch()`), and a read never taught the set finds **nothing**
  (`NO_BRANCH` — fail closed, never every branch). A612 narrows **every** user's view the same way: the owner and a
  partner of every branch get the set of PAID branches whenever one branch is unpaid; a picked branch that is unpaid is
  refused; a manager or cashier of an unpaid branch is paused. So the screens A582 already taught combine the paid
  branches, and anything not taught shows nothing rather than an unpaid branch's data.
- **The cut-off for POS: server-side only.** A request from a POS whose branch is unpaid is refused whatever it is (reads
  and writes) except sign-in, the technician, support logs and the update state. Every POS version already queues on a
  503 and keeps its last catalogue, so **no desktop release is needed** for the cut-off itself.

## 3. Build, in phases (each its own commit, each tested, nothing deployed until all four are in)

**Phase 1 — per-branch standing and the cut-off** (migration 182)
- `branch_cloud_plans` (business_id, branch_id, period, amount, paid_until, billing_from, state…), filled from the
  business's plan for every existing branch (decision 7). The business's own standing becomes derived: locked only when
  every branch is.
- `cloudStanding` per branch; `standingFor(businessId)` → per-branch map, remembered as today.
- POS: `accessRefusal` by the device's branch — every request but the open paths refused (`CLOUD_BRANCH_PAUSED`, 503),
  pulls included (decision 3). Joining a POS to an unpaid branch refused.
- Web: `requireAuth` sets the paid-branch set for the owner / all-branch partner when any branch is unpaid; an unpaid
  picked branch → 403 `BRANCH_PAUSED`; a manager / cashier of an unpaid branch → paused screen; the branch list and picker
  leave it out. Writes in that narrowed view stay allowed for the owner (A582's set refuses writes — not for this).

**Phase 2 — reads that combine without a branch filter**
- Every route that reads branch data business-wide (A582 lists them; `analytics`, `controls`, the customer and supplier
  histories, credit, the business totals on Overview…) checked one by one: narrowed to the paid branches, or shown one
  branch at a time. A test sweeps every route that touches a branch-keyed table.

**Phase 3 — billing per branch** (admin portal, invoices, reminders, payments)
- The admin portal's Billing per branch (plan, amount, record payment, disable); invoices and reminders per branch (one
  e-mail listing each branch due); the owner's billing page per branch; A587's not-interested and write-off rules per
  branch.

**Phase 4 — premium per branch**
- Premium flags per branch (images, variants, offers, stock, analytics, brand colours, customer screen, attendance): set
  by the admin per branch, read where each feature is gated today (web, web POS, desktop POS via the branch's config).

## 4. Decided since, and still open

- **Invoices (owner, 2026-10-30: "we go with your recommendation"):** ONE invoice per business, a line per branch due
  that day; each branch still pays and locks on its own (a payment is recorded against the branches it covers).
- **Billed items (owner, 2026-10-30):** Cloud (web dashboard, backup, remote POS management), Analytics, Attendance,
  Themes — each per branch; the invoice lists Item / Qty (branches) / Unit price / Amount, the period once in the header,
  the branches in a note.
- **Premium package (owner, 2026-10-30):** KES 15,000 a branch a month covers the Cloud AND every premium item (Analytics,
  Attendance, Themes) — one invoice line "Premium package" in place of the separate items; a business may mix package
  branches and cloud-only branches. Built with phase 4 (premium per branch).
- Open: the website's pricing copy: "per branch, per month" for the cloud (it already prices the desktop per branch).

## 5. Before it ships

Migration 182 on prod before the deploy; each client's branch amounts checked in the admin portal; clients told that
billing is now per branch.
