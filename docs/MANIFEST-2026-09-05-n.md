# MANIFEST 2026-09-05-n — A226 document styling (+ A225 reprint, cumulative)

**Base:** `origin/dev` @ `7a6defc`. **CUMULATIVE** — also carries the A225 reprint history (not yet
pushed). One zip delivers **A225 + A226**. If you've since pushed A225, tell me and I'll ship A226 alone.

## What A226 does (design: thin top bar + status pill, semantic palette)
Printed documents get a semantic accent: a 6px top bar + a bordered, title-cased status pill.
PO = indigo, GRN = green, transfer despatch = amber, transfer received = teal, cancelled = red. Accents
are thin (light on toner), forced to print (`print-color-adjust:exact`), and status still prints as text
so B&W copies lose nothing.

## Files
| File | Change | Finding | Rollback |
|---|---|---|---|
| `apps/dashboard/src/lib/printDocument.ts` | `accent`+`statusLabel`, `DOC_ACCENT`, top bar, status pill | A226 | restore from `7a6defc` |
| `apps/dashboard/src/pages/stock/PurchaseOrdersPage.tsx` | A225 GRN reprint + A226 accents (PO/GRN) | A225/A226 | restore from `7a6defc` |
| `apps/dashboard/src/pages/stock/StockTransfersPage.tsx` | A225 transfer reprint + A226 accents | A225/A226 | restore from `7a6defc` |
| `apps/dashboard/src/pages/manager/ManagerReceivingTab.tsx` | A226 accents (despatch/received notes) | A226 | restore from `7a6defc` |
| `tests/reprint-history.test.mjs` | A225 guards | A225 | delete file |
| `tests/document-styling.test.mjs` | A226 guards (8/8, mutation-checked) | A226 | delete file |
| `docs/AUDIT-REGISTER.md` | A225 + A226 entries; counts P3 8→10 | — | restore from `7a6defc` |
| `docs/MANIFEST-2026-09-05-m.md`, `docs/MANIFEST-2026-09-05-n.md` | manifests | — | delete files |

## What ran + output (rule 7)
```
tests/document-styling.test.mjs   8/8  (mutations: rename accentbar → red · drop PO accent → red)
tests/reprint-history.test.mjs    5/5  [A225]
apps/dashboard  npx tsc --noEmit  exit 0
check-permission-parity · check-permission-catalogue · register · doc-refs   exit 0
```
Could NOT verify here: the rendered print output (browser). A static preview mirroring the engine's exact
CSS is attached (document-styling-preview.html) so you can eyeball the PO + GRN styling before deploying.

## Apply
1. Extract over root; run gates. 2. `git add` the 8 files; commit; push. 3. Deploy dashboard. Allow pop-ups.
