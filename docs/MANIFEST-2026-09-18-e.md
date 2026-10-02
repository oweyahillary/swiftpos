# Delivery manifest — 2026-09-18 (-e) · register/reality sweep (docs + one gate)

**Base commit:** `f89b8ff` (branch `dev`, after v0.5.46 / A298).
**Scope:** make the register match what actually ships, and add a gate so the Tree line can't
drift silently again. **No desktop code, no version bump, no release** — a normal `dev` commit.

## Changes

| File | Change |
|---|---|
| `docs/AUDIT-REGISTER.md` | **A297 → CLOSED 09-18** (Overview fix confirmed on the till). **D13 → CLOSED 08-15** (A88 built the grace window; heading had lagged). **D10** line count 1,639 → 2,214. **Tree line**: desktop v0.5.38 → v0.5.46, migrations →94 → →102, last-pushed → `f89b8ff`. Header open P1 19 → 18 (A297 removed from A-P1). Changelog row added. |
| `scripts/check-register-consistency.mjs` | New check: the \| Tree \| row's `desktop **vX.Y.Z**` must equal `apps/desktop/package.json` version. Mutation-checked (a stale Tree version now fails the build, naming both numbers). Doc updated. |
| `docs/MANIFEST-2026-09-18-e.md` | This file. |

## NOT done (deliberately)
- **D3 / D4 / D18 left OPEN.** The 2026-09-17 handoff records them confirmed on a real till, but that's
  a prior-session claim — on-till status is the owner's call. Confirm they still hold and I'll close them.

## Rollback
```
git checkout f89b8ff -- docs/AUDIT-REGISTER.md scripts/check-register-consistency.mjs
git rm docs/MANIFEST-2026-09-18-e.md
```

## Apply + push (no release)
```
git apply --check "../patch files/swiftpos-register-sweep-2026-09-18.patch"
git apply "../patch files/swiftpos-register-sweep-2026-09-18.patch"
git add -A
git commit -m "register/reality sweep: close A297+D13, fix D10/Tree line, add Tree-line gate"
git push origin dev
```

## Verified on the bench (Linux, Node 22 — rule 9)
`check-register-consistency` green (18 P1; Tree v0.5.46 == package.json). Mutation-checked: setting the
Tree line to v0.5.38 fails with "TREE LINE STALE: header says desktop v0.5.38 … is 0.5.46"; reverting
goes green. `check-doc-refs`, `check-root-clean` green.
