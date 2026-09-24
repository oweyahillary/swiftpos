# MANIFEST 2026-09-24-b — docs only: A322 closed on target (0.6.4)

**Base commit:** `5b3ce9c` (origin/dev, delivery 2026-09-24-a; tag `v0.6.4`; CI #389 and Release desktop #20 green).
**No code, no deploy.**

**What.** The owner's 0.6.4 checks on mamangina — preview (own name + neutral sample), receipt placeholder, import template — all
PASS. A322 CLOSED with the evidence. Tree row: v0.6.4 released and running (replaces "to be confirmed"). Open counts
A 18/17/18 → **18 P1 · 16 P2 · 18 P3**. New `docs/VERIFY-LOG-2026-09-24.md`.

## Files (3)
| File | Change |
|---|---|
| `docs/AUDIT-REGISTER.md` | A322 → CLOSED; Tree row; Counts; Open; header; changelog. |
| `docs/VERIFY-LOG-2026-09-24.md` | NEW. |
| `docs/MANIFEST-2026-09-24-b.md` | This file. |

## Verification
```
check-register-consistency (18/16/18) / check-doc-refs / check-root-clean → exit 0
```

## Rollback
```bash
git checkout 5b3ce9c -- docs/AUDIT-REGISTER.md && git rm -q --ignore-unmatch docs/VERIFY-LOG-2026-09-24.md docs/MANIFEST-2026-09-24-b.md && rm -f docs/VERIFY-LOG-2026-09-24.md docs/MANIFEST-2026-09-24-b.md
```
