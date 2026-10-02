# MANIFEST 2026-09-21-d — register: A301 entry (Rule 14) + fold in the -c manifest

**Supersedes 2026-09-21-c** (Rule 3). Docs-only; no code (Rule 18 — no archive is needed to
*apply* code, but one ships here because the register file is 788 KB and must not be hand-edited).

**Base commit:** `35c7229` (`dev` tip — the PR #9 merge). **If `dev` has moved, do NOT extract the
full register over it** — apply the four edits below by hand instead, or rebase.
**Scope:** `docs/` only — `AUDIT-REGISTER.md` (the A301 entry) and `MANIFEST-2026-09-21-c.md`
(added so the register's citation of it keeps `check-doc-refs` green).
**Working rules:** unchanged — `HANDOFF-2026-08-08-evening.md §0`.
**Register ID:** A301 (now entered — this closes the Rule 14 debt for the branding write path).

## What changed and why

| File | New? | Change | ID |
|---|---|---|---|
| `docs/AUDIT-REGISTER.md` | edit | Four surgical edits (below). | A301 |
| `docs/MANIFEST-2026-09-21-c.md` | **new** | The test-registration fix's manifest, now folded into the tree because the A301 register entry cites it (and `-a`/`-b`). | A301 |

The four register edits (so they can be applied by hand if `dev` moved):
1. **Body §A:** new `### A301 · P3 · FIX BUILT · Desktop-local branding WRITE path …` inserted
   between the A300 and A276 entries.
2. **Open line:** `… 17 P2 · 15 P3 …` → `… 17 P2 · 16 P3 …` (A301 is FIX BUILT, which counts as
   open — `deriveStatus`).
3. **Counts line:** `… A299 A300 — D-P0` → `… A299 A300 A301 — D-P0` (A-P3 ID list).
4. **Last-updated cell:** prepended a `2026-09-21` A301 entry (newest-first).

Tree row untouched: desktop stays `v0.5.49` = `apps/desktop/package.json`, so the version check
stays green (no bump in this work — Rules 15, 22).

## Verification (Rule 7)

Bench, Linux/Node 22:
- **`check-register-consistency` → OK** — 250 entries, 250 distinct IDs, header agrees with body
  (was 249; A301 added with no duplicate and the P3 count re-derives to 16).
- **`check-doc-refs` → OK** — every cited document (incl. `-a`/`-b`/`-c`) is in the tree.
- **Full static gate set → 19/19 green.**

## Rollback (Rule 2)

```bash
git checkout 35c7229 -- docs/AUDIT-REGISTER.md
rm -f docs/MANIFEST-2026-09-21-c.md
```

## Commit (direct to dev, explicit paths — never `git add -A`)

```bash
git checkout dev
git pull                                  # confirm dev is at 35c7229; if not, re-apply the 4 edits
git add docs/AUDIT-REGISTER.md docs/MANIFEST-2026-09-21-c.md
git status --short                        # expect exactly these two
node scripts/check-register-consistency.mjs && node scripts/check-doc-refs.mjs   # both OK before commit
git commit -m "docs: register A301 (desktop branding write path) + fold in manifest -c"
git push
```

(Optional: also `git add docs/MANIFEST-2026-09-21-d.md` if you want this manifest in the tree.)
