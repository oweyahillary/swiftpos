# MANIFEST 2026-09-23-x — docs only: branding Phase 1 closed on target (0.6.3)

**Base commit:** `8df231e` (origin/dev, delivery -w; 3/3 checksums on the tip, gates exit 0, CI #386 green).
**No code, no deploy.**

**What.** The owner's 0.6.3 run on mamangina (version shown 0.6.3): A2, B1, A5, A315 PASS; sync status clean.
- **CLOSED on target:** A321, A278, A308, A319, A315 — and **A295 (branding Phase 1)**: its §10 items 5 and 7, the last two
  open, now pass, so every item is verified on the client's own till.
- **Tree row:** v0.6.3 no longer "to be confirmed" — Release desktop #19 green and the build running on the till.
- **Counts:** A 19/20/20 → **18 P1 · 17 P2 · 18 P3**. A278 was never in the Counts row (pre-existing omission; the gate
  counts the body) — noted in the changelog.
- **Log:** `docs/VERIFY-LOG-2026-09-23.md` gains §0.6.3 with the results as returned. Not recorded by the tester: timings
  and the regression line — stated, not assumed.
- Phase 2 stays a proposal awaiting decisions; A322 is next.

## Files (3)
| File | Change |
|---|---|
| `docs/AUDIT-REGISTER.md` | 6 headings → CLOSED with evidence; A295 §10 rows 5/7; Tree row; Counts; Open; header; changelog. |
| `docs/VERIFY-LOG-2026-09-23.md` | §0.6.3 appended. |
| `docs/MANIFEST-2026-09-23-x.md` | This file. |

## Verification
```
check-register-consistency → OK — header agrees with body (A: 0 P0 · 18 P1 · 17 P2 · 18 P3)
check-doc-refs / check-root-clean → exit 0
```

## Rollback
```bash
git checkout 8df231e -- docs/AUDIT-REGISTER.md docs/VERIFY-LOG-2026-09-23.md && git rm -q --ignore-unmatch docs/MANIFEST-2026-09-23-x.md && rm -f docs/MANIFEST-2026-09-23-x.md
```
