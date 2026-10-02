# MANIFEST 2026-09-24-c — docs only: Phase 2 proposal revised (two layers) + Render clarified

**Base commit:** `d69244a` (origin/dev, delivery 2026-09-24-b; 3/3 checksums on the tip, gates exit 0, CI #390 green).
**No code, no deploy.**

**Why.** The owner asked whether the rejected colours could be added, and "what of the clients who have yellow?"
Computed with the proposal's own maths: as a BUTTON, yellow is ΔE 1.8 from the till's warning colour; Amber and Red are 0.0
(they are the status colours); Rose 5.8 from void; Emerald 7.3 from paid — no threshold makes them safe for buttons. As brand
TRIM on the dark till, yellow is 9.9–11.3:1.

**What changed in `docs/PROPOSAL-A295-phase2-themes.html`:**
- **Two layers.** Brand colour (the business's own — lock screen, logo ring, sidebar tint, brand strip; rule: 3:1 visible on the
  dark till; no status rule; no new data: it is the Phase 1 lock-screen colour) + action colour (curated; buttons/selections/links;
  every check). A brand picker (presets Yellow, Red, Green, Amber, Orange, Navy, None; or any hex) drives the live preview; a
  colour too dark to see falls back to the action theme, and says so.
- **Seven action themes:** Ocean, Violet, Lagoon, Orchid, Sky + Teal and Blossom (Pink family) at status ΔE 15–20, shipped
  only after a real-till check. Iris stays out (7.2 from Violet).
- **Suggested pairing** = the complementary hue in CIE LCh: yellow → Sky, red → Lagoon, green → Orchid, amber → Sky, orange →
  Lagoon. (A first rule — "most different colour" — suggested magenta for yellow; replaced.)
- **New table** "Brand colours": visibility on the till, lock-screen Enter text, allowed as brand, and why not as a button.
- **Decisions updated:** new "two layers" decision; threshold 15 (+ till check for 15–20); the Phase 1 colour simply becomes
  the brand colour (no migration); default action colour Ocean.

**Render (owner, 2026-09-24):** two services. `swiftpos-20c2.onrender.com` — whose `/health` reports `"env":"development"` — is
the DEVELOPMENT service, so that is correct. Production is separate. Merging `dev` → `main` is planned after Phase 2 and needs its
own checklist (prod DB and migrations, environment variables, which cloud URL the tills use). Recorded in the register changelog.

## Files (3)
| File | Change |
|---|---|
| `docs/PROPOSAL-A295-phase2-themes.html` | Revised as above. |
| `docs/AUDIT-REGISTER.md` | A295 note; header; changelog (incl. Render). Counts unchanged. |
| `docs/MANIFEST-2026-09-24-c.md` | This file. |

## Verification (headless Chromium, file://)
```
no page errors · 390 px: no horizontal overflow · no reference-business names · no "server"
themes: Ocean, Violet, Lagoon, Orchid, Sky Passes · Teal, Blossom "Check on till" · Iris too close · Emerald/Rose/Amber rejected
Yellow #F5B800 → strip/lock/ring #F5B800, sidebar tint #47390d (sidebar text ≥ 7:1), Enter text black, suggested Sky
Navy #1E3A8A → "too dark to be seen (1.71:1)" → falls back to the action theme
brand table: Yellow 9.92 / warning 1.8 · Red 3.67 / void 7.6 · Green 5.38 / paid 9.6 · Amber 8.26 / warning 0.0 · Orange 4.98 · Navy 1.71
check-register-consistency / check-doc-refs / check-root-clean → exit 0
```

## Rollback
```bash
git checkout d69244a -- docs/PROPOSAL-A295-phase2-themes.html docs/AUDIT-REGISTER.md && git rm -q --ignore-unmatch docs/MANIFEST-2026-09-24-c.md && rm -f docs/MANIFEST-2026-09-24-c.md
```
