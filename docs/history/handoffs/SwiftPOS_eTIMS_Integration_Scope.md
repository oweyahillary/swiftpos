# SwiftPOS — KRA eTIMS Integration Scope

*Planning document. No code yet — this defines the decisions, data model, integration
points and phases before engineering starts. Owner sign-off needed on the two decision
points in §2 before Phase 1.*

---

## 1. Why this is the priority

As of 1 January 2026 KRA validates income/expense declarations against eTIMS in real
time; expenses without a compliant eTIMS invoice are disallowed, eTIMS is a precondition
for a Tax Compliance Certificate, and non-compliance carries penalties up to
KES 1,000,000. It applies to **all** businesses, VAT-registered or not. A Kenyan POS that
cannot issue eTIMS invoices is effectively unsellable to compliance-conscious merchants.

Authoritative sources (pull the spec PDFs before coding):
- KRA system-to-system overview: https://www.kra.go.ke/business/etims-electronic-tax-invoice-management-system/learn-about-etims/etims-system-to-system-integration
- OSCU spec v2.0: https://www.kra.go.ke/images/publications/OSCU_Specification_Document_v2.0.pdf
- VSCU spec v2.0: https://www.kra.go.ke/images/publications/VSCU_Specification_Document_v2.0.pdf
- Sign-up guide (OSCU/VSCU): https://www.kra.go.ke/images/publications/OSCU_VSCU_Step-by-Step_Guide-on-how-to-sign-up.pdf

---

## 2. Two decisions to make first (owner sign-off)

### Decision A — Integration mode: OSCU vs VSCU
- **OSCU (Online Sales Control Unit):** for invoicing that is *always online*. Each sale
  is signed by KRA in real time at point of sale.
- **VSCU (Virtual Sales Control Unit):** a bridge module suited to *bulk invoicing and
  systems that are not always online*; it transmits when KRA is reachable and tolerates
  downtime (KRA allows up to a 48-hour window for offline-generated invoices).

**Recommendation: VSCU.** SwiftPOS already has a `branches.deploy_mode` of `local`/`cloud`,
a `sync_queue`, and a desktop offline ambition. Kenyan connectivity outside the main towns
is unreliable, and a cashier must never be blocked from completing a sale because KRA is
unreachable. VSCU's queue-and-transmit model maps directly onto the architecture you
already have. (OSCU would force a hard online dependency at checkout.)

### Decision B — Build path: self-integrate vs certified third-party integrator
- **Self-integrate:** build against the KRA spec, then go through KRA's development →
  testing → vetting → certification process. Full control; more time; you own
  certification and ongoing spec changes. Feasible — your stack is Node/TS and Node SDKs
  exist (e.g. Paybill, matatashadrack).
- **Certified integrator (e.g. Slade360 by Savannah Informatics, Paybill):** call their
  API; they hold KRA certification and absorb spec changes. Faster to market; a per-
  transaction or subscription cost; a third party in your compliance-critical path.

**Recommendation: start against a certified integrator's VSCU API for time-to-market,
behind our own abstraction layer (see §4) so we can swap to self-integration later
without touching the order flow.** Confirm cost model before committing.

> Both decisions are reversible at the abstraction boundary if we build §4 correctly.

---

## 3. Multi-tenant reality (the part that makes this non-trivial)

eTIMS is **per-taxpayer**, not per-platform. SwiftPOS is multi-tenant, so:

- Each client **business** onboards to eTIMS under **its own KRA PIN** (`businesses.tax_pin`
  already exists). SwiftPOS cannot invoice on a shared PIN.
- A control unit (OSCU/VSCU) is registered **per branch/device**, returning identifiers
  (e.g. device/branch ID, a communication key) that must be stored per branch and sent on
  every request.
- Therefore onboarding a client now includes an eTIMS onboarding step (collect/confirm KRA
  PIN, register the branch control unit, store credentials). This extends the agent
  onboarding flow and the admin "New Client" flow.
- Businesses not yet eTIMS-onboarded must degrade gracefully: SwiftPOS keeps selling and
  printing internal receipts, but flags invoices as "not fiscalised" until configured.
  A `feature_flags` entry (e.g. `etims_enabled`) gates the behaviour per business.

---

## 4. Architecture — an abstraction boundary

Build one internal module the rest of the app talks to, so the mode (OSCU/VSCU) and the
provider (self vs integrator) are swappable:

```
apps/server/src/lib/etims/
  index.ts          // public interface: fiscaliseInvoice(), fiscaliseCreditNote(), registerBranch()
  provider.ts       // concrete adapter (integrator API or self VSCU); selected by config
  queue.ts          // enqueue + retry transmission; ties into existing sync_queue pattern
  types.ts          // our invoice DTO -> provider payload mapping
```

The rest of the codebase only ever calls `etims.fiscaliseInvoice(orderId)`. Swapping
provider/mode = swapping `provider.ts`, nothing else.

---

## 5. Data model additions (migration)

New tables / columns (final names to confirm against the chosen provider's payload):

- **`businesses`** — already has `tax_pin`, `vat_rate`. Add eTIMS onboarding status.
- **`etims_branch_config`** (new, per branch): control-unit / device registration data
  returned by KRA at branch registration, communication key (store encrypted), last sync
  cursor, environment (sandbox/production).
- **`products`** — add **`tax_type`** (KRA tax category: e.g. A/B/C/D/E for
  exempt/zero/standard-16%/etc.) and **`kra_item_class_code`** (KRA item classification
  code). KRA requires both on every line — this is a real catalogue change and needs a
  UI field on the product editor and bulk-import.
- **`etims_invoices`** (new, per fiscalised order): order_id, status
  (`pending`/`sent`/`signed`/`failed`), KRA fiscal document number, signature, QR payload,
  invoice counter, sent_at, error, retry_count. This is the audit trail KRA expects you to
  retain.
- **`receipt_templates`** — already has `show_qr`. Wire it to render the KRA QR + fiscal
  number once available.

Add all of the above to the consolidated migration file as a new section.

---

## 6. Where it hooks into existing code

- **Order completion** — `POST /api/orders` and `POST /api/orders/:id/pay`
  (`apps/server/src/routes/orders.ts`, just refactored). After the order + payment commit,
  call `etims.fiscaliseInvoice(order.id)`. **Non-blocking to the sale**: enqueue and return;
  the cashier is never blocked. Mirrors how `fireWebhook` is already called.
- **Voids / refunds** — `POST /api/orders/:id/void` must issue an eTIMS **credit note**
  referencing the original fiscal number. Note KRA rule: a credit note must be created from
  the **same** solution that issued the original invoice.
- **Receipt rendering** — the customer receipt template adds the KRA QR code + fiscal
  document number once `etims_invoices.status = 'signed'`. If still pending (offline), print
  the receipt and reconcile the fiscal data on sync.
- **Offline / local mode** — transmission goes through `queue.ts`, reusing the
  `sync_queue` retry discipline. This is exactly the offline path the (deferred) desktop
  sync engine was meant to serve — the two workstreams reinforce each other.
- **Onboarding** — agent onboarding + admin "New Client" gain an eTIMS step (§3).

---

## 7. Build phases

**Phase 0 — Prerequisites (blocks coding):**
- Owner signs off Decision A (VSCU) and Decision B (integrator vs self).
- Obtain KRA eTIMS **sandbox** access; if using an integrator, obtain their sandbox keys.
- Pull OSCU/VSCU v2.0 spec PDFs; confirm exact payload schema + item classification list.
- Decide where per-business eTIMS secrets are stored + encrypted.

**Phase 1 — Foundations:**
- Migration: `etims_branch_config`, `etims_invoices`, `products.tax_type` +
  `products.kra_item_class_code`, business onboarding status, `etims_enabled` flag.
- Build the `lib/etims` abstraction with a sandbox adapter; no order wiring yet.
- Product editor + bulk import: capture tax type + classification code.

**Phase 2 — Happy path (sandbox):**
- Branch registration call (one-time per branch) storing the returned CU data.
- `fiscaliseInvoice()` on order completion → enqueue → transmit → store signature/QR.
- Render QR + fiscal number on the receipt template.

**Phase 3 — Edge + resilience:**
- Credit notes on void/refund (same-solution rule).
- Offline queue + retry + 48-hour window handling; "not fiscalised" surfacing.
- Reconciliation: a report/admin view of `pending`/`failed` fiscalisations.

**Phase 4 — Onboarding + go-live:**
- eTIMS step in agent + admin onboarding flows.
- KRA vetting/certification (if self-integrating) or integrator production switch.
- Pilot with one real business PIN before fleet rollout.

---

## 8. Open questions to resolve in Phase 0
1. Integrator vs self-integration — and if integrator, which one + cost model?
2. Confirm the KRA item classification code list and how we map existing products to it
   (manual per product? a default per category?).
3. Where/how are per-business eTIMS credentials stored and encrypted at rest?
4. Sandbox availability and timeline for obtaining test PIN + control unit.
5. Receipt layout: does the 58mm printer have room for the QR, or 80mm only?

---

*Once Decisions A and B are signed off and sandbox access exists, Phase 1 (migration +
abstraction layer) can start immediately — that part has no external blocker.*
