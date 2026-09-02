# SwiftPOS — Master Test Plan

**Version:** 1.0  
**Date:** August 2026  
**Author:** SwiftPOS Engineering  
**Status:** Living Document — update after each release cycle  

---

## Table of Contents

1. [Purpose & Scope](#1-purpose--scope)
2. [Testing Philosophy](#2-testing-philosophy)
3. [System Under Test — Architecture Summary](#3-system-under-test--architecture-summary)
4. [Test Environments](#4-test-environments)
5. [Authentication & Session Management](#5-authentication--session-management)
6. [Authorisation & Role-Based Access Control](#6-authorisation--role-based-access-control)
7. [Order Processing & Payment Integrity](#7-order-processing--payment-integrity)
8. [Shift & Float Management](#8-shift--float-management)
9. [Discounts, Promotions & Fraud Prevention](#9-discounts-promotions--fraud-prevention)
10. [Loyalty Program](#10-loyalty-program)
11. [Credit & Debt Management](#11-credit--debt-management)
12. [Expenses](#12-expenses)
13. [Inventory & Stock Control](#13-inventory--stock-control)
14. [Reports & Financial Data Integrity](#14-reports--financial-data-integrity)
15. [M-Pesa Integration](#15-m-pesa-integration)
16. [eTIMS / KRA Compliance](#16-etims--kra-compliance)
17. [Multi-Tenancy & Data Isolation](#17-multi-tenancy--data-isolation)
18. [Security & Data Leak Testing](#18-security--data-leak-testing)
19. [User Manipulation & Abuse Scenarios](#19-user-manipulation--abuse-scenarios)
20. [Performance & Stress Testing](#20-performance--stress-testing)
21. [Background Jobs & Notifications](#21-background-jobs--notifications)
22. [Admin Portal](#22-admin-portal)
23. [Offline / Sync Resilience](#23-offline--sync-resilience)
24. [Regression & Smoke Test Checklist](#24-regression--smoke-test-checklist)
25. [Defect Severity Matrix](#25-defect-severity-matrix)

---

## 1. Purpose & Scope

This document defines the complete test strategy for SwiftPOS, a multi-tenant, cloud-hosted Point of Sale SaaS platform serving Kenyan SMEs. It covers every subsystem from authentication to fiscal compliance, with deliberate focus on cash flow integrity, fraud vectors, data isolation, and production-grade stress conditions.

**In scope:**
- `apps/server` — Express/TypeScript API (all routes under `/api`)
- `apps/dashboard` — React/Vite web portal
- Background jobs (daily summary cron, eTIMS retry, low-stock checker)
- External integrations: Safaricom M-Pesa Daraja, KRA eTIMS, Resend/SMTP mail, Cloudinary
- Admin portal (`/api/admin`)

**Out of scope for v1 of this plan:**
- Electron desktop app (covered when Step 27+ are implemented)
- Customer-Facing Display (Step 27)
- Third-party hardware (thermal printers, cash drawers) — covered separately in a hardware test spec

---

## 2. Testing Philosophy

SwiftPOS handles real money for real businesses. The following principles are non-negotiable:

**Money is the hardest invariant.** Every test that touches an order, payment, float, or expense must verify that numbers balance — to two decimal places — before and after. A passing UI test that hides a KES 0.01 rounding drift is a failing financial test.

**Assume adversarial users.** Cashiers are not always honest. Owners are not always careful. The system must behave correctly when users lie, manipulate, repeat, replay, or omit data. Tests must simulate all of these.

**Test the boundary, not the happy path.** A correct system processes a clean KES 500 order. A robust system also handles KES 0.00, KES 9,999,999.99, split payments that don't add up, M-Pesa callbacks that arrive twice, and a shift that never gets closed.

**Multi-tenancy is sacred.** A Business A cashier must never see, touch, or affect Business B data. This must be actively tested, not assumed.

---

## 3. System Under Test — Architecture Summary

| Layer | Technology | Key Risks |
|---|---|---|
| API | Node 24, Express, TypeScript | Route auth bypass, injection, payload abuse |
| Auth | Custom JWT (15m access / 30d refresh) + Supabase JWT | Token replay, brute force, stale permissions |
| Database | Supabase (PostgreSQL) on `aws-0-eu-central-1` | Row-level isolation, concurrent writes, constraint races |
| File Storage | Cloudinary | Unauthenticated uploads, image metadata leak |
| Email | Resend + SMTP fallback | Mail spoofing, bounce handling |
| Payment | M-Pesa Daraja STK Push | Callback spoofing, double-credit, timeout mishandling |
| Fiscal | KRA eTIMS (VSCU/OSCU mode) | Failed invoice queuing, retry loops, desync |
| Rate Limiting | express-rate-limit | Key rotation bypass, shared-IP false positives |
| Jobs | node-cron (daily summary, eTIMS retry) | Missed fires, double-execution on restart |

---

## 4. Test Environments

### 4.1 Local Development
- Server: `localhost:4000`
- Dashboard: `localhost:5173`
- Supabase: dev ref `qggftvtmtzuuyjpzmpse` on `aws-0-eu-central-1.pooler.supabase.com`
- M-Pesa: Daraja sandbox, ngrok tunnel for callbacks
- eTIMS: sandbox mode (`environment: 'sandbox'`)

### 4.2 Staging / Pre-production
- Server: Render deployment pointing at prod Supabase ref `vcqoqvepeaedobxyxuid`
- Run all test suites here before merging to `main`
- Use a dedicated staging business (never real client data)

### 4.3 Test Data Conventions

| Fixture | Value |
|---|---|
| Test business owner email | `testowner@swiftpos.test` |
| Test cashier PIN | `9999` (never use in prod) |
| Test phone (M-Pesa) | `254708374149` (Safaricom sandbox) |
| Test KRA PIN | `P000000000Z` (eTIMS sandbox) |
| Beryl's data | **Never use as a test fixture** — she is on the live dev environment |

---

## 5. Authentication & Session Management

### 5.1 Login — Email + Password (Web)

| Test ID | Scenario | Expected Result |
|---|---|---|
| AUTH-001 | Valid owner credentials | 200, access token (15m TTL), refresh token (30d TTL), session_id, jti present |
| AUTH-002 | Wrong password | 401, generic error (do not reveal if email exists) |
| AUTH-003 | Non-existent email | 401, same generic error as wrong password |
| AUTH-004 | Correct credentials, account suspended | 401, clear "account suspended" message |
| AUTH-005 | Empty body `{}` | 400 validation error |
| AUTH-006 | SQL injection in email field: `' OR '1'='1` | 400 or 401, no data leak, no 500 |
| AUTH-007 | 30 failed login attempts in 15 minutes from the same IP | 429 after attempt #30, rate limiter fires |
| AUTH-008 | 31st attempt immediately after lockout | 429, `Retry-After` header present |
| AUTH-009 | Attempt #31 from a *different* IP | Should succeed (limiter is per-IP on auth routes) |
| AUTH-010 | Owner with two businesses — which business does the token represent? | Server returns the oldest business; client must handle multi-business explicitly |

### 5.2 POS Login — Email + PIN (Branch-Scoped)

| Test ID | Scenario | Expected Result |
|---|---|---|
| AUTH-011 | Valid email + PIN for cashier assigned to branch | 200, branch-scoped JWT with `branchId` set |
| AUTH-012 | Valid email + PIN for cashier NOT assigned to that branch | 403 |
| AUTH-013 | PIN brute-force: 30 attempts with wrong PIN | 429 on attempt #30 |
| AUTH-014 | Correct PIN after lockout resolves (16 minutes later) | 200 |
| AUTH-015 | Cashier whose `status` is `inactive` attempting POS login | 401 ACCOUNT_INACTIVE |
| AUTH-016 | PIN that was changed — old PIN used | 401 |
| AUTH-017 | Empty PIN (`""`) | 400 |
| AUTH-018 | PIN as whitespace (`"   "`) | 400 — must not hash whitespace as valid PIN |

### 5.3 Token Lifecycle & Refresh

| Test ID | Scenario | Expected Result |
|---|---|---|
| AUTH-019 | Access token used after 15 minutes | 401 token expired |
| AUTH-020 | Valid refresh token → new token pair | 200, new access + refresh tokens, old refresh token revoked |
| AUTH-021 | Replay of an already-rotated refresh token | 401 — jti already revoked, replay detected |
| AUTH-022 | Logout → attempt to use revoked refresh token | 401 |
| AUTH-023 | Simultaneously refreshing the same token from two devices | One succeeds, one gets 401 (rotation race) |
| AUTH-024 | Token signed with wrong JWT_SECRET | 401 |
| AUTH-025 | Token with `alg: none` (algorithm confusion) | 401 — must reject |
| AUTH-026 | Token with `alg: RS256` (key confusion) | 401 |
| AUTH-027 | Permissions changed server-side → next API call with old token | 401 PERMISSIONS_CHANGED — client must refresh |
| AUTH-028 | permissionsVersion = 0 in token (pre-migration token) | Should not be rejected on pv mismatch; expires naturally within 15m |

### 5.4 Desktop Surface Auth

| Test ID | Scenario | Expected Result |
|---|---|---|
| AUTH-029 | Desktop login returns `surface: 'desktop'` in JWT | Confirm field present |
| AUTH-030 | Desktop token used on a web-only report endpoint | 403 WEB_SURFACE_REQUIRED |
| AUTH-031 | Web token used on `GET /api/pos/branch-staff` | 403 — desktop surface only |
| AUTH-032 | Unregistered device attempting `GET /api/pos/branch-staff` | 403 not_a_node |

---

## 6. Authorisation & Role-Based Access Control

### 6.1 Permission Enforcement

| Test ID | Scenario | Expected Result |
|---|---|---|
| RBAC-001 | Cashier without `reports.view` calls `GET /api/reports/...` | 403 |
| RBAC-002 | Cashier without `expenses.manage` calls `POST /api/expenses` | 403 |
| RBAC-003 | Cashier with `expenses.view` only calls `DELETE /api/expenses/:id` | 403 |
| RBAC-004 | Owner (wildcard `*`) calls any permission-gated route | 200 |
| RBAC-005 | Staff with per-user `granted: false` override for a permission their role grants | 403 — user-level override must win |
| RBAC-006 | Staff with per-user `granted: true` for a permission not in their role | 200 — per-user grant must win |
| RBAC-007 | `requireAnyPermission` with two keys — user has second key only | 200 — any one key is sufficient |

### 6.2 Branch Scoping

| Test ID | Scenario | Expected Result |
|---|---|---|
| RBAC-008 | Cashier assigned to Branch A queries orders for Branch B | Must return 0 results or 403 |
| RBAC-009 | Manager scoped to Branch A attempts to open a shift in Branch B | 403 |
| RBAC-010 | Owner (no branch restriction) queries any branch | 200 |
| RBAC-011 | branchId in JWT vs branchId in request body — mismatch | Server uses JWT branchId; body branchId overriding branch scope must be blocked |

### 6.3 Multi-business Owner

| Test ID | Scenario | Expected Result |
|---|---|---|
| RBAC-012 | Owner with Business A token queries `/api/products` — does any Business B product appear? | Must return only Business A products |
| RBAC-013 | Owner crafts a request with Business B's ID in a field | Server must ignore client-supplied businessId and use the JWT value |

---

## 7. Order Processing & Payment Integrity

This is the highest-risk module. Every test here must verify the financial invariant: **payment legs must sum to order total within ±KES 0.01**.

### 7.1 Normal Order Flow

| Test ID | Scenario | Expected Result |
|---|---|---|
| ORD-001 | Single item, cash payment, exact change | 201, order created, stock decremented, shift cash total incremented |
| ORD-002 | Multiple items, partial cash + partial M-Pesa | 201, payment legs stored, each method recorded separately |
| ORD-003 | Order with modifier (+KES 50 cheese) | Total = base price + modifier cost |
| ORD-004 | Order with variant (Large vs Small) | Variant price used, not base price |
| ORD-005 | Order with combo | Combo price used, individual item prices ignored |
| ORD-006 | Order with loyalty points redemption | Points deducted, order total reduced accordingly |
| ORD-007 | Order assigned to a table | Table status updated, order linked |
| ORD-008 | Order with credit payment (customer on credit) | Customer `credit_balance` incremented, credit ledger entry created |
| ORD-009 | Order with VAT-inclusive pricing | Tax amount computed correctly via `orderTax()` |

### 7.2 Payment Integrity — The Critical Invariant

The codebase flags this explicitly (audit H1): payment legs are currently logged but not rejected on mismatch. These tests verify both the logging and validate that enforcement is the correct next step.

| Test ID | Scenario | Expected Result |
|---|---|---|
| ORD-010 | Payment legs sum to KES 500, order total = KES 500 | No `[payment-mismatch]` log line |
| ORD-011 | Payment legs sum to KES 490, order total = KES 500 (KES 10 short) | `[payment-mismatch]` logged; currently accepted — flag for enforcement |
| ORD-012 | Payment legs sum to KES 510, order total = KES 500 (KES 10 over) | `[payment-mismatch]` logged; currently accepted |
| ORD-013 | Zero payment legs submitted with a non-zero order total | Log entry, no crash |
| ORD-014 | Negative payment leg amount | Should be rejected — validate this is caught |
| ORD-015 | Floating point edge: KES 33.33 × 3 items (99.99 vs 100.00) | System uses `round2()` — result must be consistent |

### 7.3 Refunds & Credit Notes

| Test ID | Scenario | Expected Result |
|---|---|---|
| ORD-016 | Full refund on a completed order | Credit note created, stock restored, eTIMS credit note submitted if applicable |
| ORD-017 | Partial refund (one item from a multi-item order) | Refund amount matches item + proportionate tax |
| ORD-018 | Refund on an M-Pesa order | M-Pesa reversal reference recorded; payment not re-credited automatically |
| ORD-019 | Duplicate refund on same order | Second refund must be rejected |
| ORD-020 | Refund without `orders.refund` permission | 403 |

### 7.4 Edge Cases & Abuse

| Test ID | Scenario | Expected Result |
|---|---|---|
| ORD-021 | Order with 0 items | 400 — must be rejected |
| ORD-022 | Order total = KES 0 (fully discounted) | Accepted, but stock still decremented and shift updated |
| ORD-023 | Submitting the same order twice (network retry / double tap) | Second submission must be idempotent or rejected |
| ORD-024 | Order with a product from another business (cross-tenant product_id) | 400 or 404 — product not found in this business |
| ORD-025 | Order with a deleted/inactive product | 400 — cannot sell discontinued product |
| ORD-026 | Order payload exceeding 1MB | 413 Payload Too Large |
| ORD-027 | Order without an open shift | Should be blocked if shift enforcement is active |

---

## 8. Shift & Float Management

Shifts are the daily reconciliation anchor. A broken shift means broken EOD figures.

### 8.1 Opening a Shift

| Test ID | Scenario | Expected Result |
|---|---|---|
| SHF-001 | Open shift with valid branch_id and opening_float | 201, shift record created with terminal_key |
| SHF-002 | Open second shift on the same terminal before closing first | 400 — duplicate open shift must be blocked |
| SHF-003 | Open shift with opening_float = 0 | Accepted — zero float is valid |
| SHF-004 | Open shift with negative opening_float | 400 |
| SHF-005 | Open shift with opening_float = KES 1,000,000 | Accepted (no ceiling enforced); flag for business logic review |
| SHF-006 | Open shift on a branch the cashier is not assigned to | 403 |
| SHF-007 | Two terminals open shifts simultaneously on the same branch | Both should succeed — different terminal_keys |

### 8.2 Terminal Key Integrity

The terminal key concept ensures shifts follow the register, not the cashier. This is a critical invariant.

| Test ID | Scenario | Expected Result |
|---|---|---|
| SHF-008 | Cashier A opens shift on Terminal 1, then logs into Terminal 2 | `GET /api/shifts/current` on Terminal 2 returns null (different terminal_key) |
| SHF-009 | Terminal 1's shift retrieved after cashier changes to Terminal 2 | Terminal 1 shift is still open and retrievable by Terminal 1 |
| SHF-010 | `x-device-id` header spoofed to match another terminal's registered ID | Device binding check must block this |

### 8.3 Closing a Shift

| Test ID | Scenario | Expected Result |
|---|---|---|
| SHF-011 | Close shift with correct closing float | Shift closed, expected_cash computed, variance recorded |
| SHF-012 | Closing float > total cash expected | Overage recorded as positive variance |
| SHF-013 | Closing float < total cash expected | Shortage recorded as negative variance — triggers alert to manager |
| SHF-014 | Close shift that is already closed | 400 |
| SHF-015 | Close shift belonging to another cashier's terminal | Must be blocked or require manager override |
| SHF-016 | Close shift while there are unpaid credit orders | Should still close; credit balance is tracked separately |
| SHF-017 | EOD summary email triggered after shift close | Email job queued; verify content includes cash, M-Pesa, expenses, variance |

### 8.4 Float Transactions

| Test ID | Scenario | Expected Result |
|---|---|---|
| SHF-018 | Pay-in (manager adds cash to float) | Float total increases, transaction recorded |
| SHF-019 | Pay-out (petty cash removed) | Float total decreases, transaction recorded |
| SHF-020 | Pay-out that would take float negative | Warn but allow (manager decision); verify variance is visible |
| SHF-021 | Pay-in without `shifts.manage` permission | 403 |

---

## 9. Discounts, Promotions & Fraud Prevention

This section explicitly models how cashiers and managers are likely to manipulate the discount system — because they will.

### 9.1 Discount Cap Enforcement

The codebase hard-caps manual discounts at `MAX_DISCOUNT_PCT` (default 10%). This is a known interim control (code comment: "not the M4 fix").

| Test ID | Scenario | Expected Result |
|---|---|---|
| DSC-001 | Apply 5% discount on KES 1,000 order | Discount = KES 50, total = KES 950 |
| DSC-002 | Apply 10% discount (at the cap) | Discount = KES 100, allowed |
| DSC-003 | Apply 11% discount | Server clamps to 10% — total matches 10% not 11% |
| DSC-004 | Apply 100% discount (free order) | Clamped to 10% — cashier cannot zero out a sale via manual discount |
| DSC-005 | Apply discount + promo code simultaneously | Combined discount must still not exceed MAX_DISCOUNT_PCT |
| DSC-006 | Apply discount of KES 600 on a KES 500 order (fixed > total) | Clamped to KES 500 max, total = KES 0 |

### 9.2 Promo Code Abuse

| Test ID | Scenario | Expected Result |
|---|---|---|
| DSC-007 | Valid promo code, within max_uses | Applied, used_count incremented |
| DSC-008 | Promo code at max_uses — one more use attempted | 400 — code exhausted |
| DSC-009 | Expired promo code | 400 — expired |
| DSC-010 | Non-existent promo code | 400 |
| DSC-011 | Promo code with `min_order_value = KES 500` applied to KES 400 order | 400 — minimum not met |
| DSC-012 | Same promo code on two orders concurrently (race condition) | Used_count must not exceed max_uses; check for atomic increment |
| DSC-013 | Promo code with `status: inactive` | 400 |

### 9.3 Cashier Manipulation Scenarios

These are the realistic scenarios a cashier will attempt to extract value fraudulently.

| Test ID | Fraud Vector | What to Verify |
|---|---|---|
| DSC-014 | Cashier creates a new promo code (should require `discounts.manage`) | 403 if cashier lacks permission |
| DSC-015 | Cashier modifies an existing discount's value via direct API call | Permission check fires; 403 |
| DSC-016 | Cashier tries to increase MAX_DISCOUNT_PCT via env spoofing | Not possible via API — env-only; document that `MAX_DISCOUNT_PCT` must not be user-configurable |
| DSC-017 | Cashier opens two browser tabs and applies discount twice on same order | Order is immutable after creation; second application must fail |
| DSC-018 | Cashier voids an order and re-rings it with a higher discount | Both orders visible in audit log; net cash must balance |

---

## 10. Loyalty Program

### 10.1 Points Accrual

| Test ID | Scenario | Expected Result |
|---|---|---|
| LOY-001 | Order completed for a loyalty customer (Bronze tier, 1× multiplier) | Points awarded = `floor(order_total × 1.0)` |
| LOY-002 | Order completed for Silver tier customer (1.5× multiplier) | Points awarded = `floor(order_total × 1.5)` |
| LOY-003 | Order completed for Gold tier customer (2× multiplier) | Points awarded = `floor(order_total × 2.0)` |
| LOY-004 | Points after an order take customer from Bronze to Silver (999→1000) | Tier upgrades on next loyalty lookup |
| LOY-005 | Points on a fully discounted (KES 0) order | 0 points — no reward for free order |
| LOY-006 | Points on a refunded order | Points must be reversed |

### 10.2 Points Redemption

| Test ID | Scenario | Expected Result |
|---|---|---|
| LOY-007 | Redeem 100 points for KES 10 discount on KES 200 order | Order total = KES 190, customer points -= 100 |
| LOY-008 | Redeem more points than customer has | 400 |
| LOY-009 | Redeem points on an order that is later voided | Points restored to customer |
| LOY-010 | Two cashiers redeem points for the same customer concurrently | Race condition — points must not go below 0 |

### 10.3 Feature Flag Gating

| Test ID | Scenario | Expected Result |
|---|---|---|
| LOY-011 | Loyalty disabled (`loyalty_enabled = false`) — cashier calls `GET /api/loyalty/...` | 403 — loyalty not enabled |
| LOY-012 | Loyalty re-enabled after being disabled | All existing customer points preserved |
| LOY-013 | Non-loyalty routes (customer create/list) work when loyalty is off | 200 — these are not gated |

---

## 11. Credit & Debt Management

### 11.1 Credit Limit Enforcement

| Test ID | Scenario | Expected Result |
|---|---|---|
| CRD-001 | Customer with `credit_limit = 5000`, `credit_balance = 0` — sale on credit of KES 3,000 | Accepted, balance = 3000 |
| CRD-002 | Same customer — second credit sale of KES 3,000 (would take balance to 6,000 > limit) | 400 — credit limit exceeded |
| CRD-003 | Customer with `credit_limit = 0` attempts credit order | 400 — no credit facility |
| CRD-004 | Credit payment on order with no customer attached | 400 — credit requires a customer record |

### 11.2 Repayment & Ledger

| Test ID | Scenario | Expected Result |
|---|---|---|
| CRD-005 | Record full repayment | `credit_balance` returns to 0, ledger entry created with `type: repayment` |
| CRD-006 | Record partial repayment | Balance reduced by repayment amount, ledger entry created |
| CRD-007 | Repayment greater than balance | 400 — cannot overpay (or accept and track credit balance as positive — define expected behaviour) |
| CRD-008 | Ledger history shows correct running balance_after for each transaction | Each row's `balance_after` = previous `balance_after` ± amount |
| CRD-009 | Two cashiers record repayment from same customer simultaneously | Balance must be consistent (no double-decrement) |

### 11.3 Reporting

| Test ID | Scenario | Expected Result |
|---|---|---|
| CRD-010 | Debtors list (`GET /api/credit/customers`) sorted by balance descending | Customer with highest balance appears first |
| CRD-011 | Debtors list filtered by name search | Case-insensitive, partial match works |
| CRD-012 | Customer with `credit_balance = 0` and `credit_limit = 0` does not appear in debtors list | Not in list |

---

## 12. Expenses

### 12.1 Categories

| Test ID | Scenario | Expected Result |
|---|---|---|
| EXP-001 | Create expense category | 201, name stored trimmed |
| EXP-002 | Create category with duplicate name | Should reject with unique constraint error or merge — define expected behaviour |
| EXP-003 | Create category with empty name | 400 |
| EXP-004 | List categories — returns only this business's categories | No cross-tenant leak |
| EXP-005 | Delete category with existing expenses linked | Should fail with FK error or cascade — define expected behaviour |

### 12.2 Expense Records

| Test ID | Scenario | Expected Result |
|---|---|---|
| EXP-006 | Record expense with valid category, branch, amount | 201, linked to current shift if provided |
| EXP-007 | Record expense with `shift_id` from a different branch | 400 or 403 |
| EXP-008 | Record expense with negative amount | 400 |
| EXP-009 | Record expense with zero amount | 400 or accept — define expected behaviour |
| EXP-010 | Record expense without `expenses.manage` permission | 403 |
| EXP-011 | View expenses without `expenses.view` permission | 403 |
| EXP-012 | EOD Z-report includes expenses for the day | Expense totals appear in report, deducted from net revenue |

### 12.3 Date Range Filtering

| Test ID | Scenario | Expected Result |
|---|---|---|
| EXP-013 | Query expenses for today only | Only today's expenses returned |
| EXP-014 | Query with `from` after `to` | 400 — invalid date range |
| EXP-015 | Query expenses across a midnight boundary (e.g. 23:00 to 01:00 next day) | Both sides included correctly using EAT (+03:00) timezone |

---

## 13. Inventory & Stock Control

### 13.1 Stock Decrements on Order

| Test ID | Scenario | Expected Result |
|---|---|---|
| STK-001 | Order containing Product A (stock = 10) | Stock becomes 9 after order |
| STK-002 | Order containing a recipe-based product | Ingredient stock decremented proportionally |
| STK-003 | Order for a product with `track_stock = false` | No decrement, no constraint |
| STK-004 | Order for a product at stock = 1 | Order accepted, stock = 0, low-stock alert queued |
| STK-005 | Order for a product at stock = 0 (out of stock) | Should be blocked if out-of-stock enforcement is active |
| STK-006 | Two simultaneous orders for the last unit of stock | One succeeds, one gets stock-out error or both accepted (race) — define expected behaviour |

### 13.2 Manual Stock Adjustment

| Test ID | Scenario | Expected Result |
|---|---|---|
| STK-007 | Manager adds 50 units via stock adjustment | Stock increases, adjustment recorded with reason |
| STK-008 | Stock adjustment without `stock.manage` permission | 403 |
| STK-009 | Adjustment to negative quantity | 400 |
| STK-010 | Stock adjustment recorded in audit log | Audit entry present with user_id, timestamp, and delta |

### 13.3 Low-Stock Notifications

| Test ID | Scenario | Expected Result |
|---|---|---|
| STK-011 | Product drops below low-stock threshold | Notification queued for manager |
| STK-012 | Same product triggers low-stock on consecutive orders | Only one notification per threshold crossing (not per order) |
| STK-013 | Low-stock threshold = 0 (feature disabled) | No notifications sent |

---

## 14. Reports & Financial Data Integrity

Reports are the source of truth for the business owner. Errors here are directly business-damaging.

### 14.1 Daily Sales Report (DSR)

| Test ID | Scenario | Expected Result |
|---|---|---|
| RPT-001 | DSR for a day with 10 orders | Total revenue = sum of all order totals |
| RPT-002 | DSR includes refunded orders | Refunds appear as negative, net revenue = gross − refunds |
| RPT-003 | DSR with mixed payment methods | Cash, M-Pesa, credit totals broken out separately |
| RPT-004 | DSR for a date with zero orders | Returns zeros, not an error |
| RPT-005 | DSR for a branch that is not the user's branch (branch-scoped cashier) | 403 or filtered to own branch only |
| RPT-006 | DSR date filter crossing midnight in EAT (+03:00) | Orders at 23:30 and 00:30 on the same local day must both appear |
| RPT-007 | DSR accessed by a cashier without `reports.view` | 403 |
| RPT-008 | DSR accessed with a desktop surface token | 403 WEB_SURFACE_REQUIRED |

### 14.2 EOD Z-Report

| Test ID | Scenario | Expected Result |
|---|---|---|
| RPT-009 | Z-report = gross sales − discounts − refunds − expenses | All four components present and mathematically consistent |
| RPT-010 | Z-report with expenses from multiple categories | Each category subtotalled separately |
| RPT-011 | Z-report without a closed shift | Behaviour must be defined — should it work or require a closed shift? |

### 14.3 Tax Report (VAT)

| Test ID | Scenario | Expected Result |
|---|---|---|
| RPT-012 | VAT-inclusive item: `price = KES 115`, tax rate = 15% | Tax component = KES 15, net = KES 100 (`keptFraction()` logic) |
| RPT-013 | Mix of taxable and non-taxable items | Non-taxable items do not inflate VAT total |
| RPT-014 | Report with zero-rated items | Tax = 0 on those items |

### 14.4 Export

| Test ID | Scenario | Expected Result |
|---|---|---|
| RPT-015 | Export report as Excel | Valid `.xlsx` file generated, all columns present |
| RPT-016 | Export with 10,000+ order rows | File generated without timeout or memory crash |
| RPT-017 | Export endpoint accessed without auth | 401 |

---

## 15. M-Pesa Integration

### 15.1 STK Push Flow

| Test ID | Scenario | Expected Result |
|---|---|---|
| MPE-001 | Valid STK push request (phone + amount) | Request forwarded to Daraja, `CheckoutRequestID` stored |
| MPE-002 | Invalid phone number format | 400 |
| MPE-003 | Amount = 0 | 400 |
| MPE-004 | Daraja returns error (e.g. invalid shortcode) | 502 with Daraja error forwarded; no crash |
| MPE-005 | M-Pesa not configured for this business | 400 — config missing |
| MPE-006 | Encrypted consumer_key/secret decryption failure | 500, error logged, no credential leak in response |

### 15.2 Callback Handling

| Test ID | Scenario | Expected Result |
|---|---|---|
| MPE-007 | Daraja sends success callback | Payment marked complete, order finalised |
| MPE-008 | Daraja sends failure callback (insufficient funds) | Payment marked failed, order remains pending |
| MPE-009 | Same callback delivered twice (Daraja retries) | Idempotent — second delivery has no effect (no double-credit) |
| MPE-010 | Callback from an IP not in the Daraja allowlist | Rejected |
| MPE-011 | Callback body with missing `Body.stkCallback` field | 400, no crash |
| MPE-012 | Callback body tampered with (different amount) | Server must use the `Amount` from the Daraja callback, not the original request — verify these are cross-checked |

### 15.3 Status Polling

| Test ID | Scenario | Expected Result |
|---|---|---|
| MPE-013 | Poll status for a pending payment | Returns `status: pending` |
| MPE-014 | Poll status after success callback received | Returns `status: completed` |
| MPE-015 | Poll status with an unknown `checkoutId` | 404 |
| MPE-016 | Poll status for a payment from another business | 403 |
| MPE-017 | Payment never confirmed after 5 minutes | Should be marked as timed-out; cashier must be able to retry or cancel |

---

## 16. eTIMS / KRA Compliance

eTIMS failures are regulatory non-compliance events, not just bugs.

### 16.1 Configuration

| Test ID | Scenario | Expected Result |
|---|---|---|
| ETM-001 | Enable eTIMS for a branch | Config saved, `etims_enabled` flag set |
| ETM-002 | Set environment to invalid value | 400 — only `sandbox` or `production` |
| ETM-003 | Set mode to invalid value | 400 — only `vscu` or `oscu` |
| ETM-004 | Access eTIMS config without `etims.manage` or `settings.manage` | 403 |
| ETM-005 | `cmc_key` must never appear in any API response | Verify all config endpoints strip `cmc_key` |

### 16.2 Invoice Submission

| Test ID | Scenario | Expected Result |
|---|---|---|
| ETM-006 | Order created with eTIMS enabled | `fiscaliseInvoice()` called, invoice submitted to KRA |
| ETM-007 | KRA returns success | Invoice marked `submitted`, response stored |
| ETM-008 | KRA returns error (e.g. invalid PIN) | Invoice queued for retry, order still created |
| ETM-009 | KRA is unreachable (network timeout) | Invoice queued for retry, no order failure |
| ETM-010 | Retry job processes queued invoices | Outstanding invoices resubmitted in correct order |
| ETM-011 | Credit note (refund) submitted to KRA | Credit note format correct, linked to original invoice |

### 16.3 Retry Queue

| Test ID | Scenario | Expected Result |
|---|---|---|
| ETM-012 | Invoice fails 3× — what happens on the 4th retry? | Define max retry count and backoff policy |
| ETM-013 | Server restarts while invoices are queued | Queue persists (Supabase-backed), retry job resumes on startup |
| ETM-014 | `processPending()` called while a previous run is in progress | Must not double-process — idempotency guard needed |

---

## 17. Multi-Tenancy & Data Isolation

This is a catastrophic failure class. Business A must never see Business B's data.

| Test ID | Scenario | Expected Result |
|---|---|---|
| TENANT-001 | Business A token used to call `GET /api/products` | Returns only Business A products |
| TENANT-002 | Business A token with Business B's product_id in an order | 404 — product not found |
| TENANT-003 | Business A token with Business B's customer_id in a loyalty lookup | 404 — customer not found |
| TENANT-004 | Business A token querying `GET /api/reports` — do Business B orders appear? | Absolutely not — verify date range queries are business-scoped |
| TENANT-005 | Business A token with Business B's staff user_id in a permission check | 403 — user not in this business |
| TENANT-006 | Admin portal modifies Business A's features — does Business B see the change? | No |
| TENANT-007 | Supabase RLS — direct DB query without JWT | Must be blocked at the database level (RLS policies) |
| TENANT-008 | Two businesses with identically named products — no ID collision | UUIDs must remain distinct; name uniqueness is per-business |

---

## 18. Security & Data Leak Testing

### 18.1 Injection Attacks

| Test ID | Scenario | Expected Result |
|---|---|---|
| SEC-001 | SQL injection via query param: `?from=2024-01-01'; DROP TABLE orders; --` | Input sanitised, no query executed, 400 or safe response |
| SEC-002 | NoSQL injection via JSON body: `{ "name": { "$gt": "" } }` | Zod schema rejects non-string where string expected |
| SEC-003 | Prototype pollution: `{ "__proto__": { "isOwner": true } }` | Body parsed safely; `req.isOwner` derived from JWT only, not body |
| SEC-004 | Path traversal in a file param: `../../etc/passwd` | 400, no file served |
| SEC-005 | XSS payload in product name: `<script>alert(1)</script>` | Stored as literal text, rendered escaped in UI — verify no HTML injection |

### 18.2 Header & Token Abuse

| Test ID | Scenario | Expected Result |
|---|---|---|
| SEC-006 | `x-device-id` set to another business's device ID | Device binding check blocks cross-business device use |
| SEC-007 | `Authorization: Bearer null` | 401 |
| SEC-008 | Very long Authorization header (50KB) | 431 Request Header Fields Too Large or 400 |
| SEC-009 | JWT with `isOwner: true` injected in payload, wrong secret | 401 — signature mismatch |
| SEC-010 | JWT with future `iat` (issued at in the future) | Rejected — time skew check |

### 18.3 Information Disclosure

| Test ID | Scenario | Expected Result |
|---|---|---|
| SEC-011 | `GET /health` in production | Must NOT expose `version` or `env` fields |
| SEC-012 | Any 500 error in production | Response body must be `{ "error": "Internal server error" }` only — no stack trace |
| SEC-013 | Failed login error message | Must not distinguish between "wrong password" and "email not found" |
| SEC-014 | `GET /api/pos/branch-staff` response | PIN hashes (`pin_hash`, `override_pin_hash`) must be present (needed for offline auth) but must NEVER be logged or forwarded to non-desktop surfaces |
| SEC-015 | Product image URL — is it publicly guessable? | Cloudinary signed URLs or obfuscated paths; direct access without auth should not expose business data |
| SEC-016 | Error response for a valid resource from the wrong business | Must return 404 (not 403) — 403 confirms the resource exists |

### 18.4 CORS & Origin Validation

| Test ID | Scenario | Expected Result |
|---|---|---|
| SEC-017 | Request from `https://evil.com` | CORS rejection — `Origin not allowed` |
| SEC-018 | Request with no `Origin` header (Electron / curl) | Allowed — `if (!origin) return callback(null, true)` |
| SEC-019 | Request from a new legitimate origin not in `CORS_ORIGINS` env | Rejected — operator must update env to add new origins |

### 18.5 Rate Limiting Bypass Attempts

| Test ID | Scenario | Expected Result |
|---|---|---|
| SEC-020 | Auth brute force with X-Forwarded-For header spoofing | Auth limiter uses `req.ip` (trust proxy is set for prod) — spoofed header must not bypass |
| SEC-021 | API limiter bypass by rotating `x-device-id` on each request | Each unique device ID gets its own bucket — this is intentional; test that an attacker cannot exhaust a real device's quota by forging its ID |
| SEC-022 | 600+ requests/minute from a single device | 429 after the 600th request in that window |

---

## 19. User Manipulation & Abuse Scenarios

These are real-world attacks from users who know the system. Modelled on common POS fraud patterns in Kenya's SME sector.

### 19.1 Cashier Fraud Vectors

| Abuse Scenario | What to Test | Detection / Prevention |
|---|---|---|
| **Void-and-pocket** — cashier voids a completed order after taking cash | Void requires permission; void creates audit trail; shift cash does not decrease without supervisor approval | `orders.void` permission required; audit log entry mandatory |
| **Discount fishing** — cashier applies 10% discount to every order for family/friends | Discount cap enforced at 10%; all discounts visible in DSR with cashier ID | Report shows cashier-level discount totals |
| **No-sale button abuse** — open cash drawer without a transaction | Float transaction required for any drawer open event; no-sale logged | Every drawer open recorded |
| **Short-change without record** — cashier quotes wrong price verbally | Price is on the receipt; POS total is the system's truth | Receipt printed before cash exchanged |
| **Under-ringing** — cashier enters lower quantity than sold | Inventory will not match count; low-stock alert will fire early | Physical stock count vs system count |
| **Phantom refund** — cashier refunds an order that the customer did not request | Refund requires permission; refund must be visible in report; customer credit created | Refund report shows cashier ID |
| **Promo code self-issue** — cashier creates promo code and uses it on their own orders | `discounts.manage` required to create; all promo code usage logged with cashier ID | Audit log, report |
| **Loyalty self-award** — cashier adds loyalty points to own/friends' accounts | Points only awarded on completed orders; no manual point add without `loyalty.manage` | Audit trail on point transactions |
| **Split payment manipulation** — submit M-Pesa reference for cash sale, pocket cash | M-Pesa reference requires a valid transaction ID format; callback confirmation must match | M-Pesa reference validated; callback reconciliation |
| **Clock manipulation** — change device time to affect shift dates | Server timestamps used, not client timestamps | All timestamps from `Date.now()` server-side |

### 19.2 Manager / Owner Fraud Vectors

| Abuse Scenario | What to Test |
|---|---|
| **Ghost employee** — create a staff account, assign it to themselves for bonus/commission | Staff creation logged; all user accounts require a verified email |
| **Expense inflation** — record personal expenses as business expenses | Expense categories must require receipts (future feature); all expenses visible to owner in report |
| **Credit forgiveness** — write off a relative's credit balance without proper authorisation | Credit write-off must require explicit permission and reason code; write-off visible in ledger |
| **Report suppression** — manager tries to delete orders from a bad shift | Orders must be immutable after creation; only voids (which leave a trail) allowed |

---

## 20. Performance & Stress Testing

### 20.1 Load Profiles

Define three realistic load tiers based on SwiftPOS's target SME market:

| Profile | Concurrent Users | Orders/Hour | Notes |
|---|---|---|---|
| **Small shop** | 2–3 cashiers | ~50 | Single branch |
| **Medium retail** | 10–15 cashiers | ~300 | 2–3 branches |
| **Busy restaurant (peak)** | 20–30 cashiers | ~600 | Kitchen display active |

### 20.2 API Performance Baselines

| Endpoint | Target p95 | Target p99 |
|---|---|---|
| `POST /api/orders` | < 400ms | < 800ms |
| `GET /api/pos/init` | < 300ms | < 600ms |
| `POST /api/auth/login` | < 500ms | < 1000ms |
| `GET /api/reports/daily` (1 day) | < 1000ms | < 2000ms |
| `GET /api/reports/export` (30 days, Excel) | < 5000ms | < 10000ms |
| `GET /health` | < 200ms | < 400ms |

### 20.3 Stress Tests

| Test ID | Scenario | Success Criteria |
|---|---|---|
| PERF-001 | 30 concurrent order submissions (restaurant peak) | All 30 complete with correct stock decrements; no race conditions; no 5xx |
| PERF-002 | 1,000 requests/minute sustained for 5 minutes (single IP) | Rate limiter fires at 600; 429s returned cleanly; no server crash |
| PERF-003 | Report generation for 12 months of data (~50,000 orders) | Completes without timeout; memory does not exceed 512MB |
| PERF-004 | 100 simultaneous loyalty point updates (100 customers checking out at once) | No negative point balances; all ledger entries correct |
| PERF-005 | 50 simultaneous shift opens across 5 branches | Each branch gets exactly one open shift per terminal; no duplicates |
| PERF-006 | Database connection pool exhaustion (simulate by maxing connections) | Server returns 503 gracefully; does not hang or throw unhandled exceptions |
| PERF-007 | Supabase goes offline for 60 seconds mid-operation | Server returns 503; reconnects automatically when DB is back; no data corruption |
| PERF-008 | M-Pesa callback flood (200 callbacks/second for the same CheckoutRequestID) | Only first callback processed; subsequent ones are idempotent no-ops |

### 20.4 Memory & Resource Leaks

| Test ID | Scenario | Expected Result |
|---|---|---|
| PERF-009 | Server running for 24 hours under medium load | Memory usage stable (no leak); no zombie processes |
| PERF-010 | Daily summary cron fires 100× in rapid succession (simulated) | Exactly one email per business per fire; no duplicate emails |
| PERF-011 | WebSocket connections (kitchen display) — 50 clients connected for 2 hours | All clients receive updates; server memory stable |

---

## 21. Background Jobs & Notifications

### 21.1 Daily Summary Job

| Test ID | Scenario | Expected Result |
|---|---|---|
| JOB-001 | Job fires at scheduled time | All active businesses with verified mail domains receive summary |
| JOB-002 | Business with unverified mail domain | Mail skipped; `reportMailReadiness()` logs warning at boot |
| JOB-003 | Business with no orders for the day | Summary sent with zeros — not skipped |
| JOB-004 | Server restarts at the exact moment job fires | Job does not fire twice; or if it does, email is deduplicated |
| JOB-005 | Resend API is down — SMTP fallback | Falls back to nodemailer; alert logged |

### 21.2 eTIMS Retry Job

| Test ID | Scenario | Expected Result |
|---|---|---|
| JOB-006 | Job runs with 10 pending invoices | All 10 retried in sequence |
| JOB-007 | Job runs while KRA is still down | Invoices remain queued; no crash; next run retries |
| JOB-008 | One invoice in the queue is malformed | Bad invoice logged and skipped; rest continue processing |
| JOB-009 | Server restarts during retry job | Partially retried invoices not double-submitted |

### 21.3 Low-Stock Checker

| Test ID | Scenario | Expected Result |
|---|---|---|
| JOB-010 | Stock drops below threshold mid-shift | Alert notification created and queued |
| JOB-011 | Alert already exists for this product today | No duplicate alert created |
| JOB-012 | Product with `track_stock = false` hits "zero" | No alert — stock tracking disabled |

---

## 22. Admin Portal

The admin portal (`/api/admin`) manages the entire client fleet. A breach here is catastrophic.

### 22.1 Admin Authentication

| Test ID | Scenario | Expected Result |
|---|---|---|
| ADM-001 | Valid admin credentials | Admin JWT issued (separate from business JWT) |
| ADM-002 | Business JWT used on admin route | 401 — wrong token type |
| ADM-003 | Admin JWT used on business route | 401 — wrong token type |
| ADM-004 | Admin brute force: 30 attempts | 429 |
| ADM-005 | `super_admin` vs regular `admin` — team management routes | Regular admin gets 403 on `GET /api/admin/team` |
| ADM-006 | Admin session logout | Token revoked; subsequent requests with old token → 401 |

### 22.2 Fleet & Client Management

| Test ID | Scenario | Expected Result |
|---|---|---|
| ADM-007 | Suspend a business | All business users immediately get 401 on next API call |
| ADM-008 | Activate a suspended business | Users can log in again |
| ADM-009 | Modify a feature flag for Business A | Business B's flags unchanged |
| ADM-010 | Renew a subscription | Expiry date extended, billing record created |
| ADM-011 | Admin audit log — all admin actions recorded | Every `POST/PATCH/DELETE` from admin portal appears in `admin_audit_log` |
| ADM-012 | Admin calling `GET /api/admin/fleet/stats` — does it include real business revenue? | Stats are aggregate counts only; no individual order data exposed to admin |

---

## 23. Offline / Sync Resilience

*(This section will expand significantly when Electron desktop is built in Steps 27–31.)*

### 23.1 Current Behaviour (API-only)

| Test ID | Scenario | Expected Result |
|---|---|---|
| SYNC-001 | Dashboard loses internet mid-shift | UI shows connection error; no data submitted; cashier can see last known state |
| SYNC-002 | API server returns 503 during an order submission | Client retries; does not double-submit (idempotency key or client-side guard) |
| SYNC-003 | WebSocket (kitchen display) disconnects and reconnects | Client resubscribes; missed events are replayed or clearly marked as missed |

---

## 24. Regression & Smoke Test Checklist

Run this checklist manually before every production deploy, and automate it in CI.

```
[ ] Health endpoint returns 200 and schema: 'ok'
[ ] Owner can log in via web dashboard
[ ] Cashier can log in via POS with PIN
[ ] A product can be found and added to an order
[ ] An order can be completed with cash payment
[ ] An order can be completed with M-Pesa reference
[ ] A shift can be opened and closed
[ ] EOD Z-report renders without error
[ ] Daily DSR renders for today
[ ] A customer can be created and their loyalty points displayed
[ ] An expense can be recorded
[ ] Low-stock notification fires correctly
[ ] Admin portal login works
[ ] Admin can suspend and reactivate a business
[ ] No cross-tenant data appears in any report query
[ ] eTIMS invoice submitted (sandbox) after a test order
[ ] JWT refresh works correctly
[ ] Rate limiter returns 429 after threshold
```

---

## 25. Defect Severity Matrix

| Severity | Definition | Examples | SLA |
|---|---|---|---|
| **P0 — Critical** | Data loss, money miscalculated, security breach, system down | Payment mismatch not caught; cross-tenant data leak; JWT bypass; double charge | Fix immediately, deploy within 2 hours |
| **P1 — High** | Feature completely broken for all users; compliance failure | eTIMS not submitting; shift cannot be closed; reports returning wrong totals | Fix within 24 hours |
| **P2 — Medium** | Feature degraded; workaround exists; affects some users | Export failing for large date ranges; notification not delivered; UI rendering issue | Fix within 72 hours |
| **P3 — Low** | Cosmetic issue; minor UX friction; edge case with no financial impact | Typo in error message; pagination off-by-one on a non-financial list | Fix in next sprint |

---

*This document is living and should be updated as new routes, features, and known audit findings are addressed. Key known open items from the codebase at time of writing: payment mismatch detection is logging-only (not enforcing) — see audit H1; discount approval trail is a planned future control — see audit M4; `GET /api/pos/branch-staff` PIN hash exposure is correct by design but warrants a dedicated transmission audit.*
