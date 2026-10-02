# MANIFEST 2026-09-23-y — docs only: session close — evening handoff + WORKING-METHOD.md

**Base commit:** `52ab094` (origin/dev, delivery -x; 3/3 checksums on the tip, gates exit 0, CI #387 green).
**No code, no deploy.**

**What.** At the owner's request, the session is closed with a full handoff and the working method written down so future
sessions run the same way:
- `docs/HANDOFF-2026-09-23-evening.md` — every delivery today (-l … -x) with commit and CI run; state (tip, desktop 0.6.3
  on mamangina, deploys, register 18/17/18); 14 closed / A322 open; next session in order (A322 first, then the Phase 2
  decisions, then the cloud `/health` "env" check); follow-ups logged today; items carried from the morning.
- `docs/WORKING-METHOD.md` (NEW) — roles; the loop; starting a session; building a delivery (sync first, sweep, reproduce
  on the tip, test by execution, mutation-check, gates, register, manifest, zip, fresh-clone rehearsal); the three hand-over
  blocks; confirming "landed" (fresh clone, md5, gates, CI from the Actions page); the desktop release sequence; target
  verification; today's pitfalls and the fix now standard; the session-start prompt. It sits on rules 1–24, does not reword
  them, and records the owner's retirement of rule 18 and the general-purpose ruling (A322).

## Files (4)
| File | Change |
|---|---|
| `docs/HANDOFF-2026-09-23-evening.md` | NEW. |
| `docs/WORKING-METHOD.md` | NEW. |
| `docs/AUDIT-REGISTER.md` | Last updated + changelog row. Counts unchanged. |
| `docs/MANIFEST-2026-09-23-y.md` | This file. |

## Verification
```
check-register-consistency / check-doc-refs / check-root-clean → exit 0 (every document the two files cite exists)
no reference-business names in either file · "server" appears only when quoting rule 21 and in a cloud host name
facts cross-checked against the tip: commits -l…-x, CI #374–#387 all "completed successfully", tag v0.6.3 → 648aaa5,
register Open line 0 P0 · 18 P1 · 17 P2 · 18 P3
```

## Rollback
```bash
git checkout 52ab094 -- docs/AUDIT-REGISTER.md && git rm -q --ignore-unmatch docs/HANDOFF-2026-09-23-evening.md docs/WORKING-METHOD.md docs/MANIFEST-2026-09-23-y.md && rm -f docs/HANDOFF-2026-09-23-evening.md docs/WORKING-METHOD.md docs/MANIFEST-2026-09-23-y.md
```
