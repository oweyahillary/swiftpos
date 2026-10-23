# Business-type wording and visibility (A573)

Owner, 2026-10-22, on Magas Limited's dashboard (a **retail** business: CATALOGUE › Menus, "Group your categories into
menus — Food, Soft drinks, Alcohol, Tea …"):

> "the items in the navigation bar, strangley enough in retail businness their is a menu item i dont know if this is
> replicated across all businesses please read all business menu and name items correctly ensure hotel references hav
> been removed everywere and correct items replace them even if it means creating new tables in the db"

"Hotel" is Kenyan usage for an eatery: the complaint is food-service words and features showing for shops.

**One source of truth:** `shared/businessTerms.ts` (copies: `apps/dashboard/src/lib/businessTerms.ts`,
`apps/desktop/src/shared/businessTerms.ts`; checked by `scripts/check-shared-sync.mjs`). It maps the business type to its
words (`businessTerms`) and to the food-service areas it sees (`foodAreas`), and gives a shop its words for the permission
catalogue at display time (`permissionWords`, `permissionGroupWords` — the catalogue's own words are frozen by migration
134). Nothing in the database or the API is renamed (`menus` table, `/api/menus`, `menu_id`, the `menu.*` keys stay).
**No migration** — the "menu" grouping (A537 / A566) already is a department or a group; only its name was wrong.

How a screen knows the type: the owner's dashboard reads `business.type` (BusinessContext); the web POS and the manager
portal `session.businessType` (pos/init); the till `modeFlags(business_type).mode` (lib/posMode.ts). A type not loaded yet
reads the restaurant's words, as the dashboard always did.

## The words

| Word | restaurant, cafe | retail, minimart | petrol_station | parking | other |
|---|---|---|---|---|---|
| A group of categories (A537 menus) | Menu / Menus | Department / Departments | Department / Departments | Group / Groups | Group / Groups |
| Examples | Food, Soft drinks, Alcohol, Tea | Groceries, Beverages, Household, Personal care | Lubricants, Shop, Gas, Car wash | Parking, Car wash, Permits | Services, Products, Accessories |
| Web sidebar catalogue section | Menu | Catalogue | Catalogue | Catalogue | Catalogue |
| Web sidebar stock section | Inventory | Stock (was "Purchasing") | Stock | Stock | Stock |
| Catalogue page (till Manager, manager portal) | Menu | Products | Products | Products | Products |
| Products / categories | Menu Items / Menu Sections | Products / Categories | Products / Categories | Products / Categories | Products / Categories |
| Setup tab (Settings › Business) | Restaurant setup / Café setup | Retail setup / Minimart setup | Petrol setup | Parking setup | Setup |
| Food-service areas (KDS, reservations, combo meals, ingredients, table turnover, tables and floor plan, room charge, kitchen POS switches) | shown | hidden | hidden | hidden | hidden |

Why these words: supermarkets and minimarts commonly organise the shop floor and their POS in **departments** (Groceries,
Beverages, Household …); a petrol station's forecourt shop
and lubricants are departments too. A car park or an unknown kind of business gets the neutral **Groups**. Restaurants and
cafés keep **Menus** (Food, Soft drinks, Alcohol, Tea) exactly as before.

## restaurant / cafe

| Surface | Current wording | Correct wording / visibility | Status |
|---|---|---|---|
| Web sidebar: Menu › Menus, Menu Sections, Menu Items, Set Meals; KDS, Reservations, Ingredients, Table Turnover | as listed | unchanged | OK (pinned by the A573 test) |
| Menus page | "Group your menu sections into menus — Food, Soft drinks, Alcohol, Tea … as tabs in its category panel" | same words; "as tabs across the top of its items" (A566 moved them there) | FIXED (outdated sentence) |
| Web POS / till top tabs and panel | Menus, All menus | unchanged | OK |
| Till Manager › Menu [Menu · Offers] | Menu | unchanged | OK |
| Settings › Business › Restaurant setup (tables, floor plan, service, menu periods) | shown | shown | OK |
| Retail wording leaking in | none found ("Print labels", "Other branches" are useful to a restaurant too) | — | OK |

## retail / minimart

| Surface | Current wording | Correct wording / visibility | Status |
|---|---|---|---|
| Web sidebar, Catalogue › **Menus** (Magas Limited's screen) | Menus; hint "Food, Soft drinks, Alcohol, Tea — each holds some of your categories" | **Departments**; hint "Groceries, Beverages, Household, Personal care — …" | FIXED |
| Web sidebar stock section | PURCHASING (holds Purchase Orders, Suppliers, Transfers, Counts, Wastage, Expiry) | **Stock** | FIXED |
| Web sidebar: KDS, Reservations, Combo Meals, Ingredients, Table Turnover | hidden (A133) | hidden — the list now comes from `foodAreas` | OK |
| Menus page (title, intro, placeholder, icon, button, empty state, delete dialog, errors) | Menus · Food, Soft drinks, Alcohol, Tea · "New menu, e.g. Soft drinks" · 🍔 · "+ Add menu" · "No menus yet" · "Delete the X menu?" | Departments · Groceries, Beverages, Household, Personal care · "New department, e.g. Beverages" · 🛒 · "+ Add department" · "No departments yet" · "Delete the X department?" | FIXED |
| Categories page: the select on each category and in the form | "Menu", "No menu", "(a deleted menu)" | "Department", "No department", "(a deleted department)" | FIXED |
| Products page: "Menu upload" button, modal title, toast, template title "Restaurant menu upload template" | menu / restaurant | "Product upload", "ZapTill — Product upload template" | FIXED |
| Promotions page hint "(Menu › Offers)" | Menu | "(Catalogue › Offers)" | FIXED |
| Settings › Business › **Setup** | "Setup" → the restaurant's page (Dine-in Settings: Tables, Floor plan, Service — waiters, kitchen — Menu periods) for **retail** (minimart had its own) | **Retail setup** → the shop's page (scanner, products and barcodes, bulk import); title from the type | FIXED |
| Settings › Devices and printers › **Kitchen display** tab | shown to every type | restaurant / café only (the sidebar KDS was already) | FIXED |
| Settings › Business › POS options: "Eat now, pay later", "Pay before kitchen" | shown to every type | restaurant / café only — still listed wherever already ON, so a shop can turn it off | FIXED |
| Settings › Roles and permissions (and a staff card's own rights) | "See the menu", "Edit the menu … extras", "Item mix and menu matrix", "… send orders to the kitchen …", "… table turnover", "Food cost …", group "Menu" | "See the products", "Edit the products (… departments …)", "Item mix", "Ring up sales, hold and recall bills and take payment", "Orders and shifts pages", "Cost prices, margins …", group "Catalogue" (display time; the catalogue's words are untouched) | FIXED |
| Manager portal sidebar: **Menu**, **Turnover** (Table Turnover: live dine-in tables) | Menu; Turnover shown to every type | **Products**; Turnover restaurant / café only | FIXED |
| Manager portal › Menu page | "Menu … Menu changes are made by the owner." | "Products … Changes to products are made by the owner." | FIXED |
| Web POS (retail uses CashierScreen, minimart MinimartPOS): top tabs, panel tabs, chip | aria "Menus", "More menus …", "All menus", "Food menu" | "Departments", "More departments …", "All departments", "Groceries department" | FIXED |
| Web POS on a phone: back from the cart | "← Back to the menu" | "← Back to the items" | FIXED |
| Web POS: tables, KOT, Send to kitchen, Split bill, Room charge | gated by `isRestaurant` | unchanged | OK |
| Till Manager sidebar | Menu [Menu · Offers]; page heading "Menu" | **Products** [Products · Offers]; heading "Products" | FIXED |
| Till Manager › Import | "Import menu from a spreadsheet", "Download a template with your menu" | "Import products …", "… with your products" | FIXED |
| Till sale screen: top tabs, panel, chip | Menus, All menus, "Food menu" | Departments, All departments, "Groceries department" | FIXED |
| Till Labels: note | "… needs menu editing" | "… needs the right to edit products" (every type) | FIXED |
| Till: order types, tables, KOT, held tabs | `modeFlags().isRestaurant` | unchanged | OK |
| Built-in roles Waiter, Kitchen, Kitchen Manager | seeded for every type (A514 / migrations 142, 159) | restaurant / café only; the unused ones removed from shops (migration 169) | FIXED (A580, owner 2026-10-23) |
| Standard receipt "Kots: 0" line | printed on every standard receipt | none on a shop's receipt (restaurant / café unchanged) | FIXED (A580, owner 2026-10-23) |

## petrol_station

| Surface | Current wording | Correct wording / visibility | Status |
|---|---|---|---|
| Web sidebar Catalogue › Menus | Menus | **Departments** (Lubricants, Shop, Gas, Car wash) | FIXED |
| Web sidebar stock section | Purchasing | Stock | FIXED |
| Menus / Categories pages, web POS, till | menu words | Department words (as retail) | FIXED |
| Kitchen display tab, kitchen POS switches, roles words, manager portal Turnover / Menu | food words | hidden / product words (as retail) | FIXED |
| Overview, reports, fuel pages, Petrol setup, Fuel attendant role | petrol-specific already | unchanged | OK |

## parking

| Surface | Current wording | Correct wording / visibility | Status |
|---|---|---|---|
| Web sidebar Catalogue › Menus | Menus | **Groups** (Parking, Car wash, Permits) — kept, not hidden: a car park may sell washes or permits, and its groups may already exist | FIXED |
| Web sidebar stock section | Purchasing | Stock | FIXED |
| Menus / Categories pages, web POS, till | menu words | Group words | FIXED |
| Kitchen display tab, kitchen POS switches, roles words, manager portal Turnover / Menu | food words | hidden / product words | FIXED |
| Overview, Parking setup, bays | parking-specific already | unchanged | OK |

## other

| Surface | Current wording | Correct wording / visibility | Status |
|---|---|---|---|
| Web sidebar Catalogue › Menus | Menus | **Groups** (Services, Products, Accessories) | FIXED |
| Settings › Business › Setup | the restaurant's page (tables, floor plan, waiters, menu periods) | the shop's page ("Setup": scanner, products and barcodes, bulk import) | FIXED |
| Everything else | as retail | as retail (Groups instead of Departments) | FIXED |

## "hotel" in user-visible text

| Where | Before | After | Status |
|---|---|---|---|
| Web POS › Post to Room (restaurant / café only) | "Charge KES … to a hotel room — guest settles at checkout." | "Charge KES … to a guest's room — the guest settles at checkout." | FIXED |
| Every other "hotel" in apps/ and shared/ | code comments quoting the owner (businessDay, reversalRules, MinimartPOS's VAT note, a desktop test) | comments stay | OK |

`tests/business-terms-a573.test.mjs` scans apps/dashboard, apps/desktop, apps/admin, apps/server and shared for a
user-visible "hotel" (comments excluded) and fails on one.

## Left for the owner to decide (not changed)

1. ~~**Built-in roles Waiter, Kitchen and Kitchen Manager**~~ — **DECIDED and FIXED in A580** (owner, 2026-10-23: "how can
   shops have waiter and kitchen roles unless requested keep them off we only have cashier and other roles"):
   shared/permissions.ts BUILT_IN_ROLES gives them `types: FOOD_BUSINESS_TYPES` (restaurant, cafe) — a new retail,
   minimart, petrol station, car park or "other" business is created with Manager, Cashier, Supervisor, Storekeeper,
   Accountant and the A550 roles (Fuel attendant at a petrol station), never a waiter or kitchen role; a business that
   becomes a restaurant or café is given them (addTypeRoles). **Migration 169** deletes, once, the built-in (is_default)
   Waiter / Kitchen / Kitchen Manager roles of every non-food business that NOBODY is on (active or inactive staff); a
   role with staff on it stays. A shop that wants one adds it on request: Settings › Roles and permissions › New role
   (name it "Waiter", tick its keys or copy another role) — it is not refilled with the built-in keys automatically.
2. ~~**"Kots: 0" on a shop's standard receipt**~~ — **DECIDED and FIXED in A580**: shared/printing's `kitchenTickets`
   (false for retail, minimart, petrol_station, parking, other — the till from device_config.business_type, the web from
   the business's type) leaves the line out; a restaurant's or café's receipt is byte for byte as before.
3. ~~**Analytics**~~ — **FIXED in A575**: `shared/analyticsTerms.ts` analyticsWords — a shop reads "Product performance",
   "items you sell with no cost", "Cost of sales", "items removed", "what to push and stock" (web page and the cloud's
   cards and tiles); a restaurant or café keeps its words.
4. ~~**The Help card**~~ — **FIXED in A575**: `helpTopicsFor(isFoodService(type))` leaves the kitchen-ticket step out for a
   shop, on the web Help page and the till's Help screen.
5. **The cloud's errors on /api/menus** ("Menu not found", "… already exists") are pinned by tests and rarely seen; a shop
   would read "menu" in such an error.
6. ~~**The upload template's help line**~~ — **FIXED in A575**: a shop's line names its own word ("the product's
   department, e.g. Groceries …"); the column stays `menu`.
7. **The till's Item Mix** is restaurant-only (A105); a shop would find it useful too (the reverse case). Owner,
   2026-10-23 (A580): stays restaurant-only — no change.
8. **Admin portal** › Test data "Also delete the whole menu" — ZapTill staff only; left.
9. ~~The till's old `MenuTab`~~ — **FIXED in A575**: still imported (so not deleted), its category list and messages now
   take businessTerms ("No department" at a shop).

## Tests

- `tests/business-terms-a573.test.mjs` — the helper per type; the web sidebar, the Menus page and Settings › Business
  rendered per type (esbuild + react-dom/server, contexts stubbed); the roles screen's words; the web POS's bar and panel;
  pins on the manager portal, POS options and Devices; no user-visible "hotel".
- `apps/desktop/test/business-terms-a573.test.mjs` — the till: the Manager sidebar (Menu / Products), the sale screen's
  top tabs and panel (Menus / Departments), the wiring in POSPage and ManagerPage.

Screenshots: `docs/screenshots/business-terms-a573-retail-before.webp`, `…-retail-after.webp`,
`…-restaurant-before.webp`, `…-restaurant-after.webp` (the real sidebar and Menus page, demo data).

## A575 — What sells together, per type

The advice for two products bought together (`shared/analyticsTerms.ts` togetherAdvice), never a price:

| Type | Card | Table |
|---|---|---|
| restaurant, cafe | "Offer Soda with Chicken Wrap" — make them a combo, or remind cashiers and waiters | Offer together or as a combo |
| retail, minimart | "Put Milk next to Bread" — the same shelf or near the till, both in stock | Same shelf or near the till |
| petrol_station, one item fuel | "Offer Water 1L at the pumps" — at the pump island, attendants offer it | Offer at the pumps |
| petrol_station, shop items | "Put Coolant next to Engine oil" — together in the forecourt shop or near the till | Side by side in the shop |
| parking, other | "Offer Car wash with Parking 1 hr" — show them together, cashiers offer | Offer together |
