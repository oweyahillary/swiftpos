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
