# A617 — Basic themes for everyone, own prices per client

**Owner, 2026-11-01.** A612 bills the cloud per branch, and premium per branch. Migration 182 gave every branch an
empty premium list, so on its own every current client would lose Themes the day it reaches production. Facts: no client
has Analytics or Attendance; **every current client has Themes on**.

**Owner's decisions:**
- **Current clients keep Themes, free.**
- **Per-client prices.** A client can have its own price for an add-on or for the package.
- **Basic themes for everyone, the rest premium.**

## 1. Free and premium

| Free to every business | Premium (Themes: the business's switch on AND the branch paying) |
|---|---|
| ZapTill's default look | Violet, Lagoon, Orchid, Blossom |
| Ocean, Teal, Sky | Own brand colours (primary and secondary) |
| Logo on the dashboard, lock screen and receipts (as before) | Logo and colours on the customer screen |
| Lock-screen colour (as before) | A branch's own look (theme, colour, receipt footer) |

The free list is in ONE place: `FREE_THEME_IDS` in `shared/themes.ts` (and its four synced copies). Every gate uses it:

- **Choosing** (`routes/business.ts` → `themeRules.ts themeWriteError`): a free theme is accepted without Themes; any
  other is refused ("part of Themes … ask ZapTill").
- **What a POS wears** (`themeRules.ts effectiveThemeId`, used by `/pos/init`, a branding change and the reprint's
  `/served`): without Themes, the free theme chosen, else ZapTill's default look. With Themes, as before.
- **The customer screen** (`customerScreen.ts`, 5 copies): a free theme id no longer means "Themes", so `/pos/init`
  now also says `themesPremium`. The logo and colours need it. The desktop keeps it (`maintenance_state`
  `themes_premium`) and a branch server passes it to its POS. A POS not yet updated reads the theme id as before, so on
  it a client without Themes who picks a free theme would also see the logo on the customer screen until it updates.
- **The dashboard and web POS** (`lib/themeVars.ts`): without Themes, the free theme chosen (never the brand colours).
- **Branding page:** the App theme section shows for every business. Without Themes: a "ZapTill default" choice, Ocean,
  Teal and Sky; the other themes greyed out with "Premium"; a note naming what Themes adds.

## 2. Own prices (`branch_cloud_plans.own_prices`, migration 185)

- Optional, per branch: `analytics`, `attendance`, `themes`, `package`, each KES a month, 0 or more. A price not set =
  ZapTill's price (Billing details). The Cloud has no own price here: the branch's Cloud amount already is its own.
- The bill (`lib/branchBilling.ts branchBill`) uses the branch's own price when set. The invoice line shows the price
  that applied; an own price is its own line ("Themes × 1 · KES 0" beside "Themes × 2 · KES 1,000").

**How to set one** (admin portal, super admin): client → Plan & billing → Cloud per branch → **Edit** on the branch →
**Own prices, a month**. Type a price, or leave it blank for ZapTill's (shown greyed in the box); 0 makes it free. Save.
The table marks the branch "own price" (hover for the prices). The save is audited (`cloud_plan.branch`).

The API: `PUT /api/admin/clients/:businessId/cloud-plan/branches/:branchId` with `own_prices: { themes: 0, package:
12000 }`. Keys not sent are kept; `null` or blank clears one; `own_prices: null` clears all. An unknown key, a negative
or a word → 400 `BAD_OWN_PRICE`.

## 3. Current clients keep Themes (migration 185)

Once (guarded by its own `schema_migrations` row), every branch row of a business with the `themes` switch on gets
`themes` in its premium (never twice) and an own Themes price of 0 (only when it has no own Themes price yet). Nothing
else changes; businesses without the switch are untouched.

**New branches of current clients get it too** (owner, 2026-11-01: "they do not pay for now"). The same once, migration
185 sets ZapTill's own flag `themes_free` on every business that had Themes. While it is on, every branch row the server
makes starts with Themes at an own price of 0:
- a branch ZapTill adds to a client billed per branch;
- the first save of a branch that had no row;
- **Bill per branch** switched on later.

An admin's own choices on that first save win, and existing rows are never changed by the deal. Brand-new clients have no
flag, so they pay the global Themes price.

**Ending the deal:** the client's **Branch billing** card says "Free Themes …" with **End the deal** (super admin only;
the flag is a paid switch like web access). New branches then start without Themes; branches already on it keep Themes
at 0 until you edit them.

## 4. Run order

- **185 after 182** (it adds a column to 182's table).
- **Before or after the server deploy:** both safe. The server reads the plans with `*`, and a branch save that sends
  own prices to a database without the column saves the rest and says "Saved without the own prices: the database needs
  migration 185 first."
- On production, run **182 and 185 together** (185 straight after 182), so no client is ever without Themes. Until
  185 runs on a database where 182 has, its clients' POS go to their free theme or the default look.

## 5. Tests

`tests/a617-themes-basic-and-own-prices.test.mjs` (own prices: the rules, the billing job, the admin save and its checks,
a database before 185; the free-theme gates; four mutations seen to bite) and `scripts/test-migration-185.mjs` (PGlite,
every migration). Updated for the new rules: `tests/theme-access.test.mjs`, `tests/branding-theme-picker.test.mjs`,
`tests/web-pos-theme.test.mjs`, `tests/branch-branding-a544.test.mjs`. CI step "Basic themes for everyone and own prices
per branch (A617) and migration 185".
