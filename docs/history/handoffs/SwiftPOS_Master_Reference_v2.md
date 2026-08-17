# SwiftPOS — Master Reference

*Single source of truth. Last updated: 13 June 2026.*
*Replaces the scattered handover/README files — see the Document Map (§11) for what each old file was and whether it still matters.*

SwiftPOS is a **multi-tenant, multi-vertical Point-of-Sale platform for the Kenyan market**, with cloud and offline (local) deployment, KRA eTIMS tax compliance, and M-Pesa payments. One **business** runs one or more **branches**; each branch runs a POS with vertical-specific screens.

---

## 1. Status at a glance

| Area | State |
|------|-------|
| **Web / cloud POS** | ✅ Mature and feature-rich (system of record today) |
| **Desktop main process** (sync, local DB) | ✅ Foundation complete — config, schema, sync directions, shift/expense push all verified |
| **Desktop renderer — retail/restaurant** | ✅ Tables, KOT, held orders, petrol pumps, payment modal, Z-report |
| **Desktop renderer — manager dashboard** | ✅ Built — petrol + restaurant + retail, role-routed after PIN |
| **Desktop void at the till** | ✅ Order history panel + VoidModal wired, server enforces permission |
| **Shift/expense sync push** | ✅ Already fully implemented (confirmed by code audit — stale "Phase C" comment removed) |
| **Admin portal** | ✅ Converted `.jsx` → `.tsx`, emoji replaced with SVG, TypeScript interfaces added |
| **Shift close (all verticals)** | ✅ Fixed — `!inner` join rewritten to two-step query; `updated_at` removed from explicit UPDATE |
| **KRA eTIMS** | ◐ Built to the edge of sandbox; blocked on credentials + payload verification |
| **WhatsApp receipts** | ◐ Built; blocked on provider credentials |
| **Live database** | ✅ Verified current through migration 12 (all migrations 01–12 applied) |
| **Offline / local-server runtime** | ✗ Designed (decisions locked), not built |
| **Parking vertical on desktop** | ✗ posMode knows it; no BaysView yet |
| **True partial refund** | ✗ Server + both surfaces — only whole-order void within 30 min exists |

> Legend: ✅ done · ◐ partial / built-to-edge · ✗ not built

---

## 2. Product & commercial model (decided)

Two deploy options, **flat KES 30,000 install fee per branch**:

- **Online (cloud):** client gets a URL; owner + manager use the web dashboard; desktop terminals can also be installed and sell against the cloud with a local cache for offline resilience. **+KES 10,000 / year hosting** (cloud reporting + viewing).
- **Offline (local):** desktop app only. A dedicated PC on the branch LAN runs the **same server codebase** against a **local Postgres** and is the system of record; other tills point at it over the LAN. No hosting fee.

**Mode is per-branch**, chosen when the branch is created in the admin portal. One business can have many branches, each independently online or offline; devices inherit their branch's mode. Branch creation is admin-portal-only — that is the billable chokepoint that enforces the install fee.

---

## 3. Tech stack & repository layout

| Layer | Technology |
|-------|-----------|
| Web POS / Dashboard | React + TypeScript (Vite) |
| Desktop POS | Electron + React (local deployment) |
| API server | Node.js + Express + TypeScript — **server is the money authority** (re-prices every order) |
| Database & Auth | Supabase (PostgreSQL + Auth + Realtime) |
| Payments | M-Pesa STK push, card, cash, store credit |
| Tax compliance | KRA eTIMS (VSCU / OSCU) |
| Messaging | WhatsApp delivery (receipts) |
| Printing | Thermal 58/80mm via browser / QZ Tray |
| Currency | KES, VAT-inclusive @ 16% (VAT extracted from gross) |

```
apps/
  dashboard/   # React web app — POS screens, manager & owner dashboards, reports
  server/      # Express API — orders, payments, shifts, reports, eTIMS, M-Pesa
  desktop/     # Electron app (local mode)
  admin/       # Admin portal (fleet, onboarding, billing) — now .tsx
packages/
  sync/        # ⚠️ unused placeholder — delete or consolidate
  db/          # ⚠️ unused placeholder — delete or consolidate
migrations/    # SQL schema & migrations (Supabase / Postgres) — live through #12
docs/          # documentation
dryrun/        # dependency-free logic test harness
```

---

## 4. What is DONE — Web / cloud (mature)

The web app is the reference implementation and is broadly production-grade.

**Sales / POS (`CashierScreen.tsx`)** — feature-rich across all verticals: retail, minimart (barcode/PLU, weighed items, hardware-scanner listener, weight modal, quick-add), restaurant (tables, covers, KOT firing, courses, modifiers, variants), parking and petrol. Hold/resume, discounts/promotions, split tender.

**Payments** — cash (with change), card, **M-Pesa STK push** (fully wired in `PaymentModal.tsx`), and store credit / A/R.

**Shifts & cash** — open/close, opening float, float in/out, expected-cash + variance with mandatory variance note, **denomination breakdown** (per-business configurable, Kenyan default), quick-tender presets.

**Inventory & purchasing** — stock levels/movements/adjustments, suppliers, POs → GRN, branch transfers, ingredients/recipes (BOM) for food-cost.

**Customers** — loyalty points/transactions and **store credit accounts** (credit limit + balance, atomic `apply_credit_transaction()` RPC, debtor list, repayments; "On Account" payment method).

**Reporting** — sales/products/hourly/tax/inventory/EOD/shifts/voids/food-cost/fuel/wet-stock, pump monitor, Master DSR (Posist-style), spreadsheet export.

**Admin portal** (`AdminPortal.tsx`) — New Client creation, onboarding flow, fleet dashboard, client health scores, billing, audit log, team management, tech-access token generation, mode-switch tokens. Now TypeScript with SVG icons.

**RBAC** — `requirePermission(...)` guards **44 routes**; per-user permission overrides; manager-vs-owner separation.

### All shipped features

| Feature | State | Notes |
|---|---|---|
| Security hardening (items 1–8) | ✅ | IDOR fixes, branch authz, server-authoritative pricing, bcrypt supervisor PIN, role guards |
| KRA eTIMS fiscalisation | ◐ | Complete to the edge of sandbox — see §8 |
| Customer credit accounts | ✅ | Migration 09; full backend + UI |
| Denomination counter + tender presets | ✅ | Migration 10 |
| Restaurant dine-in (courses, turnover, split modal) | ✅ | Migration 11; split modal ships but intentionally **not wired** (avoids two competing split UIs) |
| Tips | ✅ | VAT correctly excluded from gratuity |
| WhatsApp receipts | ◐ | Built; gated on credentials |
| Manager dashboard parity (web) | ✅ | Credit + Turnover tabs on the PIN-auth client |
| Petrol POS (web) — pumps, fuel sales, wet-stock | ✅ | Pump monitor, fuel grade reporting, tank deduction |
| Cashier attribution on orders | ✅ | `cashier_id` written on every order; JWT email→users.id resolved server-side |
| Shift close fix (all verticals incl. petrol) | ✅ | Two-step cash-sum query; `updated_at` removed from explicit UPDATE |

---

## 5. What is DONE — Desktop

### Main process (complete)
- **Runtime config** — `deviceConfig.ts`: deploy_mode, server_url, branch_id, business_type stored in SQLite; lock after install; factory-reset is tech-gated.
- **Install flow** — `InstallPage.tsx` shown when no config exists; locks on complete.
- **Local schema** — all tables present: orders (with cashier_id, shift_id, tip_amount, void columns), order_items, payments, shifts, float_transactions, expenses, users, products, categories, tables, pumps, sync_queue, staff_session, session.
- **Sync directions** — declared and implemented: catalogue/users pull-down (remote wins); orders/payments/shifts/float_transactions/expenses push-up (local origin). `pushLocalRecords()` fully implemented — shifts, floats, and expenses push to `/api/sync/push` before every order push.
- **Exactly-once offline sales** — `X-Idempotency-Key` on order push; server returns existing order on duplicate.
- **Token refresh** — expired staff tokens self-heal on reconnect.

### Renderer (complete for current scope)

**App.tsx routing** — boot → install (if no config) → owner login → PIN → role check → manager or cashier.

**Role routing after PIN:**
- `manager / supervisor / admin / branch_manager` → `ManagerPage`
- All others → `POSPage`

**POSPage** — retail product grid, restaurant tables/KOT/held orders (TablesView), petrol pump grid (PumpsView), payment modal (cash/M-Pesa/card, split tender, discount, tip), shift panel, Z-report, printer settings, barcode-friendly product search.

**ManagerPage** — full desktop manager dashboard, vertical-aware:
- **Petrol:** KPI row, pump monitor table (pump/grade/litres-today/revenue/status), grade bar chart, payment split
- **Restaurant:** KPI row, payment split, top sellers, table grid, hourly chart, item mix tab
- **Retail:** KPI row, payment split, top sellers, hourly chart
- All verticals: Orders (last 30, sync status), Shift (live KPIs), Shift Report (printable), Stock (with low/critical badges)
- "Open POS" button to switch to the till without signing out

**Order history + void at the till:**
- "History" button in POS top bar → panel showing last 30 orders from local SQLite
- Orders within 30-minute window show Void button
- `VoidModal` — reason picker, supervisor PIN for paid orders, server enforces `orders.void` permission
- Local order status updated immediately on success

**Shift/expense sync** — confirmed fully implemented (see main process above).

**ZReportView** — thermal-printer-friendly, printable via `printReceipt()`.

**VoidModal** — reason picker, supervisor PIN (paid orders only), server-enforced permission + 30-min window, clear error messages.

---

## 6. Architecture decisions — locked (desktop / offline)

| # | Decision |
|---|---|
| D1 | **One server codebase, two DB targets** — cloud → Supabase; offline → local Postgres. Every fix applies to both. |
| D2 | **Offline install provisions online once**, then runs disconnected. No fully-offline business creation. |
| D3 | **Local Postgres** as the offline datastore (handles concurrent tills). |
| D4 | **Desktop server URL is runtime config**, not compile-time `VITE_SERVER_URL`. |
| D5 | **Install/config flow = open-first-run → locked.** Every change after is tech-token gated. |
| D6 | **Owner email login is online-only.** Offline auth = install token + locally-seeded credential. |
| D7 | **Tech panel = key combo → tech PIN → one-time HMAC secret** (signed permission tier: `diagnostics` / `install` / `mode_switch`). |
| D8 | **Branch mode changed only via on-site tech migration flow** — never a bare portal toggle. |
| D9 | **Reporting is tiered, not gated.** Operational on-device (today/shift/branch/summary) vs rich analytics on web (range/slicing/cross-branch/export). |
| D10 | **Retention by role:** tills capped (rolling window); local server full history; single-machine + mandatory backup. |
| D11 | **Bound branch is a device property**, set at install — cashier never picks branch per login. |

**Admin-portal / fleet additions not yet built:** expose `branches.deploy_mode` on branch-create; `devices`/`terminals` registry (one row per installed machine); fleet + billing reconciliation views.

---

## 7. What is PENDING — remaining build work

### Cross-surface gaps

**True partial refund (Phase 4)** — "refund" today = void-whole-order within 30 minutes. Post-window or per-item refunds don't exist anywhere. Restaurant and petrol clients will hit this. Needs server route + desktop VoidModal extension + web surface.

**Permission-gated desktop till actions (Phase 3)** — server enforces all 44 permissions; desktop till UI doesn't show/hide actions by role yet. Cashier sees no void button regardless (correct), but the UI should explicitly gate discounts and price overrides.

**Desktop barcode scanner** — web retail POS has a hardware keyboard-wedge listener (80ms buffer, EAN-13). Desktop has none. One `useEffect` in `POSPage.tsx`.

**Desktop expense entry in ShiftPanel** — expenses table exists locally, syncs up, but ShiftPanel has no UI to record a petty-cash expense from the till.

**Parking vertical on desktop** — `posMode` knows `parking`; no `BaysView`, no time-based billing. Same pattern as petrol.

**SplitBillModal** — ships but intentionally not wired (avoids two competing split UIs). Revisit when per-guest flow needs server-side persistence.

### Admin portal — Phase 5

`deploy_mode` selector on branch-create · `devices` table + registration on provision · fleet + billing reconciliation views. Ties to D4/D5 (provision = register).

### Phase 6 — Desktop tech panel

Backend largely exists. Key combo → tech PIN → one-time HMAC secret (signed tier per D7). Tiers: `diagnostics` (already served), `install`, `mode_switch`. Out of scope by design: sales/revenue data, price/product/staff edits, raw SQL.

### Phase 7 — Local-server runtime (large, own design pass)

Existing server codebase → local Postgres. Audit Supabase coupling first (Auth, storage have no offline equivalent). LAN discovery. Retention (D10). Mandatory backup for single-machine installs.

---

## 8. What is PENDING — External dependencies

Both are **built complete to the edge of the dependency** and inert until credentials are set.

**KRA eTIMS** *(legally load-bearing — KES 1,000,000 penalty for non-compliance)*
- Built: migration 08, `lib/etims/` abstraction layer, non-blocking order-flow wiring, AES-256-GCM encryption, retry job, routes, dashboard.
- Gap: exact KRA wire-payload field mapping in `provider.ts` marked `VERIFY` — not confirmed against live sandbox. `ETIMS_PROVIDER=none` keeps it inert.
- Your side: KRA sandbox access → verify enums/QR → flip `ETIMS_PROVIDER`. Set `APP_ENCRYPTION_KEY`. Decision locked: VSCU mode, start against a certified integrator behind the abstraction layer.

**WhatsApp receipts**
- Built: `lib/whatsapp.ts` (Meta Cloud API / Twilio adapters), order endpoint, PaymentModal send button, delivery logging.
- Your side: provision Meta Cloud API (app + approved template) or Twilio → set env vars → verify template.

### Environment variables for go-live

| Var | For | Default if unset |
|-----|-----|------------------|
| `APP_ENCRYPTION_KEY` | eTIMS secret encryption (32 bytes) | encrypt fails closed |
| `ETIMS_PROVIDER` | `none` / `vscu` / `integrator` | `none` (inert) |
| `ETIMS_BASE_URL`, `ETIMS_*` | eTIMS endpoint / auth / QR | — |
| `WHATSAPP_PROVIDER` | `none` / `cloud` / `twilio` | `none` (inert) |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID` | Meta Cloud API | — |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM` | Twilio | — |
| `ETIMS_RETRY_CRON` | retry cadence | `*/15 * * * *` |

---

## 9. Database — current state

**All migrations 01–12 are applied to the live Supabase DB.** No outstanding migrations.

Key additions by migration number:
- 08 — eTIMS (`etims_branch_config`, `etims_invoices`, `products.tax_type`, `products.kra_item_class_code`)
- 09 — Customer credit (`credit_limit`, `credit_balance`, `customer_credit_transactions`, `apply_credit_transaction()` RPC)
- 10 — Denomination breakdown (`shifts.denomination_breakdown`, `cash_denominations` seeds)
- 11 — Restaurant dine-in (`order_items.course`, `fire_status`, `fired_at`, `sub_bill`; `orders.seated_at`)
- 12 — Tips + WhatsApp (`orders.tip_amount`, `whatsapp_deliveries`, `tip_settings`, `whatsapp_settings` seeds)

---

## 10. Known gaps & tech debt

- **No true partial refund** — void-whole-order within 30 min only (§7).
- **Desktop barcode scanner** — not wired in `POSPage.tsx`.
- **Desktop expense entry** — table + sync present, no ShiftPanel UI.
- **Parking desktop** — `posMode` knows it, no BaysView.
- **`packages/sync` + `packages/db`** — unused placeholders; real sync is in `apps/desktop/src/main/syncEngine.ts`. Delete or consolidate.
- **Stray frontend file under `apps/server/src`** — blocks server typecheck.
- **Known correctness items** (tracked in `FIXES.md` / `dryrun/DRYRUN.md`): EAT vs UTC timezone, per-product `tax_type` in VAT extraction, `.in(orderIds)` URL-length limits on high-volume report queries.
- **Build runs on your side** — always run `pnpm build` / `tsc` before shipping; esbuild syntax-only verification was used during development.

### Testing checklist before deployment

- [ ] Full `pnpm build` / `tsc` across server, dashboard, desktop, admin.
- [ ] Shift close — petrol and restaurant — no 500, Z-report prints correctly.
- [ ] Void from desktop till — within window succeeds; outside 30 min shows clean error; cashier without permission gets 403 surfaced in modal.
- [ ] Desktop manager (PIN) → ManagerPage; cashier PIN → POSPage.
- [ ] Petrol desktop: pump grid loads, fuel order places, tank deduction fires.
- [ ] Restaurant desktop: table map loads (if tables synced), KOT prints, hold/recall works.
- [ ] Tip sale → receipt shows Total / Tip / Total Paid; VAT unaffected.
- [ ] On-account sale within limit succeeds; over-limit blocked.
- [ ] Offline sale → reconnect → exactly one server order (no duplicate).
- [ ] Desktop: access token expires offline → reconnect → sync self-heals.
- [ ] Admin portal: loads, client list, new client creation, tech token generation.

---

## 11. Deliverables — this session (zips in output folder)

| Zip | What |
|-----|------|
| `desktop-manager.zip` | NEW `ManagerPage.tsx` (petrol + restaurant + retail), manager IPC handlers, preload, posApi types, role-based routing in `App.tsx` |
| `void-and-sync.zip` | `VoidModal.tsx`, order history panel in `POSPage.tsx`, `order:void` IPC + preload; shift/expense sync confirmed already complete |
| `admin-and-shiftfix.zip` | `AdminPortal.tsx` (.jsx → .tsx, SVG icons, TypeScript interfaces); `shifts.ts` shift-close 500 fix (two-step cash query, `updated_at` removed) |

---

## 12. Document map

**Canonical — keep and maintain:**

| Document | Date | Role |
|---|---|---|
| **This file** | 13 Jun | Single source of truth |
| `swiftpos-docs.zip` → `01-architecture`, `02-data-model`, `03-use-cases`, `04-dfd`, `05-process-flows` | 9 Jun | As-built system reference (Mermaid diagrams) |
| `SwiftPOS_Architecture_and_Plan.md` | 2 Jun | Deploy model + locked decisions + phased plan |
| `SwiftPOS_Desktop_Audit_and_Plan.md` | 2 Jun | Desktop audit + report-tier table |
| `SwiftPOS_eTIMS_Integration_Scope.md` | 1 Jun | eTIMS scope, decisions, data model, phases |

**Historical — superseded, safe to archive:**
`POS_Handoff_Document.docx`, `SwiftPOS_Handoff_v2`–`v5.docx`, `SwiftPOS_Handover_Document.docx`, `SwiftPOS_HANDOVER.md`, `README.md`, `SwiftPOS_README.docx`, `SwiftPOS_README2.docx`, `SwiftPOS_Session2/4/5_Handover`, `SwiftPOS_Session_Handover.docx`.

**Visual / planning artifacts (HTML & SVG) — reference, not source of truth:**
UI mockups, `onboarding_flow_map`, plans/trackers, market work, topology diagrams.

---

## 13. Data model — quick orientation

Multi-tenant: nearly every table carries `business_id`; most transactional tables also carry `branch_id`. Money is `numeric` and **VAT-inclusive**: `total = subtotal − discount_amount`; `vat_amount = total − total / (1 + vat_rate/100)`. Offline tables carry `sync_status` (`pending|synced|conflict`); `orders.idempotency_key` prevents duplicate posting on retry. A `credit` payment is **A/R** — not cash collected. Payments link to a shift only **through** `orders.shift_id` (no `shift_id` on the payments table).

Domains: **Tenancy & access** · **Catalog** · **Orders & payments** · **Inventory** · **Restaurant/fuel/parking** · **Shifts & cash** · **eTIMS** · **Printing** · **SaaS & admin** · **Integrations & infra**.

Full ER diagrams in `02-data-model.md` (in `swiftpos-docs.zip`).

---

*Findings reflect static code reads + esbuild syntax verification. Live behaviours (offline token refresh, PIN round-trip, mode-switch migration) still want a real test on the dev machine.*
