# SUSPEND-PURGE-PLAN.md — grace-period data purge for suspended clients

> **Status: plan for review (esp. by the accountant / DPO). No delete code exists
> yet.** From decision D2. Foundation shipped in **A122** (`businesses.suspended_at`).
> This is register **A123**.

## The model (agreed)

Two clocks, because in a POS the sales records *are* the tax records:

- **Normal user data → purge after a 6-month grace.** Non-financial operational and
  PII data (settings, layouts, devices, staff logins, catalogue, customer profiles)
  is deleted once a client has been suspended for **6 months**.
- **Financial / tax data → retained on the accountant's schedule.** Orders, payments,
  invoices, eTIMS and related records are kept until the retention period the
  **accountant** specifies (KRA is commonly ~5 years). Configurable, **not
  hardcoded** — defaults to a safe long value until you give the number.

After the financial retention window also lapses, the remaining (financial) rows and
the business itself can be fully deleted in a second, later pass.

## Classification (DRAFT — the safety-critical part; please review the RETAIN list)

**RETAIN — never deleted at 6 months (financial / tax / legally retained):**
`orders`, `order_items` (+ `order_item_modifiers` / `_variants` / `_units`),
`payments`, `payment_exceptions`, `invoices`, `etims_invoices`,
`etims_branch_config`, `float_transactions`, `customer_credit_transactions`,
`loyalty_transactions`, `purchase_orders`, `purchase_order_items`, `refunds`,
`catering_levy`, tips records, and admin/audit logs.

**PURGE at 6 months — normal user data (operational / config / PII):**
settings & schedules, floor plans / tables / reservations, printers, `products` /
`categories` / `modifier_groups` / combos (see note), suppliers, staff `users` &
roles/permissions, `user_devices`, `customers` profiles (see note), notifications,
report schedules, and other per-business config.

## Referential-integrity notes (why this isn't a simple DELETE)

- **`order_items.product_id` is `ON DELETE SET NULL`.** So `products` can be purged
  and retained order_items survive (their line detail must come from denormalised
  columns — to confirm per table before deleting). Any purge-table that a RETAINED
  table references must be `SET NULL`/`SET DEFAULT`, or the delete will fail (or, if
  `CASCADE`, would wrongly delete the retained row). Every purge-candidate's inbound
  FKs get checked before it goes on the delete list.
- **Cascade-from-`businesses` FKs exist (16 migrations).** So we must **not** delete
  the `businesses` row at 6 months — that would cascade and wipe the retained
  financials too. The 6-month pass deletes the purge-set tables explicitly, in
  dependency order, and leaves the business shell + financials.
- **PII inside retained records.** `customers`/order contact fields live in retained
  orders/invoices. Deleting the `customers` table doesn't scrub PII already copied
  into retained rows. Options: (a) leave it (tax retention wins), or (b) **anonymise**
  the PII columns in retained rows at 6 months (null names/phones, keep amounts/tax).
  **This is a data-protection-vs-tax-law question for the accountant/DPO.**

## Open questions (need answers before the destructive pass is built)

1. **Financial retention period** — the accountant's number (e.g. 5 years).
2. **Anonymise PII in retained financial records at 6 months, or leave it?** (the
   (a)/(b) above).
3. Confirm the **RETAIN list** above is complete for your compliance needs.

## Staged build (so nothing destructive ships un-reviewed)

- **A122 — done.** `suspended_at` clock.
- **Stage 1 (non-destructive):** a read-only "due for purge" detector (clients
  suspended > 6 months) surfaced in the admin portal, + a **pre-purge data export**
  (hand the client their data before anything is deleted). Safe to build now.
- **Stage 2 (destructive, admin-confirmed):** the actual 6-month purge — deletes the
  PURGE set for a chosen client in dependency order, behind an explicit admin
  confirmation, audited. Built only after the classification + Q1–Q3 are signed off.
- **Stage 3 (later):** full deletion after the financial retention window lapses.

*Plan, 2026-08-17. For review; no app code changed to produce this document. The
purge deletes customer data irreversibly — the classification here is a draft and
must be confirmed (accountant/DPO) before Stage 2 is written.*
