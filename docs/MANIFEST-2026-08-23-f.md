# MANIFEST — 2026-08-23-f

**Batch:** A149 opened — `apps/admin` has no CI type-check or build. **Docs-only — no zip** (rule 18).
**Cumulative:** follows -a…-e in the same session. Apply after -e.

**Base commit:** `f80f0e9` (`dev` tip). Applies on top of -a…-e.

**Working rules:** `HANDOFF-2026-08-08-evening.md` §0, rules 1–23.

---

## Files changed

| File | Change | Why |
|---|---|---|
| `docs/AUDIT-REGISTER.md` | Added `### A149 · P3 · OPEN`; bumped `\| Open \|` A-P3 5→6; appended A149 to the `\| Counts \|` row; recorded A149 in the changelog and moved "Next free ID" to A150. | Rule 14 — the finding surfaced during A147 gets an ID and an entry. |
| `docs/MANIFEST-2026-08-23-f.md` | New (this file). | Rule 2. |

## The finding

`apps/admin` is not covered by any CI gate:
- `ci.yml` typecheck job runs `node scripts/typecheck-ratchet.mjs server dashboard` — **admin omitted**.
- `ci.yml` build job builds only server + dashboard.
- `vite build` strips types without checking, so `tsc` never runs on admin.

The ratchet was designed to cover admin (its header says so; `WORKSPACES` includes `admin: 'apps/admin'`) but `scripts/typecheck-baseline.json` is `{ server: 0, dashboard: 0 }` (no admin key) and the CI invocation drops the arg. Result: `tsc --noEmit` on admin sits at **68 errors** (61× TS2322, the inline-style/`CSSProperties` class; the rest TS2345/2339/2362/2363/2349), accrued unseen. No runtime impact — which is why it went unnoticed, and why a real regression in admin would also pass CI today.

## Proposed fix (recorded, not done here)

1. `typecheck-ratchet.mjs server dashboard admin` in `ci.yml`; seed `"admin": 68` in `scripts/typecheck-baseline.json` → gates against NEW errors now, ratchets down.
2. Burn down the 68 — most are one class, cleared by typing the `S`/`C` style-token objects (`satisfies Record<string, CSSProperties>` or casts).
3. Add admin to the CI build job so a build break is caught.

## Evidence / verification (rule 7)

- `apps/admin` `tsc --noEmit` error count established at **68** by running it directly (and cross-checked against the A147 pre/post comparison).
- `ci.yml` invocation and `scripts/typecheck-baseline.json` read directly.
- `node scripts/check-register-consistency.mjs` → green (A149 OPEN P3; header agrees with body).
- `node scripts/check-doc-refs.mjs` → green (this manifest resolves the citation).

## Priority note

Filed P3: no runtime impact, but it is a real gap in the repo's gate discipline. Bump to P2 if you consider an ungated operator-facing app higher-risk.

## Rollback

```
git apply -R A149-admin-no-ci-coverage.patch
```
