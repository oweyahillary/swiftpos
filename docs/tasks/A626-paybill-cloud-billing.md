# A626 — ZapTill cloud billing by M-Pesa Paybill (clients pay with a code; Daraja auto-reconcile)

**Owner, 2026-11-25.** *"Add a Paybill and each client gets a code as their account number. They pay, the system detects
it via Daraja, matches the code to the client, and enables what they paid for. If the amount is less the admin allocates
it; if it is more the system keeps the balance for future allocations."*

Today ZapTill's **cloud subscription** payments are recorded **by hand** (super admin, on Plan & billing — `CloudPlanCard`
for a bootstrap client, the per-branch matrix `BranchBillingCard` otherwise). `CloudPlanCard` itself says *"payment
detection is manual for now (M-Pesa Daraja later)."* A626 is that automation: ZapTill's own Paybill + Daraja C2B feeds the
existing billing engine, so most client payments reconcile themselves and the admin only touches the exceptions.

> Not to be confused with **A621** (branch M-Pesa C2B): that is a *customer* paying a *client's* branch Till/Paybill at the
> POS. A626 is a *client* paying *ZapTill* for the subscription — one ZapTill Paybill, many clients, matched by an account
> code. A626 **reuses A621's Daraja C2B plumbing** (the confirm-URL + secret token, `c2bDaraja.ts`, register/test) but is a
> separate, admin-side system with its own table and screens.

## 0. Phase 1 — the pipe ✅ BUILT (2026-11-25), proven offline; live sandbox pending
Scope built: register ZapTill's Paybill C2B callback with Daraja, receive a confirmation, record it raw (deduped on the
M-Pesa code), a sandbox test-payment, and an admin card to see it. **No matching / wallet / allocation yet** (that is the
rest of this spec, Phase 2). Reuses A621's `c2bDaraja.ts` + `lib/c2b.ts` (token hashing, `parseConfirmation`, `ACCEPTED`).
- **Migration 195** `migrations/195_zaptill_billing_c2b.sql` — `zaptill_billing_c2b` (one registration row) + raw
  `cloud_billing_receipts`. Service role only. Tested `scripts/test-migration-195.mjs` 9/9.
- **Server:** `lib/cloudBilling.ts` (env creds `zaptillDaraja()`, the `/api/cloud-billing/c2b/...` URL builder,
  `normalizeBillRef`), `lib/cloudBillingStore.ts` (the tables, dedupe), `routes/cloudBillingC2b.ts` (the Safaricom
  callbacks, always `{ ResultCode:0 }`), `routes/cloudBillingAdmin.ts` (`GET /settings`, `POST /register`,
  `POST /test-payment`, `GET /receipts` under `/api/admin/cloud-billing`). Mounted in `routes/index.ts`.
- **Admin:** `apps/admin/src/CloudBillingSettingsCard.tsx` on the Billing page — status, Register, Send sandbox test,
  the receipts feed.
- **Creds are ENV** (not a DB form): `ZAPTILL_MPESA_CONSUMER_KEY`, `ZAPTILL_MPESA_CONSUMER_SECRET`,
  `ZAPTILL_MPESA_SHORTCODE` (+ optional `ZAPTILL_MPESA_TYPE=paybill`). Only the callback token hash + registration state
  are in the DB. Uses the shared `MPESA_ENVIRONMENT` (sandbox default) and `MPESA_CALLBACK_BASE_URL`.
- **Tests:** `tests/cloud-billing-a626.test.mjs` 13/13 (register super-only, the URLs + token hash, a confirmation lands +
  normalises the code, dedupe, wrong-token ignored, non-payment ignored, validate, sandbox simulate, the feed, a refusal
  keeps the prior registration, NO_CREDS). All Schema-drift gates green (schema-index regenerated for the two tables).
- **Live sandbox (owner, on dev):** apply migration 195; set the three `ZAPTILL_MPESA_*` env vars (Daraja sandbox keys +
  ZapTill's sandbox shortcode, e.g. 174379) on the dev server; open admin → Billing → *Cloud billing — M-Pesa Paybill* →
  **Register with Safaricom** → **Send sandbox test payment** (KES 1) → it appears in **Receipts** within seconds.

## 0b. Phase 2a — identify the payer (billing code + matching) ✅ BUILT (2026-11-25), proven offline
Scope built: **who paid**, by the account code. No money moves yet (the wallet + allocation are Phase 2b).
- **Migration 196** `migrations/196_business_billing_code.sql` — `businesses.billing_code` (+ `billing_code_norm`, unique on
  the normalised form) and a **backfill** so every current client gets a code from its name (unique by a numeric suffix on
  a clash). Tested `scripts/test-migration-196.mjs` 6/6.
- **Matching** (`lib/cloudBillingStore.ts`): a confirmed receipt is matched to the client whose `billing_code_norm` equals
  the normalised `BillRefNumber` — exact-on-normalised only. `status` becomes `matched` (+ `business_id`) or `unmatched`.
  `keepReceipt` now sets an explicit `id` (the mock has no `gen_random_uuid()` default). The receipts feed attaches each
  matched client's name.
- **Billing code + assign** (`routes/cloudBillingAdmin.ts`): `GET /clients/:id/code` (generates one from the name if none),
  `PUT /clients/:id/code` (super admin; a code another client holds → 409), `POST /receipts/:id/assign` (super admin —
  assign an unmatched receipt to the client whose code is given; unknown code → 404). `planView` (cloudPlanAdmin) returns
  `billing_code`, so the per-client Plan & billing shows it.
- **Admin UI:** the code shows in `BranchBillingCard`'s header; `CloudBillingSettingsCard`'s receipts feed gains a
  **Client** column with inline **assign-by-code** for unmatched rows.
- **Tests:** `tests/cloud-billing-a626.test.mjs` 16/16 (matching, unmatched, assign incl. super-only + unknown-code, code
  GET/PUT, the feed shows the client). Schema-drift gates green; the `.from()` calls use string literals so the drift
  parser resolves each table. **Phase 2b (next):** the credit wallet, allocation against open invoices via the existing
  branch-payment engine, auto-apply, and the paid-invoice receipt.

## 0c. Phase 2b — move the money (credit wallet + allocation) ✅ BUILT (2026-11-25), proven offline
- **Migration 197** `migrations/197_cloud_credit_wallet.sql` — `business_cloud_credit` (a balance per client, `CHECK >= 0`) +
  `cloud_credit_entries` (the ledger). Service role only. Tested `scripts/test-migration-197.mjs` 6/6.
- **Allocation** (`lib/cloudBillingAllocate.ts`): `allocate(businessId, { amount, reference, paidAt, receiptId, by })` —
  `amount + wallet` settles the client's open cloud invoices **oldest-first, each in full** (`openCloudInvoices`); the
  remainder stays in the wallet; **nothing half-enabled**. Settling marks the invoice paid, moves its branches' paid-until
  to the period end (only forward), turns web access on and converts a trial — the same opening a hand-recorded branch
  payment does, fed by the invoice. `amount: 0` drains the wallet alone (the admin's Allocate / the billing job later).
- **On receipt** (`routes/cloudBillingC2b.ts`): a matched payment is allocated at once; status → `allocated` (settled
  something) or `matched` (held in wallet). The receipt **email** is fire-and-forget (Safaricom must not wait): a
  paid-invoice receipt when settled, a "credit received" note otherwise (`emailBillingReceipt`, reusing `receiptEmailHtml`).
- **Admin** (`routes/cloudBillingAdmin.ts`): `GET /clients/:id/credit` (balance + ledger), `POST /clients/:id/credit/allocate`
  (super admin — drain the wallet into open invoices). `planView` returns `credit_balance`; `BranchBillingCard` shows the
  credit + an **Allocate now** button.
- **Tests:** `tests/cloud-billing-a626.test.mjs` 23/23 — exact (settles + extends branch + opens access, wallet 0),
  overpayment (surplus → wallet), underpayment (held, invoice open, status matched), no-invoice (→ wallet), **auto-apply**
  (held + a later payment settle it), admin Allocate (super-only). Schema gates green.
- **Auto-drain ✅ (2026-11-26):** `runCloudBilling` (the hourly billing job) now calls `drainCredits()` after it raises
  invoices — every client with held credit has its wallet applied to its open invoices, so a prepayment (or a topped-up
  underpayment) settles the new invoice by itself. **A credit less than the invoice is a no-op** (the invoice stays open,
  the credit stays held, nothing half-paid; the client follows the normal unpaid ladder until topped up). To avoid a lib↔job
  import cycle, `ownerEmailOf` moved to `lib/ownerEmail.ts` (used by the reminders job, cloudPlanAdmin and cloudBillingAllocate).
  Tested in `cloud-billing-a626.test.mjs` (drain settles; credit < invoice is a no-op).
- **Not done (Phase 2b follow-ons):** a super-admin wallet adjust/refund; surface `allocated` vs `matched` and the wallet
  in the global receipts feed; reversal-callback handling; the invoice reminder email could net off held credit
  ("you owe KES X after your KES Y credit") rather than show the full amount.

## 1. What it does

- ZapTill registers **one Paybill** with Safaricom (ZapTill's own shortcode). Each client (business) carries a unique
  **billing code** used as the Paybill **account number** — e.g. `KUDO` for *kudokudo*. The code is printed on every cloud
  invoice next to the Paybill.
- A client pays on M-Pesa: Paybill `12345`, account `KUDO`, amount `10,000`. Safaricom calls ZapTill's **C2B confirmation
  URL** within seconds with `{ BillRefNumber: "KUDO", TransAmount, TransID, MSISDN, … }`. **Push, not poll** — ZapTill
  never queries Daraja for incoming payments (the Transaction-Status query API is only for checking one known `TransID`).
- The cloud **matches** the normalised `BillRefNumber` to the client's billing code, records the receipt once per `TransID`,
  and **allocates** the money against the client's open cloud invoice(s) through the existing per-branch billing engine —
  settling the invoice, extending each branch's paid-until, turning web access on and converting a trial, exactly as a hand
  -recorded payment does today.
- **Amount handling** (owner's rule):
  - **Exact / covers an open invoice** → settle it, extend those branches, surplus (if any) → the client's **credit wallet**.
  - **Less than any open invoice** → hold the whole amount in the **credit wallet**; nothing is half-enabled; the admin
    **allocates** it (or it auto-applies once the wallet grows enough to cover an invoice).
  - **More** → settle the invoice(s) oldest-first; the **surplus stays in the wallet** and auto-applies to the next period.
  - **No open invoice** (prepaid) → the whole amount → wallet; auto-applies when the next invoice is raised.
- **Unmatched** (wrong/blank/typo'd account number, or a code that matches no client) → an admin **"Unmatched payments"**
  queue. The money is kept and logged; the admin assigns it to the right client, then it allocates as above. (Mirrors
  A621's *Reports › M-Pesa unmatched*.)
- **Receipt** (owner, decided): on allocation the client is emailed a **paid-invoice receipt** (the existing cloud payment
  receipt — `cloud_payments.receipt_sent`). A payment that only lands in the wallet (unallocated) gets a **"credit
  received"** acknowledgement instead, not a paid-invoice receipt.

## 2. The billing code (the account number)

- **Format:** short, upper-case, unambiguous — avoid `0/O`, `1/I/L`. A memorable word (`KUDO`) or a short alphanumeric;
  3–12 chars. Generated from the business name with a uniqueness check, editable by super admin.
- **Globally unique** across all businesses, never reused (a dropped client's code is retired, not handed on).
- **Normalisation before matching** (both the stored code and the incoming `BillRefNumber`): trim, upper-case, strip all
  non-alphanumerics. So `kudo`, `KUDO `, `Kudo`, `ku-do` all match the stored `KUDO`. Matching is an exact lookup on the
  normalised form — never a fuzzy/nearest match (a fuzzy match could credit the wrong client).
- **On the invoice & the admin:** shown on every cloud invoice ("Pay to Paybill 12345 — Account: **KUDO**"), on the client's
  Plan & billing header, and copyable. Stored on `businesses` (`billing_code`, plus `billing_code_norm` unique index).

## 3. Matching & allocation — the core rules

On each confirmation callback (after dedup on `TransID`):

1. **Dedup:** if a receipt with this `TransID` already exists → answer Accepted, do nothing (Safaricom retries callbacks).
2. **Match:** normalise `BillRefNumber`; look up `businesses.billing_code_norm`.
   - **No match** → store as an **unmatched** receipt (status `unmatched`), answer Accepted. Surfaced to admin to assign.
3. **Allocate** against the client's open cloud invoices (`invoices` where `kind='cloud'`, `status='pending'`, oldest
   `period_start` first — the same set the engine uses today):
   - Take the receipt amount **plus any existing wallet balance** as the pot.
   - Settle invoices oldest-first while the pot covers each in full (reuse `cloudPlanAdmin`'s branch-payment path:
     mark invoice paid, move each of its branches' `paid_until`, `webAccessOn`, `convertTrial`, set
     `businesses.web_access_expires_at`).
   - **Remainder** (pot minus what was settled) → the **credit wallet** (never partially settles an invoice).
   - If **nothing could be settled** (remainder < the smallest open invoice) → the whole receipt sits in the wallet;
     flag it to admin to allocate manually (they may extend a specific branch, or wait).
4. **Receipt record:** every receipt is written to a raw feed table `cloud_billing_receipts` (status
   `matched|allocated|unmatched|held`), plus — for the allocated part — a row in the existing `cloud_payments`
   (`method='mpesa'`, `reference=TransID`, `branch_ids`, `paid_until_after`) so it shows in the same **Payments &
   reminders** history the matrix already renders (A624 §11).

The allocation executor is the **existing** engine — A626 adds the *intake*, the *match*, and the *wallet*; it does not
re-implement how a payment extends a branch or raises an invoice.

## 4. The credit wallet

- **Per business:** `business_cloud_credit` (`business_id` PK, `balance` numeric, `currency` default `KES`, `updated_at`)
  with a ledger `cloud_credit_entries` (`business_id`, `delta`, `reason`, `receipt_id`/`payment_id`, `by`, `at`).
- **In:** an un-allocatable receipt, an overpayment surplus, or an admin top-up. **Out:** an auto-allocation that settles a
  new invoice, or an admin allocation.
- **Auto-apply:** whenever a new cloud invoice is raised (the billing job) or a new receipt arrives, if wallet ≥ the oldest
  open invoice, settle it from the wallet and extend — no admin needed.
- **Visible** on the client's Plan & billing header ("Credit: KES 4,000") and in the ledger; an admin can allocate or (super
  admin, audited) refund/zero it.

## 5. Setting it up

**Super admin → System → Cloud billing (M-Pesa).** One-time, ZapTill-wide (not per client, not per branch):
1. Enter ZapTill's **Paybill shortcode** and the Daraja app's keys (consumer key/secret, passkey if needed) — stored
   encrypted, never shown.
2. **Register with Safaricom** — registers the C2B confirmation (and, if approved, validation) URL. A fresh secret **token**
   is minted and saved only after Safaricom accepts (as A621 does), so a failed re-register never breaks a working one.
3. **Sandbox:** *Send a test payment (sandbox)* — a **KES 1** test payment (sandbox takes real money; KES 1 only) with a
   chosen account code lands on the feed within seconds.
4. **Launch confirmation-only.** Safaricom **External Validation** (rejecting a bad account number at pay-time) needs a
   separate application; until then, accept-then-reconcile via the unmatched queue — the normal way to start.

`MPESA_CALLBACK_BASE_URL` must be the cloud's public **https** base and must avoid Safaricom's forbidden words
(`mpesa`, `m-pesa`, `safaricom`, `exe`, `exec`, `cmd`, `sql`, `query`) — reuse the A621 check.

## 6. Admin screens

- **Client billing code:** on each client's Plan & billing header — the code, with Generate / Edit (super admin, uniqueness
  enforced) and Copy.
- **Unmatched payments** (System → Cloud billing, and a count badge): each unmatched/held receipt with amount, masked
  MSISDN, first name, `TransID`, time, and the typed account text; **Assign to client** (search) → re-runs matching/alloc.
- **Credit wallet:** per client, the balance + ledger; **Allocate** (choose which open invoice / branches to apply it to),
  and (super admin) adjust with a reason (audited).
- **Receipts feed:** the raw Daraja feed (all statuses), filterable by day, for reconciliation against the M-Pesa statement.

## 7. Run order

1. **Migration A626** — `businesses.billing_code` (+ unique normalised index), `cloud_billing_receipts`,
   `business_cloud_credit`, `cloud_credit_entries`, and the ZapTill C2B settings row (encrypted keys, token hash,
   registration state). Additive; until it runs the callback answers Accepted and keeps nothing.
2. Deploy the server (`MPESA_CALLBACK_BASE_URL` set, https, clean of forbidden words).
3. Super admin: enter the Paybill + keys, **Register**, sandbox **test payment**.
4. **Backfill billing codes** for existing clients (generate from the name; print on the next invoice).
5. Dashboard/admin ships with the deploy (no desktop release needed — this is admin-side only).

## 8. Technical

- **Safaricom's addresses** (no sign-in — the ZapTill billing secret token in the path is the proof; only its SHA-256 is
  stored; always answers `{ ResultCode: 0, ResultDesc: "Accepted" }`):
  - `POST /api/cloud-billing/c2b/confirm/<token>` — dedup on `TransID`, match the code, allocate, record.
  - `POST /api/cloud-billing/c2b/validate/<token>` — accept (or, with External Validation, reject an unknown code).
- **Admin:** `GET /api/admin/cloud-billing/settings`, `POST …/register`, `POST …/test-payment`;
  `GET …/receipts?from=&to=&status=`, `POST …/receipts/:id/assign` ({ business_id });
  `GET /api/admin/clients/:id/billing-code`, `PUT …/billing-code`;
  `GET /api/admin/clients/:id/credit`, `POST …/credit/allocate`, `POST …/credit/adjust` (super admin, audited).
- **Reuse:** `apps/server/src/lib/c2bDaraja.ts` (register C2B URLs, sandbox test), the confirm-URL+token pattern and the
  forbidden-words check from A621; `routes/cloudPlanAdmin.ts` (`workOutBranches`, the branch-payment settle path,
  `openCloudInvoices`, `insertCloudInvoice`, `nextInvoiceNumber`, `webAccessOn`, `convertTrial`) as the allocation executor;
  `cloud_payments` for the allocated-payment history (A624 §11 renders it in the matrix).
- **New code (proposed):** `lib/cloudBilling.ts` (match + allocate rules, pure where possible), `lib/cloudBillingStore.ts`
  (the tables), `lib/cloudBillingDaraja.ts` or extend `c2bDaraja.ts`; `routes/cloudBilling.ts` (the callbacks + admin);
  admin `CloudBillingSettingsCard.tsx`, `UnmatchedPaymentsCard.tsx`, and a credit section on `BranchBillingCard`/the header.
- **Tables** (service role only): `cloud_billing_receipts`, `business_cloud_credit`, `cloud_credit_entries`,
  `zaptill_c2b_settings` (one row); `businesses.billing_code` + `billing_code_norm`.

## 9. Security

- The callback carries no session — the **secret token in the path** (SHA-256 stored) is the proof, minted at Register,
  as A621. Optionally pin Safaricom's published source IPs.
- Encrypted Daraja keys at rest; never returned to the browser.
- Idempotent on `TransID`; a replayed callback changes nothing.
- Matching is exact-on-normalised only — never fuzzy (a wrong credit is worse than an unmatched one the admin assigns).

## 10. Edge cases

- **Reversal callback** (Safaricom reverses a payment) → debit the wallet / un-settle if the reversed receipt was allocated;
  audited; if it would push a branch's paid-until back, flag to admin rather than silently lock.
- **Duplicate callback** → dedup on `TransID`.
- **Locked / trial / not-interested client** pays → the engine's existing pay-as-you-go rule applies (A587): a fresh period
  from the payment day, the locked time not charged, the stale invoice closed.
- **Overpayment** → surplus to wallet (never a negative invoice).
- **Two receipts at once** covering one invoice → the engine's optimistic paid-until guard (A612) already prevents a double
  move; the second becomes wallet credit.
- **Wrong client assigned in the unmatched queue** → an admin can re-assign (audited) before allocation; after allocation,
  a reversal entry + re-allocate.

## 11. Tests

- `scripts/test-migration-A626.mjs` — the tables + the unique normalised code index (in CI).
- `tests/cloud-billing-a626.test.mjs` — the match (normalisation; exact; unmatched), the allocation (exact/under/over/no
  invoice), the wallet (surplus kept, auto-apply), dedup on `TransID`, reversal, and the callback answers Accepted; the
  admin assign/allocate routes over HTTP on the real engine in PGlite.

## 12. Decisions (owner, 2026-11-25) ✅ LOCKED

1. **Billing code — auto + override.** Auto-generate from the business name (uniqueness-checked); super admin may edit.
2. **Underpayment — hold in the wallet** for the admin to allocate; it auto-applies once the wallet covers an open invoice.
   No branch is ever half-enabled.
3. **One Paybill** — no Buy Goods Till.
4. **Send the client a receipt** when a payment is allocated (reuse the existing cloud payment receipt email). A payment
   that only lands in the wallet sends a "credit received" acknowledgement, not a paid-invoice receipt.
5. **Launch confirmation-only** (accept all, reconcile via the unmatched queue); apply for Safaricom External Validation
   later to reject an unknown code at pay-time.
