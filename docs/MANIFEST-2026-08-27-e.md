# MANIFEST 2026-08-27-e — A171 + A172 + A173 (docs & hygiene, unattended-safe)

**Base:** applies on top of `d7b20a5` + patch `-d` (A170). All three items are
low-risk, need no owner decision, and are fully bench-verified — nothing
target-only.
**Artifact:** `swiftpos-2026-08-27-e.patch`.

## What ships

**A171 (P3, CLOSED) — formalise rule 24.** Rule 24 was cited by ID across the
register but never written into §0 RULES. Added verbatim to its original meaning
in `HANDOFF-2026-08-08-evening.md`. Docs-only.

**A172 (P3, CLOSED) — rule-19 root-hygiene gate.** New `check-root-clean.mjs`
fails if a `.md` (≠ README.md), `.zip`, `.patch` or `.diff` sits in the repo
root. Ignores legitimate root config/code. Prevents the "~140 stray zips" class.

**A173 (P3, CLOSED) — remove a duplicate manifest.** `docs/MANIFEST-2026-08-20-a (1).md`
was a byte-identical browser-download dup, cited nowhere. Removed.

## Files

| File | ID | Change |
|------|----|--------|
| `docs/HANDOFF-2026-08-08-evening.md` | A171 | Rule 24 added to §0 after rule 23. |
| `scripts/check-root-clean.mjs` | A172 | NEW gate + `--self-test`. `run-all.mjs` auto-discovers it. |
| `.github/workflows/ci.yml` | A172 | Runs the gate + self-test. |
| `docs/MANIFEST-2026-08-20-a (1).md` | A173 | DELETED (dup). |
| `docs/AUDIT-REGISTER.md` | — | A171/A172/A173 entries (CLOSED) + changelog; next free ID → A174. Open counts unchanged. Gate green. |
| `docs/MANIFEST-2026-08-27-e.md` | — | This file. |

## Verification (rule 7)

- `check-root-clean.mjs` → clean; `--self-test` → **9 passed**.
- `check-notnull-writes.mjs` (A170) still green + self-test 6/6.
- `check-register-consistency`, `check-doc-refs`, `check-test-registration` → green.
- No code (server/desktop/dashboard) changed → no version bump (rule 15 not triggered), no target-only claims.

## Rollback

```
git apply -R swiftpos-2026-08-27-e.patch
```

All additive except the A173 deletion (a restore of the dup, which nothing
references).
