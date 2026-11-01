# A619 — Delivery platform prices (Glovo, Uber Eats, Bolt Food)

**Owner, 2026-11-01.** Glovo, Uber Eats and Bolt Food charge fees, so a client's prices there are higher: *"assume 3 piece
chicken is 1000 normal price ordering with glovo it is 1150 a 15% bump so the receipt shows 1150 not the percentage
increase but the price in glovo."* And: *"why cant we maintain the same but the moment a cashier picks glovo or uber eats
as the payment method the price changes"*; *"a confirmation of payment method when a cashier clicks charge glovo, uber but
cash there is no need."*

Works for every kind of business (a restaurant, a shop, a petrol station's shop …) on the web POS and the desktop POS,
offline too.

## 1. What the owner sets

- **Each platform's uplift** — Payment methods page (the business default) and Settings › Branches › a branch (that
  branch's own, which wins; "Back to the default" clears it):
  - **a percentage**: +15% → 1,000 becomes 1,150;
  - **or a fixed amount on every item**: +250 → a 350 soda becomes 600; quantity 2 = 2 × 600.
  - Blank or 0 = normal prices.
- **The rounding, once for the business** (Payment methods page): exact (to the cent), nearest shilling, up to the nearest
  5, up to the nearest 10. It applies to each bumped item price.
- **An item's own platform price** (optional) — Products › an item › *Delivery platform prices*: it wins over the
  uplift for that item (drinks unchanged, a hand-priced combo). Shown when the business takes a delivery platform.

## 2. At the POS

1. The sale is rung at normal prices, as today.
2. The cashier picks **Glovo / Uber Eats / Bolt Food** as the payment method: every item (its add-ons too) is re-priced
   and the screen says it plainly — *"Glovo prices: 1,000 → 1,150"* — with the new total. Picking Cash, M-Pesa or any
   other method again restores the normal prices.
3. The platform pays the **whole bill**: no split with another method while a platform is chosen.
4. **Charge asks first, for a platform only:** *"Charge to Glovo? Glovo prices: 1,000 → 1,150"*, with the Glovo order #
   in the same box, **Back** / **Charge to Glovo**. It asks even when the platform has no uplift. Cash, M-Pesa and the
   rest charge at once, as now.

**The sale is saved at the platform's prices:** the items, the receipt, VAT and eTIMS show the platform price only (never
a "+15%" line). Offers are worked out again on the platform prices; a percentage discount follows them, a fixed one
stays. The order keeps which platform's prices applied and the rule (e.g. +15%, up to 10), so a later change of the rate
never rewrites history.

Lines with no catalogue item (a parking bill, a quick charge) keep their price. A bill opened earlier and
paid later on the web (order first) is charged at the prices it was opened at.

## 3. Reports

Reports › the sales report's *Payment Methods* — sales by platform as before, and under each platform **"of which
uplift"**: what its prices added (the platform total minus the same items at normal prices).

## 4. How it is checked

- **One rule, one file:** `shared/platformPrices.ts` (copied to the web, the desktop's screen and main process, and the
  cloud; `scripts/check-shared-sync.mjs`).
- **The cloud** prices a platform sale itself from its own catalogue and the branch's rule (`routes/orders.ts`) — a POS
  cannot claim a made-up "platform price". A web sale at a wrong price is refused, as any wrong price; a desktop sale
  made offline at an older rate is kept at its price and the difference recorded (Reports › Voids & Exceptions), as for
  any price changed before it synced.
- **The desktop POS** checks the screen's figures against its own rules before saving (offline too), and refuses a split.
- **The branch server** passes the rules and the items' own prices to its POSs.

## 5. Data (migration 187, `migrations/187_platform_prices.sql`)

- Settings: `delivery_platform_prices` (business default, branch override) and `delivery_platform_rounding` (business).
- `products.platform_prices` — an item's own price per platform.
- `orders.price_list`, `orders.platform_rule`, `orders.platform_uplift` — what applied to a sale.

**Run order:** any time. Before it runs, POSs charge the platform rule without own item prices, the sale's record is
not kept (the sale itself always is) and the report shows no uplift. The desktop's local schema is 79.
