# ZapTill website: working log

The running record of the website work: what was researched, decided and built each session, and what comes next.
The newest entry is at the top.

| File | What it holds |
|---|---|
| [`../WEBSITE-BRIEF.md`](../WEBSITE-BRIEF.md) | The first brief: purpose, pages, draft copy, spam protection, technical outline |
| [`COMPETITOR-ANALYSIS.md`](COMPETITOR-ANALYSIS.md) | Research into Kenyan, African and global POS websites: lessons, patterns, gaps, positioning |
| `WORKPLAN.md` | How the site will be built, page by page, phase by phase (written after the research) |

Standing rules: the site is never deployed, published or committed by Claude; the owner reviews and commits. Prices are
a draft (KES 30,000 setup, about KES 3,000 a month; Analytics planned at about KES 10,000 a month). Contact:
0717 675 635, no company email yet.

---

## 2026-10-22: Night 1 — Phase 2 (depth)

Local only: nothing committed, deployed or published. Run `cd apps/website && npm install && npm run build && npm test && npm run check`.

**Built**
- **How it works** (`/how-it-works/`): "A day with ZapTill" at Mama Lishe Grill in seven moments, each with a screen:
  - 07:55: PIN and float (real till).
  - 12:40: the lunch rush, split M-Pesa and cash (real till).
  - 12:41: the kitchen (kitchen display and the real kitchen ticket).
  - 15:30: a delivery and wastage (CSS stock screen).
  - 22:35: the close (real shift report and the real printed cash reconciliation).
  - 22:45: the daily email on the phone.
  - 07:30: a "Do this next" card.
- **Features** (`/features/`): nine groups (Sell, Kitchen, Money and day close, Stock, Staff and roles, Branches and
  branding, Analytics, Support and updates, Works offline).
  - Each group has an intro, 5–8 items and a screen, slip or icon.
  - The roles board lists all twelve built-in roles plus Fuel attendant (petrol only), from `BUILT_IN_ROLES`
    (`src/lib/roles.ts`).
- **Industry pages**: `/who-its-for/` is now a hub linking to four full pages:
  - `/for/restaurants/` is the deepest: one order on three tickets, the kitchen display, combos and variants, tables,
    menu groups, credit for regulars, and Analytics.
  - `/for/bars/`, `/for/quick-service/` and `/for/retail/`.
  - Each has its own headline, five problem → fix blocks, screens, a FAQ (with FAQPage data) and its own pre-filled
    WhatsApp message.
  - Petrol stays on the hub as "Talk to us about your forecourt".
- **Analytics** (`/analytics/`):
  - The real page in a laptop frame.
  - Four "Do this next" cards, in the demo restaurant's own words (`src/lib/analyticsDemo.ts`).
  - What sells when: five daypart cards and the top 3 at every hour, in CSS, from the real figures.
  - Money leaks (a real crop) and credit ageing (a real crop of the age card only).
  - The payback table: estimates against KES 10,000, labelled as not promises.
  - "Ask for a first-month money-leak report": a WhatsApp link, with no price.
- **Real till screens: worked.**
  - The built till renderer (`apps/desktop/dist/renderer`, read only) runs in headless Chromium, with the compiled
    preload wrapped around a stub `ipcRenderer` and demo data.
  - The harness now lives in the repo, in `apps/website/tools/till-shots/` (moved from the session scratchpad) (`serve.cjs`, `make-bundle.cjs`, `mock.js`,
    `run.cjs` and the step files).
  - Captured: the PIN pad, the float, the POS with Table 4, a split payment, and the shift report by cashier. They are in
    `public/screens/till-*.webp`, 11–53 KB each.
  - The Phase 1 CSS till (`TillScreen.astro`) was removed. The CSS day close, phone summary, kitchen display and stock
    screen remain; they are web screens and were not captured.
- **Receipts use the printer's own text.**
  - `scripts/render-slips.mjs` renders a demo order and a demo shift close through `shared/printing/dist`
    (`renderTicket`, `renderShiftReport` and toPreview's layout), at 80 and 58 mm, into `src/lib/slips.generated.json`.
    Each slip is checked line for line against `toPreview`.
  - `Receipt.astro` draws the slips: tall lines at double height, rules dashed.
  - The slips: kitchen, dispatch, the customer receipt (variants on one line, the BUY GOODS block), the Z-report, and a
    shop receipt for the retail page.
  - `test/slips.test.mjs` fails if the JSON drifts from the renderer.
- **Search**:
  - JSON-LD `Organization` (with the phone number) on every page.
  - `SoftwareApplication` on Home, Features and Analytics.
  - `FAQPage` on Pricing and the four industry pages.
  - An Open Graph card per page (`public/og/*.png`, made by `scripts/make-og.mjs`).
  - Every page is in the sitemap. The industry pages are in the footer and the hub, and Home's lanes link to them.
- **Quality**:
  - `scripts/check-dist.mjs` (`npm run check`) checks links and anchors, title, description and canonical, one h1,
    heading order, alt text with width and height, at most one eager image, that JSON-LD parses, and page weights.
  - New tests: `test/slips.test.mjs` and `test/schema.test.mjs` (15 tests in all).

**Checked**
- `npm run build` builds 14 pages, `npm test` passes 15 of 15, and `npm run check` is clean.
- Page weights (HTML, CSS and images; Google Fonts not counted):

  | Page | Weight |
  |---|---|
  | Analytics | 180 KB |
  | Home | 152 KB |
  | Features | 131 KB |
  | How it works | 125 KB |
  | Restaurants | 113 KB |
  | Quick service | 76 KB |
  | Bars | 64 KB |
  | Retail | 62 KB |
  | Pricing | 54 KB |
  | Contact | 30 KB |
  | Who it's for | 29 KB |

- No horizontal overflow at 360 px on any page. Screenshots at 1440 and 390 px: `docs/website/screenshots/` (WebP).
- The repo's `scripts/check-*.mjs` all pass, and no file in `apps/website` or `docs/website` has CRLF line endings.

**Decisions**
- **No "menus by time of day"** on the restaurant page, because it is not built (A537: "no hours or days for now"; the
  settings page says "coming in a future update"). The page says "your menu, grouped your way" instead, with a TODO.
- **Per-branch branding is worded as it ships** (A544): the logo is the business's and prints on the receipt; each
  branch can have its own colours and receipt footer. WORKPLAN §3's "your logo and colours … per branch" is slightly
  ahead of the code.
- **Premium features are labelled.** Variants, pictures, offers and stock at the till say "with ZapTill Online" (A460),
  and Analytics is "an add-on". The how-it-works story uses a variant, with a note at the end.
- **The kitchen display shows variants under the dish** ("Spice: Spicy"), as the real KDS does. "On one line" is said
  only of the printed tickets and the receipt.
- **No price in the structured data** while prices are a draft (a TODO in `schema.ts`).
- **The receipt shows line amounts before VAT** (1,250.00 for a KES 1,450 dish), because the real renderer prints them
  that way. Left as is, since the site promises the real paper.
- **The credit crop shows the age buckets only**, not the debtor list. The demo names are made up, but fewer names on
  the site is safer.
- **Demo numbers match** across the till shift report, the Z-report and the email. Wanjiru: expected KES 14,550, counted
  KES 14,200, KES 350 short.

**Placeholders and TODO(owner)**
- Which package includes stock on the web dashboard (the till side needs the online licence).
- Barcode scanning and weighed items, not described on the retail page.
- Menus by time of day.
- The first-month money-leak report: what it is, who prepares it, and whether it is paid.
- The `offers` block in the structured data.
- Phase 1's TODOs: the email, the terms, the setup time, the logos.

**Open questions for the owner (new)**
11. The first-month money-leak report: what does it include, who prepares it, and is it paid? The page only invites a
    chat for now.
12. Is stock on the **web** dashboard part of the base package, or only ZapTill Online?
13. Per-branch **logo**: should WORKPLAN §3 say "your logo on the receipt; each branch its own colours and footer"?
14. The receipt shows item amounts before VAT. Is that what clients expect to see on the site, or should the demo use a
    business set up differently?
15. Retail: are barcode scanners and items sold by weight supported today? The site doesn't claim them.
16. A mistyped command tonight left one empty file at `C:\Program Files\Git\tmp_lines.js`. It is not in the repo; please
    delete it.

**Next**
- **Phase 3:** the demo request form and its cloud route, with spam protection (Turnstile, a honeypot, a time check, rate
  limits, phone and email checks), plus the admin list and the Telegram notice. It needs a migration.
- **Phase 4:** proof (case studies, quotes and logos used with permission, a Google Business Profile), then replace the
  trust strip.
- **Optional:** capture the kitchen display and the web day close from the real dashboard on a demo business (the CSS
  versions follow their layouts), and a tables screen with occupied tables.

---

## 2026-10-22: Night 1 — build (Phase 1, foundation)

Local only: nothing committed, deployed or published. Run it with `cd apps/website && npm install && npm run dev`
(details in `apps/website/README.md`).

**Built**
- `apps/website`: a static Astro site (astro 7.3.5, @astrojs/sitemap 3.7.4, both pinned exactly, released 24 Sep and
  31 Aug 2026). npm, its own `package.json` and lock file; no Tailwind. No other app or `shared/` was touched.
- **Design system** (`src/styles/global.css`): the back-office teal (`--swift` #14b8a6, `--swift-strong` #0f766e,
  `--swift-deep` #115e59), a deep teal-ink night (#061a1d) for the hero, header, offline story and footer, cool paper
  greys for the body. Bricolage Grotesque (headings) and Figtree (text) from Google Fonts. Buttons: WhatsApp (primary,
  a darker WhatsApp green so white text passes contrast) and "Book a visit" (outline). Device frames: monitor, laptop,
  phone. The one signature object is the **thermal receipt**: the day-close slip in the hero, the kitchen ticket and
  the receipt with the large Buy Goods number.
- **Header** (logo, the five nav links, 0717 675 635, Sign in → app.zaptill.co.ke, WhatsApp) with a no-script menu on
  phones; **footer** (pages, contact, privacy, terms, "Built in Kenya").
- **Home** with full copy, in the WORKPLAN §4 order: hero (the §2 headline and sub-line), trust strip (placeholder line,
  TODO slot for logos), "Choose your business", four benefit blocks (day close; offline; kitchen and M-Pesa; owner away),
  the offline scene as a timeline story, the "Do this next" card ("Example from a demo restaurant"), "From about KES 100
  a day", an FAQ excerpt and the final call to action.
- **Pricing**: the draft banner, the three packages, what the setup buys (7 steps), about KES 100 a day, the **leak
  calculator**, Analytics payback, "No surprises", the pricing FAQ (eTIMS line exactly as asked) and a call to action.
- **Contact**: WhatsApp first, phone, "Book a visit" explained; email is a TODO. No form (Phase 3).
- **Stub pages**: How it works, Features (the 8 groups), Who it's for (restaurants, bars, quick service, retail,
  petrol, each with its own WhatsApp message), Analytics (the demo screenshot in a laptop frame plus the card), Privacy,
  Terms, and a 404. Each has a "Coming in phase 2" note shown in `npm run dev` only, and as an HTML comment in the build.
- **Search basics**: a title and description per page, canonical URLs, Open Graph and Twitter tags, a 1200×630 Open
  Graph card (`public/og-zaptill.png`), favicons from the app icon, `sitemap-index.xml`, `robots.txt` (allow all).
- **Leak calculator** (`src/lib/leak.ts`, 6 tests in `test/leak.test.mjs`, `npm test`): monthly leak = cashiers ×
  shortage per cashier per day × 30 + daily sales × wastage % × 30, shown against KES 3,000 a month (and as "about N
  times"). Defaults: KES 40,000 a day, 2 cashiers, KES 200 short each, 1% wastage → KES 24,000 a month. Blank,
  negative or text input counts as 0. In the browser only: nothing stored, sent or put in the URL (checked in Edge).

**Decisions**
- **CSS-built screens** (till, day close, receipts, kitchen ticket, phone summary) with the made-up "Mama Lishe Grill",
  rather than screenshots, until Phase 2 captures the real app on a demo business. The one real image is a crop of
  the Analytics demo screenshot (`public/screens/analytics-demo.webp`, 100 KB), on the Analytics page only.
- **The phone summary shows only what the daily email contains** (`apps/server/src/jobs/dailySummary.ts`: sales,
  orders, top sellers, cash differences, voids, low stock), not payments or branch splits.
- **"Recommended", not "Most chosen"**, on the ZapTill Online package: "Most chosen" is a claim we can't back yet.
- **The offline story says the PC needs power**, and that a small UPS keeps it going (WORKPLAN §3), since the sub-line
  says "through internet and power cuts". The pricing FAQ has a "What about power cuts?" answer too.
- **Petrol stations** get "talk to us about your forecourt" only, until the feature set is confirmed.
- **No "cancel with notice"** in "No surprises", and the "stop paying", "contract" and "setup time" answers are kept
  general with TODOs, because the terms are not decided.
- **ZapTill Online** shows "Ask us" with "Price coming soon"; Analytics shows "About KES 10,000 a month".

**Placeholder**
- All product screens (CSS, demo data). The trust strip (no logos). Privacy and Terms (a short intro each). The email
  address. The prices (draft banner). The pricing FAQ answers marked `TODO(owner)`.

**Checked**
- `npm run build` passes (10 pages, about 430 KB in total). The repo's `scripts/check-*.mjs` guards all pass. No CRLF in
  the new files.
- Full-page screenshots at 1440, 390 and 360 px for Home, Pricing, Contact, Who it's for and Analytics: no horizontal
  overflow at 360 px, the phone menu included.

**Next (Phase 2)**
- Real screenshots from the app running a demo business (till, kitchen ticket, receipt, day close, dashboard, branch
  comparison, stock, Analytics, staff roles, branded receipts), converted to WebP, into the frames.
- The full How it works (a day, one screen per step), Features (one section per group), the industry pages
  (restaurants first), and the Analytics page (what sells when, money leaks, payback, the first-month leak report).
- schema.org `SoftwareApplication` and `LocalBusiness`; per-page Open Graph images.
- Phase 3 then adds the demo form and its cloud route with spam protection.

**Open questions for the owner**
1. Prices: per branch or per business; tills included; a reward for paying yearly; publish or "from"; the Online price.
2. Is "Recommended" right for ZapTill Online, or another package?
3. Contract length, notice period and what happens when a client stops paying (three FAQ answers wait on this).
4. Typical setup time, from the first visit to the first day of selling.
5. Is the visit free? (Contact says "You leave with a clear quote".)
6. A UPS in the recommended hardware? (the offline story and the power-cut answer mention one).
7. Company email, support hours, the city and areas visited.
8. Petrol stations: what to say today.
9. The demo seed's credit customers ("County Office", "Safari Tours Ltd", "Peter Oduya") show small in the Analytics
   crop. They are made up, but swap the crop if any of them matches a real client.
10. Keep the hero sub-line's "through internet and power cuts", or soften to "through internet cuts"?

---

## 2026-10-21 (night 1)

- **Asked:** research competitor sites (wording, message, format); write a workplan for a site that speaks value for
  money and shows ZapTill as a business tool, not software; start development if there is time.
- **Done:** competitor research → `COMPETITOR-ANALYSIS.md`. 8 Kenyan vendors (Uzapoint, Jampos/QuickTill, NodePoint,
  Cute Profit, Veira, iOSoft, Pesapal POS, SimbaPOS), Yoco and Orda, and Toast, Square, Lightspeed, Loyverse,
  TouchBistro. Closest rivals: **Cute Profit** (almost our pricing model) and **Jampos QuickTill** (an offline Windows
  till).
- **Done:** `WORKPLAN.md`.
  - **Positioning:** "Know where every shilling went", with offline as the first proof and "run it from anywhere" for
    multi-branch and Analytics.
  - **Claims check (§3):** the research suggested "M-Pesa matched to each sale" and Telegram summaries, neither of which
    ships today, so the site must not say them.
  - **Value for money:** about KES 100 a day, a leak calculator, what the setup buys, and Analytics payback.
  - Five phases, and the decisions needed from the owner (§10).
- **Started:** Phase 1 build of `apps/website` (Astro, static): the design system, Home with full copy, Pricing with the
  calculator, Contact via WhatsApp, and stub pages. Local only; nothing deployed or committed.
