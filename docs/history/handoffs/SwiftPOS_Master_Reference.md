# SwiftPOS — Master Reference

*Single source of truth. Consolidated 12 June 2026 from the full document set.*
*Replaces the scattered handover/README files — see the Document Map (§11) for what each old file was and whether it still matters.*

SwiftPOS is a **multi-tenant, multi-vertical Point-of-Sale platform for the Kenyan market**, with cloud and offline (local) deployment, KRA eTIMS tax compliance, and M-Pesa payments. One **business** runs one or more **branches**; each branch runs a POS with vertical-specific screens.

---

## 1. Status at a glance

| Area | State |
|------|-------|
| **Web / cloud POS** | ✅ Mature and feature-rich (system of record today) |
| **Desktop main process** (sync, local DB) | ✅ Foundation fixed, forward-compatible |
| **Desktop renderer** (the POS screen) | ✗ Retail-only; far behind web — **the active workstream** |
| **KRA eTIMS** | ◐ Built to the edge of sandbox; blocked on credentials + payload verification |
| **WhatsApp receipts** | ◐ Built; blocked on provider credentials |
| **Live database** | ✅ **Verified current through migration 12** (08–12 fully applied: tables, columns, credit RPC, index, per-business seeds — checked 12 Jun against the live schema). See §9. |
| **Offline / local-server runtime** | ✗ Designed (decisions locked), not built |

> Legend used throughout: ✅ done · ◐ partial / built-to-edge · ✗ not built · ⚠️ action needed

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
| Desktop POS *(in development)* | Electron + React (local deployment) |
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
  desktop/     # Electron app (local mode) — in development
  admin/       # Admin portal (fleet, onboarding, billing)
packages/
  sync/        # ⚠️ unused placeholder ("deferred to Step 8")
  db/          # ⚠️ unused placeholder
migrations/    # SQL schema & migrations (Supabase / Postgres) — live through #11
docs/          # documentation
dryrun/        # dependency-free logic test harness
```

---

## 4. What is DONE — Web / cloud (mature)

The web app is the reference implementation and is broadly production-grade.

**Sales / POS (`CashierScreen.tsx`)** — feature-rich across all verticals: retail, minimart (barcode/PLU, weighed items, hardware-scanner listener, weight modal, quick-add), restaurant (tables, covers, KOT firing, courses, modifiers, variants), parking and petrol stubs. Hold/resume, discounts/promotions, split tender.

**Payments** — cash (with change), card, **M-Pesa STK push** (fully wired in `PaymentModal.tsx`), and store credit / A/R.

**Shifts & cash** — open/close, opening float, float in/out, expected-cash + variance with mandatory variance note, **denomination breakdown** (per-business configurable, Kenyan default), quick-tender presets.

**Inventory & purchasing** — stock levels/movements/adjustments, suppliers, POs → GRN, branch transfers, ingredients/recipes (BOM) for food-cost.

**Customers** — loyalty points/transactions and **store credit accounts** (credit limit + balance, atomic `apply_credit_transaction()` RPC that enforces the limit, debtor list, repayments, adjustments; "On Account" payment method).

**Reporting** — sales/products/hourly/tax/inventory/EOD/shifts/voids/food-cost/fuel/wet-stock, plus a Posist-style **Master DSR** and spreadsheet export.

**Admin portal** — New Client creation (creates Supabase auth user → business → main branch → seeds owner/manager/cashier roles → owner user → branch link → onboarding record → 30-day trial). Onboarding flow.

**RBAC** — `requirePermission(...)` guards **44 routes**; per-user permission overrides; manager-vs-owner separation (managers are full branch operators, business-wide config stays owner-only).

### Recent session additions (all in the web app)

| Feature | State | Notes |
|---|---|---|
| Security hardening (items 1–8) | ✅ | IDOR fixes, branch authz, server-authoritative pricing, bcrypt supervisor PIN, role guards |
| KRA eTIMS fiscalisation | ◐ | Complete to the edge of sandbox — see §8 |
| Customer credit accounts | ✅ | Migration 09 applied; full backend + UI |
| Denomination counter + tender presets | ✅ | Migration 10 applied |
| Restaurant dine-in (courses, turnover, split) | ✅ | Migration 11 applied; split modal ships but is intentionally **not wired** (avoids two competing split UIs) |
| Tips | ✅ | No external dep; VAT correctly excluded from gratuity |
| WhatsApp receipts | ◐ | Built; gated on credentials — see §8 |
| Manager dashboard parity | ✅ | Credit + Turnover tabs on the PIN-auth client |

---

## 5. What is DONE — Desktop (foundation only)

The Electron **main process** was repaired and is now correct and forward-compatible:

- **Sync engine unblocked** — `syncAll()` was guarding on a stale `_token` field (it returned "Not configured" and never synced); fixed to `_accessToken`.
- **Token refresh** — refresh token captured at login, stored, threaded through all `configureSyncEngine` call sites; expired tokens self-heal on reconnect.
- **Exactly-once offline sales** — server now honours `X-Idempotency-Key` (returns the existing order instead of duplicating); client treats the duplicate/200 (and a defensive 409) as success. Key = stable local order id. (Relies on the existing `orders.idempotency_key` column — no new migration needed.)
- **Local persistence modernised** — `createLocalOrder` now writes `payments[]`, `tip_amount`, customer fields, course/`fire_status`, and a local credit-ledger row; idempotent SQLite migrations bring existing installs up to date.
- Earlier desktop work: build-error fixes, staff PIN login (owner/device session + per-shift PIN), boot drops to PIN pad on restart, staff token refresh on 401.

> The modernised writer **degrades gracefully** for features the renderer can't yet produce — nothing breaks, but the desktop can't *generate* the new payment features until the renderer is upgraded (§7, Phase 1).

---

## 6. Architecture decisions — locked (desktop / offline)

These are settled and should not be re-litigated while building.

| # | Decision |
|---|---|
| D1 | **One server codebase, two DB targets** — cloud → Supabase; offline → local Postgres on the server PC. Every fix applies to both. |
| D2 | **Offline install provisions online once**, then runs disconnected. No fully-offline business creation (keeps one source of truth + the install-fee chokepoint). |
| D3 | **Local Postgres** as the offline datastore (handles concurrent tills; reuses Postgres-shaped server code). |
| D4 | **Desktop server URL becomes runtime config**, not the compile-time `VITE_SERVER_URL`. One installer for all clients. |
| D5 | **Install/config flow = open-first-run → locked.** First setup is open (device empty); every change after is tech-token gated; factory-reset is tech-gated. |
| D6 | **Owner email login is online-only.** Offline auth = install token + locally-seeded owner credential on the local server; staff log in by PIN against the local server. |
| D7 | **Tech panel = key combo → tech PIN (identity) → one-time HMAC secret (per-visit authorization).** Secret carries a signed **permission tier** (`diagnostics` / `install` / `mode_switch`), chosen per-token at generation (least privilege). |
| D8 | **Branch mode chosen at creation; changed only via the on-site tech migration flow** (never a bare portal toggle — flipping `deploy_mode` on live data strands orders). |
| D9 | **Reporting is tiered, not gated.** Same reports, two depths: operational on-device (today/shift/branch, summary), rich analytics on web (range, slicing, cross-branch, export). |
| D10 | **Retention by role:** tills capped (rolling window); local server keeps full history; single-machine offline client keeps everything + **mandatory backup**. |
| D11 | **Bound branch is a device property**, set at install; cashier never picks branch per login. |

**Admin-portal / fleet additions implied by the above (not yet built):** expose `branches.deploy_mode` as a required choice on branch-create; a new **`devices`/`terminals` registry** (one row per installed machine, keyed to branch, with role server|till, licensing, app_version, last_seen_at); and **fleet + billing reconciliation** views (branches × 30k, online branches × 10k/yr, device inventory). Honest caveat to surface in the UI: live "is this terminal alive" only works for **online** devices; offline devices can only show `last_seen_at`.

---

## 7. What is PENDING — Desktop build plan (the active focus)

Ordered by dependency. Each phase ships independently. **Phase 0 is the keystone** — almost everything else depends on the local schema and per-table sync direction being right, and it's where a mistake is most expensive (data loss).

### Phase 0 — Foundations *(do first)*
- **0a. Runtime config + install flow** *(small, unblocks everything offline)*: new local `device_config` (SQLite) holding `deploy_mode`, `server_url`, `branch_id`, `business_type` + a lock flag; make `SERVER_URL` a runtime read (not the compile-time const); first-run `InstallPage.tsx` (open when no config) sets mode + URL + binds branch, then locks; gate `App.tsx` boot on config presence.
- **0b. Local schema + sync direction** *(medium, unblocks offline reports + cashier attribution)*: add local tables `users`, `shifts`, `float_transactions`, `expenses` (+ `pumps`, `fuel_tanks` for petrol); add `cashier_id`, `shift_id`, void columns to local `orders`. **Sync direction must be deliberate** — *pull-down, remote wins:* catalogue, users, business config; *push-up, local origin:* orders, payments, shifts, float_transactions, expenses. Wrong direction = data loss.

### Phase 1 — Desktop business-type interfaces *(large — biggest renderer effort)*
Port `deriveMode`-style branching into the renderer so the terminal renders the right UI per type (restaurant/retail/parking/petrol). Type comes from `device_config`, so it works offline. Stage one type at a time: retail works today → add restaurant tables/KOT → petrol pumps → parking. **This is effectively porting the web POS work into Electron — do it carefully, not blind.**

### Phase 2 — Offline operational reports *(moderate — highest user-visible value after Phase 0)*
Shift open/close + Z-report + cash reconciliation, EOD, receipt reprint / order recall, computed from local SQLite (possible after 0b). Tiered depth (D9). Closes the "can't reconcile a drawer offline" hole.

### Phase 3 — Permission enforcement at the till *(small–moderate)*
Desktop reads role/permissions from `verify-pin` and gates UI actions (void, refund, discount, price override → manager-only), mirroring the 44 server-enforced permissions so UX matches security. (Server already enforces.)

### Phase 4 — Refunds (server + desktop) *(moderate)*
Build a **true refund flow** on the server: partial + post-window, with stock reversal and correct reporting — distinct from the existing void-with-refund. Surface on desktop, permission-gated.

### Phase 5 — Admin portal: mode choice + device registry + fleet view *(moderate)*
`deploy_mode` selector on branch-create; `devices` table + registration on provision; fleet + billing reconciliation pages. Ties to 0a (provision = register).

### Phase 6 — Desktop tech panel *(small client work — backend largely exists)*
Key combo → tech PIN → one-time HMAC secret (signed tier per D7). Tiers: `diagnostics` (status/sync/logs — already served), `install` (bind branch, set mode + URL, printer setup/test), `mode_switch` (migration). **Out of scope by design:** sales/revenue/customer data, price/product/staff edits, raw SQL.

### Phase 7 — Local-server runtime + retention + backup *(large, least-defined — own design pass)*
Stand up the offline local server (existing codebase → local Postgres). **Audit first:** how much of `apps/server` is portable Postgres vs Supabase-platform (Auth, storage have no offline equivalent). LAN discovery (fixed IP/hostname). Retention (D10). Backup (existential for offline) — local/removable mandatory for single-machine; optional cloud backup as an upsell.

### Cross-cutting (fold into the relevant phase)
Local audit trail (who voided/discounted/opened drawer), synced up · cash-drawer kick on cash payment · customer-facing display · **eTIMS offline queue** (legally load-bearing in KE) · barcode scanning + held orders on desktop.

**Recommended sequence:** 0a → 0b → Phase 2 (highest visible value) → then 1, 3, 5 as capacity allows → Phase 7 as a dedicated heavy track → Phase 6 whenever (backend ready).

---

## 8. What is PENDING — External-dependency completion

Both are **built complete to the edge of the dependency**; they need credentials you provision, then a short verification pass.

**KRA eTIMS** *(legally load-bearing in Kenya — as of 1 Jan 2026, expenses without a compliant eTIMS invoice are disallowed; penalties up to KES 1,000,000).*
- Built: migration 08 (applied), abstraction layer `lib/etims/` (`index.ts`/`provider.ts`/`queue.ts`/`types.ts`), non-blocking order-flow wiring (fiscalise on completion, credit note on void), AES-256-GCM secret encryption, node-cron retry job, routes, and dashboard (`EtimsSettingsPage`, bulk item-code tool, product tax fields, receipt QR + fiscal block).
- **The one genuine gap:** the exact KRA wire-payload field mapping in `provider.ts` (marked `VERIFY`) is built from KRA's published OSCU/VSCU v2.0 shapes but **not yet confirmed against a live sandbox** — wrong enums = rejected invoices. `ETIMS_PROVIDER=none` keeps it inert.
- **Your side:** register for the KRA sandbox (a personal PIN works for *testing*; production fiscalises under each client's own PIN; self-integration needs KRA certification — a certified integrator is the faster production path). Decisions locked: **VSCU** mode (queue-and-transmit, tolerates offline), **start against a certified integrator** behind the abstraction layer. Then verify enums/QR and flip the provider. Set `APP_ENCRYPTION_KEY`.

**WhatsApp receipts**
- Built: `lib/whatsapp.ts` (Null / Meta Cloud API / Twilio adapters, KE phone normalisation), order endpoint, PaymentModal send button, delivery logging. Inert until `WHATSAPP_PROVIDER` is set.
- **Your side:** provision Meta Cloud API (app + business number + token + phone id + an **approved template** — receipts are business-initiated) or Twilio; set the env vars; verify the template name/params.

---

## 9. ⚠️ Immediate action items

1. ~~**Run migration 12 (tips + WhatsApp).**~~ ✅ **RESOLVED (verified 12 Jun).** Migrations 08–12 are fully applied to the live DB — confirmed by direct schema check: all introduced tables/columns present, the `apply_credit_transaction()` RPC present, the `orders(seated_at)` index present, and the per-business seeds (`cash_denominations`, `turnover_alert_minutes`, `tip_settings`, `whatsapp_settings`) present for all four businesses. **No database migrations are outstanding.**
2. **Decide on `packages/sync` + `packages/db`.** Both are unused placeholders nothing imports; the real sync logic lives in `apps/desktop/src/main/syncEngine.ts`. Recommendation: delete unless multi-app reuse is imminent (otherwise consolidate the desktop sync logic into them).
3. **Set go-live env vars** (below) before any eTIMS/WhatsApp testing — these, not the database, are the remaining blockers.

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

## 10. Known gaps & tech debt

- **Desktop renderer** is retail-only — no type interfaces, held orders, void, refund, or permission UX (§7 addresses this).
- **No true partial refund on the server** — "refund" today = void-the-whole-order inside a window (Phase 4).
- **Offline order payload missing `cashier_id` / `shift_id`** — blocks offline EOD/shift/staff reporting (fixed in Phase 0b).
- **Local SQLite missing** `users`, `shifts`, `float_transactions`, `expenses`, `recipes`, `ingredient_stock_movements`, `fuel_tanks`, `pumps`, `business_settings`, `stock_adjustments` — blocks several offline reports.
- **Build runs on your side** — `tsc` / `pnpm build` couldn't run in the authoring environment; everything was verified by static read + `esbuild` syntax transforms only. **Always run a real typecheck/build before shipping.**
- **Known correctness items** (tracked in `FIXES.md` / `dryrun/DRYRUN.md`): business-day timezone (EAT vs UTC), per-product `tax_type` in VAT extraction, `.in(orderIds)` URL-length limits on high-volume report queries, and **a stray frontend file under `apps/server/src` that blocks the server typecheck**.

### Testing checklist before deployment
- [ ] Run migration 12; confirm `orders.tip_amount` + `whatsapp_deliveries` exist.
- [ ] Full `pnpm build` / `tsc` across server, dashboard, desktop.
- [ ] Tip sale → receipt shows Total / Tip / Total Paid; `tip_amount` stored, VAT unaffected.
- [ ] On-account sale within limit succeeds; over-limit blocked; repayment reduces balance.
- [ ] Shift close with variance forces a note; denomination grid sums to closing float.
- [ ] Course-held item does NOT hit the kitchen; firing it does.
- [ ] Manager (PIN) sees Credit + Turnover tabs and can operate them for the branch.
- [ ] Desktop: offline sale → reconnect → exactly one server order (no duplicate); kill the response mid-push and confirm the retry dedupes.
- [ ] Desktop: let the access token expire offline → reconnect → sync self-heals.

---

## 11. Document map (what to keep, what is history)

**Canonical — keep and maintain these:**

| Document | Date | Role |
|---|---|---|
| **This file** | 12 Jun | Single source of truth |
| `swiftpos-docs.zip` → `01-architecture`, `02-data-model`, `03-use-cases`, `04-dfd`, `05-process-flows` | 9 Jun | "As-built" system reference (Mermaid diagrams) |
| `SwiftPOS_HANDOVER.md` / `.txt` | 1 Jun | Most recent build-status handover |
| `SwiftPOS_Architecture_and_Plan.md` | 2 Jun | Deploy model + locked decisions + phased plan |
| `SwiftPOS_Desktop_Audit_and_Plan.md` | 2 Jun | Desktop audit + phase detail + report-tier table |
| `SwiftPOS_eTIMS_Integration_Scope.md` | 1 Jun | eTIMS scope, decisions, data model, phases |

**Historical — superseded, safe to archive:**
`POS_Handoff_Document.docx`, `SwiftPOS_Handoff_v2`–`v5.docx`, `SwiftPOS_Handover_Document.docx`, `README.md`, `SwiftPOS_README.docx`, `SwiftPOS_README2.docx`, `SwiftPOS_Session2/4/5_Handover`, `SwiftPOS_Session_Handover.docx` — overlapping older handovers, each rolled into the canonical set above.

**Visual / planning artifacts (HTML & SVG) — reference, not source of truth:**
UI mockups (`minimart_pos_full`, `minimart_pos_refined_spec`, `swiftpos_terminal_interfaces` — the 4 vertical screens), `onboarding_flow_map`, plans/trackers (`swiftpos_build_roadmap`, `swiftpos_master_plan`, `swiftpos_plan_v2`), market work (`swiftpos_global_benchmark`, `swiftpos_product_rating`), `plan/swiftpos_db_audit`, and topology diagrams (`swiftpos_offline_local_server_topology.svg`, `swiftpos_online_cloud_mode_topology.svg`, `swiftpos_universal_expansion_plan.svg`).

---

## 12. Data model — quick orientation

Multi-tenant: nearly every table carries `business_id`; most transactional tables also carry `branch_id`. Money is `numeric` and **VAT-inclusive**: `total = subtotal − discount_amount`; `vat_amount = total − total / (1 + vat_rate/100)`. Offline tables carry `sync_status` (`pending|synced|conflict`); `orders.idempotency_key` prevents duplicate posting on retry. A `credit` payment is **A/R** (increments `customers.credit_balance`, posts to `customer_credit_transactions`) — not cash collected. Payments link to a shift only **through** `orders.shift_id`.

Domains: **Tenancy & access** (`businesses`, `branches`, `users`, `roles`/`permissions`/`role_permissions`/`user_permissions`, `user_branches`, `onboarding_progress`, `business_settings`) · **Catalog** (`categories`, `products`, variants/modifiers, `combo_items`) · **Orders & payments** (`orders`, `order_items` + variants/modifiers, `payments`, `discounts`/`promotions`, `customers`, `loyalty_transactions`, `customer_credit_transactions`) · **Inventory** (`stock_levels`/`movements`/`adjustments`, suppliers, POs/GRN, transfers, `ingredients`/`recipes`/`ingredient_stock_movements`) · **Restaurant/fuel/parking** (`tables`, `kitchen_tickets`, `reservations`, `waitlist`, `pumps`, `fuel_tanks`, `parking_sessions`) · **Shifts & cash** (`shifts`, `float_transactions`, `expenses`/`expense_categories`, `clock_events`) · **eTIMS** (`etims_branch_config`, `etims_invoices`) · **Printing** (`printer_stations`, `branch_printers`, `receipt_templates`, `printer_template_assignments`) · **SaaS & admin** (`plans`, `subscriptions`, `invoices`, `usage_snapshots`, `feature_flags`, `admin_users`, `admin_audit_log`, `tech_access_tokens`, `tech_approval_flags`, `mode_switch_requests`) · **Integrations & infra** (`api_keys`, `webhooks`/`webhook_deliveries`, `whatsapp_deliveries`, `notifications`, `audit_log`, `sync_queue`, `sync_log`).

Full ER diagrams live in `02-data-model.md` (in `swiftpos-docs.zip`).

---

*Caveat carried from the source docs: findings reflect a static read of the uploaded code. Live behaviours (offline 401-refresh, PIN round-trip, mode-switch migration) were reviewed by reading, not executed — they still want a real test on the dev machine.*
