# MANIFEST — 2026-08-10-c

**Supersedes `-b`. Cumulative — apply this one only** (rule 3).
**Base commit:** `84400d6` (`dev`)
**Desktop version: 0.5.27 — UNCHANGED.** Neither `package.json` touches its
`version` field; both diffs are `scripts` only, checked before packing (rule 22).

Carries `-b`'s two field fixes plus four items that needed no decision from you.
**One of the four was attempted and reverted** — that is §4, and it is the most
useful thing in this zip.

---

## 1. Files (13)

| File | Change |
|---|---|
| `apps/desktop/src/main/ipcHandlers.ts` | `manageFetch` gains 401 refresh-and-retry (**-b**) |
| `apps/desktop/src/main/syncEngine.ts` | `refreshStaffToken` exported (**-b**) |
| `apps/desktop/test/manage-fetch-refresh.test.mjs` | NEW, 15 assertions (**-b**) |
| `shared/printing/src/render.ts` | Receipt closing block restored (**-b**) |
| `shared/printing/src/types.ts` | `closingMessage?` on `BusinessConfig` (**-b**) |
| `shared/printing/test/receipt-footer.test.ts` | NEW, 11 assertions (**-b**) |
| `scripts/check-auth-retry.mjs` | **NEW GATE** — every authenticated fetch handles 401 |
| `scripts/table-usage-exceptions.json` | A49: false exception corrected + standing warning |
| `docs/AUDIT-REGISTER.md` | Reconciled against the tree; A47/A48/A49 added |
| `docs/RUNBOOK.md` | Field-incident section + honest staleness warning |
| `apps/desktop/package.json` | scripts only |
| `shared/printing/package.json` | scripts only |
| `.github/workflows/ci.yml` | three steps added |

**No source file was deleted.** See §4.

---

## 2. New gate — `check-auth-retry.mjs`

A47 named this as worth building; it is built and **in CI, green**.

Any function that both attaches `Authorization: Bearer` and calls `fetch()` must
mention 401. It asserts only that expiry was *considered* — whether the retry is
correct is `manage-fetch-refresh.test.mjs`'s job, because it can drive the
decision. A source scan claiming more would be pretending to knowledge it lacks.

**It found a second instance on its first run:** `refreshTechConfig`
(`techService.ts:85`). **Exempted, not fixed** — one call site
(`ipcHandlers.ts:126`), fire-and-forget, passing a token seconds old from
`/desktop-login`. A 401 there is not expiry, and the only cost of failing is that
the tech panel cannot be unlocked offline until the next login. Machinery for a
case that cannot arise is rule 12. The exemption carries a `VERIFY BY:` grep that
voids it if a second call site ever appears.

Two exemptions I *drafted and then removed*: `doRefreshAccessToken` and
`doRefreshStaffToken`. They post `refreshToken` in the body and attach no bearer
header, so they were never in scope. An exemption that exempts nothing is exactly
the unverified-claim shape A49 is about, and shipping one in the same zip that
corrects A49 would have been absurd.

Mutation-checked: remove the 401 branch from `manageFetch` → exit 1, naming
`ipcHandlers.ts:1318` and the function.

---

## 3. A49 — a dead table hidden by a false exception

`stock_adjustments` is read at `reports.ts:286` to build the Adjustments section
of the stock-movement report, and is **written nowhere** — not `apps/server`, not
`apps/dashboard`, not `apps/desktop`, not any migration, not any RPC. So
`restocked` and `written_off` are permanently zero and the report states that
nothing was ever restocked or written off.

`check-table-usage` — the gate built for exactly this shape (B6) — was silenced
by an exception reading *"Written by the till via /api/sync/push, which resolves
the table name dynamically."* **Both halves false, and never true:**
`/api/sync/push` writes four hardcoded tables (`business_days`, `shifts`,
`float_transactions`, `expenses`), and `stock_adjustments` is in neither
`SYNC_DIRECTION` nor `localDb.ts`.

Corrected to state the finding. **CI stays green** — `readOnly` entries are
informational by that gate's design, so this does not turn the build red; it
stops the file lying. The header now carries a standing warning that every reason
in it is prose nothing checks, and asks for reasons checkable in one grep.

Adjustments are actually recorded in `stock_movements`. **The fix is a product
decision and is not done:** repoint the report, or drop the table and the section.

---

## 4. What was attempted and REVERTED — A43

You said items that need no approval. I judged deleting `PrintersTab.tsx` to be
one, because the register records the owner's condition as already met. **That
was wrong, and the reason is worth more than the deletion.**

Deleted it — 479 lines, verified unreachable (no `import PrintersTab` anywhere;
only comments). Desktop main tsc, renderer tsc and `vite build` all passed.

**Then `scripts/test-print-resilience.mjs` went red — ENOENT, four reads.** Two
things are tangled in that suite:

1. **§4 protects a real field bug independent of this file's reachability.**
   `PrinterPicker` was once declared *inside* the component, so every render made
   a new component type, React remounted the `<select>`, and an open dropdown
   snapped shut under the status-dot probes — read on site as *"stuck on Microsoft
   Print to PDF"*. **`PrinterSetupScreen.tsx:270` has a `<select>` of its own and
   no equivalent assertion.** Deleting `PrintersTab` does not drop dead coverage;
   it drops the **only** guard against that bug, on the screen that is now live.
2. **§5 asserts the owner edits kitchen exclusions "on the Printers tab"** — a
   screen A43 itself says nobody can open. The gate has been protecting a fiction
   since 0.5.27.

**Rule 20 decides it: the assertion complains, so the change moves.** Rule 12 too
— "delete 479 dead lines" grew into "rewrite a print-resilience suite covering a
live field bug", which means the diagnosis was wrong, not that the fix is bigger.
Reverted rather than loosened.

**Sequence recorded in A43, and it is a decision, not a chore:**
1. Port §4's picker assertions to `PrinterSetupScreen.tsx` — **strengthening, not
   relocating: that coverage currently sits on a screen nobody can open.**
2. Resolve §5 — exclusions move somewhere reachable (PHASE6 §8c makes them
   per-station), or the assertion goes as describing a screen that is gone.
3. Only then delete.

Also found: `components/StationsPanel.tsx` (294 lines) is imported **only** by
`PrintersTab:22`. It is the nearest existing desktop implementation of what
PHASE6 §8c wants at the branch, so it must not be swept up with the parent.

---

## 5. Register reconciled against the tree

Everything below was verified by running or reading the tree. Where the tree and
the register disagreed, the tree won.

| ID | Was | Now |
|---|---|---|
| **A1** | `P0 · OPEN` | **SPLIT.** Packaging is CLOSED — `package`/`package:check` and `scripts/check-package.mjs` all present, and §E already said so, so the file contradicted itself. **Rotation half still open, and it is not a code question:** no document records that `SUPABASE_SERVICE_ROLE_KEY` was rotated after 08-08. |
| **A7** | "unrouted, no ROADMAP line" | **Re-characterised.** Parking and petrol ship inside `CashierScreen` (`:1141`, `:1182`). `ParkingPOS`/`PetrolPOS` are finished upgrades carrying their own *"INTEGRATION IN CashierScreen.tsx — replace the bay-grid block"* headers. `MinimartPOS` has the same header and **was** wired in. Rule 17 exactly. The old wording invites rebuilding what exists. |
| **A8** | open | Confirmed + full dashboard sweep: **6 files, 2,903 lines** unreferenced. |
| **A9** | `P3 · OPEN` "empty dirs" | **CLOSED — never true.** 12, 12 and 14 files. **ID COLLISION recorded:** `A9` is used twice, against this file's own "IDs are stable and never reused". |
| **A10** | I called it false last session | **REOPENED — I was wrong.** Only 1 of its 4 claimed supersessions happened. `PrinterSettingsModal` is still imported at `POSPage.tsx:21` and rendered at `:1351`; `PaperWidthControl` is still imported by it. |
| **A12** | `P3 · INVESTIGATE` | **P1.** Live: nothing writes `ingredients.current_stock` since migration 23; `recipes.ts` reads it 3×; `RecipeDrawer.tsx:308` renders it red when `<= 0`. Two screens, two numbers, wrong one alarmed. **Fix needs a decision** — recipes are business-level, the stock table is per-branch. |
| **A39** | "RED until those three land" | **One document** — only `BRANCH-SERVER-PLAN.md`. PHASE6 is blocked on one, not three. |
| **A4** | 20 of 66 | **22 of 68** — ratio unchanged, finding stands. |
| **A46** | 29 routes | **30**. |
| **A43** | "can be deleted" | **Stays open** — §4. |
| — | — | **A47, A48, A49 added.** |

Header counts re-derived by reading the file rather than carried forward — the
old header said 5 P2 where section A listed 3.

---

## 6. RUNBOOK — the two missing lines

`RUNBOOK.md` was ~33 migrations stale: it opens *"Unzip over the repo root"* and
its migration section reads *"Now — migration 41."* It is what someone opens
during a field incident.

**I did not update the migration steps** — that would mean inventing production
state I cannot verify from here, and `schema_migrations` cannot answer it either
(A4). Instead the section carries an explicit warning not to follow it, and a
pointer to `npm run test:migrations`, which is current and green.

**New §0 — field incidents**, transcribed from register decisions that lived
nowhere an operator would look:

- **0.1 A node has failed** — *do not wipe or re-image until `swiftpos.db` has
  been read.* Promotion cannot recover rows the dead node originated but never
  distributed, and nothing measures that lag (A23).
- **0.2 A terminal is missing or stolen** — *rotate the PINs of every cashier who
  signed in on it.* States honestly what DPAPI does and does not defeat, and that
  `override_pin_hash` is never cached (A20, A17).
- **0.3 Before any till trades on 0.5.27+** — tick the thermal checkbox, or
  nothing prints at all (D8, A42).

---

## 7. What was run (rule 7)

Environment: **Linux, Node 22.** Weaker than the target (Windows, Node 20,
better-sqlite3 under Electron 35) — rule 9. Nothing here touches SQLite.

```
13 gates                       ALL PASS (incl. the new check-auth-retry)
check-doc-refs                 FAIL — PRE-EXISTING, 1 doc: BRANCH-SERVER-PLAN.md
schema-audit --strict          467 selects / 100 inserts, total: 0
schema-parity                  PASS (with warnings)
typecheck ratchet              server 0 · dashboard 0, baseline held
desktop main tsc · vite build  OK — 64 modules transformed
shared/printing tsc -b         OK
migration tests (PGlite)       7 files, 110 assertions, green
server offline suites          22 / 22
desktop-scope suites           10 / 10  (incl. test-print-resilience 51/51)
desktop suites                 logFile 12 · sync 29 · failover 12 · manageFetch 15
shared/printing npm test       spooler 18 · bridge-sim 30 · receipt-footer 11
check-test-registration        29 files, all invoked
```

**Mutation checks** — each reintroduces the defect, confirms red *naming the
right thing*, restores:

| Mutation | Result |
|---|---|
| Remove `manageFetch`'s 401 branch | test: 4 red, exit 1 · gate: exit 1 naming `ipcHandlers.ts:1318` |
| Remove the whole closing block | 7 red across three sections |
| Remove **only** the `vatRate > 0` guard | **exactly 1** red |

**`test-print-resilience` going red is itself the strongest evidence in this
zip** — an existing gate caught a deletion the register had pre-approved.

---

## 8. Rollback

```bash
git checkout 84400d6 -- apps/desktop shared/printing scripts docs .github/workflows/ci.yml
rm apps/desktop/test/manage-fetch-refresh.test.mjs
rm shared/printing/test/receipt-footer.test.ts
rm scripts/check-auth-retry.mjs
```

Per concern, all independent:

```bash
# the banner fix only
git checkout 84400d6 -- apps/desktop/src/main/ipcHandlers.ts apps/desktop/src/main/syncEngine.ts
# the receipt only
git checkout 84400d6 -- shared/printing/src/render.ts shared/printing/src/types.ts
# the new gate only  (also remove its CI step)
rm scripts/check-auth-retry.mjs
# docs only
git checkout 84400d6 -- docs/AUDIT-REGISTER.md docs/RUNBOOK.md scripts/table-usage-exceptions.json
```

---

## 9. Still needs you

1. **The auto-lock** — two decisions: lock returns to the **PIN pad**, not owner
   sign-in (otherwise a shop with no internet and nothing cached locks itself out
   — A17 through a new door); and whether a lock mid-sale blocks or holds the
   cart. 3 minutes is aggressive for a counter during service.
2. **A43** — approve the three-step sequence in §4 before anything is deleted.
3. **A49** — repoint the report at `stock_movements`, or drop the table and the
   section.
4. **A12** — which branch's stock should the Recipes drawer show?
5. **A1 rotation** — was `SUPABASE_SERVICE_ROLE_KEY` rotated after 2026-08-08?
   Nothing in this repo records it. **Treat as live until confirmed.**

## 10. On target (rule 16)

1. **The banner.** Sign in, open Menu, idle **> 15 minutes**, press Refresh. A
   shorter wait proves nothing — the token has not expired yet.
2. **The receipt.** Print a sale with the Receipt field **filled and empty**. The
   empty case is the one that was broken.
3. **A zero-rated business**, if you have one — the tax line must NOT appear.
