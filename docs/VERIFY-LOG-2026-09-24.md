# Verification log — 2026-09-24 (A322 on desktop 0.6.4)

Session: **Eugene**, till **mamangina** (B Foods), desktop **0.6.4** (tag `v0.6.4` on `5b3ce9c`; Release desktop #20; the app
footer reads "SwiftPOS v0.6.4 · win32"). Fix: delivery 2026-09-24-a.

| # | Check | Where | Result |
|---|---|---|---|
| 1 | Test print / preview shows the till's own business name and neutral sample data | Printing › Printers › Till → "Preview — exactly what this printer will produce" | **PASS** — "B Foods", "Main Branch", "Tel: 0700 000 000", "Cashier: Amina" (owner screenshot) |
| 2 | Receipt-text placeholder is neutral | Printing › Receipt | **PASS** — footer hint "Thank you, visit again! / Follow us @yourbusiness"; both boxes empty (placeholders match source) |
| 3 | Menu-import template sample is neutral | the template CSV the till offers for download | **PASS** — contains "House Sauce"; no reference names anywhere in the file |

No printer was needed: the paper test print renders through the same `sampleBusinessForThisTill()` helper as the preview (pinned by
`apps/desktop/test/test-print-business-name.test.mjs`). The print path itself was verified on paper on 2026-09-23 (A315).
**Closed:** A322.

## §A325 — `theme_id` + the `themes` flag (desktop 0.6.5)
Session: **Eugene**, till **mamangina**, desktop **0.6.5** (tag `v0.6.5` on `b69eeca`; Release desktop #21). Deploy order followed:
migration 106 → cloud → admin portal → desktop.

| # | Check | Result |
|---|---|---|
| 1 | Admin → B Foods → *Turn themes on* → ~20 s → Technician mode › Database: `SELECT theme_id FROM branding` | **PASS** — `ocean` (screenshot) |
| 2 | *Turn themes off* → ~20 s → same query | **PASS** — `null` (screenshot) |
| 3 | The screens throughout | unchanged (nothing in slice 2 draws the theme) |

**Closed:** A325.

## §A326 — the till's colours follow the theme (desktop 0.6.6)
Session: **Eugene**, till **mamangina**, desktop **0.6.6** (tag `v0.6.6` on `bb31313` — slice 3 + the CI fix). Seven screenshots.

| Screen | Themes OFF | Themes ON (Ocean; B Foods has no brand colour) |
|---|---|---|
| PIN screen | Phase 1 teal (name, divider) — unchanged | name, divider, Enter in Ocean |
| Manager Overview | grey sidebar — unchanged (blue Revenue card / nav highlight are the original design) | sidebar Ocean tint, text readable |
| Open drawer | — | **Start selling** Ocean |
| POS grid | — | selected **All**, **Dine in**, **T: T10** Ocean; **prices green** |
| Payment | — | **Cash** selected, **+ Split payment**, **Charge KES 100**, cart badge Ocean; prices green |
| Status | — | **Shift open**, **pending** green; **SwiftPOS** wordmark green |

Not exercised: a brand colour (none set) and OFF again (same mechanism as A325). **Closed:** A326.
