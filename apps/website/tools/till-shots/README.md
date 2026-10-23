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

`s-*.cjs` are the step scripts (sign-in, float, POS, split payment, shift card…); `W`, `H`, `DPR`, `AT` (fixed clock)
and `EL` (a CSS selector to crop to) are read from the environment. `probe.cjs` lists elements wider than the viewport on
the local website preview (port 4329). Outputs (`*.png`, `preload.bundle.js`) are git-ignored. Convert a chosen PNG with
`apps/website/scripts/make-screens.mjs`.
