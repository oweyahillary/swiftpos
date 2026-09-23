# MANIFEST 2026-09-23-l — A315 no duplicate closing thank-you · A314 artefacts refreshed + drift gates

**Base commit:** `778f927` (origin/dev, delivery -k; CI #374 green). No shipped file has moved since; all ship whole.
**Register:** A315 OPEN → FIX BUILT; A314 OPEN → FIX BUILT. Header Last-updated, changelog. Counts unchanged
(FIX BUILT stays open).
**Owner rulings applied (2026-09-23):** (1) duplicate = any authored line equal to the closing line, whole-line,
trimmed, case-insensitive — not "starts with"; (2) the web bundle joins the drift gate in this delivery, esbuild pinned.
**Environment:** Linux, Node 22.22.2 (rule 9: weaker than the Windows/Node 20/Electron 43 target). Renderer, bytes,
bundle and gates are platform-independent and run here as on CI; paper and a deployed web receipt are target-only.
**Byte-affecting:** customer receipts (web + till) lose a duplicated line when the owner/delivery box or the web
per-device default already says it. Kitchen/dispatch bytes identical. **Desktop bytes change** → rides the next
desktop bump (0.6.3, rule 15). No version field ships here (rule 22). No migration, no cloud change.

## Files (14)

| File | Change |
|---|---|
| `shared/printing/src/render.ts` | A315: closing thank-you skipped when an authored line of `thankYouMessage`/`deliveryMessage` equals it (as printed via `sanitize`, trimmed, case-insensitive; custom `closingMessage` too). Private helper `ownerAlreadySays`. TAX line + credit untouched. |
| `shared/printing/test/receipt-footer.test.ts` | Section 6: 9 cases (80/58mm equal, blank default once, case/space, later line, delivery box, "starts with" keeps closing, custom closing, TAX/credit survive). 11→20. |
| `shared/printing/test/bytes.ts` | `--check`: compare each stream to committed `out/*.bin`, fail with file/lengths/first offset; `out/` resolved from the package root. Default (write) unchanged. |
| `shared/printing/test/sample.ts` | Output collected; `--check` vs `SAMPLE-OUTPUT.txt` (LF-normalised, first differing line); `--write` refreshes it. Default (stdout) byte-identical to before. |
| `shared/printing/package.json` | `test` += `bytes.js --check` + `sample.js --check`; new `refresh-artefacts`. **Version field untouched (0.1.0).** |
| `shared/printing/SAMPLE-OUTPUT.txt` | Regenerated: TAX RECEIPT line on the 3 sample receipts + byte counts. Thank-you appears once. |
| `shared/printing/out/receipt-80.bin` | Regenerated 1851 → 1888 bytes. |
| `shared/printing/out/receipt-58.bin` | Regenerated 1363 → 1392 bytes. |
| `shared/printing/README.md` | "Running it" corrected (tests build to `test-dist/`); how to refresh artefacts; BYTE-CHECK/VERIFICATION marked unmaintained. |
| `apps/dashboard/src/lib/escposRenderer.js` | REBUILT (`node scripts/build-escpos-renderer.mjs`, esbuild 0.28.2). Diff = the A315 change only. |
| `scripts/build-escpos-renderer.mjs` | esbuild pinned `esbuild@0.28.2` via npx (root package/lockfile untouched); `--check` builds to a temp file and fails if the committed bundle is stale (LF-normalised, first differing line). |
| `.github/workflows/ci.yml` | New step "Web receipt bundle is reproducible" after "Receipt closing block". |
| `docs/AUDIT-REGISTER.md` | A315, A314 → FIX BUILT with evidence; A314 text corrected (neither generator was in `npm test`); header; changelog. |
| `docs/MANIFEST-2026-09-23-l.md` | This file. |

## Verification (rule 7) — commands and what they printed

```
BASELINE on untouched tip 778f927
  bytes.js (regen) → receipt-80 1927 vs committed 1851 · receipt-58 1423 vs 1363 · kitchen/dispatch md5 OK
  sample.js diff    → only the Thank-you/TAX pair + byte counts on the 3 receipts        (A314 reproduced)
  build-escpos-renderer → md5 b865619396ed before == after                               (bundle in sync at tip)

A315  shared/printing: node test-dist/test/receipt-footer.test.js     20 passed, 0 failed
  M1 guard removed                    → 6 FAIL (all duplicate cases)
  M2 "starts with"                    → FAIL "a longer sentence that merely STARTS with it…"
  M3 case-sensitive                   → 2 FAIL (case/space, custom closing)
  M4 delivery box not consulted       → FAIL "the phrase in the DELIVERY box -> once"
  M5 TAX line moved inside the guard  → FAIL "suppressing the thank-you never takes the TAX line…"
  restored                            → 20 passed, 0 failed
Executed shipped code, web default footerMessage → thankYouMessage (buildReceiptBusinessConfig path):
  tip bundle   : web 80mm thank-you x2 · web 58mm x2            (the live web bug)
  -l  bundle   : web 80mm x1 + TAX present · 58mm x1 + TAX present
Desktop tech test print (sampleOrder/sampleBusiness through compiled dist/):
  tip x2 / x2  →  -l x1 / x1

A314 gate (rule 23)
  --check vs STALE committed artefacts → FAIL receipt-80.bin (1851 vs 1888, offset 1808), receipt-58.bin; SAMPLE line 53
  npm run refresh-artefacts → then --check PASS; git diff = TAX line + counts only; kitchen/dispatch unchanged
  G1 one byte flipped in receipt-80.bin      → FAIL "first difference at offset 900", exit 1
  G2 one SAMPLE line hand-edited             → FAIL "at line 120", exit 1
  G3 kitchen-58.bin missing                  → FAIL "kitchen-58.bin is not committed"
  G4 SAMPLE-OUTPUT.txt as CRLF               → PASS, exit 0   (no wolf on Windows)
  G5 A315 reverted, artefacts not refreshed  → FAIL receipt-80 (1888 vs 1927), receipt-58, SAMPLE line 53
Bundle gate: node scripts/build-escpos-renderer.mjs --check
  before rebuild (stale vs A315) → FAIL at line 410 · after rebuild → OK · hand-edit → FAIL line 410
  truncated → FAIL line 301 · CRLF copy → OK

Suites / gates (with root, server, dashboard, admin, desktop deps installed)
  shared/printing npm test                          exit 0 (18/0, 11/0, 20/0, 11, 4, 34/0, bytes --check, sample --check PASS)
  node scripts/run-all.mjs                          GREEN 113 passed, 0 skipped
    (before installing server/root deps it showed the SAME 7 env failures on the untouched tip — identical list)
  node scripts/typecheck-ratchet.mjs server dashboard admin   Ratchet OK (0/0/0, baseline held)
  apps/dashboard npm run build                      ✓ built
  node scripts/test-print-resilience.mjs            55 passed, 0 failed
  apps/desktop tsc -b tsconfig.main.json --force    exit 0 · tsc -p tsconfig.json --noEmit exit 0
  ci.yml                                            parses (yaml.safe_load)
  check-register-consistency / check-doc-refs / check-root-clean   OK (re-run on the final tree)
```

## Not verified here (rule 16) — owner / target
1. **Paper:** send the refreshed `shared/printing/out/receipt-80.bin` to the XP-80 (same RAW path as A310). Expect ONE
   "Thank you for your business!", then "TAX RECEIPT UPON REQUEST", then "Powered by SwiftPOS" last.
2. **Web:** after the dashboard deploy, one sale from a business with a blank Receipt footer → one thank-you.
3. **Till:** on the next desktop build (0.6.3), a tech test print → one thank-you.
4. **CI:** the new "Web receipt bundle is reproducible" step runs `npx --yes esbuild@0.28.2` (network fetch) — first
   green on the pushed commit is its real proof. A314 closes on that.

## Follow-ups (not in this delivery)
- `bytes.ts` decoder has no `GS v 0` case → no with-logo `.bin` in the drift set yet.
- Delete the unreferenced 2026-08-05 captures `shared/printing/BYTE-CHECK.txt`, `VERIFICATION.txt` (outside a deploy window, rule 13).

## Rollback
```bash
git checkout 778f927 -- shared/printing/src/render.ts shared/printing/test/receipt-footer.test.ts \
  shared/printing/test/bytes.ts shared/printing/test/sample.ts shared/printing/package.json \
  shared/printing/SAMPLE-OUTPUT.txt shared/printing/out/receipt-80.bin shared/printing/out/receipt-58.bin \
  shared/printing/README.md apps/dashboard/src/lib/escposRenderer.js scripts/build-escpos-renderer.mjs \
  .github/workflows/ci.yml docs/AUDIT-REGISTER.md && git rm -q --ignore-unmatch docs/MANIFEST-2026-09-23-l.md && rm -f docs/MANIFEST-2026-09-23-l.md
```
