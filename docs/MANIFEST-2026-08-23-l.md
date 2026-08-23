# MANIFEST — 2026-08-23-l

**Batch (group of 3):** A149 (build — wire admin into CI), A148 (verify + re-scope), A130 (re-confirm). Mixed: one code change + two verified re-scopes.
**Cumulative:** follows -a…-k. Apply after -k.

**Base commit:** `f80f0e9` (`dev` tip). Applies on top of -a…-k.

**Working rules:** `HANDOFF-2026-08-08-evening.md` §0, rules 1–23.

---

## Files changed

| File | Change | Why |
|---|---|---|
| `.github/workflows/ci.yml` | typecheck job: install `apps/admin` deps + run `typecheck-ratchet.mjs server dashboard admin`; build job: install + `npm run build` admin; both cache blocks gain `apps/admin/package-lock.json`. | **A149** — admin had no CI type-check or build; this closes the hole and ratchets its 68 errors downward. |
| `scripts/typecheck-baseline.json` | Added `"admin": 68`. | **A149** — seeds the one-way ratchet so new admin type errors fail CI. |
| `docs/AUDIT-REGISTER.md` | A149 `FIX SHIPPED` note (OPEN pending first CI run); A148 `VERIFIED` re-scope (per-endpoint status); A130 `RE-CONFIRMED` note. Counts unchanged. | Rule 14 / 7. |
| `docs/MANIFEST-2026-08-23-l.md` | New (this file). | Rule 2. |

## Per-item outcome (honest — this group is 1 build + 2 re-scopes)

- **A149 — BUILT.** Admin wired into CI (ratchet + build) with baseline 68. The 68-error burndown is a separate task (most are the one `S.input`/`CSSProperties` class).
- **A148 — VERIFIED, no clean build.** `POST /modifiers/options` is a minor asymmetry (add-option-to-existing-group; low value, needs a small UX call); `PUT /flags/:key` overlaps the admin feature-flag toggle with no owner home; `qr/settings` and `loyalty/settings` have no settings home (wiring = building a section). Parked at P3 unless you want a specific one.
- **A130 — RE-CONFIRMED dead report.** No writer of `order_type='aggregator'` anywhere. Standing binary decision (build a writer, or retire the report/tab) — yours.

## Verification (rule 7, 8, 9)

- `node scripts/typecheck-ratchet.mjs server dashboard admin` → **green** (server 0, dashboard 0, admin 68 held) — i.e. exactly what the edited CI step will run.
- `ci.yml` re-validated as YAML (`yaml.safe_load`).
- `apps/admin` `npm run build` (vite) → green (confirmed earlier this session).
- `node scripts/check-register-consistency.mjs` → green; `node scripts/check-doc-refs.mjs` → green.
- Environment: Linux bench, Node. **A149 closes on the first CI run** that exercises the new steps (the only bit not reproducible off-CI is GitHub Actions itself, rule 9/16).

## Rollback

```
git apply -R A149-A148-A130-group.patch
```
