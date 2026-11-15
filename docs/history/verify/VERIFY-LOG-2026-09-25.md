# Verification log — 2026-09-25 (Phase 2: A326 + A327 on target)

Session: **Eugene**, till **mamangina** desktop **0.6.6**, dashboard deployed from `68f65c9`. B Foods: themes **ON**; theme
**Violet**, then **Blossom**; brand colour **#e6d300** (yellow). Three screenshots.

| # | Check | Result |
|---|---|---|
| 1 | Till, Manager screen: thin **yellow brand strip** across the top | **PASS** |
| 2 | Till, Manager sidebar **tinted with the brand colour**, text readable | **PASS** |
| 3 | Till, POS: **Dine in**, **No table**, **Charge** in the theme (Blossom) | **PASS** |
| 4 | Branding page, DARK mode: the selected theme ringed in its own colour with ✓ (the -k fix) | **PASS** |
| 5 | Branding page's till preview matches the real till (yellow strip + tint, theme buttons) | **PASS** |

Earlier the same session (2026-09-24 evening): the PIN screen took the yellow brand colour; Blossom picked on the web reached the till.
Not photographed: the Lock-till curtain (same brand variable as 1–2; covered by the A326 test).
**Closed:** A326, A327.

## §A328 — the web POS follows the theme (dashboard `9d07e57`)
| # | State | What the owner saw | Result |
|---|---|---|---|
| 1 | Themes ON, **Blossom** | Clock, Open Table (white label readable), All, T1 chip, Delivery, Spicy, Add to Order, selected product card + badge, **Charge** — all Blossom; POS ☀ light: Cash + Confirm Blossom, readable | **PASS** |
| 2 | Themes ON, **Reset** (no theme chosen → Ocean) | the same controls Ocean blue | **PASS** |
| 3 | Themes **OFF** (admin) | Charge, All, Dine in, T6 chip, Clock, selected card back to their original green | **PASS** |
| — | Unchanged throughout | prices, tables' "free" green, Restaurant label, Send to Kitchen / Split Bill / Room | **PASS** |

Found on the way (pre-existing): the "Add tip" panel is flat grey in POS light mode → A330. **Closed:** A328.
