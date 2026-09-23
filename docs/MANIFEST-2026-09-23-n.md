# MANIFEST 2026-09-23-n — A316 web receipt-logo codec · A317 nullable product description · A314 closed

**Base commit:** `74d29a1` (origin/dev, delivery -m; CI #376 green). No shipped file has moved since; all ship whole.
**Register:** A316 NEW → FIX BUILT (P1); A317 NEW → FIX BUILT (P2); A314 FIX BUILT → CLOSED; A318, A319, A320 NEW OPEN;
tester's VERIFY-BRANDING-PHASE1 results appended to A308 and A278. Header open counts A: 19/17/24 → **20 P1 · 19 P2 · 25 P3**.
**Environment:** Linux, Node 22.22.2 — and the new tests, the printing suite and the builder ALSO on Node 24.21.0 (the
owner's major). Rule 9: weaker than Windows/Electron; neither fix is platform-specific except the builder, whose
Windows branch was exercised on Linux via an `npx.cmd` shim.
**Byte-affecting:** no. The till's stored logo string is byte-identical (see A316 proof); receipts unchanged.
**Deploys needed:** **cloud** (A317, `apps/server`) and **dashboard** (A316, the rebuilt bundle). **No desktop build**
for these two — the till's copy of `raster.ts` produces identical output; it rides the next bump with A315.
**No migration.**

## Files (9)

| File | Change |
|---|---|
| `shared/printing/src/raster.ts` | A316: base64 codec with no `Buffer`/`atob`/`btoa`. Decode accepts exactly the cloud's alphabet; padding stripped and re-derived (the cloud accepts 0–2 `=`); anything else → null. |
| `shared/printing/test/raster.test.ts` | Section 8: codec run with `globalThis.Buffer` DELETED; judged by the cloud's rule; padding + stray-character cases. 34 → 40. |
| `apps/dashboard/src/lib/escposRenderer.js` | REBUILT (`node scripts/build-escpos-renderer.mjs`, esbuild 0.28.2). Diff = the codec only. |
| `tests/web-receipt-logo-browser.test.mjs` | **NEW.** Runs the SHIPPED bundle in a child Node with no Buffer (the page's conditions); cloud regex read from `routes/business.ts`. 6/6. |
| `apps/server/src/lib/schemas.ts` | A317: `description` `.optional().nullable()` in `CreateProductSchema` and `UpdateProductSchema`. |
| `tests/product-save-payloads.test.mjs` | **NEW.** Real built `validateLoose` × the payload each caller sends (web ProductsPage, till ManageTabs, till MenuWorkbench — source lines pinned) + refusals that must survive. 16/16. |
| `scripts/build-escpos-renderer.mjs` | win32: one quoted command line through the shell (`execSync`) instead of args + `shell:true` — no DEP0190 on Node 24. |
| `docs/AUDIT-REGISTER.md` | A316, A317 (FIX BUILT), A314 (CLOSED), A318/A319/A320 (OPEN), A308/A278 target-run notes, header, Counts, changelog. |
| `docs/MANIFEST-2026-09-23-n.md` | This file. |
| — | (`shared/printing/package.json` untouched: `raster.test.js` was already in `npm test`.) |

## Verification (rule 7) — commands and what they printed

```
A316
  equivalence: encode vs Node Buffer, w 1–96 × h 1–5 × {random,0x00,0xFF}   1440 cases, 0 mismatches
  decode vs Node on every cloud-acceptable padding variant                   9600 strings, 0 divergent
  shared/printing: node test-dist/test/raster.test.js                        40 passed, 0 failed
    M1 tip raster.ts (Buffer)   → 5 FAIL (ReferenceError: Buffer is not defined; + stray-char, old decode was lenient)
    M2 no strip-and-repad       → FAIL "unpadded and odd-padded values the cloud accepts still decode"
    M3 lenient decode           → FAIL "characters outside the cloud's alphabet are refused, not skipped"
       (first draft REPLACED a char — a lenient decoder also fails on length, so it was blind; now INSERTS one)
  node tests/web-receipt-logo-browser.test.mjs                               6 passed, 0 failed
    tip bundle                  → 3 FAIL: stored "mono1:16:2:109,182,219,109", decode null, no GS v 0
    child keeps Buffer          → FAIL "ran with no Buffer"
    tip bundle + Buffer kept    → only the guard fails = how A313's check passed on a broken codec
A317
  node tests/product-save-payloads.test.mjs                                  16 passed, 0 failed
    tip schemas                 → 6 FAIL, message verbatim: "Invalid input: expected string, received null"
    create-only revert → 2 FAIL · update-only revert → 4 FAIL (incl. image 5's) · z.any() → 3 FAIL · names min(1) dropped → 1 FAIL
    (first draft's refusal cases used the null payload — refused for the wrong reason; now start from a passing payload.
     That rewrite surfaced A320.)
Builder (DEP0190), Node 24.21.0, win32 branch via shim:
  -m builder  → OK + "(node) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true…"
  -n builder  → OK, no warning; also under --throw-deprecation (exit 0); temp path with a space OK; stale bundle → FAIL line 5
  Linux branch on Node 24 --throw-deprecation → OK
  (Node 22 does not emit DEP0190 at all — checked, so only the Node 24 run counts as evidence.)

Gates
  node scripts/run-all.mjs                                     GREEN 115 passed, 0 skipped (113 + the two new tests)
  node scripts/typecheck-ratchet.mjs server dashboard admin    exit 0 (baseline held)
  apps/dashboard npm run build                                 exit 0
  node scripts/test-print-resilience.mjs                       55 passed, 0 failed
  apps/desktop tsc -b tsconfig.main.json --force / tsc -p tsconfig.json --noEmit    exit 0 / exit 0
  shared/printing npm test (Node 22 and Node 24)               exit 0 · bundle --check OK
  check-register-consistency / check-doc-refs / check-root-clean / check-test-registration   OK (final tree)
```

## Not verified here (rule 16) — owner / target
After **both deploys** (cloud + dashboard):
1. **A316:** Business → Branding → choose the logo → Save branding → "Saved." (no red `logo_receipt` line). Tick "Print
   logo on customer receipts" → the receipt preview shows the logo, not `[no logo]`. One web sale → the logo prints.
2. **A317:** edit a product with an EMPTY description on the web → saves. Same on the till's Manage screen.
3. Re-run VERIFY-BRANDING-PHASE1 **A1–A5, B1, F1–F6**. Record whether "Saved." appeared (A2) and whether B1's price was
   changed via the Edit form or the inline price.
4. **Builder on Windows:** `node scripts/build-escpos-renderer.mjs --check` prints OK and **no DEP0190** line.

## Rollback
```bash
git checkout 74d29a1 -- shared/printing/src/raster.ts shared/printing/test/raster.test.ts \
  apps/dashboard/src/lib/escposRenderer.js apps/server/src/lib/schemas.ts scripts/build-escpos-renderer.mjs \
  docs/AUDIT-REGISTER.md && git rm -q --ignore-unmatch tests/web-receipt-logo-browser.test.mjs \
  tests/product-save-payloads.test.mjs docs/MANIFEST-2026-09-23-n.md && rm -f tests/web-receipt-logo-browser.test.mjs \
  tests/product-save-payloads.test.mjs docs/MANIFEST-2026-09-23-n.md
```
