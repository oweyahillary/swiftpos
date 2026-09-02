# MANIFEST 2026-09-02-a — session close: handoff + register

**Base:** dev @ fba45bb (apply alongside the final fix zip). Docs only.

| File | Change |
|---|---|
| `docs/HANDOFF-2026-09-02.md` | **NEW.** Session handoff: goal, current state, active files, changes by ID, failed attempts/dead ends, next/skipped/proposed steps, a note, and the test-prompt to run FIRST. |
| `docs/AUDIT-REGISTER.md` | Current as of session close (all 2026-09-01/02 notes; counts re-derived, gates green). Same file shipped in the final fix zip — included here so a handoff-only apply is self-consistent. |
| `docs/MANIFEST-2026-09-02-a.md` | This file. |

## Verification (rule 7)
```
node scripts/check-register-consistency.mjs → OK (header agrees with body)
node scripts/check-doc-refs.mjs             → OK (every cited doc present)
```

## The one thing for next session
Read `docs/HANDOFF-2026-09-02.md` §8 and RUN THE TEST PROMPT before any work — after the
deploy + migration 96 + `RESEND_API_KEY`. Deploy is the bottleneck, not code.

## Rollback
`git restore docs/AUDIT-REGISTER.md && rm docs/HANDOFF-2026-09-02.md docs/MANIFEST-2026-09-02-a.md`
