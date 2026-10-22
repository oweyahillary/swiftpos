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
| Analytics | Menu engineering, what sells when, money leaks by cashier, credit ageing, ranked "Do this next" with KES estimates (marked as estimates) | Guaranteed savings; AI |
| Kitchen | Kitchen and dispatch tickets, a kitchen display, variants and combos on one line | — |
| Credit | Customer accounts with limits; every credit sale confirmed by a manager | — |
| Stock | Stock levels, deliveries, transfers between branches, counts, wastage, recipes and costs | Purchase orders sent to suppliers automatically |
| Staff | Ready-made roles (General Manager to Cashier), PINs, partner logins | — |
| Brand | Your logo and colours on the till and receipt, per branch | — |
| Support | Updates install themselves; support can pull a till's log remotely | "24/7 support" until it is staffed so |
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

1. **Cost per day:** "About KES 100 a day — less than one short drawer."
2. **Leak calculator** (Pricing and Home):
   - **Inputs:** daily sales, number of cashiers, an estimated shortage per cashier per day, wastage percentage.
   - **Output:** the monthly leak in KES, against ZapTill's monthly price.
   - Labelled as an estimate built only on the visitor's numbers; nothing stored or sent.
3. **What the setup buys,** item by item: on-site install, menu and stock loaded, printers and kitchen screens set up,
   staff roles and PINs, training, branding, the first day close together.
4. **Analytics payback:** one real card ("Raise Tusker by KES 40 ≈ KES 35,200 a month, if the same 880 still sell"),
   with KES 10,000 a month shown against it.
5. **"No surprises":** no percentage of your sales; M-Pesa charges are Safaricom's; hardware is quoted separately or
   bring your own; your data is yours to export.

## 6. Packages (a draft for the owner to decide)

| Package | Price (draft) | Includes |
|---|---|---|
| **ZapTill** | KES 30,000 setup + KES 3,000 a month (KES 36,000 a year) | Tills, M-Pesa, kitchen, day close, staff and roles, dashboard, daily email, updates and support |
| **ZapTill Online** *(Most chosen)* | Owner to price | Above + menu images, variants, offers, stock on the till (the existing online licence) |
| **ZapTill Analytics** | about KES 10,000 a month | "Do this next", what sells when, menu engineering, money leaks, credit ageing |

**Open for the owner:** is the price per branch or per business, and how many tills are included? Is there a reward for
paying yearly (a month free, or a lower setup fee)? Should prices be published or shown as "from"?

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
| **3. Conversion** | Demo request form and cloud route with spam protection; the admin list of demo requests; Telegram notice | Needs a migration |
| **4. Proof** | Case studies (multi-branch, bar, outage café); testimonials; client logos (with permission); Google Business Profile | Owner collects (analysis §8) |
| **5. Launch** | Domain switch (`zaptill.co.ke` → the site; the dashboard stays on `app.`); SEO checks; site analytics; privacy and terms reviewed | Owner deploys |

## 10. Needed from the owner

- [ ] Choose the homepage headline (B recommended; A and C are in the analysis, §6)
- [ ] Pricing decisions (§6)
- [ ] A company email address
- [ ] The city and area served, and support hours
- [ ] Permission from 2–3 clients for a quote and a number (the analysis §8 lists what to capture)
- [ ] The eTIMS FAQ wording
- [ ] Whether a UPS is part of the recommended hardware (it makes the outage story fully honest)
