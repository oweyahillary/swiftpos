# MANIFEST 2026-09-22-b — register housekeeping after the repo review (docs-only)

**Base commit:** `dev` after delivery `-a` (the doc-refs fix; CI green, owner-confirmed).
**Rule 18:** docs only — no zip. Apply the files below over the repo root.
**Environment:** Linux, Node 22.22.2 — the three gates below are pure file parsing.

## Files (5)

| File | Change |
|---|---|
| `docs/AUDIT-REGISTER.md` | A309 entry (CLOSED — the CI red and its process cause). A295 entry OPENED as the Phase 1 branding tracker with the §10 item table and the lead-dev decision that the receipt logo stays in scope. A237 re-graded FIX BUILT: Go bridge is live, Node bridge retired on tree evidence, files removed later. Header: Open A-P1 18→19, Counts row gains A295, Last-updated cell, changelog row. |
| `docs/SCOPE-A295-branding.md` | Status line corrected from "not started" to Phase 1 in progress, naming what is and is not built. |
| `docs/HANDOFF-2026-08-08-evening.md` | Dated correction block above the §0 environment note: fleet is Electron 43.4.0 (Node 20 / Windows unchanged). Standing rule text untouched. |
| `docs/VERIFY-BRANDING-PHASE1.md` | NEW — the till checklist with PASS criteria that closes A308 and A278. |
| `docs/MANIFEST-2026-09-22-b.md` | NEW — this file. |

## Verification (rule 7)

```
node scripts/check-register-consistency.mjs
  21 audit ID(s) cited in code; 21 have no entry.        (pre-existing ratchet baseline, unchanged)
  OK — no duplicate IDs, and the header agrees with the body.   A-P1 = 19 re-derived from the body
node scripts/check-doc-refs.mjs
  OK — every cited document is in the tree.
node scripts/check-root-clean.mjs
  OK — repo root is clean (only README.md among tracked docs/archives).
```

NOT verified: nothing in this delivery runs code. The A295 table's "NOT BUILT" claims were made by reading
`escposBridge.ts`, `shared/printing/src/*`, `BrandingTab.tsx:14-17` and grepping for `logo_receipt` — not by
printing. The Node-bridge retirement rests on `localPrintServer.ts:24` and the 09-09 live print record.

## Rollback
```bash
git checkout HEAD~1 -- docs/AUDIT-REGISTER.md docs/SCOPE-A295-branding.md docs/HANDOFF-2026-08-08-evening.md
git rm -q docs/VERIFY-BRANDING-PHASE1.md docs/MANIFEST-2026-09-22-b.md
```
