# ZapTill website: working log

The running record of the website work: what was researched, decided and built each session, and what comes next.
The newest entry is at the top.

| File | What it holds |
|---|---|
| [`../WEBSITE-BRIEF.md`](../WEBSITE-BRIEF.md) | The first brief: purpose, pages, draft copy, spam protection, technical outline |
| [`COMPETITOR-ANALYSIS.md`](COMPETITOR-ANALYSIS.md) | Research into Kenyan, African and global POS websites: lessons, patterns, gaps, positioning |
| `WORKPLAN.md` | How the site will be built, page by page, phase by phase (written after the research) |

Standing rules: the site is never deployed, published or committed by Claude; the owner reviews and commits. Prices are
a draft: KES 30,000 once per branch for the tills; the cloud KES 3,000 a month per business (all branches), month to
month, first month free; Analytics about KES 10,000 a month, per business. Contact: 0717 675 635, no company email yet.

---

## 2026-10-23: owner answers

- **Question 17 answered: the cloud fee is per business, not per branch.** ZapTill Cloud (about KES 3,000 a month, KES
  100 a day) covers every branch; the KES 30,000 desktop setup stays one-off per branch (a branch = branch server + a
  till); extra computers stay "quoted separately"; Analytics (about KES 10,000 a month) is per business too; ZapTill
  Online stays "Ask us"; 6 or 12 months ahead recommended, no discount figure.
- Changed to match: Pricing (lede, Cloud and Analytics cards, the note under the packages, "No surprises", the meta
  description), the FAQ ("Do I pay for the tills every month?", "Can I add a branch later?": no second cloud fee), Home
  (price band, the one-dashboard benefit), Features ("Add a branch later … with no second cloud fee"), Analytics hero
  price, the leak calculator label, the Pricing Open Graph card, `site.ts` comments, WORKPLAN §6 and §10. Multi-branch
  now reads as a plus of the per-business fee.
- **Questions 18–21 answered:**
  - 18, the cloud lapses: "the till continues to work, but the cloud stops syncing and the till cannot be re-registered
    until the client pays again"; reminders are emailed before expiry. Plans: month to month, or 3, 6 or 12 months at
    once (6 or 12 recommended). The FAQ "What happens if I stop paying for the cloud?" now says the tills keep selling;
    the dashboard, phone access, daily email and syncing stop until you pay; sales wait on the till and arrive on
    renewal; adding or re-registering a till needs an active plan; we email before the plan ends.
  - 19, support hours: 8 am to 7 pm (no days given, so none are stated); 24 hours for priority clients. On Contact
    (Call card), the FAQ "What support do I get?" and Features (Support and updates). The footer has no support line.
  - 20, a reward for paying ahead: none for now. Pricing and the FAQ say "Paying ahead is simpler, not cheaper: there is
    no discount", and recommend 6 or 12 months for convenience.
  - 21, an extra computer: "10k, in fact the price might vary depending on the client, even installation costs". The
    site says "from about KES 10,000 each, quoted for your setup" (`PRICES.extraComputerFrom`), and "installation can
    vary with the site, and we confirm the price before we start" (packages note, FAQ "What is a branch…", hardware FAQ).
    No JSON-LD offers block was added: the prices are still a draft.
- Still open from 19: what makes a client "priority" (a paid tier?).

---

## 2026-10-22: Night 2

Local only: nothing committed, deployed or published. Worked only in `apps/website/**` and `docs/website/**`; read (never
edited) `apps/server/src/lib/analyticsRules.ts`, the dashboard's Analytics page, `shared/labels.ts`, `shared/barcode.ts`,
`shared/printing` and `docs/AUDIT-REGISTER.md` (A559–A574).

**Asked**
- Reflect the owner's commercial model: per branch (2 computers), desktop one-off, cloud month to month with 6 or 12
  months ahead recommended, a one-month cloud trial, Analytics as an add-on, 24-hour support for priority clients only,
  a UPS recommended. No extra-PC price, no discount figure, Online price "Ask us".
- Remove every price-rise example from Analytics; voids are a warning, never money "to recover"; show the app's real
  card types (stock, week at a glance, items without costs, branch moves in words).
- Add the 1.0.20 features where they fit, with the right trade words (shops: departments, products, barcodes, labels,
  stock; restaurants: menus, kitchen tickets, tables). Then Phase 3's form front end, a barcode and labels section with a
  label drawn by the real label code, and other no-owner-input items.

**Done**
- **Pricing model** (`src/pages/pricing.astro`, `src/lib/site.ts`, `src/lib/faq.ts`, Home's price band):
  - "Pay once for the tills. About KES 100 a day for the cloud."
  - Two groups: **Pay once**: "ZapTill for one branch", KES 30,000 once, "A branch is two computers: the branch server
    and a till". **Month to month**: ZapTill Cloud (KES 3,000 a month, per branch, "First month free", 6 or 12 months
    ahead recommended), ZapTill Online ("Ask us", price coming soon), ZapTill Analytics (about KES 10,000 a month, an
    add-on to the cloud).
  - "More tills or a kitchen screen are quoted separately": no extra-PC figure anywhere.
  - "No surprises" now opens with "The tills are paid for once" and "The cloud is month to month".
  - New pricing FAQ answers: Do I pay for the tills every month? Is there a free trial? Can I pay for the cloud for a
    year? What is a branch, and can I have more tills? What support do I get? (24 hours for priority clients). Reworked:
    What happens if I stop paying for the cloud? Can I add a branch later? Is there a contract? The hardware answer is
    now a list per branch with a UPS; the power-cut answer says the UPS is on the recommended list.
  - The leak calculator compares against "ZapTill Cloud, a month". The Open Graph card for Pricing was redrawn.
- **Analytics without price rises** (`src/lib/analyticsDemo.ts`, `DoThisNextCard.astro`, Analytics, Home, Features,
  Pricing, Bars, Restaurants, How it works, WORKPLAN §3, §5.4):
  - The demo cards are now the app's own A560 cards, from the real capture
    (`docs/website/screenshots/app-analytics-dark.webp`): order about 70 more Tusker before Friday (≈ KES 18,255 of
    sales at risk), cooking oil runs out in about 2 days, stock up for Friday, stock up for Saturday, chase KES 87,400
    owed, feature Tilapia at lunch, and **"Check Otieno's voids" as an amber warning with no estimate**.
  - The card component draws stock plans ("Order: ≈ 70 more to have 100 by Friday"), warnings, and cards with no figure.
  - Analytics page: a new hero screenshot (re-cropped from the A560 capture: no price-rise card in it), the found line in
    plain words, the "6 items have no cost" note, **Your week at a glance: what to prepare each day**, a new **Stock
    between branches, in plain words** section (A565's two suggestions, no quantity, no KES), money leaks as warnings, and
    a payback table that shows each card's real kind of figure.
  - Home teaser: "what to have in for Saturday … Your prices stay yours: it never tells you to charge more."
  - Bars: "Then: what to have in, and when to staff up". How it works, 07:30: the voids warning, with no shilling figure.
  - `grep` finds no "raise", "to recover", "24/7" or "hotel" in the site's copy.
- **1.0.20 features, worded as shipped**:
  - Features: menus as big tabs (departments in a shop), barcode scanning, credit limits, the zero-stock choice, extras
    and notes on the kitchen ticket (the slip pair now shows them), other branches' stock and requests, 24-hour priority
    support, the owner's first-sign-in password, and a new **Barcodes and labels** group.
  - Retail (rewritten in shop words): barcodes and labels first, then departments as tabs, the zero-stock choice, other
    branches' shelves and customers on account. New FAQ answers: products without a barcode, which label printer, when
    an item runs out, checking the other shop.
  - Restaurants: extras and notes on the kitchen ticket with a real slip (Table 6: "+ Extra Cheese", "** No onions",
    "** Well done"), menus as big tabs, credit limits at the till.
  - How it works: the kitchen moment mentions extras and notes.
  - Premium labels kept: stock, labels and checking other branches **from the till** say "with ZapTill Online" (A460,
    A564, A566, A571).
- **Real labels**: `scripts/render-labels.mjs` (`npm run labels`) lays out three demo-shop items through
  `shared/labels.ts` and `shared/barcode.ts` (imported read only; Node 24 strips the types) into
  `src/lib/labels.generated.json`. `LabelSamples.astro` draws 50 × 30, 58 × 40 (with the shop name) and 38 × 25 mm
  labels at true proportions, plus an A4 3 × 8 sticker sheet with two rows printed. The codes are ZapTill's own in-store
  EAN-13s (2000000000015, …022, …039). `test/labels.test.mjs` checks the file against the label code and every check
  digit.
- **Kitchen ticket with extras**: `render-slips.mjs` renders a second demo order's kitchen ticket (`extras58`/`extras80`)
  through `shared/printing`; the other slips are unchanged. A new slip test checks the extra and the notes sit under the
  dish.
- **Phase 3 front end**: `src/components/DemoForm.astro` and `src/lib/demoForm.ts` (name, business, kind, branches,
  Kenyan phone, optional email, town, message; a honeypot; a 4-second time check; a Turnstile TODO). It shows on Contact
  in `npm run dev` only and is **not in the build**: no route receives it yet. It would post JSON in the body, never in a
  URL. `test/demo-form.test.mjs` covers the checks.
- WORKPLAN §3, §5, §6, §9 and §10 updated; `apps/website/README.md` lists the new scripts and files.

**Decisions**
- **The cloud fee is shown per branch**, following "pricing is per branch". If the owner meant per business, change
  `pricing.astro` ("per branch") and the FAQ "Can I add a branch later?".
- **"Pay once" is worded as the owner said it**: "Once paid, it's a done deal. No monthly fee for the tills." The
  stop-paying answer says the tills stay yours and the cloud features stop; exactly what a lapsed cloud does to the tills
  is a TODO(owner).
- **Card wording is the app's**, with its long dashes written as colons, as the site does elsewhere. The found line is in
  the site's words (the app's capture counts one item running low where two cards are stock warnings).
- **Analytics says, once per page where it fits, that it never suggests raising prices**: it turns the owner's rule into
  a selling point ("your prices stay competitive").
- **The week at a glance and the branch moves are CSS** from the real figures, not crops: the crops were unreadable at
  390 px.
- **Labels and stock from the till are labelled "with ZapTill Online"**; generating barcodes and printing labels from
  the web is listed under the cloud.
- **No weighed items**: in-store codes 21–29 are reserved for scale barcodes (A571), but weighing is not built. The TODO
  stays on the retail page.
- **The demo form stays out of the build** until the server route exists, so a deployed site never shows a form that
  goes nowhere.

**Placeholders and TODO(owner)**
- The extra-computer price; a reward for paying ahead; the ZapTill Online price; the notice period beyond "month to
  month"; support hours for clients who are not priority clients.
- What the tills do if the cloud lapses (the stop-paying answer).
- The demo form's route, Turnstile key and endpoint (server work).
- Earlier ones still open: the company email, the setup time, the visit being free, the area served, petrol, logos,
  the first-month money-leak report.

**Checked**
- `npm run build` (14 pages), `npm test` (23 of 23: leak, slips, labels, schema, demo form) and `npm run check` (links,
  headings, alt text, JSON-LD, weights; heaviest page Analytics at 192 KB) all pass.
- The repo's `scripts/check-*.mjs`: all pass except `check-schema-drift`, which reports migration
  `164_analytics_together.sql` not yet applied to the database: another agent's work in progress, nothing in the website.
- No CRLF in any changed or new file under `apps/website` or `docs/website`.
- Full-page screenshots at 1440, 390 and 360 px of Home, Pricing, Analytics, Features, Retail, Restaurants, Bars, How it
  works and Contact, looked at: no horizontal overflow at any width. (The first pass found the Analytics payback table
  overflowing; fixed.) The dev-only form was clicked through in Chromium: too fast → refused; filled → "not connected".
- Review shots saved over night 1's in `docs/website/screenshots/site-*-desktop.webp` and `-phone.webp`.

**Note for whoever runs the tests next**
- `shared/labels.ts` and `shared/barcode.ts` were being changed by another agent tonight (A574). If `npm test` reports
  that the labels drifted, run `npm run labels` and look at the labels again; it means the label code changed, not that
  the site is wrong.

**Next**
- Phase 3's server side: the route, the migration, the admin list, the Telegram notice; then point `ENDPOINT` at it and
  show the form in the build.
- Capture a real till screenshot with the menus as top tabs (A566) and a shop's departments, for Features and Retail.
- Phase 4: proof (quotes, logos, case studies with permission).

**Open questions for the owner (new)**
19. What makes a client "priority" (a paid tier?). (18, 20, 21 and the support hours were answered on 2026-10-23.)

---

## 2026-10-22 (afternoon): owner's answers to the open questions, for tonight

- **Pricing is per branch:** a branch is a 2-computer setup (a server plus a till). Extra PCs cost more, but **don't
  publish that yet** (owner deliberating).
- **Desktop app is a one-off purchase**: "once paid it's a done deal".
- **Cloud (dashboard and online features) is month to month.** Recommend annual or semi-annual on the site.
- **A one-month cloud trial** comes with the desktop setup (A569).
- **Support:** 24 hours for **priority clients** only. Don't say 24/7 for everyone.
- **A UPS is recommended:** keep the outage story's UPS line, and add it to the hardware list.
- Still open: the company email, the ZapTill Online price, and the contract notice wording beyond "monthly".
- Rework the Pricing page and FAQ to this model tonight: per-branch desktop setup (one-off), cloud monthly with annual
  suggested, a one-month cloud trial, Analytics as an add-on.

## 2026-10-22 (day): owner decisions that change the site, for tonight

- **No price-rise recommendations** (owner: "prices should be competitive with other businesses price increase means
  selling expensive than competitors"). Analytics now suggests **what to stock and what sells on which day** (A560).
  The site still shows "Raise the price of Tusker lager" as its example: replace it everywhere with stock or
  best-seller-by-day cards in the app's new wording. Places: `src/components/screens/DoThisNextCard.astro`,
  `src/lib/analyticsDemo.ts`, the Home teaser, the Analytics page, the Pricing payback, and WORKPLAN §5.4.
- **Cashier voids are a warning to investigate**, not "KES to recover". The site must not present voids as recovered
  money.
- **Extras and notes print on the kitchen ticket** (A559): the restaurant page and the kitchen ticket sample can say so
  once it ships.
- **A cashier needs "view customers" to sell on account at the till** (A559).

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
