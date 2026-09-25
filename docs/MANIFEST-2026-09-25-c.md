# MANIFEST 2026-09-25-c — docs only: A328 closed · 4b-2 decided · A329 (SwiftPOS → teal) · A330 · slice 5 checklist

**Base commit:** `9d07e57` (origin/dev, delivery 2026-09-25-b; CI #400 green; dashboard deployed). **No code, no deploy.**

- **A328 CLOSED** on the owner's screenshots: Blossom, Ocean after Reset, and themes OFF — each exact on the web POS.
- **A323 decision (lead dev, delegated):** 4b-2 back office stays SwiftPOS-branded; its greens convert to teal under A329.
- **A329 OPEN (P2):** SwiftPOS's own colour green → teal (owner "yes proceed"). Teal family, shade per job, numbers from the
  registry: dark-label fills 8.09 · white-label fills (700) 5.47 · links 9.53 dark / 5.47 light · the logo `#0d9488` for accents only
  (white on it 3.74). M-Pesa distance 9.6 → 19.2. Caveat: 16.8 from "paid" — the slice 5 lighting check decides the shade.
  Plan: slice 5 → tills + web POS default → back office → wordmark → client heads-up.
- **A330 OPEN (P3):** the "Add tip" panel is flat grey in POS light mode (pre-existing since the initial commit).
- **`docs/VERIFY-BRANDING-PHASE2.md`** (NEW): the slice 5 on-till walk — all seven themes, the Teal/Blossom lighting check (also
  A329's go/no-go), a brand colour, and off again; results template.

## Files (4)
| File | Change |
|---|---|
| `docs/AUDIT-REGISTER.md` | A328 CLOSED; A329, A330 NEW; A323 decision; tracker; Counts; Open A → 18 P1 · 18 P2 · 19 P3; header; changelog. |
| `docs/VERIFY-LOG-2026-09-25.md` | §A328. |
| `docs/VERIFY-BRANDING-PHASE2.md` | NEW — slice 5 checklist. |
| `docs/MANIFEST-2026-09-25-c.md` | This file. |

## Verification
```
check-register-consistency / check-doc-refs / check-root-clean / check-reference-names → OK
teal numbers computed from shared/themes.ts (Node, strip-types) — not typed by hand
```

## Rollback
```bash
git checkout 9d07e57 -- docs/AUDIT-REGISTER.md docs/VERIFY-LOG-2026-09-25.md && git rm -q --ignore-unmatch docs/VERIFY-BRANDING-PHASE2.md docs/MANIFEST-2026-09-25-c.md && rm -f docs/VERIFY-BRANDING-PHASE2.md docs/MANIFEST-2026-09-25-c.md
```
