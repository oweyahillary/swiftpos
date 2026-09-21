# MANIFEST 2026-09-21-l — dashboard: A307 in-app menu template (Large-fries upgrade + Read me)

**Supersedes 2026-09-21-k** (Rule 3).

**Base commit:** `9209573` (`dev` tip — branding chain closed).
**Scope:** dashboard `MenuUpload.tsx` + one root test + the register. No server, no migration.
**Working rules:** unchanged. **Register ID:** A307.

## Why

Trace of "the in-app menu templates": the downloadable template is built **client-side with
SheetJS** in `apps/dashboard/src/pages/products/MenuUpload.tsx` → `downloadTemplate()` (there are
also two CSV templates: `BulkProductImport.tsx`, `BulkIngredientImport.tsx`; the upload parser is
`apps/server/src/lib/productImport.ts`). The menu template already showed the drink-size upgrade
ladder but not a **fries** upgrade — the gap behind "add large fries paid".

## What changed

| File | Change | ID |
|---|---|---|
| `apps/dashboard/src/pages/products/MenuUpload.tsx` | In `downloadTemplate()`: add a **Fries-size** upgrade example (`Regular Fries`: Regular=0 baseline / Large=+60, illustrative), and expand the Read me from 4 lines into fuller guidance (name/plu_code matching, sparse updates, DELETE, one-row-per-item lists with `;` not comma, free vs upgrade ladder + 0 baseline, purchased vs central_kitchen cost). Canonical title kept. | A307 |
| `tests/menu-template.test.mjs` | **new** — 7 source-guard checks (tabs, headers, drink + **fries** examples, ladder-baseline Read me). Auto-registered by the CI `tests/*.test.mjs` glob. | A307 |
| `docs/AUDIT-REGISTER.md` | A307 entry + Open `17 P3`→`18 P3` + Counts `…A306 A307` + a `2026-09-21 (template)` line. | A307 |

**Owner note (recorded in the entry):** the client's *"Kudo Kudo — Restaurant product import
template"* xlsx is a **separate/older artifact** — the app has always generated the SwiftPOS-titled
template (`swiftpos-restaurant-import-template.xlsx`). Standardise on the in-app one.
**Example surcharge:** the Large-fries `+60` is illustrative in a template clients edit — not a
priced business decision.

## Verification (Rule 7)

Bench, Linux/Node 22:
- **`node tests/menu-template.test.mjs` → 7/7** (fries/drink/ladder mutations bite).
- **Dashboard `tsc --noEmit` → 0 errors.**
- `check-register-consistency` OK (A307, P3→18); doc-refs / root-clean / test-registration OK.

**Could NOT verify here (target-only):** downloading the template from the live dashboard and
re-importing a filled copy.

## Rollback (Rule 2)

```bash
git checkout 9209573 -- apps/dashboard/src/pages/products/MenuUpload.tsx docs/AUDIT-REGISTER.md
rm -f tests/menu-template.test.mjs
```

## Commit (direct to dev, explicit paths — never `git add -A`)

```bash
git checkout dev && git pull                    # confirm 9209573; else re-apply the register edits
git add apps/dashboard/src/pages/products/MenuUpload.tsx tests/menu-template.test.mjs \
        docs/AUDIT-REGISTER.md docs/MANIFEST-2026-09-21-l.md
git status --short                              # expect exactly these four
node tests/menu-template.test.mjs && node scripts/check-register-consistency.mjs
git commit -m "feat(dashboard): A307 in-app menu template — add Large-fries upgrade example + fuller Read me"
git push
```

Ships with the dashboard (web) deploy — no desktop release needed; clients get the new template
on their next visit to the menu-upload page.
