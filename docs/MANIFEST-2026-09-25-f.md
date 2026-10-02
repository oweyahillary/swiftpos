# MANIFEST 2026-09-25-f — session close: test labels, A329 step 3 sweep recorded, handoff

**Base commit:** `ba5aeef` (origin/dev, delivery 2026-09-25-e; CI #403; tag `v0.6.7`, Release desktop #23). **No product change.**

- `tests/web-pos-theme.test.mjs`: three check LABELS still described pre-A329 behaviour ("defaults are today's green", "falling
  back to its own green / blue") — reworded; the checks themselves are unchanged (21/21).
- `docs/AUDIT-REGISTER.md`: A329 — v0.6.7 released; step 3 sweep numbers and plan (641 uses, 59 of 104 files) for the next session.
- `docs/HANDOFF-2026-09-25.md` (NEW): today in full, next session in order.

## Files (4)
| File | Change |
|---|---|
| `tests/web-pos-theme.test.mjs` | Three labels. |
| `docs/AUDIT-REGISTER.md` | A329 note; header; changelog. |
| `docs/HANDOFF-2026-09-25.md` | NEW. |
| `docs/MANIFEST-2026-09-25-f.md` | This file. |

## Verification
```
node tests/web-pos-theme.test.mjs 21/21 · check-register-consistency / check-doc-refs / check-root-clean → OK
```

## Rollback
```bash
git checkout ba5aeef -- tests/web-pos-theme.test.mjs docs/AUDIT-REGISTER.md && git rm -q --ignore-unmatch docs/HANDOFF-2026-09-25.md docs/MANIFEST-2026-09-25-f.md && rm -f docs/HANDOFF-2026-09-25.md docs/MANIFEST-2026-09-25-f.md
```
