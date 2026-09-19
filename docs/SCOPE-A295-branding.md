# SCOPE — A295 · Client branding (Phase 1 + Phase 2)

Status: OPEN (scoped, not started). Author: lead dev. Sits behind the current
desktop close-out queue. This doc is the agreed spec so none of the decisions get
re-litigated at build time. Register anchor: A295.

---

## 1. Goal (and non-goals)

Let a client see *their* restaurant on the till without SwiftPOS losing its own
brand, at low risk and low support cost.

**In scope (Phase 1) — two surfaces a client actually judges:**
1. The **lock / PIN screen** (`PinPage`): client logo + business/branch, keypad,
   small accent touches.
2. The **printed receipt**: client logo as a monochrome raster header.

**Explicitly NOT in Phase 1 (deferred):**
- Full app-wide colour theming (POS grid, manager, tech screens). Deferred to a
  later phase behind a curated-theme approach; not a free re-skin.
- Brand colours on thermal tickets — impossible (printers are monochrome). Only the
  logo prints, as black/white. Set this expectation with the client up front.
- Custom fonts.

**Guiding rule:** default to the quiet option. A POS is used fast under glare; a
mis-read total is worse than a plain screen. Branding must never cost legibility.

---

## 2. Decisions already made (do not re-open)

- **Lock screen layout:** two columns — LEFT: logo, business name, branch line,
  small "powered by SwiftPOS"; RIGHT: "Enter your PIN…", PIN dots, keypad, Enter.
- **Fallback:** if the client has no logo, use the SwiftPOS logo. Branding is
  therefore fully optional — an un-branded business must render exactly as today
  (minus the two-column reflow, which is a general improvement).
- **"powered by SwiftPOS"** stays, small, bottom-left, and is **non-removable** even
  on a branded till. This is the "we don't lose our brand" requirement.
- **Accent colour** is applied ONLY to: the column divider, the active PIN dot, and
  the Enter button. Nothing load-bearing for legibility (never on text, totals, or
  keypad digits).
- **Contrast guard:** the accent is validated for contrast; a client cannot pick a
  colour that renders the Enter button or active dot unreadable. If it fails the
  check, fall back to the SwiftPOS accent.
- **Accent source:** a **curated set** (~6-8 vetted hexes) at launch, not a free
  colour wheel. Free-pick (still guarded) can come later. [Owner to supply the set.]
- **Branch "change" control:** removed from the cashier view; the capability is
  **kept but moved behind the technician gate** (the long-press / `st2.` flow), so
  a wrong-branch enrolment is still fixable in setup/support without exposing it to
  cashiers.

---

## 3. Data model

One branding record per business (branch-level override optional, Phase 2).

Cloud (Postgres / Supabase) — new table:

    business_branding
      business_id   uuid  PK/FK -> businesses(id)
      logo_asset_id uuid  null   -> stored logo image (see Assets)
      accent_hex    text  null   -- one of the curated set; null = SwiftPOS default
      updated_at    timestamptz  -- BEFORE UPDATE trigger (set_updated_at) so it
                                 -- participates in the A291 catalogue-version signal

Logo image storage: reuse whatever asset mechanism the web already has (Supabase
Storage bucket or an existing media table). The logo is stored once, referenced by
`logo_asset_id`. Constrain on upload: PNG/JPG, max ~1 MB, sane dimensions; generate
a small raster suitable for an 80mm receipt header (~384px wide, monochrome) at
save time so the till doesn't have to.

Local (desktop SQLite) — mirror, pulled down, remote-wins:

    branding
      business_id   TEXT PRIMARY KEY
      accent_hex    TEXT
      logo_png      BLOB      -- the synced logo bytes (screen + a mono receipt variant)
      logo_receipt  BLOB      -- pre-rendered monochrome raster for the printer
      synced_at     TEXT

Keeping the bytes local means the lock screen and receipt work fully offline.

---

## 4. Sync path (reuses what we just built)

- The web writes `business_branding`; the `updated_at` trigger bumps it, so the
  A291 `/api/pos/catalogue-version` signal already covers it — a branding change
  propagates to tills in ~20s once the A291 server half is live, no new poll.
- Add branding to the catalogue pull (`/api/pos/init` + `pullCatalogue`): return
  `accent_hex` + the logo (as a URL to fetch, or base64 for small logos) and write
  the local `branding` row. Logo fetch is one extra request on pull only when the
  logo changed (compare a hash/`updated_at`), not every poll.
- Fallback: no row, or null fields -> SwiftPOS logo + SwiftPOS accent.

---

## 5. Desktop changes

- `PinPage.tsx`: reflow to the two-column layout; read `branding` (accent + logo)
  with SwiftPOS fallback; apply accent to divider / active dot / Enter only; render
  "powered by SwiftPOS" (hard-coded, non-removable); remove the cashier "change"
  control and expose branch-change under the existing technician gate instead.
- Receipt renderer (`shared/printing` / `escposBridge`): print `logo_receipt` as the
  header raster when present; SwiftPOS logo otherwise. Monochrome only.
- Contrast guard: a small helper that checks the accent against the dark surface and
  the Enter-button text; below threshold -> use SwiftPOS accent. Applied at render
  time so bad data can never ship an unreadable screen.

## 6. Web changes

- A "Branding" settings page (business scope, admin/owner only): upload logo
  (with the constraints above + a live preview of the lock screen and a receipt
  header), pick accent from the curated set. Writes `business_branding`.
- This lives in the same web app that will host the prod cloud — build it there when
  prod is provisioned.

## 7. Server changes

- CRUD for `business_branding` (owner/admin gated, like other business settings).
- Include branding in `/api/pos/init` and serve/stream the logo asset.
- Serve the pre-rendered monochrome receipt logo variant.

---

## 8. Guardrails / edge cases

- **Legibility:** accent never on text, digits, or totals; contrast-checked on the
  three elements it does touch.
- **Monochrome receipts:** only the logo prints; no colour. Communicated to client.
- **Offline:** logo + accent held locally; screen and receipt work with no network.
- **Un-branded businesses:** identical to today apart from the layout reflow.
- **SwiftPOS visibility:** "powered by SwiftPOS" is not a togglable field.
- **Wrong-cloud safety unaffected:** branding is cosmetic; it does not touch the
  A289 title host-gate or any enrolment/branch binding.

## 9. Phasing

- **Phase 1:** lock screen + receipt logo, one curated accent, business scope.
  Demoable, low risk. (§1-8 above.)
- **Phase 2:** curated app-wide themes, branch-level overrides, per-brand receipt
  footer, and (guarded) free accent pick. (§12-16 below.)

Phase 2 is built ON Phase 1's foundation (the branding record, the sync path, the
contrast guard) — it cannot ship first. Do NOT attempt both in one sitting; Phase 2
is the high-QA half.

## 10. Rough build order — Phase 1 (when picked up)

1. Cloud table + trigger + asset storage + server CRUD.
2. `/api/pos/init` + `pullCatalogue` carry branding; local `branding` table.
3. `PinPage` two-column + accent + fallback + tech-gated branch change.
4. Receipt logo (mono raster).
5. Web branding settings page + previews.
6. Contrast guard + the curated accent set.
7. Test: branded business, un-branded business (fallback), bad accent (guard),
   offline, propagation timing via A291.

## 11. Open inputs needed from owner before build

- The **curated accent set** (~6-8 hexes) and, for Phase 2, the **curated theme set**.
- Confirm logo constraints (formats, max size) are acceptable.
- Confirm business-scope is enough for Phase 1 launch (vs per-branch) — recommend yes.

---

# PHASE 2 — curated app theming, branch overrides, receipt footer

## 12. Phase 2 goal (and the hard constraint)

Extend a client's brand beyond the lock screen into the app chrome, WITHOUT turning
the POS into an unreadable colour experiment. The whole risk of Phase 2 is
legibility: a till is used fast, under glare, by staff who must not mis-read a total
or tap the wrong button. So Phase 2 is **curated themes, not a free re-skin.**

**Decision — curated, not arbitrary:** the client picks from a small set of themes
WE design and test (like the accent set, but a fuller palette per theme). We never
let a client recolour arbitrary surfaces/text. This dodges the accessibility and
per-release QA explosion that a free theme engine would create, while still feeling
bespoke. Free accent pick (guarded) may be offered, but full free theming is out.

## 13. What a "theme" is (token model)

A theme is a small, fixed set of brand tokens layered OVER the existing dark design
system — it does not replace the base tokens, it tints specific roles:

    theme = {
      id            text        -- curated id, e.g. 'emerald', 'sunset', 'navy'
      accent        hex         -- primary accent (buttons, active states, highlights)
      accent_strong hex         -- pressed/emphasis variant of accent
      chrome_tint   hex | null  -- OPTIONAL subtle tint for sidebar/header ONLY
    }

Deliberately NARROW. We tint: primary buttons, active/selected states, the sidebar
brand area, section-header accents, links, the active nav item, progress/loading
accents. We NEVER tint: page/surface backgrounds beyond the optional chrome tint,
body text, totals, keypad digits, table rows, or any status colour (success/warn/
danger/void stay semantic — a voided line must always read as danger regardless of
brand). Themes ship as a code-side registry (`themes.ts`) keyed by id; the branding
record only stores the chosen `theme_id`, never raw colours for the chrome.

## 14. Data model additions (Phase 2)

Extend the Phase 1 record rather than a new table:

    business_branding (added columns)
      theme_id      text  null   -- curated theme id; null = SwiftPOS default theme
      receipt_footer text null   -- per-brand receipt footer line (see §15)

    branch_branding (NEW — optional per-branch override, Phase 2)
      branch_id     uuid PK/FK -> branches(id)
      theme_id      text null   -- overrides business theme for this branch
      accent_hex    text null
      updated_at    timestamptz -- set_updated_at trigger (A291 signal)

Resolution order at the till: branch override -> business branding -> SwiftPOS
default. Both levels ride the existing A291 catalogue-version sync; no new plumbing.

## 15. Per-brand receipt footer

- `receipt_footer` (business, branch can override): a short line printed under the
  existing thank-you / above the mandatory "powered by SwiftPOS" credit.
- Constraints: plain text, length-capped to the paper width (auth-approved rule
  P-15 about authored line breaks still applies), monochrome. No HTML/markup.
- The SwiftPOS credit and the tax-receipt block remain fixed and above any client
  footer text — client copy can add, never replace, the mandated lines.

## 16. Phase 2 build + QA (the reason it's not a "tonight" job)

Theme application is one CSS-variable layer flipped at runtime from the resolved
theme; that part is small. The COST is verification — every themed surface must be
checked in every state, in both light and dark, for each curated theme:

    QA matrix (per curated theme, x light/dark):
      POS grid · cart · payment/tender · manager Overview · Orders · Shift/Z-report
      · Close Day/Branch · Menu · Staff · Settings · Tech screen · lock screen
      · every button state (rest/hover/active/disabled) · status colours intact
      · totals + keypad legible · receipt footer within paper width

Contrast enforcement is mandatory on every tinted role, not just the Enter button.
A theme that fails any contrast check is rejected from the curated set at design
time — clients never see it.

**Phase 2 build order (after Phase 1 ships):**
1. `themes.ts` registry (curated themes) + contrast-vetted at authoring time.
2. Runtime theme provider: resolve branch->business->default, apply as CSS vars.
3. Extend branding record + sync (theme_id, receipt_footer, branch_branding).
4. Web: theme picker (with full-app preview) + footer field + per-branch override UI.
5. Receipt footer rendering.
6. Walk the full QA matrix on real hardware in both modes for every theme.
7. Ship behind the paid/premium tier (see §17).

## 17. Commercial framing

- Phase 1 (logo + one accent + receipt logo): standard-ish, or entry branding tier.
- Phase 2 (curated themes + per-branch + footer): premium/paid upsell. Pricing it
  also naturally caps how many themes we commit to supporting.

## 18. Explicitly still OUT (even after Phase 2)

- Free arbitrary surface/text recolour (legibility risk; unbounded QA).
- Custom fonts. Brand colours on thermal tickets (monochrome hardware).
- Per-user theming. Animated/video splash.

---

# ADDENDUM — colour + logo resolution (2026-09-19 review; Taste Town + KUDO)

Decisions from reviewing two real client logos. These REFINE §2/§5/§6 and are locked.

## A. Curated accent palette (launch set — contrast-vetted)

Eight vetted accents (WCAG checked). "White-on-btn" is white text on the Enter button;
"on-dark" is the accent on the lock surface (#0f172a) for divider/active-dot visibility.

    SwiftPOS Blue (default)  #3b82f6   white 3.68  dark 4.85
    Indigo                   #6366f1   white 4.47  dark 4.00
    Violet                   #7c3aed   white 5.70  dark 3.13
    Emerald                  #059669   white 3.77  dark 4.74
    Teal                     #0d9488   white 3.74  dark 4.77
    Rose                     #e11d48   white 4.70  dark 3.80
    Pink                     #db2777   white 4.60  dark 3.88
    Amber (deep)             #b45309   white 5.02  dark 3.56

The button bar is 3:1 (white bold UI text; SwiftPOS's own blue is 3.68). A client's exact
brand colour may be added to their available set once it passes the guard under rule B.

## B. Adaptive button-text colour (supersedes "one accent, white text")

The Enter button's TEXT colour adapts to the accent's luminance: black text on a bright
accent, white on a dark one — whichever gives the higher contrast, and it must clear 3:1.
If NEITHER clears 3:1, fall back to SwiftPOS Blue. This lets a bright brand colour be used
legibly instead of forcing a muted substitute. The accent still only touches the divider,
the active PIN dot, and the Enter button — never text, totals, or keypad digits.

## C. Logo rendering — chip on screen, threshold on paper

- **Lock screen (dark):** render the client logo on its OWN chip (a bounded, rounded panel
  that KEEPS the supplied background), NOT dropped onto the dark surface. A logo drawn as
  dark artwork on a light background (common) would vanish on a dark surface otherwise.
- **Receipt (monochrome):** luminance-threshold to black-on-white at upload; solid-artwork
  logos print crisply, gradient/colour logos may wash out — so the web settings page MUST
  show a live **receipt preview** and the client approves it (upload a cleaner mark or accept).
  The receipt preview is a requirement, not a nicety.

## D. Worked examples (the reference cases)

- **Taste Town** — brand yellow (~#F5B800), solid black artwork on a yellow field.
  Accent = their yellow; Enter uses **black** text (yellow+white = 1.79 fail; yellow+black =
  11.74). Divider/dot yellow on dark = 9.98 (great). Logo on a yellow chip on the lock
  screen. Receipt: thresholds to crisp black-on-white.
- **KUDO KUDO** — brand red (~#E1251B) + orange/yellow gradient mark, white-bg logo.
  Accent = their red; Enter uses **white** text (4.69, the default path). Logo on a white
  chip on the lock screen. Receipt: banner + knockout text print fine; the gradient chicken
  is the case the receipt preview exists for — client reviews the mono result.

These two cover the spread: bright vs mid accent (black vs white button text), light-bg vs
white-bg logo (chip handles both), solid vs gradient artwork (preview handles the receipt).
