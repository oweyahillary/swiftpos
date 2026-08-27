# MANIFEST 2026-08-27-g — A174: check-root-clean respects .gitignore

**Base:** applies on `5eedae4` (dev tip after the A169/A170-173 commit).
**Artifact:** `swiftpos-2026-08-27-g.patch`. One file + register/manifest.

## What this fixes

A172's `check-root-clean.mjs` read the raw filesystem, so on a real dev machine
it flagged `swiftpos-2026-08-25.patch` — a **gitignored** leftover (`.gitignore`
ignores `*.patch`/`*.zip`) that never reaches the repo. That's a false positive,
and a crying-wolf gate is the rule-23 failure mode. Rule 19 is about what's
COMMITTED to the root, so the gate now filters candidates through
`git check-ignore` and judges only files git would track.

CI was never affected: a clean checkout (what CI sees) has no ignored files, so
the gate was already green there — this only removes the local noise.

## Files

| File | Change |
|------|--------|
| `scripts/check-root-clean.mjs` | Filter root candidates through `git check-ignore`; only flag non-ignored files. Message/OK line reworded ("tracked docs/archives"). `isStrayRootDoc` and the self-test are unchanged. |
| `docs/AUDIT-REGISTER.md` | A174 entry (CLOSED) + changelog; next free ID → A175. Open counts unchanged. |
| `docs/MANIFEST-2026-08-27-g.md` | This file. |

## Verification (rule 7)

- Reproduced your case: a gitignored `swiftpos-2026-08-25.patch` in root → gate **OK** (skipped).
- A genuine non-ignored stray `.md` in root → gate **red**, names the file (still does its job).
- `--self-test` → 9/9.
- All gates green.

## Rollback

```
git apply -R swiftpos-2026-08-27-g.patch
```

No app code changed — no version bump (rule 15).
