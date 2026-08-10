# MANIFEST — 2026-08-10-e

**Supersedes `-b`, `-c`, `-d`. Cumulative — apply this one only** (rule 3).
**Base commit:** `84400d6` (`dev`)
**No `version` field is touched anywhere** (rule 22). Desktop stays 0.5.27 in the
tree; your built 0.5.28 is unaffected by anything here.

Five items done while you were out, none needing a decision.

| # | Item | State |
|---|---|---|
| 1 | **A52** — idle lock | Built, 27 tests, 3 mutation checks |
| 2 | **A51** — device-token sawtooth | Built, 21 tests, 4 mutation checks |
| 3 | **A6** — lost 3-Aug handoff | Recovered from git, 383 lines |
| 4 | **A53** — 20 audit IDs cited with nowhere to look | Indexed |
| 5 | **A11** | **NOT done — see §5. I could not verify the claim.** |

---

## 1. A52 — the idle lock

Your clarification chose the design: *"it should work like screen lock — only
activated on idle time, not when someone is using a pc or phone."*

That is **OS idle**, and it dissolves the objection I raised earlier.
`powerMonitor.getSystemIdleTime()` reports seconds since the last input anywhere
on the machine. A cashier mid-sale is touching it, so idle is 0 and the timer
**cannot** fire. "Never lock mid-transaction" is true by construction, not by a
special case somebody has to keep working.

Renderer activity tracking would have been the obvious build and the wrong one —
it misses a cashier reading a long receipt or counting cash into the drawer, so
it locks a till someone is standing at, and staff answer lock fatigue with shared
PINs.

**Thresholds — manager 5 min, POS 10 min.** The split is exposure, not friction:
the manager screens hold Close Day, Close Branch, Staff and Receipt, and
`settings.manage` also gates till revocation and eTIMS registration (A46). Both
are named constants in `idleMonitor.ts` — change them without me.

**It is a curtain, not a reset.** `LockCurtain` renders *over* whatever is
mounted. `POSPage`/`ManagerPage` stay mounted; nothing clears the cart, the staff
session, or SQLite. PIN back in and you are exactly where you were. **Losing a
sale to the lock is unreachable, not merely unlikely** — there is no path that
discards anything.

**Unlock is the PIN pad, never the owner login** (A17). It calls the same
`auth.verifyPin` `PinPage` uses, so the offline cache (14 days) and revocation
handling come for free rather than being a second implementation that must agree
with the first. **Only the locked staff member can dismiss it** — another
cashier's valid PIN would otherwise continue the first cashier's shift under
their identity, with every order still attributed to whoever walked away.

**Suppression** holds the lock off while work is in flight and nobody is at the
screen — an STK push awaiting its callback, a print job spooling. A counter, not
a boolean, because those overlap. Tokens live in MAIN: handing the release
closure to the renderer would let a reload mid-print strand a suppression and the
till would never lock again.

Mutation checks, each caught by the assertion that owns it:

| Mutation | Caught by |
|---|---|
| Curtain clears the staff session | *"the curtain does not clear the staff session"* |
| Any valid PIN unlocks | *"only the LOCKED staff member can dismiss it"* |
| Curtain replaces the screen instead of overlaying | *"App renders it ALONGSIDE the screen"* |

---

## 2. A51 — the sawtooth

`syncAll()` every 10 minutes against a 15-minute token, refresh purely reactive,
so **every second catalogue pull 401'd by construction**. That is the whole of
Beryl's 90-line log.

Fixed by refreshing when the token is inside 2 minutes of expiry. The reactive
401 path stays as the backstop for clock skew or an unreadable `exp`.

**Scoped to the DEVICE token, and that is the point.** The catalogue pull uses
`authHeaders()` → `_accessToken`; pushes prefer `_staffToken`. A *generic*
proactive refresh would have refreshed the staff token too — masking your A47
idle test exactly as a short auto-lock would. **There is an assertion that fails
if anyone later widens it**, and the mutation check proves it fires.

Section 1 of the test simulates the timeline and asserts the old cadence failed
every 20 minutes and the new one produces none — the finding itself, executable.

Four mutation checks: remove the call, widen to the staff token, skew → 0, rename
the constant. All caught.

---

## 3. A6 — the lost handoff, recovered

`git show 0f85155:HANDOFF.md` — intact, 383 lines. Filed at
`docs/history/handoffs/HANDOFF-2026-08-03.md`. Its §5 on zip supersession is the
origin of rule 3. **Closed.**

---

## 4. A53 — and a correction to my own earlier advice

I told you the missing register items (C6, E1-E4, G1-G2, H1-H2) were recoverable
from `git show 415e044:docs/AUDIT-REGISTER.md`. **That was wrong — `415e044` is
not in this repository's history.**

What is true: the register was opened 2026-08-07 with sections
`A1, B1-B5, C1-C6, D1-D3, E1-E4, F, G1-G2, H1-H2, I`. The 08-08 restructure kept
only A and D. **The first committed version of the file (`a80c224`) already had
only A-section headings**, so those entries never reached the repo at all — they
lived in a working copy or an external document. They are gone, and
reconstructing them would mean inventing findings.

`docs/AUDIT-ID-INDEX.md` lists all **20 audit IDs the code cites** with call
sites, each marked *in register* or *cited only* — so `// Audit H10` in
`render.yaml` leads somewhere. Generated by reading the tree, not hand-maintained.

---

## 5. A11 — deliberately NOT done

The entry says *"`ManagerPage.tsx:1061-65` comment contradicts itself"*. I read
the passage and **could not find a self-contradiction.** The nearest candidate is
the Close Day comment — *"the escape route for the trading-day gate; without it a
till stays frozen the first morning nobody closed the day"* — sitting on a tab
gated by `isManagerRole`, which means a cashier-only till stays frozen. That is a
possible design gap, not a comment disagreeing with itself.

Rewriting a comment on a guess would have replaced a finding I do not understand
with prose that looks resolved. **Left open, with what I checked recorded.** You
wrote it; you will know in ten seconds what I could not work out in ten minutes.

---

## 6. What was run

Linux, Node 22 — weaker than target (rule 9).

```
13 gates                    ALL PASS   (check-doc-refs still red: 1 doc, pre-existing)
desktop main tsc            exit 0
renderer tsc + vite build   exit 0 — 64 modules
server tsc · printing tsc   exit 0
typecheck ratchet           server 0 · dashboard 0
check-ipc-parity            136 channels bridged, 136 handled
migration tests (PGlite)    7 files, 110 assertions
server suites               23 / 23
desktop-scope suites        10 / 10
desktop suites              6 / 6  — incl. device-token 21, idle-lock 27
shared/printing             11 / 11
check-test-registration     32 files, all invoked
```

**Ten mutation checks across this session's four fixes. Every one caught.**

Also worth recording: `device-token-refresh.test.mjs` failed itself twice before
passing — my string-blanking hid the `'base64url'` literal from its own
assertion (an over-correction from the mailer lesson), and the `syncAll` slice
ran to end-of-file, so the helper's own definition satisfied *"syncAll calls
it"*. Both caught by mutation, not by the green run. That is now five times this
session a check could not see the thing it was checking.

---

## 7. Rollback

Independent per item:

```bash
# idle lock only
rm apps/desktop/src/main/idleMonitor.ts \
   apps/desktop/src/renderer/components/LockCurtain.tsx \
   apps/desktop/test/idle-lock.test.mjs
git checkout 84400d6 -- apps/desktop/src/renderer/App.tsx \
   apps/desktop/src/main/preload.ts apps/desktop/src/renderer/lib/posApi.ts

# sawtooth only
git checkout 84400d6 -- apps/desktop/src/main/syncEngine.ts
rm apps/desktop/test/device-token-refresh.test.mjs

# mail fix only (server)
git checkout 84400d6 -- apps/server/src/lib/mailer.ts apps/server/src/index.ts
rm tests/mailer-transport.test.mjs
```

`ipcHandlers.ts` and `index.ts` (desktop) carry both the A47 and A52 changes, so
reverting them whole drops both.

---

## 8. When you are back

**Test in this order** — the first one is time-sensitive and mostly unattended:

1. **A47 idle test on 0.5.28, if it has not finished.** Sign in, sell nothing,
   15+ minutes, then Refresh on Menu. Do this before installing anything new —
   a build containing A51 or A52 makes it unrepeatable.
2. **Build 0.5.29** with A51 + A52. Read the artefact filename before tagging.
3. **The lock:** open Manager, walk away 5 minutes. Curtain appears. PIN back in
   — the tab you were on is still there. Then the POS with items in the cart:
   wait 10, PIN back in, **cart intact**.
4. **The sawtooth:** `swiftpos.log` should stop filling with `401 → recovered`
   every 20 minutes. That is also the point at which the log becomes a useful
   diagnostic again.
5. **Mail** — the Render boot log two `[mailer]` lines, then 18:00 UTC tomorrow.

## 9. Still needs you

1. **A43** — approve the three-step sequence before anything is deleted.
2. **A49 `stock_adjustments`** — repoint at `stock_movements`, or drop the table
   and the report section.
3. **A12** — which branch's stock should the Recipes drawer show?
4. **A11** — §5; you will recognise what you meant.
5. **A1 rotation** — was `SUPABASE_SERVICE_ROLE_KEY` rotated after 08-08? Still
   nothing in the repo records it. **Treat as live until confirmed.**
6. **`Mama Ari` `owner_id = null`** — data fix only you can make.
