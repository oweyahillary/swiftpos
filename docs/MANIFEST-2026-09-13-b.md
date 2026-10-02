# MANIFEST 2026-09-13-b — A273 web per-till identity (Option B)

**Base:** `4fcddc8` (`dev`), on top of delivery -a. **No `version` field touched**
(rule 22). **No migration** — `user_devices` already has device_id/terminal_code/
device_label and the cloud keys drawers on the x-device-id header (migration 63), so
this is additive. Cash custody, cross-stack → not a deploy-window change (rule 13).

## What this delivers
- **A273 → FIX BUILT** (P1): a web POS now **covers a chosen till** — it adopts that
  till's `device_id` and sends it as `x-device-id` on every request, so its shift and
  sales fold into that till's drawer/day instead of the shared `web:<branch>` session.
  On a one-open-per-terminal 409 it folds into the till's existing drawer.

## Files
| File | Change | Why |
|---|---|---|
| `apps/server/src/routes/shifts.ts` | NEW route `GET /api/shifts/terminals?branch_id=` — lists the branch's enrolled tills (business_id + branch_id scoped, approved + not-retired, minimal shape) | The web picker needs the branch's tills, and a cashier has no `devices.approve`/`settings.manage` for `GET /fleet` |
| `apps/dashboard/src/lib/posTerminal.ts` | NEW — `get/setCoveredTerminal` (per-tab sessionStorage) | Holds the till this web POS is covering; read on every request |
| `apps/dashboard/src/context/POSAuthContext.tsx` | Inject `x-device-id` from the covered till on the main request **and** the 401-retry | The cloud keys the drawer on this header; the retry must not drop it |
| `apps/dashboard/src/pages/pos/ShiftModal.tsx` | Open mode: fetch tills, till picker, adopt identity **before** `/open`, 409→adopt existing drawer via `/current`; clear identity on close | The chosen till must be in effect before the drawer is opened; an already-open till is folded into, not errored |
| `tests/shift-terminals-endpoint.test.mjs` | NEW — 4 guards (mutation-checked) | Pin the endpoint's scoping + minimal shape |
| `tests/web-terminal-identity.test.mjs` | NEW — 7 guards (mutation-checked) | Pin header injection (both paths), picker, adopt-before-open, 409-adopt, clear-on-close |
| `docs/SHIFT-DAY-WEB-PARITY-DESIGN.md` | Phase 2 marked BUILT | Living design |
| `docs/AUDIT-REGISTER.md` | A273 → FIX BUILT + changelog | Rule 14 |
| `docs/MANIFEST-2026-09-13-b.md` | NEW — this file | Rule 2 |

## Behaviour change to confirm (owner)
A web shift now **requires** covering an enrolled till. A branch with **no** enrolled
till can no longer open a web shift (previously it opened a shared `web:<branch>`
drawer). This is the agreed Option-B model — flag if a generic "web register with no
specific till" fallback is still wanted.

## Verification (rule 7)
- `node tests/shift-terminals-endpoint.test.mjs` → **4 passed**.
- `node tests/web-terminal-identity.test.mjs` → **7 passed**.
- Mutation checks (rule 10/23): dropped `business_id` scoping on the endpoint → its
  scoping assertion went **red**; moved `setCoveredTerminal(till)` to after `/open` →
  the adopt-before-open assertion went **red**; both restored → green.
- `node scripts/check-register-consistency.mjs` → **OK**.

## NOT verified here — target-only (rule 16)
- Live two-surface: a till and a web-POS-covering-that-till share one drawer; a web
  sale records the till's `device_id`; the offline-till → web-carries → till-returns
  re-sync path (this is where drawer merge conflicts would show, if any).
- **server tsc** and **dashboard tsc** — no `node_modules` on the bench; run the
  typecheck ratchet on push (dashboard build is esbuild-only, the A265 class).

## Rollback
```
git checkout 4fcddc8 -- apps/server/src/routes/shifts.ts apps/dashboard/src/context/POSAuthContext.tsx apps/dashboard/src/pages/pos/ShiftModal.tsx
git rm apps/dashboard/src/lib/posTerminal.ts tests/shift-terminals-endpoint.test.mjs tests/web-terminal-identity.test.mjs docs/MANIFEST-2026-09-13-b.md
git checkout 4fcddc8 -- docs/AUDIT-REGISTER.md docs/SHIFT-DAY-WEB-PARITY-DESIGN.md
```
(Restores the -a state; -a delivery is unaffected.)
