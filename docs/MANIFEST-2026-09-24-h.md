# MANIFEST 2026-09-24-h — CI fix for Phase 2 slice 3 (CI #394): a stale pin in A321's desktop test

**Base commit:** `8f40e02` (origin/dev, delivery 2026-09-24-g — slice 3, desktop 0.6.6). **CI #394 on that commit FAILED**; no
`v0.6.6` tag was cut (correctly — nothing released from a red commit).
**No product code changes. No deploy.** After CI is green on this commit, tag `v0.6.6` here.

**What failed.** Desktop job, step "Desktop catalogue refresh signal" (`apps/desktop/test/catalogue-refresh-signal.test.mjs`, A321):
the check "a cleared branding returns it to the default (null is applied, not ignored)" pinned the exact PIN-page line
`setAccentHex(b?.accentHex ?? null)`. Slice 3 intentionally changed that line so that, with themes ON and no brand colour, the PIN
screen takes the theme. Reproduced on the tip: 17 passed, 1 failed.

**Why it was missed.** The pre-change sweep looked for tests pinning GREEN classes (found one — dashboard, untouched), not for tests
pinning other lines slice 3 edited; and `run-all` does not run `apps/desktop/test`, so not every desktop test was re-run before
hand-over.

**Fix.** The check is re-pinned to its intent — with no brand colour and themes OFF the PIN screen still APPLIES null (back to the
default), never ignores it — against the new line. Every one of the 26 desktop tests was then run on the tip: only this one had failed.
WORKING-METHOD §9 gains the rule: run every test CI runs (run-all AND `apps/desktop/test`) and sweep for tests pinning any edited line.

## Files (4)
| File | Change |
|---|---|
| `apps/desktop/test/catalogue-refresh-signal.test.mjs` | The stale PIN-page pin → its intent. |
| `docs/AUDIT-REGISTER.md` | A326 note; header; changelog. Counts unchanged. |
| `docs/WORKING-METHOD.md` | §9: the lesson. |
| `docs/MANIFEST-2026-09-24-h.md` | This file. |

## Verification
```
on 8f40e02: catalogue-refresh-signal 17/1 (the failure CI saw) → with the fix 18/0
mutations: PIN page ignores null again → FAIL · no-theme falls to a fixed colour instead of null → FAIL
all 26 apps/desktop/test/*.test.mjs on the tip (after tsc -b tsconfig.main.json): only catalogue-refresh-signal had failed
check-register-consistency / check-doc-refs / check-root-clean → OK
```

## After push
When CI is green on this commit: tag **v0.6.6** here (guarded command), then the 0.6.6 checks on the till.

## Rollback
```bash
git checkout 8f40e02 -- apps/desktop/test/catalogue-refresh-signal.test.mjs docs/AUDIT-REGISTER.md docs/WORKING-METHOD.md && git rm -q --ignore-unmatch docs/MANIFEST-2026-09-24-h.md && rm -f docs/MANIFEST-2026-09-24-h.md
```
