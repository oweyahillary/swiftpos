# MANIFEST 2026-09-21-k — register: branding chain CLOSED on target (A301–A304)

**Supersedes 2026-09-21-j** (Rule 3). Register-only — records an on-hardware verification result.

**Base commit:** `16072d2` (`dev` tip). If `dev` moved, apply the edits by hand (they're small).
**Scope:** `docs/AUDIT-REGISTER.md` only. No code.
**Working rules:** unchanged. **Register IDs:** A301, A302, A303, A304 (status change, not new findings).

## Why

The branding chain was verified on a real till (Till 1) on 2026-09-21: on-till checklist §A–§F
**25/25 pass, 0 fail** — lock-screen reflow/teal, tech-gated feed, cloud store (migration 104
confirmed live), sync-down (remote-wins), offline read, plus 0.6.0 release regression. That's the
target verification these items were waiting on (Rule 16), so they move FIX BUILT → CLOSED.

## What changed

| Change | Detail |
|---|---|
| A301, A302, A303, A304 | `P3 · FIX BUILT` → `P3 · CLOSED 2026-09-21 (verified on target, Till 1)`. |
| Open summary | P3 `21` → `17` (four closed; the gate re-derives this from the body and it agrees). |
| Counts A-P3 list | dropped A301–A304. |
| Changelog | prepended a `2026-09-21 (verify)` session line. |

**Left FIX BUILT on purpose** (not branding, not covered by this pass): A296 (Item-Mix date
filter), A298 (build provenance), A299 (logging), A300 (Rule-21 rename). **No `### A295` entry
exists** — the branding read-path work was folded into the A295 epic via commits without its own
register line, so there is nothing to flip for it; §B/§E confirmed that read path behaves.

**Deferred:** A306 (auto-update banner) stays FIX BUILT — its §G check needs a *newer* release to
download onto a 0.6.0 till, so it's verified when the next release is cut.

## Verification (Rule 7)

- `check-register-consistency` → OK (no dup IDs; header agrees with body at 17 P3).
- `check-doc-refs`, `check-root-clean`, `check-test-registration` → OK.

## Rollback (Rule 2)

```bash
git checkout 16072d2 -- docs/AUDIT-REGISTER.md
```

## Commit (direct to dev, explicit path — never `git add -A`)

```bash
git checkout dev && git pull
git add docs/AUDIT-REGISTER.md
node scripts/check-register-consistency.mjs   # OK before commit
git commit -m "docs: close branding chain A301–A304 (verified on target, Till 1 — §A–§F 25/25)"
git push
```
