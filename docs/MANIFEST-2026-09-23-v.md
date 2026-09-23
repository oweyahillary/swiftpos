# MANIFEST 2026-09-23-v — desktop v0.6.3: register Tree row (paired with the owner's version bump)

**Base commit:** `ae617e0` (origin/dev, delivery -u; 9/9 checksums on the tip, gates exit 0, CI #384 green with the new
"Desktop catalogue refresh signal" step).
**Docs only in the zip.** The version field itself is NOT here (rule 22): the owner runs `npm version 0.6.3
--no-git-tag-version` in `apps/desktop`, which changes exactly `package.json` + `package-lock.json` (as the v0.6.2 bump
`ea8416a` did).
**Must be ONE commit.** `check-register-consistency` requires the Tree row's `desktop **vX.Y.Z**` to equal
`apps/desktop/package.json`. The v0.6.2 bump committed the version without the row and CI went red (fixed by -j).
Proven on the bench: register edit alone → `TREE LINE STALE: … v0.6.3, package.json is 0.6.2`; bump alone → `… v0.6.2,
package.json is 0.6.3`; both → OK.
**Tag after CI is green** on that commit: `v0.6.3` → `release.yml` (`on: push: tags: v*`, windows-latest) builds and
publishes the installer. The workflow does not compare tag and package.json; the installer's version comes from
package.json, so the tag must be `v0.6.3` on the bump commit.
**What 0.6.3 ships** (desktop code since v0.6.2 `ea8416a`): A321 (open screens refresh on every landed pull; lock screen
listens; 20-s check refreshes on 401 and reports failures) · A315 till half (`render.ts`: no duplicate thank-you) · A316
codec in `raster.ts` (till output byte-identical) · `contrast.ts` header comment (A319). `LOCAL_SCHEMA_VERSION` stays **53**
(`localDb.ts` unchanged since v0.6.2). No migration.

## Files (2)
| File | Change |
|---|---|
| `docs/AUDIT-REGISTER.md` | Tree row → desktop **v0.6.3**; Last-updated; changelog row. |
| `docs/MANIFEST-2026-09-23-v.md` | This file. |

Owner-made in the same commit (not in the zip): `apps/desktop/package.json`, `apps/desktop/package-lock.json` (0.6.2 → 0.6.3).

## Verification
```
bench copy, register edit only        → TREE LINE STALE (v0.6.3 vs 0.6.2)
+ npm version 0.6.3 --no-git-tag-version → M package.json, M package-lock.json (3 version lines) → check-register-consistency OK
bump only (register at tip)           → TREE LINE STALE (v0.6.2 vs 0.6.3)
check-doc-refs / check-root-clean     → exit 0
```

## Owner, after the Release run
Install 0.6.3 on mamangina; VERIFY A2, B1, A5 and the A315 till receipt + test print. Tell me the Release run's result
so the Tree row's "to be confirmed" can be replaced with the fact.

## Rollback (before tagging)
```bash
git checkout ae617e0 -- docs/AUDIT-REGISTER.md apps/desktop/package.json apps/desktop/package-lock.json && git rm -q --ignore-unmatch docs/MANIFEST-2026-09-23-v.md && rm -f docs/MANIFEST-2026-09-23-v.md
```
After a tag is pushed, do not move or delete it — cut v0.6.4 instead.
