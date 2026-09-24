# MANIFEST 2026-09-24-a — A322: no reference business in shipped product · desktop v0.6.4 row

**Base commit:** `4ba7520` (origin/dev, delivery 2026-09-23-y; 4/4 checksums on the tip, gates exit 0, CI #388 green).
**Register:** A322 OPEN → FIX BUILT (P2). Tree row → desktop **v0.6.4**. Counts unchanged (FIX BUILT stays open).
**Owner decisions applied (2026-09-24):** (1) the test print shows the till's own business name; (2) neutral placeholder
and template row; (3) rename the two checklists, remove the reference menu spreadsheets; (4) add a regression gate.
**Rule 13:** renames and deletions — no deploy window open (assumed from "I approve, proceed"; say so if wrong, and the
renames/removals can be split out).
**Deploy:** desktop **0.6.4** (bump + tag per WORKING-METHOD §7 — the version field is NOT in this zip, rule 22: the owner
runs `npm version 0.6.4 --no-git-tag-version`, committed together with this Tree row). No cloud/dashboard change, no
migration. The web bundle does not include the sample ticket (reproducibility check unchanged).
**Byte-affecting:** yes — the test print / preview (and the committed sample artefacts). Real customer receipts unchanged.

## Files
| File | Change |
|---|---|
| `shared/printing/src/sampleTicket.ts` | Neutral sample: "Your Business", Main Branch, till 000000, phones 0700 000 000, cashier Amina; comment. |
| `apps/desktop/src/main/print/printWorker.ts` | `sampleBusinessForThisTill()`: preview + test print use `session.business_name`, fallback "Your Business". |
| `apps/desktop/src/renderer/pages/ManageTabs.tsx` | Placeholder `@yourbusiness`; template row "House Sauce". |
| `apps/desktop/src/renderer/lib/ticketLines.ts` | Comment. |
| `apps/desktop/test/test-print-business-name.test.mjs` | **NEW.** Real printWorker + real SQLite, 9 checks. |
| `apps/desktop/test/node-reference-bundle.test.mjs`, `node-reference-unpack.test.mjs` | Neutral receipt header. |
| `apps/desktop/package.json` | `test:print-name` script. **Version field untouched (0.6.3).** |
| `shared/printing/test/fixture.ts`, `bridge-sim.ts`, `receipt-footer.test.ts`, `sample.ts`, `raster.test.ts` | Neutral data / labels. |
| `shared/printing/SAMPLE-OUTPUT.txt`, `out/{kitchen-80,dispatch-80,receipt-80,kitchen-58,receipt-58}.bin` | Regenerated (`npm run refresh-artefacts`). |
| `tests/auth-resolution.test.mjs`, `scripts/test-print-resilience.mjs` | Neutral names / labels. |
| `scripts/check-reference-names.mjs` | **NEW gate** — the one place the names are listed; `--self-test`. |
| `.github/workflows/ci.yml` | Steps "No reference business names" + "Desktop test print business name". |
| `docs/SCOPE-A295-branding.md` | Addendum: cases described by shape; decisions and numbers unchanged. |
| `docs/VERIFY-BRANDING-PHASE1.md` | A5 label. |
| `docs/menu/importer-proof.py` | Docstrings. |
| `docs/checklists/verification-checklist-restaurant.html` | **RENAMED** from the reference-named file; content neutralised. |
| `docs/checklists/checklist-printing-twotill.html` | **RENAMED** from the reference-named file. |
| `docs/menu/*.xlsx` (3, reference-named) | **REMOVED** — a reference business's real menu; not product. |
| `docs/AUDIT-REGISTER.md` | A322 FIX BUILT with evidence; Tree row v0.6.4; header; changelog. |
| `docs/MANIFEST-2026-09-24-a.md` | This file. |

**Deletions and renames are NOT in the zip** (a zip can only add/overwrite). Block 3 removes the five old paths with
`git rm`: the two reference-named checklists (their renamed copies ARE in the zip) and the three reference menu spreadsheets.

## Verification (rule 7)
```
node apps/desktop/test/test-print-business-name.test.mjs        9 passed, 0 failed
  mutations (rebuild each): preview → sampleBusiness: 3 FAIL · no blank fallback: 1 FAIL
  tip printWorker + tip sample ticket: 8 FAIL — the preview prints "Buy Goods: 3423273"
node scripts/check-reference-names.mjs                          OK (672 files) · --self-test OK · on the TIP tree: FAIL, lists the hits
shared/printing: drift gate BEFORE refresh → FAIL on all 5 .bin + SAMPLE line 9; after `npm run refresh-artefacts` → npm test green
  (receipt-footer 20/0, raster 40/0, bytes --check + sample --check PASS); SAMPLE diff = only the neutral values
node-reference-bundle 25/0 · node-reference-unpack 19/0 · catalogue-refresh-signal 18/0 · auth-resolution 20/0 · menu-template 7/0
node scripts/test-print-resilience.mjs 55/0 · desktop main + renderer tsc 0 · build-escpos-renderer --check OK
node scripts/run-all.mjs GREEN 117/117 (gates OK, incl. check-reference-names)
check-shared-sync / check-test-registration / check-doc-refs / check-root-clean → exit 0
check-register-consistency: RED until the owner's `npm version 0.6.4` is in the same commit (by design); rehearsed → OK
```

## Not verified here (rule 16) — owner, on desktop 0.6.4
1. Technician test print on mamangina → the header shows the client's OWN business name; "Buy Goods: 000000", "Cashier: Amina".
2. Printers screen preview → the same.
3. Manager › receipt text → placeholder "…Follow us @yourbusiness"; the menu-import template → "House Sauce".

## Rollback (before tagging)
```bash
git checkout 4ba7520 -- . && rm -f apps/desktop/test/test-print-business-name.test.mjs scripts/check-reference-names.mjs \
  docs/checklists/verification-checklist-restaurant.html docs/checklists/checklist-printing-twotill.html docs/MANIFEST-2026-09-24-a.md
```
(`git checkout 4ba7520 -- .` restores every modified AND every removed file; the `rm` drops the files this delivery added.)
After a tag is pushed, do not move it — cut v0.6.5 instead.
