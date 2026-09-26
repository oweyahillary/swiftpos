# MANIFEST 2026-09-26-a — A329 step 3: the back office's green + blue colours, classified (for owner review)

**Base commit:** `bad4492` (origin/dev, delivery 2026-09-25-f; CI #404 green). **Docs only — no screen, test or gate changes.**

Why: A329 step 3 moves the back office's action colour to a FIXED SwiftPOS teal (never the client theme — A323 4b-2). Owner decisions
2026-09-26: the back office's **blue** primaries move too; the **admin portal stays out**. Method as A326/A328: classify every use first,
the owner reviews, then apply by script (next delivery).

- `docs/A329-back-office-colour-classification.md` (NEW): the sweep (106 files scanned, 62 with hits, 1016 uses: 649 green, 367 blue;
  every form — classes with all prefixes, hex and rgb by hue, named strings) classified use by use with file:line. 619 → teal (592 action,
  6 wordmark, 6 sign-in backdrop, 15 accent), 394 keep (217 status, 28 money, 108 data, 41 blue info), 1 owner decision, 2 dropped.
  Both audit directions recorded with every correction. Four points for the owner at the top. Every file scanned, with its count, at the end.
- `docs/AUDIT-REGISTER.md`: A329 title + step 3 note; Last updated; changelog row.

## Files (3)
| File | Change |
|---|---|
| `docs/A329-back-office-colour-classification.md` | NEW — the classification. |
| `docs/AUDIT-REGISTER.md` | A329 entry; header; changelog. |
| `docs/MANIFEST-2026-09-26-a.md` | This file. |

## Verification (bench: Linux, Node 22 — docs only, no runtime behaviour)
```
node scripts/check-register-consistency.mjs  → OK — no duplicate IDs, and the header agrees with the body.
node scripts/check-doc-refs.mjs              → OK — every cited document is in the tree.
node scripts/check-root-clean.mjs            → OK — repo root is clean.
node scripts/check-reference-names.mjs       → OK (the new doc also grepped by hand for the same patterns: 0)
```

## Owed
Owner: read the document's "Please decide / check" (the "SwiftPOS Blue" preset; the 15 accent uses; blue/green button pairs becoming one
teal; the status-green light-mode follow-up). Nothing to deploy.

## Rollback
```bash
git checkout bad4492 -- docs/AUDIT-REGISTER.md && git rm -q --ignore-unmatch docs/A329-back-office-colour-classification.md docs/MANIFEST-2026-09-26-a.md && rm -f docs/A329-back-office-colour-classification.md docs/MANIFEST-2026-09-26-a.md
```
