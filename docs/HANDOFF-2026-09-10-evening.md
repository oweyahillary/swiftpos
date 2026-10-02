# HANDOFF — 2026-09-10 (evening)

Read this first next session. Everything built today is **committed and pushed** —
unlike the 09-09 handoff, there is nothing uncommitted to apply. What's outstanding
is *verification on the till*, captured in a checklist ready to run tonight.

---

## Goal
Two threads this session:
1. **Burn down the genuinely-unbuilt backlog** now that CI is green and zero P0s remain.
2. **Prepare tonight's on-till verification** so the large "built but unverified"
   pile can start closing.

Both met: the last pure-build P1 (D3) is wired, three more items were built/closed,
and a two-surface checklist is ready for the dev till.

---

## Current state

### On `origin/dev` — HEAD `4b325fc`, working tree clean, CI green
Open counts: **A: 0 P0 · 18 P1 · 21 P2 · 12 P3 — D: 0 P0 · 2 P1 · 1 P2 · 2 P3.**

Commits added today (newest first):
- `4b325fc` **D9 core** — node-authoritative held-order claim/lease/audit (benchable
  half) + **D18** paste guard.
- `aa8011d` **D3** — desktop auto-update wired (electron-updater + GitHub Releases +
  tag-triggered `release.yml`). FIX BUILT.
- `8a48e4b` **Register hygiene** — fixed the malformed D10 heading + reconciled the
  Counts ID list to the body.
- `d272c5e` / `3b72c59` **D1/A204/A146 CLOSED, A18 → P3 NOTE** (D1 was the last P0,
  already fixed by A158's enrolment work — verified in source, not rebuilt).

### Zero P0s. The board is now mostly verification, not building.

---

## Active files (all committed — this is what changed today)
- `apps/desktop/src/main/autoUpdate.ts` — dev-flavour skip; header → WIRED (D3)
- `apps/desktop/src/main/index.ts` — imports + calls `initAutoUpdate()` guarded (D3)
- `apps/desktop/electron-builder.config.js` — GitHub Releases publish, prod-only (D3)
- `apps/desktop/tsconfig.main.json` — removed the `autoUpdate.ts` exclude (D3)
- `apps/desktop/package.json` — `+electron-updater`; `+test:tabs` chained into `test:desktop`
- `.github/workflows/release.yml` — NEW, tag-triggered build+publish on Windows (D3)
- `apps/desktop/src/main/nodeTabs.ts` — NEW, held-order claim/lease/audit core (D9)
- `apps/desktop/test/node-tabs-claim.test.mjs` — NEW, 17-check D9 core test
- `tests/autoupdate-wiring.test.mjs` — NEW, 12-check D3 wiring guard
- `tests/tech-token-paste.test.mjs` — NEW, 6-check D18 paste guard
- `apps/dashboard/src/pages/stock/StockTransfersPage.tsx` — A204 cancel-reason modal
- `apps/dashboard/src/pages/SettingsPage.tsx` — A146 consolidate onto shared WebhooksTab
- `apps/dashboard/src/pages/OverviewPage.tsx`, `ReportsPage.tsx`,
  `products/{Categories,Products}Page.tsx` — A258/A259/A257 owner-side fixes
- `docs/` — AUDIT-REGISTER + manifests + `D9-decision-brief.md` + `DESKTOP-AUTOUPDATE.md`

## Changes made (by item)
- **D3 → FIX BUILT** — auto-update pipeline: dep + wiring + prod-only GitHub feed +
  tag release workflow + dev-flavour runtime skip. Guarded, mutation-checked.
- **D9 → FIX BUILT (core only)** — the atomic claim/lease/audit per the owner's
  soft-lock model (90s lease renewed on edit; clear + forced-steal audited). Core
  proven (17 tests). Integration + live behaviour deliberately NOT built (see below).
- **D18 → FIX BUILT** — the tech-token paste fix (already in `PinPage`) locked with a
  guard.
- **A204/A146 → CLOSED** — cancel-reason modal; webhooks UI consolidated.
- **A258/A259/A257 → fixed (owner-side)**, still FIX BUILT pending a browser look.
- **D1/A146/A204 CLOSED, A18 → NOTE** — D1 was the last P0.
- **Register hygiene** — D10 heading + Counts list.

## Verification done (bench, rule 16 respected)
- Desktop main tsc 0; dashboard tsc 0; ratchets green.
- All offline suites green (**97–98/98** incl. server-built); every gate green.
- Every guard added today mutation-checked.

---

## Failed attempts / things that went wrong (so they're not repeated)
- **A186 (Windows migration false-FAIL) — attempt FALSIFIED, reverted.** Theory was
  "close the PGlite handle before exit stops the libuv crash." Shipped labeled
  unverified; the owner ran it on Windows and **test-migration-47 crashed EVEN WITH
  the `db.close()` added** — so closing the handle is NOT the cause. All 6 edits were
  reverted (no dead non-fix code). A186 stays **OPEN** with new evidence recorded:
  crashers are **47, 79, 41-42**; `db.close()` ruled out; next candidates = upgrade
  `@electric-sql/pglite`, or subprocess-isolate each test. Still P3 (Ubuntu CI is the
  authoritative green). This is the "ship-unverified-then-test-on-hardware" loop
  working as intended — a wrong theory caught before it calcified as a fake fix.
- **The recurring wrong-directory git trap.** Running the apply commands from
  `pos/apps` instead of `pos` root kept failing pathspecs. Always `cd /c/swiftpos/pos`
  and `pwd`-check first; the `cd apps/dashboard && … && cd ..` idiom leaves you in
  `apps`, so prefer `(cd apps/dashboard && npx tsc …)` in a subshell.
- **Double-commits from partial paste retries** (happened twice) — harmless because
  register edits were idempotent and the consistency gate re-derives counts, but watch
  for it: stage explicitly, `git status --short` before commit.
- **`release:both` bumps the version even on a failed build** — left the tree at
  0.5.39 after an earlier crash. Use `release:both none` for verification builds.

---

## Next steps

### 1. FIRST: run tonight's checklist (dev till) — closes up to 7 items
`tonight-checklist.html` (delivered separately) — two tabs, single till:
- **Web POS:** A265+A266+A267 (one idle-then-charge covers all three P1s), A258, A259,
  A257, A260.
- **Desktop POS:** A158 (enrolment-only — owner already reported this passes), D18
  (paste a full `st2.` token).
Hit **Copy report**, paste it back → the passes get closed in one commit.

### 2. Close the first release to finish D3 (highest leverage)
`git tag v0.5.40 && git push origin v0.5.40` → `release.yml` builds+publishes → install
that build → bump+tag again → confirm a running till self-updates on next quit. That
end-to-end loop moves **D3 → CLOSED** and ends A1. Unsigned is fine (SmartScreen once);
Azure Trusted Signing (~$10/mo) removes it later via a secrets flip, no code change.

### 3. Two-till LAN session — the biggest single chunk
Verifies the offline/sync P1 cluster (A19/A20/A24/A129/A160–A164/A168) AND the **D9
live behaviour** (poll lag, offline mid-charge, real claim race). Do NOT ship D9 to a
real floor until this passes — held orders are the most dangerous data.

## Proposed / skipped (deliberately not done)
- **D9 integration half** — wiring `nodeTabs` into `nodeServer` routes + `nodeClient`
  + desktop IPC/UI (Open-vs-Locked indicator, claim-on-recall) + the audit→cloud
  `notifications` hop. Ready to build on request; needs the two-till rig to verify.
- **A186** — parked with next candidates identified (see above). Low value (P3, CI
  green); revisit only if the local-Windows annoyance matters.
- **Genuinely-unbuilt remaining:** A22 (promotion split-brain), A23 (RPO measurement),
  D10 (ipcHandlers refactor). Plus **A54** (mail — needs an SMTP/owner decision).
- **A260** may need a real business loaded to confirm — folded into tonight's web checklist.

## Owner decisions still open
- D9: poll interval 3–5s (assumed) wants a node-load sanity check.
- A54: the SMTP/mail-delivery decision.
- D3: whether/when to add a signing cert.

---

## One-line status
Pushed through `4b325fc`; zero P0s; A-P1 18. D3 wired, D9 core built+proven, D1/A204/
A146 closed, register clean. Nothing uncommitted. Tonight: run the checklist on the dev
till and paste the report — up to 7 more close. Then tag the first release to finish D3.

— Claude
