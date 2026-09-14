# MANIFEST 2026-09-13-e — CI fix for the -c delivery (A275)

**Base:** `e2969da` (`dev`) — the commit that carried -a..-d and turned CI red.
**No `version` field touched.** No behaviour change — this only makes -c compile and
pass the schema audit. Two files.

## Why
The -c commit failed four CI jobs:
- **Type-check ratchet / Build / Server-suites** — the same 5 errors:
  `src/routes/day-close.ts … TS2559: Type '400' has no properties in common with type
  'SendErrorOptions'`. `sendError(res, err, options?)` takes an options **object** as its
  3rd arg; I passed `400`. Per `sendError`'s own docs, intentional 4xx messages should be
  plain `res.status().json()` anyway.
- **Schema drift** — `schema-audit.py --strict`: `day_close_instructions` is referenced in
  `day-close.ts` but absent from `scripts/schema-index.json` (built from the live DB, which
  hasn't had migration 102 applied). The schema genuinely changed, so the index needs it.

## Files
| File | Change | Why |
|---|---|---|
| `apps/server/src/routes/day-close.ts` | 5 validation calls `sendError(res, 'msg', 400)` → `res.status(400).json({ error: 'msg' })` | Fixes the 5 TS2559 errors (ratchet/Build/Server-suites); matches `sendError`'s documented use |
| `scripts/schema-index.json` | Add `day_close_instructions` (12 columns per migration 102) | Fixes the schema-audit "referenced but not in DB" failure |
| `docs/AUDIT-REGISTER.md` | Post-delivery fix note on A275 + changelog | Rule 14 |
| `docs/MANIFEST-2026-09-13-e.md` | NEW — this file | Rule 2 |

The 5 correct `sendError(res, error)` object-error calls (500s) are unchanged.

## Verification (rule 7)
- `python3 scripts/schema-audit.py --strict` → **total: 0** (was 1).
- `node scripts/check-schema-drift.mjs` → **OK**.
- `node tests/day-close-relay.test.mjs` → **5 passed** (the edited lines still satisfy the guard).
- `check-register-consistency`, `check-doc-refs`, `check-root-clean`,
  `check-test-registration` → **green**.

## NOT verified here — must confirm on CI (rule 16)
- **server tsc / dashboard tsc** — no `node_modules` on the bench. The fix targets the exact
  TS2559 lines CI reported; re-run the ratchet on push to confirm 0 errors.

## Rollback
```
git checkout e2969da -- apps/server/src/routes/day-close.ts scripts/schema-index.json docs/AUDIT-REGISTER.md
git rm docs/MANIFEST-2026-09-13-e.md
```
