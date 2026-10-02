# HANDOFF — 2026-09-18 evening

Working rules unchanged: see HANDOFF-2026-08-08-evening.md §0 (rules 1-24). The
register (docs/AUDIT-REGISTER.md) wins over any handoff if they disagree.

Branch: `dev`  ·  HEAD: `2d6dbe2`  ·  desktop version: **0.5.48** (tag `v0.5.48`)
Cloud (test): Render from `dev` · web from `main` (Vercel).
Test business: "B Foods" / branch "Mama Ngina" — **single till**, terminal `T1`, `device_role = node`.

---

## 0. Goal

Started as a fresh repo review (whole-repo pass + a desktop deep-dive), then pivoted to
the live bug the owner hit during trade-testing: the **manager Overview showed KES 0 on a
real, completed sale**. That widened into a full desktop pass: fix Overview + Item Mix, add
build provenance and real error logging, sweep the register back into agreement with the
code, close the verified D-items, and kill the CRLF patch-apply problem at its root.

## 1. Current state

Everything below is on `origin/dev` at HEAD `2d6dbe2`, all bench gates green, and 0.5.48 is
**confirmed running on the real Windows till** (Overview populated: KES 1,390 revenue, VAT
191.72, Glovo payment split, "5PC Chicken Combo" top seller, hourly peak 21:00).

Shipped + confirmed on target (0.5.48):
- **A297** — manager Overview populates. The original bug. Root cause: A271's IPC payload
  guard rejected the Overview's no-argument `salesSummary()`/`topProducts()` calls
  ("payload must be an object") *before the handler ran*, so the DB was always fine and the
  panel was always blank. Fix: `guardChannel` treats an absent object-bag payload as `{}`.
- **A296** — Item Mix has the same date-range filter as the Orders tab (+ CSV export).
- **A298** — build provenance: every build stamps git SHA + build time (Tech screen → Device,
  and a `[startup] … build <sha> @ <time>` log line).
- **A299** — all errors now reach `swiftpos.log`: main `console.error/warn` (43 calls that
  bypassed the log) via `installConsoleCapture()`, and renderer errors via a
  `window.swiftpos.logError` → `ipcMain.on('log:renderer')` forwarder. Plus event summaries
  at sale/void/refund/shift/config — **id/total/method/count + changed-key names only**, never
  line items, customer data, or config values (that table holds the node secret + cloud url).

Register hygiene (docs-only sweep):
- A297 CLOSED; **D3/D4/D18 CLOSED** (owner-confirmed on target: auto-update, node enrolment,
  tech-token paste); **D13 CLOSED** (A88 actually built the grace window; heading had lagged);
  **D10** line count corrected (1,639 → 2,214); **Tree line** current (desktop v0.5.48,
  migrations →102). Desktop open D-items now: only D9/D10 (P3 cosmetic).
- Added an **anti-drift Tree-line check** to `check-register-consistency` — the `| Tree |`
  desktop version must equal `apps/desktop/package.json`, so it can't silently go stale again.
- **A19 heading corrected FIX BUILT → OPEN** — the heading overclaimed; code verified unbuilt.

CRLF fixed at the root:
- `.gitattributes` (already present, `* text=auto eol=lf`) had never been applied to existing
  working trees, so the Windows checkout was CRLF while the committed blobs were LF. A one-time
  `git rm --cached -r . && git reset --hard` refreshed the tree to LF. **Patches now apply with
  plain `git apply`** — no more `--ignore-whitespace`.

Open confirmations still owed (owner, quick):
- **A298** — Tech screen → Device shows a real build SHA matching the release commit → then CLOSE.
- **A299** — force a renderer error + ring a sale; confirm both appear in `swiftpos.log` → CLOSE.

## 2. Active files (touched this session)

Desktop code:
- `apps/desktop/src/main/ipcGuard.ts` — A297 (`payload ?? {}` in `guardChannel`).
- `apps/desktop/test/ipc-guard-optional.test.mjs` — A297 mutation-checked test.
- `apps/desktop/src/renderer/pages/ManagerPage.tsx` — A296 (Item Mix range filter).
- `apps/desktop/scripts/gen-build-info.mjs`, `apps/desktop/src/main/buildInfo.ts` — A298.
- `apps/desktop/src/main/logFile.ts` — A299 (console capture, `appendToFile`) + A298/A299 wiring.
- `apps/desktop/src/main/index.ts` — A298/A299 (`installConsoleCapture()`, startup stamp).
- `apps/desktop/src/main/ipcHandlers.ts` — A298 (`tech:status.build`) + A299 (`log:renderer`,
  event summaries in order:create/void/refund, shift:open/close, config:save).
- `apps/desktop/src/main/preload.ts` — A299 (`logError` bridge).
- `apps/desktop/src/renderer/lib/posApi.ts` — A298 (`TechStatus.build`).
- `apps/desktop/src/renderer/pages/TechPage.tsx` — A298 (Build row).
- `apps/desktop/package.json` — version 0.5.43 → **0.5.48**; `test:ipcguard`, `gen:buildinfo`
  scripts; `build:all` runs `gen:buildinfo` after `build:main`.

Repo:
- `scripts/check-register-consistency.mjs` — Tree-line version check.
- `docs/AUDIT-REGISTER.md` — A296–A299 entries; D3/D4/D18/D13/D10/A19 heading + Tree/counts;
  changelog rows.
- Six per-delivery manifests, `docs/MANIFEST-2026-09-18-a.md` through `-f`.

## 3. Changes made — the reasoning trail

- **A296** was authored early (Item Mix filter) and, as a side effect, made Item Mix send an
  object payload — which is why Item Mix started working on 0.5.44 while the Overview stayed
  blank. That split was the clue that led to A297's real cause.
- **A297**: the Overview error was only visible in DevTools (`console.warn`, not in
  `swiftpos.log`). Once we had the verbatim `IpcValidationError: payload must be an object`,
  the one-line `guardChannel` fix was obvious. Verified by `test:ipcguard` (6/6) and the till.
- **A298** exists because we shipped a "0.5.47" that didn't contain the fix and only found out
  by reading the git tag. A visible SHA turns "is the fix on this till?" into a glance.
- **A299** exists because the whole A297 hunt needed a DevTools screenshot for an error that
  should have been in the log. Now it is.
- **Register sweep + Tree gate**: stale headings (D13) and a stale Tree line actively made the
  debugging harder; the gate stops the version field drifting again.

## 4. Failed attempts / dead ends (so they're NOT repeated)

- **A297 root cause — three wrong diagnoses before the DevTools error.** (1) "ingested orders
  lack line items" — disproven (order had items). (2) "status/date filter excludes it" —
  disproven (status='completed', created_at today, exact window returns it). (3) "stale/
  mis-built 0.5.43 bundle" — disproven (0.5.44 rebuilt clean, Item Mix worked, Overview didn't).
  **Lesson: get the runtime error FIRST; do not theorize from source when a one-line console
  line names the cause.**
- **CRLF patch war.** Patches failed to apply on the Windows checkout (`patch does not apply`
  at AUDIT-REGISTER.md:8657). `git apply`, then `--3way` (missing base blob), then
  `--ignore-whitespace` all fought it; the real cure was the working-tree LF refresh (§1). Two
  intermediate deliveries switched to CRLF-safe **Node scripts** (`apply-a299-docs.mjs`,
  `fix-a299-rotation.mjs`) that search-replace instead of using `git apply`.
- **"Did the intended change ship?" bit us twice.** 0.5.44 was tagged without the A297 fix
  (the wrong patch was applied). 0.5.47 was tagged with a 5MB rotation that then **failed CI**
  (`test/logFile.test.mjs` pins 1MB) — I had bumped a tested design value without checking for
  its test. Both surfaced as bogus `v0.5.47` tags on the wrong commits; each was deleted and
  re-cut. Ended clean at **0.5.48** (1MB restored). **Lesson: before tagging, `git apply
  --check` must be clean AND `build:all` must print the expected `Packaging vX` line; sweep for
  a matching `*.test.mjs` before changing any file.**
- **`managerReports.ts:145` `isNodeRole` "bug" — false alarm, retracted.** The `role` variable
  is already normalized through `isNodeRole()` (node OR office → `'node'`), so
  `coversBranch = role === 'node'` correctly includes office. Code is correct; the morning
  flag misread `role` as the raw device_role. No change made (correctly).

## 5. Next steps

Do first (tomorrow, agreed):
- **A19 §3 — node forwards offline-peer sales to the cloud.** Real, OPEN, P1. Needs a
  **two-till rig** (node + peer + cloud). Plan: (1) a peer with a `node_url` stops enqueuing to
  its own `sync_queue` and pushes to the node only, with a 404 fallback to the cloud queue for
  an old node build; (2) `nodeIngest.applyPeerRows` also drops peer ORDER rows into the node's
  OWN `sync_queue` (preserving the peer's original id + `idempotency_key`) so the node's cloud
  push relays them. Hard part: the node must produce the `/api/orders` payload for a forwarded
  sale — stash the peer's payload at ingest rather than reconstruct it. Idempotency makes a
  mixed-version rollout safe. Money path → ship last, its own release, verify on the rig. Latent
  for "Mama Ngina" today (single till). Full detail in the A19 register entry + PHASE5 §3.

Also owed:
- **Push the A19 heading-fix patch** (`swiftpos-A19-reopen.patch`) — prepared, not yet pushed.
- On-till **A298 / A299** confirmations (§1).

Backlog rocks, recommended order:
- **A281** (P2) — front-end/back-end deploy from different branches (Vercel=main, Render=dev).
  Cheapest, high leverage, no rig; removes real "is it shipped?" friction.
- **A280** (P1) — a clean baseline+migrations rebuild does NOT reproduce production
  (verify-db-schema fails). The real disaster-recovery risk; wants a prod snapshot and a
  focused session of its own.
- **A19 §3** (P1) — as above.

### Skipped / proposed (low priority)
- README says "77 migrations"; actual is 102 — 30-second doc fix.
- `.gitattributes` lists only png/ico/xlsx/zip as binary; `text=auto` covers the rest, but
  explicit `*.exe *.node *.blockmap *.woff2 *.ttf` would be belt-and-suspenders.
- Rule 21: `getServerUrl()` still not renamed to `getCloudUrl()`, and no register ID tracks the
  deferral — small standing debt.

## 6. Environment note (rule 9)

Work was authored on a **Linux bench, Node 22, no app `node_modules`** (pglite and esbuild were
installed ad hoc to run specific gates/tests). The bench **cannot build Electron or run the
desktop SQLite suites** — every desktop "green" here means "read the source and ran the named
gate/test in isolation," not "built on target." All desktop build/verification was the owner's
Windows `npm run build:all` and CI. Delivery was via patches (and, during the CRLF period,
CRLF-safe Node scripts) applied from the owner's `../patch files/` folder.

## 7. Process notes — what made this session work (and the guards to keep)

- **The runtime error beats any theory.** Hours went to source-reasoning about A297; one
  DevTools line ended it. For any misbehaving screen, get the console error first.
- **Prove the change is in the build before tagging.** `git apply --check` clean + `build:all`
  printing the expected `Packaging vX` + the CI-green commit. A298 (visible SHA) exists to make
  this a glance, not archaeology.
- **The register must match the code.** Stale headings (D13, A19) cost real time; the Tree-line
  gate and the sweep are the counter-measures. Keep them honest.
- **Sweep for existing tests before editing a file** (the 5MB rotation regression).
- **On Windows, keep the working tree LF** (the `.gitattributes` refresh). Patches are then
  boring, which is the goal.
