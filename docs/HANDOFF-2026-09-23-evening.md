# HANDOFF — 2026-09-23 evening (full session; owner present throughout)

**Read first:** `docs/WORKING-METHOD.md` (new today) — how sessions run: the delivery loop, the three command blocks,
how "landed" is confirmed, the release sequence, today's pitfalls. **Rules:** unchanged — `HANDOFF-2026-08-08-evening.md`
§0, rules 1–24, plus the owner rulings in `HANDOFF-2026-09-22.md` (rule 1 governs docs-only deliveries too; rule 21
covers UI strings). **New standing ruling today:** SwiftPOS is general-purpose — no reference business is named in
anything shipped or newly written (A322).

## Headline
- **Branding Phase 1 (A295) CLOSED on target** — every §10 item verified on the client's own till (mamangina).
- **Desktop v0.6.3 released and running on mamangina** (tag `v0.6.3` on `648aaa5`, Release desktop #19).
- **14 register items closed** today, 7 opened (6 of them closed the same day). Open: **0 P0 · 18 P1 · 17 P2 · 18 P3**
  (morning: 0 · 19 · 17 · 24).
- 13 deliveries (`-l` … `-x`) plus this one; every push landed and **every CI run green, #374 → #387**.

## What happened (`dev` `778f927` → `52ab094`, + this `-y`)
| Delivery | Commit | CI | What |
|---|---|---|---|
| -l | `7a66044` | #375 | A315 + A314 built — but **only the manifest landed**: the zip was extracted outside the repo. Tree unchanged; CI green because nothing new ran. |
| -m | `74d29a1` | #376 | Re-issue of -l + Windows fix for the bundle builder (`spawnSync npx ENOENT`). **A315 FIX BUILT** (no duplicate thank-you: whole-line match, owner ruling). **A314** artefacts refreshed + drift gates (`npm test` for SAMPLE/out bins; CI step "Web receipt bundle is reproducible", esbuild pinned 0.28.2) → CLOSED on CI. |
| -n | `b646b51` | #377 | **A316** (P1) web receipt-logo codec had no `Buffer` in the browser → every Branding save with a logo 400'd, web never printed a logo; Buffer-free base64. **A317** (P2) product schemas reject `description: null` → `.nullable()`. Builder DEP0190 change — which **broke the Windows builder** (quoted `"npx.cmd"`). |
| -o | `df84eaa` | #378 | Builder: -m's exact command line restored, as one string (no DEP0190). Confirmed on the owner's Windows run. |
| -p | `d889697` | #379 | **A318** products table clipped Edit/Delete (Family Meals) → scrolls, actions pinned right. **A319** web colour rule drifted from the till's → synced `contrast.ts` copy (4 copies, `check-shared-sync`). Both reproduced + verified in headless Chromium on the real components. |
| -q | `67a5480` | #380 | **A320** product name trimmed before the non-empty check (PATCH could save `''`). |
| -r | `5afe60b` | #381 | `VERIFY-BRANDING-PHASE1.md` corrected for the retest (A5's rejected example was wrong; A1/B1 record what separates causes; new §G). |
| -s | `a5a3a3f` | #382 | Interactive HTML checklist `docs/checklists/verify-branding-phase1.html` (now tracked). |
| -t | `2cab94b` | #383 | Retest recorded (Eugene, 0.6.2): 18 PASS / 0 FAIL. **Closed:** A311 A312 A313 A316 A317 A318 A320. **A321 opened** — changes reach the till's DB but the open screen never refreshes (diagnosed from source). `VERIFY-LOG-2026-09-23.md`. |
| -u | `ae617e0` | #384 | **A321 built**: every landed pull signals every window (one point in `syncAll` for all 8 pull paths); lock screen listens; 20-s check renews/refreshes on 401 and records other failures. New CI step "Desktop catalogue refresh signal". |
| -v | `648aaa5` | #385 · Release #19 | **Desktop v0.6.3**: Tree row + owner's `npm version 0.6.3` in one commit; tag `v0.6.3`. |
| -w | `8df231e` | #386 | **Phase 2 theme proposal** `docs/PROPOSAL-A295-phase2-themes.html` (nothing built). **A322 opened**. |
| -x | `52ab094` | #387 | 0.6.3 run recorded (A2, B1, A5, A315 PASS). **Closed:** A295, A278, A308, A315, A319, A321. |
| -y | (this) | — | This handoff + `docs/WORKING-METHOD.md`. |

## State
- `dev` tip `52ab094` (+ this -y). CI green on every commit.
- **Desktop 0.6.3** published and running on mamangina (owner-confirmed, version shown 0.6.3).
- **Cloud + dashboard** deployed by the owner from `a5a3a3f` ("current" at the retest) — carries A316–A320. Nothing
  cloud/dashboard-side has changed since. No migration today; prod DB still on 105.
- **Register:** 0 P0 · 18 P1 · 17 P2 · 18 P3.
- **Closed today (14):** A314, A311, A312, A313, A316, A317, A318, A320, A295, A278, A308, A315, A319, A321.
- **Opened today (7):** A316–A322; all closed except **A322**.

## Next session — in this order
1. **A322 (P2) — reference-business names in shipped product.** Owner confirmed it is next. Client-visible, fix first:
   `shared/printing/src/sampleTicket.ts:21` (the technician test print's business name, on every client's printer),
   `apps/desktop/src/renderer/pages/ManageTabs.tsx:530` (receipt-text placeholder: a social handle), `:1203` (menu-import
   sample row). Then the non-visible tidy-up (comments, `shared/printing/test/fixture.ts` → refresh artefacts with
   `npm run refresh-artefacts` under the A314 gate, tests, the scope addendum, the VERIFY A5 label, the checklist file named
   after one of them). **Rule-17 sweep first:** is `sampleTicket` in the web bundle (`scripts/escpos-renderer/entry.ts`)?
   If yes, rebuild the bundle in the same delivery. History (handoffs, manifests, logs, old register text) stays as written.
   The test print changes → **desktop 0.6.4** (release sequence: WORKING-METHOD §7). Target check: a test print shows
   "Your Business"; the two till screens show neutral samples.
2. **Phase 2 — owner's decisions on the proposal** (7, each with a recommendation in the page): which themes (proposed:
   Ocean, Violet, Lagoon, Orchid, Sky); family-of-shades model; the unthemed default; status threshold (20); theme-to-theme
   threshold (10); the Phase 1 palette; receipt-line order; premium gating via `feature_flags`. When decided, open a Phase 2
   register entry and follow the scope's build order (§16).
3. **Worth a look now:** the live cloud's `/health` reports `"env":"development"` (seen 2026-09-23 on
   `swiftpos-20c2.onrender.com`). Confirm whether that is intended for production.

## Follow-ups logged today (not started)
- A318 siblings: 11 other dashboard tables use the same clipping wrapper (listed on A318). None reported.
- A320 siblings: branch PUT and staff PATCH can store a spaces-only name (listed on A320).
- A321 point 4: `branch_prices` has no `updated_at` trigger — only matters if prices are edited per branch.
- A314: a with-logo `.bin` in the drift set needs `GS v 0` in the `bytes.ts` decoder; delete the unreferenced 2026-08-05
  captures `shared/printing/BYTE-CHECK.txt` / `VERIFICATION.txt` (outside a deploy window, rule 13).
- A139 (per-branch receipt text) still owes its target check — relevant to Phase 2's receipt footer.

## Carried from this morning's handoff (unchanged)
A237 node-bridge deletion + `apps/print-server/README.md` rewrite (owner to name a quiet hour, rule 13) · RUNBOOK §0: point
at WORKING-METHOD §7 for the release sequence · rule 21 sweep + `check-vocabulary` gate · stale-doc banners
(TEST_TOOLING/TEST_PLAN, README `/kds`, BRANCH_AUTHORITY status). Owed on target: A306 banner, A277 CTL line, A276 repro,
A19 relay pilot, A159 flag flip.

## What made today work (details in WORKING-METHOD.md)
- Every delivery rehearsed on a fresh clone of the tip — apply, checksums, gates, rollback — before hand-over.
- Three blocks every time: apply (extract into the repo) · `md5sum -c` · one `&&` chain for checks, commit, push.
- "Landed" confirmed independently after every push: fresh clone, md5 of every file, gates, CI read from the Actions page
  for that commit (the REST API is rate-limited from the bench), new CI steps checked in the job.
- Bugs reproduced on the tip before fixing, by running the real code; every committed test mutation-checked; three blind
  first drafts caught that way and fixed.
- When something went wrong (partial extract, Windows builder, stale bench tree), it was stated plainly with the evidence,
  and fixed in the next letter.

## Verify after
```bash
git fetch && git reset --hard origin/dev
node scripts/check-register-consistency.mjs && node scripts/check-doc-refs.mjs && node scripts/check-root-clean.mjs
```
