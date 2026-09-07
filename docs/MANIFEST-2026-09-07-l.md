# MANIFEST 2026-09-07-l — DOC-REFS FIX: add missing A250/A251 manifests, delete printBill.ts

**Base:** origin/dev @ 59d5470. **Corrective.** Docs + one deletion. No code change, no migration.

## Why
After the reconcile, origin's CODE is consistent (all phases wired, print test 25/25), but two
residues remain from the skipped intermediate zips:
- check-doc-refs is RED: the register cites the A250 and A251 delivery manifests
  (docs/MANIFEST-2026-09-07-h.md and docs/MANIFEST-2026-09-07-i.md), whose zips were skipped, so
  the files are absent.
- printBill.ts is still present — the A252 delete step was not run (extracting a zip does not
  delete files). It is dead (no importer) and compiles, so CI did not fail, but it is the retired
  file and should go.

## Files
| File | Change |
|---|---|
| docs/MANIFEST-2026-09-07-h.md | add (A250 delivery record the register cites) |
| docs/MANIFEST-2026-09-07-i.md | add (A251 delivery record the register cites) |
| apps/dashboard/src/lib/printBill.ts | delete (retired in A252) |
| docs/AUDIT-REGISTER.md | reconcile note |
| docs/MANIFEST-2026-09-07-l.md | this manifest |

## What ran + output (rule 7)
```
check-doc-refs         -> every cited document is in the tree
tiny-bridge test       -> 25/25
register/root-clean    -> green
```

## Apply
1. Extract over repo root, then: git rm apps/dashboard/src/lib/printBill.ts
2. node scripts/check-doc-refs.mjs -> green ; node --test tests/tiny-bridge-printing.test.mjs -> 25 green
3. Push; confirm CI green. This is the last of the print-parity clean-up; Phase 4 starts on a green tree.
