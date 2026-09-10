# MANIFEST 2026-09-10-hygiene — register cleanup (D10 heading + Counts reconcile)

**Base:** `origin/dev` @ `d272c5e`. **Register only — NO code change.**

## Two fixes
1. **D10 malformed heading.** It read `### D10 · P3 · \`ipcHandlers.ts\` at 1,639 lines` — missing
   the status field, so the heading didn't parse as `### <ID> · <Pn> · <STATUS> · <title>`. It
   happened to derive as OPEN by luck (no status → OPEN), but tooling read the title as the status.
   Fixed to `### D10 · P3 · OPEN · \`ipcHandlers.ts\` at 1,639 lines`.
2. **Counts ID-list reconcile.** The `Counts:` row had under-listed the `Open` summary for a while
   (a cosmetic drift: `check-register-consistency` validates the SUMMARY against the body, not the
   ID list, so it never flagged this). Rebuilt the ID list directly from the body's open headings.
   It now matches the summary exactly:
   - A-P1 **18**, A-P2 **21**, A-P3 **12**; D-P1 **2**, D-P2 **1**, D-P3 **2**; **zero P0s**.

## Related check (no change made): A158
While here, confirmed A158's code-level close conditions all pass in the current tree —
`LoginPage.tsx` deleted; `owner-login` state gone / `enrol` present; `EnrolPage.tsx` exists;
`auth:login` IPC handler removed; server `/desktop-login` tombstoned (410); `terminal-activation`
test green. A158 stays **FIX BUILT / OPEN** pending the owner's runtime confirm on the amber build
(no email/password screen ever appears). It will close in a follow-up once confirmed.

## Files
| File | Change |
|---|---|
| `docs/AUDIT-REGISTER.md` | D10 heading fixed; Counts row rebuilt; changelog |
| `docs/MANIFEST-2026-09-10-hygiene.md` | this record |

## What ran (rule 7)
```
check-register-consistency   OK — header agrees with body; Counts list now matches the summary
check-doc-refs               OK
```

## Apply
```
git pull origin dev
# extract this zip over the repo root, then:
node scripts/check-register-consistency.mjs && node scripts/check-doc-refs.mjs
git add docs/AUDIT-REGISTER.md docs/MANIFEST-2026-09-10-hygiene.md
git commit -m "Register hygiene: fix D10 heading + reconcile Counts list to the body"
git push origin dev
```
Rollback: revert this commit — register only.
