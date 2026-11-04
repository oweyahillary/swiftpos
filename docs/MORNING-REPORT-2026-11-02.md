# Night report — 1 November 2026 (evening build)

Three items, all on `dev`, uncommitted until you commit. Built from `a1f589d` (A617).

## 1. M-Pesa STK details per branch (A618, migration 186)

- **Where:** Settings › Business › **Payments** › **M-Pesa (STK push)**, for the owner only.
  - The **business default**, plus a row per branch: "Own settings" or "Uses the business default".
  - Fields: Paybill or Buy Goods, shortcode, **Buy Goods Till number**, consumer key, consumer secret, passkey,
    Sandbox / Live.
  - The secret and passkey are encrypted and never shown back; leave them blank to keep them.
- **Test connection:** asks Daraja for a token with the details a payment at that branch would use. Nobody is charged.
- **Receipt warning:** when the receipt's M-Pesa number differs from where STK payments go, e.g. *"Receipts at this branch
  say Buy Goods 163726, but STK payments go to Paybill 174379."* (exactly what B Foods' receipt showed today).
- **Payments use the sale's branch:** the web POS uses the order's branch; the desktop POS uses its own branch. Buy Goods
  pays the Till number.
- **Before migration 186:** payments carry on with the business default.
- **Today's dev test:** the details you put in by SQL are now B Foods' business default.

Design note: [docs/A618-branch-mpesa.md](A618-branch-mpesa.md).

## 2. Free Themes for current clients' new branches (A617 follow-up, migration 185 changed)

- **Migration 185** also sets ZapTill's own flag `themes_free` on every business that has Themes when it runs.
  Clients cannot set this flag.
- **While the flag is on,** every branch billing row the server makes starts with Themes at KES 0:
  - a branch you add;
  - a branch's first per-branch save;
  - **Bill per branch** switched on later.
- **Your choices win:** anything you set on that first save overrides the deal, and existing branches are never changed.
- **Branch billing card:** it shows the deal, with **End the deal** (super admin only).
- **On dev,** 185 already ran before this change. To try the deal there, set the flag by hand (see "Then on dev").

## 3. Delivery platform prices (A619, migration 187)

- **Settings › Payment methods:** a percentage or an amount per item for each platform (Glovo, Uber Eats, Bolt Food), and
  the business's rounding.
  - Rounding options: exact, nearest shilling, up to the nearest 5, up to the nearest 10.
  - A branch can override the rate for the platforms it takes.
- **Own price per item:** on the product form, per platform.
- **On the POS (web and desktop, offline too):**
  - Ring up as normal.
  - Pick Glovo, and every line is re-priced: *"Glovo prices: 1,000 → 1,150"*. Offers are recalculated, a % discount
    scales, and split payment is hidden.
  - **Charge** asks *"Charge to Glovo?"* with the order # field. Cash and the other methods charge straight away.
- **The receipt, VAT and eTIMS** show only the Glovo price.
- **The cloud and the desktop each work out the price themselves,** so a POS can't send an arbitrary "Glovo price". The
  sale records the rule used and the uplift.
- **Reports:** the master report's Payment methods section shows "of which uplift" under each platform.
- **Desktop local schema 79:** POS on 1.0.22 keep working at normal prices. 1.0.23 has to go out after the merge.

**Not done (none of these can charge a wrong amount):**
1. **A web bill opened first and paid later** is charged at the prices it was opened at. The screen says so. Tell me if
   the client opens tabs for Glovo orders.
2. **The desktop's own shift and daily reports** have no "of which uplift"; only the cloud report has it.
3. **The customer screen** shows normal prices while the cashier is paying.
4. **If an item's own platform price changes while it's in a desktop cart,** payment is refused with "prices changed —
   open it again".

Design note: [docs/A619-delivery-platform-prices.md](A619-delivery-platform-prices.md).

## Checks

**Full local CI:**
- 272 steps. Two failures were ours, and both are fixed:
  - **Catalogue refresh signal (desktop):** the test's stand-in config lacked A619's setter.
  - **Watchdog calls (A598):** the test's sample POS had schema 78 hard-coded as "current". It now reads the current
    number, so 79 is up to date.
- The rest is the usual Windows noise: no `python3`, the migrations `npm install`, the libuv exit crash after
  "N passed", and the time-zone case in desktop money reports.

**Per-file loop:** 322 OK. Besides the noise, one failed: the watchdog test above, now fixed.

**Migration tests:**
- 99 of 103 passed.
- 100, 101 and 102 ran out of memory in the batch, then passed on their own (10, 8 and 6 checks).
- 41–42 is the usual "all green" case.

**New tests:**

| Test | Checks |
|---|---|
| A618 | 20 |
| Migration 186 | 9 |
| A617 | 25 |
| Migration 185 | 10 |
| A619 pricing | 26 |
| A619 cloud | 22 |
| A619 desktop | 26 |
| Migration 187 | 9 |

## Commit (Git Bash)

```bash
cd /c/swiftpos/pos
git add .github apps docs migrations scripts shared tests
git status --short
git commit -m "M-Pesa STK details per branch (A618, migration 186): Settings > Payments > M-Pesa (STK push) for the owner, the business default and each branch's own (Paybill or Buy Goods with its Till number, keys encrypted and never shown, Test connection, a warning when the receipt's M-Pesa number differs), every STK prompt uses the sale's branch; free Themes for current clients' new branches (A617, migration 185 sets ZapTill's themes_free flag; new branch rows start with Themes at 0; End the deal in Branch billing); delivery platform prices (A619, migration 187, desktop schema 79): a percentage or an amount per item per platform and branch, the business's rounding, an own price per item, the POS re-prices when Glovo, Uber Eats or Bolt Food is picked and asks to confirm, the cloud and the desktop price it themselves, of which uplift in the master report" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin dev
```

## Then on dev

1. Run migrations **186** and **187**, in that order (`psql.exe -v ON_ERROR_STOP=1 -f migrations/186_branch_mpesa.sql "$DEV_DB_URL"`, then 187).
2. **Optional,** to try the free-Themes deal on dev:
   ```sql
   insert into feature_flags (business_id, key, enabled, notes, set_by)
   select business_id, 'themes_free', true, 'dev: A617 deal', 'owner'
   from feature_flags where key = 'themes' and enabled
   on conflict (business_id, key) do nothing;
   ```
3. **M-Pesa:** Settings › Payments as B Foods. Check the default shows Paybill 174379, press **Test connection**, then pay
   KES 1 from the web POS.
4. **Glovo:**
   - Switch Glovo on for the branch and set 15% with rounding up to the nearest 10.
   - Ring up an item, pick Glovo, and check the price, the confirmation and the receipt.
   - Pick Cash and check that normal prices come back.

## Production, at the merge (order matters)

1. Migrations **179 → 187** on prod.
2. **182, then 185 straight after,** before the server deploy, so no branch loses Themes in between.
3. Deploy.
4. In the admin portal: enter the real billing details and prices.
5. **Desktop 1.0.23:** schema 79.
