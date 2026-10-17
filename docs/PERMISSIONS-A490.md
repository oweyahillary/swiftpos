# Permissions — one catalogue, set in one place (A490 / A491)

Owner, 2026-10-14: *"come up with a way we can turn most of this features into permissions which can be set in one
place, if each report can be broken down to a permission … clean and single point of setting, you can move some of the
features in admin section as permission for the owner to set"*. 2026-10-15: *"dont just focus on reports break even
other views and how to limit what users see"*.

## The model

- **One catalogue**: `shared/permissions.ts` (copied to every app, kept identical by `check-shared-sync`). Every FINE key
  — one per screen, report, action or sensitive figure — with the words the owner reads, its group, where it applies.
- **Roles hold fine keys.** A person = their role's keys, plus their own overrides (a key added or taken away).
  The owner (role named owner/admin — `lib/ownerRole.ts`, the ONE place a role name decides anything) holds `'*'`.
- **Broad keys are gone from every check.** The old keys (`reports.view`, `reports.financial`, `orders.void`,
  `shifts.manage`, `products.manage`, `customers.manage`, `staff.manage`, `settings.manage`) are LEGACY: wherever
  permissions are read they are expanded into the fine keys they stood for (`expandKeys` / `expandMap`), so a role saved
  before, an old token or an override row keeps exactly what it had. Migration 134 rewrites the stored grants once.
- **Older clients** (a till on 1.0.15 or earlier, a cached web POS session) still check broad keys: the cloud's
  permission maps also carry a broad key when EVERY fine key behind it is held (`legacyKeysFor`) — an older client never
  shows more than the person may do. Maps carry `catalogue.v2: true` (`MAP_MARKER`).
- **What had no check before** (giving discounts, cash in/out, every cashier's sales, the staff list, reservations,
  parking, fuel): every person keeps it until migration 134 has run (`OPEN_BEFORE_A490`, `permissionsOpenBefore()`);
  134 grants it to the roles that had it in practice, and the owner decides per role from then on.
- **The owner sets it all in ONE place**: dashboard Settings › Users and access › Roles and permissions (each role: every
  group, every key, with what it shows) and a person's own overrides on their staff card. Business options that were
  admin-only move to the owner under Settings › Business (see "Moved from the admin portal").

## Rules for code

1. A check names a FINE key: `requirePermission('reports.sales')`, `can(req, 'menu.costs')` (server),
   `hasPermission(held, 'sales.void')` (clients, on `expandMap(session.permissions)`). `rbac.ts` refuses a non-catalogue
   key when the route file loads; `check-permission-catalogue` fails CI on a broad key in a check.
2. No role-name checks. "Is a manager" is a permission: `isBackOffice(held)` (holds anything beyond the cashier's floor
   keys) for routing, sign-in codes and device approval; a specific key for anything else.
3. The owner is never refused (`isOwner` / `'*'`). `isOwner`-only rules the owner asked for stay owner-only
   (void/refund rules, stock-count freeze, the KDS token, test e-mails, resetting someone's sign-in code).
4. Data a person may not see is not SENT (the cloud strips it), not merely hidden.
5. A till's own sign-in (no person) is limited to `TILL_KEYS` (`lib/tillScope.ts`), dry-run until `TILL_SCOPE_ENFORCE`.

## Cloud routes → keys

| Was | Route(s) | Now |
|---|---|---|
| products.manage | products / categories / variants / modifiers / combos create, edit, delete; bulk tax, bulk track, bulk import | `menu.edit` |
| products.manage | a product's price fields, bulk price, branch prices (`/branch-prices/sync`) | `menu.prices` (a product edit that changes no price needs only `menu.edit`) |
| products.manage | bulk cost; cost fields on product create/edit | `menu.costs` |
| products.manage | recipes, packaging | `menu.recipes` |
| products.manage | discounts, promotions, offers | `menu.offers` |
| products.manage / settings.manage | payment methods (custom) | `settings.payments` |
| products.manage / stations.manage | stations | `stations.manage` |
| settings.manage | `PATCH /business`, report schedule | `settings.business` / `settings.integrations` |
| settings.manage | branch update, set-main, deactivate, branch settings | `settings.branches` (branch `payment_methods_enabled` → `settings.payments`) |
| settings.manage | webhooks, QR settings | `settings.integrations` |
| settings.manage | devices | `devices.approve` |
| settings.manage | tables | `tables.manage` |
| settings.manage | printers | `stations.manage` |
| settings.manage | eTIMS | `etims.manage` |
| settings.manage | `/changes` decide (mayDecide) | `changes.approve` |
| settings.manage / shifts.force_close | day-close instruct / overview | `shifts.close_day` |
| settings.manage / shifts.force_close | shift force-close | `shifts.force_close` |
| receipt.manage / settings.manage | `POST /business/settings` per key: receipt keys → `receipt.manage`; `payment_methods_enabled` → `settings.payments`; loyalty keys → `settings.pos`; everything else → `settings.business` (void/refund rules and stock freeze stay owner-only) | |
| orders.void | `POST /orders/:id/void` | `sales.void` |
| orders.void | `POST /orders/:id/refund` | `sales.refund` |
| orders.void (approver) | the approver of a void / refund | holds `sales.void` / `sales.refund`, or is the owner |
| callerMayConfirm / mayConfirm / shifts.manage | confirm drawers, expected figures, foreign cash, closing another's drawer, kitchen-void and pay-out approval | `shifts.confirm` |
| (switch) cashier_no_money_out | cash in/out, drawer expenses | `shifts.cash_movements` (before 134: the switch still applies to anyone without `shifts.confirm`) |
| (switch) cashier_own_history | history scope | `sales.history_all` (before 134: the switch still applies to anyone without `shifts.confirm`) |
| reprint (isShiftManager) | reprint from history | `sales.reprint` |
| (none) | `POST /discounts/apply`; a LIVE web POS order with a manual discount | `sales.discount` (a till's offline sale is never refused for it) |
| reports.view | `/reports/sales`, `/master`, `/eod`, `/hourly`, `/orders/turnover/report` | `reports.sales` |
| reports.view | `/reports/products`, `/products-v2` | `reports.items` |
| reports.view | `/reports/staff` | `reports.staff` |
| reports.view | `/reports/shifts`; `/shifts/branch-report`, `/shifts/:id/zreport` | `reports.shifts` (zreport / branch-report: or `shifts.confirm`) |
| reports.view | `/reports/voids`, `/refunds` | `reports.voids` |
| reports.view | `/reports/inventory` | `reports.inventory` |
| reports.view | `/reports/fuel-sales`, `/pump-monitor`, `/wet-stock` | `reports.fuel` |
| reports.financial | `/reports/tax`, `/etims/invoices` | `reports.tax` |
| reports.financial | `/reports/food-cost`; net profit and expense lines inside `/master` (stripped without it) | `reports.costs` |
| reports.financial | `/reports/splh` | `reports.labour` |
| reports.financial | `/mpesa/exceptions` | `reports.payments` |
| reports.financial | `/reports/export/*` (+ the report's own key: sales→sales, products→items, pnl→costs, shifts→shifts, expenses→`expenses.view`, daily/hourly→sales, audit→voids) | `reports.export` |
| reports.financial / expenses.manage | monthly pack GET / export | `reports.monthly_pack` or `expenses.manage` (A481) |
| (none) | `/reports/overview`-type data the Overview page reads | `reports.overview` |
| (none) | `/orders/turnover` | `orders.view_all` |
| customers.manage | credit limit, repayment, adjustment | `customers.credit` |
| customers.manage | loyalty customer edit / delete; create (also `customers.view`, as before) | `customers.edit` |
| staff.manage | staff create / invite / edit / delete / overrides / PINs | `staff.edit` |
| staff.manage | role permissions, create / rename / delete role | `staff.roles` |
| (none) | `GET /staff`, `GET /branches/:id/staff` | `staff.view` |
| (none) | reservations, waitlist | `reservations.manage` |
| (none) | parking | `parking.manage` |
| (none) | fuel tanks, pumps | `fuel.manage` |
| (none) | GET product / ingredient / stock / GRN cost fields | stripped unless `menu.costs` or `reports.costs` |
| role names | role ceiling (ELEVATED_ROLE_NAMES) | `keysBeyond(caller, role keys)` must be empty; the owner role is the owner's |
| role names | device-registration exemption, sign-in codes (roleNeedsOtp), web routing | `isBackOffice(held)` |
| role names | daily summary / alert e-mail recipients | non-owner staff of the branch holding `reports.overview` |

## API (cloud)

**Sign-in.** `/pos-login`, `/verify-pin` answer `permissions` = `clientPermissionMap(held)` (fine + legacy + marker, or
`{'*':true}`); tokens carry `tokenKeys(held)`. `POST /auth/refresh` answers `permissions` too for a person's token.
`GET /api/pos/branch-staff` roster: each person's `permissions` = `clientPermissionMap`.

**Roles** (`routes/staff.ts`):
- `GET /api/staff/permissions` → array of `{ id, key, label, description, group, surface }` — fine keys only, in
  catalogue order; plus `GET /api/staff/permission-groups` → `PERMISSION_GROUPS`.
- `GET /api/staff/roles` → each role: existing fields + `keys: string[]` (fine), `is_owner_role`, `assignable`,
  `editable`, `members` (count).
- `PUT /api/staff/roles/:roleId/permissions` `{ keys: string[] }` (or the old `{ permission_ids }`) — `staff.roles`;
  never the owner role; never beyond the caller's own keys. Stores fine keys only.
- `POST /api/staff/roles` `{ name, description?, keys?, copy_from?: roleId }` — `staff.roles`.
- `PATCH /api/staff/roles/:roleId` `{ name?, description? }`, `DELETE /api/staff/roles/:roleId` (409 `ROLE_IN_USE`
  with `members` while anyone holds it) — `staff.roles`; never the owner role.
- Staff create/edit accept `override_keys: { [key]: boolean }` (besides `overrides` by id); `GET /api/staff` returns
  each person's `override_keys`.

**Owner controls** (`routes/controls.ts`, `/api/controls`):
- `GET /api/controls` → `{ pos?: { delivery_fee, pay_later_tabs, pay_before_kitchen, login_codes }, loyalty?: {
  enabled, earn_rate }, payments?: { enabled: string[] } }` — each section only with its key (`settings.pos`,
  `settings.pos`, `settings.payments`).
- `PUT /api/controls/pos/:key` `{ enabled }` — `settings.pos`; key one of the four above.
- `PUT /api/controls/loyalty` `{ enabled?, earn_rate? }` — `settings.pos`.
- `PUT /api/controls/updates` — refused for everyone (403 `ADMIN_SETS`): A493, ZapTill approves a client's till version
  in the admin portal (`PATCH /api/admin/clients/:id/desktop-version`).
- Business-wide payment methods: `POST /api/business/settings` `payment_methods_enabled` (`settings.payments`).

## Moved from the admin portal to the owner

| Setting | Owner sets it | Admin portal |
|---|---|---|
| Delivery fee and rider, pay later, pay before kitchen, sign-in codes | Settings › Business › POS options (`settings.pos`) | shows it, read-only |
| Cashiers see only their own sales; only managers move money; no reprint for cashiers | per role: `sales.history_all`, `shifts.cash_movements`, `sales.reprint` | shows "now set per role" |
| Loyalty on/off and earn rate | Settings › Business › POS options (`settings.pos`) | read-only |
| Till updates approve / hold | — **stays with ZapTill** (A493: some clients do not pay for updates) | approves and holds |
| Payment methods | Settings › Business › Payments (`settings.payments`) — business-wide list added | — |

Stays admin-only: licence and plan, branch licences, billing, web hosting / web access, themes, clear test data.

## Migration 134 (`134_permission_catalogue`)

1. Registers every fine key (label, group as module, description) and updates the labels of keys that already exist.
2. Per role: the stored keys are replaced by `expandKeys(stored)` — the fine keys they stood for (nothing gained, nothing
   lost); per person override rows likewise (a taken-away broad key becomes taken-away fine keys).
3. The keys nobody was refused before go to every role that could sell (`orders.create`), except:
   `sales.history_all` and `shifts.cash_movements` where the business had `cashier_own_history` /
   `cashier_no_money_out` on — then only to roles that can confirm drawers (`shifts.confirm`) — and those two switches
   are switched off (the role now decides). `staff.view`, reservations, parking and fuel go to every role.
4. The owner's role keeps everything (it is `'*'` by name; its rows are rewritten like any other).
5. Owners' database sessions may READ `feature_flags` and `businesses` but no longer write them directly (the cloud,
   which checks permissions and admin-only settings, writes them).
6. Records `134_permission_catalogue` — from then on the cloud stops giving everybody the open keys.

## Later gates (A494, A495, A499 — 2026-10-15 audit)

- **A cashier is not back office** (A499): the POS actions a cashier may be given (`POS_ACTION_KEYS`: customers.credit,
  sales.void, sales.refund, sales.reprint) never send them to the manager screens or ask them for a sign-in code.
- **Reads now gated:** GRNs (`inventory.receive`), transfers (`inventory.transfer`, the caller's branch), stock movements
  (`inventory.view`, the caller's branch), credit customers (`customers.view` or `customers.credit`), loyalty lists
  (`customers.view`; the exact-phone lookup stays open for the POS), webhooks (`settings.integrations`), devices
  (`devices.approve`, devices in reach).
- **Owner only:** M-Pesa credentials, reversal rules, the stock-count freeze, any business setting
  not on the `settings.business` list; sign-in codes (`PUT /api/controls/pos/login_codes`); changing promotions (they run
  at every branch — a branch's own deal is an Offer).
- **Costs and prices:** cost writes need `menu.costs` (a typed cost is replaced by the stored one); price changes on
  combos, variants and modifiers need `menu.prices`.
- **Approvers** (void, refund, payouts, drawer confirms): must work at the branch; only the owner approves their own action.
- **A till's own session** never holds a person's key for reads (History, reprint, stock counts, write-offs); it pushes
  what the till did (sales, drawers, offline voids and refunds) and that is all.

## Built-in roles and approval PINs (A514 — 2026-10-16)

- **Built-in roles:** `BUILT_IN_ROLES` in shared/permissions.ts is the one place their defaults live — Manager and Cashier
  (the catalogue's manager / cashier flags), Supervisor, Waiter, Kitchen, Storekeeper, Accountant, and Fuel attendant at a
  fuel business (`FUEL_BUSINESS_TYPES`: petrol_station). New businesses are seeded from it (lib/defaultRolePermissions.ts
  `seededRoleRows`, `defaultKeysForRoleName`); migration 142 adds the missing ones to every existing business (nobody
  assigned; a role of the same name is never touched). They are ordinary roles — the owner edits, renames or deletes them.
- **Migration 141:** roles named waiter or teller lose staff.view and customers.credit once (140 did cashier).
- **The business supervisor PIN is retired:** only people's own PINs approve — their sign-in PIN or the approval
  (override) PIN an owner or manager gives them in Staff. Who may be given one: someone holding sales.void, sales.refund,
  customers.credit or shifts.confirm (`APPROVAL_PIN_KEYS`, routes/staff.ts). POST /api/business/settings answers 410
  `SUPERVISOR_PIN_RETIRED` for any supervisor_pin key; the stored hash is left untouched and never read.
- **A518 — one PIN is enough:** an approver's **sign-in PIN approves** voids, refunds, sales on account, pay-outs and drawer
  confirmations as it is (lib/approver.ts `findApprover`, lib/confirmerLookup.ts; the till's offline approvals use
  sign-in PINs too). The approval PIN in Staff is **optional** — a second PIN for someone who would rather not type their
  sign-in PIN in front of cashiers. A branch where nobody who may approve has any PIN answers 400 `NO_OVERRIDE_CONFIGURED`
  ("…gives someone who may approve a PIN in Staff"), never counted by the PIN limiter — voids / refunds / credit (A514) and,
  since A518, pay-outs, expenses, drawer confirmations and kitchen voids.
- **A518 — payables.view:** "See supplier bills" — the supplier balances, bills, payments and returns, read-only (the
  Accountant's; migration 143 gives it to every role holding payables.manage, the built-in Accountant roles and the owner
  roles). Writes stay payables.manage.
