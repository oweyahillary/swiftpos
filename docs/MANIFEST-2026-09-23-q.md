# MANIFEST 2026-09-23-q — A320 product name trimmed before the non-empty check

**Base commit:** `d889697` (origin/dev, delivery -p; 12/12 checksums on the pulled tip, gates exit 0, CI #379 green).
No shipped file has moved since; all ship whole.
**Register:** A320 OPEN → FIX BUILT (P3). Header, changelog. Counts unchanged (FIX BUILT stays open).
**Deploys needed:** **cloud only** (`apps/server`). No dashboard, no desktop, no migration. **Byte-affecting:** no.

**Fix.** `PATCH /api/products/:id` accepted `name: '   '` (`nonEmptyString` is `min(1)` on the raw string) and wrote
`name.trim()` → an empty product name. `schemas.ts` now defines `productName = z.string().trim().min(1).max(120)` and
uses it for the name in `CreateProductSchema` and `UpdateProductSchema`. Trim runs FIRST — the other order lets spaces
through. Product-only: `nonEmptyString` serves 12 schemas; the branches/staff siblings are recorded on A320, not changed.
Side effect, benign: a real name with stray spaces is stored trimmed, and the 120 limit counts the trimmed name.

## Files (4)

| File | Change |
|---|---|
| `apps/server/src/lib/schemas.ts` | `productName` (trim → min 1 → max 120) for both product schemas. |
| `tests/product-save-payloads.test.mjs` | 6 A320 cases on the real built middleware. 16 → 22. |
| `docs/AUDIT-REGISTER.md` | A320 → FIX BUILT with evidence + siblings; header; changelog. |
| `docs/MANIFEST-2026-09-23-q.md` | This file. |

## Verification (rule 7)

```
node tests/product-save-payloads.test.mjs (server built)      22 passed, 0 failed
  tip schemas                         → 5 FAIL (spaces/tabs accepted; stray spaces kept; 120 counted untrimmed)
  .min(1).trim() (measure first)      → 3 FAIL (the whitespace cases)
  update-only revert                  → 4 FAIL
node scripts/run-all.mjs                                        GREEN 117 passed, 0 skipped
node scripts/typecheck-ratchet.mjs server dashboard admin       exit 0
check-register-consistency / check-doc-refs / check-root-clean / check-test-registration   OK
```

## Not verified here — owner, after the cloud deploy (optional)
Edit a product, replace the name with spaces, Save → refused with "name: Cannot be empty". Normal saves unchanged.

## Rollback
```bash
git checkout d889697 -- apps/server/src/lib/schemas.ts tests/product-save-payloads.test.mjs docs/AUDIT-REGISTER.md && git rm -q --ignore-unmatch docs/MANIFEST-2026-09-23-q.md && rm -f docs/MANIFEST-2026-09-23-q.md
```
