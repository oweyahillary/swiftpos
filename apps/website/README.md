# ZapTill website (`apps/website`)

The public marketing site for ZapTill (`zaptill.co.ke`). A fully static [Astro](https://astro.build) site: no server,
no database, no cookies. It is separate from the dashboard (`app.zaptill.co.ke`) and shares no code with the other apps.

Plan and copy rules: [`docs/website/WORKPLAN.md`](../../docs/website/WORKPLAN.md) (§3 is the claims check: the site says
only what ships). Progress: [`docs/website/WEBSITE-LOG.md`](../../docs/website/WEBSITE-LOG.md).

## Run it

Needs Node 22.12 or newer (the repo uses Node 24).

```sh
cd apps/website
npm install          # once
npm run dev          # http://localhost:4321, reloads as you edit; shows the "Coming in phase 2" notes
npm run build        # writes the static site to dist/
npm run preview      # serves dist/ at http://localhost:4321, exactly as it will be deployed
npm test             # the leak calculator, the slips and labels against the real renderers, the structured data, the demo form's checks
npm run check        # after a build: links, anchors, titles, headings, alt text, JSON-LD and page weights in dist/
npm run slips        # re-render the receipts through shared/printing (build shared/printing first)
npm run labels       # re-render the barcode labels through shared/labels.ts and shared/barcode.ts (read only)
```

Astro asks to send anonymous usage data; turn it off with `npx astro telemetry disable` (or set
`ASTRO_TELEMETRY_DISABLED=1`).

Nothing here deploys anything. Deploying (Vercel, its own project) is the owner's step, at Phase 5.

## Where things live

| What | Where |
|---|---|
| Pages (one file per URL) | `src/pages/` (`index`, `pricing`, `contact`, `how-it-works`, `features`, `who-its-for`, `for/restaurants`, `for/bars`, `for/quick-service`, `for/retail`, `analytics`, `privacy`, `terms`, `404`) |
| Industry page layout (hero, problem → fix, FAQ with FAQPage data) | `src/layouts/Industry.astro` |
| Receipts and tickets (the real printer text) | `scripts/render-slips.mjs` → `src/lib/slips.generated.json` → `src/components/screens/Receipt.astro` |
| Barcode labels (the real label code) | `scripts/render-labels.mjs` → `src/lib/labels.generated.json` → `src/components/screens/LabelSamples.astro` |
| Demo request form (Phase 3, front end only, `npm run dev` only) | `src/components/DemoForm.astro`, checks in `src/lib/demoForm.ts` |
| Real screenshots (till, Analytics) | `public/screens/*.webp`, made by `scripts/make-screens.mjs` from captures of the demo business |
| Analytics demo cards, dayparts, top 3 | `src/lib/analyticsDemo.ts` (the demo restaurant's own words) |
| Staff roles | `src/lib/roles.ts` (keep in step with `BUILT_IN_ROLES` in apps/server/src/lib/permissions.ts) |
| Structured data (JSON-LD) | `src/lib/schema.ts` |
| Open Graph cards per page | `public/og/*.png`, made by `scripts/make-og.mjs` |
| Phone number, sign-in link, prices, WhatsApp messages | `src/lib/site.ts`: change a fact once, here |
| FAQ questions and answers | `src/lib/faq.ts` (Home shows an excerpt, Pricing the full list) |
| Leak calculator maths | `src/lib/leak.ts`; the form is `src/components/LeakCalculator.astro` |
| Design system (colours, type, spacing, buttons, FAQ) | `src/styles/global.css` (custom properties at the top) |
| Header, footer, buttons | `src/components/` |
| Device frames (monitor, laptop, phone) | `src/components/frames/` |
| Product screens (real shots, receipts, CSS screens: day close, kitchen display, stock, phone summary, "Do this next") | `src/components/screens/` |
| Page shell, SEO and Open Graph tags | `src/layouts/Base.astro`; stub pages use `src/layouts/Stub.astro` |
| Images, favicons, robots.txt | `public/`; rebuild the images with `node scripts/make-images.mjs <analytics-screenshot.png>` |

## Rules for the content

- **Claims:** only the "Say" column of WORKPLAN §3. No testimonials, logos or numbers until they are real and permitted.
- **Demo data only:** every screen uses the made-up "Mama Lishe Grill". Never a client's name, receipt or numbers.
- **WhatsApp:** every link goes through `waLink()` in `src/lib/site.ts`, with a fixed message we wrote for that page.
  **Never put anything a visitor types (name, phone, email) into a URL.**
- **The leak calculator** runs in the browser only. Nothing is stored, sent or put in the URL.
- **Draft prices:** the Pricing page carries a "Draft — prices being finalised" banner. Remove it (the
  `draft-banner` paragraph in `src/pages/pricing.astro`) when the prices are final. Change the prices in `site.ts`.
- **`TODO(owner)`** comments mark what the owner still has to supply: the company email, support hours, the areas
  visited, client logos, contract and cancellation terms, the typical setup time.

## No form yet (on purpose)

There is no contact or demo form in Phase 1. The demo request form arrives in **Phase 3**, with its spam protection
(Cloudflare Turnstile, a honeypot, a time check, rate limits, Kenyan phone validation, email domain checks; see
`docs/WEBSITE-BRIEF.md` §7) and a cloud route that stores requests in the admin portal. Until then, WhatsApp and the
phone are the way in.
