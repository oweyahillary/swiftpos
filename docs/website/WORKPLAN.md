# ZapTill website: workplan

Written 2026-10-21 (night 1), from [`COMPETITOR-ANALYSIS.md`](COMPETITOR-ANALYSIS.md) and [`../WEBSITE-BRIEF.md`](../WEBSITE-BRIEF.md).
Progress goes in [`WEBSITE-LOG.md`](WEBSITE-LOG.md).

## 1. What the site must do

The site does not sell software. It sells **control of the business**: knowing where every shilling went, never stopping
a sale, and knowing what to change next. Every page answers the owner's question: *"What do I get for my money?"*

Three jobs, in this order:
1. **Make the owner feel the problem and the fix.** Leaks, outages, closing the day blind, not being there.
2. **Prove it.** Real screens, a simple money sum, honest prices, and named clients once they agree.
3. **Start a conversation.** WhatsApp first (0717 675 635, a pre-filled message), "Book a visit" second.

## 2. Positioning (from the research)

| Where | Line |
|---|---|
| Homepage headline | **Know where every shilling went, every single day.** |
| Homepage sub-line | ZapTill runs your tills, kitchen and M-Pesa — through internet and power cuts — closes your day in minutes, tells you who was short, and sends you the numbers before you sleep. |
| First benefit block | **When the internet goes, your tills don't.** (offline, shown as a scene) |
| Multi-branch and Analytics pages | **Run your business properly, even when you're not there.** |

Tone: warm, plain Kenyan English, short sentences, shillings and real moments (the drawer count, KPLC, the night shift).
No hype ("best in Kenya", "100%", "zero leakage"), and no counters until the numbers are real and impressive.

## 3. Claims check: say only what ships

The research suggests some lines that go beyond today's product. The site uses the **"Say"** column only.

| Area | Say (true today, 1.0.20) | Don't say (yet) |
|---|---|---|
| Offline | Tills keep selling and printing with no internet; a branch server keeps every till in the shop in step; everything catches up by itself | "Works through power cuts" without the honest note that the PC needs power (a UPS keeps it running) |
| M-Pesa | Buy Goods and Paybill on every receipt, split payments, M-Pesa totals per cashier at day close | "M-Pesa matched to your statement automatically": reconciliation is not built (value-add item 3) |
| Day close | Drawer counts, over/short by cashier, shift confirmation, close a branch from the till or the web | — |
| Owner away | Every branch on one web dashboard; a daily summary by email; partner and accountant logins | Telegram or WhatsApp summaries, until those channels are set up |
| Analytics | "Do this next" in plain words: what to order, what to have in for a busy day ("your week at a glance"), stock to move between branches (words only, no quantity or KES), credit to chase, a dish to feature, items without a cost; KES estimates only where honest, marked as estimates; voids and discounts as a **warning to look into**; tables capped at the top 10 | Guaranteed savings; AI; **any price-rise suggestion** (owner: prices should be competitive); voids as money "to recover" |
| Kitchen | Kitchen and dispatch tickets, a kitchen display, variants and combos on one line; extras and the cashier's notes printed under the dish (A559) | Menus by time of day |
| Credit | Customer accounts with limits (existing customers too, A567); sales on account at the till within the limit; every credit sale confirmed by a manager | — |
| Stock | Stock levels, deliveries, transfers between branches, counts, wastage, recipes and costs; see other branches' stock and request a transfer (A564; at the till with ZapTill Online); when stock hits zero: sell as normal, show sold out, or hide (A563) | Purchase orders sent to suppliers automatically |
| Barcodes and labels | Scan at the till; generate in-store EAN-13 codes for products without one (prefix 20, never overwrites); labels on any printer and size: label printers (TSPL/ZPL), A4 sticker sheets, the receipt printer; every label carries a barcode (A571, A574) | Weighed items / scale barcodes (21–29 are reserved, not built) |
| Staff | Ready-made roles (General Manager to Cashier), PINs, partner logins | — |
| Brand | Your logo and colours on the till and receipt, per branch | — |
| Support | Updates install themselves; support can pull a till's log remotely; 24-hour support for **priority clients** | "24/7 support" for everyone |
| Platforms | Windows till; web dashboard on any phone | Android or iPad till |
| eTIMS | One honest FAQ line: clients handle eTIMS with their own provider today | eTIMS built in |

Before launch, the owner re-checks this table against the release then current.

## 4. Site map

| Page | Purpose | Key sections |
|---|---|---|
| **Home** | Hook, proof, path | Hero · trust strip · "Choose your business" · 4 benefit blocks with screens · offline scene · owner-away block · "Do this next" teaser · the price in one line · FAQ excerpt · final WhatsApp call to action |
| **How it works** | A day with ZapTill | Morning open → lunch rush → kitchen → evening close → owner's phone at night; one screen per step |
| **Features** | The full list, grouped by job | Sell · Kitchen · Money and day close · Stock · Staff · Branches · Analytics · Support |
| **For restaurants and cafés** | The lead industry | Kitchen flow, combos and variants, tables, menus by time of day |
| **For bars and lounges** | Leak control | Over/short by cashier, credit for regulars, the night close |
| **For quick service** | Speed | Counter speed, offers, dispatch tickets |
| **For retail** and **for petrol stations** | Secondary lanes | Shorter pages; petrol: pumps, attendants, tank deliveries |
| **Analytics** | The premium upsell | A real "Do this next" card, what sells when, money leaks, payback logic, the first-month money-leak report |
| **Pricing** | Value for money | Packages, what the setup buys, the cost per day, the leak calculator, "No surprises", pricing FAQ |
| **Contact / Book a visit** | Conversion | WhatsApp (pre-filled), phone, demo form (with the spam protection in the brief), area served |
| Privacy, Terms | Required | Data stance, the Kenya Data Protection Act |

The **Sign in** button in the header goes to `app.zaptill.co.ke`.

## 5. Value for money: how the site makes the sum

1. **Cost per day:** "The cloud is about KES 100 a day — less than one short drawer." The tills are a one-off purchase per
   branch.
2. **Leak calculator** (Pricing and Home):
   - **Inputs:** daily sales, number of cashiers, an estimated shortage per cashier per day, wastage percentage.
   - **Output:** the monthly leak in KES, against ZapTill's monthly price.
   - Labelled as an estimate built only on the visitor's numbers; nothing stored or sent.
3. **What the setup buys,** item by item: on-site install, menu and stock loaded, printers and kitchen screens set up,
   staff roles and PINs, training, branding, the first day close together.
4. **Analytics payback:** the app's real cards (A560): "Order about 70 more Tusker lager before Friday" (≈ KES 18,255 of
   sales at risk), "Stock up for Saturday", "Chase KES 87,400 owed for over 60 days", "Feature Tilapia whole at lunch",
   and "Check Otieno's voids" as a warning with no figure, with KES 10,000 a month shown against them. **Never a price
   rise** (owner, 2026-10-22: prices should be competitive).
5. **"No surprises":** no percentage of your sales; M-Pesa charges are Safaricom's; hardware is quoted separately or
   bring your own; your data is yours to export.

## 6. Packages (the owner's model, 2026-10-22; cloud per business 2026-10-23; prices still a draft)

| Package | Price (draft) | Includes |
|---|---|---|
| **ZapTill for one branch** (pay once) | KES 30,000, one-off ("once paid it's a done deal"); installation can vary with the site, confirmed before we start; each extra computer from about KES 10,000, quoted per client | A branch = 2 computers (branch server + till). Tills, M-Pesa, kitchen, day close, staff and roles, barcode scanning, sales on account, setup on site and training |
| **ZapTill Cloud** (month to month) | KES 3,000 a month per business (one fee covers every branch); first month free with the setup (A569); month to month or 3, 6 or 12 months at once (6 or 12 recommended, no discount); if it lapses the tills keep selling, syncing stops and a till cannot be re-registered until paid; email reminders before expiry | Web dashboard on any phone, daily email, close a branch from the web, partner and accountant logins, barcodes and labels from the web |
| **ZapTill Online** | Ask us / price coming soon | Pictures, variants, offers, stock and labels at the till, other branches' stock from the till (the online licence) |
| **ZapTill Analytics** | about KES 10,000 a month, per business | "Do this next" in plain words, week at a glance, stock moves between branches, money-leak warnings, menu engineering, credit ageing |

**Still open for the owner:** the ZapTill Online price; the notice period beyond "month to month"; what makes a client
"priority". (Answered 2026-10-23: the cloud fee is per business, not per branch; the setup stays per branch; an extra
computer from about KES 10,000, quoted per client; no reward for paying ahead; what a lapsed cloud does; support 8 am to
7 pm, 24 hours for priority clients.)

## 7. Look and feel

- **Brand:** the ZapTill teal from the app, a clean light theme with a dark hero, and real product screens in device
  frames (till monitor, laptop dashboard, phone summary).
- **Screens:** captured from the real app running a **made-up demo business** (never a real client). The Analytics
  previews already render from seeded demo data.
- **Speed:** fast on mobile data. Static pages, WebP images, no heavy scripts, under about 1.5 MB per page.
- **Accessibility:** readable contrast, real text (not text in images), keyboard and screen-reader friendly.

## 8. Technology

- **Code:** `apps/website`, a static site (Astro). Separate from the dashboard, deployed on Vercel as its own project
  by the owner when ready.
- **Contact:** WhatsApp click-to-chat (`https://wa.me/254717675635?text=…`) works with nothing to set up.
- **Demo form:** phase 2. A new cloud route with Turnstile, a honeypot, a time check, rate limits, Kenyan phone
  validation and email domain checks; requests go to the admin portal list and Telegram (the brief, §7).
- **Search engines:** titles and descriptions per page, Open Graph images, a sitemap, schema.org `SoftwareApplication`
  and `LocalBusiness`.
- **Analytics for the site itself:** privacy-friendly (Plausible or Vercel Analytics), so no cookie banner.

## 9. Phases

| Phase | Contents | Status |
|---|---|---|
| **1. Foundation** | Scaffold `apps/website`; the design system (colours, type, spacing, buttons, cards); header and footer; **Home** with full copy and placeholder screens; **Pricing** with the calculator; **Contact** with WhatsApp; FAQ | **Built on night 1 (2026-10-22), local only**, for the owner to review (WEBSITE-LOG). Placeholder screens; real ones in Phase 2 |
| **2. Depth** | Features, How it works, the industry pages, the Analytics page; real screenshots from a demo business; device frames | **Built on night 1 (2026-10-22), local only** (WEBSITE-LOG "Night 1 — Phase 2"): real till screens, receipts from the print renderer, four industry pages, JSON-LD, Open Graph cards per page, `npm run check` |
| **3. Conversion** | Demo request form and cloud route with spam protection; the admin list of demo requests; Telegram notice | Front-end form built on night 2, shown in `npm run dev` only (not in the build) until the route exists. The route needs a migration (server work, not started) |
| **4. Proof** | Case studies (multi-branch, bar, outage café); testimonials; client logos (with permission); Google Business Profile | Owner collects (analysis §8) |
| **5. Launch** | Domain switch (`zaptill.co.ke` → the site; the dashboard stays on `app.`); SEO checks; site analytics; privacy and terms reviewed | Owner deploys |

## 10. Needed from the owner

- [ ] Choose the homepage headline (B recommended; A and C are in the analysis, §6)
- [x] Pricing model (§6): desktop one-off per branch, cloud monthly per business (2026-10-23), one-month trial (2026-10-22), extra PC from about KES 10,000 and no pay-ahead reward (2026-10-23). Still open: the Online price, the notice period
- [ ] A company email address
- [ ] The city and area served
- [x] Support hours (2026-10-23): 8 am to 7 pm; 24 hours for priority clients. Still open: what makes a client "priority"
- [ ] Permission from 2–3 clients for a quote and a number (the analysis §8 lists what to capture)
- [ ] The eTIMS FAQ wording
- [x] A UPS is recommended hardware (2026-10-22): in the hardware FAQ and the power-cut answer
