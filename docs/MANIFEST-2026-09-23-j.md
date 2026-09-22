# MANIFEST 2026-09-23-j — register Tree row (v0.6.2 · schema 53 · 105 on prod); fixes CI red on `ea8416a`

**Base commit:** `ea8416a` (the v0.6.2 bump). Docs-only, one file + this manifest.
**Cause:** `check-register-consistency` requires the Tree row to name the desktop version `package.json`
ships. The v0.6.2 bump instructions I gave omitted the register edit — my error, same class as A309/-c
(a delivery that touches something a gate compares, without the paired edit). Gate untouched (rule 20).

## Files (2)
| File | Change |
|---|---|
| `docs/AUDIT-REGISTER.md` | Tree row: desktop v0.6.2 (tag `ea8416a`), `LOCAL_SCHEMA_VERSION` 53, migration 105 applied to prod 2026-09-22 (`verify-db-schema` PASS). Changelog row; Last-updated. |
| `docs/MANIFEST-2026-09-23-j.md` | This file. |

## Verification (rule 7)
```
check-register-consistency OK (Tree line matches package.json 0.6.2) · check-doc-refs OK · check-root-clean OK
```

## Rollback
```bash
git checkout ea8416a -- docs/AUDIT-REGISTER.md && git rm -q docs/MANIFEST-2026-09-23-j.md
```
