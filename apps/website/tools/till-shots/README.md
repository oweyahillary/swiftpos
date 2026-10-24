# till-shots: real till screens for the website

Renders the REAL till (the built `apps/desktop/dist/renderer`, read only) in a headless browser, with its compiled
preload wrapped around a stub (`mock.js`) that answers every IPC call with made-up "Mama Lishe Grill" demo data. The
website's `public/screens/till-*.webp` came from here (2026-10-22). It never signs in anywhere and never talks to a cloud.

Needs: the desktop built (`cd apps/desktop && npm run build:all`); `playwright-core` installed where Node finds it
(`npm i --no-save playwright-core`) and a Chromium (set `CHROME` to its exe, or use Playwright's default path).

```
node make-bundle.cjs                  # wraps apps/desktop/dist/main/preload.js -> preload.bundle.js
node serve.cjs                        # serves the till renderer on :5180 (leave running)
node run.cjs '{}' pos.png s-pos.cjs   # one screen: scenario JSON, output file, the steps to click through
```

Other business types (2026-10-23): `EXTRA=shop.js node run.cjs '{"shiftOpen":true}' shop-pos.png s-shop.cjs` (a made-up
minimart: departments as top tabs, beef weighed on the keypad; `KEEP_MODAL=1` keeps the keypad open) and
`EXTRA=petrol.js FUEL=sale node run.cjs '{"shiftOpen":true}' petrol-sale.png s-pumps.cjs` (a made-up petrol station: the pumps,
KES 2,000 of diesel and two scanned shop items; `FUEL=panel` stops at the fuel entry). Capture with `DPR=1.5`, then
`node scripts/make-screens.mjs --trades tools/till-shots`.

Branding and photos (2026-10-23): every scenario is a FICTIONAL demo brand (Mama Lishe Grill in `mock.js`, Kijani
Basket in `shop.js`, Kifaru Fuel & Mart in `petrol.js`): `branding:get` answers with the brand's theme, accent and logo,
and each product carries its photo (`image_url`); `serve.cjs` serves `/demo-brands/` and `/demo-products/` from the
website's `public/`. For the videos, `clip-shop.cjs`, `clip-grill.cjs` and `clip-fuel.cjs` save every step
(`CLIP=<dir>`, with `DPR=2`) with where each tap lands; `../video/render.cjs` turns them into the clips.

`s-*.cjs` are the step scripts (sign-in, float, POS, split payment, shift card…); `W`, `H`, `DPR`, `AT` (fixed clock)
and `EL` (a CSS selector to crop to) are read from the environment. `probe.cjs` lists elements wider than the viewport on
the local website preview (port 4329). Outputs (`*.png`, `preload.bundle.js`) are git-ignored. Convert a chosen PNG with
`apps/website/scripts/make-screens.mjs`.
