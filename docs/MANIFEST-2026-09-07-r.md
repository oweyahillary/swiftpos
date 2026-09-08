# MANIFEST 2026-09-07-r — A257: surface field-level validation errors + fix category placeholder

**Base:** origin/dev @ 0825458. **Web-only (dashboard).** No migration. No exe build.
Found during the A157 close test.

## Fixes
- **Validation message** — `validate()`/`validateLoose()` return `{error, errors:[{field,message}]}`;
  the api client used only `error`, so a rejected save showed a bare "Validation failed". Now it
  builds the message from the field errors (`field: message`, joined), falling back to `error`.
  One place — every form benefits; non-validation errors unchanged.
- **Category placeholder** — "New menu section" Name placeholder was hard-coded `e.g. Diesel`
  (petrol), wrong for a restaurant → `e.g. Beverages`.

## Files
| File | Change |
|---|---|
| `apps/dashboard/src/lib/api.ts` | surface field-level validation errors in the message |
| `apps/dashboard/src/pages/products/CategoriesPage.tsx` | placeholder `Diesel` → `Beverages` |
| `tests/validation-wiring.test.mjs` | +2 guards (7) |
| `docs/AUDIT-REGISTER.md` | A257 entry; A-P3 15→16 |
| `docs/MANIFEST-2026-09-07-r.md` | this manifest |

## What ran + output (rule 7)
```
message logic: {error:'Validation failed', errors:[name,base_price]} -> "name: Name is required; base_price: expected number..."
               non-validation error ("Barcode already assigned") unchanged
tests/validation-wiring.test.mjs -> 7/7 green
esbuild transpile (api.ts, CategoriesPage.tsx) -> clean
register/doc/root gates -> green
```
NOT verified here (rule 16): the message on a real rejected save in the UI.

## A157 close-test result (owner UI)
1 login PASS · 3 edit-no-reset PASS (the landmine fix holds) · 4 category create PASS.
The #2 "create failed" was a legitimate empty-name catch, not a regression — the payload sends
null (not "") for optional fields and base_price is a parsed number. With this message fix the
form now tells the user which field to fix.

## Rollback (rule 2)
Web-only. `git revert <this commit>`.

## Apply
1. Extract over repo root.
2. `node --test tests/validation-wiring.test.mjs` -> 7 green; gates.
3. Redeploy dashboard. Retry the product create with an empty name → the error now names the field.
