# User rights audit and split design

**ZapTill, 26 October 2026.** A read-only audit of every permission key, followed by a design for breaking up the keys that are too broad. No code was changed for this document. It builds on A594, which is in progress on `dev` (cash in / cash out / expenses as three keys, migration 175, POS options moved to the owner). It does not repeat A594's keys or its planned `orders.view_own` / `orders.view_all` and reprint splits.

Owner, 2026-10-26: *"implement the changes and break down any right that you feel is too big and exposes data — I feel some are too broad; some can be broken down to view and edit etc."*

## Owner summary

**In short.** Today a person's role is made of 70 rights. Most of them are already narrow. About twenty are too broad: one tick gives both "see" and "change", or shows personal data the person does not need. The worst examples:

- A cashier can page through every customer's phone number and e-mail.
- The Auditor role, which is meant to change nothing, can change cost prices.
- A cashier at a petrol station can add or delete pumps and record fuel deliveries.

This design adds **36 narrower rights**, plus one reserved for a future customer download. Nobody gains or loses anything on the day it goes live: everyone who has a broad right today gets all of its new parts automatically. After that, you remove the parts you don't want people to have, per role or per person.

**The 10 most important splits**

1. **Customer phone numbers and e-mails** (`customers.contacts`). Without it, numbers are shown masked (07•• ••• 123) everywhere: the customer list, credit accounts, orders, M-Pesa payer numbers and Analytics. Looking a customer up by typing their number still works. Personal data under the Kenya Data Protection Act 2019.
2. **Customer purchase history** (`customers.history`), split from seeing the customer.
3. **Cost prices: see vs change** (`menu.costs_edit`). Today "See cost prices" also lets people change them, so the Auditor, Storekeeper and Kitchen Manager can all change cost prices.
4. **Staff details**: phone/e-mail (`staff.contacts`), PINs (`staff.pins`), pay rates (`staff.pay`) and per-person rights (`staff.access`), each split from "Add and edit staff".
5. **Data that leaves the business**: webhooks (`settings.webhooks`) and scheduled report e-mails (`settings.report_emails`) come out of "Integrations". Either one can send every sale, with customers' details, to any address.
6. **Customer credit**, split four ways: approve a sale on account, record a repayment (`customers.credit_payment`), adjust or write off a balance (`customers.credit_adjust`), and set limits (`customers.credit_limit`). Today, who may set limits depends on the role's *name*. It becomes a right like any other.
7. **Fuel**, split three ways: pump on/off, tank deliveries (`fuel.deliveries`) and pump/tank set-up (`fuel.setup`). Today every cashier role has all three.
8. **Discounts**: set-up discounts and promo codes (`sales.discount_preset`) vs typing your own amount (`sales.discount`).
9. **Approvals**: confirming drawers, approving pay-outs and drawer expenses (`shifts.approve_payout`), and approving the removal of items already sent to the kitchen (`sales.approve_kitchen_void`).
10. **Back-office actions split from the everyday ones.** Stock: suppliers, purchase orders, reviewing counts and reorder levels. Menu: deleting items and bulk changes. Tills: viewing, approving and retiring them. Expenses: adding, changing and expense types. Suppliers: paying them. Tax rates and discount limits come out of Business settings.

**What changes for cashiers by default.** This applies to new businesses only. Existing cashier roles keep exactly what they have unless you approve the default changes in the decisions list below.

- Customers' phone numbers and e-mails are masked, and their history is hidden. Cashiers can still find a customer by typing the number, add a customer and see points.
- Set-up discounts and promo codes only. A typed discount needs a manager.
- Parking: open and close tickets, but no voids.
- Fuel: pumps on and off only. No deliveries and no pump set-up.
- From A594: no cash in, cash out or drawer expense without a manager's PIN.

**Decisions needed from you**

| # | Decision | Recommendation |
|---|---|---|
| D1 | Take customer phone numbers / e-mails and customer history off **existing** Cashier and Waiter roles (not only new businesses)? | Yes: a cashier needs to find a customer, not read the list |
| D2 | Take "Change cost prices" off existing **Auditor** roles (a correction: the role is "changes nothing") and off **Storekeeper** roles? | Yes for Auditor; Storekeeper your call (deliveries keep their own cost on receiving) |
| D3 | Webhooks and report e-mails: owner-only by default, even for General Manager roles? | Yes. Data leaving the business is the owner's decision |
| D4 | Credit limits: give the new right only to the roles that may set limits today (built-in Manager / General Manager), and keep or drop the rule that a **partner** sets limits at their own branch whatever their role? | Keep today's holders; partners by their role's right only |
| D5 | Fuel: take tank deliveries and pump set-up off **existing** cashier / fuel attendant roles? | Yes. Recording a fake delivery hides missing fuel |
| D6 | Discounts: take *typed* discounts off **existing** Cashier / Waiter roles (set-up discounts and promo codes stay)? | Your call: shops that let cashiers haggle need it |
| D7 | Partners of some branches: should they see customers who never bought at their branches? Customers are business-wide records today | No: show a partner only the customers seen at their branches (needs a customer-branch link, see F11) |
| D8 | Overview: stop it opening the full sales and item reports for any date range (it is meant to be today's page)? Custom roles that relied on it keep the reports through the carry-over | Yes |
| D9 | Manager's built-in defaults for new businesses (each listed in the "default change" table): no write-offs, no per-person rights, no pay rates, no retiring tills, no M-Pesa number, no editing or removing expenses | Yes |
| D10 | A594 coordination: should A594's planned `orders.view_own` replace `sales.history_all`? | Let A594 decide; this design assumes its names |

**The owner's answers (27 October 2026)** — built as A595 (section 7):

| # | Answer | Where it is |
|---|---|---|
| D1 | **No.** Cashiers and waiters keep customers' phone numbers, e-mails and history. They add customers, with the KRA PIN. | Migration 177 gives the built-in Cashier and Waiter roles "Add and edit customers"; `customers.kra_pin` (a letter, 9 digits, a letter), masked without `customers.contacts` |
| D2 | **Yes**, for the Auditor and the Storekeeper. | 177; new-business defaults |
| D3 | Webhooks: the **owner** alone. Report e-mails: the **owner and partners** choose the recipients, never a manager by role; the e-mails go out once a recipient is set (daily report, stock alerts). | 177 takes both rights off every role but the owner's; `routes/business.ts mayReportEmails`; `jobs/dailySummary.ts`, `jobs/lowStockChecker.ts` |
| D4 | The approved design: the owner's **maximum** limit, **locked** limits, **credit per branch**, **partners** deciding at their own branches (the owner's switch), a **limit per branch**, checked at the sale (owed here), every change audited. | Migration 178; `lib/branchCredit.ts`, `routes/credit.ts`, `routes/orders.ts`, `routes/pos.ts`; desktop `main/creditSale.ts` (offline) |
| D5 | **Yes.** | 177 |
| D6 | **Yes**, for cashiers (the waiter keeps typed discounts). | 177; new-business Cashier default |
| D7 | **No change**: customers stay business-wide. | — |
| D8 | **Yes.** | `routes/reports.ts`; 177 gives roles that had only Overview the Sales and Item reports |
| D9 | **Yes, new businesses only.** | `shared/permissions.ts` (`manager` flags) |
| D10 | **As is**: `sales.history_all` stays. | — |

## 1. How this was measured

- **Catalogue**: `shared/permissions.ts` as it stands on `dev` with A594's uncommitted change: **70 fine keys** in 11 groups, 8 legacy broad keys, 13 built-in roles plus the owner's role (`'*'`).
- **Cloud**: a static scan of every route in `apps/server/src/routes` (70 files). It found **521 routes**: 87 are admin portal routes (ZapTill staff, admin sign-in, no business permission keys) and **434** are business routes. For each route it recorded:
  - the gate: `requirePermission`, `requireAnyPermission`, a router-wide `router.use(...)`, or a named gate such as `limitSetterGate` or `ownerOnlyGate`;
  - the checks inside the handler: `can(req, …)`, `holds`, `hasPermission`, `seesCosts` / `withoutCosts` / `stripCostsUnlessAllowed`, `seesDrawerFigures`, `callerMayConfirm`, `ownHistoryOnly`, `mayMoveMoney`, `seesCredit`, `req.isOwner`, and partner scoping (`branchFilter`, `allBranchAccess`).

  After that, every risky route named in the findings was read by hand, and a few scanner misreads were corrected (listed under the mapping table). **575 key-to-route links** came out of it.
- **Desktop POS**: every IPC channel in `apps/desktop/src/main`. There are **260 channels** and **85** of them check a key (`requireKey`, `signedInCan`, `personCan`, `personAccess.ts`, `tillGates.ts`, `ipc/shared.ts`). Screens in `apps/desktop/src/renderer` were checked too.
- **Web**: the dashboard and web POS (`apps/dashboard/src`), checked through the files that name each key. The admin portal (`apps/admin/src`) names no business keys. It only holds its copy of the catalogue.
- **Counts are a floor, not an exact figure.** A check built from a variable key, or one hidden behind a helper defined in another file, may be missed. Every key that a finding below relies on was checked in the code.

## 2. Inventory: every key and who holds it by default

Role abbreviations: Mgr = Manager, GM = General Manager, Ops = Operations Manager, Fin = Finance Manager, Acc = Accountant, Aud = Auditor, Sup = Supervisor, Csh = Cashier, Wtr = Waiter, Kit = Kitchen, KMg = Kitchen Manager, Sto = Storekeeper, Fuel = Fuel attendant.

- **Owner**: always everything (`'*'`). The owner is never refused, and the owner-only rules apply to the owner alone.
- **Kitchen, Waiter and Kitchen Manager** exist only at restaurants and cafés (A580). **Fuel attendant** exists only at petrol stations (A514).
- **"(owner only)"** means no built-in role starts with the key. General Manager holds every key, so a key marked "(owner only)" still lists GM.
- `shifts.cash_out` and `expenses.record` are A594's new keys and are not committed yet.

| # | Key | Group | Where | Label | View only | Built-in roles holding it by default |
|---|---|---|---|---|---|---|
| 1 | `orders.create` | selling | both | Sell |  | Mgr, GM, Sup, Csh, Wtr, Fuel |
| 2 | `sales.discount` | selling | both | Give discounts |  | Mgr, GM, Sup, Csh, Wtr |
| 3 | `sales.void` | selling | both | Void sales |  | Mgr, GM, Sup |
| 4 | `sales.refund` | selling | both | Refund sales |  | Mgr, GM, Sup |
| 5 | `sales.reprint` | selling | both | Reprint receipts |  | Mgr, GM, Sup |
| 6 | `sales.history_all` | selling | both | See every cashier's sales | yes | Mgr, GM, Ops, Aud, Sup |
| 7 | `invoice.create` | selling | web | Raise invoices |  | Mgr, GM, Sup, Csh |
| 8 | `shifts.cash_movements` | drawer | both | Record cash in |  | Mgr, GM, Sup |
| 9 | `shifts.cash_out` | drawer | both | Record cash out / pay-outs |  | Mgr, GM, Sup |
| 10 | `expenses.record` | drawer | both | Record expenses |  | Mgr, GM, Sup |
| 11 | `shifts.confirm` | drawer | both | Approve with their PIN |  | Mgr, GM, Fin, Sup |
| 12 | `shifts.force_close` | drawer | both | Force-close a drawer |  | Mgr, GM, Ops |
| 13 | `shifts.close_day` | drawer | both | Close the day |  | Mgr, GM, Ops, Sup |
| 14 | `shifts.close_branch` | drawer | till | Close the branch |  | Mgr, GM, Ops |
| 15 | `reports.overview` | reports | both | Overview | yes | Mgr, GM, Ops, Fin, Acc, Aud |
| 16 | `reports.sales` | reports | both | Sales reports | yes | Mgr, GM, Ops, Fin, Acc, Aud, Sup |
| 17 | `reports.items` | reports | both | Item mix and menu matrix | yes | Mgr, GM, Ops, Fin, Acc, Aud |
| 18 | `reports.staff` | reports | both | Staff performance | yes | Mgr, GM, Fin, Acc, Aud |
| 19 | `reports.shifts` | reports | both | Shift reports and Z-reports | yes | Mgr, GM, Ops, Fin, Acc, Aud, Sup |
| 20 | `reports.voids` | reports | both | Voids, refunds and exceptions | yes | Mgr, GM, Ops, Fin, Acc, Aud |
| 21 | `reports.inventory` | reports | both | Inventory report | yes | Mgr, GM, Ops, Fin, Acc, Aud, KMg, Sto |
| 22 | `reports.fuel` | reports | both | Fuel reports | yes | Mgr, GM, Ops, Fin, Acc, Aud |
| 23 | `reports.tax` | reports | web | Tax report | yes | GM, Fin, Acc, Aud |
| 24 | `reports.costs` | reports | both | Costs, margins and profit | yes | GM, Fin, Acc, Aud |
| 25 | `reports.labour` | reports | web | Labour cost | yes | GM, Fin, Acc, Aud |
| 26 | `reports.monthly_pack` | reports | both | Monthly pack | yes | GM, Fin, Acc, Aud |
| 27 | `reports.payments` | reports | web | Payment exceptions | yes | GM, Fin, Acc, Aud |
| 28 | `reports.export` | reports | both | Download reports | yes | GM, Fin, Acc, Aud |
| 29 | `orders.view_all` | orders | both | Orders, shifts and turnover pages | yes | Mgr, GM, Ops, Fin, Acc, Aud |
| 30 | `products.view` | menu | both | See the menu | yes | Mgr, GM, Ops, Aud, Sup, Csh, Wtr, Kit, KMg, Sto, Fuel |
| 31 | `menu.edit` | menu | both | Edit the menu |  | GM, Ops, KMg |
| 32 | `menu.prices` | menu | both | Change prices |  | GM, Ops |
| 33 | `menu.offers` | menu | both | Discounts and offers |  | Mgr, GM, Ops |
| 34 | `menu.promotions` | menu | web | Promotions |  | GM |
| 35 | `menu.recipes` | menu | web | Recipes and packaging |  | GM, Ops, KMg |
| 36 | `menu.costs` | menu | both | See cost prices | yes | GM, Ops, Aud, KMg, Sto |
| 37 | `inventory.view` | stock | both | See stock levels | yes | Mgr, GM, Ops, Aud, Sup, Csh, Wtr, KMg, Sto |
| 38 | `inventory.receive` | stock | both | Receive deliveries |  | Mgr, GM, Ops, KMg, Sto |
| 39 | `inventory.transfer` | stock | both | Transfer stock |  | Mgr, GM, Ops, Sto |
| 40 | `inventory.count` | stock | both | Count stock |  | Mgr, GM, Ops, KMg, Sto |
| 41 | `inventory.waste` | stock | both | Record wastage |  | Mgr, GM, Ops, KMg, Sto |
| 42 | `inventory.count_freeze` | stock | web | Stock count freeze |  | GM |
| 43 | `inventory.adjust` | stock | web | Adjust stock |  | GM, Ops |
| 44 | `ingredients.manage` | stock | web | Ingredient list |  | GM, Ops, KMg |
| 45 | `payables.manage` | stock | web | Supplier bills and payments |  | GM, Fin |
| 46 | `payables.view` | stock | web | See supplier bills | yes | GM, Fin, Acc, Aud |
| 47 | `customers.view` | customers | both | See customers | yes | Mgr, GM, Fin, Aud, Sup, Csh, Wtr |
| 48 | `customers.edit` | customers | both | Add and edit customers |  | Mgr, GM, Sup, Csh, Wtr |
| 49 | `customers.credit` | customers | both | Customer credit |  | Mgr, GM, Fin, Sup |
| 50 | `expenses.view` | expenses | both | See expenses | yes | Mgr, GM, Fin, Acc, Aud |
| 51 | `expenses.manage` | expenses | both | Record expenses |  | Mgr, GM, Fin |
| 52 | `staff.view` | staff | both | See staff | yes | Mgr, GM, Ops, Aud |
| 53 | `staff.edit` | staff | both | Add and edit staff |  | Mgr, GM, Ops |
| 54 | `staff.roles` | staff | web | Roles and permissions |  | GM |
| 55 | `reservations.manage` | front | web | Reservations and waitlist |  | Mgr, GM, Ops, Sup, Csh, Wtr |
| 56 | `parking.manage` | front | both | Parking |  | Mgr, GM, Ops, Sup, Csh |
| 57 | `fuel.manage` | front | both | Fuel pumps and tanks |  | Mgr, GM, Ops, Sup, Csh, Fuel |
| 58 | `settings.business` | settings | both | Business settings |  | GM |
| 59 | `settings.branches` | settings | web | Branches |  | GM |
| 60 | `settings.payments` | settings | both | Payment methods |  | GM |
| 61 | `settings.mpesa` | settings | till | M-Pesa number |  | Mgr, GM |
| 62 | `settings.reversals` | settings | web | Void and refund rules |  | GM |
| 63 | `settings.integrations` | settings | web | Integrations |  | GM |
| 64 | `settings.pos` | settings | web | POS options |  | GM |
| 65 | `receipt.manage` | settings | both | Receipt text |  | Mgr, GM |
| 66 | `stations.manage` | settings | both | Printers and print stations |  | Mgr, GM, Ops, KMg |
| 67 | `tables.manage` | settings | web | Tables and zones |  | Mgr, GM, Ops |
| 68 | `devices.approve` | settings | web | Tills and devices |  | Mgr, GM |
| 69 | `etims.manage` | settings | web | eTIMS / KRA |  | GM |
| 70 | `changes.approve` | settings | web | Approve till changes |  | GM, Ops |

**Rules that live outside any key** (owner-only by design, A490 / A550):

- the owner's password, account and role;
- web dashboard access for partners;
- the M-Pesa credentials;
- the sign-in-code and approval-PIN switches (A594 adds the approval PIN);
- the kitchen display key;
- void/refund rules (`settings.reversals` is the owner's by default);
- the stock-count freeze;
- the loss-alert settings;
- who approves credit sales (`/credit/approvers`);
- test e-mails;
- resetting someone's sign-in code. This is `staff.edit` plus an owner check in places.

**Partners (A550 / A582).** A partner is a staff member the owner lets into the web dashboard. A partner:

- holds exactly their role's keys plus their own overrides, the same as on the till;
- is never the owner (`req.isOwner` stays false), so every owner-only rule above refuses them;
- works at the branches on their staff record: every branch, one branch, or a set of branches ("All my branches", A582);
- in a set of branches, may only read: `requireAuth` refuses every write, and reads are narrowed by `branchFilter` / `byBranch` (81 business routes do this).

Two current exceptions read something other than keys:

1. Credit limits: a partner at their own branch may set limits whatever their role (`maySetCreditLimits`).
2. Customer records are business-wide, so a partner of one shop who holds `customers.view` sees every shop's customers (F11).

## 3. Mapping: each key to its routes, POS channels and screens

"Gate" means the route refuses without the key. "In handler" means the key changes what the answer contains, or the handler decides by it (for example, cost fields stripped, own sales only, or an approver must hold it). A route gated by several keys appears under each key, which is why the 17 report keys each count the router-wide report gate (`anyReport`, `routes/reports.ts`).

| Key | Server routes (gate + in-handler) | Server routes | Desktop IPC channels | Web screens (dashboard / web POS) | Desktop screens |
|---|---|---|---|---|---|
| `orders.create` | 7 + 0 | GET /fuel-tanks; GET /fuel-tanks/movements; GET /pumps; POST /orders; POST /orders/open; POST /orders/:id/pay; POST /orders/:id/fire-course | 1: expense:list | DashboardLayout, lib/businessTerms | - |
| `sales.discount` | 1 + 2 | POST /discounts/apply; POST /orders (in handler); POST /orders/:id/pay (in handler) | 1: order:create | pos/DiscountPanel, pos/PaymentModal | - |
| `sales.void` | 1 + 0 | POST /orders/:id/void | 1: order:void | OrdersPage, pos/POSOrderHistoryTab, settings/StaffTab | - |
| `sales.refund` | 1 + 0 | POST /orders/:id/refund | 1: order:refund | OrdersPage, pos/POSOrderHistoryTab, settings/StaffTab | - |
| `sales.reprint` | 0 + 2 | GET /orders (in handler); POST /orders/:id/whatsapp-receipt (in handler) | 1: escpos:reprintReceipt | - | - |
| `sales.history_all` | 0 + 2 | GET /orders (in handler); GET /orders/:id (in handler) | 0 | - | - |
| `invoice.create` | 0 + 0 | none (client side only) | 0 | - | - |
| `shifts.cash_movements` | 0 + 1 | POST /shifts/:id/float (in handler) | 1: expense:list | pos/CashierScreen | - |
| `shifts.cash_out` | 0 + 0 | none (client side only) | 0 | - | - |
| `expenses.record` | 0 + 0 | none (client side only) | 0 | - | - |
| `shifts.confirm` | 0 + 16 | GET /orders (in handler); GET /orders/:id (in handler); POST /orders/:id/kitchen-void (in handler); GET /reports/eod (in handler); POST /shifts/:id/foreign-cash (in handler); POST /shifts/:id/foreign-orders (in handler); POST /shifts/:id/close (in handler); POST /shifts/:id/confirm (in handler); POST /shifts/:id/manager-confirm (in handler); GET /shifts/:id/confirm-view (in handler); POST /shifts/:id/expense (in handler); GET /shifts/branch-report (in handler); GET /shifts/:id/zreport (in handler); GET /shifts (in handler); GET /shifts/:id (in handler); GET /tills-days/overview (in handler) | 7: shift:stale, manager:branchDay, manager:branchShifts, manager:remoteZReport, shift:remoteConfirmView, shift:zreport, shift:history | DashboardLayout, lib/businessTerms, lib/shiftConfirm, manager/ManagerShiftTab, pos/ZReportModal, settings/StaffTab | - |
| `shifts.force_close` | 3 + 0 | POST /shifts/:id/force-close; GET /tills-days/overview; POST /tills-days/close-drawer | 1: shift:forceClose | DashboardLayout, manager/ManagerDashboard, manager/ManagerShiftTab | - |
| `shifts.close_day` | 9 + 1 | GET /credit/sales/count; POST /day-close/instruct; GET /day-close/overview; POST /day-close/:id/cancel; POST /day-close/abandon; GET /tills-days/overview; POST /tills-days/close-day; POST /tills-days/instructions/:id/cancel; POST /tills-days/abandon; POST /shifts/:id/close (in handler) | 1: day:summary | DashboardLayout, manager/ManagerDashboard, manager/ManagerShiftTab, manager/RemoteDayClose | - |
| `shifts.close_branch` | 1 + 0 | GET /credit/sales/count | 0 | - | - |
| `reports.overview` | 17 + 0 | GET /reports/sales; GET /reports/products; GET /reports/staff; GET /reports/inventory; GET /reports/eod; GET /reports/shifts; GET /reports/master; GET /reports/hourly; GET /reports/voids; GET /reports/refunds; GET /reports/tax; GET /reports/products-v2; GET /reports/food-cost; GET /reports/splh; GET /reports/fuel-sales; GET /reports/pump-monitor; GET /reports/wet-stock | 8: manager:salesSummary, manager:topProducts, manager:recentOrders, manager:branchDay, manager:fuelSales, manager:pumpStatus, manager:tableOccupancy, manager:branchReport | DashboardLayout, manager/ManagerDashboard | - |
| `reports.sales` | 34 + 0 | GET /analytics/menu-engineering; GET /analytics/heatmap; GET /analytics/money-leaks; GET /analytics/credit-ageing; GET /analytics/overview; GET /analytics/item-times; GET /analytics/recommendations; GET /analytics/stock; GET /analytics/customers; GET /analytics/costs; GET /analytics/branches; GET /analytics/together; GET /analytics/insights; GET /orders/turnover/report; GET /reports/export/daily; GET /reports/export/hourly; GET /reports/export/sales; GET /reports/sales; GET /reports/products; GET /reports/staff; GET /reports/inventory; GET /reports/eod; GET /reports/shifts; GET /reports/master; GET /reports/hourly; GET /reports/voids; GET /reports/refunds; GET /reports/tax; GET /reports/products-v2; GET /reports/food-cost; GET /reports/splh; GET /reports/fuel-sales; GET /reports/pump-monitor; GET /reports/wet-stock | 5: day:summary, manager:salesSummary, manager:exportCsv, manager:dailyReport, manager:branchReport | DashboardLayout, manager/ManagerDashboard, manager/ManagerReportsPage, pos/POSReportsTab | - |
| `reports.items` | 18 + 0 | GET /reports/export/products; GET /reports/sales; GET /reports/products; GET /reports/staff; GET /reports/inventory; GET /reports/eod; GET /reports/shifts; GET /reports/master; GET /reports/hourly; GET /reports/voids; GET /reports/refunds; GET /reports/tax; GET /reports/products-v2; GET /reports/food-cost; GET /reports/splh; GET /reports/fuel-sales; GET /reports/pump-monitor; GET /reports/wet-stock | 2: manager:topProducts, manager:exportCsv | DashboardLayout, lib/businessTerms, manager/ManagerDashboard, manager/ManagerReportsPage | - |
| `reports.staff` | 17 + 0 | GET /reports/sales; GET /reports/products; GET /reports/staff; GET /reports/inventory; GET /reports/eod; GET /reports/shifts; GET /reports/master; GET /reports/hourly; GET /reports/voids; GET /reports/refunds; GET /reports/tax; GET /reports/products-v2; GET /reports/food-cost; GET /reports/splh; GET /reports/fuel-sales; GET /reports/pump-monitor; GET /reports/wet-stock | 0 | DashboardLayout, manager/ManagerReportsPage | - |
| `reports.shifts` | 18 + 5 | GET /reports/export/shifts; GET /reports/sales; GET /reports/products; GET /reports/staff; GET /reports/inventory; GET /reports/eod; GET /reports/shifts; GET /reports/master; GET /reports/hourly; GET /reports/voids; GET /reports/refunds; GET /reports/tax; GET /reports/products-v2; GET /reports/food-cost; GET /reports/splh; GET /reports/fuel-sales; GET /reports/pump-monitor; GET /reports/wet-stock; GET /shifts/branch-report (in handler); GET /shifts/:id/zreport (in handler); GET /shifts (in handler); GET /shifts/:id (in handler); GET /tills-days/overview (in handler) | 5: manager:branchDay, manager:branchShifts, manager:remoteZReport, shift:zreport, shift:history | DashboardLayout, manager/ManagerReportsPage, manager/ManagerShiftTab, pos/ZReportModal | - |
| `reports.voids` | 20 + 0 | GET /loss-alerts; PATCH /loss-alerts/:id/dismiss; GET /reports/export/audit; GET /reports/sales; GET /reports/products; GET /reports/staff; GET /reports/inventory; GET /reports/eod; GET /reports/shifts; GET /reports/master; GET /reports/hourly; GET /reports/voids; GET /reports/refunds; GET /reports/tax; GET /reports/products-v2; GET /reports/food-cost; GET /reports/splh; GET /reports/fuel-sales; GET /reports/pump-monitor; GET /reports/wet-stock | 0 | DashboardLayout, manager/ManagerDashboard, manager/ManagerReportsPage | - |
| `reports.inventory` | 17 + 0 | GET /reports/sales; GET /reports/products; GET /reports/staff; GET /reports/inventory; GET /reports/eod; GET /reports/shifts; GET /reports/master; GET /reports/hourly; GET /reports/voids; GET /reports/refunds; GET /reports/tax; GET /reports/products-v2; GET /reports/food-cost; GET /reports/splh; GET /reports/fuel-sales; GET /reports/pump-monitor; GET /reports/wet-stock | 0 | DashboardLayout | - |
| `reports.fuel` | 20 + 0 | GET /fuel-tanks; GET /fuel-tanks/movements; GET /pumps; GET /reports/sales; GET /reports/products; GET /reports/staff; GET /reports/inventory; GET /reports/eod; GET /reports/shifts; GET /reports/master; GET /reports/hourly; GET /reports/voids; GET /reports/refunds; GET /reports/tax; GET /reports/products-v2; GET /reports/food-cost; GET /reports/splh; GET /reports/fuel-sales; GET /reports/pump-monitor; GET /reports/wet-stock | 2: manager:fuelSales, manager:pumpStatus | DashboardLayout, manager/ManagerDashboard, manager/ManagerReportsPage | - |
| `reports.tax` | 18 + 0 | GET /etims/invoices; GET /reports/sales; GET /reports/products; GET /reports/staff; GET /reports/inventory; GET /reports/eod; GET /reports/shifts; GET /reports/master; GET /reports/hourly; GET /reports/voids; GET /reports/refunds; GET /reports/tax; GET /reports/products-v2; GET /reports/food-cost; GET /reports/splh; GET /reports/fuel-sales; GET /reports/pump-monitor; GET /reports/wet-stock | 0 | DashboardLayout | - |
| `reports.costs` | 18 + 0 | GET /reports/export/pnl; GET /reports/sales; GET /reports/products; GET /reports/staff; GET /reports/inventory; GET /reports/eod; GET /reports/shifts; GET /reports/master; GET /reports/hourly; GET /reports/voids; GET /reports/refunds; GET /reports/tax; GET /reports/products-v2; GET /reports/food-cost; GET /reports/splh; GET /reports/fuel-sales; GET /reports/pump-monitor; GET /reports/wet-stock | 0 | DashboardLayout, lib/businessTerms, manager/ManagerDashboard, manager/ManagerHistoryTab, manager/ManagerReceivingTab, pos/ZReportModal | - |
| `reports.labour` | 17 + 0 | GET /reports/sales; GET /reports/products; GET /reports/staff; GET /reports/inventory; GET /reports/eod; GET /reports/shifts; GET /reports/master; GET /reports/hourly; GET /reports/voids; GET /reports/refunds; GET /reports/tax; GET /reports/products-v2; GET /reports/food-cost; GET /reports/splh; GET /reports/fuel-sales; GET /reports/pump-monitor; GET /reports/wet-stock | 0 | DashboardLayout | - |
| `reports.monthly_pack` | 3 + 0 | GET /reports/monthly; GET /reports/monthly/export; GET /reports/monthly/movements | 0 | DashboardLayout | - |
| `reports.payments` | 1 + 0 | GET /mpesa/exceptions | 0 | DashboardLayout | - |
| `reports.export` | 8 + 0 | GET /reports/export/daily; GET /reports/export/hourly; GET /reports/export/audit; GET /reports/export/sales; GET /reports/export/products; GET /reports/export/pnl; GET /reports/export/shifts; GET /reports/export/expenses | 2: manager:exportCsv, manager:dailyReport | DashboardLayout, manager/ManagerReportsPage | - |
| `orders.view_all` | 1 + 0 | GET /orders/turnover | 6: manager:recentOrders, manager:branchOrders, manager:branchDay, manager:exportCsv, manager:tableOccupancy, manager:branchReport | DashboardLayout, lib/businessTerms, OrdersPage, manager/ManagerDashboard, pos/POSDrawer | - |
| `products.view` | 0 + 0 | none (client side only) | 0 | DashboardLayout, lib/businessTerms, manager/ManagerDashboard | - |
| `menu.edit` | 34 + 0 | POST /categories; PATCH /categories/:id; DELETE /categories/:id; POST /combos; PATCH /combos/:id; PUT /combos/:id/items; DELETE /combos/:id; POST /menus; POST /menus/reorder; PATCH /menus/:id; DELETE /menus/:id; POST /modifiers/groups; PATCH /modifiers/groups/:id; DELETE /modifiers/groups/:id; POST /modifiers/options; PATCH /modifiers/options/:id; DELETE /modifiers/options/:id; POST /products/barcodes/generate; PUT /products/barcodes/settings; PUT /products/labels/settings; POST /products; PATCH /products/:id; DELETE /products/:id; PATCH /products/bulk-tax/by-category; PATCH /products/bulk-tax/by-ids; PATCH /products/bulk-track/by-ids; POST /products/bulk; POST /variants/bulk; POST /variants/groups; PATCH /variants/groups/:id; DELETE /variants/groups/:id; POST /variants/options; PATCH /variants/options/:id; DELETE /variants/options/:id | 16: labels:setup, labels:save, labels:print, labels:numbering, manage:bulkProducts, manage:createCombo, manage:updateCombo, manage:setComboItems, manage:updateVariantGroup, manage:createVariantOption, manage:updateVariantOption, manage:deleteVariantOption, manage:createVariantGroup, manage:deleteVariantGroup, manage:createModifierGroup, manage:deleteModifierGroup | DashboardLayout, lib/businessTerms, pos/CashierScreen, products/LabelsPage | - |
| `menu.prices` | 3 + 6 | POST /branch-prices/sync; PATCH /products/:id; POST /products/bulk-price; PATCH /combos/:id (in handler); POST /modifiers/groups (in handler); POST /modifiers/options (in handler); PATCH /modifiers/options/:id (in handler); POST /products/bulk (in handler); POST /variants/bulk (in handler) | 1: manager:priceList | - | - |
| `menu.offers` | 7 + 1 | POST /discounts; PUT /discounts/:id; PATCH /discounts/:id/toggle; DELETE /discounts/:id; POST /offers; PATCH /offers/:id; DELETE /offers/:id; GET /discounts (in handler) | 3: manage:offers, manage:saveOffer, manage:deleteOffer | DashboardLayout, manager/ManagerDashboard | - |
| `menu.promotions` | 3 + 0 | POST /promotions; PATCH /promotions/:id; DELETE /promotions/:id | 0 | manager/ManagerDashboard | - |
| `menu.recipes` | 4 + 0 | POST /recipes/bulk; POST /recipes/:productId; DELETE /recipes/:productId; POST /recipes/:productId/packaging | 0 | - | - |
| `menu.costs` | 2 + 8 | PATCH /products/:id; PATCH /products/bulk-cost/by-ids; POST /products (in handler); POST /products/bulk (in handler); POST /stock/ingredients (in handler); POST /stock/ingredients/bulk (in handler); PATCH /stock/ingredients/:id (in handler); POST /stock/purchase-orders (in handler); POST /stock/grn (in handler); POST /wastage (in handler) | 2: manage:createProduct, manage:bulkProducts | lib/businessTerms, manager/ManagerDashboard, manager/ManagerHistoryTab, manager/ManagerReceivingTab | - |
| `inventory.view` | 4 + 0 | GET /inventory/movements; GET /products/labels/restocked; GET /stock/ingredients/:id/movements; GET /stock/other-branches | 4: branchStock:find, manager:stockLevels, manager:branchReport, batches:expiring | DashboardLayout, manager/ManagerDashboard, pos/POSDrawer | - |
| `inventory.receive` | 18 + 0 | GET /batches; POST /batches; PATCH /batches/:id; PATCH /inventory/:product_id/threshold; GET /payables/returns; POST /payables/returns; GET /stock/suppliers; POST /stock/suppliers; PATCH /stock/suppliers/:id; DELETE /stock/suppliers/:id; GET /stock/purchase-orders; GET /stock/purchase-orders/:id; POST /stock/purchase-orders; PATCH /stock/purchase-orders/:id; POST /stock/purchase-orders/:id/cancel; DELETE /stock/purchase-orders/:id; GET /stock/grn; POST /stock/grn | 0 | DashboardLayout, manager/ManagerDashboard, manager/ManagerReceivingTab, pos/POSInventoryTab, stock/SuppliersPage | - |
| `inventory.transfer` | 6 + 1 | GET /stock/transfers; POST /stock/transfers; PATCH /stock/transfers/:id/status; GET /stock/requests; POST /stock/requests; POST /stock/requests/:id/${step}; GET /stock/requests/count (in handler) | 7: branchStock:requests, branchStock:request, branchStock:decide, transfers:list, transfers:branches, transfers:create, transfers:status | DashboardLayout, manager/ManagerDashboard, manager/ManagerHistoryTab, manager/ManagerReceivingTab, pos/POSInventoryTab, stock/OtherBranchesPage | - |
| `inventory.count` | 6 + 0 | GET /stock-takes; POST /stock-takes; GET /stock-takes/:id; POST /stock-takes/:id/count; POST /stock-takes/:id/submit; POST /stock-takes/:id/cancel | 0 | DashboardLayout, manager/ManagerDashboard | - |
| `inventory.waste` | 4 + 0 | GET /batches; GET /wastage; GET /wastage/items; POST /wastage | 2: wastage:items, wastage:dismiss | DashboardLayout, manager/ManagerDashboard | - |
| `inventory.count_freeze` | 1 + 0 | POST /business/settings | 0 | manager/ManagerDashboard | - |
| `inventory.adjust` | 21 + 1 | GET /batches; POST /batches; PATCH /batches/:id; POST /batches/:id/close; PUT /branches/:id/stock/:productId; POST /inventory/adjust; PATCH /inventory/:product_id/threshold; POST /stock/ingredients/:id/adjust; PATCH /stock/ingredients/:id/reorder; GET /stock-takes; POST /stock-takes; GET /stock-takes/:id; POST /stock-takes/:id/count; POST /stock-takes/:id/submit; POST /stock-takes/:id/recount; POST /stock-takes/:id/post; POST /stock-takes/:id/cancel; GET /wastage; GET /wastage/items; POST /wastage; POST /wastage/:id/void; GET /pos/changes (in handler) | 0 | DashboardLayout, manager/ManagerDashboard, pos/POSInventoryTab | - |
| `ingredients.manage` | 3 + 0 | POST /stock/ingredients; POST /stock/ingredients/bulk; PATCH /stock/ingredients/:id | 0 | DashboardLayout, stock/IngredientsPage | - |
| `payables.manage` | 8 + 0 | GET /payables/summary; GET /payables/suppliers/:id; POST /payables/bills; POST /payables/bills/:id/void; POST /payables/payments; POST /payables/payments/:id/void; GET /payables/returns; POST /payables/returns | 0 | DashboardLayout, manager/ManagerDashboard, stock/SuppliersPage | - |
| `payables.view` | 3 + 1 | GET /payables/summary; GET /payables/suppliers/:id; GET /payables/returns; POST /payables/returns (in handler) | 0 | DashboardLayout, manager/ManagerDashboard, stock/SuppliersPage | - |
| `customers.view` | 7 + 4 | GET /credit/customers; GET /credit/customer/:id; GET /credit/customer/:id/history; POST /loyalty/customer; GET /loyalty/customer/:id/transactions; GET /loyalty/customer/:id/insights; GET /loyalty/customers; GET /analytics/credit-ageing (in handler); GET /analytics/recommendations (in handler); GET /analytics/customers (in handler); GET /analytics/insights (in handler) | 0 | DashboardLayout, manager/ManagerDashboard, pos/POSDrawer | - |
| `customers.edit` | 3 + 1 | POST /loyalty/customer; PATCH /loyalty/customer/:id; DELETE /loyalty/customer/:id; POST /orders/:id/whatsapp-receipt (in handler) | 0 | - | - |
| `customers.credit` | 9 + 4 | GET /credit/customers; GET /credit/customer/:id; GET /credit/customer/:id/history; POST /credit/customer/:id/payment; POST /credit/customer/:id/adjustment; GET /credit/sales; GET /credit/sales/count; POST /credit/sales/:orderId/confirm; POST /credit/sales/:orderId/dispute; GET /analytics/credit-ageing (in handler); GET /analytics/recommendations (in handler); GET /analytics/customers (in handler); GET /analytics/insights (in handler) | 3: credit:list, credit:decide, credit:dismiss | DashboardLayout, lib/creditLimit, customers/CreditAccountsPage, manager/ManagerDashboard, settings/StaffTab | - |
| `expenses.view` | 4 + 2 | GET /expenses; GET /expenses/summary; GET /reports/export/expenses; GET /reports/monthly/movements; GET /reports/eod (in handler); GET /reports/master (in handler) | 2: expense:range, expense:list | DashboardLayout, manager/ManagerDashboard | - |
| `expenses.manage` | 11 + 0 | POST /expenses/categories; PATCH /expenses/categories/:id; DELETE /expenses/categories/:id; POST /expenses; PATCH /expenses/:id; DELETE /expenses/:id; GET /reports/monthly; GET /reports/monthly/export; GET /reports/monthly/movements; POST /reports/monthly/movements; DELETE /reports/monthly/movements/:id | 5: expense:addCategory, expense:range, expense:list, monthly:addMovement, monthly:removeMovement | DashboardLayout, expenses/ExpensesPage, manager/ManagerDashboard | - |
| `staff.view` | 2 + 0 | GET /branches/:id/staff; GET /staff | 2: manage:listStaff, manage:listRoles | manager/ManagerDashboard | - |
| `staff.edit` | 5 + 0 | POST /staff; POST /staff/invite; PATCH /staff/:id; POST /staff/:id/reset-otp; DELETE /staff/:id | 2: manage:listStaff, manage:listRoles | manager/ManagerDashboard, settings/UsersAccessPage | - |
| `staff.roles` | 4 + 1 | PUT /staff/roles/:roleId/permissions; POST /staff/roles; PATCH /staff/roles/:roleId; DELETE /staff/roles/:roleId; GET /staff/roles (in handler) | 0 | - | - |
| `reservations.manage` | 7 + 0 | GET /reservations; POST /reservations; PATCH /reservations/:id; DELETE /reservations/:id; GET /reservations/waitlist; POST /reservations/waitlist; PATCH /reservations/waitlist/:id | 0 | DashboardLayout | - |
| `parking.manage` | 6 + 0 | POST /parking-sessions; GET /parking-sessions; GET /parking-sessions/:id; PATCH /parking-sessions/:id; POST /parking-sessions/:id/close; POST /parking-sessions/:id/void | 0 | - | - |
| `fuel.manage` | 12 + 0 | GET /fuel-tanks; POST /fuel-tanks; PATCH /fuel-tanks/:id; DELETE /fuel-tanks/:id; GET /fuel-tanks/movements; POST /fuel-tanks/:id/delivery; GET /pumps; POST /pumps; PATCH /pumps/:id; DELETE /pumps/:id; PATCH /pumps/:id/activate; PATCH /pumps/:id/idle | 1: manager:pumpStatus | - | - |
| `settings.business` | 7 + 0 | PATCH /business; PUT /business/branding; GET /business/branding/branches; PATCH /business/branding/branches/:branchId; DELETE /business/branding/branches/:branchId; POST /business/settings; PUT /flags/:key | 8: manage:setContinuousOperation, manage:setCashierHistoryMethods, branding:set, node:tlsRetrust, node:syncHealth, node:distribution, node:drawersStatus, node:retryFailed | DashboardLayout, manager/ManagerDashboard, settings/BusinessPage | - |
| `settings.branches` | 4 + 0 | PUT /branches/:id; PUT /branches/:id/set-main; DELETE /branches/:id; POST /branches/:id/settings | 0 | DashboardLayout | - |
| `settings.payments` | 5 + 1 | POST /branches/:id/settings; POST /business/settings; POST /payment-methods; PATCH /payment-methods/:id; DELETE /payment-methods/:id; GET /controls (in handler) | 4: manage:setPaymentMethodsEnabled, manage:createPaymentMethod, manage:updatePaymentMethod, manage:deletePaymentMethod | DashboardLayout | - |
| `settings.mpesa` | 0 + 2 | GET /branches/:id/mpesa (in handler); PUT /branches/:id/mpesa (in handler) | 0 | - | - |
| `settings.reversals` | 1 + 0 | POST /business/settings | 0 | DashboardLayout, manager/ManagerDashboard | - |
| `settings.integrations` | 8 + 0 | POST /business/settings; PATCH /qr/settings; GET /webhooks; POST /webhooks; PATCH /webhooks/:id; DELETE /webhooks/:id; GET /webhooks/:id/deliveries; POST /webhooks/:id/test | 0 | DashboardLayout | - |
| `settings.pos` | 4 + 1 | POST /business/settings; PUT /controls/pos/:key; PUT /controls/loyalty; PUT /controls/stock-zero; GET /controls (in handler) | 0 | DashboardLayout, lib/businessTerms, settings/BusinessPage | - |
| `receipt.manage` | 6 + 0 | POST /branches/:id/settings; PUT /business/branding; GET /business/branding/branches; PATCH /business/branding/branches/:branchId; DELETE /business/branding/branches/:branchId; POST /business/settings | 2: manage:setReceiptText, branding:set | DashboardLayout, manager/ManagerDashboard | - |
| `stations.manage` | 8 + 0 | POST /printers; PATCH /printers/:id; DELETE /printers/:id; POST /stations/seed-defaults; POST /stations; PATCH /stations/:id; PUT /stations/:id/categories; DELETE /stations/:id | 4: manage:seedDefaultStations, escpos:setKitchenExclusions, escpos:clearKitchenExclusions, escpos:assignments | DashboardLayout, lib/businessTerms, manager/ManagerDashboard, pos/CashierScreen | - |
| `tables.manage` | 4 + 0 | GET /tables/all; POST /tables; PATCH /tables/:id; DELETE /tables/:id | 0 | DashboardLayout | - |
| `devices.approve` | 9 + 2 | GET /devices; GET /devices/fleet; PATCH /devices/:id/label; PATCH /devices/:id/retire; PATCH /devices/:id/unretire; PATCH /devices/:id/approve; PATCH /devices/:id/reject; DELETE /devices/:id; POST /devices/:id/authorise-handover; GET /support/terminal-codes (in handler); GET /tech/branch-config/:branchId (in handler) | 1: node:answerJoin | DashboardLayout | - |
| `etims.manage` | 4 + 0 | GET /etims/config; PUT /etims/config; POST /etims/branches/:branchId/register; POST /etims/retry | 0 | DashboardLayout | - |
| `changes.approve` | 0 + 3 | GET /changes/count (in handler); GET /changes (in handler); POST /changes/:id/decide (in handler) | 0 | DashboardLayout, lib/businessTerms | - |

**Corrections made by reading the code**:

- `POST /orders/:id/void` needs `sales.void` and `POST /orders/:id/refund` needs `sales.refund`. The scanner saw both keys in `reversalGate`'s ternary.
- `POST /shifts/:id/confirm`, `/manager-confirm` and `/expense` decide through the approver's PIN. The approver must hold `shifts.confirm` (lib/shiftConfirm.ts, lib/approver.ts).
- `POST /credit/sales/:orderId/confirm|dispute` go through `personGate`, which means `customers.credit` plus the owner's chosen approvers (A585).
- `GET|PUT /credit/approvers` are owner-only.
- `products.view` is not checked by the cloud at all. Menu reads are open to every signed-in session, which the POS needs. On the till, `products.view` is one of the keys that opens the menu screen (`MENU_READ`).
- `shifts.cash_out` and `expenses.record` are not checked by the cloud yet. A594 removed the key refusal on `/shifts/:id/expense` and put "a manager approves every one" in its place.

**Checks that are not a single key**:

| Derived check | What it means | Routes |
|---|---|---|
| `~costs` | menu.costs or reports.costs (cost fields stripped from the answer) | 80: GET /analytics/costs; GET /batches; POST /batches; PATCH /batches/:id; POST /batches/:id/close; GET /inventory; POST /inventory/adjust; PATCH /inventory/:product_id/threshold; GET /inventory/movements; GET /orders/:id; GET /payables/returns; POST /payables/returns; GET /pos/changes; GET /pos/init; GET /products; GET /products/plu/:code; GET /products/barcode/:code; POST /products/barcodes/generate; GET /products/barcodes/settings; PUT /products/barcodes/settings; GET /products/labels/settings; PUT /products/labels/settings; GET /products/labels/restocked; POST /products; PATCH /products/:id; DELETE /products/:id; PATCH /products/bulk-tax/by-category; PATCH /products/bulk-tax/by-ids; PATCH /products/bulk-cost/by-ids; PATCH /products/bulk-track/by-ids; POST /products/bulk-price; POST /products/bulk; GET /recipes; GET /recipes/:productId; POST /recipes/bulk; POST /recipes/:productId; DELETE /recipes/:productId; GET /recipes/:productId/packaging; POST /recipes/:productId/packaging; GET /reports/products-v2; GET /stock/ingredients; POST /stock/ingredients; POST /stock/ingredients/bulk; PATCH /stock/ingredients/:id; POST /stock/ingredients/:id/adjust; PATCH /stock/ingredients/:id/reorder; GET /stock/ingredients/:id/movements; GET /stock/suppliers; POST /stock/suppliers; PATCH /stock/suppliers/:id; DELETE /stock/suppliers/:id; GET /stock/purchase-orders; GET /stock/purchase-orders/:id; POST /stock/purchase-orders; PATCH /stock/purchase-orders/:id; POST /stock/purchase-orders/:id/cancel; DELETE /stock/purchase-orders/:id; GET /stock/grn; POST /stock/grn; GET /stock/transfers; POST /stock/transfers; PATCH /stock/transfers/:id/status; GET /stock/other-branches; GET /stock/requests; GET /stock/requests/count; POST /stock/requests; POST /stock/requests/:id/${step}; GET /stock-takes; GET /stock-takes/active; POST /stock-takes; GET /stock-takes/:id; POST /stock-takes/:id/count; POST /stock-takes/:id/submit; POST /stock-takes/:id/recount; POST /stock-takes/:id/post; POST /stock-takes/:id/cancel; GET /wastage; GET /wastage/items; POST /wastage; POST /wastage/:id/void |
| `~drawer_figures` | reports.shifts or shifts.confirm (drawer figures stripped) | 2: GET /shifts; GET /shifts/:id |
| `~owner_only` | the real owner only | 7: GET /credit/approvers; PUT /credit/approvers; GET /loss-alerts/settings; PUT /loss-alerts/settings; GET /staff/web-access; POST /staff/:id/web-access; DELETE /staff/:id/web-access |
| `~owner_or_manager_role` | the owner, a built-in role NAMED Manager / General Manager, or a partner at their own branch (a role-name check) | 2: GET /credit/candidates; PATCH /credit/customer/:id/limit |
| `~owner_check` | req.isOwner branch inside the handler | 28: POST /auth/set-pin; POST /auth/password/change; GET /auth/session; PUT /branches/:id/mpesa; GET /business/cloud-trial; POST /business/settings; POST /changes; PUT /controls/pos/:key; GET /day-close/overview; POST /inventory/adjust; POST /kitchen/kds-token; GET /notifications; PATCH /notifications; POST /notifications; POST /orders; POST /orders/:id/refund; POST /orders/:id/void; POST /shifts/:id/close; GET /shifts/:id; GET /staff; POST /staff; POST /staff/invite; PATCH /staff/:id; POST /staff/:id/reset-otp; DELETE /staff/:id; POST /stock/ingredients/bulk; GET /support/terminal-codes; POST /sync/push |

**Business routes with no key at all (96).** These were read and sorted into the groups below. None is a gap except those named in the findings.

- **Sign-in and session**: `/auth/*` and `/tenant/:subdomain`.
- **The till's own session**, refused for a person's session, or reading only what every till needs:
  - `/pos/catalogue-version`, `/pos/join-code`, `/pos/branch-staff` (PIN hashes go to the till's own session only), `/pos/stock-view`, `/pos/test-data-clears`, `/pos/branch-drawers`, `/pos/credit-customers` (F4);
  - `/desktop-update/*`, `/day-close/pending|ack`, `/support/*`, `/tech/*`, `/ops/events`.
- **Reads every seller needs**:
  - menu, categories, combos, variants, modifiers, menus, offers, promotions;
  - payment methods, tables, stations, printers, flags, `/business`, `/business/settings` (an allow-list: secrets are never returned), branding;
  - expense types, shift state, terminals, the open drawer;
  - `/loyalty/customer` (look up a customer by their exact phone number, at the till), `/loyalty/settings`, `/kitchen/tickets`.
- **Customer-facing**: QR menu and order, M-Pesa STK push, callback and status, `/mpesa/config`.
- **Owner-only inside the handler**: web access, loss-alert settings, credit approvers, `PUT /controls/updates` (refused for everyone).
- **Worth a gate (F10)**: `GET /staff/roles` (every role's keys and member count, to any signed-in person) and `GET /staff/authorizers` (who can approve, by name).

## 4. Findings, ranked

The ranking puts personal data first (Kenya Data Protection Act 2019: data must be limited to what is necessary for the purpose, with protection by design and by default; legal wording to be confirmed by counsel). Money actions come next, then operations. **H** = high, **M** = medium, **L** = low.

### Personal data

**F1 (H) `customers.view` shows every customer's phone, e-mail, spend and notes, and it is a Cashier and Waiter default.**

- **Who sees what.** Any holder can page through every customer of the business:
  - `GET /loyalty/customers`, 50 per page with no page limit, giving name, phone, e-mail, points, total spent and visits;
  - `/loyalty/customer/:id/transactions` (what they bought, when);
  - `/loyalty/customer/:id/insights`;
  - `GET /credit/customers` and `/credit/customer/:id` (balances and limits);
  - with `reports.sales`, the Analytics customer list and credit ageing (`seesCredit`).
- **What a cashier needs.** Only to find the customer in front of them. `GET /loyalty/customer?phone=` already does that by exact number and needs no key.
- **Split.** `customers.view` (the list and records, contacts masked), `customers.contacts` (full phone numbers and e-mails) and `customers.history` (purchases and insights).

**F2 (H) Customer phone numbers also travel with sales.**

- `GET /orders/:id` returns `orders.*` (`customer_phone`) and `payments(*)`, which includes `mpesa_phone`, the payer's M-Pesa number.
- `GET /mpesa/status/:checkoutId` returns the payer's phone.
- `/mpesa/exceptions` (`reports.payments`) lists payer numbers.
- **Who sees it.** A cashier sees their own sales; anyone with `sales.history_all` sees every sale of the branch.
- **Split.** Mask these numbers without `customers.contacts`. The WhatsApp receipt already sends to the order's own number without showing it (`POST /orders/:id/whatsapp-receipt`).

**F3 (H) `settings.integrations` can send all the business's data out.**

- Webhooks (`/webhooks/*`, 6 routes) post every order, customer details included, to any URL.
- Scheduled report e-mails (`/business/settings/report-schedule`, the key `report_schedule` in `POST /business/settings`) mail reports to any address.
- The same tick also covers QR ordering, which is harmless.
- **Who holds it.** General Manager, and every role that held the legacy `settings.manage`.
- **Split.** `settings.webhooks` and `settings.report_emails`. `settings.integrations` keeps QR ordering.

**F4 (M) `GET /pos/credit-customers` has no key.**

- Any desktop-surface session, whether a person's sign-in or the till's own, gets every credit customer: name, phone, limit and balance, up to 5,000.
- The till keeps the list offline for credit sales.
- **Fix.** Keep the list for the till's own session and for people holding `customers.credit` or `customers.view`, and mask the phone unless the person holds `customers.contacts`. The till's local copy is then masked at the source.

**F5 (M) `staff.view` shows staff phone numbers and e-mails.**

- `GET /staff` and `/branches/:id/staff` return `email` and `phone`.
- **Who holds it.** Migration 134 gave `staff.view` to *every* role, because everyone had it before. Migrations 140 and 141 then took it off Cashier, Waiter and Teller. Every other pre-134 custom role still holds it.
- **Split.** `staff.view` (names, roles, branches and status) and `staff.contacts` (phone and e-mail).

**F6 (M) Staff pay rates are part of "Add and edit staff".**

- `PATCH /staff/:id` writes `hourly_rate`.
- The labour report (`reports.labour`, `/reports/splh`) shows each person's rate.
- **Split.** `staff.pay` for setting rates. The labour report stays under `reports.labour`, as an accountant's figure.

**F7 (M) The Analytics area is opened by `reports.sales` alone.**

- `/analytics/*` (13 routes, premium) includes:
  - "money leaks": voids and refunds by staff, which is `reports.voids` data;
  - the branch comparisons;
  - recommendations.
- A Supervisor (`reports.sales`) gets all of it.
- **Split.** `reports.analytics` opens the area. Inside it, money leaks also needs `reports.voids`, and the cost, customer and credit cards keep their own keys, as they do today.

**F8 (M) `reports.overview` reads the full sales and item reports.**

- `/reports/sales` and `/reports/products` accept `reports.overview` instead of `reports.sales` / `reports.items`, for any date range.
- The desktop's `manager:salesSummary` / `topProducts` do the same.
- **Why it matters.** The label says "today's sales, orders and open drawers".
- **Fix (narrowing, D8).** With Overview alone, the cloud answers today's range only.

**F9 (L) Supplier records are part of "Receive deliveries".**

- `inventory.receive` also adds, changes and deletes suppliers: contacts and payment details (`/stock/suppliers`).
- It also raises and cancels purchase orders.
- **Split.** `suppliers.manage` and `inventory.order`. `inventory.receive` keeps the receiving itself (GRNs) and reading suppliers and purchase orders.

**F10 (L) Role lists are open.**

- `GET /staff/roles` (every role's keys and member counts) and `GET /staff/authorizers` (who can approve, by name) need only a sign-in.
- **Fix.** Gate them on `staff.view`, `staff.edit` or `staff.roles`. The till's role picker uses `staff.edit`.

**F11 (M) Partners and branch staff see the whole business's customers.**

- Customers have no branch, so the list is business-wide (`.eq('business_id')` only).
- This works against A582's rule that a partner sees only their own branches.
- **Fix (D7).** Narrow partners in a set of branches, and branch-only partners, to customers with an order at their branches.

### Money

**F12 (H) `menu.costs` is a "view" key that also changes cost prices.**

- `PATCH /products/:id` accepts a `cost_price` change from anyone holding `menu.costs`. The route gate is any of `menu.edit` / `menu.prices` / `menu.costs`, and the field decides which is needed.
- `PATCH /products/bulk-cost/by-ids` needs only `menu.costs`.
- **Who can therefore change cost prices.**
  - The built-in **Auditor**: `VIEW_KEYS` includes `menu.costs`, yet the role "changes nothing".
  - The **Storekeeper** and **Kitchen Manager**.
- **Split.** `menu.costs` (see) and `menu.costs_edit` (change).

**F13 (H) `fuel.manage` is a Cashier default and covers set-up and deliveries.**

- Every cashier role, at every business type, can create, change and delete pumps and tanks (`/pumps`, `/fuel-tanks`) and record tank deliveries (`POST /fuel-tanks/:id/delivery`).
- A false delivery hides missing fuel.
- **Split.** `fuel.manage` (pump active / idle and the reads), `fuel.deliveries` and `fuel.setup`.

**F14 (H) `customers.credit` covers approving, repaying and writing off; credit limits go by role name.**

- One key approves a sale on account with a PIN, records repayments (`POST /credit/customer/:id/payment`) and adjusts balances, including write-offs (`/adjustment`).
- Credit limits (`PATCH /credit/customer/:id/limit`, `/credit/candidates`) go by role NAME: a built-in role called Manager or General Manager, the owner, or a partner at their own branch (`lib/creditApprovers.ts maySetCreditLimits`). That breaks rule 2 of A490 ("no role-name checks").
- **Split.** `customers.credit` (approve a sale on account; the till checks it by this name), `customers.credit_payment`, `customers.credit_adjust` and `customers.credit_limit`.

**F15 (M) `shifts.confirm` approves three different kinds of money action.**

- It confirms drawers and shows the expected cash. That is right together.
- It also makes the holder an approver for cash out, pay-outs and drawer expenses (with their PIN).
- It also approves removing items already sent to the kitchen (`POST /orders/:id/kitchen-void`, the till's `kitchen:void`).
- A Finance Manager confirms drawers but has no business approving kitchen removals.
- **Split.** `shifts.approve_payout` and `sales.approve_kitchen_void`.

**F16 (M) `sales.discount` (Cashier default) covers typed and set-up discounts.**

- The same key covers a typed manual amount or percent, up to the business limit (`orders` POST / pay, `discountRefused`), and applying a set-up discount or promo code (`POST /discounts/apply`).
- **Split.** `sales.discount` (typed; the till checks it by this name) and `sales.discount_preset`.

**F17 (M) `expenses.manage` adds, changes, removes, and sets types and monthly-pack entries.**

- Changing or removing a recorded expense rewrites the books.
- The monthly pack's cash and M-Pesa books (`POST /reports/monthly/movements`) are a finance task.
- A594 added `expenses.record` for the drawer. Its label "Record expenses" is the same as `expenses.manage`'s, so two ticks on the Roles screen read alike. **Rename the labels** (section 5).
- **Split.** `expenses.manage` (add a back-office expense), `expenses.edit`, `expenses.types` and `expenses.monthly`.

**F18 (M) `payables.manage` records bills and pays suppliers.**

- **Split.** `payables.manage` (bills, returns and voiding them) and `payables.pay` (record a payment and void one).

**F19 (M) `devices.approve` (Manager default) covers approving, retiring and removing tills.**

- It approves and rejects new tills, renames them, retires, unretires, removes them, authorises a hand-over, and lists the fleet.
- **Split.** `devices.view`, `devices.approve` (approve / reject / rename) and `devices.retire` (retire, unretire, remove, hand over).

**F20 (M) `settings.business` covers the profile, tax rates and selling limits.**

- Through `POST /business/settings` and the till's `tillGates.ts` it covers the profile and hours, the receipt and history rules, VAT and levy rates (`vat_rate`, `ctl_rate`), the discount limit (`max_discount_pct`) and continuous operation.
- **Split.** `settings.business` (profile, hours, receipt and history rules), `settings.tax` and `settings.sales_rules`.

**F21 (M) `settings.mpesa` is a Manager default.**

- It sets the M-Pesa number customers pay to. The owner is told of every change, but a wrong number sends the day's money elsewhere.
- **Fix.** No split. The default changes (D9): new businesses' Manager roles do not get it.

**F22 (L) `parking.manage` (Cashier default) includes voiding tickets.**

- **Split.** `parking.void`.

### Operations

**F23 (M) `inventory.adjust` covers hand changes, count review and reorder levels.**

- It covers:
  - changing a stock figure by hand (`/inventory/adjust`, `/stock/ingredients/:id/adjust`, `/branches/:id/stock/:productId`);
  - reviewing counts, which also unblinds the expected figure (`/stock-takes/:id/recount|post`);
  - reorder levels and thresholds;
  - closing batches and voiding wastage.
- **Split.** `inventory.adjust` (hand changes, batches, wastage voids), `inventory.count_review` and `inventory.reorder`. Reorder is also offered to `inventory.receive` holders today.

**F24 (M) `menu.edit` (34 routes) covers adding, deleting and bulk changes.**

- Deleting products, categories, menus, variant / modifier groups and options, or combos (8 routes) loses history from the screens.
- Bulk import, bulk tax class, bulk stock tracking and code generation (6 routes) change hundreds of items at once.
- **Split.** `menu.edit`, `menu.delete` and `menu.bulk`.

**F25 (L) `changes.approve` covers menu and staff changes made on a till.**

- Staff changes made on a till (new people, PINs) are approved by the same key as menu changes. The Operations Manager holds it.
- **Split.** `changes.approve_staff`.

**F26 (L) `staff.edit` covers PINs and per-person rights.**

- Setting or resetting PINs and approval PINs and resetting sign-in codes are security actions.
- Per-person rights (override keys) widen one person beyond their role, within the ceiling.
- **Split.** `staff.pins` and `staff.access`. Giving a person a role stays with `staff.edit`, which a manager needs to take on a cashier.

**Already right, and kept:**

- void vs refund (two keys);
- Close Day vs Close Branch (A520);
- force-close;
- every report on its own key;
- receipt text vs business settings;
- promotions (owner) vs offers;
- the count freeze (owner);
- `payables.view` vs `payables.manage`;
- drawer figures stripped (A494) and cost fields stripped (A490 rule 4).

**Considered and not proposed now:**

- splitting "approve a void / refund" from "void / refund" (`sales.void_approve`). Today the approver must hold the same key; revisit if owners ask for cashier-started voids;
- `settings.branches_close` (deactivate a branch / set the main branch, where branch creation is ZapTill's);
- a price-override key. There is no open-price feature at the POS yet; if one is added, it gets its own key (`sales.price_override`).

## 5. Proposed split

### 5.1 The new keys

Each new key is one part of a key that exists today (its **parent**). The parent keeps its name and the part a 1.0.21 desktop POS checks by that name. This is the same pattern A594 used for `shifts.cash_movements`. **Personal** marks keys that show personal data: they get a badge on the Roles screen and are left out of the built-in Auditor (section 5.4).

| # | New key | Parent | Label (owner's words) | Guards | Personal |
|---|---|---|---|---|---|
| 1 | `customers.contacts` | customers.view | See customers' phone numbers and e-mails | full `phone` / `email` in `/loyalty/customers`, `/loyalty/customer/:id`, `/credit/customers`, `/credit/customer/:id`, `/pos/credit-customers`, `/analytics/customers`, `/analytics/credit-ageing`; `customer_phone` and `payments.mpesa_phone` in `/orders`, `/orders/:id`; `/mpesa/status`, `/mpesa/exceptions`. Without it: masked. Desktop: customer and credit screens | yes |
| 2 | `customers.history` | customers.view | See what a customer bought | `/loyalty/customer/:id/transactions`, `/loyalty/customer/:id/insights`, the named list in `/analytics/customers` | yes |
| 3 | `customers.delete` | customers.edit | Remove customers | `DELETE /loyalty/customer/:id` (also the way to honour an erasure request) | |
| 4 | `customers.credit_payment` | customers.credit | Record credit repayments | `POST /credit/customer/:id/payment`; the Credit accounts screen (CreditAccountsPage) | |
| 5 | `customers.credit_adjust` | customers.credit | Adjust or write off credit balances | `POST /credit/customer/:id/adjustment` | |
| 6 | `customers.credit_limit` | (role-name rule) | Set customers' credit limits | `GET /credit/candidates`, `PATCH /credit/customer/:id/limit` (replaces `maySetCreditLimits`'s role names) | |
| 7 | `customers.export` | (reserved) | Download customer lists | no route today; registered with the first customer download, which must need it | yes |
| 8 | `staff.contacts` | staff.view | See staff phone numbers and e-mails | `phone` / `email` in `GET /staff`, `/branches/:id/staff`, the till's `manage:listStaff` | yes |
| 9 | `staff.pins` | staff.edit | Set and reset PINs and sign-in codes | `pin` / approval PIN fields of `POST /staff`, `PATCH /staff/:id`; `POST /staff/:id/reset-otp`; till staff PIN change | |
| 10 | `staff.access` | staff.edit | Give a person their own rights | `override_keys` / `overrides` of `POST /staff`, `PATCH /staff/:id` (the ceiling still applies) | |
| 11 | `staff.pay` | staff.edit | Set staff pay rates | `hourly_rate` of `PATCH /staff/:id` (accepted with `staff.pay` alone for that field) | yes |
| 12 | `settings.webhooks` | settings.integrations | Webhooks (send sales to another system) | `/webhooks/*` (6) | |
| 13 | `settings.report_emails` | settings.integrations | Scheduled report e-mails | `GET /business/settings/report-schedule`, `report_schedule` in `POST /business/settings` | |
| 14 | `reports.analytics` | reports.sales | Analytics | `router.use` of `/analytics/*` (13); money leaks also needs `reports.voids` | |
| 15 | `reports.audit` | reports.voids | Audit trail | `GET /reports/export/audit` | |
| 16 | `menu.costs_edit` | menu.costs | Change cost prices | `cost_price` in `PATCH /products/:id`, `POST /products`, `POST /products/bulk`; `PATCH /products/bulk-cost/by-ids`; the till's cost field (ipc/menu.ts) | |
| 17 | `menu.delete` | menu.edit | Delete products, categories and menus | `DELETE` of `/products/:id`, `/categories/:id`, `/menus/:id`, `/variants/groups/:id`, `/variants/options/:id`, `/modifiers/groups/:id`, `/modifiers/options/:id`, `/combos/:id`; till delete buttons | |
| 18 | `menu.bulk` | menu.edit | Bulk changes to the menu | `POST /products/bulk`, `PATCH /products/bulk-tax/by-category`, `/bulk-tax/by-ids`, `/bulk-track/by-ids`, `POST /variants/bulk`, `POST /products/barcodes/generate` | |
| 19 | `suppliers.manage` | inventory.receive | Add, change and remove suppliers | `POST`, `PATCH`, `DELETE /stock/suppliers` (reading stays with receive) | |
| 20 | `inventory.order` | inventory.receive | Purchase orders | `POST`, `PATCH /stock/purchase-orders`, `/:id/cancel`, `DELETE` (reading stays with receive) | |
| 21 | `inventory.count_review` | inventory.adjust | Review and post stock counts | `POST /stock-takes/:id/recount`, `/post`; the unblinded expected figure (`stockTakeAccess.may`) | |
| 22 | `inventory.reorder` | inventory.adjust, inventory.receive | Reorder levels | `PATCH /inventory/:product_id/threshold`, `PATCH /stock/ingredients/:id/reorder` | |
| 23 | `fuel.deliveries` | fuel.manage | Record fuel deliveries | `POST /fuel-tanks/:id/delivery` | |
| 24 | `fuel.setup` | fuel.manage | Set up pumps and tanks | `POST`, `PATCH`, `DELETE /pumps`, `/fuel-tanks` (6) | |
| 25 | `shifts.approve_payout` | shifts.confirm | Approve cash out and drawer expenses with their PIN | the approver of `POST /shifts/:id/float` (cash out), `/shifts/:id/expense`; till approvals (`approverByPin`, shiftService) | |
| 26 | `sales.approve_kitchen_void` | shifts.confirm | Approve removing items sent to the kitchen | the approver of `POST /orders/:id/kitchen-void`; till `kitchen:void` (approver via `mayConfirmLocal`, ipc/shared.ts) | |
| 27 | `sales.discount_preset` | sales.discount | Apply set-up discounts and promo codes | `POST /discounts/apply`; the till's discount picker presets | |
| 28 | `expenses.edit` | expenses.manage | Change or remove recorded expenses | `PATCH`, `DELETE /expenses/:id` | |
| 29 | `expenses.types` | expenses.manage | Expense types | `POST`, `PATCH`, `DELETE /expenses/categories`; till `expense:addCategory` | |
| 30 | `expenses.monthly` | expenses.manage | Monthly pack entries | `POST /reports/monthly/movements`; the monthly pack read that `expenses.manage` opens today | |
| 31 | `payables.pay` | payables.manage | Pay suppliers | `POST /payables/payments`, `/payments/:id/void` | |
| 32 | `devices.view` | devices.approve | See the tills | `GET /devices`, `/devices/fleet` | |
| 33 | `devices.retire` | devices.approve | Retire, remove or hand over tills | `PATCH /devices/:id/retire`, `/unretire`, `DELETE /devices/:id`, `POST /devices/:id/authorise-handover` | |
| 34 | `settings.tax` | settings.business | Tax rates | `vat_rate`, `ctl_rate` in `POST /business/settings` and `tillGates.ts` | |
| 35 | `settings.sales_rules` | settings.business | Discount limit and selling rules | `max_discount_pct`, `continuous_operation` and the history rules in `POST /business/settings` and `tillGates.ts` | |
| 36 | `changes.approve_staff` | changes.approve | Approve staff changes made on a till | `POST /changes/:id/decide` when the change is a staff change; the count and list show staff changes only with it | |
| 37 | `parking.void` | parking.manage | Void parking tickets | `POST /parking-sessions/:id/void` | |

The parents' new labels:

- `customers.view`: "See customers (phone numbers masked)".
- `customers.credit`: "Approve sales on account".
- `staff.view`: "See staff".
- `staff.edit`: "Add and edit staff, their branches and role".
- `settings.integrations`: "QR ordering".
- `menu.costs`: "See cost prices".
- `menu.edit`: "Add and change the menu".
- `inventory.receive`: "Receive deliveries".
- `inventory.adjust`: "Change stock figures by hand".
- `fuel.manage`: "Pumps on and off".
- `shifts.confirm`: "Confirm drawers and see the expected cash".
- `sales.discount`: "Give typed discounts (up to the limit)".
- `expenses.manage`: "Add back-office expenses" (and A594's `expenses.record` becomes "Record drawer expenses").
- `payables.manage`: "Record supplier bills and returns".
- `devices.approve`: "Approve and rename tills".
- `settings.business`: "Business profile, hours and receipt rules".
- `changes.approve`: "Approve menu changes made on a till".
- `parking.manage`: "Open and close parking tickets".

Each new key also needs its business-type wording in `shared/businessTerms.ts` where the parent has one (for example, "products" instead of "menu" for a shop).

### 5.2 Defaults per built-in role (new businesses)

A tick means the built-in role is seeded with the key (`BUILT_IN_ROLES`, `lib/defaultRolePermissions.ts`). General Manager holds every key by definition (`PERMISSION_KEYS`), except where D3 makes webhooks and report e-mails the owner's. The Owner always holds everything.

| New key | Mgr | GM | Ops | Fin | Acc | Aud | Sup | Csh | Wtr | Kit | KMg | Sto | Fuel |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| customers.contacts | ✓ | ✓ | | ✓ | | | | | | | | | |
| customers.history | ✓ | ✓ | | | | | | | | | | | |
| customers.delete | ✓ | ✓ | | | | | | | | | | | |
| customers.credit_payment | ✓ | ✓ | | ✓ | | | ✓ | | | | | | |
| customers.credit_adjust | | ✓ | | ✓ | | | | | | | | | |
| customers.credit_limit | ✓ | ✓ | | | | | | | | | | | |
| customers.export | | | | | | | | | | | | | |
| staff.contacts | ✓ | ✓ | ✓ | | | | | | | | | | |
| staff.pins | ✓ | ✓ | ✓ | | | | | | | | | | |
| staff.access | | ✓ | | | | | | | | | | | |
| staff.pay | | ✓ | | ✓ | | | | | | | | | |
| settings.webhooks | | (D3) | | | | | | | | | | | |
| settings.report_emails | | (D3) | | | | | | | | | | | |
| reports.analytics | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | | | | | | |
| reports.audit | ✓ | ✓ | | ✓ | ✓ | ✓ | | | | | | | |
| menu.costs_edit | | ✓ | ✓ | | | | | | | | ✓ | | |
| menu.delete | | ✓ | ✓ | | | | | | | | | | |
| menu.bulk | | ✓ | ✓ | | | | | | | | | | |
| suppliers.manage | ✓ | ✓ | ✓ | | | | | | | | | | |
| inventory.order | ✓ | ✓ | ✓ | | | | | | | | ✓ | | |
| inventory.count_review | | ✓ | ✓ | | | | | | | | | | |
| inventory.reorder | ✓ | ✓ | ✓ | | | | | | | | ✓ | ✓ | |
| fuel.deliveries | ✓ | ✓ | ✓ | | | | | | | | | | |
| fuel.setup | ✓ | ✓ | ✓ | | | | | | | | | | |
| shifts.approve_payout | ✓ | ✓ | | ✓ | | | ✓ | | | | | | |
| sales.approve_kitchen_void | ✓ | ✓ | | | | | ✓ | | | | | | |
| sales.discount_preset | ✓ | ✓ | | | | | ✓ | ✓ | ✓ | | | | |
| expenses.edit | | ✓ | | ✓ | | | | | | | | | |
| expenses.types | ✓ | ✓ | | ✓ | | | | | | | | | |
| expenses.monthly | | ✓ | | ✓ | | | | | | | | | |
| payables.pay | | ✓ | | ✓ | | | | | | | | | |
| devices.view | ✓ | ✓ | ✓ | | | ✓ | | | | | | | |
| devices.retire | | ✓ | | | | | | | | | | | |
| settings.tax | | ✓ | | | | | | | | | | | |
| settings.sales_rules | | ✓ | | | | | | | | | | | |
| changes.approve_staff | | ✓ | | | | | | | | | | | |
| parking.void | ✓ | ✓ | ✓ | | | | | | | | | | |

Changes to the built-in defaults of **existing** keys for new businesses:

- `sales.discount` (typed) leaves Cashier and Waiter: they get `sales.discount_preset`.
- `settings.mpesa` leaves Manager (F21).
- The Auditor's `menu.costs` stays (it is a view). The Auditor never gets `menu.costs_edit`.

### 5.3 Carry-over: nobody gains or loses on deploy

**The rule.** Every holder of a parent gets all of its new parts:

- every role that holds the parent, through `role_permissions`;
- every person override of the parent, through `user_permissions`, given or taken away. A taken-away parent becomes taken-away parts.

The owner's roles get every new key, as every new key always has. What a person may do the day after the deploy equals what they could do the day before, because the parent still guards what it guarded and the new keys are already held wherever the parent is.

| Parent held | Gets |
|---|---|
| customers.view | customers.contacts, customers.history |
| customers.edit | customers.delete |
| customers.credit | customers.credit_payment, customers.credit_adjust |
| built-in Manager / General Manager roles (`is_default`, by today's role-name rule) and the owner roles | customers.credit_limit (exactly who sets limits today) |
| staff.view | staff.contacts |
| staff.edit | staff.contacts, staff.pins, staff.access, staff.pay |
| settings.integrations | settings.webhooks, settings.report_emails |
| reports.sales | reports.analytics |
| reports.voids | reports.audit |
| menu.costs | menu.costs_edit |
| menu.edit | menu.delete, menu.bulk |
| inventory.receive | suppliers.manage, inventory.order, inventory.reorder |
| inventory.adjust | inventory.count_review, inventory.reorder |
| fuel.manage | fuel.deliveries, fuel.setup |
| shifts.confirm | shifts.approve_payout, sales.approve_kitchen_void |
| sales.discount | sales.discount_preset |
| expenses.manage | expenses.edit, expenses.types, expenses.monthly |
| payables.manage | payables.pay |
| devices.approve | devices.view, devices.retire |
| settings.business | settings.tax, settings.sales_rules |
| changes.approve | changes.approve_staff |
| parking.manage | parking.void |
| reports.overview without reports.sales / reports.items (custom roles only; no built-in role) | reports.sales / reports.items, so F8's narrowing takes nothing away (D8) |

The **legacy broad keys** get the parts too, wherever their list holds the parent. An old token, an override row or a till map that still carries a broad key then keeps its meaning:

- `settings.manage` gets devices, settings.business, changes and integrations parts;
- `products.manage` gets the menu.edit and menu.costs parts;
- `customers.manage` gets customers.delete and the credit parts;
- `staff.manage` gets the staff parts;
- `reports.view` gets reports.analytics and reports.audit;
- `orders.void` and `shifts.manage` get the shifts.confirm parts.

`legacyKeysFor` then reports a broad key only when every part is held, which is what the carry-over guarantees.

**Partners.** They are treated exactly as their role and overrides say. Nothing extra and nothing less:

- They pass through the same carry-over.
- In "All my branches" they still only read.
- Owner-only rules stay owner-only.
- One partner exception is decided by D4: today a partner sets credit limits at their own branch whatever their role. Kept, the rule stays as it is. Dropped, partners set limits only through `customers.credit_limit`. Their roles then need the key, and 176 can give it to the roles of today's live partners (`web_partners`) so nothing changes on the day.

### 5.4 Default changes for owner review

These are the only places where an **existing** role changes. They are not part of the carry-over migration. Each one runs only if the owner says yes, in its own guarded block of a second migration (section 6.1).

| # | Change | Roles affected | Why |
|---|---|---|---|
| C1 (D1) | Take off customers.contacts, customers.history | built-in Cashier and Waiter roles, and roles that hold `orders.create` but nothing beyond the floor keys (`isBackOffice` false) | A cashier finds a customer by number; the list is not theirs |
| C2 (D2) | Take off menu.costs_edit | built-in Auditor roles (correction); optionally Storekeeper | "Changes nothing" / receiving carries its own cost |
| C3 (D3) | Take off settings.webhooks, settings.report_emails | every non-owner role | Data leaving the business |
| C4 (D5) | Take off fuel.deliveries, fuel.setup | built-in Cashier and Fuel attendant roles | A false delivery hides missing fuel |
| C5 (D6) | Take off sales.discount (typed), keep sales.discount_preset | built-in Cashier and Waiter roles | Typed discounts are the most common till fraud (finding M4, orders.ts) |
| C6 | Take off parking.void | built-in Cashier roles | A void is a money action |
| C7 (D9) | Take off customers.credit_adjust, staff.access, staff.pay, devices.retire, expenses.edit, expenses.monthly; settings.mpesa | built-in Manager roles | Write-offs, pay rates and rights are the owner's or the finance manager's |
| C8 | Take off sales.approve_kitchen_void | built-in Finance Manager roles | Finance confirms drawers, not kitchen removals |
| C9 | Take off reports.analytics | built-in Supervisor roles | The premium area is for managers |

**Built-in Auditor and personal data.** The Auditor is defined as `VIEW_KEYS`, every key marked as a view. The three new contact and history keys are views, so the definition becomes "view and not personal". New Auditor roles then never get them, and existing Auditor roles keep them only if C1 is not extended to them. Recommendation: extend C1 to the Auditor too, because an outside auditor needs figures, not phone numbers.

## 6. Implementation plan

### 6.1 Catalogue and migrations

1. **`shared/permissions.ts`** (and its 5 copies, kept identical by `scripts/check-shared-sync.mjs`):
   - add the 37 entries to `PERMISSIONS`, with group, surface, `view` and a new `personal?: boolean`;
   - add `SPLITS: Record<parent, children[]>` (section 5.3). This is the one source for the migration test, the Roles screen's nesting and `expandKeys`' pre-migration behaviour;
   - append the children to every `LEGACY` list that holds a parent;
   - change `VIEW_KEYS` for the Auditor to view and not personal;
   - update `BUILT_IN_ROLES` (section 5.2) and `FLOOR_KEYS`. `sales.discount_preset` is a floor key and `sales.discount` stays one, so a cashier is never "back office".
   - Before the migration has run (`splitsPending()`, on the pattern of `permissionsOpenBefore()`), `expandKeys` also adds the children of a held parent. Every client therefore behaves the same before and after the migration.
2. **Migration `176_permission_splits.sql`**: the first free number after A594's 175. If A594 adds another migration, take the next one.
   - **Register** the keys idempotently, with EXACTLY the catalogue's tuple `('key', 'label', 'group', 'description')`. `test-migration-134.mjs`'s `registeredLater` looks for that exact text, so 134's frozen test stays green. Relabel the parents with `UPDATE … SET label = …, description = … WHERE key = …`, the catalogue's exact words (as 140 and 147 do).
   - **Carry over once**, guarded by its own `schema_migrations` row:
     - `INSERT … SELECT DISTINCT role_id, child FROM role_permissions JOIN permissions … WHERE key = parent ON CONFLICT DO NOTHING`, per `SPLITS` pair, generated from the catalogue the way 134's mapping is;
     - the same for `user_permissions` with the same `granted` value;
     - `customers.credit_limit` for built-in Manager / General Manager roles (`is_default` and the role name, the rule it replaces) and the owner roles;
     - `reports.sales` / `reports.items` for roles holding `reports.overview` without them.
   - The `role_permissions` / `user_permissions` triggers bump `permissions_version`, so tokens renew and the tills get a staff change. The migration takes nothing away.
   - A read-only preview query goes in the header, as in 175.
3. **Migration `177_permission_default_changes.sql`**: only the default changes the owner approves (C1–C9). Each sits in its own block under its own `schema_migrations` row, so an unapproved one is simply left out. Per-person overrides are never touched. A person given a right in Staff keeps it, as in 175.

### 6.2 Cloud enforcement (where each key is checked)

- **Writes** use the new key at the route (`requirePermission(child)`), or per field inside a mixed write, as `PATCH /products/:id` already does with `need.add(...)`. The field-level points are:
  - `POST|PATCH /staff` (`pin` → staff.pins, `override_keys` → staff.access, `hourly_rate` → staff.pay);
  - `POST /business/settings` (`SETTING_WRITE_KEYS`: vat/ctl → settings.tax, `max_discount_pct` / `continuous_operation` / history rules → settings.sales_rules, `report_schedule` → settings.report_emails);
  - `PATCH /products/:id` (`cost_price` → menu.costs_edit);
  - `/changes/:id/decide` (by the change's kind).
- **Approvers.** `lib/approver.ts` `APPROVE_KEY` gains `payout: 'shifts.approve_payout'` and `kitchen_void: 'sales.approve_kitchen_void'`. `lib/confirmerLookup.ts` and `shiftConfirm.mayConfirm` keep `shifts.confirm` for drawers. `APPROVAL_PIN_KEYS` (routes/staff.ts) gains the two approver keys.
- **Reads that mask.** A new `lib/personalData.ts`: `maskPhone('0712345678') → '07•• ••• 678'`, plus `withoutContacts(req, body)`, the same shape as `withoutCosts`, stripping or masking `phone`, `email`, `customer_phone`, `mpesa_phone` and `payer_phone` unless `customers.contacts` is held. It is applied as router middleware on `/loyalty`, `/credit`, `/analytics`, `/mpesa` (status and exceptions), `/orders` (list and detail) and `/pos/credit-customers`. Staff: `shapeStaff` drops `phone` / `email` without `staff.contacts`. Rule 4 of A490 holds: data a person may not see is not sent.
- **Narrowings:**
  - `/reports/sales` and `/reports/products` with `reports.overview` only → today's range;
  - `/staff/roles` and `/staff/authorizers` → staff.view, staff.edit or staff.roles;
  - `/pos/credit-customers` → till session, customers.credit or customers.view;
  - `/credit/candidates` and `/credit/customer/:id/limit` → `customers.credit_limit` (the role-name rule in `maySetCreditLimits` goes; D4 decides the partner rule);
  - customers for partners → D7.
- `rbac.ts`'s `assertFineKeys` already refuses a non-catalogue key when a route file loads, and `check-permission-catalogue` refuses a legacy key in a check. Both stay as they are.

### 6.3 POS (desktop 1.0.22) and offline

- The till's permission map comes from the cloud's `clientPermissionMap` / `permissionMapFor`, which already sends every fine key. The roster (`/pos/branch-staff`) carries each person's map, and the till keeps it offline. **No local schema change** is needed: the keys are strings in the cached map.
- **Older tills (1.0.21 and earlier)** ignore keys they do not know: `expandMap` keeps only catalogue keys. They keep checking the parents, which still mean what they meant for those builds.
  - A parent holder has every child after 176, so nothing changes for them.
  - A role that holds only a child and not its parent fails closed on an older till. This can only happen through the new defaults or an owner's choice. Example: a new business's Cashier with set-up discounts only cannot discount on 1.0.21. The 1.0.22 release notes say so.
- **1.0.22 changes:**
  - copy the catalogue into `apps/desktop/src/{shared,main}/permissions.ts`;
  - `tillGates.ts` (`vat_rate`, `ctl_rate` → settings.tax; `max_discount_pct`, `continuous_operation` → settings.sales_rules);
  - `ipc/sale.ts` (typed vs preset discount);
  - `shiftService` / `ipc/shifts.ts` approvals (`shifts.approve_payout`), `ipc/kitchen.ts` (`sales.approve_kitchen_void`);
  - `ipc/menu.ts` (`menu.costs_edit`, `menu.delete`, `menu.bulk`), `ipc/staff.ts` (pins, access, pay), `ipc/credit.ts` (payment, adjust);
  - `ipc/expenses.ts` (types), `ipc/join.ts` / devices (`devices.view`);
  - the screens in `renderer/pages/ManagerPage.tsx`, `POSPage.tsx` and `App.tsx`, and `renderer/lib/access.ts`.
- **Masked data offline.** The till's copy of credit customers comes masked from the cloud for people without `customers.contacts`. The till's own session keeps the full list only where it must dial or send (WhatsApp receipt). Otherwise mask at the source and let the till ask the cloud for the number when it sends.

### 6.4 Screens

- **Roles and permissions** (`apps/dashboard/src/pages/settings/RolesTab.tsx`):
  - each group shows its keys in three columns: **See**, **Do** and **Approve** (keys of the same area side by side);
  - a parent shows its parts indented under it, labelled "includes";
  - ticking a parent ticks its parts the first time, so an owner who ticks the old box gets what they always got; each part can then be unticked;
  - a **personal data** badge on the four personal keys;
  - the ceiling rule (`keysBeyond`) applies per part.
- **Staff** (`StaffTab.tsx`, `UsersAccessPage.tsx`):
  - per-person overrides use the same nesting;
  - the form hides the PIN fields without `staff.pins`, the rights panel without `staff.access` and the pay rate without `staff.pay`;
  - phone and e-mail are shown masked without `staff.contacts`.
- **Web screens to update** (from the mapping table):
  - `DashboardLayout` (nav items per key);
  - `ManagerDashboard`, `CreditAccountsPage`, `ExpensesPage`, `SuppliersPage`, `OtherBranchesPage`;
  - `POSDrawer` / `CashierScreen` / `DiscountPanel` / `PaymentModal` (web POS);
  - `BusinessPage`, `WebhooksTab`, `ReportSchedulerTab`, `DevicesTab`.

### 6.5 Tests

- **Catalogue** (`scripts/test-permission-catalogue.mjs`):
  - every `SPLITS` child is a fine key, has one parent and no cycles;
  - every child is in each `LEGACY` list that holds its parent;
  - `VIEW_KEYS` for the Auditor has no personal key;
  - every new key has its words in `businessTerms.ts` where the parent has.
- **Migration** (`scripts/test-migration-176.mjs`, on the pattern of 142, 159 and 175), on a fixture database of roles and overrides:
  - after the migration, each role holds exactly what it held plus `SPLITS` children of what it held, plus the credit-limit and overview rows;
  - overrides are carried with the same `granted` value;
  - the owner roles hold everything;
  - running it again changes nothing;
  - the registered words equal the catalogue's;
  - 134's test stays green.
- `test-migration-177.mjs`: each approved block changes only its named roles, and per-person overrides are untouched.
- **Routes**: a generated matrix test (`tests/permission-splits.test.mjs`). For every new key and every route in section 5.1:
  - a token holding only the child is allowed;
  - a token holding the parent alone is allowed while `splitsPending()`, and refused after it for the split-off part;
  - a token with neither is refused (403 with `Missing permission: <child>`).

  Masking:

  - a token without `customers.contacts` gets masked `phone` / `mpesa_phone` and no `email` from each read in item 1 of section 5.1;
  - with the key, the full values.
- **Mutation checks**:
  - remove one `requirePermission(child)` and the matrix fails;
  - drop a child from a `LEGACY` list and the catalogue test fails;
  - make the 176 carry-over skip overrides and the migration test fails.
- **Parity**: update `scripts/permission-parity-baseline.json` so `check-permission-parity` compares the new keys' web and till gates.
- **Before each commit**, run every step of `ci.yml` (the repo's rule).

### 6.6 Risks

- **Lock-out during the deploy.** Prevented by accepting the parent until 176 has run (`splitsPending()`). The narrowing (section 6.7, step 3) comes only after the post-migration check.
- **Approvals at an older till.** A 1.0.21 till checks `shifts.confirm` for pay-out approvals offline, and every current approver holds it. A person given only `shifts.approve_payout` cannot approve on a 1.0.21 till. Release note.
- **A crowded Roles screen.** 70 → 107 keys. The nesting keeps a group's first view as short as today: parents only, with "includes" folded.
- **The ceiling.** A manager editing a role can hand out only parts they hold. After the carry-over they hold every part of what they held, so no manager loses the ability to give what they gave before.
- **Wording per business type** must be added for each new key (`businessTerms.ts`), or a shop reads "menu" where it means "products".
- **A594 is in flight** on the same files (`shared/permissions.ts`, `routes/staff.ts`, `routes/shifts.ts`, migration numbering). Build this after A594 is committed, on top of its keys. Take the migration number after its last.
- **Masking breaks a flow that needs the number:**
  - calling a credit customer is a `customers.contacts` job;
  - reservations keep the guest's phone for whoever holds `reservations.manage` (they must call the guest);
  - the WhatsApp receipt sends server-side without showing the number.

### 6.7 Rollout order

1. **Cloud, step 1** (no visible change):
   - catalogue with `SPLITS`;
   - every route accepts the child or the parent;
   - masking reads check `customers.contacts` (held by every `customers.view` holder after 176, so nobody sees less);
   - deploy, then run migration 176 and verify with the preview query that every parent holder holds its children.
2. **Web screens**: the Roles and Staff nesting and the personal-data badge, the dashboard and web POS gated by the child keys. Owners can now untick parts.
3. **Cloud, step 2**: the split-off routes stop accepting the parent. Run migration 177 with the owner's approved default changes. New businesses get the new built-in defaults.
4. **Desktop 1.0.22** in the next batch release (no tag per feature): the till's gates use the child keys, and the release notes cover the older-till behaviour.

## Appendix: method notes

- The tables in sections 2 and 3 were generated from the code on 2026-10-26 by a read-only scan (Node scripts kept in the session's scratchpad, not in the repo). If the tables need refreshing after A594 lands, re-run that scan, or turn it into `scripts/report-permission-map.mjs` with the implementation.
- An aside, outside this audit's scope: `GET /loyalty/customers?search=` builds a PostgREST `or(...)` filter from the raw search text. Commas or brackets in the search can add filter terms, always still inside the business (`eq('business_id')` is applied separately). Quoting the search text, as `likeLiteral` does for promo codes, closes it.

## 7. Implemented (A595, 27 October 2026)

**Keys.** 36 added (106 in all): 35 parts of a broad key (`SPLITS` in `shared/permissions.ts`) and `customers.credit_limit`. `customers.export` stays reserved (no download exists). The parents keep their names and their frozen words in the database (migration 134); what is left of each is shown at display time (`shared/businessTerms.ts` `SPLIT_PARENT_WORDS`). `personal: true` marks `customers.contacts`, `customers.history`, `staff.contacts`, `staff.pins`, `staff.pay`; the built-in Auditor (`VIEW_KEYS`) takes view keys that are not personal.

**Nobody gained or lost on the day.**
- Migration 176 gave every role and every per-person override holding a parent all of its parts (a part with two parents: what the person had through either), credit limits to the built-in Manager and General Manager roles (the rule by role name it replaces), the owner roles every new key. `scripts/test-migration-176.mjs` proves, person by person, that what anyone holds after 176 equals what they held before.
- Until 176 is recorded (`lib/permissionsState.ts splitsPending`), and for a token made before A595 (no `parts` in it), a parent still brings its parts. After that a part not held was taken away on purpose, and the owner can untick parts.
- A screen that does not know the parts (no `parts: true` on the save) ticking a parent for the first time gets its parts too, within the caller's own keys.
- A 1.0.21 desktop POS keeps checking the parents, which every parent holder still has.

**Checked by the cloud.** Every route in the section 5.1 table checks its part: discounts/apply; Analytics; the audit download; the eight menu deletes and six bulk routes; cost prices (products, bulk cost, ingredients); suppliers; purchase orders; count review (recount, post, the expected figures); reorder levels (an ingredient's still needs Change stock figures by hand, as before); paying suppliers; customer history and removal; credit repayments, adjustments and limits; expense edits, types and the monthly pack; staff PINs, own rights and pay (pay alone may set the rate); parking voids; fuel deliveries and set-up; webhooks; report e-mails; tax rates; selling rules; seeing and retiring POS devices; staff changes made on a POS; the two PIN approvals (pay-outs and drawer expenses; kitchen removals).

**Personal data.** `lib/personalData.ts`: phone numbers masked as 07•• ••• 678, e-mails as m•••@domain, KRA PINs as A•••Z, unless the person holds `customers.contacts` (customer lists and records, credit accounts, the POS credit list, orders and their M-Pesa payers, M-Pesa status and exceptions, Analytics) or `staff.contacts` (staff lists). A masked value sent back is never written; an order takes the customer's real number from their record.

**Gaps closed.** `GET /api/pos/credit-customers`: a person needs `customers.view` or `customers.credit`; the POS's own session gets names, limits and balances with phones masked. `GET /api/staff/roles`: a staff or roles right. `GET /api/staff/authorizers`: ids and names (roles only with a staff right). The customer search: one quoted PostgREST literal per value (it was pasted in raw), LIKE wildcards literal, and without `customers.contacts` a phone matches only when typed in full.

**Screens.** Roles and permissions and a person's own rights: See / Do / Approve per area, parts nested under their parent, a **Personal data** mark. Staff cards: PIN, own rights and pay shown by their parts; contacts read-only when masked. Credit Accounts: Credit settings and By branch (D4). The desktop POS: **+ Customer** (lazy-loaded), On account refused at a branch without credit, owed here / owed in total. Main chunk: 439.9 KiB of 450 (the void dialog now loads on demand).

**Tests.** `tests/permissions-split-a595.test.mjs`, `tests/owner-decisions-a595.test.mjs`, `tests/owner-alerts.test.mjs` (D3's e-mails), `apps/desktop/test/credit-branch-a595.test.mjs`, `scripts/test-migration-176.mjs`, `177`, `178`.
