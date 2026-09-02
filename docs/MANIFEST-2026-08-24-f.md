# MANIFEST — 2026-08-24-f

**Base commit:** batch -e (`0640afa`) on `audit/2026-08-23`. Applies **on top of -e**.
**Register ID:** **A157** — reconciliation map. Stays **OPEN P2** (per-route
reconciliation + target test to close).
**Working rules:** `HANDOFF-2026-08-08-evening.md` §0, rules 1–23.
**Docs-only (rule 18):** no code changed — the register diff + this manifest.
**Apply:** `git apply MANIFEST-2026-08-24-f.patch` · **Rollback:** `git apply -R MANIFEST-2026-08-24-f.patch`

Asked to wire the four unwired validation schemas. On checking the live payloads,
**force-wiring would break production**, so nothing was wired; instead A157 now carries
a payload-level reconciliation map so the eventual wiring is safe and mechanical.

---

## Why nothing was wired (the "make sure nothing is broken" call)
The `validate()` middleware does `req.body = result.data` and Zod `z.object()` strips
unknown keys. Checked against the actual dashboard payloads:

- **Product create/update (money path) — would 400 real requests.** `ProductsPage.tsx`
  sends `description: … || null` and an `image_url` that can be `''`; the schema has
  `description: z.string().max(500).optional()` (rejects `null`) and
  `image_url: z.string().url()` (rejects `''`). Either **400s a normal product save.**
  Plus 13 handler fields (barcode, cost_price, tax_type, is_kitchen, …) would be stripped.
- **Login (auth path) — would break device binding.** `/login` reads `device_id`
  (`auth.ts:122`) which `LoginSchema` lacks → stripped; `.email()` could also reject an
  email the raw handler accepts.
- **Category create — closest to safe** (palette 6-hex color, numeric sort_order match),
  but `name.max(80)` could newly reject a long name and the handler reads
  `super_category`/`is_kitchen` (need `.passthrough()`); PATCH has no `UpdateCategorySchema`.

Wiring any of these on the bench would be shipping an unverified money/auth-path change —
exactly rule 20 / rule 16 / the standing "nothing broken" instruction. So: not done.

## Files

| # | Change | File | What |
|---|--------|------|------|
| 1 | **edit** | `docs/AUDIT-REGISTER.md` | A157 gains a payload-level "RECONCILIATION MAP" (the breakage proof + per-schema safe-wiring recipe); Last-updated. Open tally **unchanged** (A157 stays OPEN P2). |
| 2 | **new** | `docs/MANIFEST-2026-08-24-f.md` | This manifest. |

## The safe-wiring recipe recorded for the implementer
Per schema: enumerate the full accepted field set, make client-`null`/`''` fields
`.nullable()`/tolerant, `.passthrough()` (or add) the extra handler fields, add an
`UpdateCategorySchema` for the category PATCH, verify `.max()`s against the DB columns,
then `validate(Schema)` and **live-test the money/auth path before closing**. Lowest-risk
first step: category POST with `.passthrough()` after a DB name-length check.

## Evidence (rule 7 / rule 9)
```
check-register-consistency   OK — header agrees with body (tally unchanged)
check-doc-refs               OK — every cited document resolves
```
Docs-only; no build/test surface touched.

## Could NOT be done here (rule 16)
The safe wiring itself — it needs a live product create/edit and a real owner sign-in to
confirm no currently-valid payload is rejected. That is the close condition for A157.
