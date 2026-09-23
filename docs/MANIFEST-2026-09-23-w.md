# MANIFEST 2026-09-23-w — Phase 2 theme proposal (docs) + A322 opened

**Base commit:** `648aaa5` (origin/dev, delivery -v; v0.6.3 tagged there; CI #385 and Release desktop #19 green).
**Docs only. Nothing built, no deploy.**

**What.** `docs/PROPOSAL-A295-phase2-themes.html` — the Phase 2 (curated themes) proposal for the owner's decision. Open it
in a browser: pick a theme and the till POS screen, the lock screen and the light dashboard recolour live. Written for any
business — it names no client (checked: zero matches).
- **A theme = one colour family with a fixed shade per job** (500 till buttons, 400 till links, 600 light-mode buttons, 700
  light-mode links, pressed one shade darker, 950 optional sidebar tint). Found by testing every family against the till's
  real surfaces: no single colour passes on both the dark till and the light dashboard, so the scope's three-colour model
  cannot work as written.
- **Every number is computed in the page** from the colours (WCAG contrast; CIEDE2000 colour difference): buttons 3:1 on their
  panel with a 4.5:1 label; text 4.5:1; sidebar text ≥ 7:1 on the tint; ≥ 20 from the paid/warning/void colours; ≥ 10
  between any two offered themes.
- **Result:** proposed Ocean, Violet, Lagoon, Orchid, Sky. Not proposed: Iris (too close to Violet), Teal (borderline next to
  paid green), Emerald (reads as paid), Rose (as void), Amber (as warning).
- **Seven decisions** for the owner, each with a recommendation: which themes; family-of-shades model; the unthemed default;
  status threshold; theme-to-theme threshold; the Phase 1 palette; receipt-line order; premium gating.

**A322 (NEW, P2, OPEN).** Checking the proposal for client names found them in SHIPPED product: the technician test print's
business name (`sampleTicket.ts`), the till's receipt-text placeholder and a menu-import sample row (`ManageTabs.tsx`). Every
client sees these. Recorded with the full list (33 files; history stays as written); fix planned as its own delivery.

## Files (3)
| File | Change |
|---|---|
| `docs/PROPOSAL-A295-phase2-themes.html` | NEW. The interactive proposal. |
| `docs/AUDIT-REGISTER.md` | A295 note (proposal); NEW A322; Counts; Open A 19/19/20 → **19 P1 · 20 P2 · 20 P3**; header; changelog. |
| `docs/MANIFEST-2026-09-23-w.md` | This file. |

## Verification
```
Headless Chromium, file:// : no page errors · picker computes 5 proposed / 5 not · table 10 rows, all values computed
  Ocean 4.82 / 5.71 / 5.77 / 4.95 / 5.17 / 6.41 / 5.17·6.70 / 9.97 / void 42.7 → Ship … Amber warning 0.0 → Reject
  pairs: "Iris is close to Violet (difference 7.2, below 10)"
  till mock not clipped at 1320 px; 390 px wide: no horizontal overflow; screenshots checked (Ocean, Orchid)
grep -i "taste|kudo" in the proposal → 0 · "server" → 0 (rule 21)
check-register-consistency (19/20/20) / check-doc-refs / check-root-clean → exit 0
```

## Rollback
```bash
git checkout 648aaa5 -- docs/AUDIT-REGISTER.md && git rm -q --ignore-unmatch docs/PROPOSAL-A295-phase2-themes.html docs/MANIFEST-2026-09-23-w.md && rm -f docs/PROPOSAL-A295-phase2-themes.html docs/MANIFEST-2026-09-23-w.md
```
