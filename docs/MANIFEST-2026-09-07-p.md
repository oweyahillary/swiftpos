# MANIFEST 2026-09-07-p — A157: wire input validation (safe passthrough) + A141/A256 reconcile

**Base:** origin/dev @ 0825458 (fresh pull). **Server-only code.** No migration. No exe/web build.

## Why
`schemas.ts` defined Zod schemas that no route used; `/login`, product create/update and
category create read `req.body` raw. Wiring them naively strips unknown fields (device
binding, tax fields) — and `UpdateProductSchema.partial()` keeps `.default()` values that
would silently reset product flags on any edit.

## Fixes
- **`validateLoose(schema)`** (new, `middleware/validate.ts`) — validates the KNOWN fields and
  passes unknown fields through untouched (`.catchall(z.unknown())`, Zod-4-safe). No stripping.
- Wired on `/login` (LoginSchema), product create (CreateProductSchema), product update
  (UpdateProductSchema), category create (CreateCategorySchema).
- **`UpdateProductSchema` de-defaulted** — redefined without the inherited `.default()` values,
  so an update only touches the fields it actually sends (no track_stock/variants reset).

## Files
| File | Change | ID |
|---|---|---|
| `apps/server/src/middleware/validate.ts` | add `validateLoose` (catchall passthrough) | A157 |
| `apps/server/src/lib/schemas.ts` | de-default `UpdateProductSchema` | A157 |
| `apps/server/src/routes/auth.ts` | `validateLoose(LoginSchema)` on `/login` | A157 |
| `apps/server/src/routes/products.ts` | `validateLoose` on create + update | A157 |
| `apps/server/src/routes/categories.ts` | `validateLoose` on create | A157 |
| `tests/validation-wiring.test.mjs` | new guard test (5, mutation-checked) | A157 |
| `docs/AUDIT-REGISTER.md` | A157 FIX BUILT; A141 reconcile; A256 filed; A-P2 33→34 | — |
| `docs/MANIFEST-2026-09-07-p.md` | this manifest | — |

## What ran + output (rule 7)
```
behavioural test vs the REAL schemas (zod 4.4.3):
  login passes device_id/terminal_code + rejects bad email
  update injects nothing (only sent fields + passthrough)   ← the landmine, prevented
  create keeps its defaults + passes tax fields
tests/validation-wiring.test.mjs -> 5/5 green (mutation-checked: re-add a default -> red)
esbuild transpile (validate/schemas/auth/products/categories) -> clean
register-consistency · doc-refs · root-clean · test-registration -> green
```
**NOT verified here (rule 16):** a live login + a real product create AND update on prod
(auth/money path) before A157 closes.

## Also in this sweep (no code here)
- **A141** reconciled — bulk ingredient import IS built (`POST /api/stock/ingredients/bulk` +
  `BulkIngredientImport.tsx`); remaining is the owner enabling `ingredients.manage`.
- **A256** filed (P2) — systemic backfill of newly-added default permissions to pre-existing
  roles (A141's root cause). Not built.
- **A50/A54** (mail): code already has the Resend path — set `RESEND_API_KEY` + `NOTIFY_FROM_EMAIL`
  on the server (owner). **A146** (webhook/email observability) + **A159** (write-guard enforce)
  are verify/config, not code.

## Rollback (rule 2)
Server-only. `git revert <this commit>`.

## Apply
1. Extract over repo root.
2. `node --test tests/validation-wiring.test.mjs` -> 5 green; register/doc gates.
3. Deploy the server. Live-check: log in (incl. from a till — device binding intact), create a
   product (tax fields saved), edit a product's name (track_stock NOT reset), create a category.
