# MANIFEST 2026-09-26-c — A273 follow-up: web ↔ desktop shifts (real till names; join an open drawer without a float)

**Base commit:** `4d0c09c` (origin/dev, delivery 2026-09-26-b; CI #406 green). **Not committed** — built overnight at the owner's
request ("do not commit, I will commit in the morning"); it sits uncommitted in the session workspace. **Deploys: cloud (Render) +
dashboard + a desktop release v0.6.8** (the till change). The version bump is done at commit time (WORKING-METHOD §7 — the Tree
row, `package.json` and the lockfile change together; `check-register-consistency` checks it).

Why (owner, 2026-09-26): "if i open a shift on desktop pos and i log into web pos it should prompt me to select a till based on the
till name not a made up name … if i am using the email used to open any of the till it should not ask me all this". Owner answers:
the setup name always wins · a different cashier on the desktop is offered to join · order: names, web, desktop.

## What changed
- **Real till names.** The till now sends `terminal_code` and `device_name` (the name typed at setup) with `enrol/redeem` and every
  `verify-pin` — before, it sent neither, so every till was "SwiftPOS till". The cloud writes the name on every sign-in (setup name
  wins; an older till that sends none never blanks it). NEW `apps/server/src/lib/terminalLabel.ts` (pure: `cleanLabel`, `labelFor`,
  the generic labels) used by `deviceRegistry.ts`. The web picker shows `tillName()`: "T1 — Front Counter", never the generic label.
  Settings → Devices: the rename button's tooltip says a desktop till's own name replaces a rename at its next sign-in.
- **Joining an open drawer never asks a float** (the 2026-09-15 target finding). NEW `GET /api/shifts/terminals/open` — the branch's
  open drawers, one per till (newest), who + when, no amounts (NEW pure `apps/server/src/lib/tillShifts.ts`). `/terminals` is
  byte-for-byte unchanged. The picker lists "T1 — Front Counter · open — Jane, since 09:02"; choosing an open till shows
  **Join this drawer** and hides the float.
- **The same cashier is not asked.** On sign-in with no current shift, the web joins the till whose drawer this cashier opened
  (exactly one; two → the picker; someone else's → the picker).
- **Not built — A334 (P1):** the desktop never learns of a drawer opened on the web (shifts are push-only on the till); joining it
  from the desktop needs two cash-custody decisions (see the register). Nothing on the till's shift logic changed.

## Files (14)
| File | Change |
|---|---|
| `apps/server/src/lib/terminalLabel.ts` | NEW — label rules (pure). |
| `apps/server/src/lib/tillShifts.ts` | NEW — open drawer per till (pure). |
| `apps/server/src/lib/deviceRegistry.ts` | Writes the reported name on every registration; `labelFor` moved out. |
| `apps/server/src/routes/auth.ts` | Both registration points pass `device_name` as the label. |
| `apps/server/src/routes/shifts.ts` | NEW route `GET /terminals/open` (before `/:id`). |
| `apps/desktop/src/main/ipcHandlers.ts` | `enrol/redeem` + `verify-pin` bodies carry `terminal_code` + `device_name`. |
| `apps/dashboard/src/lib/posTerminal.ts` | `tillName`, generic labels, `withOpenShifts`, `loadOpenDrawers`, `loadTills`, `ownOpenTill`, `openShiftLine`. |
| `apps/dashboard/src/pages/pos/ShiftModal.tsx` | Picker names + open state; Join path with no float. |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx` | Sign-in joins the cashier's own open till. |
| `apps/dashboard/src/pages/settings/DevicesTab.tsx` | Rename tooltip. |
| `tests/till-name.test.mjs` | NEW. |
| `tests/shift-join.test.mjs` | NEW. |
| `docs/AUDIT-REGISTER.md` | A273 follow-up note; NEW A334; Tree row **v0.6.8**; header, counts, changelog. |
| `docs/MANIFEST-2026-09-26-c.md` | This file (NEW). |

## Verification (bench: Linux, Node 22)
```
node tests/till-name.test.mjs     → 12 passed (runs the COMPILED registerDesktopTerminal; the database replaced by a recorder)
  mutations (dist rebuilt between cloud ones): stop writing the name · write it when none reported · show the generic label ·
  generic list changed on one side · verify-pin body without device_name → each reddens its named check
node tests/shift-join.test.mjs    → 12 passed
  mutations: join with two of mine · ignore who opened (a check strengthened after this reddened the wrong assertion, rule 24) ·
  float asked for an open till · mount stops joining · route loses its branch scope → each reddens its named check
A273's existing tests (shift-terminals-endpoint 4/4, web-terminal-identity 7/7, web-shift-gate 5/5) → unchanged, green
tests/*.test.mjs → 124 files, 0 failed · apps/desktop/test/*.test.mjs → 26, 0 failed (after tsc -b tsconfig.main.json)
typecheck-ratchet apps/server, dashboard, admin → 0 errors · dashboard build OK · desktop main build OK
every "node scripts/…" CI step → exit 0, except test-maintenance / test-tech-db-console ("Cannot find module 'better-sqlite3'" —
  the bench has no native build; identical on the untouched base; CI runs them)
```
Not verified here (rule 16): the live flow — a till on 0.6.8 signing in, then the web picker; desktop-opened drawer → web sign-in
as the same / another cashier.

## Noted, not changed
The generic labels (now in `terminalLabel.ts`, moved verbatim from `deviceRegistry.ts`) include "SwiftPOS till (branch server)" and
"SwiftPOS office server (view only)" — shown in the fleet view, so they break rule 21 ("node", never "server"). Pre-existing; renaming
them is a visible text change for the owner to approve (the web hides them either way — `tillName()` never shows a generic label).

## Owed on target
Deploy the cloud and the dashboard; install desktop 0.6.8 on the till and sign in once. Then: (1) the web picker shows the till's
real name; (2) open a shift on the desktop, sign in on the web as the SAME cashier → straight to selling (no picker, no float);
(3) as ANOTHER cashier → the picker shows the till "open — <name>, since HH:MM" and joining asks no float; (4) a closed till still
asks for the opening float. Answer A334's two questions for the desktop side.

## Rollback
```bash
git checkout 4d0c09c -- apps/server/src/lib/deviceRegistry.ts apps/server/src/routes/auth.ts apps/server/src/routes/shifts.ts apps/desktop/src/main/ipcHandlers.ts apps/dashboard/src/lib/posTerminal.ts apps/dashboard/src/pages/pos/ShiftModal.tsx apps/dashboard/src/pages/pos/CashierScreen.tsx apps/dashboard/src/pages/settings/DevicesTab.tsx docs/AUDIT-REGISTER.md && git rm -q --ignore-unmatch apps/server/src/lib/terminalLabel.ts apps/server/src/lib/tillShifts.ts tests/till-name.test.mjs tests/shift-join.test.mjs docs/MANIFEST-2026-09-26-c.md && rm -f apps/server/src/lib/terminalLabel.ts apps/server/src/lib/tillShifts.ts tests/till-name.test.mjs tests/shift-join.test.mjs docs/MANIFEST-2026-09-26-c.md
```
