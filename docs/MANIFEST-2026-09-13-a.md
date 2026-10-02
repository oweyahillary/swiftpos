# MANIFEST 2026-09-13-a — A274 web shift hard-gate (+ A273/A275 opened)

**Base:** `4fcddc8` (`dev`). **No `version` field touched** (rule 22); web-only, no
desktop change, so no bump/tag due (rule 15). Additive (rule 13/20).

## What this delivers
- **A274 → FIX BUILT** (P1): the web POS can no longer create a `shift_id:null` sale.
  The mount `/api/shifts/current` check no longer swallows failures, and Charge,
  Send-to-Kitchen and Room-charge are disabled + guarded on an open shift. Parity
  with the desktop till's hard gate.
- **A273 / A275 → OPENED** (P1, design only): register identity (Option B) and remote
  day close (Option i). Not built this delivery. See the design brief.

## Files
| File | Change | Why |
|---|---|---|
| `apps/dashboard/src/pages/pos/CashierScreen.tsx` | (1) mount `/current` `.catch(() => {})` → `.catch(() => setShiftModal('open'))`; (2) `sendToKitchen()` early-returns + prompts open when `!currentShift`; (3) Send-to-Kitchen button `disabled`/opacity add `!currentShift`; (4) Charge button `disabled={!currentShift}` + opacity + onClick prompts open, with a "Open a shift to start selling." note; (5) Room-charge button `disabled` + handler guard add `!currentShift` | Close every selling boundary so no order can carry `shift_id:null`; stop treating an unknown shift state as "sellable" |
| `tests/web-shift-gate.test.mjs` | NEW — 5 source-assertion guards (mutation-checked) | Pin each gate so a later edit that drops one goes red naming it |
| `docs/SHIFT-DAY-WEB-PARITY-DESIGN.md` | NEW — decision brief | Standing design: Option B + Option i, invariants, phased plan |
| `docs/AUDIT-REGISTER.md` | A273/A274/A275 entries + Open A-P1 18→21 + Counts + changelog | Rule 14 — findings + the built fix recorded in the same change as the code |
| `docs/MANIFEST-2026-09-13-a.md` | NEW — this file | Rule 2 |

## Verification (rule 7)
- `node tests/web-shift-gate.test.mjs` → **5 passed, 0 failed**.
- Mutation check (rule 10/23): removed the Charge `disabled={!currentShift}` guard →
  the Charge assertion went **red naming it**; restored → 5/5.
- `node scripts/check-register-consistency.mjs` → **OK** (238 entries, header agrees
  with body).
- `node scripts/check-doc-refs.mjs` → green after this manifest lands.

## NOT verified here — target-only (rule 16)
- On-screen: with no open shift, Charge is disabled and the note shows; opening a
  shift enables Charge; a completed sale carries the shift id (not null).
- `dashboard tsc` — the dashboard build is esbuild-only (no type-check), the A265
  class; run the ratchet on push.

## Rollback
```
git checkout 4fcddc8 -- apps/dashboard/src/pages/pos/CashierScreen.tsx
git rm tests/web-shift-gate.test.mjs docs/SHIFT-DAY-WEB-PARITY-DESIGN.md docs/MANIFEST-2026-09-13-a.md
git checkout 4fcddc8 -- docs/AUDIT-REGISTER.md
```
