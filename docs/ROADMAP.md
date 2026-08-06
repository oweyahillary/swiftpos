# SwiftPOS — Roadmap & Backlog

_Last updated: 2026-07-10 (session 2 — tests, dine-in fix, printing notes, bundle split)_

Purpose: a single place to park ideas that came up during testing so they don't get
lost, with an explicit **now vs later** call on each. This is a planning doc, not a
commitment — items move up only when we agree to schedule them.

**Product north star:** perfect the **fast-food restaurant** flow first (booming
segment), while keeping petrol / minimart / parking modules working as secondary.

Legend — Status: `ACTIVE` (in progress now) · `PLANNED` (agreed, not scheduled) ·
`BACKLOG` (idea parked) · `GATED` (blocked on a non-code dependency).
Effort is a rough t-shirt size (S/M/L/XL), not an estimate.

---

## 1. Now (active)

### 1.1 Playwright UI test layer — `ACTIVE` · M
Automated browser tests across all three dashboard surfaces (owner `/dashboard`,
POS `/pos`, manager `/manager`) plus the public routes (`/kds`, `/menu/:slug`).
Lives in `e2e/`. Runs against local dashboard (`:5173`) + API (`:4000`).

**Status — 7 tests green:**
- Auth on all 3 surfaces: owner (session reuse via `storageState`), cashier PIN,
  custom Waiter-role PIN, manager PIN.
- POS regressions: variant sale → cash checkout; dine-in table auto-clear.
- Supporting: `npm run seed:users` (creates manager/supervisor/cashier + custom
  Waiter role with known PINs, writes them to `e2e/.env`); shared flow helper
  (`lib/pos-flow.ts`: open shift → open table → sell variant cash).

**Selector hooks added to app source** (non-behavioral `data-testid` /`data-*`):
product tile, variant option, charge button, payment confirm, table tile (+status,
+name). Pattern: prefer text/role selectors, add a testid only where inline styles
leave no stable handle.

**Learned while testing (real pre-conditions a sale passes through):** cashier login
→ **open-shift modal** (starting float) blocks the screen → restaurant opens on a
**tables view** (floor-plan tiles overlap when tables have no saved positions; use
the Grid toggle) → open a table (covers) → product grid. All encoded in the helper.

**Next specs (handoff §6):** reporting date-defaults + "Revenue Today"; Print Bill
no-freeze; session-expiry → PIN lock; `/kds` (written for fixed behaviour, skipped
until its auth is wired — see 6.1).

### 1.2 Verify two freshly-shipped fixes — `DONE (table) / PLANNED (reporting)`
- **Table auto-clear** — verified by test, and it **caught a real bug** (see 7.1);
  now fixed and guarded.
- **Reporting timezone** (Cockpit "Revenue Today" + Reports "Today" reflect a
  same-day sale) — still to be turned into a Playwright assertion.

---

## 2. Compliance — Kenya statutory (planned, partly gated)

### 2.1 KRA eTIMS integration — `GATED` · XL
KRA electronic tax invoicing. From 1 Jan 2026, expenses/income are validated against
eTIMS; a non-eTIMS invoice is not valid for tax, penalty up to 2× tax due. Effectively
mandatory for any VAT-registered client. Competitors (Odoo, Tally, Cute Profit) market
this as built-in — it's table-stakes, not a differentiator.

**What already exists in the repo (good foundation):** eTIMS schema (migration 08 +
`routes/etims.ts` + `lib/etims/` + settings page): per-branch control unit
(`etims_branch_config`, `mode vscu/oscu`, `bhf_id`, `cmc_key`, `sdc_id`), fiscal invoice
ledger (`etims_invoices`, sequential `invoice_no`, `kra_receipt_no`, credit-notes for
voids), per-product `tax_type` + `kra_item_class_code`. Column names map 1:1 to the KRA
OSCU/VSCU v2 spec. **The provider adapter is stubbed** — no real KRA calls, not wired to
checkout, no QR on receipt, no offline queue/retry.

**The gate (key finding):** you cannot go to production on the API without KRA
certification. Two routes, **both gated**:
- **(A) SwiftPOS becomes a KRA-certified third-party integrator** — one certification,
  then every client onboards under our integration (the scalable path; Odoo does this via
  "Odoo KE LTD"). Heavier bar: company reg + CR12, **≥3 qualified technical staff**,
  notarized solvency declaration, technology-architecture docs, software submission, KRA
  vetting → interim approval certificate.
- **(B) Each client self-integrates** using SwiftPOS as their invoicing system — no vendor
  cert for us, but every client repeats sandbox→certification per KRA PIN (painful at scale).

**Plan:** start building **sandbox-side now** (open to anyone, no gate) in parallel with a
**business/legal decision on A vs B** and the KRA paperwork (has lead time). For the first
fast-food client, ship **"eTIMS-ready"** and have them use KRA's free eTIMS Lite/Client for
actual fiscal receipts in the interim.
**Open decision (business, not code):** pursue A (recommended, competitive) or B?

### 2.2 Tourism Levy cleanup — `PLANNED` · M
The 2% levy on hotels/restaurants (Tourism Act 2011), base = gross sales **excluding VAT
and service charge**, remitted monthly to the Tourism Fund by the 10th of the following month.
- **Already exists:** `reports.ts` computes this as **"CTL / Catering Levy" at 2% of
  net-of-VAT**, gated to `restaurant`/`cafe`. Math is right; naming is legacy.
- **Gaps:** rename "CTL" → "Tourism Levy"; model the **service-charge exclusion**; show the
  levy as a **line on the customer receipt/invoice**; add a **monthly Tourism-Fund return
  export**. (Fast-food usually has no service charge, so the exclusion is lower priority for
  our first client.)

---

## 3. Inventory integrity (planned, optional)

### 3.1 Expiry / batch tracking — `BACKLOG` · M · optional, minimart-first
- **Already exists:** purchase orders → goods-received-notes (GRN) + `grn_items`, suppliers,
  ingredients, recipe auto-deduction on sale, stock adjustments/movements/transfers, low-stock job.
- **Missing:** any `expiry_date` / `batch_no` / lot tracking; FEFO (first-expiry-first-out)
  deduction; near-expiry alerts.
- **Decision:** **not** on the fast-food critical path (high turnover, made-to-order). Build
  as **optional, non-mandatory**, toggled per business (on for minimart, off for fast food):
  nullable `expiry_date` + `batch_no` on received-stock lines + a near-expiry alert; FEFO later.
  Defer until an early client actually needs it (i.e. a minimart).

---

## 4. Fast-food focus — north star (to define)

Concrete meaning of "perfect the fast-food flow." To be fleshed out together:
- **Speed of order entry** at the till (fewest taps to a common combo).
- **Combos / meal deals** — exists (migration 04); verify it's fast-food-grade (upsizing,
  swaps, "make it a meal").
- **KDS (kitchen display)** — currently **broken** (see 6.1); fast food lives on the kitchen
  screen, so this is high priority to fix.
- **Order queue / ticket numbers / "order ready"** display + notification.
- **Rush-hour resilience** — see offline POS (5.2).

### 4.1 Dine-in / takeaway toggle at the register — `BACKLOG` · S
The **data model, server, and reports already support the full order-type set**
(`retail, dine_in, takeaway, delivery, aggregator, …`). The gap is only at the
point of sale: the cashier screen derives `dine_in` (when a table is active) or
`retail` (when not), and **never emits `takeaway`**, with no dine-in/takeaway
switch. A restaurant sale is currently forced through table selection. Add a
counter/takeaway path that skips the table and tags the order `takeaway` — small,
because the plumbing exists. Relevant for fast food, which is often counter-service.

---

## 5. Kenyan market gaps — features the market expects that aren't here yet

Prioritised by impact for a fast-food client. Grounded in code review + market research.

### 5.1 M-Pesa Till/Paybill C2B reconciliation — `BACKLOG` · L · **high impact**
- **Today:** M-Pesa is **STK-push only** (`routes/mpesa.ts`) — cashier pushes a prompt to the
  customer's phone.
- **Gap:** a huge share of Kenyan payments are **customer-initiated** ("Lipa na M-Pesa", enter
  Till/Paybill manually). The POS can't auto-match those. Needs Daraja **C2B**
  validation/confirmation URL registration + auto-reconcile of incoming payments against open
  orders (match by amount/reference), plus reversal/refund handling.
- Why it matters: this is the single most common real-world payment path; without it cashiers
  reconcile M-Pesa by hand at close. (The presence of an Odoo-MPESA-reconciliation skill in our
  tooling underlines how common this pain is.)

### 5.2 Offline-resilient web POS + cart persistence — `BACKLOG` · L · **high impact**
- **Today:** the Electron desktop app handles offline; the **web POS likely breaks without
  connectivity**, and cart-persistence-across-reload is already flagged as missing (handoff).
- **Gap:** power/internet outages are routine in Kenya. The web POS should keep taking orders
  offline (queued draft orders, local cart persistence) and sync on reconnect.
- Ties into eTIMS offline queue (2.1) and the handoff's "server-side draft-order model" idea.

### 5.3 Delivery-aggregator order ingestion (Glovo-first) — `BACKLOG` · L
- **Today:** aggregators are **reporting-only** (`order_type='aggregator'`, revenue-after-
  commission report). Orders are keyed in manually.
- **Gap:** **Glovo dominates (~33%, growing ~40%/yr)**; Uber Eats and Bolt Food follow; Jumia
  Food exited in 2023. Fast food depends on delivery. Pull aggregator orders **into the POS/KDS**
  so staff don't double-key. Pragmatic first step: structured manual entry + per-platform
  reconciliation; full partner-API integration (Glovo first) is the larger follow-on.

### 5.4 SMS notifications & receipts (Africa's Talking) — `BACKLOG` · M
- **Today:** **no SMS anywhere** in the codebase.
- **Gap:** SMS still reaches feature phones / no-data customers — "order ready", digital
  receipts, and simple marketing blasts. Low-effort, high-reach in Kenya. (Complements the
  existing partial WhatsApp scaffolding from migration 12, which is tips-only, not ordering.)

### 5.5 Staff accountability / anti-theft hardening — `BACKLOG` · M
- **Today:** void tracking, cash variance, override PIN (migration 16), Z-report exist.
- **Gap:** theft/pilferage is a top concern for Kenyan SME owners. Strengthen with
  manager-approval workflows on voids/discounts, discount/void audit trails, mid-shift X-report,
  and blind cash counts. Partly built — this is hardening, not greenfield.

### 5.6 Secondary / nice-to-have — `BACKLOG` · S–M
- Airtel Money / T-Kash / Pochi la Biashara as additional tender types (M-Pesa dominates, so low priority).
- Swahili UI option (staff adoption).
- Note for alcohol-selling clients: NACADA's 2025 proposal may restrict online alcohol sales/delivery — watch, don't build.

---

## 6. Known-broken / carried from handoff (don't lose these)

### 6.1 KDS sends no auth token — `PLANNED` · S
`pages/kds/KDSPage.tsx` calls `/api/kitchen/tickets` with bare `fetch` and no
`Authorization` header → 401 against the hardened backend. Route it through the existing
`api`/posRequest client. High priority given fast-food KDS dependence.

### 6.2 eTIMS / M-Pesa / On-Account "in progress, untested" — `PLANNED`
Flagged by the tester as not fully verified. Verify before enabling for any live client.

### 6.3 Unbuilt POS menu placeholders — `BACKLOG`
Hold Orders, Create Orders, mid-sale Customers/Products/Payments/Discounts are placeholder
screens. **Hold Orders** and **mid-sale Discounts** are the ones a restaurant will expect.

---

## 7. Fixed this session (guarded by tests)

### 7.1 Dine-in table re-occupied after payment — `FIXED`
Paying a dine-in order and dismissing the receipt ("New order") silently flipped
the table back to **occupied**. Root cause: payment `onSuccess` freed the table but
then called `goBackToSlotPicker()`, which re-added `openOrders[activeKey]` via a
stale closure. Fix: `onSuccess` now returns to the slot-picker view without the
re-add (the other "park order" callers of the helper are unchanged). Caught by the
`table-auto-clear` Playwright spec — hand-testing had previously passed it.
Note: table occupancy is **local React state only** (`openOrders`), never loaded
from the server — worth remembering (occupancy doesn't survive a reload / isn't
shared across devices).

---

## 8. Production printing (revisit at deploy time — no domain yet)

Local dev works today: `localhost:5173 → localhost:3001` is same-scheme, no issues.
Set `VITE_PRINT_SERVER_URL=http://localhost:3001`, run the print node, done. The items
below only matter once the dashboard is served from a real HTTPS domain.

- **Print node CORS** — currently allows only origins containing `localhost`/`127.0.0.1`,
  so it will **reject the production dashboard origin**. Make the allowlist env-driven
  (e.g. `PRINT_ALLOWED_ORIGINS`) and add the deployed domain. Small change; do it at deploy.
- **Config** — set `VITE_PRINT_SERVER_URL=http://localhost:3001` in the production build.
- **Browser: localhost is reachable from HTTPS** (loopback is a secure origin, exempt from
  mixed-content), BUT Chrome 142+ shows a one-time **Local Network Access permission prompt**
  the cashier must approve (the older PNA-preflight approach was shelved). Annotating the
  print fetch with `targetAddressSpace: "local"` helps.
- **Safari / iPad / iPhone** are stricter and may block localhost from HTTPS — for those
  terminals use the **Electron desktop app** (already in the repo) or the `window.print()`
  fallback. Most deploy-proof cross-device option is a **pull model** (local agent polls the
  cloud API for jobs) — new code, revisit only if browser terminals prove unreliable.

---

## 9. App size / load performance — `DONE this session (verify with tests)`

Measured from real production builds of `apps/dashboard`.

**Diagnosis:** deps are already lean (only react, react-dom, react-router, supabase-js,
recharts). The size problem was structural: **zero code-splitting** — all 34 pages /
39 routes were statically imported into one **1,212 KB / 287 KB-gzip** chunk, so every
user downloaded all three surfaces (incl. the 616 KB POS and recharts) on first load.

**Done:** route-level `React.lazy` + `<Suspense>` in `App.tsx` (each page → its own
on-demand chunk); tuned `vite.config.ts` (`manualChunks` splits react / supabase / router
into long-cached vendor chunks; `target es2020`, `sourcemap:false`, `cssCodeSplit`).

**Result (real builds):**
- App shell: **1,212 KB → 20.8 KB**.
- Login first paint: ~287 KB gz → **~120 KB gz**.
- Cashier `/pos`: whole app → **~159 KB gz** (no owner/report/recharts code).
- After a code change, users re-download only the changed page chunk (**2–16 KB gz**)
  instead of the whole 287 KB — big for repeat visits + our frequent patching.

**Verify:** the Playwright suite is the safety net for this refactor — all 3 surfaces
must still pass after applying.

**Optional next steps (not done):** nested `<Suspense>` in `DashboardLayout`; PWA
(`vite-plugin-pwa`) for installable/offline/instant-repeat loads; brotli at host; a
`ChunkLoadError` boundary for flaky networks; swap recharts / trim supabase to cut total code.

---

## Decision log (how items landed)

- **Implement now:** Playwright UI tests + verifying the two freshly-shipped fixes. Everything
  else parked here with notes.
- **eTIMS:** engineering can start in the KRA sandbox now; **production is gated** on
  certification (decide A vs B — a business call).
- **Expiry:** optional, minimart-first; not on the fast-food path.
- **Kenyan market gaps (§5):** captured, unscheduled. Likely first movers when we resume feature
  work: **5.1 M-Pesa C2B** and **5.2 offline POS** (highest daily impact), then **6.1 KDS fix**
  for the fast-food flow.
