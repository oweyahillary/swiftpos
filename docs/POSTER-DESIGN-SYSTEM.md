# ZapTill — Poster design & build system

How we design, build and export the ZapTill marketing posters. One system, stamped into many posters so they read as a family. Built 2026‑11‑12, owner‑directed.

> **Rules that never bend** (see also the marketing memory):
> - **Restaurant POS only.** Market the tested restaurant POS. No other verticals/modules on public material.
> - **No pricing on the artwork.** Pricing stays in the sales conversation, never on a poster or the public website.
> - **Only tested, true claims.** Every feature shown is one that works on‑device (offline selling, M‑Pesa & split bills, tables/tabs, kitchen tickets, shift/daily close, receipt printing, staff PINs).
> - **Artefacts stay local.** Posters live in the repo (`docs/marketing/posters/`). Nothing is published to any cloud/artifact host.
> - **The owner commits.** Leave files uncommitted; hand over a paste‑proof commit command.

---

## 1. The look (design language)

- **Brand:** the ZapTill "Z" logo (`assets/logo.png`), on a dark teal‑night or a **loud, bright** feature colour.
- **Type:** display = **Fraunces** (a high‑craft serif with beautiful *italics*); body = **Figtree**. Loaded from Google Fonts in `posters.css`. The emphasised word in a headline is set in *Fraunces italic* and a bright accent colour — that italic pop is the signature.
- **Colour:** each poster shouts in its own **bright, mixed** palette (e.g. offline = electric blue→cyan + yellow; M‑Pesa = green→teal + yellow). The two intro pieces use the cooler brand set (teal/violet). Mixed, saturated, high‑contrast — never muted.
- **Product‑forward:** show the *real* POS screen (`assets/pos-restaurant.webp`, `pos-payment.webp`) tilted with a glow, and real Kenyan **food** photography (`assets/food-*.webp`). Don't describe what you can show.
- **Craft, not gimmicks:** one clear focal point, generous negative space, a disciplined type scale, subtle Memphis accents (a dot grid, a ring). No stock clip‑art.

## 2. Anatomy of a poster

Every poster has two artboards:

| Format | Size | Use |
|---|---|---|
| **feed** | 1080 × 1080 | Instagram/Facebook feed |
| **story** | 1080 × 1920 | Stories / WhatsApp status |

Standard elements, top to bottom:
1. **Logo lockup** (`⚡ Zap`*Till*) + a small **tag/eyebrow** (the feature name or "Introducing").
2. **Headline** — Fraunces, one line of it in *italic* + the bright accent.
3. **One line of meaning** (the benefit) in Figtree — *why it matters*, not just what it is.
4. **The proof** — the real POS screen (often with a status pill, e.g. "Offline · 3 orders saved") or food/a bolt.
5. **CTA** — a bright pill **"Book a demo →"** next to `zaptill.co.ke`. Every poster ends with the same visible, contrasting call‑to‑action (the one feature the research said we were missing).

## 3. The ecosystem (poster map)

- **Intro / flagship:** `v-light.html` (bright product on a light canvas), `v-lightning.html` (the gradient bolt), plus the orbit/receipt/appetite/device explorations.
- **Feature heroes** (one loud poster each, "NEW PRODUCT" register): `f-offline`, `f-mpesa`, `f-tables`, `f-kitchen`, `f-split`, `f-close`, (and later receipt, staff PINs).
- **The menu** — the food + POS.
- **How it works / onboarding** — a 3‑step process (Join → Sign in → Sell).
- **Ecosystem hub** — the orbit infographic, both a **bolt‑centre** and a **Z‑logo‑centre** variant.
- **In the wild** — a real Kenyan cashier/waiter at a ZapTill till (needs a supplied or AI‑generated photo).
- **Grow your restaurant** — benefits + loud CTA.

## 4. Files & structure

```
docs/marketing/posters/
  posters.css          # shared tokens: Fraunces+Figtree, brand colours, gallery styles
  assets/              # logo.png, pos-restaurant.webp, pos-payment.webp, pos-shifts.webp, food-*.webp
  index.html           # gallery of everything (scaled iframes + export how‑to)
  v-light.html         # intro — bright/light
  v-lightning.html     # intro — gradient bolt
  f-offline.html       # feature hero — offline     (blue)
  f-mpesa.html         # feature hero — M‑Pesa      (green)
  f-<feature>.html     # … one per feature
  exports/             # rendered PNGs: <name>-feed.png, <name>-feed-hd.png, -story, -story-hd
```

Assets come from the website: `apps/website/public/{screens,demo-products}` and `apps/website/public/apple-touch-icon.png`, copied into `posters/assets/`.

## 5. How to add a new feature poster

1. **Copy** `f-offline.html` → `f-<feature>.html`.
2. **Swap the palette** — the `.board` background gradient and the accent colour (keep it bright and distinct from neighbours).
3. **Swap the content** in the `<template>` — tag, headline (put the punchy word in `<em>`), the benefit line, the POS image, the status pill.
4. **Keep the structure** — the `.square`/`.story` layout rules and the `#feed`/`#story` export hook are already right; don't touch them.
5. **Render, eyeball, refine, export.**

Each poster carries a tiny script so `?#feed` / `#story` renders just that board at (0,0) for an exact‑size screenshot.

## 6. Rendering & exporting (the pipeline)

We render with **headless Chrome**. Two gotchas learned the hard way:

- **Use `--headless=old`, not `=new`.** The new mode detaches and often writes nothing; the old mode is reliable here.
- **The file appears ~4–5 s after launch** — always poll for it; don't check immediately.
- A **running Chrome blocks headless** (it forwards to the open instance). If a render returns no file, fully quit Chrome (`taskkill /F /IM chrome.exe`) and retry.

Export one board at exact size:
```bash
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
# feed, HD (2×) → 2160×2160
"$CHROME" --headless=old --disable-gpu --no-sandbox --hide-scrollbars \
  --force-device-scale-factor=2 --user-data-dir="/tmp/u$RANDOM" \
  --window-size=1080,1080 --screenshot="exports/<name>-feed-hd.png" \
  "file:///C:/swiftpos/pos/docs/marketing/posters/<file>.html#feed"
# story, HD → 2160×3840 : window-size 1080,1920 and #story
```
- `--force-device-scale-factor=1` → standard (1080); `2` → **HD/retina** (2160).
- Confirm dimensions with PowerShell + `System.Drawing` if in doubt.

A designer can also skip all this: open the poster in Chrome → right‑click the `.board` → **Inspect** → right‑click the div → **Capture node screenshot** (exact size).

## 7. Copy style

- Headlines: short, confident, benefit‑ or outcome‑led. The punchy word goes italic + accent.
- Body: one honest sentence of *why it matters*.
- Kenyan and concrete: "M‑Pesa", "nyama choma", "KES", real restaurant language. Never the word "till" in user‑visible copy on product surfaces (A586) — but "ZapTill" the brand is fine.
- Always end with the **CTA + `zaptill.co.ke`**. Never a price.
