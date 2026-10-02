# MANIFEST 2026-09-27-a — A334: the till joins a drawer the web POS opened, and its close includes the web's cash

**Base commit:** `7e00375` (origin/dev = delivery 2026-09-26-c + desktop v0.6.8, tagged; CI #407 green). **One commit on
`claude/modest-cray-f21ll5`**; the owner fast-forwards `dev` and bumps the desktop to **v0.6.9** in the same block (the Tree row
already says v0.6.9 — `check-register-consistency` passes only after `npm version 0.6.9`). **Deploys: cloud (Render) + desktop
v0.6.9.** The dashboard is unchanged.

Why (owner, 2026-09-26): "if i open on web pos and i log into desktop pos it should give me either the pos name or the cashiers
name". Answers: a different cashier is offered to **join**; the desktop close **includes** the web's sales; offline is
discouraged (and a till with no internet has no web session either — it opens as today).

## What changed
- **Join at sign-in (desktop).** After an ONLINE PIN sign-in the till asks the cloud for its drawer (`GET /api/shifts/current`,
  its own device id, capped at 4 s — never blocks). A drawer the web opened AS THIS TILL is taken into the local database under the
  **same id** (no second drawer — the cloud refused those as `duplicate_open_shift`), attached to this till's trading day, left
  `pending` so the next push writes that day onto the cloud row. Refused when it is another terminal's, not open, the till already
  has an open drawer, it cannot sell, or its previous day is unclosed. The opener just resumes; another cashier sees
  "**T1 — Front Counter is already open** — opened by Jane at 09:02 on the web POS … **Continue**".
- **The close includes the web's cash (cloud + desktop).** NEW `POST /api/shifts/:id/foreign-cash`: the till sends the order,
  float and expense ids it holds; the cloud sums the rest on that drawer with its own close arithmetic (NEW pure
  `apps/server/src/lib/foreignCash.ts`), authorised exactly like `/:id/close`, read-only. The till adds it in `computeZReport` /
  `closeShift` / `currentShiftReport` (`totals.foreign`; `null` = could not check). Used by the close, the Z-report, the shift panel
  ("Includes the web POS on this drawer: 2 sales, KES 700 cash" — or, offline, that it could not check) and the manager report —
  **never by the POS sell gate**. Also fixes the web-joins-a-desktop-drawer direction (26-c): its web sales were missing from the
  till's close. The day close sums shift expected cash, so it follows.

## Files (14)
| File | Change |
|---|---|
| `apps/server/src/lib/foreignCash.ts` | NEW — the web's part of a shared drawer (pure). |
| `apps/server/src/routes/shifts.ts` | NEW `POST /:id/foreign-cash` (before `/:id/close`). |
| `apps/desktop/src/main/shiftService.ts` | `adoptCloudShift`, `localShiftIds`, `ForeignCash`; Z-report / close / current take the web's part. |
| `apps/desktop/src/main/ipcHandlers.ts` | Sign-in joins the drawer; close / Z-report / `shift:current({includeForeign})` fetch the web's part; identity carries the till name. |
| `apps/desktop/src/main/preload.ts` | `shift.current(opts)`. |
| `apps/desktop/src/renderer/lib/posApi.ts` | Types: `joinedDrawer`, `totals.foreign`, `identity().deviceName`, `current(opts)`. |
| `apps/desktop/src/renderer/pages/PinPage.tsx` | The "already open — Continue" notice for another cashier. |
| `apps/desktop/src/renderer/pages/ShiftPanel.tsx` | Asks for the web's part; shows what it includes (or that it could not check). |
| `apps/desktop/src/renderer/pages/ManagerPage.tsx` | The manager's shift report includes the web's part. |
| `apps/desktop/test/shared-drawer.test.mjs` | NEW. |
| `tests/foreign-cash.test.mjs` | NEW. |
| `.github/workflows/ci.yml` | Step "Desktop shared drawer with the web POS". |
| `docs/AUDIT-REGISTER.md` | A334 FIX BUILT; Tree row **v0.6.9**; header; changelog. |
| `docs/MANIFEST-2026-09-27-a.md` | This file (NEW). |

## Verification (bench: Linux, Node 22)
```
cd apps/desktop && npx tsc -b tsconfig.main.json && node test/shared-drawer.test.mjs   → 16 passed
  (the REAL compiled shiftService on SQLite: same id, day attached, pending; another terminal / closed / already-open refused;
   expected 1000 + 400 till + 700 − 50 web = 2050; counting 2050 balances WITH the web's part, a false 650 over WITHOUT it)
  mutations (rebuilt each): no device check · no already-open check · Z-report ignores the web · close ignores the web → each
  reddens its named check (the last two first CRASHED the test on the note error instead — wrapped, rule 23)
node tests/foreign-cash.test.mjs → 14 passed; mutations: count known orders · drop refunds · route loses its auth · sell gate asks
  the cloud → each reddens its named check
tests/*.test.mjs → 125, 0 failed · apps/desktop/test/*.test.mjs → 27, 0 failed · desktop main + renderer tsc 0
typecheck-ratchet apps/server, dashboard, admin → 0 · dashboard build OK · check-test-registration OK (desktop test wired in CI)
every "node scripts/…" CI step → 0, except test-maintenance / test-tech-db-console (no better-sqlite3 native build on this bench;
  identical on the base; CI runs them — they passed in CI #406/#407)
```
Not verified here (rule 16): the live two-surface run on a till + the web.

## Owed on target
Deploy the cloud; install **0.6.9** on the till. Then, with the web POS: (1) open a shift on the WEB covering T1, sign in on T1 as the
SAME cashier → straight in, no second drawer; (2) as ANOTHER cashier → "T1 — … is already open — opened by <name> at HH:MM",
Continue; (3) ring a cash sale on each; open the till's shift panel → "Includes the web POS on this drawer: 1 sale, …"; (4) close on
the till counting the whole drawer → balances; (5) the cloud's reconciled close (Open shifts / reports) shows the same expected cash.

## Rollback
```bash
git checkout 7e00375 -- apps/server/src/routes/shifts.ts apps/desktop/src/main/shiftService.ts apps/desktop/src/main/ipcHandlers.ts apps/desktop/src/main/preload.ts apps/desktop/src/renderer/lib/posApi.ts apps/desktop/src/renderer/pages/PinPage.tsx apps/desktop/src/renderer/pages/ShiftPanel.tsx apps/desktop/src/renderer/pages/ManagerPage.tsx .github/workflows/ci.yml docs/AUDIT-REGISTER.md && git rm -q --ignore-unmatch apps/server/src/lib/foreignCash.ts apps/desktop/test/shared-drawer.test.mjs tests/foreign-cash.test.mjs docs/MANIFEST-2026-09-27-a.md && rm -f apps/server/src/lib/foreignCash.ts apps/desktop/test/shared-drawer.test.mjs tests/foreign-cash.test.mjs docs/MANIFEST-2026-09-27-a.md
```
