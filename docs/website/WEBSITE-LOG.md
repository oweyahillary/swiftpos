# ZapTill website: working log

The running record of the website work: what was researched, decided and built each session, and what comes next.
The newest entry is at the top.

| File | What it holds |
|---|---|
| [`../WEBSITE-BRIEF.md`](../WEBSITE-BRIEF.md) | The first brief: purpose, pages, draft copy, spam protection, technical outline |
| [`COMPETITOR-ANALYSIS.md`](COMPETITOR-ANALYSIS.md) | Research into Kenyan, African and global POS websites: lessons, patterns, gaps, positioning |
| `WORKPLAN.md` | How the site will be built, page by page, phase by phase (written after the research) |
| `../../apps/website/src/lib/guides.ts` | The guides (night 3): titles, status (draft or ready), related links |

Standing rules: the site is never deployed, published or committed by Claude; the owner reviews and commits. Prices are
a draft: KES 30,000 once per branch for the point of sale; the cloud KES 3,000 a month per business (all branches), month to
month, first month free; Analytics about KES 10,000 a month, per business. Contact: 0717 675 635, no company email yet.
Wording (owner, 2026-10-23): "point of sale" (or "POS"), never "till", except Safaricom's own M-Pesa "Till number";
`npm run check` fails on any other "till" a visitor can read. Every demo business is FICTIONAL (src/assets/demo-brands)
and the pages say so; product photos only from free-licence libraries, credited in src/data/photo-credits.json.

---

## 2026-10-23: Night 3

Local only: nothing committed, pushed, deployed or published. Worked only in `apps/website/**` and `docs/website/**`;
product code not touched. Built on the uncommitted evening work above (videos, brands, "point of sale"); nothing of it
reverted.

**Asked** (overnight queue, no owner input needed)
1. A Lighthouse-style quality pass on every page, phone and desktop: fix what is cheap; accessibility (contrast,
   headings, focus, alt text, labels, keyboard use of the Features filter, TradeSwitch and video controls, reduced
   motion). Before and after numbers.
2. SEO for Kenya: what owners search for; titles, descriptions, headings, internal links, JSON-LD, sitemap, canonical;
   no keyword stuffing; no eTIMS claim.
3. A `/guides/` section: four practical articles, honest, no invented statistics, each with a soft call to action,
   marked Draft for the owner.
4. "ZapTill vs a cash book / vs a basic POS", no competitor named.
5. Review every page at 1440 and 390 px; videos, posters, the trade filter, the credits page.
6. Keep build, test and check green; tests for new logic.

**How it was measured**
Lighthouse 12 (installed in the session scratchpad, not the repo) on the local build (`astro preview`, port 4329) in
the Playwright Chromium: the mobile preset (Moto G Power-sized screen, simulated slow 4G, 4x CPU slowdown) and the
desktop preset. The preview server does not compress, so the kilobytes below are uncompressed; Cloudflare Pages
serves Brotli, so real transfers are smaller. Scores vary by a point or two from run to run.

**Numbers: before → after** (mobile unless marked)

| | Page | Performance | Accessibility | LCP | CLS | Weight |
|---|---|---|---|---|---|---|
| mobile | `/` | 86 → 100 | 93 → 100 | 3.16 → 1.66 s | 0 → 0 | 180 → 129 KB |
| mobile | `/features/` | 83 → 99 | 93 → 100 | 3.07 → 2.03 s | 0.146 → 0 | 307 → 186 KB |
| mobile | `/pricing/` | 100 → 100 | 91 → 100 | 1.50 → 1.51 s | 0.001 → 0 | 114 → 94 KB |
| mobile | `/analytics/` | 99 → 99 | 93 → 100 | 2.04 → 1.96 s | 0 → 0 | 241 → 148 KB |
| mobile | `/how-it-works/` | 84 → 100 | 92 → 100 | 2.84 → 1.58 s | 0.155 → 0 | 174 → 121 KB |
| mobile | `/who-its-for/` | 91 → 100 | 90 → 100 | 2.82 → 1.36 s | 0 → 0 | 105 → 84 KB |
| mobile | `/contact/` | 91 → 100 | 90 → 100 | 2.82 → 1.36 s | 0 → 0 | 105 → 83 KB |
| mobile | `/credits/` | 100 → 100 | 91 → 100 | 1.51 → 1.89 s | 0 → 0 | 254 → 233 KB |
| mobile | `/for/restaurants/` | 89 → 99 | 93 → 100 | 2.99 → 1.88 s | 0.001 → 0 | 256 → 161 KB |
| mobile | `/for/bars/` | 91 → 100 | 92 → 100 | 2.84 → 1.51 s | 0.001 → 0 | 124 → 97 KB |
| mobile | `/for/quick-service/` | 90 → 100 | 92 → 100 | 2.84 → 1.66 s | 0.04 → 0 | 152 → 109 KB |
| mobile | `/for/retail/` | 99 → 100 | 93 → 100 | 1.64 → 1.51 s | 0.001 → 0 | 117 → 96 KB |
| mobile | `/for/minimarts/` | 99 → 100 | 92 → 100 | 1.66 → 1.73 s | 0.039 → 0 | 193 → 134 KB |
| mobile | `/for/petrol-stations/` | 89 → 100 | 93 → 100 | 2.98 → 1.73 s | 0 → 0 | 151 → 117 KB |
| mobile | `/for/parking/` | 91 → 100 | 90 → 100 | 2.83 → 1.36 s | 0.018 → 0 | 107 → 86 KB |
| mobile | `/privacy/`, `/terms/` | 100 → 100 | 90 → 100 | 1.50 → 1.36 s | 0 → 0 | 104 → 82 KB |
| mobile | `/404` | 91 → 100 | 90 → 100 | 2.82 → 1.36 s | 0 → 0 | 103 → 82 KB |
| desktop | `/` | 100 → 100 | 89 → 100 | 0.51 → 0.41 s | 0.041 → 0 | 1,325 → 1,274 KB (the hero video plays on desktop) |
| desktop | `/features/` | 100 → 100 | 93 → 100 | 0.54 → 0.47 s | 0.036 → 0 | 307 → 186 KB |
| desktop | `/how-it-works/` | 100 → 100 | 92 → 100 | 0.51 → 0.39 s | 0.001 → 0 | 189 → 130 KB |
| desktop | `/for/retail/` | 98 → 100 | 92 → 100 | 0.84 → 0.42 s | 0.038 → 0 | 225 → 150 KB |

Averages over the 18 existing pages: mobile performance 93 → 100, accessibility 92 → 100, LCP 2.41 → 1.60 s, weight
161 → 118 KB, worst CLS 0.155 → 0; desktop performance 99 → 100, accessibility 91 → 100, LCP 0.69 → 0.40 s. Best
practices and SEO were 100 before and after. The new guide pages score 100 / 100 / 100 and SEO 66–69, **on purpose**:
they are drafts with a robots `noindex` (Lighthouse's "is-crawlable" check), see below. The credits page's LCP moved
1.51 → 1.89 s with nothing changed on it but the fonts: run-to-run noise on a photo-heavy page (it still scores 100).

**Done: speed**
- **Fonts self-hosted** (the biggest win: the Google Fonts stylesheet was render-blocking and the late font swap caused
  every CLS above). `public/fonts/figtree-latin.woff2` (15 KB) and `bricolage-grotesque-latin.woff2` (58 KB), from the
  same Google Fonts files, cut with fontTools (in a scratchpad venv) to the latin characters the site uses and to the
  weights it uses (Figtree 400–700, Bricolage 600–800; were 20 KB and 77 KB), `font-display: swap`, both preloaded in
  `Base.astro`. Metric-matched fallbacks ("Figtree Fallback", "Bricolage Fallback": Arial with `size-adjust`,
  `ascent-override`, `descent-override` from the fonts' own metrics) so the swap barely moves text. No request to
  Google any more (also better for privacy). Both fonts are SIL Open Font License; credited on `/credits/` (new
  "Fonts" section).
- **Phone-size images**: `scripts/make-responsive.mjs` writes an 800 px copy of every wide screenshot and video poster
  (`*-800.webp`, 6–51 KB each, e.g. `till-pos` 116 → 51 KB, the hero poster 39 → 22 KB). `Shot.astro` and
  `ProductVideo.astro` add them to `srcset` with `sizes` when the file exists; a desktop still gets the full image.
  Checked: a 390 px phone at 2x loads `reel-poster-800.webp`.
- **Caching** in `public/_headers`: `/_astro/*` a year, immutable (hashed names); fonts 30 days; video, screenshots and
  product tiles a day with a week of stale-while-revalidate.
- Already right, checked: every `<img>` has width and height, one eager image a page, the hero poster eager with
  `fetchpriority="high"`, videos attach their sources only in view (checked: no `<source>` on below-the-fold videos at
  load), no unused-JavaScript or unused-CSS findings worth acting on (the remaining "render-blocking" item is the
  site's own small CSS, estimated saving 0 ms).

**Done: accessibility**
- **Contrast**: the WhatsApp button green `#128c4a` (white text 4.3:1, below AA) → `#0e7a40` (5.4:1), hover
  `#0b6434`. The kitchen display's "Preparing" badge `#3b82f6` (3.7:1) → `#1d4ed8`.
- **Link in a sentence**: the footer's phone number now underlined (it was told apart by colour only, 1.8:1).
- **Target size**: Home's "Quick service →" link under the Bars card is now at least 32 px tall.
- **Features filter**: native buttons with `aria-pressed` (already); new polite live region says "Showing 63 features
  for Shops and minimarts." after a change. Keyboard checked with Playwright: Tab reaches skip link, logo, menu, the
  five filter buttons, then the group links; Enter on "Shops and minimarts" filters and sets `?type=shop`.
- **TradeSwitch** (Analytics): Enter on "Shop" switches the panel, `aria-pressed` follows; both switches on the page
  work independently.
- **Videos**: the Pause/Play toggle works from the keyboard (Enter pauses, the label becomes "Play the video"); with
  reduced motion the hero shows the poster and a "Play the video" button, nothing loads until it is pressed, and it
  plays when pressed. Phones under 640 px get the poster and the button (unchanged).
- Headings order, one H1, alt text: `npm run check` passes on all 23 pages; Lighthouse accessibility 100 everywhere.

**Done: SEO for Kenya**
- Research (web searches, 2026-10-23): Kenyan POS sites and listings (Paylink, SokoniPOS, RACK, Qoba, Jiji
  classifieds, Pesapal's forecourt system, Business Today's POS explainer) title their pages with "POS system Kenya",
  "point of sale software", "supermarket / minimart / restaurant POS", "M-Pesa", "offline", "inventory", and
  petrol-station pages with "forecourt management"; many lead with eTIMS. No search-volume tool was available, so
  these are the words the market uses, not measured volumes. Our pages already said "Kenya" and "M-Pesa" but buried
  the search words behind long titles (up to 93 characters).
- **Titles and descriptions**: every page rewritten to put the search words first and fit a search result (titles
  47–64 characters, descriptions 126–164). E.g. Home "ZapTill | POS system for Kenyan businesses, with M-Pesa";
  restaurants "Restaurant POS in Kenya: kitchen tickets, tables | ZapTill"; retail "Supermarket and shop POS in Kenya:
  barcodes, stock | ZapTill"; minimarts, petrol stations, bars, quick service and car parks likewise; Pricing "POS
  pricing in Kenya: KES 30,000 once per branch | ZapTill". H1s kept (they are the brand's voice); each industry page
  has a small line above its H1 in search words ("Petrol station POS in Kenya", the new `kicker` prop on
  `Industry.astro`). No eTIMS claim anywhere; the existing FAQ line stays.
- **JSON-LD**: `BreadcrumbList` on every industry page (Home › Who it's for › page) and guide; `WebSite` on Home;
  `Article` on each guide (author and publisher the Organization, no person, rating or review). **No LocalBusiness**:
  it needs a street address, and there is none to publish yet (the Organization with `areaServed: KE` and the phone
  stays).
- **Internal links**: each industry page ends its FAQ with "Worth reading" (two guides for that trade); guides link to
  the industry pages, Features groups, Pricing and the calculator; the footer has "Guides for owners"; Pricing's
  comparison links to the pricing guide.
- **Sitemap and canonical**: canonical was already on every page. The sitemap now leaves out draft guides (and the
  hub while all are drafts) via a filter in `astro.config.mjs` reading `src/lib/guides.ts`.
- `scripts/check-dist.mjs` now also fails on a title over 65 characters, a description over 170, a `noindex` page in
  the sitemap or an indexable page missing from it (proved by planting a `noindex` in a built page: it failed).

**Done: guides (DRAFTS for the owner, see below)**
- `/guides/` (hub) and four articles, data in `src/lib/guides.ts`, layout `src/layouts/Guide.astro` (trail, summary,
  reading time, the body, "Read next", a soft WhatsApp + Book a visit close, "Demo businesses in this guide are
  fictional."), pages in `src/pages/guides/`. Each has its own fixed WhatsApp message in `site.ts`.
- **Draft handling**: `status: 'draft'` → `<meta name="robots" content="noindex, follow">`, no sitemap entry, and a
  review note in `npm run dev` only. Visitors can still reach them from the footer and the industry pages. The owner
  flips `status` to `'ready'` per guide once read.
- Real product visuals only: the float screen, the day close, the pumps, the owner's phone summary and the owner video.
- `zaptillCost()` in `guides.ts` adds up the pricing guide's three-year table from `PRICES` (so it follows any price
  change): one branch KES 135,000 (KES 30,000 + 35 paid cloud months), about KES 123 a day; two branches KES 165,000,
  about KES 151 a day; hardware not included.

**Done: ZapTill vs a cash book vs a basic POS** (Pricing, `#compare-title`, before "No surprises")
- Twelve rows (every sale recorded, who was short by name, M-Pesa by cashier, cancelling a paid sale, stock, the
  internet going, a power cut, seeing it from home, your trade, what to do next, setup and training, cost). Honest both
  ways: the cash book "wins" on the internet, power and cost rows (shown in bold); "a basic POS" says "Varies" or
  "ask" rather than guessing. ZapTill's column is the claims check's "Say" column only. A table on desktop, one card
  per row on a phone.

**Checked**
- `npm run build` (23 pages), `npm test` (37 pass; new `test/guides.test.mjs`: every guide has its page and the other
  way round, metadata lengths, drafts = the sitemap's exclusions, no "till" in any guide's visible text or data except
  "Till number", no "24/7", "guarantee", "best in Kenya", "100%", "AI", "eTIMS" or price-rise wording, and the
  three-year sum from `PRICES`), `npm run check` (all pass; heaviest Features at 349 KB).
- Review shots of every page at 1440 and 390 px re-taken (`docs/website/screenshots/site-*.webp`, new
  `site-guides-*`): no horizontal scroll anywhere. Found and fixed: the guides' table style leaked into the day-close
  screen inside a guide (its text grew and was clipped on a phone); Pricing's comparison cards squeezed their row
  title on a phone. The guides hub now uses two columns (four cards in three left an orphan).
- The mobile menu's closed panel measures wider than the screen in the overflow check (its content is laid out while
  hidden); it causes no scroll and fits when open, so left as is.
- No CRLF in any changed or new file.

**Decisions**
- Fonts self-hosted rather than kept on Google: faster, no layout shift, no third-party request; same typefaces.
- Draft guides are reachable but not indexed; one field publishes each.
- The pricing guide gives Analytics as "about KES 10,000 a month on top" rather than a three-year total (it would
  read as KES 360,000 on its own); the sum function can show it if the owner prefers.
- The comparison names no supplier and prices no one else.

**Drafts for owner review**
1. `/guides/stop-cash-going-missing/`: "How to stop cash going missing at your shop" (habits, then how ZapTill does
   each; "a warning is not proof").
2. `/guides/run-two-branches-without-being-there/`: "Running two branches without being there" (same setup in both,
   ten minutes a night, weekly stock and people, partner and accountant logins, a monthly unannounced visit).
3. `/guides/pos-when-the-internet-goes-off/`: "What a POS should do when the internet goes off" (what must keep
   working, what can wait, power and the UPS, six questions to ask any supplier, M-Pesa during an outage; says plainly
   that the dashboard, the email and parking need the internet).
4. `/guides/pos-pricing-setup-vs-monthly/`: "Pricing your POS: setup vs monthly" (compare over three years, ZapTill's
   own sum, what the setup and the monthly fee should buy, questions about "free"; carries the draft-prices banner).
5. The Pricing comparison table.

**Open owner questions (new)**
14. Are the four guides right in tone and facts? Each needs `status: 'ready'` in `src/lib/guides.ts` to be indexed.
15. The pricing guide's line "1% of KES 20,000 a day is about KES 6,000 a month" illustrates per-sale fees in general
    (no supplier named). Comfortable with it?
16. Guide 2 says "a partner sees only the branches you give them" (A582). Is that how you want it described?
17. Guide 3 advises checking M-Pesa on the business phone before handing over goods. Fine as general advice?
18. Should "Guides" go in the header menu too (now footer, industry pages and Pricing only)?
19. A company address would allow LocalBusiness data (Google's map results); is there one to publish?

---

## 2026-10-23 (evening): videos, demo brands, "point of sale", product photos

Four owner additions on top of the balancing work below, same rules (local only; only `apps/website/**` and
`docs/website/**`; product code read, never edited).

**Asked**
- "Record like a video when generating these screenshots … a small video can play on the hero … a beautiful video."
- "Come up with a beautiful client branding … add a dummy logo … make it a bit realistic."
- "Use Point of sale not the word Till."
- "Download images of products … common in the Kenyan market, feel realistic as possible."

**Done: demo brands (fictional)**
- Four made-up businesses, one per trade, in `apps/website/src/assets/demo-brands/` (`brands.json`: names, trade,
  branches, palette, the till accent, receipt header and thank-you line, cashiers; an SVG logo and a one-colour SVG
  for the thermal receipt each):

  | Brand | Trade | Branches | Palette | Mark |
  |---|---|---|---|---|
  | **Kijani Basket** (minimart) | Minimart / shop | Kahawa West, Ruaka | green #1F7A3E, yellow #F2C230, ink #14532D, cream #FFF8E7 | a woven basket with a leaf ("kijani" is green) |
  | **Mama Lishe Grill** | Restaurant | Ngong Road, Westlands, Kilimani | ember #E4572E, amber #FFB347, charcoal #2B2118, sand #F6E7D2 | a flame over the grill bars |
  | **Mvua Café** | Café | Kilimani | navy #1E3A5F, sky #7FB7E6, cream #FAF6EF | a raindrop over a cup ("mvua" is rain) |
  | **Kifaru Fuel & Mart** | Petrol station and forecourt shop | Thika Road | navy #13294B, signal yellow #FFC20E | a K whose arm is a rhino horn ("kifaru"), on a shield |

  Names checked with web searches (no known Kenyan business of these names; none close to Naivas, Quickmart, Carrefour,
  Java, Artcaffe, KFC, Rubis, TotalEnergies, Shell, Ola, Twiga). Mama Lishe Grill was already the site's demo
  restaurant; "Baraka Minimart" and "Ridgeway Service Station" (used earlier today) are gone. No phone numbers on any
  demo receipt.
- `scripts/make-brands.mjs` renders `public/demo-brands/<id>.png` (logo), `<id>-mark.png` (the mark, for the point of
  sale) and `<id>-receipt.png`, plus `src/lib/demo-brands.rasters.json`: each receipt logo **through the product's own
  code** (shared/printing `monoRasterFromRGBA` → `monoRasterToString`, as the dashboard's BrandingTab stores
  `logo_receipt`; printed at `fitMonoRaster(…, 384, 120)` as A530 does).
- Through the real code everywhere: the receipts (`scripts/render-slips.mjs` passes each brand's `logoRaster`, header
  and thank-you line to `renderTicket`; shops and stations pass `kitchenTickets: false`, so no "Kots" line, A580); the
  point of sale screens (the harness answers `branding:get` with each brand's theme (teal, or ocean for Kifaru, from
  the product's own theme list), accent and logo: the brand strip shows across the top and the logo on the PIN screen);
  the labels (`scripts/render-labels.mjs`, Kijani Basket's name on the 58 × 40 label).
- New receipts: Kijani Basket's sale now matches the point of sale shot (milk, bread, flour, eggs, beef 0.640 kg,
  KES 1,246 by M-Pesa), Kifaru's forecourt sale (diesel 11.655 L for KES 2,000, engine oil, water; on the petrol page),
  Mvua Café's takeaway (on the restaurants page, "And for a café"). The receipt component draws the printed logo.
- "Demo businesses shown on this site are fictional." in the footer of every page, under every video, and on the new
  `/credits/` page with each logo and palette.

**Done: product photos (licensed)**
- 39 tiles in `apps/website/public/demo-products/` (400 × 400 WebP, 6–24 KB each, about 0.8 MB in all; they load only
  where shown, lazily), made by `scripts/make-products.mjs` from originals downloaded once to the session scratchpad
  (`stock-downloads/`, images only, nothing run from there). **All from Unsplash** (Unsplash License: commercial use,
  no permission or attribution needed); found through Unsplash's search pages, Unsplash+ (paid) photos skipped. Each
  photo's file, products, source page, image URL, photographer and licence are in `src/data/photo-credits.json` and on
  `/credits/`. Reviewed on a contact sheet: rejected a shelf of branded engine-oil cans and a man refilling from a
  labelled bottle; kept only unbranded shots (milk in a plain bottle, sliced bread, eggs, raw beef, tomatoes, kale for
  sukuma wiki, flour, rice, sugar, oil in a cruet, an unlabelled soda, water, crisps, soap bars, nyama choma, chicken,
  ribs, skewers for mishkaki, grilled fish for tilapia, pilau, burgers, chips, samosas, chapati (flatbread), passion
  fruit, chai, latte, plain jerrycans for oil and coolant, gas cylinders). Some stand-ins are approximate (kale for
  sukuma wiki, flatbread for chapati, a vegetable plate for kachumbari, a cropped plate for ugali).
- Used through the product's real image feature: each demo product's `image_url`, which the point of sale shows on its
  tile (pictures on the point of sale are a ZapTill Online feature, as the Features page says).

**Done: videos**
- Pipeline (in the repo): `tools/till-shots/clip-shop.cjs`, `clip-grill.cjs`, `clip-fuel.cjs` drive the real point of
  sale renderer (the harness, 2x) through each flow and save every step with where the tap lands; the site's own
  receipts and phone summary are captured from the built site; the owner clip uses the dashboard's real Analytics
  captures. `tools/video/stage.html` draws each frame (device frame, the brand badge "Demo business: fictional", the
  ZapTill mark, numbered captions, an eased camera that zooms to the keypad, the payment and the cart, crossfades, and a
  smooth synthetic pointer with a tap ring: no real cursor) and `tools/video/render.cjs` renders 30 fps frames at 1.5x
  in Chromium and encodes with ffmpeg 8 (on PATH): H.264 MP4 (yuv420p, faststart) and VP9 WebM, 1280 × 720, plus a WebP
  poster. Playwright's own recordVideo was not used: it records low-bitrate VP8 that blurs the small point of sale text;
  frame-by-frame rendering is sharp and smooth.
- `apps/website/public/video/`:

  | Clip | Length | MP4 | WebM | Poster | What plays | Where |
  |---|---|---|---|---|---|---|
  | `reel` | 18.6 s | 1.20 MB | 1.12 MB | 38 KB | Kijani Basket sale → Mama Lishe Grill to the kitchen → the owner's phone | Home hero |
  | `shop` | 12.2 s | 0.79 MB | 0.76 MB | 35 KB | scan or tap, weigh 0.640 kg, M-Pesa, the receipt with its logo | /for/retail/ |
  | `grill` | 12.0 s | 0.87 MB | 0.99 MB | 27 KB | Table 4, Spicy on the line, send, the kitchen ticket | /for/restaurants/ |
  | `fuel` | 9.6 s | 0.44 MB | 0.44 MB | 18 KB | Pump 3, KES 2,000, oil and water scanned, the receipt | /for/petrol-stations/ |
  | `owner` | 10.8 s | 0.75 MB | 0.50 MB | 28 KB | the day's summary, "Do this next" (no price rises), branches | /analytics/ |

- `src/components/ProductVideo.astro`: muted, looping, playsinline, no sound. The poster is an ordinary `<img>` (eager
  only on the hero, so the first paint stays fast); the sources are attached only when the video scrolls into view
  (`preload="metadata"` then), and it pauses out of view. Reduced motion, Save-Data or a phone under 640 px: poster
  only, with a "Play the video" button. A Pause/Play button once it plays. The full description is the video's
  aria-label; a short caption plus "Demo businesses are fictional." shows under it. Without JavaScript: the poster.
- Review frames: `docs/website/screenshots/video-reel-frame-weigh.webp`, `video-reel-frame-kitchen.webp`,
  `video-fuel-frame-pump.webp`; the logos: `demo-brands-sheet.webp`.

**Done: "point of sale"**
- Every visible "till" / "tills" became "point of sale" / "points of sale" (204 places: pages, FAQ, site.ts, roles,
  the leak calculator, alt text, meta, JSON-LD, the Open Graph text in `make-og.mjs`); "POS" where it reads better
  ("web POS", "desktop POS", "POS computer", "the POS keypad"), with "point of sale (POS)" at the first mention on Home,
  Features, Petrol stations and Car parks. Headlines: "Pay once for your point of sale." File names and code
  (`till-pos.webp`, `tools/till-shots`) stay. There was no M-Pesa "Till number" in the copy; it would be allowed.
- `scripts/check-dist.mjs` now fails on any "till" in a page's visible text, alt, aria-label, title, meta or JSON-LD
  (tested by planting "Ask at the till" in a built page: it failed; "Till number" passed).

**Also**
- Re-shot with the brands and photos: `public/screens/till-pin.webp` (Mama Lishe's logo on the PIN screen),
  `till-float`, `till-pos`, `till-split`, `till-shop`, `till-shop-pin` (Kijani Basket's), `till-pumps`, `till-weigh`,
  `till-pump-entry` (`node scripts/make-screens.mjs --trades tools/till-shots`). The harness serves the site's
  `/demo-products/` and `/demo-brands/` (`serve.cjs`); `mock.js` (Mama Lishe) and `shop.js` / `petrol.js` carry the
  brands and photos. `till-shifts.webp` and the Analytics captures are unchanged.
- Tests: 30 pass (new: each demo receipt prints its brand's logo above the name, no "Kots" on a shop receipt, the
  weighed beef prints "0.640 kg @ 650/kg", no phone number on a demo receipt). `npm run check`: 18 pages, heaviest
  Features at 347 KB (the videos are not counted: they load only when played).
- Review shots of every page re-taken at 1440 and 390 px (`docs/website/screenshots/site-*.webp`, plus
  `site-credits-*`): no horizontal scroll anywhere.

**Open owner questions (new)**
9. The brand names and logos: happy with Kijani Basket, Mama Lishe Grill, Mvua Café and Kifaru Fuel & Mart?
10. Stock photos on the demo tiles: fine for marketing, given real clients upload their own? (All Unsplash, credited.)
11. On a receipt each line's amount is shown without VAT (2 × Fresh Milk at KES 65 prints 112.07; the total is
    right). That is how the product prints today; a shopper might be puzzled. Keep?
12. On the petrol receipt the fuel line prints "Qty 1" with "11.655 @ 171.60" under it, no "L" (question 6).
13. The petrol desktop point of sale's "Shop items →" grid still shows only the fuel grades (question 1), so the fuel
    clip scans the shop items, as the site says.

---

## 2026-10-23: balancing every business type

Local only: nothing committed, deployed or published. Worked only in `apps/website/**` and `docs/website/**`. Read,
never edited: `apps/desktop/src/renderer/pages/POSPage.tsx`, `components/PumpsView.tsx`, `components/WeightModal.tsx`,
`lib/posMode.ts`, `shared/menuFilter.ts`, `shared/businessTerms.ts`, `apps/server/src/lib/analyticsRules.ts` and
`analyticsTerms.ts`, `routes/fueltanks.ts`, `routes/parking.ts`, `lib/lossAlertRules.ts`, the dashboard's
`CashierScreen.tsx`, `PetrolSettingsPage.tsx`, `ParkingSettingsPage.tsx`, `ReportsPage.tsx`, `docs/AUDIT-REGISTER.md`
(A564, A565, A574–A578, A580, A582) and `docs/PARKING-DESIGN.md`.

**Asked**
- Owner: "the whole website markets more of restaurant than all the other businesses how can we sort this?" Balance the
  site across restaurants and cafés, bars and quick service, shops and supermarkets, minimarts, petrol stations, car
  parks and other businesses, in each trade's own words (shared/businessTerms.ts: Menus, Departments, Groups), saying
  only what ships.

**Audit** (visible text and alt text of each built page, header and footer left out; counted words such as restaurant,
kitchen, menu, table, dish, bar / shop, retail, minimart, department, barcode, label, scan, weigh, product, supplier /
petrol, pump, fuel, litre, forecourt, station / parking, bay, plate, vehicle. "Station" also matches "kitchen station",
so the petrol column runs a little high on food pages.)

| Page | Food before → after | Shop before → after | Petrol before → after | Parking before → after |
|---|---|---|---|---|
| / | 47 → 40 | 8 → 40 | 2 → 15 | 0 → 2 |
| /analytics/ | 88 → 94 | 0 → 13 | 1 → 17 | 0 → 0 |
| /contact/ | 4 → 2 | 0 → 2 | 0 → 3 | 0 → 1 |
| /features/ | 59 → 115 | 33 → 97 | 5 → 93 | 0 → 20 |
| /for/bars/ | 29 → 29 | 3 → 4 | 0 → 1 | 0 → 0 |
| /for/minimarts/ | – → 11 | – → 69 | – → 1 | – → 0 |
| /for/parking/ | – → 7 | – → 6 | – → 1 | – → 67 |
| /for/petrol-stations/ | – → 10 | – → 43 | – → 98 | – → 0 |
| /for/quick-service/ | 39 → 39 | 3 → 4 | 1 → 2 | 0 → 0 |
| /for/restaurants/ | 121 → 121 | 3 → 4 | 3 → 4 | 1 → 1 |
| /for/retail/ | 13 → 13 | 62 → 96 | 0 → 1 | 0 → 0 |
| /how-it-works/ | 40 → 41 | 1 → 18 | 0 → 0 | 0 → 0 |
| /pricing/ | 18 → 18 | 13 → 22 | 0 → 5 | 0 → 0 |
| /who-its-for/ | 22 → 20 | 7 → 21 | 4 → 14 | 1 → 7 |

Before, by examples and pictures: Home's hero, the split-payment shot, the kitchen ticket, the offline story ("at a
restaurant"), the Analytics teaser (Tusker for Saturday) and the final call to action ("load your menu") were all
restaurant; the lanes put petrol on "Talk to us" and had no parking. Features opened on a restaurant till, put Kitchen
second and said "on a made-up restaurant". Analytics showed only the demo restaurant's cards. How it works was a
restaurant day only. Pricing listed "Kitchen and dispatch tickets" in the one-off package and "training on your own
menu"; Contact offered only "Ask for a restaurant demo". JSON-LD had no audience; the default Open Graph card said
"Tills, kitchen, M-Pesa". Only `/for/retail/` was shop-first. Petrol had a dashed "talk to us" box; parking was absent.

After: the food pages (restaurants, bars, quick service) are unchanged and still restaurant-first, as they should be.
Analytics stays restaurant-heavy below the cards (what sells when for a restaurant, week at a glance, top 3, branch moves,
credit, payback): the cards and "what sells when" now switch to a shop, and the cards to a petrol station.

**Done**
- **Home** (`src/pages/index.astro`): the hero keeps "Know where every shilling went, every single day." with a neutral
  sub, "In your shop, your restaurant or your station"; the hero visual is the real minimart till (departments as tabs,
  beef weighed at 0.640 kg) with the restaurant till as an inset, "The same till, at a restaurant". New **Built for your
  business** strip: seven cards (Restaurants and cafés; Bars and quick service, with a Quick service link; Shops and
  supermarkets; Minimarts; Petrol stations; Car parks; Other businesses), each to its page. The offline benefit shows the
  petrol till (pumps, diesel and shop items on one sale); the third benefit is "Every item scans. Every order reaches the
  kitchen. Every receipt carries your M-Pesa number." with the shop receipt next to the kitchen ticket; the offline story
  is "the busiest hour" at a minimart and the restaurant next door; the Analytics teaser is the shop's "Put White bread
  400g next to Fresh milk 500ml". Own Open Graph card (`/og/home.png`).
- **New pages** (all on `src/layouts/Industry.astro`, each with FAQPage data and its own Open Graph card):
  - `/for/minimarts/`: the quick queue, weighing at the till (the real keypad shot), departments by the hour (alcohol
    in licensed hours), neighbours on account, out-of-stock choice, deliveries and counts, what sells together, M-Pesa
    and the drawer by name.
  - `/for/petrol-stations/`: the real pumps view and fuel entry (amount or litres, quick amounts, the pump on the sale),
    grades priced a litre per branch, tanks and deliveries in litres, Fuel Sales / Pump Monitor / tank reconciliation,
    the forecourt shop with barcodes and labels (never fuel), the Fuel attendant role, "Offer Water 1L at the pumps", a
    dashed **What ZapTill does not do yet** box (no meter readings or dips) and a closing **Talk to us about your
    forecourt** section.
  - `/for/parking/`: web till only: a bay opened with plate, vehicle type and rate; each hour started charged; cash,
    M-Pesa or card; Parking Overview; the Watch list's "vehicles let out with no charge"; car wash and permits as items;
    a **Good to know** box (needs the internet; no entry ticket, plate camera, barrier, grace period or lost-ticket fee).
- **/for/retail/** is now "Shops and supermarkets": the real shop till, items sold by weight (the old TODO said weighing
  was not built; A577 ships it), departments by the hour, suppliers and what you owe, what sells together, plus a
  weighed-items FAQ.
- **Who it's for** (`who-its-for.astro`): seven cards (shops first) and an **Other businesses** section (`#other`: your
  own groups of products and services, "Ask if ZapTill fits"). The old `#petrol` box is gone; the footer links "Other
  businesses" instead, and `INDUSTRIES` in `site.ts` lists all seven pages (footer, the industry pages' "Also:" line).
- **Features** (`features.astro`): rebuilt from data. Every feature carries its business types; features that are not
  for every type show small tags (Restaurants, Shops, Petrol, Car parks). A **Show the features for** filter (Every
  business, Restaurants cafés and bars, Shops and minimarts, Petrol stations, Car parks) hides the rest and the empty
  groups, and keeps `?type=food|shop|petrol|parking` in the address so a page can link to it. Without JavaScript the
  filter stays hidden and everything shows. Order: Sell, Barcodes and labels, Stock and suppliers, then Kitchen, then the
  new **Pumps and fuel** and **Parking** groups, then money, staff, branches, Analytics, support, offline. Sell shows the
  minimart till with the restaurant inset; Analytics shows the shop card; the roles note says Waiter, Kitchen and Kitchen
  Manager are set up for restaurants and cafés (A580, `roles.ts` marks them `food`).
- **Analytics** (`analytics.astro`, `src/lib/analyticsDemo.ts`, `src/components/TradeSwitch.astro`): a **Show it for**
  switch on the demo cards: Restaurant (the existing seven), Shop (a demo minimart: order about 45 more Fresh milk before
  Friday; put White bread next to Fresh milk; cooking oil runs out in about 2 days; stock up for Saturday; chase KES
  18,600; "Check Kevin's voids" as a warning) and Petrol station (offer Water 1L at the pumps; put Coolant next to Engine
  oil; order about 20 more Engine oil before Saturday; gas refills for Friday; chase KES 64,500 from account customers;
  "Check Brian's discounts" as a warning). "What sells when" switches between the restaurant and the shop (the owner's
  example: bread and milk sell most from 6 to 9 am). Card wording follows the app's rules (`togetherAdvice`: "Put … next
  to …" in a shop, "Offer … at the pumps" at a station; "often/sometimes" by share; stock plans +10%, KES at risk = units
  short × price). Fuel is never a stock card. No price rise anywhere; warnings carry no figure. Without JavaScript all
  three sets show one under another, each labelled.
- **How it works**: still Mama Lishe Grill's day, with a short **At the minimart** line at each moment (Kevin's float at
  6:30, the queue scanning and the beef weighed, labels instead of a kitchen, the milk delivery and expired yoghurt, the
  close, the milk and bread cards).
- **Pricing**: the one-off package lists "Set up for your trade: departments, barcodes and weighed items for a shop;
  menus and kitchen tickets for a restaurant; the pumps for a petrol station" instead of kitchen tickets; Analytics lists
  what sells together and "menu engineering for restaurants"; setup items speak of products, scanners, labels, pumps and
  attendants; "each extra computer (another till, a second counter, a kitchen screen)". Owner rules kept as they were:
  setup per branch, cloud per business, month to month or 3/6/12 months, no discount for paying ahead, extra computers
  from about KES 10,000 quoted, support 8 am to 7 pm and 24 hours for priority clients, the draft banner.
- **Contact**: "Or ask for a demo for your trade: a shop, a restaurant, a petrol station or a car park" (four fixed
  WhatsApp messages); the visit looks at "your counter, your shelves, your kitchen or your pumps".
- **FAQ** (`faq.ts`): new answers for weighed items, licensed hours, the fuel sale, tanks, the forecourt shop, the pumps
  offline, how a parking session works, parking and the internet, tickets and plates, cars let out without paying; new
  lists `MINIMART_FAQ`, `PETROL_FAQ`, `PARKING_FAQ`; `RETAIL_FAQ` gains the weighed-items answer.
- **JSON-LD and meta**: `softwareApplication` now carries `audience` (BusinessAudience, Kenya): retail shops and
  supermarkets, minimarts, restaurants and cafés, bars and lounges, quick service, petrol stations, car parks. Home,
  Features, Analytics, Who it's for, Retail, How it works descriptions name the other trades. Open Graph cards
  (`scripts/make-og.mjs`): new home, minimarts, petrol-stations, parking; who-its-for, features, retail, how-it-works
  and analytics redrawn.
- **Screens** (`tools/till-shots`, the real till renderer with made-up data; renamed and branded in the evening entry
  above): `shop.js` + `s-shop.cjs` ("Baraka Minimart", now Kijani Basket, Kahawa West: Groceries / Beverages / Household / Personal care tabs, milk, bread, flour, eggs, beef 0.640 kg
  at 650/kg = KES 416, total KES 1,246) and `petrol.js` + `s-pumps.cjs` ("Ridgeway Service Station", Thika Road: five
  pumps, KES 2,000 = 11.66 L of diesel on Pump 3, Engine Oil 1L and Water 1L scanned, total KES 2,920). `run.cjs` takes
  `EXTRA=` to load them. `scripts/make-screens.mjs --trades tools/till-shots` writes `public/screens/till-shop.webp`,
  `till-pumps.webp`, `till-weigh.webp` (the weight keypad) and `till-pump-entry.webp` (the fuel entry). The barcode
  labels stay the real `LabelSamples`. The parking hero is a **CSS illustration** of the web till's bay grid, captioned as
  one: parking is web-only and the harness renders the desktop till.
- Tests: `test/analytics-demo.test.mjs` (no card for any trade suggests raising a price; warnings carry no estimate;
  shop and petrol cards use their own words, never a kitchen's); `test/schema.test.mjs` checks the audience and the new
  FAQ lists. READMEs (`apps/website`, `tools/till-shots`, `docs/website/screenshots`) and WORKPLAN §3 (weighed items,
  menus by the hour, petrol, car parks, the Watch list: say / don't say) and §4 (site map) updated.

**Decisions**
- **Minimarts get their own page**, not a fold into retail. ZapTill has `minimart` as its own business type (setup
  "Minimart: Grocery & convenience", its own web POS screen), people search for "minimart POS", and the page has its own
  angle (the quick queue, the butchery and produce by weight, licensed hours for alcohol, neighbours on account).
  `/for/retail/` is "Shops and supermarkets" (stock, suppliers, labels, branches). There is no "supermarket" type in the
  product; supermarkets sit under retail.
- **Bars and quick service share one Home card** (with a second link), so the strip has seven cards, as asked.
- **Petrol describes only the forecourt features in the code**, with a plain "does not do yet" box and the "talk to us
  about your forecourt" call to action kept. On the desktop till, shop items are described as **scanned** (see question 1).
- **Parking says plainly that it runs on the web till and needs the internet**; the offline claims on the site now say
  "the scanner, the kitchen tickets and the pumps", and Features notes that parking needs the internet.
- The trust strip no longer says "Trusted by restaurants, bars and shops": it reads "Made in Kenya for every business that
  sells over a counter: shops, restaurants, bars, stations and car parks", which claims no clients (see question 7).
- The Watch list (A576, premium) is described as "with ZapTill Analytics" (see question 4).

**Placeholders**
- The parking hero is an illustration, not a capture (captioned).
- Analytics below the cards (week at a glance, top 3, branch moves, credit, payback) is still the demo restaurant's only.
- How it works is still a restaurant day, with minimart lines beside it; a full shop day would need more shop captures
  (receiving, the shift report) from the harness.

**Checked**
- `npm run build` (17 pages), `npm test` (28 pass), `npm run check` (links, anchors, titles, headings, alt text, JSON-LD;
  heaviest page Features at 260 KB).
- Review shots at 1440 and 390 px of every changed and new page, plus Features filtered to shops and petrol and Analytics
  switched to shop and petrol, looked at: no horizontal scroll on any page (scrollWidth = clientWidth). Saved to
  `docs/website/screenshots/site-*-desktop.webp` / `-phone.webp` (new: for-minimarts, for-petrol-stations, for-parking,
  features-filter-shop, features-filter-petrol, analytics-shop, analytics-petrol).
- `grep`: no "hotel", "24/7" or price-rise wording in the copy; no CRLF in any changed file.

**Open owner questions**
1. **Desktop petrol till, a product issue:** "Shop items →" opens a grid that lists only the fuel grades (`POSPage.tsx`
   `matchFuel`: `isPetrol ? is_fuel === true`), so shop items can only be sold by **scanning** on the desktop till; the
   comment says "Shop items → clears the fuel filter" but nothing does. The site says shop items scan. Should the grid
   show the shop items?
2. Parking runs on the web till only (not the desktop till) and needs the internet. Is the web till part of what a car
   park buys, and what does a car park pay (the setup is priced per branch for the desktop app)?
3. Parking billing uses the rate typed when the bay opens (default 200); the bay rates, vehicle-type rates and grace
   period in Parking Settings are saved but not used, and nothing prints a ticket. The site claims none of these. Are
   they planned?
4. Is the Watch list (loss alerts, premium since A580) sold as part of the Analytics add-on? The site says "with ZapTill
   Analytics".
5. Petrol: the site says ZapTill does not take pump meter readings or tank dips yet. Is that the right wording, and is
   meter reconciliation planned? The "Station policies" switches (litres on the receipt, attendant name) are saved but
   not used.
6. On receipts, litres print as the quantity ("20.5 @ 180") without an "L"; the site only says the bill shows the litres.
7. The trust strip: if there are paying clients in petrol or parking (or only restaurants, bars and shops), say which and
   we can put "Trusted by …" back with the right list.
8. Other businesses: are "a hardware store, a salon, an agrovet, a car wash" fair examples to name?

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
