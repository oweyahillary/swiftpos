# MANIFEST — 2026-08-10-f

**Supersedes `-b` … `-e`. Cumulative — apply this one only** (rule 3).
**Base:** `84400d6` · **No `version` field touched anywhere** (rule 22).

Four more closed. **None required a decision from you**, which was the constraint.

| # | Item | Was | Now |
|---|---|---|---|
| 1 | **A43 step 1** | The deletion's blocker | Picker protection now exists on the LIVE screen |
| 2 | **D6** | Six local schema generations undocumented | `docs/LOCAL-SCHEMA-VERSIONS.md` |
| 3 | **A9 triage** | "23 vulns, 3 critical" with no analysis | Shipped surface: **none** |
| 4 | **A5** | Two planning docs silently a month stale | Both carry status headers |

---

## 1. A43 step 1 — the blocker, removed

Yesterday's revert found that deleting `PrintersTab.tsx` would drop the **only**
guard on a live field bug: `PrinterPicker` declared inside the component made a
new type per render, React remounted the `<select>`, and an open dropdown snapped
shut under the status-dot probes — read on site as *"stuck on Microsoft Print to
PDF"*. `PrinterSetupScreen.tsx:270` has a `<select>` of its own and had no
equivalent assertion.

`test-print-resilience.mjs` **§4b** now covers the live screen — four assertions,
in the **general form** of the bug rather than a copy:

- no component declared INSIDE `PrinterSetupScreen` (the identity churn itself)
- options keyed by `p.name`, not by index — index keys mean unplugging a printer
  renumbers everything below and React reuses the wrong DOM node, so the
  selection appears to jump
- a target still settable with **no printer plugged in** — otherwise a manager
  cannot fix a mis-set target without the hardware present
- the free-text input **not** hidden behind `localPrinters.length`, or a machine
  reporting no printers could set no target at all

Mutation-checked twice: nest a component inside the export, and key by index.
Each fires its own assertion.

**The live screen uses inline JSX and so cannot have the original bug today — but
it is one refactor away, and extracting a `PrinterPicker` is the obvious thing to
do as that file grows.** That is what the coverage is for.

**Step 2 still blocks the deletion:** §5 asserts the owner edits kitchen
exclusions *"on the Printers tab"* — a screen A43 says nobody can open. Resolve
that (PHASE6 §8c makes exclusions per-station) and the file can go.

---

## 2. D6 — local schema 46-51

`docs/LOCAL-SCHEMA-VERSIONS.md`. This is the mechanism that decides whether a
till trades, and six generations had no record anywhere.

**It is not a numbered ladder.** No `case 46:`. Tables arrive via
`CREATE TABLE IF NOT EXISTS`, columns via `migrateColumns` reading
`PRAGMA table_info`. Both additive and idempotent, so any older till converges by
running the whole file. **`LOCAL_SCHEMA_VERSION` labels the resulting shape; it
does not drive replay** — which is why it can be bumped with no matching code.

Traced: 43 baseline · 44 `device_id` (never shipped alone) · 45 replication
seq/outbox/cursors · 46 Phase 4 node tables · 47 Phase 2a distribution ·
49 events + maintenance_state · 51 `escpos_enabled`, `kitchen_exclusions`.

**48 and 50 never existed.** The constant jumped 47 → 49 → 51. Nothing broke —
but a reader hunting "what did 48 do?" finds nothing and would reasonably
conclude a migration was lost. **Same shape as the server**, where 31 and 32 are
SKIPPED and 64 never existed. Two independent numbering schemes, both with gaps
that looked like data loss until somebody checked.

Not reconstructed, and the file says so: what 44 and below did in detail, and
whether every field till has reached 51 — nothing here records the fleet's state.

---

## 3. A9 — the triage, and it is good news

The measurement said 23 vulnerabilities, 3 critical. It never said which **ship**.

| | Verdict |
|---|---|
| **All 3 CRITICAL** — `concurrently`, `shell-quote`, `tar` | devDependencies. Dev-server runner and the `node-gyp` → `electron-rebuild` chain. Not in the packaged app. |
| **16 of 18 HIGH** | `electron-builder` / `node-gyp` / `app-builder-lib`, plus `postcss`, `js-yaml`, `nanoid`, `brace-expansion`, `ip-address`. Build machine only. |
| **`electron` (HIGH)** | *AppleScript injection in `app.moveToApplicationsFolder`* — **macOS only**. Every till is win32. |
| **2 MODERATE — `uuid`, `exceljs`** | The only production dependencies. `exceljs` is flagged solely via `uuid`. |

**And `uuid` does not apply to how we call it.** The advisory is a missing buffer
bounds check in **v3/v5/v6 when `buf` is provided**. Every call site here is
`import { v4 as uuid }` — five of them, all `uuid()` with no argument.

**Shipped surface of 23 vulnerabilities: none.**

Worth stating plainly, because "3 critical" on a POS handling money reads as
urgent and would have had someone run `npm audit fix --force` on the chain that
**builds the installer** — a MAJOR toolchain bump, the week after a release went
out with two binaries under one version.

**Server is real but lower:** `body-parser` (DoS via a silently-disabled size
limit), `brace-expansion`, `ip-address` (SSRF / trust-boundary bypass — this one
matters more here, since the server takes inbound requests). All fixed by a plain
`npm audit fix`, no majors. **Not done tonight**, and deliberately not in the
same change as a mail fix going to production.

**Not claimed:** that these packages are safe in general — only that the
vulnerable paths are not on the till's shipped surface. Re-run per workspace when
the dependency set changes.

---

## 4. A5 — two documents that looked current

`PHASE2-3-DESIGN.md` still opened *"For approval before code"* **a week after the
code shipped** — Phase 2a in `5ef0f08`, 2b+2c in `fee91cc`, Phase 4 in `40f53ac`.
It now says to read it as a record of what was built, names the code as the
authority where they disagree, and lists the drift found by running it: the node
is a replica not a relay (A19), reference data does not flow downstream (A24),
the node cannot authorise anybody (A17). **The design anticipated none of those.**

`ROADMAP.md` (2026-07-10) mentions none of Phase 2, Phase 4, Close Branch,
`/node/since`, the office role or the ESC/POS migration, so its "now vs later"
calls are not a guide to what is next. It now says so and points at the register.
Kept rather than deleted: §1's north star — fast food first, petrol/minimart/
parking secondary — is the standing direction and is recorded nowhere else.

**Deliberately not rewritten.** Restating a month of decisions as a fresh plan
would be inventing intent. A document announcing its own staleness is honest; one
that looks current and is not is the failure this item was about.

---

## 5. D13 considered and NOT done

The P0 was the tempting one, and its fix is already specified — *"a short grace
window returning the current pair"*. I stopped, for three reasons:

1. **It needs a migration.** Returning the *current* pair means knowing the
   successor, which `refresh_tokens` cannot express — there is no `replaced_by`.
   A schema change on the production auth table is not a "no decision needed"
   change.
2. **The window length is a security decision**, not an implementation detail. A
   grace window necessarily weakens replay detection for its duration, and
   `validateRefreshToken` answers a replay by revoking **every session for that
   user**. How long is a trade you should make, not me.
3. **Shipping an auth change unsupervised, tonight, alongside a mail fix already
   going to production** is exactly rule 12.

Ready to build tomorrow once you pick the window. 60 seconds is my suggestion —
long enough for a dropped response, short enough that a stolen token is unlikely
to land inside it.

---

## 6. What was run

Linux, Node 22 (rule 9).

```
13 gates                    ALL PASS  (check-doc-refs red: 1 doc, pre-existing)
desktop main tsc            exit 0
renderer tsc + vite build   exit 0
server tsc · printing tsc   exit 0
typecheck ratchet           server 0 · dashboard 0
check-ipc-parity            136 bridged, 136 handled
migration tests (PGlite)    7 files, 110 assertions
server suites               23 / 23
desktop-scope suites        10 / 10   (test-print-resilience now 55)
desktop suites              6 / 6
shared/printing             11 / 11
check-test-registration     32 files, all invoked
```

**15 mutation checks across the session. Every one caught.**

---

## 7. Session totals

**Closed:** A5 · A6 · A9 (triage) · A43 step 1 · A47 · A48 · A50 · A51 · A52 · D6
**Opened:** A49 · A53
**Corrected:** A1 (split) · A7 (re-characterised) · A9 (dirs, never true) ·
A10 (**reopened — I had wrongly dismissed it**) · A12 (P3 → P1) · A39 (three
documents → one) · A4 / A46 (counts) · D14 (stale duplicate)

**My own errors, all recorded in the register:** A10 wrongly dismissed · told you
to recover lost items from `415e044`, a commit not in this history · printed
`BUILD OK` off `tail`'s exit code when the build had failed · **five tests passed
their own first run against the defect they existed to catch** · deleted `-b`/`-c`
without saying so.

## 8. Tomorrow

**Test order matters:** if the 0.5.28 idle test has not finished, do it **before**
installing anything — a build with A51 or A52 makes it unrepeatable.

Then 0.5.29 (A51 + A52), and these still need you: **A43 step 2** · **A49** ·
**A12** · **A11** · **D13 window length** · **A1 key rotation** · **`Mama Ari`
`owner_id`**.
