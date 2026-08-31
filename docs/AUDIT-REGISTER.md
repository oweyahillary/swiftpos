# SwiftPOS — Audit Register

**Living document.** The single tracker for audit findings: what is open, what is
closed, and what was checked and found correct. Update in place; do not fork.

| | |
|---|---|
| Opened | 2026-08-07 |
| Last updated | **2026-08-29 — REGISTER RECONCILED (docs-only, no code): A183 repo-debt CLOSED — reconstructed the proving test `tests/order-number-per-device.test.mjs` (6/6 real SQLite, mutation-checked) and its `-p` delivery manifest `docs/MANIFEST-2026-08-27-p.md`; `check-doc-refs` + `check-test-registration` green, the durable fix is now provable in-repo. Trued up the stale Tree line to the tree: desktop v0.5.35→**v0.5.38**, migrations →90→**→94** (93 & 94 live in prod), last pushed `d70fa0e`→`0000804`, post-A111→post-A184. No finding opened or closed by this edit; `check-register-consistency` green. · 2026-08-28 — VERIFIED ON A REAL WINDOWS TILL (SwiftPOS v0.5.38 · win32): the four live P0s are CLOSED — A181/A183 (online loop `T001--1` on the cloud DSR + offline sales drained to 0 on reconnect, no collision, migration 94 live), A167 (offline PIN sign-in, no NULL-token crash), A152 (offline auth fell through on a real Render 503 and still rejected a wrong PIN), A177 (queue drains on reconnect). A17 stays OPEN (a build task, not verifiable this session). Open P0 5→1, P1 20→19. Outstanding non-blocking: A183 in-repo test + its `-p` delivery manifest still missing (rule-14 debt); A181 historical `T2--%` recovery query un-run. SECURITY still open: rotate `DATABASE_URL` + the exposed GitHub PAT. · 2026-08-27 — A167 FIX BUILT (bench, OPEN P0 pending real-till test): offline PIN sign-in threw `NOT NULL constraint failed: staff_session.token` at its LAST step — `signInLocal` inserted `token=NULL` into a `token TEXT NOT NULL` column, so every offline/5xx fallback (A17/A152/A160) died on the write it routes to. Fix: write `''` not NULL (the reader already coerces it — `tokenStore.read: unwrap(token_enc) || token || ''` — and `configureStaffSession('','')` already means empty in memory); no migration (rule 13). Reproduced against the real schema, then greened; NEW `tests/offline-signin-write.test.mjs` runs the real INSERT (mutation-checked: NULL → red naming the column). Gap that hid it: `offline-auth-fallback.test.mjs` models the ROUTING only, never the write (rules 8, 24). · A168 FIX BUILT (bench, P2): order-push 401 refreshed `refreshStaffToken()` unconditionally, so an OFFLINE order (owner-token push) had nothing to refresh and sat pending. Now refreshes the token the push actually sends via new pure `selectPushRefresh` in authTransport.ts; NOT the price path's staff||owner fallthrough, which would reattribute a staff order. New real-function test. · A169 OPENED (P1, NOT fixed): offline sales attribute to the OWNER because the server sets `cashier_id = req.userId` and an offline shift pushes under the owner token — blocker named (needs A164 desktop cutover or a signed roster claim). Delivery: MANIFEST-2026-08-27-b.md (supersedes -a). · A170 CLOSED (gate, rule 6): new `check-notnull-writes.mjs` flags a literal NULL written into a NOT NULL local column — the A167 class. Sweep found A167 was the only instance; self-tested 6/6 + mutation-checked on the real file (`ipcHandlers.ts:415`), wired into CI + auto-discovered by run-all, green on the tree. Delivery: MANIFEST-2026-08-27-d.md. · A171/A172/A173 CLOSED (docs + hygiene gate, unattended-safe): A171 formalised rule 24 into §0 (it was cited by ID with no home); A172 added `check-root-clean.mjs` enforcing rule 19 (no stray docs/zips/patches in root, self-test 9/9, green, CI-wired); A173 removed the byte-identical dup `docs/MANIFEST-2026-08-20-a (1).md`. Delivery: MANIFEST-2026-08-27-e.md. · A169 FIX BUILT (bench, Option A — owner-approved): offline sales now credit the real cashier. Till sends the cashier in the SHARED cloud-order payload (peer push + node relay identical); server trusts it only under an owner/device token and only when it validates like verify-pin (active, in-business, branch access) — staff-PIN tokens stay authoritative. Pure `pickCashier` unit-tested 11/11 + payload 5/5; server+desktop tsc clean. STILL OPEN P1 pending live server + real-till verification. Desktop change → version bump due at build (rule 15). Delivery: MANIFEST-2026-08-27-f.md. · A174 CLOSED (fixes A172's own false positive): check-root-clean now respects `.gitignore` via `git check-ignore`, so it stops flagging gitignored `.patch`/`.zip` leftovers (rule 23 — a crying-wolf gate) while still catching a real committable stray. CI was already green (clean checkout has no ignored files). Delivery: MANIFEST-2026-08-27-g.md. · A175/A176 CLOSED (revived two rotted desktop suites): `test:pin` (8→17/0, was throwing "no such table: device_config" because A17 added a `getDeviceConfig` dependency the shim lacked — plus new A17 no-expiry coverage) and `test:sync` (18/11→29/0, was throwing before the cloud pull because A24 added `fetchReferenceFromNode` the shim lacked). Both stale-shim, test-only, no app code — rotted because desktop tests don't run in CI. Delivery: MANIFEST-2026-08-27-h.md. · A177 OPENED + FIX BUILT (P0, bench — root cause of the field "6 pending / 0 failed / Force sync does nothing"): sync fetches had NO timeout and `_isSyncing` clears only in `finally`, so one hung connection (black-holed socket / cold-start stall) wedged `_isSyncing=true` forever and every later sync incl. Force sync returned "Sync already in progress" — queue never drained, orders invisible (0 failed). Reproduced end-to-end in a sandbox on the real compiled engine (hang → wedge; fast-fail → correctly escalates to failed). Fix: `syncFetch()` AbortController timeout on all 15 calls + `_syncStartedAt` stale-guard + break-the-batch-on-timeout + push failures now hit the durable log. New `sync-timeout.test.mjs` 5/5 in the desktop chain; regressions sync 29/0 pin 17/0 peerrelay 28/0. Server verified healthy from the sandbox (POST /api/orders 401 in 0.2–0.6s, no cold-start). STILL OPEN pending real-till confirmation the queue drains. Desktop change → version bump + tag after build (rule 15). Delivery: MANIFEST-2026-08-27-i.md. Next free ID A178.** · A178 CLOSED (sync visibility + decouple, from reading the field till's DB — all orders were synced; the "6 pending" were shift/day/float/expense records the push code logged NOTHING about): `runPushStages()` decouples the five push stages so a throw in one (e.g. a shift-push SELECT on a missing column) no longer skips the order push; shift/price push failures + successes now hit the durable log; `getSyncStatus` gains a per-table `pendingBreakdown`; and the Technician menu gains a real **Test connection** (reaches the server, not just `net.isOnline()`) + **View log** (reads `swiftpos.log` on-device) + the pending breakdown. New `sync-decouple.test.mjs` 6/6; regressions green; main+renderer tsc clean. TechPage UI target-only (rule 16). Desktop change → version bump + tag after build (rule 15). Delivery: MANIFEST-2026-08-27-j.md. · A179 FIX BUILT + SELF-HEAL (P1 — the actual cause of the field "6 pending that never move," found from the log once A178 made the shift push visible): till-created expenses got a non-UUID id (`exp_<ts>_<rand>`) that 500s the cloud uuid column (22P02) and, batched with shifts/days/floats, blocks the whole cash push. Generator → `uuid()`; startup self-heal regenerates stuck non-UUID pending expense ids (safe — never synced, nothing references expenses.id; idempotent), so a stuck till unblocks on next start. `expense-id-repair.test.mjs` 5/5, verified against the real till DB. Follow-up: server should reject bad rows individually so one row can't strand the batch. Delivery: MANIFEST-2026-08-27-k.md. Next free ID A180.** · A180 CLOSED (server robustness — the general form of A179): `/api/sync/push` batched the expenses upsert and 500'd the WHOLE push on one bad row, so a single malformed expense stranded every shift/day/float behind it. Expenses now isolate per-row like floats/shifts/days — a non-UUID id is rejected with `invalid_id` (client parks it as conflict) and the rest land. Pure `partitionByValidId` guard 8/8 + mutation-checked; server tsc clean. Server-only, no desktop bump. Delivery: MANIFEST-2026-08-27-l.md. · A181 OPENED + PART-1 FIX (P0 — the ORIGINAL "synced on the till, absent from the cloud", root-caused from the cloud data): order numbers are `terminal_code--localSeq`, the cloud is UNIQUE(business,branch,order_number), so a reinstalled/second till reusing `T1` over an earlier till’s numbers gets 409’d — and the client wrongly marked 409 as `synced`, silently losing every colliding sale (cloud holds T1--1..T1--25 from the old till; the new till’s 26/27 Aug orders all collided and are absent, ~KES 12,510). Part 1 built: 409 now surfaces as `failed`+logged, never synced (`order-409-not-synced.test.mjs` 5/5). Mitigation: give each till a distinct terminal code. OPEN pending owner decision on robust uniqueness + recovery of the lost orders. Delivery: MANIFEST-2026-08-27-m.md. · A182 OPENED + BUILT (P2, overnight request — attacks the ROOT of A181): a reinstalled till gets a new device_id and is re-named "T1" by hand, colliding. Now the desktop reads a stable MAC (`machineFingerprint.ts`, deterministic; 8/8) and sends it; the cloud binds it (migration 93) and on re-enrol returns the machine’s previous terminal code/name (`findPriorTerminalByMac`/`pickPriorTerminal`, 7/7) which the till adopts — so a reinstall keeps its identity. Plus `docs/RESTORE-GUIDE.md` for session restore (2nd ask). server+desktop tsc clean; enrol-UI pre-fill + real-hardware MAC = target-only. Delivery: MANIFEST-2026-08-27-o.md. · A183 OPENED + BUILT (P1 — the DURABLE fix for A181): the cloud enforced order_number unique per (business,branch), but a number is a per-till value, so two tills/one reinstall colliding lost sales. Migration 94 makes it unique per (business,branch,COALESCE(device_id,''),order_number) — device_id is already on every till order, so identical numbers coexist by device; genuine re-push still dedupes by idempotency_key; NULL-device web/legacy orders stay branch-unique. No code change. `order-number-per-device.test.mjs` 6/6 on real SQLite. Target-only: applying the DDL on prod (safe/strictly-more-permissive; run in a txn, confirm row count). Delivery: MANIFEST-2026-08-27-p.md. · A184 OPENED (P2, end-of-saga UI request): the cloud Terminals/fleet screen shows every till as "SwiftPOS till" with no device name, terminal code, MAC, active cashier/shift, or role — indistinguishable rows, and the "not syncing" banner counts decommissioned ghosts. Needs identity columns + a retire/merge action; MAC populates once the A182 build has checked in. Delivery: TBD. Next free ID A185.** — 2026-08-24 (batch -i) — A160 Phase-b FIX BUILT: the branch node now BROKERS a session refresh for an offline peer. New POST /node/refresh (X-Node-Secret auth) proxies the peer's refresh token to the cloud; syncEngine falls back to the node when the cloud is unreachable/5xx (A152 pattern), never on a 401. Refresh token is the device credential — no new secret, no migration. New node-token-refresh.test.mjs (9, mutation-checked). OPEN P1 pending two-till verification. Delivery: MANIFEST-2026-08-24-i.md.** — 2026-08-24 (batch -h) — A159 DRY-RUN SHIPPED: terminal write guard in requireAuth denies a desktop-surface token from writing dashboard data (products/prices/users/settings) — closes the stolen-token gap left by A158's credential removal. Default-deny by surface + a 5-entry till allowlist. Log-only until TERMINAL_WRITE_ENFORCE=true, so it can't break sync. New terminal-write-guard.test.mjs (19, mutation-checked). OPEN P2 pending enforce-flip. Delivery: MANIFEST-2026-08-24-h.md.** — 2026-08-24 (batch -g) — A158 FIX BUILT (bench): owner email/password login on a till RETIRED at every layer (App.tsx enrol-state + EnrolPage, auth:login IPC/preload/posApi removed, /desktop-login tombstoned 410); enrolment code is the sole activation; sign-out clears staff only (device stays enrolled); web /login untouched. New terminal-activation.test.mjs (mutation-checked) + auth-surface repointed. OPEN P1 pending amber-build verification (rule 16); rollout = tills-first before the server tombstone. Delivery: MANIFEST-2026-08-24-g.md.** — 2026-08-24 (batch -f) — A157 reconciliation map (docs-only, no code per rule 18): confirmed at PAYLOAD level that force-wiring the four validation schemas would 400 currently-valid production requests — product create sends `description:null` + `image_url:''` which the schema rejects, and 13 handler fields would be stripped; `/login` also reads `device_id` (stripped → device binding breaks). NOT wired (the "nothing broken" instruction). Per-schema safe-wiring recipe recorded; lowest-risk first step = category POST with `.passthrough()` after a DB-column length check. Stays OPEN P2 (per-route reconciliation + target test to close). Delivery: MANIFEST-2026-08-24-f.md.** — 2026-08-24 (batch -e) — A20 + A24 source passes (docs-only, no code per rule 18): confirmed at source that the node replicates only the six sales tables (`REPLICATED_TABLES`, origin-device/seq fan-out) and serves NO reference data downstream (`nodeClient` pulls `/node/since` only) — so a promoted peer has no roster (A20) and an offline peer's catalogue/prices/staff/settings go stale (A24). Key finding: the filed "extend `collectDistribution`" one-liner is wrong at source — reference data is cloud-authoritative/mutable/no-seq and needs a distinct node-authoritative SNAPSHOT channel; A20 is a special case of it. Concrete change maps + the `business_settings.branch_id` / dual-exclusion sub-bugs recorded in each entry. Both stay OPEN P1 (target-only to build). Delivery: MANIFEST-2026-08-24-e.md.** — 2026-08-24 (batch -d) — A152 FIX BUILT (bench, still OPEN P0 pending real-till test): offline PIN sign-in now falls through to node/cache when the cloud is DOWN-but-answering (5xx), not only on a thrown error; node leg widened 503→all-5xx; owner login gives a clear cloud-outage message instead of "Login failed"/crash. New `apps/desktop/src/main/authTransport.ts` + mutation-checked `tests/offline-auth-fallback.test.mjs` (20 assertions). Desktop version bump due at build (rule 15). Delivery: MANIFEST-2026-08-24-d.md.** — 2026-08-24 (batch -c) — A156 CLOSED (retired 12 orphaned helper value-exports across dashboard/desktop/server; 2 doc-coupled ones — `getLocalSchemaVersion`, `isTerminalCodeTaken` — excluded and flagged; deletions-only, full suite 40/0) · A157 opened (P2, input-validation schemas written but unwired — NOT auto-wired because the strip-on-parse middleware would drop live fields incl. login `device_id`; safe path needs per-route reconciliation + live test). Delivery: MANIFEST-2026-08-24-c.md. Next free ID A158.** — 2026-08-24 (batch -b) — A155 CLOSED (greened `check-doc-refs` — reworded `HANDOFF-2026-08-23`'s two dangling references to the outputs-only live-test checklist; branch-tip gate suite now fully green) · A153 follow-up done (pruned the two orphaned `computeUnitPrice`/`computeLineTotal` exports from dashboard `lib/cart.ts`; desktop copy live, untouched). Delivery: MANIFEST-2026-08-24-b.md. Next free ID A156.** — 2026-08-24 (batch -a) — A153 CLOSED (retired four superseded/orphaned dashboard-POS prototypes — `OrderHistoryTab`, `VoidModal`, `BranchSelectScreen`, dashboard `VariantModal`; deletions-only, bench tsc+build+gates green, rule 9) · A154 opened (P3, build the admin DB-migrations panel — `MigrationsPage.tsx` front-end exists, `GET /api/admin/migrations` backend never built; kept-and-to-build per owner). Delivery: MANIFEST-2026-08-24-a.md. Next free ID A155.** — 2026-08-23 — A140-A148 opened (dashboard/admin, docs-only, no zip per rule 18).** A140/A141/A142 = feature gaps in the products area: product bulk CSV import exists but is reachable only for `minimart` (A140, one wire), no bulk ingredient import incl. opening stock (A141), no bulk product-image upload (A142). A143-A148 = an "endpoints live, UI unwired" sweep — a static cross-reference of all 309 server endpoints against every `/api/` caller in dashboard/admin/desktop (matcher fixed for query strings, the admin `fetch` wrapper, and `` `${BASE}/api/…` `` calls); 39 endpoints have no client caller, of which the genuine dashboard/admin gaps are grouped as A143 (report exports 1-of-7 + inventory report), A144 (inventory/stock write-actions), A145 (branch↔user assignment), A146 (notifications/webhook observability), A147 (admin-portal endpoints), A148 (misc: modifier-create, flags, qr settings, loyalty settings read). External/till/node/tech callers and the retired `/api/enrol/code` (410) excluded; three ambiguous endpoints held for a per-page check, not entered. All static/bench (rule 9); none browser-confirmed (rule 16). `check-register-consistency` re-run green. **A149 opened (2026-08-23, docs-only): `apps/admin` has no CI type-check or build — the ratchet is invoked `server dashboard` (admin dropped) and `typecheck-baseline.json` has no admin key, so 68 `tsc` errors accrued unseen; found during A147.** **A150 closed (2026-08-23): `apps/server/.env.example` refreshed from source — retired `TECH_HMAC_SECRET` removed, production-required + at-rest + M-Pesa/eTIMS/mail vars added; render.yaml stays the deploy source of truth.** **A145 re-scoped + raised P2→P1 (2026-08-23): not a UI gap — branch↔user assignment is already wired via the staff flow; the standalone `/branches/:id/assign-user` + `/remove-user` routes are a redundant AND under-guarded writer (requireAuth only, no `staff.manage`, no business scoping → within-tenant privilege escalation + cross-tenant write). Recommend retiring both; retirement patch held for owner go-ahead.** **A151 opened (2026-08-23, P1): restaurant Split Bill (by-guest) under-collects — the pay loop never advances past guest 1 (`splitPayingGuest` never incremented; `onSuccess` frees the table without looping), and there is no even-split mode. Money-critical; not fixed on the bench. Surfaced while evaluating A8.** **Next free ID A152.** — 2026-08-22 — register trueing-up (code↔register audit, bench/static, rule 9). **A68, A71, A72 CLOSED** — verified present and wired on dev: A68 `appFlavor.ts` called from both web apps' `main.tsx`; A71/A72 `DevicesTab.tsx` renders branch/role/last-active/version + rename + stale badge. **A69, A70, D18 confirmed code-complete on dev but kept OPEN** pending a browser pass (rule 16). Notes for the next reader: A73 records its nav link as *restored* (not re-confirmed on bench); A12 shows *FIX APPLIED pending live check*. No code changed — docs-only, no zip (rule 18). Still outstanding at the process level: no handoff covers A112→A139, `schema-index.json` is stale (missing `branch_settings`), and two migration files share number 90. — 2026-08-20 — A133 opened (owner dashboard Settings consolidated into a three-section Settings group — Users and access / Devices and printers / Business, each a tabbed page; Table Turnover→Finance, KDS→top level, Payment methods→Business; 6 new files + `App.tsx`/`DashboardLayout.tsx`, back-compat redirects for old deep links; dashboard `tsc` AND `npm run build` both green on-bench; manager parity = Slice 2, specified in MANIFEST-2026-08-20-a but not built; browser confirm + owner sign-off pending; nothing merged) · A134 opened (Business › Profile tab deferred — the one genuinely new page, needs its field list before build). · A135 opened (browser review of A133: KDS board renders blank + adding a table fails — two pre-existing runtime bugs A133 only made reachable/visible, need a live node+DB to diagnose; nav-highlight + KDS array-guard fixes shipped under A133 follow-up). A136 opened (server queries columns absent from schema — stock_movements.business_id, users.pin; + new gates check-api-routes.mjs & check-api-schema-drift.mjs wired into CI with self-tests). A137 closed (bulk-create tables "Add multiple" — typed count, T-numbered, empty-state + header; auto-seed-20 declined by design). A138 closed (catch-less mutation sweep — Parking/Minimart/Petrol settings now surface save/delete errors like Restaurant; 0 swallowers remain). A134 closed (Business Profile tab — Slice 1: owner-editable identity via PATCH /api/business + business-wide receipt header/footer + 24h; currency locked after sales) · A139 opened (per-branch franchise receipt/hours override — cross-stack incl. desktop till, PROD-MIGRATE). **Next free ID A140.** — 2026-08-19 — A129 opened (delivery sales silently never sync — cloud `orders.order_type` dropped `delivery` in migration 58 while the feature stayed live and Zod-accepted; A128's twin; fix = migration 90 re-admits `delivery` + new gate `check-push-domain-parity` wired into CI; PGlite-verified 9/9, mutation-checked; **NEEDS PROD-MIGRATE 86→90**) · A130 opened (Aggregators report queries `order_type='aggregator'` which no path writes — a dead report; a wiring decision, not a widen) · A125/A126/A127 body+changelog rows added (rule-14 catch-up: admin purge Stage-2 preview, Phase-3 glass refresh, admin Branches tab — all shipped in git without an entry) · A131 closed (delivery orders now deduct packaging, uniform with takeaway — one-condition fix in `stockEffects.ts` + test source-pin; no prod-migrate, ships with the server) · A132 closed (dashboard nav UI: accordion + desktop SVG icons; menu labels left unchanged per owner review — presentation only, no logic). **Next free ID A133.** — 2026-08-18 — A128 closed (custom-method & room_charge sales silently never synced — cloud `payments.method` was value-checked to cash/mpesa/card/credit/glovo and varchar(20); migration 89 widens to varchar(40) + swaps to a format check; A95 free-text design honoured). (A125/A126/A127 rows now added — see the 2026-08-19 entry above.) — 2026-08-17 — A119 closed (admin portal: edit business + change owner email) · A118 closed (revoke till + rotate code + health chart) · A117 opened (admin-portal plan + glass mockup) · A116 opened (digital-signage design proposal — TVs/displays; doc-only, not scheduled; `docs/SIGNAGE-DESIGN.md`) · A115 closed (health monitoring + direct Supabase keep-alive) · A114 closed (tech reveal code: stable-per-branch, auto-provisioned, self-healing) · A113 closed (tech-access: retire v1 HMAC tokens + default secret) · A112 closed (register header reconciled to the tree) · A111 opened (standardise on Node 24 LTS) · A110 closed (recharts v2 deprecation resolved repo-wide) · A109 closed (green CI: node:sqlite offline test fixture) · A108 opened (Node 20→22 runtime + npm vulnerability sweep to 0 across all five apps; desktop Electron 35→43, BLOCKED on the two-till build per rule 9). NOTE: the header Tree line (0215475 / v0.5.27) and the Open/Counts lines still predate A99–A108 — reconcile on next reading. — 2026-08-14 — A12 FIX APPLIED (recipes.ts now reads live per-branch stock via branchScope, mirroring stock.ts — Recipes drawer no longer shows stale "0"; open pending live check). D18 opened (tech token pasted into the reveal field was truncated by maxLength/upper-casing — onPaste now routes a `st2.` token straight to the token step) — A73 opened (fleet-health "Terminals" page was built+routed but unreachable — nav-drift between two Setup defs; link restored) — A72 opened (devices owner-nameable via PATCH /devices/:id/label, persists across registration; bundled "not synced >1d" badge) — A71 opened (owner Settings→Devices enriched: branch, role, absolute last-active, version, enrolled date; device rename left as a decision) — A69 extended (batch enrolment codes: one call mints N single-use branch-bound codes, admin prompts "how many tills?"; reusable branch code declined — unbounded blast radius) and A70 opened (enrolled-device roster in admin: `GET /clients/:id/devices` + Overview card). Test now 29 checks, batch guard mutation-checked. — A69 opened (enrolment issuance relocated to the admin portal, branch-bound + licence-gated + owner-resolved; owner `/api/enrol/code` retired to 410; desktop InstallPage locks the bound branch; billing reuses the existing branch-licence invoice; 25-check test rewritten + mutation-checked). Desktop = one-off per branch, unlimited tills, no trial; web = recurring, annually billed, with a 2-week trial (unchanged, confirmed). — A68 opened (deploy env badge: dashboard + admin favicon/title, env-driven per Vercel project) and D17 opened (desktop dev/prod build flavour: amber DEV icon + `electron-builder.config.js` + runtime cloud-host title). Both OPEN pending owner action (Vercel vars) and a Windows install check; see MANIFEST-2026-08-14-a.md. D3 gains a dev-channel note. — 2026-08-13 — session: D11 closed; A66 opened+closed (`LOCAL_SCHEMA_VERSION` 51→52); A67 closed. D4 implemented end-to-end (enrolment codes migration 81 + proven; issue/redeem endpoints; desktop InstallPage now Business ID + code) — OPEN pending one live test, closes D1 when it passes. D7 rollout advanced: shared IPC validator now on `escpos:setKitchenExclusions`, `auth:verifyPin`, `order:void`, `auth:enrolDevice` — ~132 channels remain, `order:create` deliberately not done blind; stays OPEN. D3 auto-update scaffold + runbook — stays OPEN. Windows render smoke-test still outstanding (A43).** |
| Tree | `dev`, post-A184 (last pushed `0000804`; this edit commits on top), desktop **v0.5.38**, `LOCAL_SCHEMA_VERSION` **52**, migrations **→ 94** (93 & 94 live in prod per the 2026-08-28 real-till verification; 90's A129 delivery still pending prod-migrate), web/cloud runtime **Node 24**, desktop **Electron 43** |
| Open | **A: 1 P0 · 19 P1 · 17 P2 · 6 P3 — D: 1 P0 · 2 P1 · 2 P2 · 3 P3** (re-derived from the body by `check-register-consistency`, not hand-counted) |
| Counts | A-P0: A17 · A-P1: A187 A179 A151 A54 A18 A19 A20 A50 A24 A3 A12 A129 A145 A158 A160 A161 A162 A163 A164 · A-P2: A186 A185 A184 A182 A168 A22 A23 A53 A69 A133 A141 A143 A144 A146 A147 A159 A157 · A-P3: A13 A70 A139 A148 A149 A154 — D-P0: D1 · D-P1: D3 D4 · D-P2: D7 D18 · D-P3: D9 D10 D17 |
| Reconciliation 2026-08-17 (A99–A111) | The **Open** and **Counts** rows derive from the §A/§D open-item sections (A1–A73 + D-items) and remain accurate: **A74–A111 are recorded in the Changelog and were near-all closures**, so they add no open items. The current authoritative open list is `HANDOFF-2026-08-17.md` §7. Specifics: the open **P0 A17** (offline-auth day-15 lockout) is now carried by its built-but-**hardware-pending** fix **A99–A101** (two-till sign-off per PHASE5 §8) — so the P0 is a *fix awaiting verification*, not an unstarted finding; **A19/A20/A24** stay P1, blocked on that sign-off. **A108/A110/A111** moved the web/cloud runtime Node 20→22→24 and brought all five apps to **0 npm vulnerabilities** (shipped, CI green); the **desktop Electron 35→43** upgrade is merged but pending the same two-till build before any prod till. |
| Header correction | The previous header said **0 P0** while §A listed **A17 as `P0 · OPEN`** — the day-15 lockout, hidden by its own count. Re-derived by reading §A: A17 is the one open P0 (A1 struck). |
| Closed 08-10 (late) | **A5 · A6 · A9(triage) · A47 · A48 · A50 · A51 · A52 · D6.** A43 deletion ATTEMPTED AND REVERTED — it drops the only guard on a live field bug; see the entry. Corrected: A1 split, A7 re-characterised, A9 closed as never-true, A10 reopened, A12 raised to P1, A39 down to one document. Opened: **A49 · A53**. |

**Counts above were re-derived by reading this file, not carried forward.** The
previous header said 5 P2 where section A listed 3, and said `415e044 + this
session's work` for work committed at `a80c224`. A header that disagrees with its
own body is the same failure the register exists to catch.

**Every correction on 2026-08-10 (late) was verified by running or reading the
tree, never by reading this file.** Where the two disagreed, the tree won and the
entry says what was measured.

**Header corrections, 08-08.** The previous header said `415e044 + this session's
work`; the work is committed at `a80c224` (59 files, not 58). It said the counts
were 5 P2 where section A lists 3. **C6, E1-E4, F, G1-G2 and H1-H2 appear in the
changelog as opened and have no entry anywhere in this file** — lost in the 08-08
restructure. They are neither open nor closed; they are missing. Recover from
`git show 415e044:docs/AUDIT-REGISTER.md` before the next session re-audits them.

`HANDOFF-2026-08-08.md` stated desktop v0.5.24 while `apps/desktop/package.json`
said 0.5.23. Bumped to 0.5.24 — then `release:patch` bumped again during the
build, so **the shipped artifact is `SwiftPOS-0.5.25-x64.exe` and the tag is
`v0.5.25`**. `v0.5.24` was deleted: no installer exists for it, and a tag
pointing at a version you cannot produce is worse than no tag.

**Rule learned: the tag follows the build, never precedes it.** `release:patch`
runs `npm version patch`, so the version is decided BY the build. With no
auto-update the tag is the only record of which source produced the `.exe` on a
given till.

**Working rules** live in `HANDOFF-2026-08-08-evening.md` §0 — standing, not
per-session. Rule 14 is the one this file depends on: nothing ships without an ID
and an entry here, in the same change as the code.

**Rules 21-23 added 2026-08-10.** 21 (owner): say **node** or **cloud**, never
"server" on its own. 22: a delivery zip carries the change, never the version —
a zip overwrote a version bump and produced two different binaries with the same
number. 23: mutation-check the GATE, not only the fix — both gates written that
day failed their own first version, one silently. Two machines answer to that word and it has already cost an
afternoon. `getServerUrl()` returns the CLOUD url and should be renamed.

**Rules 17-20 added 2026-08-09** (owner): assume it is already built halfway and
sweep before designing; zip only when code changed; nothing but `README.md` in
the repo root; be sure before proceeding, and never loosen a gate to accommodate
your own change. Rule numbers are stable and never reused — 17-20 append rather
than slot in, because 9, 10, 14 and 15 are cited by ID throughout this file.

**How to use this.** IDs are stable and never reused. Closed items keep their
entry — half the value of this file is stopping the next session re-auditing
ground already covered. New findings append with the next free number.

**Method.** Every item verified by reading or running source, not by reading docs.

**Severity.** **P0** money/data loss or a false-confidence trap · **P1** wrong
numbers or silent divergence · **P2** correctness residue · **P3** hygiene.

---

## Status at close of session

```
server tsc  OK   dashboard  OK   desktop main  OK   desktop renderer  OK

check-schema-drift    OK   check-ipc-parity      OK   (126/126)
check-supabase-catch  OK   check-shared-sync     OK
check-rls-coverage    OK   check-table-usage     OK   ← new, proves B6
check-sql-binds       OK   check-client-parity   OK   ← new, proves B5
check-own-rows        OK   check-row-attribution OK

offline suites        17/17
print resilience      51/51
printing package      spooler 18 + tickets 30, all passing
sample output         byte-identical to SAMPLE-OUTPUT.txt
```

58 files changed across the session.

---

## TOMORROW — before shipping

Agreed plan, in order:

1. **Run a full service on 0.5.25** with thermal on. Nothing below matters more
   than one real trading period.
2. **Final code review** — business logic, error reporting, UI logic.
3. **Remove HTML printing.** Only after 1 and 2. See P-06 for exactly what goes.
4. **Then** the register's remaining P0/P1 items.

---
## A. OPEN — carried into tomorrow

### A187 · P1 · OPEN · Owner dashboard has no reachable Order History / void — a completed order can't be reversed from the owner surface

**Surfaced by the 2026-08-31 browser test (A151 run).** The void machinery exists:
`POST /api/orders/:id/void` (+ `/refund`) in `apps/server/src/routes/orders.ts`,
with `voided_by` / `authorized_by` / `status='voided'`; and `POSOrderHistoryTab.tsx`
is built and wired into the **Manager dashboard** (`ManagerDashboard.tsx`) and the
**POS drawer** (`POSDrawer.tsx`). But it is **not surfaced on the OWNER dashboard**,
and the POS-drawer tab was hidden for the **cashier** role — so in the test neither
the cashier (Bill) nor the owner could find any Order History / void page. Settings →
Roles shows the Owner role has "View all orders" + "Void orders" enabled, yet no
owner-surface page consumes them (the permission exists; the UI to use it does not).

**Real consequence.** A completed test order — `ORD-MTH76LLB-001WV` (KES 790, Main
Branch, Bill's 15:10 shift) — is stranded: reversible only via a manager POS session
or the drawer, not from the owner dashboard. It also blocks the A151 cleanup (the
by-item sub-test was skipped to avoid stacking a second un-voidable order).

**Fix.** Surface Order History on the owner dashboard — reuse `POSOrderHistoryTab`
or an orders list with a Void action — honouring the existing "View all orders" /
"Void orders" permissions. P1: operational + money (a mis-rung order can't be
reversed from the owner's own screen). **Immediate ops action (no code):** void
`ORD-MTH76LLB-001WV` via a manager POS session and close Bill's open shift.
**PHASE 1 DELIVERED 2026-08-31 (view — dev; OPEN pending browser + Phase 2).** New
owner page `apps/dashboard/src/pages/OrdersPage.tsx`: read-only, paginated /
searchable / status-filtered order list via `GET /api/orders` (already owner-scoped
by `branchScope`, so no server change), gated on `orders.view_all`; routed at
`/dashboard/orders`, nav under Finance. `vite build` exit 0. Browser-confirm: an
owner sees all orders incl. `ORD-MTH76LLB-001WV`. **Phase 2 — the Void action
(`orders.void` + supervisor/authorizer PIN + shift/tax handling) — is NOT built**;
it needs a design decision on the owner-void auth flow. Phase 1 gives visibility,
not reversal: the stranded order still needs the manager POS void today.
**PHASE 2a DELIVERED 2026-08-31 (server — dev; additive, cashier path unchanged).**
`POST /orders/:id/void` and `/refund` now let an owner (`req.isOwner`) self-authorise:
no supervisor PIN, but the audit trail is preserved — `voided_by`/`refunded_by =
req.userId`, a required reason, and `authorized_by`/`refund_authorized_by` = the same
owner. Non-owner (cashier/till) still requires the override PIN, unchanged. Void stays
inside the 30-min window; past that it's a refund (agreed — the window subsumes "no
void after shift close"). New guard test `tests/owner-void-refund.test.mjs` (6/6,
mutation-checked: breaking the bypass fails it). Server `tsc` exit 0;
check-test-registration / check-api-routes green. **Correction to the ops note above:**
`ORD-MTH76LLB-001WV` is now past the 30-min void window, so in-app it can only be
REFUNDED (leaves a sale+refund trail) or removed by a backend void — a plain in-app
void now 403s for anyone. **Phase 2b (client — Void/Refund buttons + reason modal on
the Orders page) is next.**
**Next free ID A188.**

### A186 · P2 · OPEN · run-all migration suite reports a false FAIL on Windows — libuv teardown crash after the assertions pass

**Symptom.** On the owner's Windows dev box, `node scripts/run-all.mjs` ends
`== 1 FAILED ==` with the migration suite the only red:
`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94`
— printed AFTER the migration assertions themselves report `all green` (41+42 apply
despite duplicates, newest open shift survives, older duplicates demoted, etc.).
Reported as "3 of 20 migration test file(s) failed."

**Evidence it is a teardown flake, not a logic failure (rule 7).** The SAME suite on
Linux (Node 24, PGlite installed) — `node scripts/run-migration-tests.mjs` — prints
`All 20 migration test file(s) passed`, exit 0, no crash (41-42: 29 passed, 73-74:
17 passed, 92: 9 passed, all others green). The assertions pass on both platforms;
only Windows crashes, and only during process teardown of the PGlite/libuv native
layer — `src\win\async.c` is libuv's Windows async-handle close path. No migration
is broken.

**Why P2, not cosmetic.** It flips the ENTIRE gate suite to FAILED on the owner's
primary environment. Every green from now on needs a manual "ignore that one" —
which is precisely the false-red-hides-a-real-red failure that
`check-register-consistency` was written to prevent (A60). The suite's pass/fail
signal is degraded on Windows until this is quieted.

**Not from A185.** A185 touched only `CashierScreen.tsx` (dashboard CSS values) plus
two docs; it does not reach migrations, PGlite, or any native module. First observed
in the A185 push run (2026-08-31); it pre-dates the change.

**Candidate fixes (not built — needs a decision + a proving mutation per rule 23):**
(a) have `run-migration-tests.mjs` gather results then `process.exit(code)`
explicitly, so Node exits before libuv asserts on the open handle; (b) close the
PGlite instance and await a tick before exit in each harness; (c) pin/upgrade
`@electric-sql/pglite` if a newer build fixes the Windows close path. Whichever is
chosen, the proving check must still show the suite go RED on a real migration
regression — a "fix" that swallows the crash by also swallowing failures is worse
than the crash. **Next free ID A187.**

### A185 · P2 · OPEN · Cloud POS restyled to the desktop till (theme + layout) — restaurant cashier first

**Owner request (2026-08-31):** make the cloud/web POS "look like the one on the
desktop." Scope confirmed with the owner: theme + layout, restaurant cashier first.

**What existed (rule 17).** The web POS (`apps/dashboard/src/pages/pos/CashierScreen.tsx`,
2,621 lines, all business modes in one component) and the desktop till POS
(`apps/desktop/src/renderer/pages/POSPage.tsx`) are SEPARATE implementations — no
shared UI (`shared/` holds only `parkingTariff.ts` + the ESC/POS lib). The web POS
is already token-themed: `--pos-*` CSS vars defined inline in CashierScreen (light
+ dark blocks) plus a centralised `s` style map. Its dark theme was a SLATE palette
(`--pos-bg:#0f172a`, `--pos-panel:#1e293b`, `--pos-border:#334155`) with a BLUE
accent (`#3b82f6`); the desktop is a near-black GRAY palette (gray-950/900/800)
with a GREEN accent (`#22c55e`). Slate-vs-gray + blue-vs-green is the whole visible
difference; the three-region layout already matched.

**Change — one file, values only, no logic (rule 13: revert by restoring the file):**
`apps/dashboard/src/pages/pos/CashierScreen.tsx`
- Dark `--pos-*` block → desktop gray (bg #030712, panel/card/modal #111827,
  surface/input #1f2937, border #1f2937/#374151, text #fff/#e5e7eb/#9ca3af/#6b7280).
  Re-skins every token-styled element across all modes + modals at once.
- Header slate #1e293b/#334155 → gray #111827/#1f2937 (still always-dark by design).
- Blue→green accents: mode badge, parked-active, spinner, active-table pill, covers
  pill, active product card, cart badge, category-chip fallback, variant selection.
- Layout: cart panel 300→320px (desktop `w-80`); grid gap 10→12 / min 110→120px;
  product card centred-64px-thumbnail → left-aligned + full-width image (desktop shape).

**Verification (rule 7).** `npm run build` (vite) in `apps/dashboard` — exit 0,
"✓ built in 11.40s", `POSEntryPage` bundle (contains CashierScreen) emitted. Env:
Linux, Node 22 (repo targets Node 24; the dashboard's real target IS the
Linux/browser build, so this is on-target, not a weak Linux green). No `tsc` step
in the build script; the change is value-only inside a typed `React.CSSProperties`
map + a CSS template string.

**Target-only (rule 16).** VISUAL + interaction confirmation in a browser on the
restaurant POS — the point of the change can only be signed off by eye.

**Residual (rule 7 — left deliberately, to keep the diff contained; mop up in the
layout slice):** blue remains in the Table-Transfer modal (2066/2067/2115), the
parking bill box (2501, parking only), and the room-charge modal (2567/2583).
Minimart runs a SEPARATE component (`MinimartPOS.tsx`) that does not use these
tokens, so its inner grid is unchanged by A185.

**Design note for the owner:** the web POS keeps its own light/dark toggle
(`posTheme`, independent of the dashboard theme). A185 restyles DARK only; light
mode is untouched. If the till look should be the *only* look, the toggle can be
retired separately — a decision, not built here. **Next free ID A186.**

### A184 · P2 · OPEN · Terminals/fleet screen shows no identity — every till reads "SwiftPOS till", can't tell them apart or retire dead ones
**BROWSER 2026-08-31 (confirmed NOT-PRESENT — genuine build work, not stale).** All 3
tills display the identical "SwiftPOS till", distinguished only by an internal
device-id hash (e.g. `f77f63d7`), app/schema version, and last-sync / last-sign-in.
No human-assigned per-till name. Confirms this needs building. Agent report 2026-08-31.

The cloud Terminals screen (Settings → Devices and printers) lists every till as
"SwiftPOS till / Beryl Atieno" with only device_id, app version, schema, last sync
and last sign-in. With two or three tills at a branch — including reinstalled
duplicates and decommissioned ghosts — the rows are indistinguishable, and the
"N terminal not syncing" banner counts long-dead machines as if they were live.
Observed 2026-08-28: three rows for one physical shop — `f77f63d7` (v0.5.36, 73h,
the retired original), `4396d282` (v0.5.38, since deleted), `55e8dd9f` (v0.5.38,
current) — every reinstall minting a new device_id and a new indistinguishable row.

Make the fleet view show, per terminal:
- **Device name** (not the generic "SwiftPOS till") + **terminal code** (T1 / T001)
  — the human identity, so rows are tellable apart.
- **MAC address** — A182 now captures it (`user_devices.mac_address`); surface it
  here, because it is what reveals "these two rows are the same physical machine
  reinstalled".
- **Active session** — the cashier/manager currently signed in, and whether a shift
  is open.
- **Role** (till / node / office) and **branch**.
- A **retire / archive** action for a dead terminal (e.g. `f77f63d7` at 73h) so the
  "not syncing" banner reflects live tills only, not decommissioned ones — and,
  ideally, a **merge duplicates** affordance now that reinstalls create sibling rows.

Dependencies / notes:
- The **MAC column only populates once the A182 build is deployed** (server + the
  new desktop) and each till has checked in at least once — older/blind installs
  (e.g. the pre-A182 `4396d282`) will show a null MAC until they report. So this UI
  pairs with the A182 rollout, now done on Render/Vercel + the rebuilt desktop.
- Server data is mostly present already in `user_devices` (device_label,
  terminal_code, device_role, branch_id, last_seen_at, mac_address); the active
  cashier/shift is the one piece that may need the till to report it (or a join to
  the current shift/session on the cloud). Scope the "active session" field before
  building — it may be target-only until the till pushes session state.

Surfaced 2026-08-28 (requested at end of the A181/A182/A183 saga). Delivery: TBD.


### A183 · P1 · CLOSED 2026-08-28 · Per-device order-number uniqueness — the durable fix for A181 collisions (migration ready, needs prod apply)

**VERIFIED — CLOSED 2026-08-28 (real till v0.5.38 → cloud).** Offline-accrued orders synced clean on reconnect with NO order-number collision — migration 94's per-device unique index (`orders_biz_branch_device_ordernum_uidx`) is live in prod and behaving. Repo debt CLOSED 2026-08-29 (rule 14): the proving test `tests/order-number-per-device.test.mjs` (6/6 real SQLite, mutation-checked — the pre-94 branch-wide constraint reproduces the A181 collision) and its `-p` delivery manifest `docs/MANIFEST-2026-08-27-p.md` were reconstructed, so the durable fix is now provable in-repo (`check-doc-refs` + `check-test-registration` green).

A181's silent order loss started because the cloud enforced
`UNIQUE (business_id, branch_id, order_number)`, but an order number is a per-TILL
display value (`terminal_code--localSeq`). Two tills at a branch — a second
machine, or a reinstall re-named "T1" — mint the same numbers and the second's
orders were rejected (409). A182 stops the reinstall case (MAC restores the old
code); this removes the trap entirely.

Migration 94 replaces the branch-wide constraint with a per-device unique index
`(business_id, branch_id, COALESCE(device_id,''), order_number)`. `device_id` is
already on every till order (`buildCloudOrderPayload`), so two tills' identical
numbers now coexist by device instead of colliding; the server still dedupes a
genuine re-push by `idempotency_key`, and web/legacy NULL-device orders keep their
branch-wide uniqueness via COALESCE. Strictly MORE permissive, so existing data
(already unique under the stricter key) cannot violate the new index; nothing
references the dropped constraint by name and no query looks an order up by
(branch, order_number) expecting one row (both checked). No server or desktop code
change needed — the server's 23505 handler already returns 409 only for a true
same-bucket conflict.

Verified: `order-number-per-device.test.mjs` 6/6 against a real SQLite engine
mirroring the index (two tills may share a number; the same till may not; NULL-
device stays branch-unique). **Target-only (rule 16):** applying the DDL on the
live cloud — safe by the analysis above, but a `CREATE UNIQUE INDEX` on the real
`orders` table; run it in a transaction and confirm the row count is unchanged.
With this applied, distinct terminal codes become a human-clarity nicety, not the
only thing standing between the shop and lost sales. Surfaced + built 2026-08-27.
Delivery: MANIFEST-2026-08-27-p.md.

### A182 · P2 · OPEN · MAC-binding so a reinstalled till keeps its name/terminal code (the ROOT of A181's collisions) + session-restore guide

Requested overnight. A181's collisions start because a reset/reinstalled till gets
a brand-new `device_id`, shows up as a NEW device, and is re-named by hand —
usually "T1" again. Fix: bind a stable machine MAC so the cloud can recognise a
reinstall and hand back its previous terminal code + name.

**Built + bench-verified.** Desktop `machineFingerprint.ts` reads a stable,
deterministic MAC (skips loopback/virtual/zero; lowest MAC wins so the SAME box
always yields the SAME value) and sends it as `X-Device-Mac` on pushes and
`mac_address` on enrol (`machine-fingerprint.test.mjs` 8/8). Cloud: migration 93
adds `user_devices.mac_address` (+ a partial index); `deviceRegistry` stores it
(with a missing-column fallback for a DB without 93) and `findPriorTerminalByMac`
→ pure `pickPriorTerminal` picks the most-recently-seen OTHER device sharing the
MAC (`device-mac-restore.test.mjs` 7/7). `/api/auth/enrol/redeem` returns
`restore: { terminal_code, device_label }`; the desktop enrol handler adopts it,
filling terminal code/name only when the operator hasn't set them. server +
desktop tsc clean.

**Session-restore guide (the 2nd ask):** `docs/RESTORE-GUIDE.md` — the automatic
MAC path above, plus the manual fallbacks (restore the terminal code with
`recover-lost-orders.mjs --set-code`, or restore a whole session from a
`swiftpos.db.bak-*` backup).

**Still OPEN / target-only (rule 16):** verify on real hardware that a Windows
reinstall reports the same MAC and the InstallPage shows the restored code (the
enrol handler sets `device_config`, but the InstallPage should PRE-FILL from it —
needs an on-device pass). A MAC can change (swapped NIC, USB tether, MAC
randomisation): treated as a hint, so the worst case is "no restore offered", never
a wrong bind. Migration 93 must be applied on the cloud. Surfaced + built
2026-08-27. Delivery: MANIFEST-2026-08-27-o.md.

### A181 · P0 · CLOSED 2026-08-28 · Orders read "synced" on the till but never reach the cloud — order-number collision + client treats 409 as success

**VERIFIED — CLOSED 2026-08-28 (real till, SwiftPOS v0.5.38 · win32 → cloud).** Live end-to-end: till coded `T001` rang `T001--1` KES 2,280 'completed' and appeared on the cloud DSR (1 order / KES 2,280, 2026-08-28) — the online loop that had never run on live infra. Then, with the Render cloud suspended (HTTP 503), sales rung fully offline all reached the cloud once Render was restored and the queue drained to 0 — no 409, no silent loss. The '409-marked-synced' loss class is closed. CONFIRMED 2026-08-28: the recovered `T2--6` and `T2--7` (old till `4396d282`) are present on the cloud, so the historical `T2--%` recovery is verified — the last residual thread on A181 is closed.

The ORIGINAL "synced on the till, absent from the cloud." Root-caused from the
cloud's own data. Order numbers are `terminal_code--seq` where `seq` is a LOCAL
per-till counter (`counters.bill_seq`, `ipcHandlers.ts:1156`). The cloud enforces
`UNIQUE (business_id, branch_id, order_number)` (`00_baseline.sql:2493`). A second
till or a REINSTALL at the same branch keeps terminal code `T1` and restarts its
counter at 1, so it mints `T1--1, T1--2 …` over numbers an earlier till already
put on the cloud. `/api/orders` correctly refuses the collision with **409 "Order
number already exists — please retry"** (`orders.ts:705`) — but the client's push
loop treated 409 as success and marked the order `synced` (`syncEngine.ts:1552`).
It does not — a DIFFERENT order holds that number. So every colliding sale read
`synced` on the till and was never stored on the cloud. Cash records/expenses
synced (no number collision), which is why the expense showed but no orders did.
Confirmed live: the cloud holds `T1--1…T1--25` from the prior till (device
`f77f63d7`, 18–25 Aug); the current till (device `4396d282`, from the 26th) reused
`T1--1…T1--7` → all 409'd → all absent (~KES 12,510 of 26–27 Aug sales, safe on
the till, missing on the cloud).

**Fix — part 1 (BUILT, this delivery).** A 409 is no longer marked `synced`; it
escalates to `failed` with the server's reason and hits the durable log
(`order push rejected (409): …`), so a collision is VISIBLE and recoverable
instead of silently lost. `order-409-not-synced.test.mjs` 5/5. main tsc clean.

**Immediate operational mitigation (no code):** give each till at a branch a
DISTINCT terminal code (this till → e.g. `T2`); new orders mint `T2--N`, don't
collide, and land. Stops the bleeding now.

**Still OPEN — needs an owner decision before building (rules 12, 20):**
(a) ROBUST uniqueness so a human setting T1/T2 isn't the only guard (per-device
constraint, or auto-assign a free terminal code on enrol). (b) [DONE] RECOVERY of
the already-lost 26–27 Aug orders — `scripts/recover-lost-orders.mjs`: diffs local
order ids against the cloud id list, re-numbers only the missing ones with the
till's current terminal code (refuses if that would still collide), updates the
`orders` row + the `sync_queue` payload, flips them to `pending`, and backs the DB
up first; dry-run by default. Verified against the real till DB copy (5 × 26-Aug
orders → `T2--1…T2--5`, re-queued; idempotent). Money path; surfaced +
part-1-fixed 2026-08-27. Delivery: MANIFEST-2026-08-27-m.md (part 1) +
MANIFEST-2026-08-27-n.md (recovery).

### A179 · P1 · OPEN · Till-created expenses never sync (non-UUID id 500s the whole cash batch) — FIX BUILT + SELF-HEAL

Root cause of the field "6 pending that never move," found from the till's own
`swiftpos.log` once A178 made the shift push visible:
`[sync] shift push rejected (HTTP 500): invalid input syntax for type uuid:
"exp_1787776714494_w0ash" | 22P02`. The expense-create IPC handler
(`ipcHandlers.ts:1826`) minted the id as `exp_${Date.now()}_${rand}` — not a UUID
— while the cloud `expenses.id` is `uuid`. Every till-created expense therefore
500s on push; and because shifts/floats/expenses/business_days go up as ONE batch
(`/api/sync/push`), that single bad row blocks ALL of them (here: 2 shifts, 2 days,
1 float behind 1 bad expense), forever, never escalating to `failed` (the cash
push leaves rows `pending` on rejection). Orders were fine — they already use
`uuid()` (`ipcHandlers.ts:1843`), which is why they synced. `held_` ids
(`ipcHandlers.ts:225`) are local-only (never pushed) and unaffected.

**Fix.** (1) The generator now uses `uuid()`. (2) A startup self-heal in
`localDb.ts` regenerates any `sync_status='pending'` expense whose id is not a UUID
(`NOT GLOB '*-*-*-*-*'`) — safe because such rows never synced (they always 500'd)
and nothing references `expenses.id`; idempotent. So a till already stuck in the
field unblocks its whole batch on the next start with no manual SQL. Verified: the
self-heal run against the real till DB turned `exp_1787776714494_w0ash` into a
valid UUID; `expense-id-repair.test.mjs` 5/5 (repairs a bad pending id, leaves a
good one and an already-synced bad one untouched, idempotent). main tsc clean.

**Still OPEN (rule 16):** confirmation on the real till that after this build the 6
drain. **Robustness follow-up (recommended):** one malformed row 500s the entire
cash batch — the server should reject bad rows individually (add to the `rejected`
array) instead of failing the transaction, so a single bad record can never again
strand a shop's reconciliation. Surfaced + fixed 2026-08-27. Delivery:
MANIFEST-2026-08-27-k.md.

### A177 · P0 · CLOSED 2026-08-28 · A hung sync fetch deadlocks ALL syncing (root cause of the field "6 pending, 0 failed, Force sync does nothing")

**VERIFIED — CLOSED 2026-08-28 (real till v0.5.38).** After Render was restored the pending queue drained to 0 — orders that had piled up while offline all reached the cloud. Syncing no longer wedges and a backed-up queue drains on reconnect; the 'N pending / 0 failed / Force sync does nothing' signature did not recur.

Field report: a 0.5.37 till, ONLINE, 6 orders PENDING / 0 FAILED for 30+ minutes,
"Force sync" doing nothing; the log full of `fetch failed` and a device token aged
to `-55368s`. Reproduced end-to-end in a sandbox driving the REAL compiled
`syncEngine` (`/tmp/sync-sandbox2.mjs`).

**Root cause.** None of the 15 sync `fetch()` calls had a timeout, and `_isSyncing`
is a module-global set true before the fetch and cleared only in `finally`. A
connection that opens but never responds — a black-holed socket, a proxy dropping
the stream, IPv6 half-open, a cold-start stall — hangs the `await` forever, so the
`finally` never runs and `_isSyncing` stays true permanently. From then on EVERY
`syncAll`/`syncPush` — the 60s flush, the post-sale flush, online-reconnect, and
the Force-sync button — short-circuits with "Sync already in progress." The queue
never drains: orders sit `pending`, 0 attempts, 0 failed (so "Retry failed" can't
help either), until the app restarts. Sandbox: a fast-failing fetch correctly
escalates orders to `failed` at 5 attempts (would show 6 FAILED); a HANGING fetch
leaves them pending/0 and blocks the next pass — the exact field signature. The
server itself is healthy: from the sandbox `POST /api/orders` answers 401 in
0.2–0.6s with no cold-start stall, so this is the till turning one hung connection
into a permanent outage, not the cloud.

**Fix (built, bench-verified).** (1) Every sync fetch now goes through `syncFetch()`
— an `AbortController` with `SYNC_FETCH_TIMEOUT_MS` (20s, env-overridable). A
timed-out fetch REJECTS, which the existing per-call catch already handles, so the
sync completes and `finally` clears `_isSyncing`. (2) A `_syncStartedAt` stale
guard: a sync "in progress" longer than 3 min no longer blocks a new pass, as
defence-in-depth against any non-fetch hang. (3) `pushPendingOrders` now breaks the
batch on the first network timeout instead of burning one full timeout per queued
order, and (4) writes push failures to the durable log (`logLine('sync', …)`) —
they were DB-only, which is why the field log showed pulls failing but never a word
about the 6 orders' push. New test `sync-timeout.test.mjs` (5/5) drives the real
engine with a signal-respecting hanging fetch and asserts the pass resolves, the
order is attempted, and a following sync is never wedged; registered in the
`test:desktop` chain. Regressions: test:sync 29/0, test:pin 17/0, test:peerrelay
28/0. `tsc` clean.

**Still OPEN (rule 16):** confirmation on the real till that after 0.5.37+A177 the
6 pending drain (or escalate to failed and clear on retry) once it can reach the
cloud. Desktop change → version bump + tag after build (rule 15). A separate,
related fragility spotted in the sandbox: `pushLocalRecords`' SELECTs run OUTSIDE
its try/catch, so a schema error there also aborts `pushPendingOrders` — worth
decoupling the three pushes so no one of them can starve the others. Surfaced +
fixed 2026-08-27. Delivery: MANIFEST-2026-08-27-i.md.

### A168 · P2 · OPEN · Order-push 401 refreshed the wrong token for an offline shift

`pushPendingOrders` pushes under `pushAuthHeaders()` = `_staffToken ||
_accessToken`, so an online shift pushes under the staff token and an offline
shift (where `signInLocal` sets the staff token to `''`, A167) pushes under the
OWNER token. On a 401 the recovery called `refreshStaffToken()` unconditionally
— which returns false immediately when there is no staff token — so an offline
order's owner-token 401 had nothing to refresh and the order sat `pending` until
a later pass happened to carry a fresh owner token. `syncAll` refreshes the
device token first (`refreshDeviceTokenIfExpiring`), so the window is narrow
(unreadable `exp`, clock skew, or a token rotated elsewhere), but the path was
simply wrong for the offline case.

**Fix (bench):** refresh the token the push is actually sending. Extracted the
choice into a pure, exported `selectPushRefresh(staffToken)` in `authTransport.ts`
(beside `isUnreachableStatus`) that returns `'staff'` when a staff token is
present, else `'owner'`; the handler refreshes accordingly. Deliberately NOT the
price path's `refreshStaffToken() || refreshAccessToken()` fallthrough: branch
prices are not cashier-attributed, but orders are (`cashier_id = req.userId`,
orders.ts), so falling a STAFF order through to the owner token would reattribute
the sale (see A169). New `tests/push-refresh-selection.test.mjs` runs the real
exported function (staff→staff, empty→owner, mutation-checked), so it is not a
model (the A167 lesson). `apps/desktop` `tsc --noEmit` clean. The 401→refresh→
retry loop itself is target-only (rule 16). Delivery: MANIFEST-2026-08-27-b.md.

### A169 · P1 · CLOSED 2026-08-28 · Offline sales are attributed to the OWNER, not the cashier — FIX BUILT (bench, Option A)

**VERIFIED — CLOSED 2026-08-28 (live cloud data, real till).** Multi-cashier attribution confirmed on the cloud: on ONE till (`55e8dd9f`), order `T001--6` credits **Bill** while the surrounding `T001--*` orders credit **Eugene** — the resolver credits the actual signed-in cashier per order, not the till and not the owner (the pre-fix behaviour would have collapsed every row onto one owner account). The `credited_to` + `device_id` per-row view is exactly the owner's ask — which cashier sold what, on which till. Scope note (rule 7): these rows prove the resolver end-to-end; which specific `T001--*` orders were rung OFFLINE vs online is not distinguishable from the row data, so the offline leg is carried by the resolver's proven correctness rather than an isolated offline-only capture. Closes the P1 opened 2026-08-27.

Found while fixing A168. The server sets `cashier_id = req.userId` — the token
subject (`apps/server/src/routes/orders.ts`) — and did not read a cashier from
the order payload. An OFFLINE shift has no staff token (`signInLocal` →
`configureStaffSession('','')`), so its sales push under the OWNER device token,
and every offline sale was credited to the owner on the cloud. Staff Performance
and SPLH were wrong by exactly the offline volume, silently. Online shifts were
already correct (real staff token → correct subject).

**Fix (Option A, owner-approved 2026-08-27).** The till already knows the real
cashier offline (it stores the signed-in staff's `users.id` = the same id the
server credits online) and now SENDS it as a payload `cashier_id`, carried in the
SHARED `buildCloudOrderPayload` so the peer's direct push and the node's A19
relay stay byte-identical (`peerRelay.ts`, both call sites updated —
`syncEngine.ts`, `nodeIngest.ts`). The server trusts that claim only when the
push is under an owner/device token (`isOwner`) AND it validates against the
roster exactly as verify-pin does — active user in this business with access to
this branch (`orders.ts`). A staff-PIN token stays authoritative: its subject
can't be reattributed, so online sales can't be spoofed. Decision extracted to a
pure `pickCashier` (`lib/cashier.ts`) and unit-tested directly.

**Accepted residual risk (Option A).** An owner-token push can attribute a sale
to ANY branch-authorised cashier, not provably the one who rang it — attribution,
not money movement, and strictly better than "all offline → owner." Owner signed
off on this trade-off.

**A164 interaction (documented).** The gate is `isOwner`. When the till cuts over
to the device-scoped token (isOwner:false, userId = owner, currently INERT), that
path would route down the "staff token" branch and mis-credit the owner again.
**REPORTING & CROSS-TILL ATTRIBUTION (folded 2026-08-28 — the owner's framing of why this matters).** The question A169 answers in practice is *“which cashier sold what and how much, on whichever till.”* The model supports it: every order carries BOTH `cashier_id` (the user) and `device_id` (the till) as independent dimensions — a cashier is credited by their user id no matter which terminal they PIN into, and sales can still be sliced by till. Read surfaces: **Staff Performance** (`reports.ts`) groups completed orders by `cashier_id` net of refunds → revenue + order count per cashier, across tills and per-branch; and a per-cashier **EOD/Z-report** (`/api/reports/eod?cashier_id=`). So the capability the owner wants IS built — but it is only ever as correct as `cashier_id`, which is the whole of A169. Caveats beyond the residual-risk and A164 notes above:
- **History is NOT retroactively corrected.** Every offline sale rung BEFORE the Option-A build shipped is credited to the OWNER on the cloud and stays so — those past Staff Performance / SPLH figures understate cashiers and overstate the owner by the offline volume. Only sales from the fix forward credit the real cashier, and no backfill is possible (the true cashier was never recorded on those rows).
- **Per-person accuracy needs per-person sign-in.** Attribution follows the signed-in account, so several people ringing under one PIN session all credit that one account — a floor-discipline requirement (own PIN, switch on handover), not something the code can enforce.
- **Null `cashier_id` → an “Unknown” bucket** in Staff Performance (`o.cashier_id ?? 'unknown'`); legacy / web-origin orders can land there.

**Verification (rules 7, 16).** `pickCashier` / `claimNeedsValidation` unit-tested
11/11 incl. two mutation guards (an invalid claim is never credited; a staff
subject is never overridden); `buildCloudOrderPayload` cashier + byte-identity
tested 5/5. Server + desktop `tsc --noEmit` clean. STILL OPEN P1: the end-to-end —
the server route actually resolving the claim against real Postgres, and a real
offline till crediting the cashier on the cloud — needs a live server + till
(bench can't run the route or Electron). Delivery: MANIFEST-2026-08-27-f.md.
Surfaced 2026-08-27.

### A167 · P0 · CLOSED 2026-08-28 · Offline PIN sign-in throws `NOT NULL constraint failed: staff_session.token`

**VERIFIED — CLOSED 2026-08-28 (real till v0.5.38, cloud unreachable).** Offline PIN sign-in succeeded for both manager and cashier with NO `NOT NULL constraint failed: staff_session.token`; shift opened and the till sold offline. A wrong PIN was still correctly rejected ('That PIN was not recognised'), so the fallback continues to enforce genuine rejections rather than waving a bad PIN through.

The offline-auth chain (A17 cache · A152 5xx-fallback · A160 node-broker) is
correct at every decision, then dies on the row it writes. `staff_session.token`
is `TEXT NOT NULL` (`localDb.ts`), but the offline path `signInLocal`
(`ipcHandlers.ts`) inserts `token=NULL, refresh_token=NULL` — and its
`ON CONFLICT DO UPDATE` sets `token=NULL` too. So the instant the cloud is
unreachable or answers a 5xx and the code falls through to the local authority,
the INSERT throws `NOT NULL constraint failed: staff_session.token`. Both the PIN
pad (`PinPage`, raw error) and the lock curtain (`LockCurtain.tsx:77`, shown as
"Cannot check that PIN right now. Use Lock till and sign in again.") reach this
through the one `auth:verifyPin` handler, so both are the same failure.

Field-confirmed on a DEV till (`localhost:4000`): reachable-cloud sign-ins take
the ONLINE branch (writes a real token) and never hit it, which is why it only
surfaces during an outage — exactly the case A152 exists for.

**Fix (bench):** write `''` for `token`, not NULL, in both the INSERT and the
UPDATE. The column and its readers are unchanged, so no migration (rule 13): the
reader already coerces empty (`tokenStore.read: unwrap(token_enc) || token || ''`)
and `configureStaffSession('','')` already represents an offline staff session as
empty in memory, so `''` is the value the rest of the code expects, not a
sentinel.

**Verification (rule 7).** Reproduced the throw against the real schema, applied
the fix, re-ran green. NEW `tests/offline-signin-write.test.mjs` builds the real
`staff_session` schema and runs the real statement: INSERT ok, ON CONFLICT
re-sign-in ok, token stored as `''`; mutation-checked — reintroducing `token=NULL`
turns it red naming `staff_session.token` (rules 10, 23). `apps/desktop`
`tsc --noEmit` clean. Engine on the bench: `node:sqlite`, Linux/Node 22 — NOT the
target's better-sqlite3 under Electron (rule 9); NOT NULL is identical across
SQLite builds, so the constraint claim is strong, but the full Electron IPC path
is target-only (rule 16).

**Why the gate missed it:** `offline-auth-fallback.test.mjs` models the ROUTING
decision (5xx → local-fallback, 401 → final-reject) and is correct and
mutation-checked, but it never runs `signInLocal`, so it never writes through the
real schema. A green routing assertion can't prove the write it routes to
succeeds (rules 8, 24). The new test closes that specific seam.

**Stays OPEN P0** until an offline sign-in is proven on a real till (cloud down),
and the lock-curtain unlock verified on the same. Delivery: MANIFEST-2026-08-27-b.md.

### A151 · P1 · OPEN · Split Bill (by-guest) under-collects — the pay loop never advances past guest 1
**BROWSER 2026-08-31 (even-split CONFIRMED correct — the under-collection is gone).**
3-way even split of a KES 790 order previewed 263.34 / 263.33 / 263.33 (sums exactly,
remainder on person 1); charge button read "Charge KES 790.00 · 3 ways"; all 3 Cash
legs took in one confirmation; **one** order closed (ORD-MTH76LLB-001WV), table freed,
Reports showed Orders Today = 1 / Gross = KES 790 — a single order at the full total,
nothing dropped. **By-item NOT tested** (skipped to avoid a second un-voidable order —
see A187). Stays OPEN only pending the by-item confirmation once A187 gives a void
path. Agent report 2026-08-31.

Surfaced while evaluating A8. The restaurant "Split Bill" action in `CashierScreen`
is **half-implemented and loses money on any split with 2+ payers.** The assign step
works (assign each line to a guest, up to 6; per-guest totals compute). The pay step
does not: entering it calls `setSplitPayingGuest(0)`, replaces the cart with guest
0's sub-cart, and opens `PaymentModal` with `existingOrderId` = the WHOLE table's
order. On success, `onSuccess` frees the table and clears the order — and **never
advances `splitPayingGuest`** (it is only ever set to `0`; grep finds no increment,
no `useEffect` watching it). A code comment claims "restore remaining items (handled
via splitPayingGuest)" — it is not handled. Net effect: the cashier collects one
guest's portion, the table shows paid, and every other guest's items are dropped.

Client-confirmed. NOT yet verified server-side: whether `PaymentModal`'s `/pay`
against the full `existingOrderId` also closes the whole order on the first leg
(which would make the remaining guests uncollectable rather than merely dropped from
the UI) — needs a `PaymentModal` + server read. Either way the client already loses
the rest. Second gap: there is **no even/equal-split mode** (the common "just split
it N ways") — only by-item assignment. `SplitPaymentPanel` is unrelated (it splits
the TENDER — cash/M-Pesa/card legs — for one total, not the bill among guests).

Severity P1: silent revenue under-collection, but only on the split-bill path and
only for restaurants, so filed P1 rather than P0 (raise if split-bill is used
heavily). Money-critical POS logic — NOT fixed on the bench (rule 16/20); needs a
design pick + a live test.

FIX — two shapes, pick one:
  • **A (make by-guest work):** advance `splitPayingGuest` on each paid leg, keep the
    remaining guests' items, only free the table / close the order after the LAST
    guest, and record each leg as a PARTIAL payment against the one order (per-guest
    KOT/receipt). Faithful to the current UI; trickiest.
  • **B (even-split via split-tender — recommended for the common case):** reuse the
    working `SplitPaymentPanel` to take N payments for one total without splitting the
    order into sub-orders. Reliable; covers the most-asked need; by-item can follow.

Related: A8 (dead `SplitBillModal`/`/split`/`sub_bill`) is NOT the fix — retire it.
Delivery of this finding: MANIFEST-2026-08-23-m.md.

INVESTIGATED 2026-08-23 (source read of `/pay`, `PaymentModal`, `SplitPaymentPanel`
— severity refined, fix plan corrected):
  • **Server guards against the worst case.** `POST /:id/pay` recomputes `amountDue`
    from the order's own `subtotal` and REJECTS any leg set that doesn't reconcile
    (`|legSum − amountDue| > 0.01` → 400, "no partial write, order stays open"). So
    paying a guest's partial share against a *sent* order does NOT silently close it
    — it errors. Silent under-collection is therefore the **pay-first** case only:
    there `PaymentModal` creates a NEW order from guest 0's sub-cart (legs match →
    accepted), then `onSuccess` frees the table and drops the rest. Order-first just
    fails at payment. Either way broken; P0 avoided (no silent close of a sent
    order). Severity stays **P1**.
  • **Split-tender already works.** `PaymentModal` has a `splitMode` toggle →
    `SplitPaymentPanel` (legs must sum to total) → `handleSplitCharge` → `/pay` with
    N legs. So "collect N payments for one bill, paid in full, one order" is a solved,
    proven path.
  • **But `SplitPaymentPanel` can't do people-splits.** It filters out already-used
    methods (`availableMethods`), so it's one-leg-per-method, capped at 4 — fine for
    "part cash / part card," wrong for "3 people all paying cash." So the original
    "reuse SplitPaymentPanel for even-split" does NOT fit.

CORRECTED FIX (Option B, refined): add a small **even-split collector** — pick N,
it builds N equal legs (total/N, remainder on leg 1), each leg method-selectable,
summing to the FULL total — and reuse the proven `handleSplitCharge` → `/pay`
(N legs, one order, paid in full). Do NOT touch `SplitPaymentPanel` (its
method-unique cap is correct for tender-splitting). Separately, neutralise the
broken by-guest sub-cart pay (repoint it at the even-split collector, or fix it as
Option A later). Money-critical + no live test on the bench, so this lands as its
own patch with a build-green + a required live test before close. Delivery of this
investigation: MANIFEST-2026-08-23-n.md.

FIX SHIPPED 2026-08-23 (Option B; dev; still OPEN pending a LIVE split-payment
test — rule 16). New `EvenSplitPanel.tsx` (per-person even split: pick N=2–12 →
N equal legs, remainder on person 1, each leg cash/M-Pesa/card, summing to the full
total) wired into `PaymentModal` behind a "Split evenly (per person)" toggle and an
`initialEvenSplit` prop; it calls the existing `handleSplitCharge` → `/pay` with N
legs (one order, paid in full, no sub-orders). `CashierScreen`'s restaurant
"Split Bill" button is **repointed** to open `PaymentModal` in even-split mode, so
the broken by-guest sub-cart pay path (the under-collection bug) is now
**unreachable** — closing the revenue hole. Deliberately excluded: credit legs (tied
to one customer account); `SplitPaymentPanel` untouched. Verified: dashboard
`tsc --noEmit` 0 errors, `vite build` exit 0. NOT done (follow-ups): true by-item
split (Option A), and removing the now-dead `showSplitBill` by-guest UI block in
`CashierScreen` (left inert to keep this money patch minimal). MUST live-test before
close: open a dine-in check, Split Bill → even split N ways with mixed methods →
confirm one order is paid in full and the table frees only after full payment.
Delivery: MANIFEST-2026-08-23-o.md.

OPTION A SHIPPED + CLEANUP 2026-08-23 (dev; OPEN pending live test). Added
`ByItemSplitPanel.tsx` (assign each line to a guest 2–6, per-guest totals scaled
proportionally to reconcile to the FULL order total, one method per guest → N legs
summing to total → the same `handleSplitCharge` → `/pay`). Wired into `PaymentModal`
as a third split mode ("Split by item (per guest)") beside by-method and evenly; all
three collect N legs against one order (no sub-orders). The now-dead by-guest UI
block + its state (`showSplitBill`/`splitGuests`/`splitStep`/`splitPayingGuest`,
~130 lines) were removed from `CashierScreen`. Allocation safety: per-guest legs are
scaled so they sum to the total exactly, and the server rejects any set that
doesn't (400, no partial write), so a mis-allocation fails safe (errors) rather than
under-collecting. dashboard `tsc`/`vite` green. STILL OPEN — live test now covers
all three modes; for by-item specifically, verify a bill WITH VAT/discount/tip
splits so the legs reconcile and the sale is accepted. NOTE the VAT/tip allocation
choice is "proportional to each guest's line-item value" — flag if a different
policy is wanted. Delivery: MANIFEST-2026-08-23-p.md.

### A152 · P0 · CLOSED 2026-08-28 · Offline auth doesn't fall back when the cloud is DOWN-but-responding (5xx) — tills locked out during the 2026-08-23 Render outage

**VERIFIED — CLOSED 2026-08-28 (real till v0.5.38, cloud at HTTP 503).** The Render service was suspended — which serves the 'This service has been suspended by its owner' page with a 503, i.e. the down-but-answering case A152 targets. On that 503 both manager and cashier fell through to the offline path and signed in, AND a wrong PIN was still rejected — confirming both halves: a 5xx is treated as unreachable (fall through), while the fallback still enforces genuine rejections. Only nicety outstanding: the till-log verbatim `503` line (behaviourally proven, Render 503 documented).
**⏭ MORNING PRIORITY (owner, 2026-08-23): first task next session.**

**Incident (owner, 2026-08-23):** the Render (cloud) API was down and desktop
tills could not sign in. The desktop app is meant to keep trading when the cloud
is unavailable; it did not — offline resilience did not save the shop.

**Root cause (confirmed at source, `ipcHandlers.ts`):** the auth chain falls back
to the offline authority ONLY when the cloud fetch *throws* — a transport failure
(DNS, connection refused, timeout). `ownerFetch` (ipcHandlers.ts:368) returns the
raw `Response` and only special-cases 401; it does NOT throw on a 5xx. So in
`auth:verifyPin` (ipcHandlers.ts ~502–511) a "down" cloud that still answers at the
platform edge with **502/503** is not caught: control reaches `await res.json()`
(which throws on the gateway's HTML body) or `if (!res.ok) throw 'Invalid PIN'` (a
REJECTION) — and the node/cache fallback is never reached. A Render outage is
exactly this shape (process down, load balancer still answering 5xx), which is why a
valid offline cache/node could not rescue the login.

**This is the deployed-behaviour gap A17's note warned about** — the P0 is live in
production; this incident is a concrete instance of it, distinct from the day-15
expiry (here login fails *immediately* the moment the cloud 5xxs).

**FIX DIRECTION (verify first thing; do not build blind — money/auth path):**
  1. Treat a 5xx / gateway / non-JSON response as authority **UNREACHABLE** and fall
     through to the next authority (node → cache), same as a thrown transport error.
     Keep the rule that a clean 401/403 (a real authenticated rejection) is FINAL —
     only genuine rejections must not fall back.
  2. Guard `res.json()` against a non-JSON body (a 502 HTML page currently throws an
     unhandled parse error).
  3. Check the SAME pattern on the node step (`verifyPinAtNodeClient`) and on the
     cloud-only `desktop-login` / session-restore path (ipcHandlers.ts:74), which has
     no offline fallback at all.
  4. Confirm whether the PHASE5/A17 auth build is even on the affected tills (D3 — no
     auto-update); an old build would compound this.
Reproduce: point a till at a URL that returns 502, or stub `ownerFetch` to resolve a
503, and confirm a previously-cached cashier can still sign in. Filed 2026-08-23.
Delivery: MANIFEST-2026-08-23-w.md.

**FIX BUILT 2026-08-24 (batch -d, bench) — STILL OPEN P0 pending the target test
(rule 16).** New `apps/desktop/src/main/authTransport.ts::isUnreachableStatus(status)`
(`5xx` ⇒ unreachable), used as the single source of truth at all three sites of
the class:
  1. **Cloud PIN verify** (`ipcHandlers.ts` `auth:verifyPin`): the offline fallback
     was extracted to a local `fallbackToLocalAuthority()` and is now taken on BOTH
     a thrown transport error AND a 5xx response — so a down-but-answering cloud
     rescues from node/cache identically to an unreachable one. `res.json()` is now
     `.catch(() => ({}))`-guarded so a gateway HTML body cannot throw. A clean 4xx
     still throws — a real rejection stays FINAL.
  2. **Node PIN verify** (`nodeClient.ts` `verifyPinAtNodeClient`): the transport
     test widened from `=== 503` to all 5xx (a node 500/502/504 was being read as a
     final rejection — the same class on the LAN leg).
  3. **Owner desktop-login** (`ipcHandlers.ts` `auth:login`): a first owner login has
     no cached credential to fall back to, but a 5xx no longer reads as "Login
     failed" or crashes on a non-JSON page — it surfaces a clear "cloud unreachable,
     retry" message distinct from a wrong password.
Test: `tests/offline-auth-fallback.test.mjs` (20 assertions, models the authority
decision + the node leg; mutation-checked — narrowing the predicate back to `=== 503`
reddens the 502/500/504 cases by name). Bench green (Linux/Node 22). **NOT verified on
a till (rule 16):** point a real till at a 502/503 and confirm a previously-cached
cashier signs in and a wrong PIN is still refused. Desktop change → version bump at
build time (rule 15). Also confirm the affected tills actually carry this build (D3 —
no auto-update). Delivery: MANIFEST-2026-08-24-d.md.

### A180 · P2 · CLOSED 2026-08-27 · One bad row 500'd the whole /api/sync/push batch — expenses now isolated per-row like the rest

The general form of A179. `/api/sync/push` upserts business_days, shifts and
floats PER ROW and reports failures in a `rejected` array — but expenses were a
single batch `upsert(rows)` that `sendError`'d (500) on any error
(`sync.ts`). So one malformed expense (A179's non-UUID id → 22P02) failed the
entire push, and every shift/day/float in the same batch stayed pending behind it
— the client leaves the whole payload pending on a non-2xx. Fixed: expenses now
partition by valid id (a non-UUID is rejected up front with `code:'invalid_id'`,
`table:'expenses'` — which the till already parks as `conflict`, `syncEngine.ts`)
and the rest upsert per-row, adding any per-row failure to `rejected` — the same
contract floats/shifts/days already honour. A bad row is now the row's own
problem; the good rows in the same push still land. Guard extracted to a pure
`partitionByValidId` (`lib/syncPush.ts`), unit-tested 8/8 incl. a mutation check
(a bad id never leaks into `valid`). Server tsc clean. Server-side change — deploys
on its own cadence, no desktop version bump. Delivery: MANIFEST-2026-08-27-l.md.

### A178 · P2 · CLOSED 2026-08-27 · Sync was invisible and coupled — decoupled the push stages, logged them, and gave the tech menu real diagnostics

Found while diagnosing the field "6 pending" from the till's own DB: all orders
were `synced` — the 6 were shift/day/float/expense records, and the code that
pushes them (`pushLocalRecords`) wrote NOTHING to the durable log on success or
failure, so a stuck shift push was completely silent. Two problems fixed:

**Coupling.** `syncAll`/`syncPush` ran the five push stages (shift, price, order,
reconcile, node) in one `try`, so a throw in an earlier stage — e.g.
`pushLocalRecords`' SELECTs hitting a missing column — skipped the order push
entirely. Now a `runPushStages()` helper runs each stage independently: a throw is
caught, logged (`[sync] <stage> stage threw: …`), and the others still run. Test
`sync-decouple.test.mjs` drives the real engine with a deliberately broken shifts
schema and proves the order still pushes (6/6).

**Invisibility.** Shift-push and price-push failures now write to `swiftpos.log`
(`[sync] shift push rejected …` / `… failed: …`), matching the order-push logging
added in A177; successful pushes log their counts too (`pushed N order(s)`,
`pushed N cash record(s)`) so the log positively shows sync working.

**Tech menu (the "more powers" ask).** `getSyncStatus` now returns a
`pendingBreakdown` (orders/shifts/floats/expenses/days); the Technician screen
shows it under the count ("2 shift · 2 day · 1 float · 1 expense waiting to push")
instead of a bare "6". Added a real **Test connection** (`testConnection()` +
`tech:testConnection`) that reaches the server and reports HTTP status + round-trip
— unlike the "Online" badge, which is only `net.isOnline()` — and a **View log**
(`tech:logTail`) with copy, so a tech reads the durable log on the device instead
of hunting `%APPDATA%`. Both read-only; the log never records tokens.

Verified: `sync-decouple.test.mjs` 6/6 (incl. shift/order log lines + breakdown);
regressions sync-timeout 5/0, sync 29/0, pin 17/0, peerrelay 28/0; `apps/desktop`
main + renderer `tsc` clean. Target-only (rule 16): the TechPage buttons/render
need an on-device look. Desktop change → version bump + tag after build (rule 15).
Delivery: MANIFEST-2026-08-27-j.md.

### A176 · P2 · CLOSED 2026-08-27 · syncEngine-failures test rotted — pull-capture suite couldn't reach the pull

`test:sync`'s "inbound failure capture" suite (11 of its assertions) had been red:
every one reported "nothing reported at all" / an empty log. Cause: A24 added an
unconditional `fetchReferenceFromNode()` at the top of `pullCatalogue()` (node
reference channel, falls through to cloud on null), but the test's `nodeClient`
shim never exported it — so `syncAll()` threw `fetchReferenceFromNode is not a
function` before ever reaching the cloud fetch the tests exercise. Feature is
correct; the shim was stale. Fixed by adding `fetchReferenceFromNode: async () =>
null` to the shim. Now 29/0 (was 18/11), and the 403/500/ECONNREFUSED pull
captures are genuinely exercised again. Test-only; no app code. Found because
`test:desktop`'s `&&` chain had been dying here, hiding everything after it.
Delivery: MANIFEST-2026-08-27-h.md.

### A175 · P2 · CLOSED 2026-08-27 · pinCache test rotted — offline-verify suite threw "no such table: device_config"

`test:pin`'s offline-verify suite (8 assertions) had been red on every run: the
A17 no-expiry-on-a-node work added `getDeviceConfig()?.node_url` to
`verifyPinOffline`, but the test shimmed `localDb`/`logFile`/`electron` and never
`deviceConfig`, so the real `deviceConfig` ran against a DB with no
`device_config` table and threw. Feature is correct (the real app creates the
table, `localDb.ts:54`); the shim set was stale. Fixed by shimming `deviceConfig`
(standalone default), and added a test for the A17 node-configured no-expiry
branch it now reaches. Now 17/0 (was 8/8). This suite is the automated guard for
the exact offline-auth area A167 fixes, so restoring it matters. Test-only; no app
code. Delivery: MANIFEST-2026-08-27-h.md.

### A174 · P3 · CLOSED 2026-08-27 · check-root-clean flagged gitignored leftovers (A172 false positive)

A172's gate read the raw filesystem, so on a real dev machine it flagged
`swiftpos-2026-08-25.patch` — a gitignored delivery leftover that never reaches
the repo (`.gitignore` ignores `*.patch`/`*.zip`). Rule 19 is about what's
COMMITTED to the root, and a gate that fires on files git already ignores cries
wolf — the exact rule-23 failure mode. Fixed: the gate now filters candidates
through `git check-ignore` and only judges files git would track. CI was never
affected (a clean checkout has no ignored files — it was already green), but the
local false positive is gone. Verified: a gitignored `swiftpos-*.patch` in root →
clean; a genuine non-ignored stray `.md` → still caught; self-test 9/9.
Delivery: MANIFEST-2026-08-27-g.md.

### A173 · P3 · CLOSED 2026-08-27 · Duplicate manifest in docs/ — `MANIFEST-2026-08-20-a (1).md`

A browser-download duplicate (`… (1).md`) of `MANIFEST-2026-08-20-a.md` had been
committed into `docs/`. Confirmed byte-identical and cited nowhere, then removed.
The rule-19 gate (A172) guards the repo root; this was the same class one level
down. Deletion only, `check-doc-refs` still green. Delivery: MANIFEST-2026-08-27-e.md.

### A172 · P3 · CLOSED 2026-08-27 · Gate: rule 19 — repo root must hold no documents/archives but README.md

Rule 19 ("the ~140 stray zips") made a gate. New `scripts/check-root-clean.mjs`
fails if a `.md` (other than README.md), `.zip`, `.patch` or `.diff` sits in the
repo root; it deliberately ignores build/config that legitimately lives there
(package.json, render.yaml, rearm-till.mjs, dotfiles). Self-test 9/9 (rules 23,
24), green on the tree, wired into CI, auto-discovered by run-all. Delivery:
MANIFEST-2026-08-27-e.md.

### A171 · P3 · CLOSED 2026-08-27 · Rule 24 was cited by ID but had no home in §0

`HANDOFF-2026-08-10-evening.md` said "That is rule 24" and the register cited it,
but §0 RULES (`HANDOFF-2026-08-08-evening.md`) never contained its text — the one
rule that existed purely as a cross-reference, the exact fragility rule 21's
stability note warns about. Formalised into §0 verbatim to the original meaning:
a mutation check proves an assertion notices a change, not that it measures the
right thing (A167 is the standing example). Docs-only. Delivery: MANIFEST-2026-08-27-e.md.

### A170 · P3 · CLOSED 2026-08-27 · Gate: literal NULL written into a NOT NULL local column (the A167 class)

The rule-6 sweep A167 earned. A167 was a literal `NULL` written into a `NOT NULL`
column (`staff_session.token`) — fatal at runtime, invisible to `tsc`, and missed
by the offline-auth test because that test models the routing, not the write
(rules 8, 24). New gate `scripts/check-notnull-writes.mjs` parses the NOT NULL
columns out of `localDb.ts`'s `CREATE TABLE` blocks and flags any literal `NULL`
written into one — in an INSERT's VALUES (aligned by column position), an
UPDATE SET, or an ON CONFLICT DO UPDATE SET. It only inspects statements that
contain a bare `NULL`, so NULL-free SQL cannot be mis-parsed into a false
positive; bound-parameter NULLs (`?`, `@name`) are a runtime value it does not
judge.

Sweep result: A167 was the ONLY instance. The other literal-NULL sites are all
against nullable columns and correct — `shiftService.ts` (`closing_float` /
`cash_variance` are `REAL`), `managerReports.ts` (`local_price_edits.price` is
nullable, "NULL = cleared"). So the gate is green on the tree today (167 NOT NULL
columns across 45 tables, 0 violations).

Verification (rules 7, 23): `--self-test` passes 6/6 (fires on A167's INSERT and
UPDATE and ON CONFLICT shapes, stays silent on a nullable NULL), using the SAME
`analyzeSql` the real run uses (rule 24, not a model). Mutation-checked on the
REAL file: reintroducing `token=NULL` in `ipcHandlers.ts` turns the gate red
naming `ipcHandlers.ts:415 staff_session.token`. Wired into CI (run + self-test)
and auto-discovered by `run-all.mjs`. Delivery: MANIFEST-2026-08-27-d.md.

### A153 · P2 · CLOSED 2026-08-24 · Retire four superseded/orphaned dashboard-POS prototypes (dead code)
Four dashboard files were unreachable at runtime — unrouted and imported by
nothing — each with a live sibling that already does the job. Confirmed at source
(per-file import scan across all apps, plus a test/gate/e2e sweep that found zero
dependents):
  - **`pages/pos/OrderHistoryTab.tsx` (361)** — original-commit prototype, never
    edited since 2026-07-13. Superseded by `POSOrderHistoryTab.tsx`, which is the
    live one wired into `ManagerDashboard` and `POSDrawer`.
  - **`pages/pos/VoidModal.tsx` (165)** — dead **by association**: its only importer
    was `OrderHistoryTab`; the live `POSOrderHistoryTab` does not use it. No scan
    flagged it because it *looked* imported. (If void-from-dashboard-POS is ever
    wanted, its only UI was already unrouted — a separate feature gap, not a
    regression from this deletion.)
  - **`pages/pos/BranchSelectScreen.tsx` (353)** — original-commit prototype. Its
    whole `SELECTED_BRANCH_KEY` / `swiftpos_selected_branch` sessionStorage contract
    is read/written **nowhere** in any app. Live branch selection is
    `components/BranchSelector.tsx`.
  - **`pages/pos/VariantModal.tsx` (258)** — dead in the dashboard (name-collides
    with the *live* desktop `renderer/components/VariantModal.tsx`, which stays,
    wired in `POSPage.tsx`). This was the `VariantModal` in the 08-10 A8 sweep.

All four are the exact set the 08-10 A8 "unreferenced sweep" listed but never gave
an owning item; A8's 08-23 re-scope deleted `SplitBillModal` and left these behind.
Pure deletion of unreachable code — **no runtime behaviour changes** (nothing could
reach it), which is why this is bench-closeable without a target pass (rule 16 does
not bite: there is no on-target behaviour to verify). **Evidence:** after deletion,
`apps/dashboard` `tsc --noEmit` 0 errors + `npm run build` (vite) green; full gate
suite + unit/migration tests green on the bench (Linux/Node 22, rule 9).
**Left in place (additive, rule 13):** deleting the dashboard `VariantModal` orphans
`computeUnitPrice` / `computeLineTotal` in `lib/cart.ts` (now zero consumers) —
kept, flagged for removal, so this delivery is deletions-only and reverts by
restoring four files. Delivery: MANIFEST-2026-08-24-a.md (rollback: `git apply -R`).
**Follow-up done 2026-08-24 (batch -b):** the two orphaned exports were pruned from
`apps/dashboard/src/lib/cart.ts` — the DESKTOP copy (`renderer/lib/cart.ts`) keeps
both (live: desktop `VariantModal` + `POSPage`); `cart.ts` is not a shared-synced
file, so the copies legitimately differ. Dashboard `tsc` 0 + build green after.
Delivery: MANIFEST-2026-08-24-b.md.

### A154 · P3 · OPEN · Build the admin "DB migrations" panel — `MigrationsPage.tsx` front-end exists, `GET /api/admin/migrations` backend never built
`apps/admin/src/MigrationsPage.tsx` (213) is a **finished-but-unwired** read-only
panel (rule 17): it lists schema-migration runs + applied migrations for the admin
portal, and its own header documents the one backend route it needs
(`GET /api/admin/migrations`, service-role read of `schema_migration_runs` +
`schema_migrations`, mounted under the admin router so it inherits admin auth). That
route **does not exist** — no `routes/admin/migrations*`, no `schema_migration_runs`
reference anywhere in `apps/server/src` — and the page is imported nowhere in
`AdminPortal`, so it renders only its built-in mock data. **Kept deliberately**
(owner, 2026-08-24) rather than deleted: given the recurring "what is actually
applied to prod" pain (the 89/90/91 migrate saga, the twin-`90` filename collision),
a live migrations-status panel is worth finishing. **To build:** (1) add the
service-role read route under the admin router; (2) replace the mock `req` with the
real admin fetch helper; (3) route/link it into `AdminPortal`. Backend touches meta
tables only (no schema change, no prod-migrate). Filed 2026-08-24.

### A155 · P3 · CLOSED 2026-08-24 · Branch-tip gate red — `check-doc-refs` failed on `HANDOFF-2026-08-23`'s citation of an outputs-only checklist
The 08-23 handoff (§2) claimed "all gates green," but committing that handoff broke
`check-doc-refs`: batch -x cited a money-path live-test checklist as a followable
`docs/` markdown reference, when the file was delivered to the session outputs
directory (never committed to `docs/`, by design — it is an ops artifact, not repo
doc). So the very act of committing the "all green" handoff turned a gate red — the
rule-20 miss the register keeps catching ("a header/claim disagreeing with the tree
is the failure the register exists to catch"). **Fix (this batch):** reworded the two
references in `HANDOFF-2026-08-23.md` (lines 74, 162) to describe the checklist
without a dangling `.md` citation — the gate's own sanctioned option ("add the
document to docs/, or remove the reference"). `check-doc-refs` now green (546
citations, all resolve). Verified: `node scripts/check-doc-refs.mjs` OK. This closes
the "Finding 1" raised in the 2026-08-24 audit discussion. Delivery:
MANIFEST-2026-08-24-b.md.

### A156 · P3 · CLOSED 2026-08-24 · Retire orphaned helper exports (dead value-exports across dashboard/desktop/server)
A repo-wide sweep for value exports (function/const) referenced nowhere — the same
class as the A153 cart follow-up. A whole-tree scan (`git grep -w`, all tracked
files incl. `migrations/`, `scripts/`, `docs/`, `tests/`, `.github/`) found 14
declaration-only candidates; **12 removed**, **2 excluded** because they are cited in
docs and want a decision, not a silent delete:
  - **Removed (elsewhere-refs = 0):** `clearSwiftPOSToken` (dashboard `lib/api.ts`;
    `clearAllTokens` is the real logout path), `localDateStrDaysAgo`
    (`lib/localDate.ts`), `getAvailablePrinters` + `disconnectQZ`
    (`lib/localPrintServer.ts` — QZ module stays; these two getters/teardown unused),
    `SkeletonLine` + `PageSkeleton` (`pos/cashier/POSSkeletons.tsx` — the 4 live
    skeletons + `SkeletonTable`/`SkeletonKpiCard` stay), `stopIdleMonitor`
    (desktop `main/idleMonitor.ts`; monitor was already never stopped — no behaviour
    change), `getPrinterSettings` (`renderer/hooks/usePrinterSettings.ts`),
    `heldOrderCount` (`renderer/lib/heldOrders.ts`), `metaRow` (`renderer/lib/thermal.ts`),
    `DISABLED_ADMIN_HASH` (server `lib/adminSeedGuard.ts`; `SEEDED_ADMIN_HASH` +
    `isSeededAdminHash` stay), `whatsAppEnabledGlobally` (server `lib/whatsapp.ts`).
  - **Excluded — flagged, NOT deleted (doc-coupled, need a decision):**
    `getLocalSchemaVersion` (`desktop/main/localDb.ts`) is described in
    `docs/LOCAL-SCHEMA-VERSIONS.md` as the mechanism for knowing which schema a till
    reached — it may want *wiring* (a diagnostic), not deletion. `isTerminalCodeTaken`
    (`server/lib/deviceBinding.ts`) appears in `docs/history/applied/WIRING.md` as
    once-wired example code; the "applied" history conflicts with it being uncalled
    now — resolve before removing.
  No behaviour changed — every removed symbol had zero callers tree-wide. **Evidence:**
  typecheck-ratchet server/dashboard/admin all 0; desktop renderer tsc clean; desktop
  main tsc unchanged (its 4 pre-existing implicit-any errors exist at the -b baseline
  too, untouched here); dashboard `npm run build` green; full `run-all` suite 40/0
  (Linux/Node 22, rule 9). Deletions-only; reverts by restoring 10 files. Delivery:
  MANIFEST-2026-08-24-c.md (rollback `git apply -R`).

### A158 · P1 · OPEN · Owner email/password login on a till exposed reusable dashboard credentials — retired for enrolment-only activation
A shared terminal accepted the **owner's email + password** (`/desktop-login`) to
sign in. Anyone who watched it typed or captured it then held the owner's *dashboard*
credentials and could edit anything — products, prices, users, settings. The one-time
enrolment code (`/enrol/redeem`) was built to replace it (device-bound, revocable, no
password) and mints the *same* owner-scoped desktop session (`surface: 'desktop'`, D14
terminal registration, suspended-business check), but owner-login remained a **reachable
fallback**, so the risk stayed open.

**FIX BUILT 2026-08-24 (bench) — OPEN P1 pending amber-build verification (rule 16).**
Owner email/password is removed as a terminal entry point at every layer; enrolment is
the sole activation. Web dashboard `/login` is untouched.
  - **Renderer:** `App.tsx` drops the `owner-login` state → new `enrol` state; a
    configured-but-session-less till shows the new `EnrolPage.tsx` (business id + one-time
    code), not email/password. `LoginPage.tsx` deleted. Sign-out now clears **staff only**
    → PIN pad; the device stays enrolled (its session is the terminal identity), so a
    routine sign-out no longer strands the till.
  - **Main + preload + posApi:** the `auth:login` IPC handler, its preload bridge, and the
    `auth.login` binding are removed. `auth:enrolDevice` is now the only activation call.
  - **Server:** `POST /desktop-login` **tombstoned** (410 `DESKTOP_LOGIN_RETIRED`),
    keeping the shared `registerDesktopTerminal` helper `/enrol/redeem` uses.
  - **Tests:** `auth-surface` repointed to assert `/enrol/redeem` mints `surface:'desktop'`
    and `/desktop-login` mints none; new `terminal-activation.test.mjs` guards every layer
    (mutation-checked — re-adding owner-login at any layer reddens it).
Evidence (bench, Linux/Node 22): server + desktop renderer + main tsc clean (main only the
4 pre-existing implicit-any); `check-ipc-parity` 147/147; `auth-surface` 12/0;
`terminal-activation` 10/0; full suite green.
**Verify on the amber `dev` build (close condition):** fresh till → enrol with a portal
code → lands on PIN (no email/password screen ever); session-loss → shows EnrolPage, not
owner-login; cashier sign-out → PIN, device stays enrolled.
**ROLLOUT (rule 13):** update every client till to this enrolment-only build BEFORE the
tombstone reaches their server, or an un-updated old till loses its only sign-in path.
**Phase 2 (separate, NOT here):** device-scope the till token so a *stolen* token can't
reach the dashboard. Delivery: MANIFEST-2026-08-24-g.md.

### A160 · P1 · OPEN · Offline peers can't refresh their session without the cloud — node now brokers the refresh (Phase a+b built)
Realises your original design: **only the node needs internet; peers rely on it.** Today a
peer refreshes its session against the CLOUD (`/api/auth/refresh`, access 15m / refresh
30d); an offline peer whose access token lapses can't refresh and falls to a login. The
node — which is online — should broker it. (Foundation already there: the node
authenticates peers over the LAN with `node_secret`; `nodeServer.ts` even remembers it
"used to be the SOLE uplink to the cloud".)

**Phase (a) — already satisfied for ONLINE tills.** With refresh-token rotation, a till
with internet re-auths silently (no human) on expiry; the "login on expiry" only bit
offline peers. No build needed for (a).

**Phase (b) FIX BUILT 2026-08-24 (batch -i) — node brokers the refresh — OPEN P1 pending
on-till verification (rule 16).** The refresh token IS the device credential (server-issued,
rotating, revocable — no new secret, no migration):
  - `nodeServer.ts` — new `POST /node/refresh`: authenticated by `X-Node-Secret` (existing
    LAN auth), proxies the peer's refresh token to the cloud `/api/auth/refresh` and passes
    the verdict straight back; **503** if the node itself can't reach the cloud.
  - `nodeClient.ts` — `refreshViaNode(refreshToken)` calls it; returns the new pair or null.
  - `syncEngine.ts::doRefreshAccessToken` — when the cloud is **unreachable (thrown) or 5xx**
    (the A152 pattern) and `hasNode()`, refresh THROUGH the node before giving up. A clean
    **401 (revoked) is final** — never brokered around, so a killed session still ends.
So an offline peer keeps its session as long as its node has internet — no human login.
Test: `tests/node-token-refresh.test.mjs` (9, mutation-checked — removing the 5xx/throw→node
arm reddens the offline cases). Desktop main + renderer tsc clean; refresh-grace/
node-verify-pin/peer-auth-chain/offline-auth-fallback all still green; ipc-parity OK.
**To CLOSE (owner):** on two tills + node, cut the peer's cloud (leave the node online), let
the peer's access token lapse, confirm it refreshes via the node and keeps selling — and
that a revoked token still ends the session.
**Phase (c) — the pure "only the node online"** (node mints its own tokens; peers never
touch the cloud) stays future work; it needs A19 (node uplink) + A24 (reference down) +
A20 (roster). Full scope: `SCOPE-node-authority-A160.md`. Delivery: MANIFEST-2026-08-24-i.md.

### A161 · P1 · OPEN · Node serves no reference data downstream — the A24 snapshot channel (node-serve half built)
The first leg of Phase (c) node-authority. Implements the **downstream reference snapshot
channel** that closes **A24** (catalogue/prices/variants/modifiers/stock/tables/pumps/print
routing go stale on an offline peer) and, on the same channel later, **A20** (roster). A161
tracks the channel's own build lifecycle across batches; A24/A20 remain the findings it closes.

Verified at source first (rule 5, 17): the node already holds the whole branch's reference
data in its OWN local tables — its cloud sync (`syncEngine.pullCatalogue`) writes categories,
products, variants, modifiers, stock, tables, pumps, stations, payment methods and caches the
config fields on `device_config`. It just never served any of it (`nodeServer` had no
reference route; `nodeClient` pulled `/node/since` only). So this is "serve what the node
already has", not new node-side persistence — the register's hoped-for "extend an existing
mechanism".

**BATCH -a 2026-08-25 — NODE-SERVE HALF BUILT (bench, Linux/Node 22 — a WEAKER green than the
Windows/Node 20/Electron target, rule 9). Inert until batch -b wires the peer read, so it
changes no running till.**
  - `apps/desktop/src/main/referenceBundle.ts` (NEW) — `buildReferenceBundle(db, cfg)` reads
    the node's local tables and returns a bundle in the EXACT shapes `pullCatalogue` consumes
    from the cloud, so the peer's write path is unchanged whether the source is cloud or node.
    The reshape is a PURE function `mapReferenceBundle(rows)` (no SQLite/Electron) so the
    mappings that corrupt a catalogue silently are mutation-testable: **products.is_kitchen is
    a tri-state** (null|0|1 → boolean|null; the writer only stores it when `typeof==='boolean'`,
    so a raw number becomes null on every product), users `role_name` → cloud `roles:{name}`,
    `print_stations`+`category_stations` → `station.category_ids[]`, flat `combo_items` →
    `Record<combo_id, component[]>`.
  - `nodeServer.ts` — new `POST /node/reference` (branch-scoped, `X-Node-Secret`, matches
    `/node/since`), returns `buildReferenceBundle(getLocalDb(), cfg)`. Full snapshot, applied
    wholesale (delta-by-version is a later A24 step).
  - `nodeClient.ts` — `fetchReferenceFromNode()` (mirrors `pullNodeDistribution`): null on
    unreachable/refused/malformed so the peer falls back to the cloud. **Unused until -b.**
  - Test `apps/desktop/test/node-reference-bundle.test.mjs` (NEW, 25 assertions) drives the
    REAL compiled `mapReferenceBundle`; **mutation-checked** — breaking the tri-state turns 3
    named asserts red. Wired into `test:desktop` + a CI step (`check-test-registration` green).

**Scope held deliberately (named, not dropped):** the roster (A20) rides this same channel in
a later slice, behind the owner's trust-domain go-ahead (given) + the PIN-rotation runbook —
reference-first proves the channel on harmless data before credentials (the register's own
PHASE6 reasoning). `business_settings`/kitchen-exclusion distribution is also held: A24 step 4
(`business_settings` has no `branch_id`) must land first or the snapshot hands down an
ambiguous truth.

**NEXT — batch -b (peer-read half, money-adjacent):** refactor `pullCatalogue` to be
node-first — when a `node_url` is set and `fetchReferenceFromNode()` answers, feed the bundle
to the existing write transaction and skip the 7+N cloud calls; on any node problem, fall
through to today's cloud path unchanged (additive by construction). Then A19 (upstream), then
the node-mint.

**BATCH -b 2026-08-25 — PEER-READ HALF BUILT (bench, same Linux/Node-22 ceiling, rule 9). The
feature is now end-to-end on the bench; closes on the two-till target.**
  - `referenceBundle.ts` — added pure `unpackNodeBundle(bundle)` + `AcquiredReference`: turns a
    node bundle into exactly what `pullCatalogue` writes. The DON'T-WIPE guards live here —
    a partial/old-build bundle (a missing array) reads as "not fetched" (`tablesFetched=false`,
    `stations=null`, `paymentMethods=null`), never as an empty fetch that would clear good
    local data. Numeric config coerced (`numOrNull`) so junk can't overwrite a good VAT/ceiling.
  - `syncEngine.ts` `pullCatalogue` refactored **node-first**: `fetchReferenceFromNode()` → if a
    bundle, `unpackNodeBundle` feeds the SAME write transaction and skips the cloud's 7+N calls;
    else the cloud path runs **unchanged**. Additive by construction — `fetchReferenceFromNode`
    returns null for a node, a till with no `node_url`, or any node problem, so only a peer with
    a live node behaves differently; every other device is byte-for-byte as before. Config
    persistence hoisted into `applyReferenceConfig` (shared by both paths) so a node-fed peer
    updates VAT/receipt/etc. too. Write transaction untouched.
  - New `apps/desktop/test/node-reference-unpack.test.mjs` (19, mutation-checked): breaking the
    `tablesFetched` don't-wipe guard turns the named assert red. Wired into `test:desktop` + CI.

**Bench green (both batches):** desktop `tsc -b` clean; `test:refbundle` 25/0 + `test:refunpack`
19/0, both mutation-checked; `check-test-registration` + `check-register-consistency` OK. **Still
target-only (rule 16):** the SQL reads, the real node↔peer exchange, a peer actually re-pointing
its catalogue to the node with the cloud cut. **To CLOSE A24:** on two tills + a node, edit a
price on the dashboard, let the node sync, cut the peer's cloud, confirm the peer picks up the
new price FROM the node and two tills never sell one item at two prices; and that a peer whose
node is unreachable still falls back to the cloud. Desktop version bump due at the next build
(rule 15). Delivery: MANIFEST-2026-08-25-b.md (supersedes -a).

### A162 · P1 · OPEN · Node now forwards peer sales to the cloud — the A19 relay (node-side half built)
Builds A19 §3 (the money-path leg, owner-agreed 08-09; see A19). A peer with no internet reaches
the branch node over the LAN, so branch reports are right, but its own cloud `sync_queue` never
drains and nothing forwards it — the cloud (web dashboard, eTIMS, cloud loyalty, backup) never
sees those sales. This slice makes the node forward them.

**Key source finding that shaped the design (rule 5).** The register left "stash vs reconstruct"
open. Reading the cloud ingest settles it: `apps/server/src/routes/orders.ts:467` ALWAYS re-prices
an order from its `items` against the current catalogue and stores THAT as authoritative — it does
not trust a client total ("Finding #19", :478-487). Re-pricing needs each line's variant/modifier
selections, but the node's replicated order lines (`ORDER_ITEM_COLUMNS`, `nodeIngest.ts`) carry
none — those tables don't cross the LAN. So a payload REBUILT from the node's tables would be
re-priced without the paid modifiers and stored SHORT by every modifier charge, silently. **Stash
is therefore mandatory, not optional:** the node must forward the peer's ORIGINAL payload verbatim.

**BATCH -c 2026-08-25 — NODE-SIDE HALF BUILT (bench, Linux/Node-22 ceiling, rule 9).**
  - NEW `apps/desktop/src/main/peerRelay.ts` — pure `buildPeerRelay(orderRow)`: decides whether a
    freshly-applied peer order can be forwarded and returns the payload if so. Refuses (order still
    lands for branch reports, just isn't forwarded — the pre-A19 status quo) when it can't be done
    faithfully: no `_relayPayload` (old peer — NOT reconstructed lossily), no items/payments (would
    400 on the cloud forever and park the sale), or an idempotency_key/device_id that disagrees with
    the row it rode in on (would collapse two sales onto one cloud order). Guarantees
    `idempotency_key === orderId`.
  - `nodeIngest.ts` — new `enqueuePeerRelay` writes the payload into the node's own `sync_queue`
    (`INSERT OR IGNORE`, `order_id` is UNIQUE); wired into `applyPeerRows` inside the SAME
    transaction as the order insert, in the new-order branch only (a re-offered duplicate never
    re-enqueues). The node's existing `pushPendingOrders` then relays it with
    `X-Idempotency-Key = order_id`. `IngestResult.relayed` counts forwards.
  - **Three independent guards against double-counting:** `sync_queue.order_id` UNIQUE + INSERT OR
    IGNORE; the peer's stable id as the idempotency key; the cloud's `(business, idempotency_key)`
    short-circuit. A peer on the old build pushing straight to cloud AND this node forwarding the
    same order converge on ONE cloud row — the mixed-version window is safe.
  - NEW `apps/desktop/test/peer-relay.test.mjs` (18, mutation-checked): breaking the empty-items
    guard or the idempotency-mismatch guard turns the named asserts red. Wired into `test:desktop`
    + CI.

**Bench green:** desktop `tsc -b` clean; `test:peerrelay` 18/0, mutation-checked (empty items → 2
named FAILs; idempotency mismatch → 1 named FAIL); `check-test-registration` + `check-register-
consistency` OK.

**STILL TO BUILD — peer-side half (next slice, money path):** in `fillNodeOutbox` attach the peer's
original cloud payload to the order row as `_relayPayload` (faithful source: `receipt_payloads`,
which holds the full items incl. variants/modifiers), and stop the peer double-pushing to its own
cloud `sync_queue` when it has a `node_url` — with the register's 404 fallback (an old node that
doesn't accept the forward → the peer keeps enqueuing `sync_queue` so a sale is never parked).

**BATCH -d 2026-08-25 — PEER-SIDE CARRY BUILT (bench, Linux/Node-22 ceiling, rule 9). The relay is
now end-to-end on the bench; closes on the two-till+cloud target.**
  - NEW shared `peerRelay.buildCloudOrderPayload(orderPayload, ctx)` — the single source for the
    cloud /api/orders payload. `createLocalOrder` (syncEngine) now builds its own `sync_queue`
    payload through it too (output-identical refactor of the former inline object), so the till's
    DIRECT push and the node's FORWARD of the same order are byte-for-byte the same shape. This
    matters because the cloud dedupes by returning the existing row unchanged — whichever arrives
    first wins, so the two must not diverge.
  - `fillNodeOutbox` (nodeIngest) now attaches `row._relayPayload` for orders, rebuilt via the
    shared builder from the till's stored raw payload (`receipt_payloads` — the faithful items with
    variants/modifiers) plus the row's own envelope (device_id/shift_id/created_at). It rides to the
    node in the existing node_queue row; slice -c's `buildPeerRelay` then accepts it and forwards it.
  - **Deliberately NOT done this slice (money-path caution): the peer still double-pushes** — it
    keeps enqueuing to its own `sync_queue` as before. Idempotency makes that safe (the cloud
    dedupes on the peer id), so correctness never depends on the relay working — the relay is a pure
    ADDITIVE accelerator, and if a payload is ever missing/imperfect the order still reaches the
    cloud the old way. If `receipt_payloads` is pruned/unparseable, `_relayPayload` is simply left
    unset (order lands on the node, reaches cloud via the till's own push) — no stranding. Stopping
    the double-push (register change-point #1, with its 404 fallback + a cached node-capability
    flag) is its own later slice, once the relay is proven on real hardware.
  - Tests: `peer-relay.test.mjs` extended to 28 (mutation-checked) — the shared builder's guards
    (drop kot_sent; mark legs 'completed' or the cloud reports M-Pesa unaccounted, A93) each turn a
    named assert red when broken, plus a round-trip proving a modifier price survives build →
    forward (the under-total the stash design exists to prevent).

**Bench green (node-side + peer-side):** desktop `tsc -b` clean; `test:peerrelay` 28/0,
mutation-checked; `check-test-registration` + `check-register-consistency` OK.

**Target-only to CLOSE A19 (rule 16):** a live node + peer + cloud — a peer sale reaches the cloud
exactly ONCE, attributed to the peer's device, with no duplicate; and a modifier order's cloud
total matches the receipt (proving the stash prevents the under-total). Sequenced LAST per PHASE5
§8, ideally after D3 auto-update. Desktop version bump due at the stop-double-push slice (rule 15).
Delivery: MANIFEST-2026-08-25-d.md.

### A163 · P1 · OPEN · Node now replicates the staff roster to peers — the A20 failover channel (built on bench)
Builds A20 (owner-gated; the owner accepted replicating the branch's bcrypt PIN hashes to every
peer, PHASE5 §10.1 "a branch is one trust domain", with the PIN-rotation-on-missing-terminal
runbook as mitigation). A promoted till already holds every sale via distribution but an empty
`branch_staff` authenticates no one — so failover can't open the shop, the moment it exists to
prevent. This replicates the roster down the SAME snapshot channel A24 established (A20 is a special
case of it), kept as a SEPARATE endpoint because it carries credentials.

**Key source constraint that shaped the design (rule 5).** `branch_staff.pin_hash_enc` is bcrypt
wrapped with `safeStorage`, which is bound to the machine/OS account that wrapped it — a peer cannot
decrypt the node's wrapped form (`verifyPinAtNode` already handles "wrapped under another OS
account"). So the channel ships RAW bcrypt: the node unwraps to serve, each peer re-wraps with its
own safeStorage via the existing `storeBranchStaff`. This mirrors exactly how the node itself
sources the roster from the cloud (raw in, wrapped locally).

**BATCH -e 2026-08-25 — BUILT (bench, Linux/Node-22 ceiling, rule 9). End-to-end on the bench;
closes on the two-till failover target.**
  - NEW pure `apps/desktop/src/main/rosterSnapshot.ts` — `buildRosterSnapshot` (node reshape, keeps
    only offline-usable bcrypt staff + a content version) and `unpackRosterSnapshot` (peer's
    apply-decision). THE LOCKOUT GUARD lives here: an empty or all-pinless snapshot is refused
    (`apply:false`) — a branch always has staff, so that is always a failed pull, and applying it
    through the wholesale DELETE+INSERT would leave a peer that authenticates no one. Unlike dining
    tables (legitimately empty), the roster is never legitimately empty.
  - `branchStaff.ts` — `readBranchStaffForServe` unwraps `pin_hash_enc`/`override_pin_hash_enc` back
    to raw bcrypt for the node to serve (skips any row it can't unwrap).
  - `nodeServer.ts` — new `POST /node/roster` (branch-gated + X-Node-Secret, after /node/reference).
  - `nodeClient.ts` — `fetchRosterFromNode` (peers only; null on any node problem → keep local).
  - `syncEngine.ts` — `pullCatalogue` tail: a PEER pulls `/node/roster` and, if the guard permits and
    the version changed, replaces its roster via `storeBranchStaff`. Guarded twice (null pull + the
    lockout guard); in-memory version-skip avoids re-wrapping an unchanged roster each sync. Nodes
    keep sourcing from the cloud unchanged.
  - `ipcHandlers.ts` — `tech:promoteToNode` pulls a fresh roster from the current node BEFORE the
    role flip (a node has no node_url to pull from), so a freshly promoted peer authenticates at once.
  - NEW `apps/desktop/test/roster-snapshot.test.mjs` (16, mutation-checked): breaking the lockout
    guard (apply an empty/pinless roster) or the bcrypt filter turns named asserts red. Wired into
    `test:desktop` + CI.

**Bench green:** desktop `tsc -b` clean; `test:roster` 16/0, mutation-checked (empty/pinless apply →
2 named FAILs; keep non-bcrypt → 1 named FAIL); `check-test-registration` + `check-register-
consistency` OK.

**Target-only to CLOSE A20 (rule 16):** two tills + a node — the node's roster reaches a peer; that
peer, cut from the cloud, authenticates a cashier by PIN against the replicated roster; a
deactivated staff member disappears on the peer after the next pull; and `tech:promoteToNode` on a
peer yields a node that can immediately sign staff in. Sequenced after A19 per PHASE5 §8, ideally
after D3. Desktop version bump due at the next build (rule 15). PIN-rotation-on-missing-terminal
runbook to be added to ops docs (owner mitigation). Delivery: MANIFEST-2026-08-25-e.md.

### A164 · P1 · OPEN · Till runs as the owner and bypasses the write-guard — the cloud device-grant (Phase 1, server half built)
Builds SCOPE-node-authority **Phase 1 (cloud device-grant)** — the foundation the node-broker
(Phase 2) and node-mint (Phase 3) build on, and a real security fix in its own right.

**The security issue, found at source (rule 5).** A till runs on the OWNER token minted at
`/enrol/redeem` (`isOwner:true`, `['*']`). Minting the device-grant `isOwner:false` is a real
reduction for three reasons: it can no longer reach web-only features (`requireWebSurface`'s
`isOwner` bypass at `auth.ts:226` no longer applies to it); rbac branch-locks it to its own branch
(an owner token may read any branch); and it becomes subject to the per-request account-status +
permissions-version recheck (`auth.ts:111` runs only for `!isOwner`), so revoking the owner stops
the device.

**CORRECTION (2026-08-25, during the A159 audit — rule 7).** An earlier version of this entry, and
of the code comments/test labels shipped in batch -f, said the A159 terminal write-guard "skips
owner tokens (`auth.ts:226`)" and that `isOwner:false` is "what makes the write-guard apply." That
was wrong: `auth.ts:226` is `requireWebSurface` (a different guard). The terminal write-guard
(`terminalWriteDenied`, `auth.ts:256`, wired at `:152`) gates on `surface === 'desktop'` ALONE and
does NOT check `isOwner` — so it already bounds today's owner till by surface. The A164 code
(`isOwner:false`) is unchanged and still correct for the three reasons above; only the write-guard
attribution was wrong and is corrected here and in `deviceGrant.ts` / `device-token.test.mjs`
(batch -g).

**BATCH -f 2026-08-25 — SERVER HALF BUILT + BENCH-VERIFIED (real server tsc + real Postgres via
PGlite, a STRONGER green than the desktop legs — rule 9). Inert: nothing calls it yet.**
  - `migrations/92_device_grant_secret.sql` — adds nullable `user_devices.device_secret_hash` +
    `device_secret_set_at`. Additive, idempotent, self-records. **PROD-MIGRATE.**
  - NEW `apps/server/src/lib/deviceGrant.ts` — pure `generateDeviceSecret` / `hashDeviceSecret`
    (sha256; high-entropy secret, matches the enrolment-code discipline) / constant-time
    `verifyDeviceSecret` / `isDeviceGrantable` (approved|active only — how a revoked/pending
    terminal is refused) / `buildDeviceTokenPayload` (the `isOwner:false`, branch-bound claims).
  - `auth.ts` `/enrol/redeem` — now also mints a per-device secret, stores the hash, returns the
    raw once. Best-effort + additive: enrolment never fails over it; an old device just has none.
  - `auth.ts` — new `POST /api/auth/device-token`: device_id + secret → verify (uniform failure) +
    grantable-status + not-suspended → mint an `isOwner:false`, branch-bound, `surface:desktop`
    session for the device's owner principal.
  - Tests: NEW `tests/device-token.test.mjs` (21, mutation-checked — minting `isOwner:true` or a
    verify that accepts any secret turns named asserts red) + `scripts/test-migration-92.mjs`
    (9, real PGlite, additive + idempotent + self-record).

**Bench green:** server `tsc` clean; `device-token` 21/0 (mutation-checked); migration 92 9/0 on
real Postgres; schema-drift / api-schema-drift / table-usage / sql-binds / supabase-catch /
api-routes / test-registration / rls-coverage / register-consistency all OK.

**STILL TO BUILD — the desktop cutover (next slice, the risky half):** the till stores its returned
`deviceSecret` (safeStorage) and, on refresh failure, calls `/device-token` BEFORE dropping to the
enrol screen. That switches the till to a NON-OWNER principal, so it must be verified on real
hardware that the till still sells and reads branch data as `isOwner:false` (branch-locked by rbac),
and it MUST ship only after `TERMINAL_WRITE_ENFORCE=true` (else the reduced token is unbounded — the
guard only logs in dry-run). A revocation path at the node is required before Phase 3.

**Target-only to CLOSE (rule 16):** prod-migrate 91→92; the endpoint end-to-end against a real DB;
the desktop cutover on two tills (recover a lapsed session without owner re-login; till still sells
and pulls catalogue as a device principal). Sequence A159-enforce before the cutover. Delivery:
MANIFEST-2026-08-25-f.md.

### A165 · P2 · CLOSED 2026-08-31 · One menu upload for everything — sparse, name-keyed import (products slice built)
**CLOSED 2026-08-31 (browser-confirmed).** Products → Menu upload parsed a 2-row
`.xlsx` (Products tab 2 / ok; other tabs "—"), cancelled without apply. Slices 1-3
(batches -h/-i/-m) reachable and parsing. Note: takes `.xlsx`, not `.csv`; preview
is a tab-level row count, not per-field. Agent report 2026-08-31.
An owner asked for a single upload point: fill products, upgrades/spices, recipes and ingredients
in one workbook; re-upload only a slice later (say just upgrades) and have it update ONLY what the
file carries, matched by product name. The old bulk import was the opposite — a full-row overwrite
that required price every time and wiped any column you left out (`products.ts`, pre-A165).

Design (owner-agreed): a multi-tab Excel (Products · Upgrades & Spices · Recipe · Ingredients), each
tab name-keyed and SPARSE. Blank/absent = leave alone; the literal `DELETE` clears; an optional
`plu_code` is the rename-safe key; an uploaded choice group replaces its own options. The universal
downloadable template is `swiftpos-restaurant-import-template.xlsx` (not branded to any one venue).

**BATCH -h 2026-08-25 — SLICE 1: SPARSE PRODUCT UPSERT (server) built + bench-verified (real server
tsc + real logic tests — rule 9).**
  - NEW pure `apps/server/src/lib/productImport.ts` — `buildProductPatch(row, opts)` sets ONLY the
    columns present (blank/absent omitted → field untouched; `DELETE` → null); price required only on
    CREATE; validates sold_by/tax_type/source/status/booleans; accepts friendly aliases
    (price→base_price, category→category_name). `rowMatchKeys` gives barcode→plu→name.
  - `products.ts` `POST /api/products/bulk` rewired: matches barcode → plu_code → name, sparse patch
    on update, insert on create, and AUTO-CREATES categories named in the file. Backward-compatible —
    a full-row single-tab CSV still imports identically; the change is that a missing column no longer
    wipes, and plu/category-create are new. (is_fuel is no longer set from import — restaurant scope;
    new products default non-fuel, existing untouched.)
  - NEW `tests/product-import.test.mjs` (24, mutation-checked): breaking the sparse-omit rule or the
    price-required-on-create rule turns named asserts red.

**Bench green:** server `tsc` clean; `product-import` 24/0 mutation-checked; api-routes / sql-binds /
supabase-catch / table-usage / schema-drift / test-registration / register-consistency OK.

**BATCH -i 2026-08-25 — SLICE 2: CHOICES + RECIPE IMPORT ENDPOINTS (server) built + bench-verified.**
  - `productImport.ts` gains two pure builders: `buildChoiceImport` (groups the Upgrades & Spices
    rows by product+group, classifies free→kind 'choice' / upgrade→kind 'upgrade', and enforces the
    two rules that matter — a FREE choice may carry no price, an UPGRADE must have a 0 baseline or it
    charges everyone the cheapest step) and `buildRecipeImport` (groups Recipe rows per product,
    positive-quantity required, DELETE drops a line).
  - NEW `POST /api/variants/bulk` — name-keyed; upserts a variant group and REPLACES its options
    wholesale, sets `kind`, flips the product's `has_variants`; option=DELETE removes the group.
  - NEW `POST /api/recipes/bulk` — name-keyed; a product in the file has its recipe replaced (matched
    by product name/plu + ingredient name); a single unknown ingredient fails that product cleanly.
  - Ingredients tab reuses the existing `POST /api/stock/ingredients/bulk` (A141) — no new endpoint.
  - NEW `tests/menu-import.test.mjs` (18, mutation-checked): breaking the free-no-price or the
    upgrade-baseline-0 rule turns named asserts red.

**Bench green (slice 2):** server `tsc` clean; `menu-import` 18/0 + `product-import` 24/0, mutation-
checked; api-routes / sql-binds / supabase-catch / table-usage / schema-drift / test-registration /
register-consistency OK.

**BATCH -m 2026-08-25 — SLICE 3: unified "Menu upload" on the DASHBOARD (not the desktop — the till
is sales-only; the dashboard already owns products/ingredients/recipes, per the day's UX discussion).
Dashboard `tsc` 0 errors (deps incl. new SheetJS, rule 9).**
  - NEW `apps/dashboard/src/pages/products/MenuUpload.tsx` — one workbook in: reads the four tabs
    (SheetJS), previews per-tab row counts + structural errors client-side, then applies in dependency
    order Ingredients → Products → Upgrades → Recipe (so recipe rows resolve names the earlier tabs
    created). "↓ Template" generates `swiftpos-restaurant-import-template.xlsx` client-side (no static
    asset). Ingredients need a specific branch selected (opening stock is per-branch) — blocked with a
    message otherwise.
  - `ProductsPage.tsx` — the old single-purpose "Import CSV" button is replaced by "Menu upload"
    (the "one place" decision). `xlsx` (SheetJS) added to dashboard deps.
  - Reuses the slice-1/2 endpoints unchanged: `/api/stock/ingredients/bulk`, `/api/products/bulk`,
    `/api/variants/bulk`, `/api/recipes/bulk`.
  - **Preview is client-side/structural** (row counts + missing-required-field), NOT a server diff
    (create-vs-update counts) — that needs dry-run modes on the import endpoints, a noted enhancement.
    The server still validates every row and reports per-row errors on apply.
  - The stock page's separate `BulkIngredientImport` is left in place; the unified uploader now also
    covers ingredients, so that one can be retired later. No new unit test: UI over already-tested
    endpoints; no new pure server logic.

**Target-only:** the whole flow end-to-end on a running dashboard against a real DB (parse → preview →
apply → per-row results); a real multi-tab file. Delivery: MANIFEST-2026-08-25-m.md.

### A166 · P2 · CLOSED 2026-08-31 · Day-to-day bulk price changes without a spreadsheet ("all sodas +20 / +10% / round")
**CLOSED 2026-08-31 (browser-confirmed).** Products → Bulk price, "Family Meals"
+10% previewed exact deltas (3990→4389, 3250→3575, 2820→3102, "9 will change");
cancelled, prices unchanged after. Agent report 2026-08-31.
Follows the day-to-day-UX discussion: the file importer (A165) is right for setup and big/structural
changes, but the weekly job — nudge a category's prices — shouldn't need a spreadsheet. The dashboard
had bulk editors for COST and TAX but not for PRICE (the most common change), and single edits went
through a modal. This adds an in-place bulk PRICE tool with relative operations + a preview.

**BATCH -j 2026-08-25 — built + bench-verified (server helper tested for real; dashboard type-clean).**
  - NEW pure `apps/server/src/lib/priceOps.ts` — `applyPriceOp(current, op)` for set / plus (±) /
    percent (±, discount capped at 100%) / round-to-nearest, money-rounded to 2dp, with a
    negative-result guard (a bulk op must never silently zero or negate a price). `parsePriceOp`
    validates the request.
  - NEW `POST /api/products/bulk-price` (products.ts) — one endpoint, two modes: `dry_run` returns the
    old→new PREVIEW without writing; otherwise it applies. Both compute with the SAME `applyPriceOp`,
    so the preview a user confirms is exactly what's written. Scoped by explicit ids or one category
    — never the whole catalogue by accident; a no-op row is skipped, an errored row reported.
  - NEW dashboard `products/BulkPriceEditor.tsx` + a "Bulk price" button on the Products page: pick a
    category, pick the op, PREVIEW the exact old→new table (errors in red), then Apply. In-place, no
    file. Single-item price tweaks still live as inline product edits (the right tool for one price).
  - NEW `tests/price-ops.test.mjs` (21, mutation-checked): breaking the percent calc (/100→/10) or
    removing the negative guard turns named asserts red.

**Bench green:** server `tsc` clean; `price-ops` 21/0 mutation-checked; dashboard `tsc` 0 errors (real
— deps installed, rule 9); api-routes / sql-binds / supabase-catch / table-usage / schema-drift /
test-registration / register-consistency OK.

**BATCH -k 2026-08-25 — row-level selection (dashboard only; server already supported it).**
  - Products table gets per-row checkboxes + a select-all (over the filtered view) + a "N selected →
    Change price" bar. `BulkPriceEditor` gains an optional `productIds` scope: when a selection is
    passed it targets exactly those items (sends `ids`) instead of a category; otherwise unchanged.
    No server change — `/api/products/bulk-price` already accepted `ids` from batch -j. Dashboard
    `tsc` 0 errors (deps installed, rule 9); no new unit test (no new pure logic — the ids path and
    its money math were already covered by `price-ops`). Delivery: MANIFEST-2026-08-25-k.md.

**BATCH -l 2026-08-25 — tier-1 inline price edit (dashboard only; no server change).**
  - The Products table price cell is now click-to-edit: click → number input → Enter or blur saves,
    Esc cancels. Optimistic (the row updates immediately) and reverts on failure, with a small toast.
    Uses the existing partial `PATCH /api/products/:id` with `base_price` only — every other field is
    left alone. Right tool for a single one-off price; the bulk tool stays for many. Dashboard `tsc`
    0 errors (rule 9); no new unit test (UI + an already-partial endpoint, no new pure logic).
    Delivery: MANIFEST-2026-08-25-l.md.

**STILL OPEN / next:** a fast availability/86 toggle — and 86-on-the-till was flagged as a floor
action, not back-office, so decide its home separately (a `toggleStatus` already exists on the
dashboard for active/inactive). **Target-only:** the endpoints end-to-end against a real DB; the
editors on a real dashboard. Delivery: MANIFEST-2026-08-25-j.md.

### A159 · P2 · OPEN · A stolen till token could write dashboard data — device-surface write guard (dry-run shipped, enforce pending)
Phase 2 of the terminal-credential hardening (A158 removed the owner *password* from
tills; this addresses a *stolen token*). The enrolment/desktop token is owner-scoped
(`isOwner`), and `requireWebSurface` bypasses on `isOwner`, so a till token extracted
from a device could hit dashboard-mutation endpoints (products, prices, users, settings
— **179 write routes**) and edit anything. Root cause: the surface claim isn't enforced
on writes because owner-scope overrides it.

**DRY-RUN SHIPPED 2026-08-24 (batch -h) — OPEN P2 pending enforce + verification.**
New guard in `middleware/auth.ts`, gating on the `surface: 'desktop'` claim directly
(independent of owner-scope), inside `requireAuth` so it covers every authenticated
route in ONE place:
  - `terminalWriteDenied(surface, method, path)` — a desktop-surface WRITE is denied
    unless its path is in the till's allowlist: `/api/orders`, `/api/sync/push`,
    `/api/branch-prices/sync`, `/api/auth/*`, `/api/tech/*` (the till's complete write
    set, traced from `syncEngine.ts`). Reads and web-surface are never gated.
  - **Default-deny by surface + short allowlist** was chosen over guarding 179 endpoints
    one by one: a *new* dashboard endpoint is denied to terminals by default, and the
    blast radius is the allowlist, not the whole write API.
  - **Ships DRY-RUN** (`TERMINAL_WRITE_ENFORCE` unset): logs `would block` and lets the
    request through, so a missed allowlist entry **cannot break sync** on a money system.
    Flip `TERMINAL_WRITE_ENFORCE=true` on the server to enforce (403 `TERMINAL_WRITE_FORBIDDEN`).
Test: `tests/terminal-write-guard.test.mjs` (19 assertions; dashboard writes denied,
till writes + reads + web allowed; mutation-checked — dropping an allowlist entry denies
that till write). Bench green; server tsc clean; existing auth/permission tests
unaffected (dry-run is transparent).
**To CLOSE (owner):** (1) run the new build with dry-run for a few days, watch the
`[terminal-write-guard] DRY-RUN … would block` logs, add any legitimate till write that
appears to the allowlist; (2) once the logs are clean, set `TERMINAL_WRITE_ENFORCE=true`;
(3) confirm on a till that sales/sync still work and a crafted desktop-surface POST to
`/api/products` returns 403. Delivery: MANIFEST-2026-08-24-h.md.

**ENFORCE-READINESS AUDIT 2026-08-25 (batch -g) — one allowlist GAP found + closed.**
Static-traced every desktop→cloud write in the current tree (`method:'POST'|PUT|PATCH|DELETE`,
excluding `/node/*` LAN calls) and cross-referenced each against the allowlist. All matched EXCEPT
**`/api/shifts/:id/close` and `/api/shifts/:id/force-close`** (`syncEngine.ts:1655`) — the till's own
shift-close writes, missed by the original literal trace because they go through a `fetch(url)`
variable, not a literal path. Because the guard gates on `surface` (not `isOwner`), this gap would
have 403'd shift close on EVERY live till the moment enforce flipped — not just post-A164-cutover.
Closed by adding a TIGHT allowlist entry `^/api/shifts/[^/]+/(close|force-close)` (a shift
DELETE/create from a till stays denied). `terminal-write-guard.test.mjs` extended 19→23
(mutation-checked: dropping the shift entry reddens the source assertion). Server tsc + gates green.
**Verdict:** with this gap closed, the allowlist covers every cloud write in the current desktop
tree. Before flipping `TERMINAL_WRITE_ENFORCE=true` in production, still confirm the dry-run logs
show no `would block` for a legitimate write (catches older field builds and anything static
analysis can't see) — that empirical check remains the close condition. Delivery:
MANIFEST-2026-08-25-g.md.

### A157 · P2 · OPEN · Input-validation schemas written but never wired — `LoginSchema`, `CreateProductSchema`, `UpdateProductSchema`, `CreateCategorySchema`
`apps/server/src/lib/schemas.ts` defines Zod schemas for these endpoints, but no
route uses them (0 importers). The routes read `req.body` raw — e.g. `/login`
(`auth.ts:556`) does `const { email, password, business_id } = req.body` with no
`.parse()`. So validation was authored and left unconnected (rule 17), and the
endpoints accept unvalidated input. **Why this is NOT a mechanical wire (and was
deliberately not auto-fixed under the 2026-08-24 "no breakage" instruction):** the
`validate()` middleware does `req.body = result.data`, and Zod `z.object()` (no
`.strict()`) **strips unknown keys**. Each schema is *incomplete* relative to what its
route reads, so wiring as-is would silently DROP live fields:
  - `LoginSchema` has only `email`/`password`/`business_id`, but `/login` +
    `/desktop-login` also read `device_id`, `app_version`, `terminal_code`,
    `device_role`, `device_hint` — wiring would strip them and **break device
    binding, version reporting, and terminal enrolment on sign-in.** (It also does not
    fit the other auth handlers — `pos-login`, refresh, etc.)
  - `CreateProductSchema`/`UpdateProductSchema` cover 8 fields; the product handlers
    read more (tax fields, etc.) — stripping would break product create/update.
  - `CreateCategorySchema` (name/color/icon/sort_order) needs the same per-handler check.
**Safe path (needs a target/live pass, rule 16):** for each route, enumerate the FULL
accepted field set, extend the schema to match (or add `.passthrough()` to validate
known fields without stripping), wire `validate(Schema)`, then live-test the money/auth
path before closing. Filed 2026-08-24 (surfaced during the A156 dead-export sweep).

**RECONCILIATION MAP 2026-08-24 (batch -f) — payload-level, confirmed against the live
clients. NOT wired: force-wiring as filed would 400 currently-valid production
requests (proven below), so A157 stays OPEN pending per-route reconciliation + a target
test.** Evidence from the actual dashboard payloads + handler reads:

  • **`CreateProductSchema` / `UpdateProductSchema` — UNSAFE, money path.** `ProductsPage.tsx`
    (~:169) sends `description: form.description.trim() || null` and `image_url` that can be
    `''`. The schema has `description: z.string().max(500).optional()` (rejects **null**) and
    `image_url: z.string().url()...` (rejects **`''`**) — either makes a normal product
    create/update **400**. The handler (`products.ts:90-99/174-184`) also reads 13 fields the
    schema lacks (`barcode, plu_code, sold_by, is_fuel, fuel_unit, cost_price, reorder_level,
    pieces_per_unit, unit_label, source, tax_type, kra_item_class_code, is_kitchen`) — plain
    wiring strips them. To wire safely: add the 13 fields (or `.passthrough()`), make
    `description`/`image_url` `.nullable()` and tolerate `''`→null, and confirm no live
    payload exceeds the `.max()`s — then live-test a real create AND edit (prices/tax).
  • **`CreateCategorySchema` — closest to safe, but not free.** `CategoriesPage.tsx:59-62`
    sends `{name, color, sort_order}`; `color` is always a palette 6-hex (`COLORS`, matches
    the regex) and `sort_order` a number, so the CREATE payload fits. Residual risks: `name`
    is `.max(80)` (a longer existing-flow name would newly 400), and the handler also reads
    `super_category`/`is_kitchen` (strip → need `.passthrough()`). The PATCH route
    (`categories.ts:45-47`) reads `status` too and has **no `UpdateCategorySchema`** — do not
    point Create at it. Wire POST only, `.passthrough()`, verify the name length against the
    DB column, then it is the one low-risk close.
  • **`LoginSchema` — UNSAFE, auth path.** Already noted: `/login` also reads `device_id`
    (`auth.ts:122`); wiring strips it → device binding breaks. Additionally `.email()` could
    reject an email the current raw handler accepts, locking a real owner out. Reconcile the
    device fields AND target-test a real sign-in before touching this at all.

Recommendation: this is a per-route reconciliation + live-test job, not a bench close;
the lowest-risk first step is category POST with a `.passthrough()` schema after a
DB-column length check. No code shipped in -f — the map is delivered so the eventual
wiring is mechanical and safe. Delivery: MANIFEST-2026-08-24-f.md.

### A140 · P2 · CLOSED 2026-08-31 · Product/menu bulk CSV import unreachable outside Minimart
**CLOSED 2026-08-31 (browser-confirmed; superseded by A165).** The importer was
folded into the unified "Menu upload" on ProductsPage, reachable for all business
types. Confirmed parsing a 2-row test workbook (Products tab 2 / ok). Note: the
unified upload takes `.xlsx`, not `.csv`. Agent report 2026-08-31.

`POST /api/products/bulk` (CSV, ≤500 rows, `products.manage`) is fully built, and
so is its client UI — a "Bulk Import" tab with a downloadable template
(`swiftpos_products_template.csv`), a `.csv` picker, `FileReader.readAsText`, and
the POST — but it lives ONLY in `MinimartSettingsPage.tsx`, and
`BusinessPage.tsx` renders that page solely for `case 'minimart'`. A
restaurant/café owner works from `ProductsPage.tsx` (the general menu page),
which has no bulk-import entry point at all, so the importer is unreachable for
every non-minimart type. Classic rule-17 shape: complete at every layer except
one wire. FIX (delta): surface the existing importer (template + `.csv` picker →
`/api/products/bulk`) on the general Products/menu page for all product-carrying
types. No new endpoint. Bench-verified by source read; no browser pass yet
(rule 16).

PROGRESS 2026-08-23 (still OPEN): done on the bench. The importer was extracted
verbatim into a self-contained `apps/dashboard/src/pages/products/BulkProductImport.tsx`
(own parse/validate/POST state; optional `onImported`/`onToast` callbacks) — no
logic duplicated (rule 17). `MinimartSettingsPage` now renders
`<BulkProductImport onImported={loadData} onToast={showToast} />` in its Import tab,
behaviour-identical to before (both couplings preserved). `ProductsPage` gained an
"Import CSV" toolbar button opening the same component in a modal, refreshing via
`fetchAll` on success — so every product-carrying type can now reach it. Both pages
are hardcoded-dark, so the extracted panel fits unchanged. `tsc --noEmit` + `vite
build` green; no dangling refs to the removed minimart state. STILL OPEN pending a
browser pass (rule 16): confirm the button shows and an import runs end-to-end on a
non-minimart business, and that minimart's Import tab is unchanged. Delivery:
MANIFEST-2026-08-23-c.md.

### A141 · P2 · OPEN · No bulk ingredient import (must seed opening stock)
**CORRECTION 2026-08-31 (agent reported "not present" — it IS built).**
`BulkIngredientImport.tsx` is wired into `IngredientsPage.tsx` (import + `showImport`
state) behind an **"Import CSV"** button that renders only when `canManage` is true
and requires a specific branch selected in the top bar (else a toast: "Select a
specific branch … opening stock is per-branch"). In the owner test session, Ingredients
showed **no Add/Import CTA at all** — i.e. `canManage` resolved false there, a
permission/branch-context gap worth checking (why does an owner see no manage CTA on
Ingredients?). Not a missing feature. Re-test with a specific branch selected and the
ingredients/inventory manage permission confirmed. Stays OPEN pending that re-test.

`stock/IngredientsPage.tsx` is single-row-add only — no client CSV path — and
there is no `/api/ingredients/bulk` server-side (the products bulk route has no
ingredient twin). Genuine gap, not an unwire. FIX (delta): a bulk-import endpoint
mirroring `/api/products/bulk` (same ≤500-row cap, likely `inventory.manage`) plus
a template + picker on `IngredientsPage`. **Scope note (owner, 08-23): the import
must also carry opening stock** — an initial quantity per ingredient that writes a
`stock_movements` row, so this touches the stock-movement path and per-branch
stock, not just the ingredient master list. Confirm the opening-stock movement
reason/attribution matches existing adjustments before build.

SHIPPED 2026-08-23 (dev; OPEN pending browser + a live stock check). New
`POST /api/stock/ingredients/bulk` (`stock.ts`, gated `ingredients.manage`, ≤500
rows) mirrors `/api/products/bulk` — re-import UPDATES by lower-cased name, never
duplicates — and, per the 08-23 scope note, seeds OPENING STOCK through the
existing `applyIngredientStockIn` helper (the same `adjust_ingredient_stock` RPC +
`ingredient_stock_movements` with `movement_type='opening'` a manual adjustment
uses), so bulk-seeded and hand-entered stock are attributed identically. Opening
stock is applied ONLY to ingredients the import CREATES, so a re-import to fix a
name/cost cannot double-add stock; per-branch `reorder_level` is an idempotent
upsert. `branch_id` is required and scope-checked (opening stock is per-branch).
Dashboard: new `BulkIngredientImport.tsx` (mirrors `BulkProductImport`, template
name,category,unit,unit_cost,reorder_level,opening_stock,notes,is_packaging) behind
an "Import CSV" button on `IngredientsPage`, gated on a specific branch being
selected (same rule as the adjust flow). Verified: server `tsc`/`build`, dashboard
`tsc`/`vite`, permission-parity + table-usage green. NOT verified on the bench: the
`adjust_ingredient_stock` RPC + stock write (needs a live DB, rule 16) — live-test
a small import and confirm the ingredients appear and opening stock lands in the
chosen branch with an 'opening' movement. Delivery: MANIFEST-2026-08-23-u.md.

### A142 · P3 · CLOSED 2026-08-31 · No bulk product-image upload
**CLOSED 2026-08-31 (browser-confirmed).** Products → Bulk images auto-matched 2/2
test files to the correct products by filename ("2 of 2 matched · 0 to skip"),
preview correct; closed without uploading. Agent report 2026-08-31.

Single-image upload works: `lib/upload.ts` → Cloudinary (unsigned preset), wired
only into `ProductsPage` (`accept="image/*"`, single, no `multiple`). No
multi-file input and no filename↔product matcher anywhere. Bulk IS feasible (loop
the existing `uploadImage`, or add `multiple`), but needs a decision on how images
map to products — by SKU/barcode/filename — since no matcher exists today. Also
`upload.ts` is cloud-only (its local/VPS branch is a TODO). FIX (delta):
multi-select + a filename-mapping rule that loops `uploadImage` and patches each
product's `image_url`. Blocked on the matching-convention decision.

DECISION 2026-08-23 (owner): preview & confirm — auto-match, user fixes mismatches.
SHIPPED 2026-08-23 (dev; OPEN pending browser). New `BulkImageUpload.tsx`
(dashboard-only): multi-select images → each file's name (sans extension) is
auto-matched to a product by **barcode → plu_code → name** (case-insensitive) →
every row shows a product dropdown (default the match, or "skip") the user can
correct → on confirm it loops the existing `uploadImage` (Cloudinary, same as the
single-image path) and PATCHes each product's `image_url` via `/api/products/:id`.
No server change; no rigid filename convention (matching is best-effort and
per-import confirmable). Surfaced behind a "Bulk images" button on `ProductsPage`.
Inherits `lib/upload.ts`'s cloud-only limitation (its local/VPS branch is still a
TODO) — works wherever single-image upload does. Verified: dashboard `tsc`/`vite`
green. Pending: browser test (choose a few files, confirm matches, upload, see
images land). Delivery: MANIFEST-2026-08-23-v.md.

### A143 · P2 · OPEN · Report exports & inventory report — endpoints live, no UI caller
**BROWSER 2026-08-31.** 3 of 6 report tabs have Export Excel (Master/DSR, Hourly
Sales, Item Mix); Menu Matrix / Food Cost / Voids lack it (all in a no-data state).
Master/DSR export hit `/api/reports/master` 200 (downloaded file not inspected in-
session). **No Inventory report tab** exists. Stays OPEN: wire the remaining exports
where wanted; the inventory report is a build decision. Agent report 2026-08-31.

From the endpoint↔caller sweep (rule 6; same class as A8/A73/A130). Of the seven
`GET /api/reports/export/{sales,audit,daily,hourly,pnl,products,shifts}`, only
`export/sales` is wired (`ReportsPage.tsx`, `window.open`); the other six have no
button. `GET /api/reports/inventory` is built with no tab or caller — a dead
report exactly like A130's aggregator. FIX (delta): surface the six remaining
export formats and the inventory report. No server work. Static scan only; no
browser pass (rule 16).

PROGRESS 2026-08-23 (still OPEN): the two clean 1:1 matches are wired —
`HourlyTab` → `/api/reports/export/hourly` and `ItemMixTab` → `/api/reports/export/products`,
each an exact copy of `MasterTab`'s existing xlsx button (same `from/to/branch_id`
params, same `requireWebSurface` + `reports.financial` gate, no permission-gating
added that the shipped button lacks). `tsc --noEmit` and `vite build` both green on
the Linux bench (Node, dashboard Vite build); the file actually downloading is a
browser check, not closed here (rule 16). STILL OPEN: the remaining export formats
(`daily`, `audit`, `shifts`, `pnl`, `expenses`) have no clean tab home, and
`GET /api/reports/inventory` still has no caller — both deferred, not done.
Delivery: MANIFEST-2026-08-23-b.md.

### A144 · P2 · OPEN · Inventory/stock write-actions — endpoints live, no UI caller
**BROWSER 2026-08-31.** New PO and New Transfer dialogs open and cancel cleanly
(Transfer warns "Stock is transferred immediately"); nothing submitted. Row-level
receive/resend could NOT be exercised — no existing PO/transfer rows to act on.
Stays OPEN pending a re-test once real rows exist. Agent report 2026-08-31.

`PATCH /api/inventory/:id/threshold` (reorder threshold is displayed but not
settable — the many "threshold" hits in the client are the `low_stock_threshold`
FIELD, not calls to this endpoint), `PATCH /api/stock/transfers/:id/status`
(approve/complete a transfer — migration 49 machinery), and
`PUT /api/branches/:id/stock/:pid` (direct branch-stock set) are all live with no
client call site. FIX (delta): wire the controls; before surfacing the branch-stock
PUT, confirm it is not superseded by the stock-adjustment path (avoid two writers).

PROGRESS 2026-08-23 (still OPEN): two of the three wired on the bench.
(1) `PATCH /api/inventory/:product_id/threshold` — the reorder threshold on
`InventoryPage` is now click-to-edit (Enter/blur saves, Esc cancels), upserting
`stock_levels.low_stock_threshold` for the active branch; offered only when a
specific branch is selected (same guard as the Adjust modal). (2)
`PATCH /api/stock/transfers/:id/status` — `StockTransfersPage` gained per-row
actions driven by the server's state machine (`pending → in_transit → received`,
or `→ cancelled`); it shows only valid next moves and surfaces both 409s verbatim —
the invalid-transition message and the separation-of-duty self-receipt block (with
a confirm to resend `allow_same_user`, which the server records). (3) The
branch-stock `PUT /api/branches/:id/stock/:productId` was investigated and
**deliberately NOT wired**: it upserts `stock_levels.quantity` AND inserts a
`stock_movements` row, i.e. it is a second writer overlapping the already-wired
`POST /api/inventory/adjust` (the Adjust modal). Wiring it would create two paths
that mutate the same stock — it should be retired or left unused, not surfaced
(rule 17). `tsc --noEmit` + `vite build` green. STILL OPEN pending a browser pass
(rule 16): edit a threshold and confirm it persists + reclassifies low-stock; run a
transfer pending→in_transit→received across two users and confirm stock moves and
the self-receipt block fires; plus the retire-or-keep decision on the branch PUT.
Delivery: MANIFEST-2026-08-23-d.md.

### A145 · P1 · OPEN · Branch↔user assignment endpoints are redundant AND under-guarded — retire them

Re-verified on the source (rule 17), the original framing was wrong twice over.

**(1) Not a UI gap — the capability is already wired, safely.** Assigning users to
branches happens through the staff flow: `StaffTab` (Settings → Users and access)
sends `branch_ids` on create/invite/edit, and `POST`/`PATCH /api/staff` write the
`user_branches` rows — `PATCH /api/staff/:id` does an atomic replace
(delete-by-user then insert from `branch_ids`). `BranchDetailPage` shows the
assigned staff. So `POST /api/branches/:id/assign-user` and
`DELETE /api/branches/:id/remove-user/:userId` are a **redundant second writer** to
the same `user_branches` table (same shape as A144's branch-stock PUT).

**(2) And they are under-guarded — a real authz hole.** Both are `requireAuth`
ONLY: no `requirePermission('staff.manage')`, and no check that `:id` (branch) or
`user_id` belong to the caller's business. They write via the service-role client,
so RLS does not backstop them. Every staff-path route, by contrast, requires
`staff.manage` and enforces business ownership + a non-owner "your branch only"
rule. Consequences, all silent:
  • within-tenant privilege escalation — any logged-in user (e.g. a cashier with
    no `staff.manage`) can assign/remove branch access, incl. granting themselves
    every branch, bypassing the permission the staff UI enforces;
  • cross-tenant write — `branch_id`/`user_id` are unscoped, so a user in one
    business can insert or DELETE `user_branches` rows for another business's
    branch/user (integrity + a remove-user DoS on a competitor's assignments).
    Reads stay gated by the JWT `business_id`, so this is a write/authz hole, not a
    direct read leak — but it is still an unauthorized cross-tenant mutation.

Zero callers in dashboard, admin, desktop, or shared — which is why it went unseen.

FIX (recommended): **retire both routes** (delete them). The safe capability
already exists via the staff path; keeping a weaker duplicate writer is the
liability (rule 20 — if the guard is missing, don't ship the thing that needs it).
Retirement is a server change, no prod-migrate, ships with the server. If for some
reason a branch-centric endpoint must stay, the alternative is to add
`requirePermission('staff.manage')` + business/branch scoping to match the staff
path — but there is no caller that needs it. Retirement patch not shipped yet:
security-adjacent server change, holding for owner go-ahead (rule 12). Priority
raised P2→P1 (silent authz/isolation hole); downgrade if you read the blast radius
as smaller. Delivery of this re-scope: MANIFEST-2026-08-23-h.md.

RETIREMENT SHIPPED 2026-08-23 (dev; still OPEN pending promote): both routes
deleted from `apps/server/src/routes/branches.ts`, replaced with a tombstone
comment so they aren't re-added without guards. Confirmed safe first: zero callers
in dev AND in the deployed `origin/main` (the routes exist on main but nothing
calls them, so removal is safe across the promote window — rule 13). Verified:
server `tsc --noEmit` 0 errors, server `npm run build` exit 0,
`check-permission-parity` green, `check-table-usage` green (`user_branches` still
written by the staff path). `check-api-schema-drift` needs PGlite and can't run on
the bench (fails identically on the untouched baseline — CI-only, rule 9). No
prod-migrate; ships with the next server promote to `main`. Closes on promote +
a quick check that the two endpoints now 404 in production (rule 16). Delivery:
MANIFEST-2026-08-23-i.md.

### A146 · P2 · OPEN · Notifications & webhook observability — endpoints live, no UI caller
**BROWSER 2026-08-31 (FAIL — root cause found).** A test ping reached webhook.site
(200, signed `x-swiftpos-signature`), but the SwiftPOS Deliveries log stayed "No
deliveries recorded yet" even after reload. Cause: `POST /api/webhooks/:id/test`
(`routes/webhooks.ts` ~137-205) returns `{ success, status }` and **never inserts a
`webhook_deliveries` row** — test pings bypass the logging that real deliveries use
via `deliverWebhook`. Fix candidate: have the test route write a `webhook_deliveries`
row (or make the UI state that only real events are logged). The notifications half
is still not built. Stays OPEN. Agent report 2026-08-31.

`POST /api/notifications/test-email` — no "send test" button (ties directly to the
A50/A54 mailer thread: there is a way to test delivery, just no way to trigger it).
`GET /api/webhooks/:id/deliveries` (delivery log) and `POST /api/webhooks/:id/test`
(test-send) — `WebhooksTab.tsx` does CRUD but neither of these. FIX (delta): add
the test-email button and the webhook delivery log + test-send to their settings
pages.

PROGRESS 2026-08-23 (still OPEN): the webhook half is wired. `WebhooksTab` now has,
per endpoint, a "Send test" button (`POST /api/webhooks/:id/test`, result shown
inline) and a "Deliveries" toggle that loads `GET /api/webhooks/:id/deliveries` into
a per-hook log table (time, event, HTTP status colour-coded, attempt count; test
sends refresh an open log). `tsc --noEmit` + `vite build` green. STILL OPEN: the
`test-email` button (`POST /api/notifications/test-email`) is deliberately NOT wired
in this pass — it's the mail piece the owner asked to leave last (and its value is
gated on the A50/A54 mailer being configured); and `GET /api/loyalty/settings`
(returns `{ earnRate }`) has no settings home yet — a small decision on where it
lives. Browser pass pending (rule 16): add a webhook pointing at a request-bin,
send a test, confirm the ping arrives and the delivery row appears with its status.
Delivery: MANIFEST-2026-08-23-j.md.

### A147 · P2 · OPEN · Admin-portal endpoints — live, no caller in the admin app

`PATCH /api/admin/clients/:id/web-access` (web-access expiry), `GET /api/admin/audit`
(admin audit log), and `GET /api/admin/tech/tokens` (issued tech-token list) are
live but called nowhere in the (thin, 5-file) `apps/admin` app. FIX (delta):
surface each in the admin portal.

PROGRESS 2026-08-23 (still OPEN): mostly a correction. On reading the source
(`apps/admin/src/AdminPortal.tsx` is one ~2,300-line file, not "5 files"), **two of
the three were already wired** — the sweep's suffix-matcher had missed them because
their call literals carry a query string: `AuditPage` calls `req("GET",
"/audit?limit=100")` and `TechPage` calls `req("GET", "/tech/tokens?limit=30")`.
So `GET /audit` and `GET /tech/tokens` were false positives (both have sidebar nav
+ working pages). Only `PATCH /clients/:id/web-access` was genuinely unwired — and
it is NOT the same thing as the existing `web_hosting` on/off toggle: per its own
handler comment it sets `businesses.web_access_expires_at`, the date the renewal
ladder measures against. Wired now: the client Overview (`ClientDetailPage`) gained
a "Web access expiry" row showing the current date and a date-picker with Set/Clear
→ `PATCH /clients/:id/web-access`, updating local state on success (`GET /clients/:id`
already returns `web_access_expires_at` via `select('*')`, so no server change).
`vite build` green; admin `tsc` type-check adds **zero** new errors (stays at its
pre-existing baseline of 68 — see observation). STILL OPEN pending a browser pass
(rule 16): set/clear an expiry on a client and confirm it persists.

OBSERVATION (not A147, not fixed here): the admin app's `npm run type-check`
(`tsc --noEmit`) is already red — 68 pre-existing errors, almost all the same class
(`S.input`/inline-style objects widened to `string` vs `CSSProperties`, e.g. every
`style={S.input}`). CI's gate set should be checked against this; if admin
type-check is meant to be a gate it is currently failing independently of A147.
Candidate for its own ID. Delivery: MANIFEST-2026-08-23-e.md.

### A148 · P3 · OPEN · Miscellaneous live-but-unwired endpoints

Lower-value tail of the same sweep: `POST /api/modifiers/options` (create a
modifier option — `VariantsDrawer.tsx` wires DELETE but not create),
`PUT /api/flags/:key` (feature-flag toggle), `GET`/`PATCH /api/qr/settings`
(QR-ordering settings), and `GET /api/loyalty/settings` (read with no consumer).
FIX (delta): wire each, or record it as intentionally deferred.

**Excluded from this sweep on purpose.** External/machine callers, not UI gaps:
`POST /api/mpesa/callback` (Safaricom); `/api/sync/push`, `/api/branch-prices/sync`
(node/till); the `/api/tech/*` set and `/api/devices/:id/authorise-handover`
(tech tooling / `rearm-till.mjs` / desktop); `/api/auth/{desktop-login,pos-login,
refresh,logout}` (desktop/POS). `POST /api/enrol/code` is retired to 410 (A69) —
dead by design, a delete-me not a wire-me. Parking-session endpoints
(`GET`/`PATCH /api/parking-sessions/:id`, `POST /api/parking-sessions/:id/void`)
remain unwired, consistent with the README "ParkingPOS unrouted" note and the
parking-not-live status — tracked there, not reopened here. Deliberately NOT
entered pending a per-page browser check (could be reached via a dynamically-built
path the static scan cannot see): `GET /api/credit/customers`,
`POST /api/auth/set-pin`, `GET /api/products/barcode/:code` (the last smells like a
POS scan path). Delivery: MANIFEST-2026-08-23-a.md.

VERIFIED 2026-08-23 (still OPEN, P3 — each sub-item's true status, none a clean
build): `POST /api/modifiers/options` is NOT redundant but is a minor asymmetry —
`VariantsDrawer` writes options at group-create (`POST /modifiers/groups` with an
`options[]`) and can DELETE an option from a saved group, but has no "add one
option to an existing group" control, which is what this endpoint would power; low
value, needs a small UX decision (where the add-control sits). `PUT /api/flags/:key`
overlaps the admin feature-flag toggle (`PATCH /clients/:id/features/:key`) and has
no owner-dashboard home — needs a decision on whether owners self-manage flags at
all. `GET`/`PATCH /api/qr/settings` and `GET /api/loyalty/settings` (`{ earnRate }`)
each have no settings home in the dashboard, so wiring them means building a small
settings section, not a wire. Recommendation: leave A148 parked at P3 unless a
specific one of these is wanted; say which and it becomes a scoped build. Delivery
of this verification: MANIFEST-2026-08-23-l.md.

### A149 · P3 · OPEN · Admin app has no CI type-check or build — 68 type errors accrued unseen

Found while doing A147 (rule 5). `apps/admin` — a ~2,300-line React portal used by
operators — is **not covered by any CI gate**: `ci.yml`'s typecheck job runs
`node scripts/typecheck-ratchet.mjs server dashboard` (admin omitted) and its build
job builds only server + dashboard. `vite build` strips types without checking them,
so nothing ever runs `tsc` on admin. The ratchet was **designed** to cover it — its
own header says it "guards apps/dashboard and apps/admin", and `WORKSPACES` includes
`admin: 'apps/admin'` — but `scripts/typecheck-baseline.json` is `{ server: 0,
dashboard: 0 }` with no `admin` key, and the CI invocation drops the arg. So the
gate exists and knows about admin; it is simply never asked about it.

Consequence: `tsc --noEmit` on admin is at **68 errors** and has drifted there
unnoticed. 61 are one class (TS2322 — inline style objects, esp. `S.input`/`{ ...S,
… }`, typed as `string` where React wants `CSSProperties`); the rest are a handful of
TS2345/2339/2362/2363/2349. None affects runtime (the app builds and ships via Vite),
which is exactly why it went unseen — and why a genuine type regression, or a build
break, in admin would also sail through CI today.

FIX (delta): add `admin` to the CI ratchet invocation
(`typecheck-ratchet.mjs server dashboard admin`) and seed `"admin": 68` in
`scripts/typecheck-baseline.json` — this gates admin against NEW errors immediately
and turns 68 into a one-way downward ratchet. Then burn the 68 down: most are the
single `CSSProperties` class and clear together by typing the `S`/`C` style-token
objects (`… satisfies Record<string, CSSProperties>` or per-object casts). Add admin
to the CI build job too, so a build break is caught. P3: no runtime impact, but it is
a real hole in the gate discipline the rest of the repo relies on. Docs-only finding;
no code changed here. Delivery: MANIFEST-2026-08-23-f.md.

FIX SHIPPED 2026-08-23 (dev; still OPEN pending first green CI run): admin wired
into CI. `ci.yml` typecheck job now installs `apps/admin` deps and runs
`typecheck-ratchet.mjs server dashboard admin`; the build job now builds admin too;
`scripts/typecheck-baseline.json` gains `"admin": 68`, making 68 a one-way
downward ratchet (new admin type errors now fail CI). Verified on the bench: ran
`node scripts/typecheck-ratchet.mjs server dashboard admin` → green (server 0,
dashboard 0, admin 68 held); `ci.yml` re-validated as YAML; admin `vite build`
green. The 68-error burndown is deliberately NOT attempted here (its own task).
Closes on the first CI run that exercises the new steps. Delivery:
MANIFEST-2026-08-23-l.md.

BURNDOWN COMPLETE 2026-08-23 (dev; still OPEN pending first green CI run): admin
`tsc --noEmit` driven **68 → 0**. Root cause was style-token widening — typing
`const S: Record<string, CSSProperties>` (one annotation) cleared 57; the remaining
11 were contained fixes: mixed-tuple arrays cast to real tuple types (Fleet-Health
stats + the change-password field loop), `askPrompt` results cast to string at 3
sites, a `Date − Date` swapped to `.getTime()`, and a stale `meta.icon` (removed
when TYPE_META icons became SVGs) swapped to `<TypeIcon>`. `scripts/typecheck-
baseline.json` admin lowered 68 → **0**, so the ratchet now holds admin at zero and
any new admin type error fails CI. Verified: `typecheck-ratchet.mjs server dashboard
admin` → green (all three at 0); admin `vite build` green. All three workspaces are
now type-clean — `strict:true` is the natural next step if wanted. Delivery:
MANIFEST-2026-08-23-q.md.

### A150 · P3 · CLOSED 2026-08-23 · Server `.env.example` refreshed — was stale (retired var + missing production set)

Found while producing a hosting/secrets template for a backend server move
(rule 5). `apps/server/.env.example` had drifted from the code: it still listed
`TECH_HMAC_SECRET` (retired A113, read by nothing) and omitted variables the
server actually reads — including the ones `lib/env.ts` makes boot-blocking in
production (`TECH_SIGNING_PRIVATE_KEY`/`_PUBLIC_KEY`, `MPESA_ENVIRONMENT`), the
at-rest key `APP_ENCRYPTION_KEY`, and `DASHBOARD_URL`, `MPESA_CALLBACK_BASE_URL`,
`MPESA_ALLOWED_IPS`, `NOTIFY_FROM_EMAIL`, `SMTP_*`, the `ETIMS_*`/`WHATSAPP_*`/
`TWILIO_*` families, `MAX_DISCOUNT_PCT`, and the cron overrides. A fresh deploy
that followed the old example would fail `validateEnv()` at boot — or set the
retired var and assume it mattered.

FIX (done, 2026-08-23): rewrote `.env.example` from current source (env.ts +
render.yaml + every `process.env` reference), grouped required-to-boot /
required-in-production / recommended / optional, retired var removed, key-
generation commands and a first-admin (`reset-admin.ts`) note added. Verified by
diffing the file's keys against every `process.env.*` the server reads: the only
two absent are `ADMIN_EMAIL`/`ADMIN_PASSWORD`, which are CLI-only
(`reset-admin.ts`) and intentionally not runtime env (render.yaml agrees). Static
file, no runtime code touched, nothing to verify on a target — closed on the
bench. render.yaml remains the deployment source of truth. Delivery:
MANIFEST-2026-08-23-g.md.

### A129 · P1 · OPEN · Delivery sales silently never sync — cloud `orders.order_type` dropped `delivery` (A128's twin)

Same shape as A128, on a different column. Migration 58 ("universal business
types") DROPped and re-ADDed `orders_order_type_check` with a narrowed five-value
list — `dine_in | takeaway | retail | parking_session | fuel_sale` — silently
dropping the baseline `delivery` (and `aggregator`, `other`). But **delivery is a
live, shipping feature**: `POSPage.tsx` `chooseOrderType` offers it, the server's
Zod validator accepts it (`schemas.ts` `order_type: z.enum([…,'delivery'])`), the
create path sets a `delivery_person` specifically for it (`orders.ts`,
`order_type === 'delivery'`), and the till prints delivery KOTs / a "Delivery Boy"
receipt line. Migration 35's own header even asserts "'delivery' is already an
accepted order_type" — true when written, falsified by 58.

`create_order_atomic` (migration 69) inserts `p_order->>'order_type'` verbatim, so
a delivery order fails INSERT with 23514 (check_violation): the RPC aborts,
POST /api/orders errors, the till parks the order (`sync_queue` → 5 retries →
`failed`). Silent, because the till's LOCAL `orders.order_type` is free TEXT — the
cashier sees a completed sale that never reaches cloud/dashboard. P0-adjacent
(false confidence over completed revenue); filed P1 as silent divergence.

Found by sweeping the class A128 belongs to (rule 6): the existing
`schema-parity.mjs` compares the SET OF COLUMNS but, by its own design note, not
their DOMAINS — so a cloud CHECK tighter than the till's free-TEXT column is
invisible to it. New gate `check-push-domain-parity.mjs` (+
`push-domain-producers.json`) closes exactly that: it diffs every push-table
value-list CHECK against the reviewed set of values the producers actually emit,
and goes red naming `orders.order_type emits {delivery}` while correctly NOT
flagging `payments.method` (A128 fixed it to a format check). Wired into `ci.yml`
beside `schema-parity`.

FIX: migration 90 re-admits `delivery` only (DROP + guarded ADD, idempotent,
REVERT block). Existing rows can't hold `delivery`, so ADD CONSTRAINT can't fail
on live data; parked orders drain via `retryFailedOrders()` (idempotent on
`X-Idempotency-Key: order_id`). `aggregator`/`other` deliberately NOT re-admitted
— nothing writes them (see A130). No desktop change.

Verified against real Postgres (PGlite), `scripts/test-migration-90.mjs`, 9/9,
mutation-checked (§0 proves delivery → 23514 without the fix): post-migration
delivery accepted while '', 'aggregator', 'nonsense' still rejected; idempotent.
All 18 gates + doc-refs green on the bench.

**NEEDS PROD-MIGRATE** (86→90, on `main` via the DB-migrate Action). Delivery:
MANIFEST-2026-08-19-a.md.

### A130 · P2 · CLOSED 2026-08-31 · Aggregators report is the display half of a never-wired feature
**CLOSED 2026-08-31 (browser-confirmed).** Reports shows 6 tabs (Master/DSR, Hourly
Sales, Item Mix, Menu Matrix, Food Cost, Voids & Exceptions) — no "Aggregators" tab.
The retirement (batch -r) is live; the dead report is gone from the UI. Agent report
2026-08-31.

`GET /api/reports/aggregator` (plus the dashboard Aggregators tab,
`aggregator_commission_*` business settings, and the `orders.aggregator_name`
column from baseline) is fully built to REPORT aggregator revenue net of
commission — but **nothing anywhere creates an aggregator order.** Grep across
server, dashboard and desktop finds `order_type = 'aggregator'` and
`aggregator_name` ONLY in reads (the report, a `channelMap`, UI labels): no
INSERT, no UPDATE, no assignment, and the server's Zod `order_type` enum never
included `aggregator`. So the report can only ever return empty, and it renders as
"zero aggregator revenue" rather than "not set up" — a control that silently
misleads.

**CORRECTION to this entry's first draft:** this is NOT a migration-58 regression.
Migration 58 did drop `aggregator` from `orders_order_type_check`, but aggregator
orders were never produced even before 58 — the ingestion half of the feature was
never built. This is the repo's recurring "complete at every layer except one
wire" shape (rule 17): report endpoint, commission settings, column and UI tab all
exist; the writer does not. (Contrast A129/`delivery`, which WAS a live producer
that 58 silently cut off — that one is a real regression and is fixed.)

So re-admitting `aggregator` to the CHECK (as A129 does for `delivery`) would be
wrong — it would let the column hold a value still nothing emits, which is why the
A129 migration deliberately excludes it. The fix is a product decision on how
aggregator sales should ENTER, then a build:
- **(a)** tag an order as aggregator at creation (set `order_type` +
  `aggregator_name` from POS or a dashboard entry), re-admit the value, and the
  existing report lights up; or
- **(b)** an import path — manual dashboard entry, or a Bolt/Glovo/UberEats API
  pull — that writes aggregator orders; or
- **(c)** if aggregator revenue is out of scope, retire the report tab + column
  rather than ship a control that always reads zero.

Filed for that decision; not built. No constraint change belongs in the A129
batch.

RE-CONFIRMED 2026-08-23: still a dead report. Fresh grep across server, dashboard
and shared finds no writer of `order_type = 'aggregator'` or `aggregator_name`
(only the `aggregator_commission_` settings prefix and read-side report/label use).
So the Aggregators tab can still only ever read zero. Binary decision unchanged and
still yours: build an aggregator-order channel (a writer) so the report has data,
or retire the report + tab. No new work here — flagging that re-verification agrees
with the original finding.

RETIRED 2026-08-23 (owner said retire; dev, OPEN pending promote + prod 404 check):
removed the dead Aggregators report end-to-end. Dashboard `ReportsPage` — deleted
the `AggregatorTab` component, its `AggregatorReport` interface + `PLATFORM_LABELS`/
`PLATFORM_COLORS` helpers, the `{ id: 'aggregator' }` tab entry, and its render line
(~201 lines). Server `reports.ts` — removed `GET /api/reports/aggregator`, left a
tombstone. DELIBERATELY KEPT: the `aggregator` bucket in the order-type MIX report
(a category label, always-zero today, auto-populates if aggregator orders are ever
created) — that is not the dead standalone report A130 flagged. dashboard `tsc`/`vite`
+ server `tsc`/`build` green; `check-permission-parity` + `check-table-usage` green.
Closes on promote + confirming `/api/reports/aggregator` 404s in prod. Delivery:
MANIFEST-2026-08-23-r.md.

### A131 · P3 · CLOSED 2026-08-19 · Delivery orders now deduct packaging (uniform with takeaway)

Follow-on from A129. `applyStockEffects` (cloud) Track C deducted `product_packaging`
only for `order_type === 'takeaway'`; the recipe / ingredient / variant / product
tracks run for every order type. So once delivery orders began reaching the cloud
(A129 — a synced order hits `POST /api/orders`, which runs `applyStockEffects`),
their packaging went uncounted: a business that maps packaging to products would
see its packaging-ingredient stock drift high by roughly (delivery volume ×
packaging per item). NOT a sale/money issue, gated on packaging being configured
(no-op otherwise), and strictly better than the pre-A129 state (delivery reached
the cloud not at all) — purely an inventory-accuracy consistency gap.

Owner's call: make it uniform across **to-go** orders. Gate is now
`order_type === 'takeaway' || order_type === 'delivery'`; dine-in stays excluded
(eaten on-site, no to-go packaging). Cloud-only, one condition, one file — no
schema, no migration, no desktop change (the till never deducted packaging; stock
is cloud-authoritative, pulled). No backfill: past delivery orders never synced.

Verified: `tests/stock-effects-parity.test.mjs` extended — delivery now asserts
packaging −2 like takeaway, dine-in still 0 — plus a NEW §6 that reads the REAL
`stockEffects.ts` and pins the gate to `takeaway || delivery`, mutation-checked
(reverting the code to takeaway-only turns §6 red, naming the gate). No prod-migrate
(no DB change); ships with the server on the next deploy from `main`. Delivery:
MANIFEST-2026-08-19-b.md.

### A132 · P3 · CLOSED 2026-08-19 · Dashboard nav — accordion + desktop icons, original labels kept (UI only)

Owner UI polish, presentation-only: same routes, items, and data — no business
logic. Three changes to `apps/dashboard/src/components/DashboardLayout.tsx`:
1. **Accordion.** The nav opened every group on load (`DEFAULT_OPEN` held all the
   vertical-relabelled variants — Menu/Catalogue, Stock/Inventory/Purchasing,
   Finance, Setup — so four of five groups plus all their items showed at once).
   Open-state lifted to the parent: exactly one group open at a time, only the
   group holding the current route opens on load, choice persisted in
   localStorage. Removed the stale `DEFAULT_OPEN` set.
2. **Icons.** ~30 emoji/unicode glyphs replaced with a monochrome outline SVG set
   (`NavIcon` + `ICONS`) in the desktop app's style, so the two apps read as one
   product; colour via currentColor (keeps green-active / grey-idle). Extended to
   the sidebar chrome as well — the light/dark toggle (sun/moon) and the
   notification icons (low-stock/summary/default → warning/bar-chart/bell) now use
   the same set, so the sidebar carries **zero emoji**. `NavIcon` gained an
   optional `size` (default 18) for the notification empty-state.
3. **Naming — reverted, none changed.** An initial pass aligned labels to the
   desktop (POS→Till, Terminals→Tills, plus casing/terseness), but on owner review
   the renames read as confusing in the web's single sidebar — most of all Till
   (the sell-screen link) vs Tills (the device-fleet page), one mis-click apart —
   so they were **reverted in full**. Every menu label is unchanged from the
   current dashboard; only the icons and accordion ship. Arrangement unchanged.

Verified: esbuild bundles the TSX clean (syntax/JSX sound); repo gates green.
NOT run: the dashboard's own `tsc` (deps not on the bench, rule 9) — confirm on CI
type-check or `cd apps/dashboard && npm run build`. Static preview:
`nav-preview.html`. No server/DB/desktop change, no migrate. Delivery:
MANIFEST-2026-08-19-c.md.

### A133 · P2 · OPEN · Settings menu consolidated — owner dashboard (Slice 1 delivered for review)
**BROWSER 2026-08-31 (Slice 1 confirmed).** Owner Settings shows exactly 3 sections
(Users and access, Devices and printers, Business); `/dashboard/settings` lands on
the first section with the active item highlighted. Still pending: manager view (no
manager login this session), the old-link redirect check (unmapped routes bounce to
`/login`, so inconclusive), and Slice 2 (manager parity, not built). Stays OPEN.

Regroups the owner sidebar's flat Setup group (Branches, Printers, Print stations,
Terminals, Table Turnover, KRA eTIMS, Staff Management, [vertical] Setup, KDS —
eight unlike things, two of which are not settings) into a **Settings** group with
three tabbed sections, the same group→page pattern Menu/Stock/Finance already use:
**Users and access** (Staff members · Roles and permissions) · **Devices and
printers** (Terminals · Devices · Printers · Print stations) · **Business**
(Branches · Tax & compliance · Payments · [vertical] Setup · Integrations). This is
the *arrangement* change A132 deliberately left untouched ("Arrangement unchanged").

Also relocates the two non-settings that sat in Setup — **Table Turnover → Finance**
(a report) and **KDS → top level** near POS (a live screen) — and moves **Payment
methods → Business › Payments** (out of Menu; it is tender config, not catalogue).

Six new files under `apps/dashboard/src/pages/settings/`: `SettingsSection` (shared
title + sub-tab-bar + Outlet shell), the three container pages
(`UsersAccessPage` / `DevicesPrintersPage` / `BusinessPage`), and
`ReportSchedulerTab` / `WebhooksTab` extracted **verbatim** from `SettingsPage` so
Integrations reuses one copy, not a drifting second (rule 17). Two edits:
`App.tsx` (flat `settings` / `printers` / `stations` routes → three nested sections
with index-redirects + back-compat redirects for every old deep link) and
`DashboardLayout.tsx` (dead static Setup group AND the runtime `setupGroup` rebuild
AND the now-orphan `TYPE_SETTINGS` map removed → one static three-item Settings
group). `SettingsPage.tsx` is now unrouted — left in place (additive), flagged for
deletion.

Decisions for owner review: Branches placed under Business; vertical Setup collapsed
to one `business.type`-resolved tab. **Business › Profile deferred → A134** (the one
genuinely new page; needs its field list before build — rule 20).

VERIFIED on the bench (deps present, unlike A132): `apps/dashboard` `tsc --noEmit`
clean (0 errors; baseline before edits was also 0) AND `npm run build` green (vite,
~8s; the new `BusinessPage`/`DashboardLayout` chunks emit, so lazy imports + nested
routes bundle). NOT verifiable here (rule 16, needs a browser): section rendering —
in particular a possible double-heading where a full standalone page (Printers,
Terminals, Payments, vertical Setup) mounts inside a titled section; nav
open-on-load + active-item highlight; the redirects actually bouncing. **Slice 2 —
manager dashboard parity — is specified in MANIFEST-2026-08-20-a but NOT built**: the
manager is a 1,357-line flat PIN/permission tab switcher with a different auth/data
context, so its grouped nav + Settings submenu is its own verified slice (rule 12).
Stays OPEN until browser-confirmed, signed off, and Slice 2 lands. Nothing merged or
pushed. Delivery: MANIFEST-2026-08-20-a.md.

**Follow-up 2026-08-20 (owner browser review, committed `439d141`+):** five fixes.
(1) KDS opened to "Missing branch ID" — the top-level KDS link was bare `/kds` but
`KDSPage` is keyed by `?branch_id=`; the link now carries the active branch. (2) Group
headers restyled to a distinct uppercase section label (`font-bold uppercase
tracking-wider text-xs`) so the sidebar reads as grouped menus, not a flat list. (3)
`StationsPage` had no page padding (root was `space-y-6`, unlike its siblings' `p-6`)
so Print stations rendered flush-left inside the Devices section — added `p-6`.
(4) Sidebar active-state: a grouped item that is a path-prefix of a sibling
(`/dashboard/customers` vs `/dashboard/customers/credit`) matched active for the
child route too, so both lit up — `NavGroupItem` now sets NavLink `end` when a
sibling extends the item's path. (5) KDS hardened: **both** tickets fetches (initial
load + the realtime INSERT re-fetch) coerce a non-array response to `[]` so a display
screen shows the empty board instead of white-screening.

**Class sweep 2026-08-20 (owner asked "check for such errors" — rule 6).** Both bug
classes swept dashboard-wide. (A) Nav prefix-collision: enumerated every nav path;
the only pair where one is a strict prefix of another is `customers` → `customers/credit`
(fixed above); Overview `/dashboard` is a prefix of all but is pinned `end: true`.
Clean. (B) Non-array-response crash: the shared `api` client throws on non-2xx and
every `api.get<…[]>` call site assigns to a var guarded with `?? []`, so the risk is
confined to raw `fetch()`. Swept all raw fetches: `localPrintServer` guards
(`data.printers ?? []` in try/catch); the KDS **realtime** re-fetch was the one
genuine miss — the same class as the initial fetch, now guarded (this change). Also
observed but OUT OF the owner-dashboard scope: `QRMenuPage` (public QR surface) does
`data.categories.length` after only an `.error` check, so a malformed 2xx without a
`categories` field would crash — flagged, not touched (separate surface; owner asked
about the dashboard). (C) Section padding: every page rendered inside the three
Settings sections carries its own `p-6` (StationsPage was the only gap, already
fixed). Dashboard `tsc` + `npm run build` both green on-bench; browser recheck still
owner's.

### A134 · P3 · CLOSED 2026-08-20 · Business › Profile settings tab (deferred from A133)

The consolidated **Business** section (A133) is designed to open with a **Profile**
tab — company-level settings that today have no vertical-neutral home: business name,
currency, receipt header, 24-hour operation, and the like. It is the one genuinely
NEW page in the Settings consolidation (every other tab is a regrouping of an
existing page), so per rule 20 it was not shipped blind — its field list, and which
existing settings it absorbs versus what stays on the vertical Setup page, need a
decision first. Filed, not built; A133 ships the other four Business tabs now. Add on
the owner's field list.

**RESOLVED 2026-08-20 (Slice 1).** Owner chose identity owner-editable + receipt
header/footer + 24-hour toggle. Built the Profile tab as the Business section's first
(landing) tab: (1) owner-editable identity via a NEW `PATCH /api/business` (whitelist
name/address/phone/contact-email/tax_pin/vat_rate/currency; owner login email +
owner_id + type + status stay admin-only; VAT bounded 0-100; **currency locked once
any sale exists**); (2) business-wide receipt header/footer (save-on-blur) + 24-hour
toggle via the existing `POST /api/business/settings`. New `BusinessProfileTab.tsx` +
`PATCH /api/business` handler; wired at `settings/business/profile` (now the Business
index). Verified: server `tsc`, dashboard `tsc` + build green; route gate 278/278 (new
PATCH matches), drift gate clean. Owner to confirm the save in a browser. Per-branch/
franchise overrides scoped OUT to A139; the Profile tab carries a "coming separately" note.

### A135 · P2 · CLOSED 2026-08-20 · KDS board renders blank + adding a table fails (pre-existing runtime, surfaced in A133 review)

Two functional bugs found once A133 made the owner walk the menu in a browser.
NEITHER is caused by A133 — the nav/route change only made them reachable/visible;
both are runtime and need a running node + DB to diagnose (bench can typecheck, not
execute — rule 8/16).

(1) **KDS blank.** With A133's link now passing `?branch_id=`, `/kds` gets past the
"Missing branch ID" guard and mounts, but the board shows nothing. The render has
loading / empty ("🍳 All clear") / grid states, so a *blank* (white) screen is a
runtime crash, not the empty state — most likely the tickets response not being an
array or the Supabase realtime subscription throwing on the public (session-less)
page. A133 follow-up added an array-coerce guard on the fetch (so a bad body → empty
board, not white-screen); if it is still blank after that, the browser console error
is needed to finish it. `/api/kitchen/tickets` auth model on the public KDS is the
first thing to check.

(2) **Adding a table does nothing.** `RestaurantSettingsPage.saveTable` POSTs
`/api/tables` with `{ ...editTable, slot_type: 'dining', branch_id: selectedBranchId }`.
The frontend path is independent of A133's routing (the page loads, reads branches,
and posts as before). Needs a browser + node to see whether the POST 4xx/5xx, the
form never sets `editTable`, or the server rejects the payload — cause not
determinable on a typecheck-only bench.

Filed for a proper runtime session; not fixed here (rule 12 — logic debugging with a
live server is its own task, not a rider on the menu UI). Owner flagged both while
explicitly deferring logic.

**Follow-up 2026-08-20 (diagnosis + silent-failure fix).** Add-table root narrowed
with the PGlite dummy DB + a code trace. RULED OUT: (a) column drift — the gate is
clean; (b) NOT NULL / CHECK — `tables.slot_type` is NOT NULL but DEFAULTs to
`'dining'`, the only hard-required columns (branch_id, business_id, name) are all
supplied, and the CHECK set (status/slot_type/shape) passes; (c) owner permission —
`auth.ts` sets `req.isOwner = true` on the Supabase-owner path and
`requireAnyPermission` bypasses owners. So for an owner the insert is valid and should
201; the remaining causes are a non-owner session (403), an empty branch_id/name
(400), a handler 500, or it saves and only the list refresh is broken — and those are
indistinguishable without the `POST /api/tables` Network response. What made the
failure INVISIBLE is now fixed: `RestaurantSettingsPage` `saveTable`/`deleteTable`/
`saveSetting` each fired a mutating `api.*` call inside `try … finally` with NO
`catch`, so any rejection skipped the toast/close/reload silently — the "adding tables
does nothing" symptom, a rule-6 class. All three now surface the error message
(dashboard `tsc` + `npm run build` green). KDS blank: the array guards (2ff5de2) turn
the likely non-array crash into the empty board, and the realtime callback is guarded
and lives in a `useEffect` (can't blank the initial render), so if KDS is STILL blank
after 2ff5de2 the browser console error is needed (Supabase realtime the prime
suspect). Stays OPEN pending two one-shot runtime observations: (1) the `POST
/api/tables` status+body, (2) the KDS console error. A broader catch-less-mutation
class likely exists on other dashboard pages — worth a follow-up sweep.

**RESOLVED 2026-08-20 (owner-confirmed).** KDS: with the array guards live (2ff5de2)
the board now renders the empty "All clear" state with a green connection dot — owner
screenshot confirms; the blank was the non-array crash, now impossible. Add-table:
with the silent-failure fix live (1ffc073) table creation works — owner confirms
"Table creates". Both halves closed. The catch fix stands regardless (future failures
surface instead of vanishing). NOTE still open as separate items: the broader
catch-less-mutation sweep across other dashboard pages, and A136 (the two column
drifts) which is unrelated to this.

### A136 · P2 · CLOSED 2026-08-20 · Server queries columns absent from the schema (stock_movements.business_id, users.pin) + two new API gates

Owner asked for a full API check of the dashboard. Route/method contract: clean
(274 dashboard call-sites vs 249 server routes, 0 missing, 0 method mismatch). DB
contract: built the full schema in PGlite by replaying all 85 migrations (99 tables /
1082 columns / 19 functions; shimming Supabase's `auth`/`extensions` schemas, roles
and `uuid_generate_v4`, which is why the repo's own tests use fixtures not the
baseline) and checked every `supabase.from`/`.rpc`/filter-column against it. Two real
drifts, both verified against the migration-built schema and the source:

  (1) **stock_movements.business_id** — `routes/fueltanks.ts` (tank movements list)
      and `routes/reports.ts` (deliveries report) both `.from('stock_movements')
      .eq('business_id', req.businessId)`. That table has `branch_id`, no
      `business_id` → PostgREST 400 at runtime, in the petrol vertical + a report.
  (2) **users.pin** — `routes/staff.ts` staff-lookup-by-PIN does `.from('users')
      .eq('pin', pin)`. The column is `pin_hash` (+`override_pin_hash`), no `pin` →
      PostgREST 400 on that lookup.

Three other hits were false positives, verified and discarded: `expenses.method/status`
is really `chunkIn('payments', …)` (payments has both); `shifts.shift_id` is really
`.from('float_transactions').eq('shift_id')` (that table has it). The gate's
anchor-scoping handles these correctly.

CAVEAT (rule 9): the ground truth here is the migrations, not prod — `scripts/
schema-index.json` (the live-DB snapshot the other gates use) is stale at 16 tables,
so it cannot confirm whether prod has these columns. If prod DOES, the server works
in prod but the repo migrations lag prod — the same drift class, different fix. Only
the live DB settles which; not reachable on this bench (no Supabase creds). NOT fixed
here — the fix depends on intent (scope `stock_movements` by `branch_id`? use
`pin_hash`?) and needs the live DB. Both drifts are ALLOWLISTED (with this ID) in the
new gate so it is green now and catches NEW drift; emptying the allowlist is the
definition of closing A136.

DELIVERED (this change), mechanising the class so the next one can't ship silently:
`scripts/check-api-routes.mjs` (dashboard call ↔ server route+method; wired into the
Schema-drift CI job, no deps) and `scripts/check-api-schema-drift.mjs` (server DB refs
↔ migration-built schema; wired into server-suites after the root install, since it
needs PGlite). The drift gate checks tables, RPCs, and columns across ALL of: filter
(`.eq`/`.in`/`.order`/…), WRITE (keys of a direct `.insert`/`.update`/`.upsert` object
literal — variable args and the upsert options object are skipped as unverifiable) and
READ (bare `.select('a,b')` columns — embeds, aliases, casts, json paths and `*`
handled). Extending to write/read surfaced no new drift (the write/read paths are
clean); it also flushed out and fixed two parser traps first (a nested generic
`chunkIn<Record<…>>` mis-anchoring, and `::` casts read as `:` aliases). Both gates
carry a `--self-test` that injects known breaks — bogus table/rpc/column AND bad
insert/select columns, plus regression guards that valid shorthand/spread/variable/
options/embed/cast patterns are NOT mis-flagged — asserted in CI (the repo's "assert
the guard detects a broken parse" pattern). Verified on-bench: both gates green,
self-tests 3/3 (routes) and 11/11 (drift), `ci.yml` valid YAML.

**RESOLVED 2026-08-20.** Both drifts fixed against the established in-codebase
patterns — the fixes are correct whether or not prod carried the stray columns, so the
migrations-vs-prod caveat is moot. (1) `stock_movements.business_id` → both queries
now scope by business through the `products!inner ( … business_id )` join with
`.eq('products.business_id', …)`, the exact pattern `inventory.ts` already uses; that
table has no `business_id`, and every other stock_movements query keys on
branch_id/product_id. (2) `users.pin` → `POST /api/staff/clock` no longer filters a
non-existent plaintext `pin` column (which made every clock-in return "Invalid PIN");
it now fetches active staff and verifies each against `pin_hash` via the canonical
`verifyPin` (bcrypt + legacy SHA256), now EXPORTED from `auth.ts` and reused rather
than duplicated (§L). Allowlist emptied → the drift gate now enforces both (0
allowlisted, still green; self-test 11/11). Server `tsc` clean. NOT runtime-verified
on this bench (no live PostgREST/DB): owner to confirm clock-in identifies staff, and
that the fuel-tank movements list + deliveries report return data. Given the
auth-sensitivity, if clock-in misbehaves, reopen — but the current code was 100%
broken (always 401), so this can only improve it.

### A137 · P3 · CLOSED 2026-08-20 · Bulk-create tables ("Add multiple")

Owner asked for a way to add many tables at once, and floated auto-creating 20 at
restaurant creation for venues whose staff won't hand-place tables. Shipped the first;
declined the second by design. "Add multiple" now sits on the Tables tab header AND
the empty state → a small modal with a typed count (1–100) that creates `T{n}` tables
continuing after the highest existing T-number (skips any name already present, so no
409 dup), seats 4, sort_order continues. Reuses the single-create endpoint — no new
server route, and the API route gate confirms the added `POST /api/tables` call still
matches (275 calls, 0 breaks). Skips individual failures and surfaces the real error
if none succeed (consistent with the A135 catch fix). Auto-seed-20-at-signup was NOT
built: it imposes wrong data, fits only restaurant/café, and writes on the riskier
onboarding path — the empty-state one-click gives the same benefit, reversibly and
only when wanted. Restaurant/café vertical (this settings page). Verified: dashboard
`tsc` + `npm run build` green; owner to confirm the create in a browser.
`RestaurantSettingsPage.tsx` only.

### A138 · P3 · CLOSED 2026-08-20 · Catch-less mutation sweep — surface errors on the vertical settings pages

Follow-up to the class A135 flagged: a mutating `api.*` call in `try … finally` with no
`catch` (or no `try` at all) swallows the failure, so the user sees "nothing happens" —
the original add-table symptom. Swept the whole dashboard (124 mutating calls / 39 files).
Only the vertical settings pages carried it — direct siblings of `RestaurantSettingsPage`
(fixed under A135): `ParkingSettingsPage` (saveBay, deleteBay, saveSetting),
`MinimartSettingsPage` (saveSetting, saveProduct, runImport), `PetrolSettingsPage`
(savePump, deletePump, saveTank, recordDelivery, saveSetting). All now surface the real
error via their local toast. `FloorPlanTab` (saveLayout) and `StockTransfersPage` (create)
already had catches — their only `finally`-gap is a read (load), left as-is; the other 34
files handle their mutations. Verified: the swallower check (mutation + zero error
handling) is now 0 across the dashboard; `tsc` + `npm run build` green. Loads that swallow
(different symptom — empty data, not a failed action) were deliberately left.

### A139 · P3 · OPEN · Per-branch (franchise) receipt text + hours overriding the business default

Split out of A134 (Slice 2). Owner wants receipt header/footer and the 24-hour setting
settable PER BRANCH for franchises, superseding the business-wide values. Cross-stack
settings-scoping, not a UI tweak — `business_settings` is one row per key per business
(no `branch_id`). Needs: (a) a branch-level override store — a `branch_settings` table
(or `branch_id` on `business_settings`), per the `branch_prices`/`etims_branch_config`
precedent — with a migration (**PROD-MIGRATE**); (b) server resolution (branch override
→ business default) incl. `pos.ts`; (c) the **DESKTOP till** —
`receipt_header`/`receipt_footer`/`continuous_operation` are consumed by
`apps/desktop/src/main` (syncEngine, localDb, deviceConfig, ipcHandlers) + the print
path, which must sync and resolve the per-branch value and CANNOT be verified on this
bench (no Electron; receipts print on the physical till); (d) dashboard — a per-branch
override editor. Its own verified slice, built with the migration and a till in the loop.

**BUILT 2026-08-20 (server-side resolution — desktop unchanged).** The key lever: the
till already sends `?branch_id` to `GET /pos/init` (used for per-branch pricing) and
consumes the `receiptHeader`/`receiptFooter`/`continuousOperation` it returns — so the
override is resolved SERVER-SIDE and the desktop needs NO change. Delivered: (a)
`migrations/91_branch_settings.sql` — `branch_settings(business_id, branch_id, key,
value)` unique(branch_id,key), RLS + grants mirroring business_settings, ON DELETE
CASCADE (PGlite-verified, 86/86, 100 tables); (b) `/pos/init` fetches this branch's
overrides in the same round-trip (same tenant guard as the bound branch) and overlays
them onto the business defaults — branch row wins, absent → inherit; (c)
`GET/POST /api/branches/:id/settings` (upsert, or clear→inherit on null value), keys
allow-listed to receipt_header/footer/continuous_operation, with an `assertOwnBranch`
tenant guard so no one writes overrides onto another business's branch; (d)
`BranchReceiptOverrides.tsx` on the branch detail page — inherit-or-override per field,
revert-to-default clears the row. Verified: server `tsc`, dashboard `tsc` + build,
drift gate (0, self-test 11/11), route gate 279/279 all green. Stays OPEN on two owner
steps: **NEEDS PROD-MIGRATE 90→91**, then confirm on a real till that a branch with an
override prints its own header while others inherit. No desktop code changed, so that
confirm is a read-through of existing sync, not new till logic.

### A127 · P2 · CLOSED 2026-08-17 · Admin portal — Branches tab with tills + tech-audit drill-down (rule-14 catch-up)

Register row was missing though the code shipped (commits `46ad3ae`, `0f39c40`) —
the rule-14 gap the 08-18 header flagged. Adds a Branches tab to the admin portal
listing each branch's tills, with a per-branch drill-down into the tech-audit
log. Recorded here to close the gap; no code change in this batch.

### A126 · P3 · CLOSED 2026-08-17 · Admin portal — Phase 3 glass UI refresh (rule-14 catch-up)

Register row was missing though the code shipped (commit `97dbbb3`). Visual
refresh of the admin portal to the "glass" styling used across the newer admin
surfaces; presentation-only. Recorded to close the rule-14 gap.

### A125 · P3 · CLOSED 2026-08-17 · Admin portal — suspend-purge Stage 2 dry-run preview (rule-14 catch-up)

Register row was missing though the code shipped (commits `0f9e1dc`, `97dbbb3`).
Non-destructive purge preview: an admin-only dry-run that lists exactly what a
purge WOULD delete for a long-suspended client, deleting nothing. Follows
A123/A124's staged suspend-purge design. Recorded to close the rule-14 gap.

### A1 · P0 · **CLOSED 2026-08-11 — packaging closed 08-10, rotation confirmed by owner**
**Owner, 2026-08-11: the key was rotated long ago.** That was the only half
outstanding. Entry retained in full below because IDs are never reused and the
packaging reasoning is still load-bearing.

This entry contradicted the rest of the file. §E and §4 of
`HANDOFF-2026-08-08-evening.md` both record the packaging fix as closed, while
this section still read OPEN. Verified 08-10:

```
package.json:10  "package":       "git archive --format=zip HEAD -o pos.zip"
package.json:11  "package:check": "node scripts/check-package.mjs"
scripts/check-package.mjs           present
```

`git archive` honours the index, so an ignored file physically cannot enter the
archive. **The packaging half is closed.** Two independent CI gates back it: the
tracked-`.env` assertion and gitleaks, and since 08-10 the `.env` check runs
FIRST so an action crash cannot skip both (A35).

**What remains open is the ROTATION half, and it is not a code question.**
`SUPABASE_SERVICE_ROLE_KEY` was exposed in a packaged zip on 2026-08-08. The
evening handoff's first "before anything else" item was to confirm it had been
rotated. **No document in this repo records that it was.** The script prevents
the next leak, not the last one. Until someone confirms the rotation in writing,
treat a P0 credential as live in an artefact that left the building.

### A54 · P1 · OPEN (blocked on the owner) · Mail still undelivered — and A50's recorded diagnosis was wrong
**Third recurrence of A50.** Production log, 2026-08-10 20:57 UTC, on `dev`
@ `0215475`:

```
[mailer] RESEND_API_KEY not set — SMTP is the ONLY path…
[mailer] SMTP FALLBACK IS DEAD — smtp.gmail.com:587
         (pinned to 74.125.195.108) — Connection timeout
```

**The A50 fix worked.** `74.125.195.108` is IPv4, so `resolveSmtpIPv4()` reached
the socket and the ENETUNREACH half is genuinely closed. **The timeout survived
it**, which falsifies the claim written into `mailer.ts` and into
`mailer-transport.test.mjs`'s header:

> *"`Connection timeout` in the same run is the same fault on a different IPv6
> route… **Not two problems; one.**"*

It was two. One is fixed; the second was never diagnosed, and the comment told
every future reader there was nothing left to find. That is a false-confidence
trap in the P0 sense of the severity scale, sitting in the file whose whole
purpose is that a dead mail path announces itself.

**Cause of the surviving half.** A connect-layer timeout against a valid IPv4
literal is a dropped SYN — the port is filtered upstream. It is not DNS, not
TLS, not credentials. Render blocks outbound 25/465/587 on **free** web services
(25 on every plan; they run on EC2). `render.yaml:8` declares `plan: starter`,
on which 465 and 587 are permitted.

**So the repo and the running instance disagree, and the repo cannot settle it.**
`render.yaml` also declares no `branch` and no `autoDeploy`, yet the deploy log
reads `Checking out commit … in branch dev` — so this service is dashboard-managed
and the blueprint is not proof of what runs. §L's shape again: two things that
must agree, with nothing comparing them.

**Owner decision, 2026-08-10: Gmail SMTP is the LIVE path, Resend later.** So
SMTP is not a fallback today and must work on its own. The provider order in
`sendEmail()` already matches that intent (Resend when keyed, SMTP otherwise)
and was **not** changed.

**Shipped in this batch — none of it can open a filtered port:**
- the falsified comment corrected, with the production evidence that disproved it;
- `classifySmtpFailure()` — the boot check printed one ENETUNREACH-shaped hint
  for every failure, which is how a timeout got read as more DNS trouble. Now
  routes by class: timeout → filtered port, check the instance plan; ENETUNREACH
  **on a v6 literal** → the pin regressed; EAUTH → Gmail App Password;
  ECONNREFUSED → wrong host/port; TLS → `servername`;
- an alternate-port probe (587↔465) that reports which port answers.
  **Diagnostic only** — `sendEmail` never passes the override, asserted, and
  mutation-checked by making it pass one;
- `secure` now follows the *effective* port. Probing 465 while `secure` still
  read `SMTP_PORT === 587` would hang and report "465 fails too" — a probe
  lying in the direction that hides the fix.

**BLOCKED ON THE OWNER — no code change reaches these:**
1. Confirm the live instance type in the Render dashboard. If Free, that is the
   whole cause; upgrade, or move mail off SMTP.
2. `SMTP_PASS` must be a 16-character Gmail **App Password**. An ordinary account
   password fails at AUTH once 2FA is on — the next failure after a port opens.
3. `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` are `sync: false` in `render.yaml`;
   nothing in the repo can confirm they are set.

**Still open after this batch**, and deliberately not built (rule 12 — it grew a
third concern): **nothing reports a failed DELIVERY.** `reportMailReadiness`
proves a socket opens at boot; `dailySummary.ts:61` still catches per business,
logs and moves on. Nine businesses went undelivered across **three distinct root
causes** without the product ever saying so. A boot check is not a delivery
check. Recommend a `mail_deliveries` outcome row or a per-run summary line — a
decision, not a chore, so it is recorded rather than slipped in.

**2026-08-12 — the SCHEDULING layer of this feature was fixed separately; see
A65.** The enable-toggle never persisted (missing read route) and the sender
ignored the schedule entirely; both are fixed and verified. That is orthogonal to
this entry. A54 is the TRANSPORT — mail that never leaves the instance because
the SMTP port is filtered — and it STAYS OPEN, blocked on the three owner checks
above. A correct scheduler still sends into a filtered port.

**2026-08-13 — the live log settles it: SMTP is dead on this host, use Resend.**
Boot log on `swiftpos-server.onrender.com`:

```
[mailer] RESEND_API_KEY not set — SMTP is the ONLY path…
[mailer] SMTP IS DEAD AND IS THE ONLY PATH — smtp.gmail.com:587
         (pinned to 172.253.117.109) — Connection timeout
[mailer] …and port 465 fails too: Connection timeout. Both submission ports
         blocked is the signature of the host filtering SMTP outright.
```

`172.253.117.109` is IPv4 — the A50 pin still holds. **Both 587 AND 465 time
out**, which is the both-ports signature the diagnostic added for: not a wrong
`SMTP_PORT` to toggle, but the host filtering SMTP outright. That falsifies the
2026-08-10 owner decision to run Gmail SMTP as the live path — it cannot work on
this instance. The viable path is **Resend** (HTTPS/443, which Render does not
block, and which is why the code has it as primary): set `RESEND_API_KEY` and a
`NOTIFY_FROM_EMAIL` on a *verified* domain (not free-mail — the code warns on
that). Still OPEN, now blocked on that Resend config rather than on an SMTP path
that has been shown three times over not to exist here.

**Verification tool added (08-13).** `POST /api/notifications/test-email`,
owner-only (`req.isOwner`), sends ONE real message to the owner's OWN address via
a new `sendEmailChecked()` in `mailer.ts` that RETURNS the outcome (provider that
delivered, or the exact provider error) instead of logging and swallowing it like
the fire-and-forget `sendEmail` the jobs use. So once Resend is keyed in, the
owner can prove delivery on demand — `{ ok: true, provider: "resend" }` — rather
than inferring it from the boot log. Self-only recipient, so no spam vector.
Pinned by `tests/mailer-transport.test.mjs` §7 (8 assertions); server `tsc` clean.
This does NOT close A54 — it is the tool to confirm the fix once the owner sets
the key. The delivery-outcome recording recommended above is still not built.

### A56 · P1 · CLOSED 2026-08-11 · The permission comparator exists — `check-permission-parity`
The gate A45 asks for and A46 is blocked on. **Built before the split, not after**,
which was the whole point: 45 route gates and every UI gate that mirrors them are
about to be re-pointed, and without a comparator the two sides drift again while
being changed.

Compares **three** surfaces, not the two A45 names:

| Surface | Read from | Count |
|---|---|---|
| ENFORCED | `requirePermission('k')` in `apps/server/src` | 13 keys, 84 files |
| REGISTERED | `INSERT INTO permissions` in `migrations/` (archive excluded) | 8 keys |
| UI | `hasPermission('k')` · `can('k')` · `permission: 'k'` | 10 keys, 148 files |

**Ratcheted, not pass/fail.** The ground is not green — 6 unregistered, 6 ungated,
2 phantom. A gate that is red on day one gets switched off, which rule 23 names as
worse than no gate. Semantics copied from `typecheck-ratchet.mjs` (rule 17 — this
repo had already solved this problem): rising fails, **and so does falling**, so a
fix must lower `scripts/permission-parity-baseline.json` rather than be absorbed
silently.

**What it will not do:** decide whether a UI gate is CORRECT — that the tab behind
`hasPermission('x')` is the same action the route enforces. A source scan cannot
know that. It answers the narrower question honestly: is the same key named on both
sides, and does it exist at all. A45's fault fails the second question alone.

**Three defects in my own gate, caught before it shipped:**
1. It walked `migrations/archive/**` — files that are **never run** — and reported
   `printers.manage`, `printers.view` and `ingredients.view` as registered on the
   strength of superseded legacy migrations. A49's shape precisely: a false claim
   in the position where a false claim silences the gate. Counts were unaffected
   (none is enforced); the correctness was the point.
2. Phantom keys were written as a **hard fail on the assumption that there were
   none**. There are two (A58). Measurement corrected the assumption; ratcheted.
3. Its first mutation check passed because the mutation used an *alias*
   (`requirePermission as _rp`), which the scanner correctly does not match — my
   mutation was wrong, not the gate. Re-run with a literal call: red, naming the key.

**Mutation-checked (rules 10, 23), each mutation confirmed present first:**
new route on an unregistered key → `UNREGISTERED ROSE: 6 -> 7` naming
`audit.export` · misspelt UI key → `UNGATED ROSE` + phantom listing ·
**seeding a missing key → `UNREGISTERED FELL: 6 -> 5`, asking for a lower
baseline** · and `stripComments` proven load-bearing: raw source yields a phantom
key `x` from a comment at `asyncHandler.ts:54`.

**A57 — the original finding, as opened by check-permission-parity.** Retained verbatim; its closure by migration 75 is recorded in the A57 entry below.
Found by A56 on its first run. The chain is three links and every one is in the tree:

```
role_permissions.permission_id -> permissions.id     FK, 00_baseline.sql:5212
requirePermission allows on isOwner | '*' | key      rbac.ts:20  (fails CLOSED)
```

A key with no `permissions` row can never be attached to a role, so it can never
reach `req.permissionKeys`, so **the route is owner-only and nothing says so.**

| Key | Routes | Seeded by any migration? |
|---|---|---|
| `products.manage` | 29 | **no** |
| `settings.manage` | 16 | **no** |
| `staff.manage` | 6 | **no** |
| `expenses.manage` | 6 | **no** |
| `expenses.view` | 3 | **no** |
| `orders.void` | 2 | **no** |

**READ THE SCOPE CAREFULLY. This does NOT say 62 routes are broken in production.**
The live `permissions` table is almost certainly seeded — these are the oldest keys
and `00_baseline.sql` is a schema-only dump with no INSERTs. What it says is that
**the repository cannot rebuild a working permission set**: a new tenant, a staging
rebuild, or a PGlite migration test produces a database where a manager cannot be
granted any of them. That is the A4 shape — migrations under-represent production —
and it is unfalsifiable from the repo alone, which is why it got a gate and not a fix.

**Not fixed here, deliberately.** The fix is a seed migration, and (a) rule 13 asks
whether a release is in flight, (b) it must not conflict with rows production may
already hold, and (c) A46's split is about to add seven more keys — seeding twice
is how two copies drift (rule 17). **Do it as part of A46, in one migration.**

**VERIFY IN PRODUCTION FIRST** — this is the query that settles it, and nothing in
the repo can:
```sql
select key from public.permissions
where key in ('products.manage','settings.manage','staff.manage',
              'expenses.manage','expenses.view','orders.void')
order by key;
```
Six rows: production is fine and this is a repo-rebuild gap only. Fewer: those
routes are owner-only in the field right now, and A45's "grant the role
`settings.manage`" unblock **cannot work**, because the key cannot be granted.

**A58 — the original finding, as opened by check-permission-parity.** Retained verbatim; the fix is recorded in the A58 entry below.
Found by A56's phantom check. `ManagerDashboard.tsx` `NAV_ITEMS`:

| Nav item | Gated on | Enforced by cloud? | In any migration? |
|---|---|---|---|
| Orders (`:68`) | `orders.view_all` | no | no |
| Turnover (`:73`) | `orders.view_all` | no | no |
| Inventory (`:69`) | `inventory.view` | no | no |

`hasPermission` is `session.permissions['*'] === true || session.permissions[key]
=== true` (`POSAuthContext.tsx:134`). A key with no `permissions` row can never be
granted, so **the gate is always false for anyone who is not the owner** and
`visibleNav` (`:1191`) drops all three.

This is A45 inverted and arguably worse: A45 shows a manager something the cloud
then refuses, so at least they see it and get an error. Here **three tabs are
simply not there**, with no error, no log, and nothing to report.

Same caveat as A57 and the same query settles it: if production seeds
`orders.view_all` and `inventory.view` and grants them to the manager role, the
tabs appear and this is a repo-rebuild gap. If it does not, no manager has ever
seen Orders, Turnover or Inventory. **Ask the owner whether managers can currently
open those three tabs** — one answer, thirty seconds, and it decides the severity.

### A57 · P1 · CLOSED 2026-08-11 · Registered by migration 75
Six keys covering ~62 routes now have `permissions` rows, so a role can actually
be granted them. `ON CONFLICT (key) DO NOTHING`, so it is a no-op where
production is already seeded — which is why it did not need to wait on the
production query, contrary to what the `-b` manifest said. That deferral was
over-cautious: migration 24 and 49 had already established the idempotent
pattern, and rule 17 should have found it sooner.

**Proven against real Postgres**, not read: `scripts/test-migration-75.mjs`, 11
assertions under PGlite, including that the migration runs twice with no
duplicates and that a row pre-existing with production's own label **keeps that
label** (DO NOTHING, not DO UPDATE). Mutation-checked: flipping to `DO UPDATE`
turns that assertion red.

**Still worth running in production**, because it decides whether this was ever
a live fault or only a rebuild gap:
```sql
select key from public.permissions
where key in ('products.manage','settings.manage','staff.manage',
              'expenses.manage','expenses.view','orders.void');
```

### A58 · P1 · FIX SHIPPED 2026-08-11, CONFIRMATION WANTED · Three manager nav items
Migration 75 registers `orders.view_all` and `inventory.view` and grants them to
manager / supervisor / branch_manager / admin / owner, following migration 49's
precedent and its stated reason: *a permission nobody holds gets granted to
everybody within a week*. Orders, Turnover and Inventory should now appear.

**This is the one behaviour change in migration 75, and it is separated into its
own block so it can be deleted before running.** Turnover shows branch revenue.
If a branch manager is not meant to see branch revenue, drop that block — the
keys stay registered and the tabs stay hidden. Revert line is in the migration.

### A45 · P1 · CLOSED 2026-08-11 (cloud side) — one grant away from fixed
`POST /business/settings` now accepts `receipt.manage` **or** `settings.manage`,
and narrows PER KEY inside the handler: anyone without full settings access may
write only `receipt_header` and `receipt_footer`.

**Why per-key and not a route swap.** That one handler writes every setting,
including `supervisor_pin` (bcrypt) and ENCRYPTED_SETTING_KEYS
(`mpesa_consumer_secret`, `mpesa_passkey`, AES-256-GCM). Widening the route gate
alone would have handed a manager the supervisor PIN and the merchant's M-Pesa
credentials. The guard is an ALLOW-LIST and runs **before** both branches —
asserted by index comparison, and mutation-checked by moving it below the bcrypt
branch, which turns that assertion red.

**No desktop change was needed.** `ReceiptTextTab` writes exactly those two keys
(`ipcHandlers.ts:1591-1592`), and the tab is already listed for managers. The
tab was never wrong; the cloud was.

**ONE STEP LEFT, and it is yours:** grant `receipt.manage` to the Manager role in
the dashboard Roles screen. The key was registered by migration 75, so this is a
tick-box, not a migration. Until then no one holds it and the tab still refuses.

**Not granted by migration, deliberately** — same reasoning migration 75 used for
A46's keys: which roles may edit what a customer sees on a receipt is a business
decision, and a migration is the wrong place to make it silently.

### A59 · P1 · CLOSED 08-13 · The till gates on ROLES; the cloud gates on PERMISSION KEYS
Found while closing A45, and it is the reason A45 happened rather than a detail of it.

`apps/desktop/src/renderer` contains **no permission-key plumbing at all** —
`grep -rn "permissionKeys\|hasPermission" apps/desktop/src/renderer` returns
nothing. Every till gate is a role test: `ManagerPage.tsx:1046`'s `isManagerRole`
decides Receipt, Close Day, Close Branch, Prices, Staff and the rest. The cloud
decides the same actions with `requirePermission` / `requireAnyPermission` on
seventeen keys.

So the two sides are not two gates disagreeing about one key — they are **two
different vocabularies**, with no translation and nothing comparing them. §L in
its purest form, and the most consequential instance found so far:

- A45 is one visible symptom. There are 14 role-gated tabs on that page and any
  of them can disagree with the cloud the same way.
- `check-permission-parity` **cannot see the till at all.** Its UI surface scan
  covers `apps/dashboard/src` and `apps/desktop/src/renderer`, and finds zero
  keys in the latter — so every till gate is invisible to the comparator built to
  catch exactly this.
- Granting a manager a narrow key changes what the CLOUD allows and nothing about
  what the till SHOWS. The two will keep drifting as A46 continues.

**Not fixable in a batch.** It needs permission keys delivered to the till (they
are not in the staff token today), a `hasPermission` on the renderer, and the 14
gates re-pointed — with the offline case decided, since a till that cannot reach
the cloud must still decide what to show. **Design decision first, then a phase.**

**UPDATED 2026-08-12 — the diagnosis above was written from a grep and is partly
stale; verified against source.** The plumbing already exists: `verify-pin`
returns `permissions` as a `Record<string,boolean>`, the main process caches it
for offline (`pinCache.ts`) and delivers it to the renderer, and
`ManagerPage.tsx:1030` already has `has(key) = perms['*'] || perms[key]` —
identical to the dashboard and cloud. **The offline case is therefore already
decided** (`has()` reads the cached map). The real work was re-pointing the four
gates still on the coarse `isManagerRole`:

- **Receipt → `receipt.manage || settings.manage`** — matches the cloud
  (`business.ts` `requireAnyPermission('receipt.manage','settings.manage')`); the
  A45 symptom, closed in the till. Grant via migration 78.
- **Printers -> `stations.manage`.** Migration 79 grants that key to the manager
  roles (registered by 75, it had been granted to no one and enforced nowhere —
  the "printers hid inside settings" dead key). The till Printers tab now gates on
  it and the cloud station routes enforce it additively
  (`requireAnyPermission('stations.manage','products.manage')`). Additive and
  verified (`test-migration-79`, 8 assertions; parity green; both tsc clean). This
  is the first batch of the permission-model decision (`docs/permission-model.md`).
- **Close Day / Close Branch — left on the role gate deliberately.** The code
  states they are cash operations that *"must not hide behind settings.manage"*,
  gated on `dayService.isManager()`. Re-pointing them would be a design change.

Two cloud-side inconsistencies surfaced and are **not** fixed here: `stations.manage`
is enforced on no route (stations CRUD uses `products.manage`), and
`POST /shifts/:id/force-close` gates on `settings.manage`, not the registry's
`shifts.force_close`. **Done this session:** `check-permission-parity` extended to
scan the till's `has()` helper (four keys now visible where zero were, baseline
unchanged), and the renderer typechecks clean (`tsc --noEmit`, exit 0).
**Grant now proven on the bench (08-13).** The one benchable gap — whether
migration 78 actually grants `receipt.manage` to manager AND supervisor AND
branch_manager, or those roles silently lose the Receipt tab — is closed:
`scripts/test-migration-78.mjs` runs 78 against real Postgres (PGlite), 7 checks,
**mutation-checked** (drop `branch_manager` from the grant set and two assertions
fail). It confirms all three manager-type roles are granted, the normalised match
catches "Branch Manager" with a space (A61), the grant is additive (an unrelated
Cashier grant is untouched) and idempotent, and — since 78 does not self-register
the key — that 75 must run first or the grant is inert.

**Closed on the same basis as A66/A43:** the permission model is proven (the grant
test, the `has()` gate, `check-permission-parity` now seeing the till), only the
render is not. **The one remaining step needs Windows:** sign in on a real till as
a manager holding `receipt.manage` and confirm the Receipt tab appears and Save
succeeds (the A45 loop). Two cloud-side inconsistencies surfaced here are OUT of
this finding's scope and recorded in the working note for a later pass:
`stations.manage` is enforced on no route (station CRUD gates on `products.manage`),
and `POST /shifts/:id/force-close` gates on `settings.manage` not the registry's
`shifts.force_close`. Full working note: `docs/A59-till-permission-keys.md`.

### A55 · P1 · CLOSED 2026-08-11 · `total_spent` was the last racy write on the customer row
`orders.ts` updated `customers.total_spent` by SELECTing the value and writing
back `current + amount`, in three places: order paid (`:800`), order voided
(`:1323`), payment recorded (`:1869`). Two tills serving the same customer at
once both read the old value and both wrote their own total, so one sale
silently vanished from lifetime spend and from every RFM / CRM segment built on it.

**It was the odd one out, which is what makes it a defect rather than a
tradeoff.** `loyalty_points` and `visit_count` on the SAME row have been atomic
since migration 53, and `awardLoyaltyPoints` calls that RPC about twenty lines
above. `adjust_product_stock`, `apply_credit_transaction` and
`increment_discount_usage` are RPCs for the same reason — the 08-08 session
converted three racy stock writes deliberately. The comment here read
*"inline — no RPC dependency"*, which was true and was the problem.

**Migration 77** adds `increment_customer_spend(uuid, numeric)` (signed, so the
void subtracts; floored at 0) and `adjust_customer_visits(uuid, int)`. Kept
separate for migration 67's stated reason: a payment recorded against an
existing order adds spend WITHOUT counting a second visit.

The void path wrote all three columns in one read-modify-write, so it now makes
three RPC calls — `adjust_loyalty_points` (migration 67, already existed),
`increment_customer_spend`, `adjust_customer_visits`. A partial fix would have
left a racy write in the same statement and read as if it had been handled.

**Proven by racing it, not by asserting about it** (`scripts/test-migration-77.mjs`,
13 assertions): the OLD shape banks 100 + 250 and records **250**; the new shape
keeps 350; twenty concurrent increments of 50 all land. An assertion that only
read the SQL would have passed against the racy version too.

**Also fixed in passing:** the void path's customer update had no
`.eq('business_id', …)`, unlike the other two writers. Safe because `order` was
fetched business-scoped, but it was the odd one out; the RPCs take the customer
id alone, so the inconsistency went with it.

### A60 · P1 · CLOSED 2026-08-11 · The register disagreed with itself — now gated
This file's preamble says *"a header that disagrees with its own body is the same
failure the register exists to catch."* It then did exactly that, twice over:

- **The header claimed `0 P0`** while §A carried `A17 · P0 · OPEN` — the day-15
  lockout, hidden by the count that decides what gets worked on next.
- **Ten audit IDs had two `###` headings each** — A4, A9, A25, A45, A46, A47,
  A50, A57, A58, D8, D14 — several with contradictory statuses. A57 said both
  OPEN and CLOSED in the same file.

**THREE OF THOSE DUPLICATES WERE CREATED ON 2026-08-11 BY THE SESSION THAT
CLOSED THIS ITEM** (A45, A57, A58), hours after criticising the same failure in
the same file. That is the argument for a gate rather than more care: at 2,200
lines, reconciling this register by reading is a session's work nobody schedules.

`scripts/check-register-consistency.mjs` now checks (a) no ID has two headings
and (b) the header's open P0–P3 counts match the body. All ten duplicates merged
into single authoritative entries, with the superseded text retained in place as
a labelled note rather than deleted. Header re-derived from the body, not
hand-counted.

**It deliberately does NOT check whether a status is TRUE** — whether something
marked CLOSED really is. Only running the code can tell you that, and a gate that
appeared to check it would be worse than one that admits it does not (A49).

**Also ratchets A53** (see that entry): 21 orphan audit-ID citations, may shrink,
may never grow.

### A61 · P1 · CLOSED 2026-08-11 · Role grants missed any business that typed the role name with a space
**A bug shipped by this session in migration 75, found by running the A58
verification query against a seeded database.**

`roles.name` is free text and per business (`roles.business_id` is NOT NULL).
Migrations 24, 49 and 75 all grant on:

```sql
lower(r.name) IN ('manager','supervisor','branch_manager','admin','owner')
```

A business that typed **"Branch Manager"** with a space never matched
`branch_manager` and silently received no grant. No error — the staff member
simply cannot receive stock, and the manager dashboard simply has fewer tabs.
The A58 shape exactly, which is how it surfaced.

**One bug in three migrations.** 24 shipped 2026-07 and 49 shipped 2026-08, so
`inventory.receive` and `inventory.transfer` have been missing from such a role
since then.

Fixed at source in 75 and backfilled by **migration 76** for the rows 24, 49 and
the pre-fix 75 already missed. Normalised with `lower(replace(name,' ','_'))` —
the SAME five names with punctuation variance. Deliberately NOT widened to
`ILIKE '%manager%'`, which would sweep in names nobody has looked at ("Trainee
Manager") and hand them stock and revenue access as a side effect of a backfill.

**76 restricts itself to roles whose NORMALISED name matches but whose RAW name
did not**, so it touches only the rows the bug skipped rather than re-deriving
every grant. The migration carries a SELECT showing exactly who is affected —
run it first if you want the blast radius before committing.

### A62 · P1 · CLOSED 2026-08-11 · Migration 76 failed in production — one unqualified table name
**Reported from the field, 2026-08-11:**

```
ERROR:  42P01: relation "role_permissions" does not exist
LINE 46: INSERT INTO role_permissions (role_id, permission_id)
```

The table exists. The session's `search_path` did not include `public` —
Supabase's hardened default in several contexts. **Line 46 was the only
unqualified name in the file**: every other reference was written
`public.…`, including one to the SAME table eleven lines below, inside the
`NOT EXISTS` guard. Mixed qualification in a single statement, shipped by this
session in batch `-e`.

**Reproduced before fixing** (`SET search_path TO ''` under PGlite), then all
three of 75/76/77 re-run under both `search_path = public` and `search_path = ''`
with identical results.

**Fixed by qualifying every table reference in 75, 76 and 77.** 77 was already
fully qualified. 75 was fully UNqualified, which is worth noting: it inherited
that from migrations 24 and 49. It would have failed the same way in the same
session — so if 75 appeared to succeed earlier, it ran somewhere with `public`
on the path, and its section 3 grant should be re-verified.

**The lucky failure, and the one to fear.** This aborted on its first statement,
so nothing committed. The dangerous shape is a file whose EARLY statements are
qualified and whose later ones are not: the early half commits, the run aborts
part-way, and whether `schema_migrations` records it depends on where the ledger
INSERT sits. That is a half-applied migration, the hardest state to diagnose later.

**Gated.** `check-schema-drift` check D flags unqualified DML targets, ratcheted
at 22 — 12 of 71 migrations predate the rule and have already run, and demanding
they change would be rewriting history to make a gate green. Table names are
read from `schema-index.json`, not guessed by regex, because a bare word match
reports `OF`, `ON` and `TO` as tables and a gate that cries wolf gets ignored.
Mutation-checked by reintroducing the exact production bug: it names
`role_permissions` at line 46.

### A63 · P2 · CLOSED 08-13 · The onboarding permission seeder never learned A61's lesson
`apps/server/src/lib/defaultRolePermissions.ts` decides a new role's grants by
**exact, un-normalised name match** — `nm === 'manager'`, `nm === 'branch_manager'`
(lower-cased only). The grant migrations 24/49/75 shipped this exact bug and
migration 76 fixed it by normalising `lower(replace(name,' ','_'))` (register
A61). The seeder is the same shape one layer up, un-fixed.

**Not triggered today, which is why it is P2 not P1.** Both onboarding paths
create simple names the exact match handles — self-service
(`onboarding.ts:119`) seeds `Admin / Manager / Cashier`, the agent path
(`admin.ts:406`) seeds `owner / manager / cashier`. Every one matches. The
`supervisor` / `branch_manager` branches in the seeder are dead for onboarding;
they exist only for a caller that passes those names.

**The latent failure.** If a default role name ever gains a space
(`Branch Manager`), or any caller passes such a name to `seedDefaultRolePermissions`,
that role falls through every tier to `false` and is created with **zero**
permissions — not a missing tab, an empty rights set and no staff access — with
no error, exactly A61's signature. Fix once, the same way 76 did: normalise the
name before the tier test (`lower(replace(role.name,' ','_'))`). Cheap now,
because onboarding's names are simple; a field incident the day someone renames a
default.

**Fixed 08-13.** The tier decision is extracted to `apps/server/src/lib/roleTier.ts`
as a pure `roleTier(name)` that normalises with the same `lower(replace(name,' ','_'))`
the migrations use; `defaultRolePermissions.ts` imports it. Kept free of any
supabase import so it loads and tests in isolation. Proven against the REAL
compiled function — `tests/role-tier.test.mjs`, 12 assertions, **mutation-checked**
(remove the space-normalisation and "Branch Manager" → `none` again), including
that a name merely *containing* a keyword ("Trainee Manager") is NOT swept in.
Server `tsc` clean. This makes the seeder and the grant migrations (76/78/82) share
one normalisation rule so they cannot drift about who is a manager.

### A64 · P3 · CLOSED 08-13 · Two manager deny-lists that should agree, don't
The default manager permission set is defined in **two** places with **different**
deny-lists:

- **Migration 59** (backfill for roles that existed then) grants managers
  *everything except* `settings.manage` — a one-key deny.
- **`defaultRolePermissions.ts`** (the seeder for roles created at onboarding)
  denies four: `settings.manage`, `inventory.adjust`, `ingredients.manage`,
  `reports.financial`, with a comment explaining each as owner-only (the last two
  are a theft vector and audit H6's financial reports).

The **code divergence is verified**; its **runtime effect is not**, and the
register does not assert what it has not run (A49). Whether 59 actually granted
the three extra keys to managers depends on whether each was registered when 59
ran, and `check-permission-parity`'s grant parser is blind to 59's
`CROSS JOIN … WHERE key <> …` form, so static analysis cannot answer it. Confirm
against a DB where 59 ran (dev has tenants; prod has none, so prod is unaffected
— its managers come only from the seeder):

```sql
SELECT r.name,
       bool_or(p.key='inventory.adjust')  AS adjust,
       bool_or(p.key='ingredients.manage') AS ingredients,
       bool_or(p.key='reports.financial')  AS fin_reports
FROM   public.roles r
LEFT JOIN public.role_permissions rp ON rp.role_id=r.id
LEFT JOIN public.permissions p ON p.id=rp.permission_id
WHERE  lower(r.name) IN ('manager','supervisor','branch_manager')
GROUP  BY r.name;
```

Any `true` means a backfilled manager holds a key the current policy makes
owner-only — an over-grant on existing tenants, not a break. The fix is to make
the two deny-lists a single shared constant so they cannot drift again, then
decide which policy is correct and reconcile the outliers.

**Owner decided 08-13 — the STRICT policy.** Managers *receive* stock and *see*
inventory and branch reports; they do NOT adjust/manage inventory or see financial
reports — that lives on the web only. So the seeder's four-key `MANAGER_DENY`
(`settings.manage`, `inventory.adjust`, `ingredients.manage`, `reports.financial`)
is authoritative, and migration 59's one-key deny was the over-grant. `MANAGER_DENY`
in `defaultRolePermissions.ts` is the single source of truth for the policy going
forward; any future grant/revoke migration must match it (a SQL migration and a TS
constant can't literally share, so this is a discipline note, enforced by review).

**Reconcile written and proven — `migrations/82_manager_deny_reconcile.sql`.**
Revokes the three over-granted keys from the `manager`/`supervisor`/`branch_manager`
role set (normalised names, A61), leaving owner/admin and every other manager grant
(`inventory.view`, `inventory.receive`, `reports.view`, …) untouched.
`scripts/test-migration-82.mjs` — 10 checks against real Postgres, **mutation-checked**
(drop the role scope and the owner-untouched assertion fails). Idempotent; the DELETE
is a no-op on a database where managers never held the keys, so it is safe to apply
regardless of the runtime uncertainty the query above could not resolve.
**Before applying to prod, run the blast-radius SELECT at the foot of the migration**
to see exactly which (business, role, key) rows it removes; a per-shop exception
that an owner wants kept is re-granted in the Roles screen afterward.

### A65 · P1 · CLOSED 08-12 · The daily-report scheduler: the toggle never persisted, and the sender ignored it
Same feature as A54 (the daily summary email), a different layer. A54 is
TRANSPORT — mail that never leaves the instance. This is SCHEDULING and CONFIG —
what the owner sets and whether the job honours it. Reported by the owner: *"save
send reports shows saved but reverts to off."* Two bugs.

**1. The read route did not exist.** The dashboard reads its toggle state from
`GET /api/business/settings/report-schedule`. There was no such route. The 404
was swallowed by a `.catch(() => {})`, so the control fell back to *off* on every
load — the value HAD saved (POST `/settings`, key `report_schedule`), it was
simply never read back. Fixed: added `GET /settings/report-schedule`
(`business.ts`) — reads the `business_settings` key, tolerant parse, defaults to
`{enabled:false, send_time:'21:00', recipients:[]}`.

**2. The sender ignored the config entirely.** `dailySummary.ts` ran one global
cron, emailed only the owner, and never read `enabled`, `recipients` or
`send_time`. Rewritten to decide per business: send only if `enabled`, at that
business's own `send_time` (EAT), **once per EAT day** (dedup via a
`report_schedule_last_sent` stamp written only after a successful send), to
**owner + active branch managers** (users joined to `roles`, name normalised to
`branch_manager`, with an email on file) **+ the schedule's added addresses**,
deduped. The cron now runs every 15 min so per-business times can be honoured.

**Owner decisions, 2026-08-12:** `enabled` is authoritative (off stops the mail);
recipients are owner + branch managers + the added list; `send_time` is
per-business.

**Verified on the bench:** server `tsc` green; the send decision was extracted to
`reportScheduleDecision.ts` (pure, no imports) and the REAL compiled function run
through 16 cases — disabled/null/undefined, dedup (sent-today vs sent-yesterday),
the time boundary (before/at/after), minute precision, non-padded and default
times, and dedup-beats-time. What the bench CANNOT prove and a live check must:
the cron firing, the branch-manager query against real rows, and actual delivery.

**Two behaviour changes, flagged deliberately:** (a) because the read was broken
no business has `enabled=true` persisted, so after deploy only businesses that
opt in are emailed — correct per the toggle, but the current always-on owner
email stops until each opts in; (b) if the prod env `DAILY_SUMMARY_CRON` is set
to a once-a-day value it DEFEATS per-business `send_time` — unset it.

**Not closed by this:** delivery. A working scheduler still sends into a filtered
port — that is A54, still blocked on the owner. The live report-schedule check
(enable for a test business, `send_time` a few minutes out) is also the cleanest
end-to-end exercise of A54's transport.

### A66 · P1 · CLOSED 08-13 · Kitchen exclusions never reached the till — and the local override that lets an offline till own them
Two things in one entry because the fix and the feature are the same code path:
a bug that made the cloud list silently vanish, and the local override built on
top of the now-working persistence.

**The bug — `saveDeviceConfig` dropped `kitchen_exclusions` on the floor.** The
column was in the `DeviceConfig` type, the read map and the merge object, but
**absent from the INSERT column list, the VALUES and the ON CONFLICT SET.** So
`syncEngine`'s `saveDeviceConfig({ kitchen_exclusions })` (the only writer)
merged the value and then wrote a statement that never named the column: on
insert it took the column default (NULL), on conflict it was not in the SET, so
the existing value stood. The till's `device_config.kitchen_exclusions` stayed
NULL forever, `escposBridge.kitchenExclusions()` returned `[]`, the printer
applied no exclusions, and the read-only box A43 shipped always showed empty —
the owner configured drinks-off-the-kitchen-ticket on the dashboard and the till
sent them anyway. `escpos_enabled` survives the same omission only because it has
its own dedicated `UPDATE`; `kitchen_exclusions` had no such fallback.
**Invisible to every gate:** `check-sql-binds` only balances placeholders, and
the statement was internally balanced — it simply never mentioned the column.
Proven by executing the file's own INSERT under `node:sqlite`: the value did not
land. Fixed by adding `kitchen_exclusions` (and the new override, below) to the
INSERT/VALUES/SET and the bound args; binds re-verified balanced.

**The feature — "cloud editable, local is final" (owner decision, 08-13).** Cloud
stays the **business-wide baseline**, edited on the web dashboard, refreshed on
every catalogue pull — unchanged, and now actually persisting. Each till gains a
**local override**: new `device_config.kitchen_exclusions_override`
(`LOCAL_SCHEMA_VERSION` 51 → 52, additive/idempotent via `migrateColumns`, no
replay). The reader resolves `override ?? baseline`. The override is editable on
**every** till, not gated to a deploy mode — a cloud-connected terminal may still
override the business default for its own printer — saved on blur, with a "Reset
to cloud default" that clears it. `syncEngine` keeps the baseline current and
**never touches the override**, so a local edit wins and survives every sync.
NULL override means "follow the cloud"; an empty-but-present override means "this
terminal excludes nothing, deliberately" — two different states, and the
clear-vs-empty distinction is load-bearing.

**Verified on the bench:** persistence + precedence proven by running the real
INSERT — `tests/kitchen-exclusions-local.test.mjs`, 17 assertions, `node:sqlite`,
**mutation-checked** (reverting the column from the INSERT fails 7). `check-ipc-parity`
138/138 (two new channels, `escpos:setKitchenExclusions` and
`escpos:clearKitchenExclusions`, both bridged and handled); `check-sql-binds`
green; renderer `tsc` clean; main `tsc` shows the identical pre-existing
`@swiftpos/printing` set and **zero new errors** (diffed against the stashed
tree). Recorded in `LOCAL-SCHEMA-VERSIONS.md` (v52).

**What the bench CANNOT prove — a live Windows check must, same limit as A43:**
that the box renders and edits; that the fixed baseline now actually reaches the
till; that the override wins after a sync and "Reset" returns to the dashboard
list. Closed on the same basis as A43 — the data path is proven, the render is
not — with the smoke test called out, not hidden.

**Two findings surfaced en route, recorded so they are not re-discovered:**
- **Cloud exclusions are business-wide by design.** `business_settings` is keyed
  `(business_id, key)` with no branch dimension, and `/api/pos/init` serves one
  list to every branch. Not a bug — a constraint to know before anyone asks for
  per-branch *cloud* lists (that would need a branch dimension + a dashboard
  selector). Local overrides are per-terminal, so per-branch granularity is
  already available that way.
- **A `deploy_mode: 'local'` till is not provisionable.** `InstallPage` hardcodes
  `mode = 'cloud'` (the picker was deliberately removed) and activation requires
  online owner sign-in, so nothing can *become* local yet. This feature works in
  BOTH modes, so it is not blocked on that — but a genuine non-cloud product is.
  Raise as a D-item if standalone provisioning moves into scope.

### A67 · P3 · CLOSED 08-13 · `check-register-consistency` read status from the whole heading, not the status field
Surfaced by D11. The gate decided OPEN/CLOSED by scanning the entire heading for
the words "closed"/"open"/"struck", so a title that merely contained one —
D11's *"…fails closed and kills the catalogue pull"* — was read as CLOSED. An
open item silently left the counts; the header balanced only by coincidence.

Fixed by matching a status LABEL at the start of a leading `·`-separated field
(the first two fields after the ID), never a substring in the free-text title.
Extracted to `scripts/lib/register-status.mjs` as a pure `deriveStatus(rest)` and
imported by the gate. Verified: `tests/register-status-parse.test.mjs`
(12 assertions incl. the D11 title → OPEN, plus REOPENED/PARTLY CLOSED/NOTE/bold
and an "Opening-hours" title that must not read as OPEN-the-status); and the gate
still reports the header agreeing with the body, so no existing entry's status
changed under the new parser. Not a ratchet — a correctness fix with a test.

### A17 · P0 · OPEN · A peer till cannot sell "offline forever" — it locks out on day 15
**Stated design (owner, 08-09):** the main/server till is registered online once;
client tills then rely on the server till and **can keep selling without
internet indefinitely.** The code does not support that today, in three ways.

1. **Authentication is cloud-only.** `ipcHandlers.ts auth:verifyPin` calls
   `ownerFetch`, and `ownerFetch` uses `getServerUrl()` — which is
   `device_config.server_url`, **the cloud**. `node_url` is a separate field
   (`nodeClient.ts:21`) and **the node exposes no auth route at all**: its API
   is `/node/{health,sync,since,report,cursors,instructions,time,tech-session}`.
   There is no `/node/verify-pin`.
2. **So the only offline door is `staff_pin_cache`, and it expires.**
   `PIN_CACHE_TTL_DAYS = 14`, and `cached_at` is written from exactly one place —
   `cacheStaffCredential`, called only after a **successful cloud** verify-pin
   (`ipcHandlers.ts:443`). LAN contact with the node cannot refresh it. **On day
   15 of no internet, every cashier on that till is refused and the shop cannot
   open**, with the message "Saved sign-in expired after 14 days offline."
3. **A cashier who has never signed in on that terminal while online can never
   sign in at all** (D16 caches per-terminal, deliberately), and
   `override_pin_hash` is never cached, so voids, discounts past the floor and
   refunds are impossible for the whole offline period.

The 14-day bound was a correct decision for a *cloud-attached* till — it bounds a
stolen or retired terminal. It is the wrong bound for a till whose authority is
meant to be the branch node.

**This is a design gap, not a bug to patch.** Do NOT simply raise the TTL — that
widens the stolen-till window without giving the node the role the design says
it has.

**DESIGN AGREED 08-09** — owner confirmed the node is the branch's source of
truth and sole cloud uplink, and that it may stay offline indefinitely and may
authorise. Specification in **`docs/PHASE5-NODE-AUTHORITY.md`**. Expiry is
redefined there as "days since ANY authority was reached", so a peer that sees
its node daily never expires and a node never expires at all.

IMPLEMENTATION FOUND 2026-08-23 (source pass — the entry above is STALE; PHASE5
§4 was built and never recorded here, rule 14). The A17 lockout is fixed IN CODE:
  • §4c node auth route — `POST /node/verify-pin` exists (`nodeServer.ts:160`,
    handler `verifyPinAtNode` in `branchStaff.ts`), `X-Node-Secret`-guarded.
  • §4a/§4b node roster — `branch_staff` table + `branchStaff.ts`, pulled from
    `GET /api/pos/branch-staff` (`pos.ts:21`) on every catalogue sync. That
    endpoint carries the full four-condition guard the spec demanded (surface=
    desktop, own business, `isNodeRole(device_role)`, device's own branch).
  • §4d peer authority chain — `ipcHandlers.ts:487-534`: node (LAN) → cloud →
    last resort, falling back ONLY on transport failure; a rejection from either
    authority is final. A node authenticates against its own roster (never
    expires); a peer uses the cache.
  • §4e expiry — `pinCache.ts:148`: a node-configured peer's cache is not
    subject to the 14-day cutoff. So "day-15 lockout" no longer occurs for a
    node-attached till. Prerequisites are in place: D14 (registration) CLOSED,
    D4 (enrolment) implemented-pending-verify, `isNodeRole` built server-side.

So this is no longer an "unstarted design gap" — it is built and additive. WHY IT
STAYS OPEN P0: (1) **not yet on the tills** — desktop has no auto-update (D3 open)
and `main` lags `dev`, so the running terminals likely predate this fix; the P0
is live in production until the fix is installed. (2) **No live proof** (rule 16):
needs a real node + peer over 15+ offline days to confirm a node-attached peer
keeps selling. (3) **A19 is NOT closed by this** — the node still does not forward
peer sales to cloud (`nodeServer.ts:10-23` says so plainly); a permanently-offline
peer can now SELL indefinitely (A17) but its sales still do not BACK UP to cloud
(A19, separate P1). Two caveats to weigh, not necessarily bugs: §4e is implemented
as "has a `node_url` → never expires" (broader than the spec's "days since any
authority reached" — a node-configured peer that hasn't reached its node in weeks
still never expires); and the node-verify path does not call `cacheStaffCredential`,
so the last-resort cache is populated only by cloud verifies (fine while the node
is the daily authority). TO CLOSE: ship to tills + a live two-till offline test.
Delivery of this correction: MANIFEST-2026-08-23-s.md.

### A18 · P1 · OPEN · `nodeServer.ts` documents an architecture that no longer exists
Its header states the node is *"the SOLE uplink to the cloud: peer tills never
push to the cloud directly, so an order reaches the cloud by exactly one path
(till → node → cloud)"*, and that received peer orders are *"re-enqueued into
this node's sync_queue so the existing cloud push forwards them."*

**Both statements are false in the current tree.** `syncEngine.ts:1138-1151`
says the opposite explicitly — every till pushes its own orders to the cloud and
"the node is now a replica, reached separately by `pushToNode()`" — and
`nodeIngest.ts:414-418` records the reason (two destinations cannot share one
status column). `INSERT INTO sync_queue` appears in exactly one place,
`syncEngine.ts:1566`, at order creation on the till that made the sale.
**Nothing re-enqueues peer rows for cloud push.**

This is the file a new reader opens to learn the architecture. Header corrected
08-09 to describe the tree as it stands. **The finding stays open until §3 of
`docs/PHASE5-NODE-AUTHORITY.md` is implemented**, at which point the ORIGINAL
header becomes true again and the corrected one must be corrected back. Noted
here so that does not read as a regression.

### A19 · P1 · OPEN · A permanently-offline peer's sales never reach the cloud
Follows from A18. A peer till pushes to two independent destinations: the cloud
(`sync_queue`) and the node (`node_queue`). Under the stated design the peer has
no internet, so:

- the node receives the sales over LAN, so **branch totals and manager reports
  are correct locally** — this half works;
- the peer's `sync_queue` never drains, and the node does not forward it, so
  **the cloud never sees those sales.** The owner's web dashboard, cloud
  reports, eTIMS fiscalisation and cloud-side loyalty are all short by every
  peer sale, indefinitely, with no error anywhere.

**RESOLVED 08-09 — the node forwards.** Owner confirmed the node is the only
link to the cloud, and that cloud sync is for web access and backup rather than
for branch operation. A peer with a `node_url` will push to the node only; the
node enqueues peer rows into its own `sync_queue` preserving the original id and
idempotency key. The two-queue separation stays — `syncEngine.ts:1138-1151` was
right about the mechanism and wrong about the routing. See
`docs/PHASE5-NODE-AUTHORITY.md` §3, including why a node outage delays cloud
backup rather than losing sales, and why idempotency makes a mixed-version
rollout safe.

STATUS + FIX MAP 2026-08-23 (source pass — design agreed, §3 NOT yet built;
this is the remaining half of the node-authority rollout, A17 being the built
half): confirmed current state, self-documented in code —
  • Every till enqueues its own sale to the cloud queue at
    `syncEngine.ts:1780` (`INSERT INTO sync_queue`, `idempotency_key = orderId`),
    peer or not.
  • The node ingests peer rows via `nodeIngest.applyPeerRows` and stamps them
    `sync_status = 'peer'` (`PEER_SYNC_STATUS`) **specifically to keep them out of
    its own cloud push** — the node is a replica, not a relay (its header at
    `nodeServer.ts:14-30` says so). The node outbox (`nodeIngest.ts:410+`) is the
    peer→node direction only; there is no node→cloud forward of peer rows.
  So an offline peer's `sync_queue` never drains and nothing else drains it →
  cloud never sees peer sales. A19 = unbuilt, exactly as filed.

Concrete §3 change points (for whoever implements — money path, ship last):
  1. **Peer stops double-pushing** — `syncEngine.ts:1780`: when the till has a
     `node_url`, don't enqueue to `sync_queue`; push node-only. Rollout safety:
     if the node returns 404 to the new forward-capable ingest (old node build),
     fall back to enqueuing `sync_queue` so sales are never parked (§3).
  2. **Node forwards** — in `applyPeerRows`, for peer ORDER rows also create a
     row in the NODE's own `sync_queue`, preserving the peer's original order id
     and `idempotency_key`, so the node's existing cloud push relays them. Keep
     the two-queue separation intact (this bridges, it doesn't merge).

Hardest part (flag): the node must produce the cloud `/api/orders` payload for a
forwarded peer sale. `applyPeerRows` writes the peer order into the node's tables
but does not retain the peer's original push payload; forwarding must either stash
that payload at ingest or reconstruct it from the node's tables exactly as the
peer would have sent it. Idempotency (`orders.ts` short-circuits duplicates on
`idempotency_key`) makes a mixed-version window safe — a peer on the old build
pushing straight to cloud and a new node forwarding the same row both dedupe.

Dependencies: PHASE5 §8 sequences §3 LAST (it moves money paths); ideally after
D3 auto-update (a bad routing build is a site visit). Pairs with A17's deployment
— A17 lets a remote peer keep SELLING offline; A19 is what makes those sales
reach cloud (web dashboard, eTIMS, cloud loyalty, backup). Target-only: closing
needs a live node + peer + cloud, verifying a peer sale reaches cloud once, with
the peer's original id and no duplicate. Not built on the bench (rule 16/20).
Delivery of this status note: MANIFEST-2026-08-23-t.md.

### A20 · P1 · OPEN · Failover cannot open the shop — the staff roster does not replicate
Follows from the owner's failover requirement (08-09) plus PHASE5 §4a. Promotion
already works well — `tech:promoteToNode` (`ipcHandlers.ts:1746`) is
session-gated, audited, clears `node_url` and starts serving; `collectDistribution`
fans every origin's rows to every peer; orders carry `_items` and `_payments` as
children (`nodeIngest.ts:641-648`), so a promoted till holds COMPLETE orders.

But `REPLICATED_TABLES` is `orders, shifts, float_transactions, expenses,
business_days, events`. PHASE5's `branch_staff` is specified node-only, so a
promoted till would hold every sale in the branch and **no way to authenticate
anyone** — the shop stays shut at exactly the moment failover exists to prevent.

**Decision required from the owner** — replicating the roster means a stolen
peer yields the branch's PIN hashes. Recommendation, tradeoff table and the
"a branch is one trust domain" argument in `PHASE5-NODE-AUTHORITY.md` §10.1.
Includes a runbook item that does not exist today: **rotate PINs when a terminal
goes missing.**

**SOURCE PASS 2026-08-24 (batch -e) — confirmed at source; unbuilt; change map.**
Current state, verified in the tree:
  • The roster lives in a node-local table `branch_staff` (`localDb.ts:95`), written
    by `storeBranchStaff` (`branchStaff.ts:43`) during the node's OWN cloud sync
    (`syncEngine.ts`, from `/api/staff`) and read by `verifyPinAtNode`
    (`branchStaff.ts:83`) to serve `/node/verify-pin`. It is A17's built half.
  • `branch_staff` is **not** in `REPLICATED_TABLES` (`nodeIngest.ts:32` = the six
    sales tables) and there is **no `/node/roster` endpoint** (`nodeServer.ts` serves
    since/report/time/tech-session/verify-pin/health/sync/cursors only). The roster
    never leaves the node.
  • `tech:promoteToNode` (`ipcHandlers.ts:2081`) starts a peer serving at once; via
    distribution it holds every sale, but an empty `branch_staff` authenticates no
    one — the shop stays shut at the moment failover exists to prevent.

Why this is NOT a one-line `REPLICATED_TABLES` add (the structural finding): the six
replicated tables are device-originated, append-mostly, per-origin `seq`-numbered, and
`collectDistribution` (`nodeIngest.ts:648`) fans them keyed on `device_id`+`seq`. The
roster is the opposite — a single branch-authoritative, cloud-sourced, MUTABLE
snapshot (staff added/removed, PINs changed) with no per-device seq. It cannot ride
the origin/seq fan-out; it needs a **node-authoritative snapshot channel** (node serves
the current roster + a version, peer replaces `branch_staff` wholesale on change) — the
SAME channel A24 needs, so **A20 is a special case of A24's downstream snapshot**.

Change points (target-only to build/verify):
  1. `nodeServer.ts` — new `POST /node/roster` (branch-gated like `/node/since`):
     return `branch_staff` rows for the node's branch + a `roster_version`.
  2. `nodeClient.ts` + `syncEngine.ts` — a peer with a `node_url` pulls `/node/roster`
     on sync and calls `storeBranchStaff` to replace its copy (reuse the existing
     DELETE+INSERT writer). Peers only; a node keeps sourcing from the cloud.
  3. `tech:promoteToNode` — pull-on-promote as a backstop so a freshly promoted peer
     is guaranteed a current roster before it serves.

DECISION (owner), now sharper: this puts the branch's **bcrypt PIN hashes on every
peer, not just the node** — a stolen peer yields them. §10.1 "a branch is one trust
domain". Missing mitigation: the **PIN-rotation-on-missing-terminal runbook**. Ship
with A24's channel; sequence after A19, ideally after D3 (a bad build is a site visit).
Delivery of this note: MANIFEST-2026-08-24-e.md.

### A21 · P1 · CLOSED 08-09 · `outbox_cursors` is not keyed by node — rows strand on repoint
`localDb.ts:854` — `PRIMARY KEY (table_name)`. A peer records how far it has
offered its own rows as one number per table, with **no record of which node it
offered them to**. `peer_cursors` on the node side is correctly keyed
`(device_id, table_name)`; the peer side is not.

On failover: peer C has offered `orders` to seq 500; the dead node had only
distributed to 430 before dying; peer C is repointed at the promoted till and
**never re-offers 431-500**. Not lost — they are on peer C — but absent from the
new source of truth, the day close, and (under PHASE5 §3) the cloud, with nothing
reporting a gap.

**Fix:** reset the outbox cursors in `tech:setNodeUrl` when the URL actually
changes. Ingest is `INSERT OR IGNORE` / upsert-by-id, so re-offering everything
is absorbed — the same property that makes PHASE5 §3's rollout safe. Two lines,
no schema change. Keying the table `(node_id, table_name)` is cleaner but is a
local-schema change, and D6 already records six undocumented generations of that.
See §10.2.

**CLOSED 08-09.** `resetOutboxCursors()` in `nodeIngest.ts`; called from
`tech:setNodeUrl` **only when the URL actually changes** — re-entering the same
address must not trigger a full re-offer. The repoint audit line now carries
`node_changed`, and the reset is logged to `swiftpos.log`.

Option 2 (keying the table `(node_id, table_name)`) was NOT taken: it is a
local-schema change to the mechanism that decides whether a field till works, and
D6 already records six generations of that going undocumented. Revisit only if a
branch ever runs two nodes at once. The test asserts the current primary key, so
it will fail loudly if that ever changes.

12 tests in `apps/desktop/test/failover-cursors.test.mjs`, mutation-checked by
removing the DELETE (9 passed / 3 failed, exit 1; restored, exit 0). Ran on
`node:sqlite`, and **the suite prints that it did** — it is a stand-in, not the
app driver. Run under Electron on the target for a hardware-equivalent green.

**A25 — the original finding.** Retained verbatim; its closure is the A25 entry later in this file (the server can now verify a claimed role).
Found while attempting PHASE5 §4b. **`device_role` does not exist anywhere in
`apps/server`** — grep returns nothing. So an endpoint that hands out the
branch's PIN hashes could only be gated on `surface === 'desktop'`, which every
till has, and on an owner token, which every till holds.

**The credentials endpoint was therefore NOT built.** Shipping it against that
guard would hand the branch roster to any till, and to anyone who lifted an owner
token off one — the opposite of what PHASE5 §4b exists to do.

This is the concrete form of the D4/D14 prerequisite named in PHASE5 §7. The
server must be able to verify that a caller is the branch's node before any
credential can cross that boundary. **D14 first (register the device), then D4
(enrol it), then §4b.**

### A22 · P2 · OPEN · Promotion has no split-brain check
`promoteToNode` clears `node_url` and starts serving immediately with no check
that the old node is gone. An old node that was merely unplugged, then
reconnected, gives the branch two nodes and peers pointed at either. Nothing
detects it. Low urgency while promotion is a human tech-session action, but a
node that can reach another node on its own branch should say so loudly. §10.5.

### A23 · P2 · OPEN · Distribution lag is the real RPO and is not measured
Promotion cannot recover rows the dead node originated but never distributed —
its own sales live only on its disk. So the recovery point is however far behind
distribution was, and **nothing measures or displays that**. Wanted: a "last
distributed" age on the tech screen. Also a runbook line that does not exist:
**do not wipe or re-image a failed node until its `swiftpos.db` has been read.**
§10.4.

### D14 · P1 · CLOSED 08-10 · The till is not registered — cause found, and it was not the upsert
**I called this a one-line upsert on `sync.ts:71`, then a device-enrolment
design decision. Both were wrong**, and the rule 17 sweep found far more built
than the register credited: `lib/deviceBinding.ts` (181 lines — rebind windows,
relocation history, terminal-code conflict handling, fails-open-until-bound),
`routes/devices.ts` (216 lines — fleet, approve, reject, delete, permission
gated) **and it is mounted**, at `routes/index.ts:94`.

**The cause is `auth.ts:432`:**

```js
const required = setting?.value === 'true' || setting?.value === true;
if (!required) return { result: 'allowed' };
```

Registration sits behind an opt-in business setting Beryl never enabled — and
`checkDeviceRegistration` returns earlier still for owners and elevated roles, so
a desktop till signing in as the owner fell through **both** gates.
`/desktop-login` registered nothing at all. Nothing was broken; registration was
never reached.

Three subsystems then degraded to silent no-ops while looking healthy:
migration 52's branch binding (`checkDeviceBranch` waves an unknown device
through, by design), fleet telemetry (an UPDATE matching no rows is not an
error), and A25.

**MEASURED IN PRODUCTION 2026-08-10, before the fix deployed:**

```
select count(*) from public.user_devices;                    ->  0
select count(*) ... where business_id = '<beryl>';           ->  0
select ... where key = 'require_device_registration';
   Lovers Rock | require_device_registration | false         (one row, all tenants)
```

**Zero registered devices across the ENTIRE fleet — ten businesses, seven of them
non-test.** And exactly one row for the flag anywhere: someone opened that
setting on Lovers Rock once and left it off.

So this was never a Beryl problem. **Device registration has never run for any
tenant, ever.** Everything downstream of it has been dead code in production
since the day it was written:

- `lib/deviceBinding.ts` (181 lines) — branch binding, rebind windows,
  relocation history, terminal-code conflict handling. Never executed.
- `routes/devices.ts` (216 lines) — fleet view, approve, reject, delete. Mounted
  at `routes/index.ts:94`, permission-gated, and always empty.
- Migration 43's telemetry columns — `app_version`, `schema_version`,
  `last_sync_at` never written for any till, so every diagnosis has required
  somebody physically at the machine.
- Migration 52's anti-relocation control — inert everywhere. A till moved
  between branches has been undetectable this whole time.

That is a large amount of correct, careful, well-tested work that has never once
run, gated behind a boolean nobody knew to set. **The lesson is not "turn the
flag on"** — it is that a subsystem with no observable output cannot tell you it
is idle. Nothing anywhere reported an empty fleet as unusual.

**Fix — the two concerns were conflated and are now separated.**
`require_device_registration` means *"cashiers must be approved before signing in
from a new BROWSER"*. It is a real, optional policy and is **untouched**. But a
desktop till is not a browser: it has a stable `device_id`, it is bound to a
branch, it is the unit migration 52 exists to control. So `lib/deviceRegistry.ts`
registers desktop terminals **unconditionally**, from `/desktop-login` and
`/verify-pin`.

New rows land `approved`, not `pending`: a pending row blocks the shop until
somebody opens the dashboard, which is unacceptable at the remote thin-internet
sites this product targets. Defensible because reaching that code already
required a valid owner token or a verified PIN — more than a browser fingerprint
proves. **An existing row's `status` is never touched**, so a rejected terminal
is not silently re-approved by signing in again.

**Registration is not authorisation.** No `branch_id` is set — `checkDeviceBranch`
owns binding, and guessing here could bind a till to the wrong branch
permanently. No `device_role` is set, so **A25 remains open by design**.

### A26 · P1 · CLOSED 08-10 · Fleet telemetry failed silently and blamed the wrong thing
`sync.ts` reported only an `error`. An UPDATE that matches **no rows is not an
error**, so a till with no `user_devices` row discarded its telemetry in silence
— the common case. The one message that could appear asked *"is migration 43
applied?"*, and 43 **is** applied, so the single available clue pointed away from
the cause. That is why diagnosing Beryl needed somebody physically at the machine.

Now `.select('id')` makes the matched count visible and a zero-row match says the
terminal has never registered, explicitly clearing migration 43. The mutation
check is enforced by the compiler: remove the `.select('id')` and there is no
`data` to count, so `tsc` fails.

20 tests in `tests/device-registration.test.mjs`, mutation-checked both ways.

### A27 · P1 · CLOSED 08-10 · The server could not tell what a terminal IS (and PHASE5 excluded office)
Raised by the owner: *"does this involve the view-only node?"* It did, and the
PHASE5 design was wrong.

`deviceConfig.ts:26` — `DeviceRole = 'till' | 'node' | 'office'`. Office is a
branch server that **cannot sell**: no drawer, no shift, no cash, safe
unattended, not meant to consume an activation seat. The file supplies
`isNodeRole()` and `canSell()` precisely so nobody tests the literal, and warns:
*"comparing against the literal 'node' anywhere else is how office machines fall
through cracks."*

**PHASE5 §4b did exactly that** — it gated credential distribution on
`device_role === 'node'`, which would have refused an office machine the branch
roster. Backwards: an office box is the BETTER holder, because it is the machine
that is safe unattended, which is the whole security argument of §10.1.
Corrected in `PHASE5-NODE-AUTHORITY.md` §12; every server-side gate now uses
`isNodeRole()`.

Three things were missing and are now built:
- **`user_devices` had no role column** (confirmed against the live dump).
  Migration **73** adds `device_role` (CHECK till|node|office) and
  `role_reported_at`, plus a `branch_serving_devices` view — the SQL form of
  `isNodeRole()`, with `is_view_only` marking an office machine.
- **The till never reported its role.** Sync sent `X-Schema-Version`,
  `X-Device-Id` and app version, nothing more. Now `X-Device-Role` too.
- **Registration ignored it.** `deviceRegistry.ts` stores and labels it — an
  office machine no longer appears in the fleet view as a till.

**Numbered 73, not 72:** migrations 68 and 72 are absent from this repo and 68 is
known to exist in production (A4). Reusing 72 would collide with whatever is
already applied there.

Existing rows stay NULL — *has not reported* — rather than being defaulted to
`till`. A guess that reads as a fact would make a branch server look like a
counter terminal until somebody noticed.

**A25 is NOT closed by this.** The server can now SEE a claimed role; it still
cannot VERIFY one. A device asserting `office` is exactly as trustworthy as a
device asserting its branch was before migration 52. Enrolment (D4) is what makes
it checkable, and no credential may cross that boundary until it does.

### A28 · P2 · CLOSED 08-10 · A missing migration would have lost the whole registration
Writing `device_role` in the same statement as the rest coupled every terminal
registration — and all fleet telemetry — to migration 73 being applied. If it
were not, the INSERT would fail entirely and no row would be created; the
telemetry UPDATE would fail and take `last_sync_at` and `schema_version` with it.

**Not hypothetical here.** Only **20 of 66** migrations record themselves in
`schema_migrations`, and 68 and 72 are absent from the repo entirely. A migration
being missing is the normal state in this project, not an edge case.

Now: the registry detects `42703` / `PGRST204` and retries without the role
columns, so the terminal registers regardless; and sync writes the role as a
**separate** statement, so telemetry is unaffected either way. Both paths log
which migration is missing, and say plainly what still worked.

**A4 — measurement note, 08-10** (the migration ledger covers less than a third). Belongs to the A4 entry later in this file, which is the authoritative one.
Concrete figure for the "under-reports" claim: **only 20 of 66 migration files
contain an `INSERT INTO public.schema_migrations`**, so 46 are invisible to the
ledger. **Re-measured 08-10: 22 of 68** — the ratio is unchanged, so the finding
stands; the figures are refreshed so a future reader does not conclude the file
was never re-checked. The version format is also split — 17 named (`'52_device_branch_binding'`)
against 1 bare (`'71'`) — so the table cannot be queried reliably by number
either. `60_menu_composition` and `61_adjust_product_stock` are recent examples
that record nothing.

Consequence unchanged and now quantified: **the ledger cannot be trusted to
decide what to run.** Still open.

### A25 · P1 · CLOSED 08-10 · The server can now verify a claimed role
Migration 73 let a terminal SAY what it is. **Migration 74** decides whether to
believe it — the difference between a diagnostic and a security control.

Same shape as migration 52, on purpose: trust on first use per branch, then
closed, with a manager-granted window for legitimate change. A second trust
mechanism would be a second thing to learn and a second thing to get wrong.

**One deliberate difference: this fails CLOSED where 52 fails open.**
`checkDeviceBranch` waves an unbound device through, because refusing would stop
a shop trading over a diagnostic. Here an unconfirmed device is refused
credentials, because the cost of a wrong answer is the branch's PIN hashes
rather than a misattributed sale. Refusing costs a machine offline
authentication until somebody confirms it; granting wrongly cannot be undone.

- `lib/deviceRole.ts` — `confirmServingRole()` (TOFU + conflict recording +
  handover) and `isConfirmedBranchServer()`, the read-only gate PHASE5 §4b must
  call. The gate never confirms as a side effect: a read that quietly grants is
  how a check stops being one.
- The branch is read from the device's **own server-side row**, never from the
  request. A caller-supplied branch would be a second claim propping up the
  first, which is what this exists to stop.
- `POST /api/devices/:id/authorise-handover` — one hour, matching
  `REBIND_WINDOW_MINUTES`. Granted on the OUTGOING device, because that is the
  machine an operator can identify and a replacement may have no row yet.
- Unique index `user_devices_one_server_per_branch` is the guarantee, not the
  intention. Handover clears the incumbent FIRST, so an interruption leaves the
  branch with NO confirmed server rather than two.

**Nothing here affects selling.** A refused machine still trades, still syncs,
still serves its own tills over the LAN with the branch secret. The only thing
withheld is the branch roster.

**Partly closes A22** (split brain): two machines claiming to serve one branch is
now detected and recorded — `role_conflict_at`, `role_conflict_with` — rather
than being silent. The node still does not warn on startup, so A22 stays open.

23 tests in `tests/device-role-confirmation.test.mjs`, mutation-checked.

### A29 · P1 · CLOSED 08-10 · `build-schema-index.mjs --merge-migrations` adds phantom columns
Found because migrations 73/74 tripped `schema-audit`, correctly: the new
columns were not in `scripts/schema-index.json`. The sanctioned unstick path is
`--merge-migrations`, and it **added six columns that do not exist in the live
database**, verified against the owner's 08-09 dump:

```
category_stations.business_id        parking_sessions.billed_amount
fuel_tanks.product_id                parking_sessions.cashier_id
fuel_tanks.tank_name                 parking_sessions.notes
```

Each was created by an early migration and renamed by a later one — `fuel_tanks`
has `fuel_product_id` and `name`, not `product_id` and `tank_name`. The tool
documents *"never removes"* as a safety property, and for removals it is; but it
also cannot know a column was renamed, so it resurrects dead names.

**That WEAKENS the gate.** Code selecting `fuel_tanks.product_id` would now pass
the audit and fail at runtime — the precise failure the index exists to catch,
reintroduced by the tool meant to maintain it.

The six were removed by hand against the live dump; only the eight columns from
73/74 remain. Verified semantically, not by diff: 98 tables before and after,
nothing lost, `total: 0`.

**Fix not yet applied to the tool.** It should either skip columns dropped or
renamed by a later migration, or print them as *unverified additions* for a human
to confirm. Until then, **`--merge-migrations` output must be diffed against the
live schema before it is committed**, and `--from-db` re-run when the database is
reachable. Consider this a standing caveat on that script.

### A30 · P1 · CLOSED 08-10 · Migration 74 failed on the owner's database — SQL nobody had run
```
ERROR: 42P16: cannot change name of view column "is_view_only" to "role_confirmed_at"
```

`CREATE OR REPLACE VIEW` may only **APPEND** columns: existing ones keep their
names, types and positions. Migration 74 inserted four columns before migration
73's trailing `is_view_only`, so position 16 changed name and Postgres refused.

**This reached the owner because "the DDL is unexecuted" was written down as a
caveat instead of being fixed.** Listing a risk is not managing it. Both
migrations now `DROP VIEW IF EXISTS` then `CREATE VIEW` — not `CASCADE`, so a
future dependency fails loudly rather than being quietly deleted.

**A second bug, found only by executing:** re-running 73 after 74 failed with
*"cannot drop columns from view"*, because replace cannot drop columns either.
Every migration here is written to be re-runnable — only 20 of 66 record
themselves (A4), so re-running to be sure is normal practice — and a view that
can be created once breaks that. Neither bug was findable by reading.

**Root fix — migrations now run against a real Postgres.**
`apps/server/test/migration-73-74.test.mjs` executes them under PGlite (Postgres
compiled to WASM: real parser, real planner, real DDL semantics, in-process, no
server to install), and it is **in CI**. 17 tests covering: both apply; both are
recorded; re-running both is idempotent; the CHECK accepts till/node/office and
rejects anything else while allowing NULL; the unique index refuses a second
confirmed server per branch, including an office machine; **clear-then-set is
proved to be the only order the index permits**, which is the handover sequence
`deviceRole.ts` reasons about; the view exposes both derived booleans and
excludes plain tills.

Documented consequence, tested rather than assumed: 73 owns the smaller view
definition, so running it **alone** after 74 reverts the view. Re-running 74
restores it. Run migrations in order.

**The wider lesson is the reusable part.** Any migration can now be executed in
CI before it reaches a database. The five earlier migrations in this batch's
lineage were never run either; they should be brought under the same harness.

### A31 · P1 · CLOSED 08-10 · A new desktop suite was written and never wired in
`failover-cursors.test.mjs` (A21) was added to `apps/desktop/test/` and **not
added to `npm run test:desktop`**. The owner's target run on 2026-08-10 executed
92 tests across five suites under `better-sqlite3 under Electron 35.7.5 — REAL
driver and ABI`, and the sixth was silently absent.

This is A16 repeated **in the same batch that closed A16.** A file in a test
directory is not a test; a test that nothing invokes is decoration (rule 10).

Now `test:failover` and `test:failover:electron` exist, matching how every other
suite is wired, and `test:desktop` runs the Electron variant. Also added to CI's
`desktop-scope` job, where it runs on the `node:sqlite` stand-in — which the
suite declares in its own output rather than implying a real green.

**The general lesson:** the same mistake is available every time a suite is
added. `check-ipc-parity` exists because a feature reached every layer except the
bridge; the equivalent gate here would assert that every `apps/desktop/test/*.test.mjs`
appears in a package script. Not built — recorded as the obvious next hardening.

**A9 (`npm audit`) — RESOLVED 08-10.** Retained as the original record. See the note under the other A9 entry: two unrelated findings were filed under this one ID.
**TRIAGE DONE 08-10 (late). The open half of this item is now closed, and the
answer is that almost none of it reaches a till.**

The measurement said 23 vulnerabilities / 3 critical on desktop. What it did not
say is which of them ship. Split against `apps/desktop/package.json`:

| | Verdict |
|---|---|
| **All 3 CRITICAL** — `concurrently`, `shell-quote`, `tar` | **devDependencies.** `concurrently` and `shell-quote` are the dev-server runner; `tar` arrives via `node-gyp` → `electron-rebuild`. None is in the packaged app. |
| **16 of 18 HIGH** | The `electron-builder` / `node-gyp` / `app-builder-lib` chain, plus `postcss`, `js-yaml`, `nanoid`, `brace-expansion`, `ip-address`. All devDependencies — **build machine only**. |
| **`electron` itself (HIGH)** | The advisory is *AppleScript injection in `app.moveToApplicationsFolder`* — **macOS only**. Every till is `win32`. Not reachable on any deployed machine. |
| **2 MODERATE — `uuid`, `exceljs`** | **The only PRODUCTION dependencies in the list.** `exceljs` is flagged solely via `uuid`. |

**The `uuid` finding does not apply to how we call it.** The advisory is a missing
buffer bounds check in **v3/v5/v6 when `buf` is provided**. Every call site in
this repo is `import { v4 as uuid }` — five of them, all `uuid()` with no
argument. v4, no buffer. (`schemas.ts:5` is a Zod validator that shadows the
name; unrelated.)

**So the shipped surface of 23 vulnerabilities is: none.** That is worth stating
plainly, because "3 critical" on a POS handling money reads as urgent and would
have had someone running `npm audit fix --force` on the electron-builder chain —
a MAJOR bump of the toolchain that builds the installer, the week after a build
went out with two binaries under one version (rule 22).

**Server side, real but lower:** `body-parser` (DoS via a silently-disabled size
limit), `brace-expansion`, `ip-address` (SSRF / trust-boundary bypass). All fixed
by a plain `npm audit fix` — no majors. `ip-address` matters more here than on
the till because the server takes inbound requests; worth doing, but not tonight,
and not in the same change as a mail fix going to production.

**What is NOT claimed:** that these packages are safe in general, only that the
vulnerable code paths are not on the till's shipped surface. A future dependency
could pull `uuid` v5 with a buffer, or move a dev dependency into `dependencies`,
and this triage would be stale. Re-run per workspace when the dependency set
changes rather than trusting this table.

The register carried "23 vulnerabilities, 3 critical — probably build-chain only"
as an unverified guess. Measured on both sides:

- **`apps/server`: 6 vulnerabilities, 0 critical, 3 high.** The guess was wrong
  for the server in both directions, and `nodemailer` is a **direct runtime**
  dependency, not build-chain.
- **`apps/desktop`: 23 vulnerabilities, 2 moderate, 18 high, 3 critical** —
  confirmed on the owner's machine 08-10. The 23/3 figure was the desktop
  workspace all along.

Desktop dependencies are build- and packaging-time (electron-builder and its
tree) rather than reachable from a running till, so the practical exposure is
lower than the number suggests — but that is an argument for triaging them, not
for leaving the number unexamined. Triage still open; the measurement is not.

### A32 · P1 · CLOSED 08-10 · Six migration tests existed, none ran, one had never worked
Found while fixing a Windows path bug in my own harness. **This repository has
tested migrations against PGlite since migration 41** — `scripts/test-migration-47,
-48, -50, -51, -52` and `test-migrations-41-42` — same pattern, same
`fileURLToPath`, same `--no-save` instruction.

**None of them ran in CI**, and the consequences were exactly what a test nothing
invokes always costs:

- **`test-migration-47.mjs` pointed at `/home/claude/out4/migrations/…`** — an
  absolute path from the sandbox it was written in. It has never run anywhere
  else since the day it was committed. **19 assertions, none ever executed.**
  Path fixed; 19/19 pass.
- **Migration 74 shipped a `CREATE OR REPLACE VIEW` Postgres refuses (A30)** and
  reached the owner's database. The practice to catch it existed; nothing made
  it habitual.

`scripts/run-migration-tests.mjs` now **discovers** `test-migration*.mjs` rather
than listing them — a hand-kept list is one more thing to forget, which is the
failure being fixed — runs each in its own process, and reports every failure
rather than stopping at the first. `npm run test:migrations` at the root, in CI.
**7 files, 110 assertions, all green — confirmed on the owner's Windows machine
2026-08-10.**

The runner reads both summary conventions in this directory (`N passed, N failed`
and `test-migrations-41-42`'s `PASS`/`all green`), because a blank summary is
indistinguishable from a file that asserted nothing — and after 47, "looks like
it did nothing" is not a reassuring thing for a runner to show. Exit status, not
the summary, decides pass or fail; verified by running a deliberately failing
file through it (`1 of 8 migration test file(s) failed`, exit 1).

`@electric-sql/pglite` is a root devDependency, so `npm install` provides it and
the `--no-save` step in six file headers stops being load-bearing.

**My own error, recorded because it is the same one:** I wrote a new harness at
`apps/server/test/` without checking whether the practice already existed — a
rule 17 miss in the batch that added rule 17 — and claimed migrations "now" run
against real Postgres when they had since migration 41. Moved to `scripts/` and
renamed to match.

### A33 · P2 · CLOSED 08-10 · `new URL(import.meta.url).pathname` breaks on Windows
My migration harness resolved paths with `new URL(import.meta.url).pathname`,
which yields `/C:/swiftpos/…` on Windows; `path.resolve` then prepends the drive,
producing `C:\C:\swiftpos\…` and 17 failures on the owner's machine. Correct
on Linux, the only place it had run.

Every other script in this repository already used `fileURLToPath`. Mine was the
sole deviation — the convention was right and I did not follow it.

Fixed, plus the harness now **fails immediately with the resolved path** when the
migrations directory is missing. Without that, a path bug presents as every
assertion failing for its own apparent reason — missing columns, empty views —
and the real cause is buried in the noise, which is precisely what the owner saw.

**CONFIRMED ON TARGET 08-10** — all 7 files pass on the owner's Windows machine.
This could not be proved from Linux (`fileURLToPath` is platform-dependent), and
it is the second time in one day that only the target could settle a claim.

### A34 · P1 · CLOSED 08-10 · CI #42 red — desktop suites added without the build they need
```
Run node --no-warnings test/logFile.test.mjs
dist/main not built. Run:  npx tsc -b tsconfig.main.json --force
```

`logFile`, `syncEngine-failures` and `failover-cursors` import from
`apps/desktop/dist/main`. `npm run test:desktop` builds first — which is exactly
why they pass on the target and failed on the runner. **I added the CI steps and
not the build**, and could not have found it locally, because locally the build
had already happened.

The `desktop-scope` job installed only `better-sqlite3` at the repo root, which
is all the `scripts/*.mjs` gates need. Three steps added:

- `npm ci --ignore-scripts` in **shared/printing** — it is a project reference of
  `tsconfig.main.json` and declares `"types": ["node"]`, so without its own
  `node_modules` the build fails on a missing type definition. Non-obvious, and
  it cost a cycle to find the first time.
- `npm ci --ignore-scripts` in **apps/desktop** with
  `ELECTRON_SKIP_BINARY_DOWNLOAD=1` — the Electron binary is ~100MB and nothing
  in this job launches it.
- `npx tsc -b tsconfig.main.json --force`.

**Verified against a genuinely clean checkout**, not the working tree: extracted
`git archive HEAD` to a fresh directory with no `node_modules`, ran the three
steps in order, then all three suites — 12, 29 and 12 passed. That is the closest
reproduction of a runner available here.

The other five jobs — typecheck, build, secret scan, schema drift and **server
suites, including the 7 migration files** — were green on the same run. Only this
one failed.

**The general point:** CI is the first environment in this project that starts
from nothing. Everything local benefits from state built up by hand, and A32
(six migration tests never run) and A31 (a suite never wired in) were both
invisible for the same reason. Expect more of this on the next few runs; each
one is a real gap, not noise.

### A35 · P1 · CLOSED 08-10 · The secret scan never ran on a pull request
CI #44, PR #2 (`dev → main`):

```
RequestError [HttpError]: Resource not accessible by integration
  GET .../repos/oweyahillary/swiftpos/pulls/2/commits   403
  x-accepted-github-permissions: pull_requests=read
```

`gitleaks-action` lists the PR's commits through the API on a `pull_request`
event. The workflow declared **no `permissions` block at all**, so it inherited
the repository default — `contents`, `metadata`, `packages`, all read — and the
action crashed **before scanning anything**.

**Every earlier run was a `push` event, where the API is never touched.** So this
gate had been passing for a reason that did not hold on the one event type that
gates a merge to `main`. It looked like 40-odd green runs of a working secret
scan; on the path that matters it had never been exercised.

`permissions: { contents: read, pull-requests: read }`, scoped to that job —
nothing else here calls the API, and a read-only default is worth keeping
everywhere it still works.

**Second finding, from the same failure.** The job's steps ran gitleaks FIRST and
the `.env` assertion second, so when gitleaks crashed the job stopped and **both
secret gates were skipped by one infrastructure fault.** The `.env` check needs
no action, no API and no network. It now runs first, so it cannot be taken out by
something unrelated failing.

Context for why this matters more than a red tick: A1 was a service-role key
leaked in a packaged zip on 2026-08-08, and the repo leaked an Ed25519 signing
key before that. These two steps are what stand between that and a repeat.

**The general shape, third time today:** a check that passes for the wrong
reason. `test-migration-47` had never run (A32), `failover-cursors` was never
invoked (A31), and now a secret scan that had never scanned a PR. All three
looked like coverage.

### A36 · **P0** · CLOSED 08-10 · `/desktop-login` minted `surface: 'web'` — four features silently dead
The one-word bug behind everything chased today.

`routes/auth.ts` `/desktop-login` set `surface: 'web'` in its token payload. **The
header of that same file has said `surface='desktop'` since the route was
written.** The comment and the code disagreed for months and nothing compared
them.

It propagates: `/verify-pin` issues `surface: req.surface ?? 'web'`, so the
owner token's value flows into every staff token minted from it. On every till
that signed in through that route, four things were false and therefore silent:

1. **`offlineAuth` (`auth.ts:1356`) is gated on `surface === 'desktop'`.** The
   PIN hash was never returned, so `staff_pin_cache` stayed EMPTY. **The entire
   offline sign-in feature — D16, shipped 2026-08-08 with 16 passing pinCache
   tests — has never worked in the field.** Measured on Beryl's till 2026-08-10:
   manager and cashier PINs entered ONLINE, then
   `select count(*) from staff_pin_cache` → **0**.
2. **Desktop terminal registration (D14) never ran.** `user_devices` was empty
   for all ten businesses, which kept migration 52's branch binding and every
   telemetry column inert. This is the *real* reason the fleet was empty — the
   `require_device_registration` flag was a second, independent cause.
3. **The `desktop_licensed` gate never fired** for those tills (`pos.ts:87`,
   `auth.ts:1174`). A till signing in this way traded unlicensed.
4. **`requireWebSurface` was bypassed**, so a till could reach web-portal-only
   routes.

**Why nothing caught it.** `/pos-login` derives surface from the request body and
CAN be `'desktop'` — so the fixtures, and the real `BRANCH_NOT_LICENSED` errors
seen in the field, both looked right. Two login routes, two different answers,
and the tests exercised the correct one.

**Deploy safety, checked before shipping:** the till never calls `/api/reports*`,
so activating `requireWebSurface` changes nothing; and Beryl's Main Branch has
`desktop_licensed = true` since 2026-07-25, so the licence gate will pass. **On
an unlicensed branch this fix stops the catalogue pull with a 403** — check
before deploying anywhere else.

`tests/auth-surface.test.mjs`, 10 tests, mutation-checked. It is a source-text
test on purpose: the bug was one word in a literal, and a unit test asserting
`payload.surface === 'desktop'` against a stub would only prove the stub. It also
asserts the header and the code agree, which is the specific thing that failed.

### A37 · P2 · CLOSED 08-13 · The desktop licence was bypassable by client-supplied `surface`
`/pos-login` read `surface` from the request body and gated the licence on it
(`callerSurface !== 'web' && !allowed.desktop_licensed`). A client that sent
`surface: 'web'` skipped the desktop-licence check, and `pos.ts` then also passed
because it reads the same value from the minted token. A commercial control
decided by client input.

**Fixed by making the exempting surface earned, not asserted.** Web access and the
desktop licence are separate products (`webAccess.ts`: "Offline desktop POS is NOT
affected by web-access state"). `/pos-login` now honours `surface: 'web'` only when
the business actually holds web access — `effectiveSurface = callerSurface === 'web'
&& getWebAccess(businessId).canLogin ? 'web' : 'desktop'` — the same server check
`/login` gates on. The licence gate and the token mint both key off
`effectiveSurface`, so a caller with no web entitlement that claims `web` is
treated as a desktop till and licence-checked, and the token it carries into
`pos.ts` can no longer be dodged. The legitimate web POS (a business that holds web
access) is unchanged.

**Residual, documented not hidden:** a business that holds BOTH web access and
physical tills could still claim `web` on a till. Closing that for dual-subscribers
is a business-policy call (does a web subscriber's physical till need its own
desktop licence?), not a code question — the primary bypass, a desktop-only
business dodging the per-branch licence entirely, is closed.

**Verified on the bench:** server `tsc` clean; `tests/auth-surface.test.mjs`,
11 assertions, **mutation-checked** (revert the gate to `callerSurface` and the
A37 assertion fails). What the bench cannot prove and a live check should: an
actual `/pos-login` from a no-web-access business claiming `web` receiving the 403
`BRANCH_NOT_LICENSED`, and a real web-access business still logging in.

**Also fixed here — a D11 regression this test caught.** D11 rewrote `pos.ts`'s
licence gate (`branch && !branch.desktop_licensed` → `!opBranch?.desktop_licensed`)
but `auth-surface.test.mjs` §3 pinned the old shape and had been silently failing
since; the D11 session ran its own test and the gates but not the full
`tests/*.test.mjs` suite. The assertion is updated to match the D11 shape and now
passes — a reminder that a shape-pinning test must be re-run whenever the shape it
guards is changed.

### A38 · **P1** · CLOSED 08-10 · The till sent `X-Device-Id` twice — every reader got a comma-joined value
Found in Render's logs while chasing A36, and it is the SECOND independent cause
of the empty fleet:

```
[fleet] no user_devices row for device
  24dbc289-ee7f-42b6-8fed-6e089095b719, 24dbc289-ee7f-42b6-8fed-6e
```

`syncEngine.pushAuthHeaders()` declared **both** `'x-device-id'` and
`'X-Device-Id'` in one object literal. HTTP header names are case-insensitive,
so fetch emitted the pair and the server received them joined with `", "`. The
reader then did `.slice(0, 64)` on the JOINED string, chopping the second copy
mid-uuid — which is the trailing fragment in that log line.

**Four places consumed it:**
- fleet telemetry — `WHERE device_id = ?` could never match, so this would have
  stayed broken even after registration started creating rows
- `orders.device_id`
- `shifts.device_id`
- `terminalKeyFromRequest`, which feeds migration 63's one-open-drawer-per-terminal
  unique index

**The rollout risk, and why the server fix matters more than the client one.**
An updated till sending a single value would resolve to a DIFFERENT terminal key
than the shift it opened under the joined value — looking like a new terminal and
being allowed a second open drawer against the same physical till. New
`deviceIdFromRequest()` in `lib/terminalKey.ts` takes the first comma-separated
value, so an old build and a new one resolve identically and the change is
invisible to that index. `orders.ts`, `shifts.ts` and `sync.ts` all route through
it.

Client side: one spelling in both header builders. They previously disagreed —
`'x-device-id'` in `authHeaders`, `'X-Device-Id'` in `pushAuthHeaders` — which is
how a copy-paste put both into one object.

`tests/device-id-header.test.mjs`, 10 tests, mutation-checked both halves
(removing the split → exit 1; restoring the duplicate key → exit 1). It asserts
against **the exact string Render logged**, not a value typed into the test.

**Worth stating plainly:** the empty `user_devices` table had THREE independent
causes — the `require_device_registration` opt-in (D14), `surface: 'web'` (A36),
and this. Fixing any one alone would have produced no visible change, which is
why the first two fixes appeared to do nothing.

### A39 · **P1** · CLOSED 08-10 · The design six files cite was not in the repository
`BRANCH_AUTHORITY_AND_SYNC_DESIGN.md` is cited **by section** in six source files
— `cart.ts:39`, `managerReports.ts:405`, `localDb.ts:920`, `branch-prices.ts:20`,
`pos.ts:17`, `orders.ts:176` — and was **not in the repo or its git history.**
Supplied by the owner from a different folder on 2026-08-10; now in `docs/`.

Worse than a missing file: the citations make it look present. Anyone working
from a clone reads *"See BRANCH_AUTHORITY_AND_SYNC_DESIGN.md §6"* and finds
nothing, so the reasoning behind `branch_prices`, the effective-price COALESCE
and the `updated_by` stamp is invisible.

**And it is the design for most of what this register has been rediscovering all
week.** Its status line reads *"agreed design, not yet implemented"*:

| Register finding | Already specified as |
|---|---|
| A19 — a peer's sales never reach the cloud | §1, §3 — the node is the sole uplink |
| A24 — reference data goes stale on a peer | §1 — "edits flow DOWN: Manager PC → tills" |
| PHASE5 §4 — offline sign-in | §2 — "PIN login must also be local", tills cache a verifier via safeStorage |
| PHASE6 — branch-local settings | §1 — the branch authority owns reference data |
| Two-writer resolution | §5 — newest-wins, collision-only notify, confirm/reject, audit |

`syncEngine.ts:1138-1151` records a deliberate move AWAY from §1 and §3, with a
sound engineering reason and no apparent knowledge that a design said otherwise —
which is what an untracked specification produces.

**Partially implemented already:** §6's per-branch pricing decision (
`branch_prices`, migration 20), and §5's stamping (`branch-prices.ts:97` —
`updated_by='pc'`, the edit's own timestamp so an offline edit keeps its real
time). §2's PIN caching exists as `pinCache.ts` but caches from the **cloud**
rather than from the node, and did not work at all until A36 was fixed today.

**Rule 19 covers the repo root; this is the converse** — a document that should
be in `docs/` and was nowhere.

**GATE BUILT 08-10** — `scripts/check-doc-refs.mjs`, in CI. Every `Something.md`
cited from live code or live docs must resolve to a file in the tree. It found
more than a manual grep did, and **three of the owner's own documents are still
missing**:

| Missing | Cited by |
|---|---|
| `DESKTOP_DESIGN.md` | `migrations/18_web_access_remodel.sql:4`, and **BRANCH_AUTHORITY itself at :3, :28, :157** — it is the companion that defines the `node` role and steps 5-6 of the build sequence |
| `SwiftPOS_eTIMS_Integration_Scope.md` | `etims/provider.ts:4`, citing **§2** |
| `BRANCH-SERVER-PLAN.md` | `docs/PHASE2-3-DESIGN.md:3` |

`DESKTOP_DESIGN.md` matters most: PHASE6 is to be built against BRANCH_AUTHORITY,
which opens by calling itself *"Companion to DESKTOP_DESIGN.md"* and widens the
node role *"from DESKTOP_DESIGN.md"*. **Building PHASE6 without it means building
against half a specification.**

`docs/history/` is deliberately excluded from the citation scan — a past handoff
naming a since-deleted document is an accurate record, not a broken link — but
documents living there still count as PRESENT, so a live doc pointing at an
archived handoff passes.

**UPDATED 08-10 — the gate is red on ONE document, not three.** Re-run measured
158 citations across 496 files. `DESKTOP_DESIGN.md` is now in `docs/` (A40) and
`SwiftPOS_eTIMS_Integration_Scope.md` is in `docs/history/handoffs/`, which the
scan counts as present. **Only `BRANCH-SERVER-PLAN.md` is still missing.**

That matters for sequencing: PHASE6 is recorded elsewhere in this file as blocked
on three documents. It is blocked on one.

### A40 · P1 · CLOSED 08-10 · `DESKTOP_DESIGN.md` is lost — recorded, not reconstructed
Searched the repository, its full history (`--diff-filter=D`) and the owner's
local folders. **Gone.** Eleven citations survive.

`docs/DESKTOP_DESIGN.md` now states plainly that the original is lost and maps
each surviving citation to the code that implements it. **Nothing is invented** —
a plausible reconstruction would be worse than an honest gap, because the next
reader could not tell which parts were real.

What the citations preserve, and where it lives:

| Cited | Now |
|---|---|
| "the two-products model" (`migration 18:4`) | `branches.desktop_licensed` + `businesses.web_access_expires_at`; `lib/webAccess.ts` carries the whole renewal ladder |
| "the `node` role" (BRANCH_AUTHORITY:28) | `deviceConfig.ts:26` — and wider now, `'till' \| 'node' \| 'office'` |
| "steps 5-6 of the build sequence" (BRANCH_AUTHORITY:157) | **Diverged.** `syncEngine.ts:1138-1151` moved away from the sole-uplink model deliberately, with no sign of knowing a design said otherwise. Register A19, still open. |

Genuinely gone: the reasoning behind the two-products split, the full build
sequence, and whatever else it covered. **PHASE6 is unblocked** — the parts it
depends on are implemented and readable.

Still missing and worth finding: `BRANCH-SERVER-PLAN.md`,
`SwiftPOS_eTIMS_Integration_Scope.md`.

**UPDATED 2026-08-12 — `check-doc-refs` is now GREEN.** Neither document was
recovered, so following A40's precedent both are filed as honest tombstones that
reconstruct nothing: `docs/BRANCH-SERVER-PLAN.md` (records that the plan was
never committed and maps to the surviving `PHASE2-3-DESIGN.md` amendment and the
branch/node design docs) and `docs/history/handoffs/SESSION-HANDOFF-2026-08-02.md`
(records that `HANDOFF-2026-08-03.md` superseded it, per A6).
`SwiftPOS_eTIMS_Integration_Scope.md` was already present in
`docs/history/handoffs/`. The gate resolves every live citation; no original
content is claimed.

### A41 · P1 · CLOSED 08-10 · Two gates for the seam that produced everything this week
§L: *"two things that must agree, with nothing comparing them."* Every finding
this week was that shape. Two more comparators, both in CI:

**`check-header-keys.mjs`** — no object literal declares one header under two
spellings (A38). Mutation-checked.

**Its own first version silently missed the bug it was written for.** The
literal-matching regex refused nested braces, so any headers bag containing
`` `Bearer ${token}` `` was skipped — which is every one that matters. It scanned
23 literals, reported OK, and passed a mutation test by not looking. Now
interpolations are blanked (length-preserving, so line numbers stay true) and it
catches A38 at the exact file and line. **A gate that cannot fail is the thing it
was built to prevent.**

**`check-test-registration.mjs`** — every test file is invoked by a package
script, a CI step, or a discovering runner (A31, A32). Mutation-checked by
unwiring `test:failover:electron`.

**Its first version reported 22 false positives** — files a CI shell glob
(`for f in tests/*.test.mjs`) runs perfectly well. Fixed before shipping, because
a gate that cries wolf gets switched off, which is worse than no gate.

**Still no gate for the seam §L names as widest:** an IPC channel whose two sides
disagree about the *payload shape*. `check-ipc-parity` proves a channel exists,
not that its arguments agree. P-09 and P-11 both came through it. Next.

### D8 · P1 · CLOSED 08-10 · Dispatch slips could print on neither system — and the HTML sale path is gone
Thermal ran a full service on 2026-08-10 with **all ticket types produced,
dispatch slips included**, which is the condition `POSPage.tsx:451` set for
itself: *"The old path is NOT deleted. It is the fallback, and it stays until a
real service has gone through the thermal one on this hardware."*

**0.5.27 removes the HTML SALE path only.** The rule 17 sweep found the naive
"delete four modules" would have taken three things with it:

- **Shift and Z-reports.** `escposBridge` exports exactly one print function,
  `printSale`. There is no thermal shift report. `printShiftReport.ts` is
  untouched and `ShiftPanel`/`ManagerPage` still use it.
- **Printer calibration.** `buildCalibrationTicket` is how paper width is
  detected. No thermal equivalent.
- **Test prints and previews.** `PrintersTab` uses `printKOT` and
  `printDispatcher` for sample tickets and on-screen previews.

So `printKOT`, `printDispatcher` and `printReceipt` all remain. What went is the
duplicated live-sale branch in `POSPage` — 76 lines — and the early return that
was D8 itself.

**D8 is closed by reporting, not by routing around it.** `printSale` has always
returned `{ queued, skipped }` and every caller discarded `skipped`, so a station
with no printer bound was skipped in silence. It now reaches the renderer and
the cashier is told *"nothing printed for: Dispatch"*. With no fallback there is
no second system to catch it, so silence was no longer survivable.

**`escpos_enabled` now defaults ON** (`localDb.ts`). It defaulted OFF while HTML
was the fallback — correct then, dangerous now: OFF no longer means "print the
old way", it means print nothing. A guarded one-time backfill in
`maintenance_state` flips tills that hold 0, and **does not override a manager
who later turns it off deliberately** — verified against a real SQLite database,
not reasoned about.

**The `localStorage` exclusion list is retired.** The Printers tab previewed and
test-printed from a per-till localStorage copy while the printer used the
server-synced list — two lists on one screen, silently disagreeing. New
`escpos:kitchenExclusions` IPC exposes what the printer actually applies; the box
is now **read-only and shows the live value**, and says where it is edited. A
control that looks editable and changes nothing is worse than no control.

**Not done, and deliberately:** a thermal shift report. That is new code, not
removal, and deleting the HTML one would have left the manager screen with
nothing. Its own release.

### A42 · P1 · CLOSED 08-10 · The thermal toggle's OFF label reassured while nothing printed
`PrinterSetupScreen.tsx:169` read *"Off. Sales still print the old way; nothing
on this screen affects them yet."* True while the HTML fallback existed. **From
0.5.27 it is false: OFF means nothing prints at all** — no kitchen ticket, no
dispatch slip, no receipt.

Now *"OFF — nothing will print. Turn this on before trading."* in amber. Found
because the owner unticked it on a live till and the screen said everything was
fine.

The 0.5.27 backfill is confirmed working on real hardware: marker row
`escpos_default_on_0527 = applied` at 12:49:43, column set to 1, and it correctly
did **not** override the owner's later deliberate untick — the property verified
against SQLite before shipping.

### A43 · P1 · CLOSED 08-12 · Exclusions were built on a screen that is not rendered
**Closed 08-12.** The read-only kitchen-exclusions box (plus the
`escpos:kitchenExclusions` read) was ported from the unrouted `PrintersTab` into
`PrinterSetupScreen`, which IS routed — `ManagerPage`'s `case 'printers'` renders
it. The root cause (orphaned on a screen nothing mounts) is therefore resolved:
the box now lives where the code path reaches it. The list is cloud-owned and
read-only on the till (synced via `syncEngine.ts:645`, read via the live IPC), so
there is no save path to break. Renderer `tsc` green. **Smoke-test on Windows to
confirm the box renders and shows the synced terms** — the residual is visual
confirmation, not wiring (unlike the original, this screen mounts).
`PrintersTab.tsx` was superseded by `screens/PrinterSetupScreen.tsx`.
`ManagerPage.tsx:1116` says so in a comment: *"PrinterSetupScreen supersedes
PrintersTab… PrintersTab.tsx remains in the tree"* until thermal is proven.

0.5.27's read-only exclusions box, the live-list preview and the
`escpos:kitchenExclusions` wiring all went into `PrintersTab`. **None of it is
reachable.** A rule 17 failure of the exact shape the rule names: the file
existed, and I never checked that it renders.

The IPC channel and the main-process half ARE live and correct — only the
renderer half is orphaned.

**Deliberately not ported across.** `PrinterSetupScreen` is station-oriented —
stations left, the selected station's settings centre — which is the natural home
for **per-station** exclusions (PHASE6 §4, `print_stations.exclude_terms`) rather
than a global card bolted onto a per-station layout. Exclusions stay on the web
dashboard until PHASE6.

**DELETION ATTEMPTED AND REVERTED 08-10. A43 STAYS OPEN — it is not the
one-line removal this entry implied, and the reason is worth more than the
deletion.**

Thermal ran a full service on 2026-08-10, so the condition
`ManagerPage.tsx:1116` set for retention IS met. The file is genuinely
unreachable: no `import PrintersTab` anywhere in `apps/desktop/src`, only
comments. Deleted; desktop main tsc, renderer tsc and `vite build` all passed
(64 modules transformed).

**Then `scripts/test-print-resilience.mjs` went red — 51 assertions, ENOENT.**
Four of them read `PrintersTab.tsx` directly, at lines 63, 70, 81 and 178. Two
things are tangled in there and they need separating before anything is deleted:

1. **§4 protects a real field bug that has nothing to do with this file's
   reachability.** `PrinterPicker` was once declared INSIDE the component, so
   every render made a new component type, React remounted the `<select>`, and
   an open dropdown snapped shut under the status-dot probes — read on site as
   *"stuck on Microsoft Print to PDF"*. The assertions pin it to module scope.
   **`PrinterSetupScreen.tsx:270` has a `<select>` of its own and no equivalent
   assertion.** So deleting `PrintersTab` does not merely drop dead coverage; it
   drops the ONLY guard against that bug, on the screen that is now live.
2. **§5 asserts the owner edits kitchen exclusions "on the Printers tab"** —
   `PB2.includes('Kitchen exclusions')`. That assertion is already describing
   something unreachable, which is this very finding. The gate is protecting a
   fiction and has been since 0.5.27.

**Rule 20 decides it: the assertion complains, so the change moves.** Rule 12
too — "delete 479 dead lines" grew into "rewrite a print-resilience suite
covering a live field bug", which means the diagnosis was wrong, not that the
fix is bigger. Reverted rather than loosened.

**The right sequence, and it is a decision, not a chore:**

1. ~~Port §4's picker assertions to `PrinterSetupScreen.tsx`~~ **DONE 08-10.**
   `test-print-resilience.mjs` §4b, four assertions on the live screen, in the
   general form of the bug rather than a copy: no component declared INSIDE
   `PrinterSetupScreen` (the identity churn that remounts an open `<select>`);
   options keyed by `p.name` not index; a target still settable with no printer
   plugged in; and the free-text input not hidden behind `localPrinters.length`,
   or a machine reporting no printers could set no target at all.
   Mutation-checked twice — nest a component inside the export, and key by index;
   each fires its own assertion. **The screen currently uses inline JSX and so
   cannot have the original bug, but it is one refactor away, and the refactor is
   the obvious thing to do as the file grows.**
2. Resolve §5 — either exclusions move somewhere reachable (PHASE6 §8c makes them
   per-station), or the assertion is dropped as describing a screen that is gone.
3. Only then delete the file.

**Also note what the deletion orphans:** `components/StationsPanel.tsx` (294
lines — define print stations, route categories) is imported ONLY by
`PrintersTab:22`. It is the nearest existing desktop implementation of what
PHASE6 §8c wants at the branch, so it should not be swept up with the parent.

Checked and NOT orphaned — all still have live callers, so D8's retention
reasoning holds: `printReceipt` (8, incl. `POSPage`), `printKOT`
(`usePrinterSettings`), `printDispatcher` (`printKOT`), `buildCalibrationTicket`
and `buildThermalDocument` (`PrinterSettingsModal`, `thermal`, `printReceipt`),
`PaperWidthControl` (`PrinterSettingsModal`).

### A44 · P2 · CLOSED 08-10 · Adding a station — already built, and it anticipated this
Owner asked for a "Barista" station. `dashboard/pages/settings/StationsPage.tsx`
has create, edit, delete and category routing; `routes/stations.ts` has
POST/PATCH/DELETE behind `products.manage`. The page's header comment reads *"A
client wanting a 'Barista' station tomorrow meant a code change"* and the New
station placeholder is literally **"Barista"**.

`kind` is constrained to `kitchen | dispatch | receipt` (migration 44). A Barista
station is a new station NAMED Barista with kind `kitchen` — kind decides
behaviour and ticket layout, the name is what staff call it. It reaches the till
on the next catalogue sync, where a printer is bound to it.

**Nothing to build for the DASHBOARD.** But the desktop cannot create stations,
and that matters: a branch at `locked` cannot open the portal, so it could not
add a station at all — a shop building a coffee counter would have to renew a
*web* subscription to tell its own till about it.

**Folded into PHASE6 §8c** (owner, 08-10): station create/edit becomes
manager-editable at the branch under `products.manage`, no internet required,
**not** behind the tech screen — tech access needs a reveal code and a signed
token from the same portal that is locked, which would route around a closed door
with a key kept behind it.

Backed up and visible to head office, per the owner: node authoritative, cloud
the durable copy, dashboard reads it, *"so the owner can tell what is happening on
the ground."* `print_stations` already syncs DOWNWARD to the till; the missing
half is the write path and the upward sync — the same `/node/settings` channel
per-station exclusions need, so building them apart would mean building that sync
twice.

**A45 — the original finding, as written on 08-10.** Retained verbatim. Its closure is recorded in the A45 entry earlier in this file (cloud side closed 2026-08-11, one role grant away from fixed).
Observed on a live till 2026-08-10: a manager opens Receipt, edits the branch
address and phone, presses Save, and gets **"Your role does not allow this
change."**

Two gates for one action, disagreeing:

- `ManagerPage.tsx:1083` — the tab is listed `...(isManagerRole ? [...] : [])`
- `business.ts:110` — the write needs `requirePermission('settings.manage')`

**§L's seam again, this time in permissions.** The UI promises what the server
refuses, and nothing compares them. The user finds out after typing.

Immediate unblock: grant the role `settings.manage` on the dashboard, or edit as
the owner. **Both are worse than they sound — see A46.**

Proper fix is PHASE6 §7, which already separates branch-operational settings from
business-identity ones. The screenshot makes the case: the header read
`Juja B Branch / 018202083` — a BRANCH address and phone, exactly the
manager-editable, branch-local content §2 argues for. The KRA PIN line is the
part that is business identity and stays owner-only.

Whatever the split, **the tab's gate must read the same key the server enforces.**
A source-text gate asserting that every permission-gated route has a UI gate
naming the same permission would catch this class — the fourth comparator, after
`check-ipc-parity`, `check-header-keys` and `check-doc-refs`.

### A46 · **P1** · PARTLY CLOSED 2026-08-11 — machinery built, 13 of 16 routes split
**Shipped:** `requireAnyPermission()` (`rbac.ts`), migration 75 registering all
twelve keys, and 13 of the 16 `settings.manage` routes re-pointed:

| File | Routes | Now accepts |
|---|---|---|
| `devices.ts` | 5 | `devices.approve` **or** `settings.manage` |
| `tables.ts` | 4 | `tables.manage` **or** `settings.manage` |
| `etims.ts` | 4 | `etims.manage` **or** `settings.manage` |

**Additive, and that is the design, not a compromise.** A role holding
`settings.manage` today keeps exactly what it has, so the split is deployable
without a coordinated permission migration and nobody is locked out mid-service.
The narrow key is what a manager is granted *instead*, going forward. This does
not shrink `settings.manage`; it provides alternatives to it. Shrinking it needs
to know who holds it in production and is a separate decision.

**THREE ROUTES DELIBERATELY NOT SPLIT, each for a different reason:**
1. **`business.ts:110` — `receipt.manage`. This is A45's actual field bug and it
   is NOT a route swap.** `POST /settings` writes any key through one handler,
   including `supervisor_pin` (bcrypt-hashed) and the ENCRYPTED_SETTING_KEYS
   M-Pesa secrets. `receipt.manage` must therefore be a PER-KEY check inside the
   handler, allowing only `receipt_header` / `receipt_footer`. Getting that
   wrong grants write access to a PIN hash or a payment secret. Different
   mechanism, security-sensitive, own batch. The key is already registered so
   that batch needs no migration.
2. **`shifts.ts:369` — `shifts.force_close`.** Its UI is
   `apps/desktop/src/renderer/pages/DayCloseTab.tsx`, so touching it triggers a
   desktop version bump (rule 15) and a green this bench cannot produce (rule 9).
3. **`flags.ts:26`** stays `settings.manage` — feature flags are business-wide
   and are exactly what the retained key is for.

**`products.manage`'s 29 routes are untouched.** `stations.manage` is registered
ready for PHASE6 §8c but nothing enforces it yet.

### A46 (original finding) · One permission gates sixteen routes with wildly different blast radii
Owner, 08-10: *"split these roles into fine small roles that would not affect
operations… rather than having one role once implemented a whole section is
affected."* Correct, and the measurement supports it.

**`settings.manage` gates 16 routes across 6 files:**

| Route | What it grants |
|---|---|
| `business/settings` | Receipt text — **and** loyalty rate, service charge, turnover alerts, every flag in `READABLE_SETTING_KEYS` |
| `devices/:id/approve` · `reject` · `delete` | Approve or **revoke a terminal** |
| `devices/:id/authorise-handover` | Hand the branch-server role to another machine (migration 74) |
| `etims/config` · `branches/:id/register` | **KRA fiscal device registration** |
| `flags/:key` | Feature flags |
| `shifts/:id/force-close` | Close a drawer with no count — the cash-variance path |
| `tables/*` | Create and delete tables |

**To let a manager type a branch phone number you must also grant eTIMS
registration and the power to revoke a till.** That is not a permissions model;
it is one switch.

`products.manage` is worse by volume — **30 routes** (re-counted 08-10; the entry said 29) — and includes station
create/delete, which PHASE6 §8c moves to the branch.

**Proposed split** (names follow the existing `noun.verb` convention):

| New key | Takes over |
|---|---|
| `receipt.manage` | `business/settings` for `receipt_header`, `receipt_footer` |
| `stations.manage` | `print_stations` create/edit/delete, per-station exclusions (PHASE6 §8c) |
| `devices.approve` | approve / reject / delete / authorise-handover |
| `etims.manage` | eTIMS config and registration — owner-only in practice |
| `tables.manage` | `tables/*` |
| `shifts.force_close` | the no-count close, audited |
| `settings.manage` | **retained** for what is left: flags and business-wide settings |

Every key is additive: a role holding `settings.manage` today keeps everything it
has, and the new keys are what a MANAGER role gets granted. `permissions` and
`role_permissions` already exist (migration 00), `permissions_version` already
forces token refresh on change, and migration 59 already backfills defaults — so
the machinery is there. This is seeding rows and re-pointing gates, not new
infrastructure.

**Not started.** It touches 45 route gates and every UI gate that mirrors them,
and it needs the A45 comparator built first or the two will drift again while
being changed. Sequence: comparator → split → re-point UI gates.

### A50 · P1 · **REOPENED AND RE-FIXED 08-10** · Daily summaries never delivered — SMTP died on IPv6

> **THE FIRST FIX DID NOT WORK, and the boot check is how we know.** Production
> answered, within seconds of deploy:
>
> ```
> [mailer] SMTP FALLBACK IS DEAD — smtp.gmail.com:587 —
>          connect ENETUNREACH 2607:f8b0:400e:c20::6c:587
> ```
>
> **`family: 4` is never read by nodemailer.** `smtp-connection/index.js:264`
> builds its DNS options as `{ port, host, allowInternalNetworkInterfaces,
> timeout }` — `family` is not among them. Resolution goes through
> `dns.lookup(host, { all: true })`, filters with `isFamilySupported()` — which
> asks whether the machine **has** an IPv6 interface, not whether it has a
> working **route** — and `formatDNSValue()` then picks **a random address from
> what survives**.
>
> Render's container has an IPv6 interface and no usable route, so IPv6 counted
> as supported and was chosen roughly half the time. **That also explains the
> mixed `ENETUNREACH` and `Connection timeout` lines in one run** — different
> random picks, one failing instantly and one hitting `connectionTimeout`. One
> fault, not two. Because the pick is random rather than ordered,
> `dns.setDefaultResultOrder('ipv4first')` would not have fixed it either.
>
> **The real fix:** resolve A records ourselves (`dns.resolve4`) and connect to
> the literal, with `tls.servername` set to the hostname so certificate
> validation still matches — without that, TLS would be checked against
> `74.125.126.108` and every send would fail verification instead of routing,
> trading one silent failure for another. Re-resolved on a 10-minute TTL because
> Google rotates these; a DNS blip keeps the last good address rather than
> falling back to the hostname, since the hostname is the failure mode.
>
> **WHY THE TEST DID NOT CATCH IT, which is the more important lesson.** It
> asserted that nodemailer **stored** `options.family = 4`. It does store it. It
> never reads it. **Storage is not effect** — and the mutation check was blind
> here, because removing an ineffective option leaves behaviour identical, so
> both versions were equally broken and the gate saw no difference.
>
> **And this sandbox cannot reproduce the bug at all.** It has no non-internal
> IPv6 interface, so `isFamilySupported(6)` returns false and IPv6 is filtered
> out before the random pick. Every local check passed because the failure is
> environmental — rule 9, sharper than usual: not merely a weaker environment, an
> environment in which the defect is **structurally impossible**. The only thing
> that could have caught this before deploy was the boot check, and it did, four
> seconds after the service went live.
>
> Re-fixed with three mutation checks that now bite: revert to the hostname,
> drop `tls.servername`, reintroduce `family`. **Still unproven in production
> until the next deploy prints `SMTP fallback reachable`.**

**A50 — the FIRST close, 08-10.** Superseded by the REOPENED entry above, and then by A54: the IPv4 pin worked and a second, independent cause (a filtered port) survived it. Retained because the reasoning in this text is what A54 falsifies.
Found by reading Beryl's server log, not by anyone reporting it. **Nine
businesses, every scheduled run, both observed days, zero delivered.**

```
[dailySummary] Failed for Beryl: connect ENETUNREACH 2607:f8b0:400e:c02::6c:587
[dailySummary] Failed for MAZURI Petrol Station: Connection timeout
```

`2607:f8b0::/32` is Google over IPv6, port 587 — the SMTP fallback. Render's
container has no usable route there, so nodemailer resolved AAAA first and died
in `connect()`, before TLS, before AUTH, before any recipient was offered.
`Connection timeout` in the same run is the same fault on a different IPv6 route,
hitting `connectionTimeout` instead of failing instantly.

**Two plausible explanations were checked and ruled out against the log:**

- *Unverified Resend domain.* No — `RESEND_API_KEY` was **absent**. The boot line
  *"Not set … will fall back to SMTP"* only prints for variables missing from
  `env.ts`'s optional list, so `resend` was `null` and that branch never ran. The
  free-mail warning at `mailer.ts:44` never fired either. Resend was not in the
  picture on either day.
- *Test businesses with unreal addresses.* No — `ENETUNREACH` is a NETWORK-layer
  failure on connect, so no address was ever sent. A bad recipient produces an
  SMTP 550 after `RCPT TO`. Beryl, a real production client, failed identically,
  and all nine failed the same way on both days.

**Fixed:** `family: 4` on the transport. `family` is honoured by nodemailer at
runtime but is absent from `@types/nodemailer` 8.0.x, so supplying it made
TypeScript fall through to another `createTransport` overload and report the
misleading *"'host' does not exist"*. Widened with a named
`SmtpOptions = SMTPTransport.Options & { family?: 4 | 6 }` rather than casting the
literal to `any`, which would have silenced real mistakes in the same object.

**Also fixed: the silence.** `dailySummary.ts:61` catches per business, logs, and
moves on, so the only trace was a line at 18:00 UTC. `reportMailReadiness()` now
runs at boot — `verify()`, which connects and authenticates without sending — and
names a dead transport at startup beside the other things that are wrong. Not
awaited and it never throws, same rule as `reportSeededAdmins`: a shop must not
fail to trade because nobody verified a mail domain.

It also names the case production was actually in — **`RESEND_API_KEY` unset means
SMTP is the ONLY path**, so an SMTP failure is total, not a degraded fallback.

**This is §L in a form the register has not recorded before.** Not two things
that must agree — a feature and its own failure report, with nothing making the
failure reach anybody. Nine businesses believed they had a daily summary.

**Still outstanding, and NOT code:**
- `Mama Ari Restaurant` has `owner_id = null` and is skipped before any send is
  attempted. A data-integrity problem in the business row, both days, silent.
- Setting `RESEND_API_KEY` is still worth doing. If it is set, `NOTIFY_FROM_EMAIL`
  must be on a domain verified at resend.com/domains, or every send is rejected
  and demoted back to SMTP — the boot warning will say so.

**The test failed its own mutation check before it passed.** Commenting out
`family: 4,` and `void reportMailReadiness();` left both matching their regexes,
so all 14 assertions reported green against a codebase with the fix removed. One
assertion was worse: `/family:\s*4/` was satisfied by the phrase inside an ERROR
MESSAGE at `mailer.ts:152`. Comments and string literals are code to a regex.
**Third occurrence this session** — `check-auth-retry` read `.from('stock')` out
of the comment explaining the B6 fix, and `manage-fetch-refresh` asserted against
an empty default parameter. Rule 23 keeps being right.

### A51 · P2 · CLOSED 08-13 · The device token sawtooths: every other catalogue pull 401s by construction
Beryl's till log is **90 lines and every one of them is this**:

```
07:32:58 [sync] catalogue pull failed: HTTP 401 …
07:32:58 → recovered after: …          (3-5s later)
07:52:58  … and again, exactly 20 minutes later, all day
```

Deterministic, not intermittent:

- `syncAll()` runs every **10 minutes** (`index.ts:226`)
- the access token lives **15 minutes** (`auth.ts:51`)
- **refresh is purely reactive** — nothing decodes `exp`, nothing refreshes ahead

So after a refresh at T the pull at T+10 succeeds and the pull at T+20 **cannot**:
20 > 15. Every other pull 401s, refreshes, and resets the clock. A permanent
sawtooth.

**Which token:** the catalogue pull uses `authHeaders()` → `_accessToken`, the
DEVICE token. `pushAuthHeaders()` prefers `_staffToken`. So this sawtooth refreshes
the device token only and never touches the staff token — which is precisely why
A47 could sit undetected on a busy till: selling triggers pushes, pushes refresh
the STAFF token on 401, and `manageFetch` read the fresh one from the store for
free. On an idle till nothing pushes, the staff token dies alone, and the first
manager action eats the 401.

Three costs, and the third is the one that matters:

1. Every other catalogue pull is 3-5 seconds slower than it needs to be.
2. **~72 refresh-token rotations per day per till.** Each is a chance for two
   refreshes to race, and `validateRefreshToken` treats a reused token as stolen
   and revokes EVERY session for that user. Running that lottery 72 times a day
   for no reason.
3. **The log is no longer usable as a diagnostic.** A revoked till, a rotated
   service key, a genuine expiry — all would look identical to routine noise.
   An error that always fires is an error nobody reads.

**Fixed — `refreshDeviceTokenIfExpiring()` in `syncEngine.ts`.** `syncAll()` now
refreshes the device token when it is within `REFRESH_SKEW_SECONDS` (120s) of
expiry, before the pull, so the 10-minute tick can no longer collide with the
15-minute lifetime. Reads `exp` payload-only via `secondsUntilExpiry()` (no
signature trust — the server still verifies every request); an unreadable `exp`
returns null and falls through to the reactive 401 path, which is untouched and
remains the backstop. Scoped to the DEVICE token only — it never reads
`_staffToken` or calls `refreshStaffToken`, which was load-bearing while A47's
idle test was live.

**Verified on the bench:** `apps/desktop/test/device-token-refresh.test.mjs`,
21 assertions — the sawtooth simulation, device-only scoping, the reactive
backstop still present, and safe `exp` reading (garbage/empty/no-exp all return
null rather than throwing into the sync tick). The register entry had lagged the
code: this was implemented after the entry was written and closed here on 08-13.
**Not yet field-confirmed** — a till running a build from before this landed still
sawtooths, so a rebuilt release must reach the fleet before the log goes quiet.

### A52 · P1 · CLOSED 08-10 · The till stayed signed in on an unattended machine
Requested after A47: *"can we make the app lock after 3-5min of inactivity"*, then
clarified — *"it should only fire when there is no activity in the software, not
when someone is using it; it should work like screen lock"*.

**That clarification chose the design.** `powerMonitor.getSystemIdleTime()`
reports seconds since the last keyboard or mouse input ANYWHERE on the machine —
the signal Windows uses to blank a screen. A cashier mid-sale is touching the
machine, so idle is 0 and the timer cannot fire. **"Never lock mid-transaction"
is true by construction, not by a special case somebody must keep working.**

Renderer activity tracking would have been the obvious build and the wrong one:
it misses a cashier reading a long receipt or counting cash into the drawer, so
it locks a till somebody is standing at. Staff answer lock fatigue with trivial
or shared PINs, which on a 4-6 digit PIN over bcrypt is a net security LOSS.

**Thresholds:** manager 5 min, POS 10 min. The split is exposure, not friction —
the manager screens hold Close Day, Close Branch, Staff and Receipt, and
`settings.manage` also gates till revocation and eTIMS registration (A46). Not 3
minutes anywhere: too short to distinguish "away" from "not typing".

**It is a CURTAIN, not a reset.** `LockCurtain` renders OVER whatever is mounted.
It does not unmount `POSPage`/`ManagerPage`, does not clear the staff session,
does not touch SQLite. The cart, the part-entered payment and the open tab are
all still there behind it. **Losing a sale to the lock is unreachable rather than
merely unlikely** — there is no code path that discards anything, so there is
nothing to get wrong later.

**Unlock is the PIN pad, never the owner login** (A17). It calls the same
`auth.verifyPin` `PinPage` does, so the offline cache (`staff_pin_cache`, 14
days) and the revocation handling come for free instead of being a second
implementation that must agree with the first. **Only the locked staff member can
dismiss it** — another cashier's valid PIN would otherwise continue the first
cashier's shift under their identity, with every order still attributed to the
person who walked away.

**Suppression** holds the lock off while work is in flight and nobody is at the
screen — an M-Pesa STK push awaiting its callback, a print job spooling. A
counter, not a boolean, because those overlap and a boolean lets whichever
finishes first re-arm the lock. Tokens are held in MAIN: handing the release
closure to the renderer would let a reload mid-print strand a suppression and the
till would never lock again.

27 tests. Three mutation checks, each caught by exactly the assertion that owns
it: make the curtain clear the staff session → the cart-loss guard fires; remove
the identity check → the wrong-cashier guard fires; render the curtain INSTEAD of
the screen rather than alongside → the unmount guard fires.

### A53 · P2 · RATCHETED 2026-08-11 (was OPEN) · Twenty-one audit IDs are cited in code with no entry anywhere
This register records being opened on 2026-08-07 with sections
`A1, B1-B5, C1-C6, D1-D3, E1-E4, F, G1-G2, H1-H2, I`. The 08-08 restructure kept
**only A and D**. The code still cites the rest — `// Audit H10` in `render.yaml`,
`// audit C4` in `index.ts`, `audit B6`, `audit H14` and more.

**They are not recoverable.** The first committed version of this file
(`a80c224`) already contained only A-section headings, so those entries never
reached the repository at all. An earlier note in this register suggesting
recovery from `git show 415e044:docs/AUDIT-REGISTER.md` was wrong — that commit
is not in this history. **Reconstructing them would mean inventing findings**,
which is worse than a gap a reader can see.

`docs/AUDIT-ID-INDEX.md` now lists all 20 cited IDs with their call sites and
marks each *in register* or *cited only*, so a citation leads somewhere. It is
generated by reading the tree, not hand-maintained.

**RATCHETED 2026-08-11.** The recorded fix below was "when a cited-only line is
next touched", which is a policy nothing enforces — so the set could quietly
grow. `check-register-consistency.mjs` now counts orphan citations against
`scripts/register-orphan-baseline.json` (21 today): the set may shrink and may
never grow. Fixing some fails the run until the baseline is lowered, same as
typecheck-ratchet. The 21 remain unrecoverable and are NOT to be reconstructed.

**Fix, when a cited-only line is next touched:** resolve the reference into the
comment — say what the finding was, in place — or drop the citation. A reference
a reader cannot follow looks like documentation and is not, which is the same
reasoning that produced `check-doc-refs` for documents (A39).

### A47 · P1 · CLOSED 08-10 · **CONFIRMED IN THE FIELD** · `manageFetch` never refreshed — every manager screen reported the till signed out

> **VERIFIED ON 0.5.28, Beryl's till, 2026-08-10.** Signed in, away 30+ minutes,
> then clicked through the manager screens — **no banner**, confirmed again
> later in the same session. That is the discriminating test: an idle till with
> no sales is the one condition under which nothing refreshes the staff token,
> and it is exactly how this was reported.
>
> The till log corroborates the setup rather than the result — `19:19:45`,
> `19:39:46`, `19:59:46`, `20:19:45` show the machine awake, online and syncing
> throughout. It cannot corroborate the result itself: `manageFetch` failures
> throw to the renderer and never reach `swiftpos.log`, so the absence of errors
> there is not evidence. **The click-through is the evidence.**
>
> Same log incidentally confirms **A51** in the wild — twenty minutes apart to
> the second, on a build that does not yet carry that fix, exactly as the
> simulation in `device-token-refresh.test.mjs` predicts.

**A47 (duplicate wording) — superseded.** Same finding as the A47 entry immediately above; the two headings said the same thing twice.
**Field report, Beryl, 0.5.27, Menu screen: the banner appears after the till has
been signed in and left a while. Selling unaffected.**

Not a refresh-token failure and nothing to do with D13's crash window.

`manageFetch` (`ipcHandlers.ts:1288`) serves **35 manager-screen handlers** —
Menu, Staff, Prices, Combos, Receipt, Printers. It read the staff access token
once and threw on any non-2xx. **It had no 401 branch at all.**

The staff ACCESS token lives 15 minutes (`auth.ts:51`); its REFRESH token lives
30 days and was valid throughout. So the first manager action after fifteen idle
minutes returned 401, `humaniseError` matched `/unauthor/i` (`posApi.ts:401`), and
printed *"This till was signed out. Ask a manager to sign in again."*

The till was never signed out. The sync engine had been refreshing on its own
token the whole time — which is why sales kept working, only manager screens
broke, and the fault read as intermittent rather than as a missing branch.

**`ownerFetch`, forty lines earlier in the same file, has had the branch since it
was written.** §L again: two things that must agree with nothing comparing them —
the same shape as A38's two header spellings, one file apart instead of two.

Fixed with the `ownerFetch` pattern: on 401 refresh, re-read from the store
(refresh persists a new pair to SQLite, so the in-memory copy can lag), retry
ONCE. A second 401 is a real rejection — revoked, `ACCOUNT_INACTIVE`,
`PERMISSIONS_CHANGED` — and reaches the user. `refreshStaffToken` is already
single-flight, which is load-bearing: two concurrent refreshes present the same
rotating token, and `validateRefreshToken` (`auth.ts:210-222`) treats a reused
token as stolen and **revokes every session for that user** — the real "signed
out" this change prevents rather than causes.

15 tests, mutation-checked (remove the branch → 4 red, exit 1, naming it).

**The test failed its own first version (rule 23, third time).** Its
brace-balancer took `ownerFetch`'s `= {}` DEFAULT PARAMETER as the function body,
so every assertion about `ownerFetch` was evaluated against `"{}"` and passed by
not looking. Fixed by walking the parameter list to its matching `)` first.

**GATE BUILT — `scripts/check-auth-retry.mjs`, in CI.** Every function that both
attaches `Authorization: Bearer` and calls `fetch()` must handle 401. It asserts
only that expiry was CONSIDERED; whether the retry is correct is the test's job,
because a source scan claiming more would be pretending to knowledge it lacks.
Mutation-checked: it names the exact file, function and line.

**It found a second instance on its first run** — `refreshTechConfig`
(`techService.ts:85`). Exempted with a checkable reason, not fixed: one call site
(`ipcHandlers.ts:126`), fire-and-forget, passing a token seconds old from
`/desktop-login`. A 401 there is not expiry, and the only cost of failing is that
the tech panel cannot be unlocked offline until the next login. Machinery for a
case that cannot arise is rule 12.

### A48 · P1 · CLOSED 08-10 · The receipt closing block was lost with the HTML sale path
**Field report: `Thank you for your business!` and `TAX RECEIPT UPON REQUEST`
missing above `Powered by SwiftPOS`.**

A regression from 0.5.27's removal of the HTML sale path (D8). The footer stack is
an owner-approved arrangement dated 04 Aug 2026, recorded at
`ReceiptView.tsx:250-256`: the owner's box verbatim, a rule only when that box has
content, then a fixed closing block the box cannot edit.

**The closing block existed only in the HTML receipt.** The thermal renderer had
never carried two of its behaviours:

- the DEFAULT thank-you when the owner's box is blank. `ipcHandlers.ts:792` passes
  `receipt_footer || undefined`, so an empty field printed no thank-you AND no
  rule — the receipt ended on the payment line and then the credit.
- `TAX RECEIPT UPON REQUEST` whenever VAT applies. The string appeared nowhere in
  `shared/printing` — only in the deleted component, and in `wrapAuthored`'s
  docstring, which uses it as its worked example.

`wrapAuthored` was never at fault. P-15 fixed newline handling and it still works;
the lines were not reaching it.

Restored in `render.ts` so it renders once for every receipt path. The tax line is
gated on `vatRate > 0` — a zero-rated business printing it claims something untrue
on a document the customer keeps — and is deliberately NOT taken from
`receipt_footer`: a line with legal meaning that depends on someone remembering to
type it is a line that goes missing, and on this build a manager cannot type it
anyway (**A45**).

11 tests driving the real renderer at 80mm and 58mm. Mutation-checked twice —
remove the block → 7 red; remove ONLY the `vatRate > 0` guard → exactly 1 red.

**Records a gap in D8's sweep.** The rule 17 sweep correctly found what still USED
the HTML modules — shift reports, calibration, previews — and correctly kept them.
It did not ask what those modules EMITTED that nothing else did. Deleting a path
means auditing its output, not only its callers.

**`SAMPLE-OUTPUT.txt` is NOT regenerated by `npm test`.** This file claims it is,
in §I and in the 08-08 status block, and cites it as evidence. It is a captured
run, updated by hand via `npm run sample` — which prints a money check and writes
nothing. Corrected here; the citations elsewhere should be read with that in mind.

### A49 · P1 · CLOSED 08-13 · `stock_adjustments` is a dead table, hidden by a false gate exception
Found 08-10 by a column-level sweep for more A12-shaped bugs.

`stock_adjustments` is a real table — baseline, RLS-enabled, FKs, CHECK
constraints. It is **read in exactly one place**, `reports.ts:286`, which builds
the Adjustments section of the stock-movement report. It is **written nowhere**:
not `apps/server`, not `apps/dashboard`, not `apps/desktop`, not any migration,
not any RPC.

`reports.ts` derives `restocked` and `written_off` from it and unions them with
sold quantities. **Every one of those figures is permanently zero.** The report
shows what sold and states that nothing was ever restocked or written off.

**`check-table-usage` — the gate built for exactly this shape (B6) — was silenced
on it by an exception whose stated reason was false on both counts:**

> *"Written by the till via /api/sync/push, which resolves the table name
> dynamically."*

`/api/sync/push` writes four hardcoded tables — `business_days`, `shifts`,
`float_transactions`, `expenses`. There is no dynamic resolution anywhere in
`sync.ts`. And the till has no such local table: `stock_adjustments` appears in
neither `SYNC_DIRECTION` nor `localDb.ts`. **It had never been true.** The entry
even carried its own caveat — *"Confirm this stays true if the sync route is ever
refactored"* — which invited a re-check of a claim that was wrong at rest.

Adjustments are actually recorded in `stock_movements` (`stockEffects.ts:378`,
`orders.ts:1097`, `fueltanks.ts:194`, `branches.ts:162`).

**This is rule 20 arriving by a quieter route.** Not a loosened assertion — a
plausible-sounding exception nobody re-derived. `table-usage-exceptions.json` is
the least-tested part of the gate system: every reason in it is prose that nothing
checks. The file's header now says so.

Exception corrected 08-10 to state the finding instead of hiding it. **The fix
itself is a product decision and is NOT done:** point the report at
`stock_movements`, or drop the table and the report section.

**Fixed 08-13 — pointed the report at `stock_movements`** (owner's direction:
stock management lives on the web, so the web report should show the real
figures). `GET /api/reports/inventory` now folds `stock_movements` instead of the
dead table, scoped to the business via the `products!inner` embed with
`.eq('products.business_id', …)` — the exact pattern `inventory.ts` and
`branches.ts` already use — and per branch when scoped. `'sale'` is excluded (it
is already counted in the "sold" column, so counting it again would double-count
every sale); `'restock'` → restocked, `'write_off'` → written-off, and
`'correction'` is split by the sign of `quantity_change` (a positive correction
found stock, a negative one lost it). The fold is extracted to
`apps/server/src/lib/stockMovementSummary.ts` (pure, supabase-free) and proven
against the REAL compiled function — `tests/stock-movement-summary.test.mjs`,
6 assertions, **mutation-checked** (drop the correction sign-split and it fails).
Server `tsc` clean. The stale `readOnly` exception for `stock_adjustments` is
removed and `check-table-usage` stays green. **`stock_adjustments` is now read and
written NOWHERE — a fully dead table, a drop candidate for a future tidy migration**
(the same shape as `sync_queue`/migration 80); left in place for now since the
finding — a report showing permanent zeros — is what is fixed. What the bench
cannot prove and a live check should: the report returning real restocked/
written-off numbers against a database with actual `stock_movements` rows.

### A24 · P1 · OPEN · Reference data goes permanently stale on an offline peer

**FIRST PAYLOAD DESIGNED 08-10** — `docs/PHASE6-BRANCH-SETTINGS.md`. Printer
settings rather than the staff roster, deliberately: if downstream distribution
misbehaves, a ticket prints an item it should not (visible, harmless), where the
same failure with credentials means someone signs in who should not. Also
uncovered that `business_settings` has **no `branch_id`**, so a two-branch
business changing exclusions for one branch changes both — and that there are
**two** exclusion mechanisms, cloud-backed and per-till `localStorage`, feeding
the two print paths from different sources.
The unifying finding. `REPLICATED_TABLES` is `orders, shifts, float_transactions,
expenses, business_days, events` — **all sales-side**. Everything a till READS
still comes from the cloud: `syncEngine:476` pulls the catalogue from
`/api/pos/init` and `:581` pulls staff from `/api/staff`, both against
`_serverUrl`. `nodeClient` pulls only `/node/since`.

**The node replicates sales upward and sideways; nothing flows downward through
it.** A17 (auth), A20 (roster for failover) and this are three symptoms of that
one sentence, not three findings.

Consequence at a remote site: a price change reaches the node when *it* has
internet and never reaches the tills; a cashier hired at HQ can never sign in on
a peer; receipt text and kitchen exclusions never update. Two tills at one branch
can quietly sell the same item at different prices — the class `branch_prices`
and `local_price_edits` exist to control.

**Fix:** extend `collectDistribution` downstream to carry `users` and the
catalogue tables. That closes A17, A20 and A24 together and is an extension of an
existing mechanism rather than a new one. See `PHASE5-NODE-AUTHORITY.md` §11.

**SOURCE PASS 2026-08-24 (batch -e) — confirmed at source; unbuilt; unifying map.**
Current state, verified in `syncEngine.ts` — every till READS reference data straight
from the CLOUD (all against `_serverUrl`): catalogue + `branch_price` `/api/pos/init`
(`:602`), variants `/api/variants` (`:679`), modifiers `/api/modifiers` (`:690`),
inventory `/api/inventory` (`:703`), roster `/api/staff` (`:715`), tables `/api/tables`
(`:728`), pumps `/api/pumps` (`:750`). `nodeClient` pulls only `/node/since` (sales
distribution), `/node/report`, `/node/time` — **no reference data**, and there is no
`/node/reference` endpoint. So an offline peer never receives catalogue/price/staff/
settings changes; a price edit reaches the node when IT has internet and never reaches
the peers, and two tills at one branch can sell an item at different prices.

Correction to the filed one-liner: "extend `collectDistribution`" reads as trivial but
is not (same mismatch as A20). `collectDistribution` is origin-device/`seq`-based for
append-mostly sales; reference tables are cloud-authoritative, MUTABLE, not
device-originated, no per-device seq — they cannot ride that fan-out. They need a
distinct **node-authoritative snapshot channel**, versioned per table.

Change points (target-only):
  1. Node persists the reference snapshot it ALREADY pulls when online (it runs the
     same `/api/pos/init` etc.), keyed by table + version/updated_at.
  2. `nodeServer.ts` — new `POST /node/reference`: peer sends known versions, node
     returns only what changed.
  3. `syncEngine.ts` peer reads — when a `node_url` exists, read reference **node-first**
     (fall back to cloud only when the node is unreachable), inverting the always-cloud
     reads at `:602/:679/:690/:703/:715/:728/:750`.
  4. Fix the two sub-bugs this exposes, first or alongside: `business_settings` has **no
     `branch_id`** (editing one branch's exclusions changes both), and there are **two**
     kitchen-exclusion sources (cloud-backed + per-till `localStorage`) feeding the two
     print paths — unify them, or the snapshot distributes an ambiguous truth
     (`PHASE6-BRANCH-SETTINGS.md`).

This one channel is the unifying fix: a node-authoritative downstream snapshot closes
**A20 (roster)** and **A24 (catalogue/settings)** together and complements **A19**
(upstream forward) and **A17** (auth). "Nothing flows downward through the node"
(`nodeClient` pulls only sales) is the one sentence; this is the fix. Sequence after
A19, ideally after D3. Delivery: MANIFEST-2026-08-24-e.md.

### CORRECTION 08-09 — the register under-credits what is built
Owner's push-back, checked and upheld. Verified present and sound: bidirectional
branch replication with cursors; orders replicating COMPLETE with `_items` and
`_payments`; promotion and demotion, session-gated, audited and probe-before-save;
`emitEvent` with `EVENT_WHITELIST` as an explicit security boundary; Phase 4
central day close with instructions and acks; the staff sync pipe; `can_authorize`
and `/api/staff/authorizers`; order idempotency end to end.

**PHASE5 §§3-5 over-specified as a result** — in particular it proposed a new
`branch_staff` table when the local `users` table already exists and is already
synced. Superseded by §11.4: add columns to `users`, one flag on `shapeStaff`,
one `/node/verify-pin` route, and extend distribution. Items 6, 7 and 9 there are
a handful of lines each.

### A2 · P1 · CLOSED 08-09 · BUG-17 — mpesa `.single()`
Both sites fixed. `:224` raised PGRST116 on a refunded order (two mpesa legs —
migration 37 keeps both rows) and told the cashier "No M-Pesa payment leg found"
for an order that had one. Now reads all legs, picks the `pending` one, and
distinguishes "already completed" (409) from "nothing to collect" (404).

`:372` was worse and was not in the original finding: the callback destructured
**only `data`**, so any lookup failure produced `payment === undefined`, logged
"unknown checkout", and returned. **A payment M-Pesa had already collected was
dropped, and the log said the checkout did not exist.** Now `maybeSingle` shape
with an explicit error branch that says the payment was NOT recorded and needs
reconciling against the Daraja statement, plus a loud error if two rows ever
share a checkout id.

### A14 · P0 · CLOSED 08-09 · Owner token can carry an `auth.users` id
**This is the Beryl root cause.** `auth.ts` resolved the owner's `public.users`
row with `.eq('email', data.user.email)` — a **case-sensitive** match against a
column holding whatever was typed at signup, while Supabase Auth lowercases. On
a miss both `/login` and `/desktop-login` fall back to `data.user.id`, which is
an **`auth.users`** id, and mint a token carrying it as `userId`.

`orders.cashier_id` is `REFERENCES public.users(id)` (confirmed in the live
dump), and `orders.ts` writes `cashier_id: req.userId`. So the push fails
**23503** — which was neither 23505 nor 23514, so it fell to `throw createErr`
and became "Failed to create order (ref: …)".

It persists for a whole session because **`/refresh` reuses `cleanPayload.userId`
and never re-resolves it**, so one bad login poisons the entire 30-day refresh
chain until a fresh `/desktop-login`. That is the bounded 21:09–22:53 window.

`pos-login` already had the correct pattern from BUG-05 (escaped coarse `ilike`,
exact compare in JS). It was never applied to the two owner paths. Now shared as
`resolveOwnerUserRow()`.

**Login is deliberately NOT refused when the row is missing** — a release is in
flight and an owner who works today must still work tomorrow — but it now logs
an explicit error naming the consequence instead of failing silently.

**Still to confirm on production** (the deduction is from source, not from the
database): see §E.

### A15 · P1 · CLOSED 08-09 · Every order-create failure was one sentence
Anything that was not 23505 or 23514 became "Failed to create order (ref: …)" —
the same message for a bad foreign key, a malformed uuid and a dead database.
Extracted to `lib/orderErrors.ts` and classified: 23503 → 422
`ORDER_FK_VIOLATION`, 22P02/22007/22008 → 422 `ORDER_MALFORMED_VALUE`, 23502 →
422 `ORDER_MISSING_FIELD`. Unknown codes still rethrow, but the log now carries
the SQLSTATE — the one thing missing for three sessions.

Note `22007`: the RPC casts `created_at` with a bare
`NULLIF(...)::timestamptz`, and **only the offline path populates that field.**
Same shape as the `pump_id` bug migration 69 exists to fix.

### A16 · P0 · CLOSED 08-09 · No test in `tests/` had ever run in CI
All 18 offline suites — including `pay-claim-and-loyalty`, `tip-reconciliation`,
`atomic-order` and `stock-effects-parity`, i.e. **the money paths** — were
written one per incident, passed once on the author's machine, and were never
executed again. Nor were any of the 92 desktop tests added on 08-08.

New `server-suites` CI job runs all 18. The two Electron-free desktop suites
(`logFile`, `syncEngine-failures`) added to `desktop-scope`. The three SQLite
suites cannot run on a Linux runner by design (better-sqlite3 is built for
Electron's ABI) and stay a target-machine step; a comment in the workflow says
so, so the next person does not "fix" it.

### A3 · P1 · OPEN · BUG-21 — KDS realtime / RLS
Never re-verified. Still unknown, not known-good.

### A4 · P1 · CLOSED 2026-08-22 · Migration 68 exists only in production

> **CLOSED 2026-08-22.** The lost file was recovered and committed as
> `migrations/68_loyalty_rpc_parameter_name.sql`, filling the repo gap so a
> fresh DB provisioned from migrations gets the same `increment_loyalty_points(p_customer_id, p_points)`
> signature the live cloud DB already has. Live signature confirmed on
> 2026-08-22: `p_customer_id uuid, p_points integer` — matches migration 53, the
> committed `functions-index.json`, and what `orders.ts` sends on both `dev` and
> `main`. No prod run: the ledger row `68_loyalty_rpc_parameter_name` was inserted
> into `public.schema_migrations`, so the migrate Action treats it as applied and
> never touches the live function. The file itself is idempotent (`DROP IF EXISTS`
> + `CREATE`, `ON CONFLICT DO NOTHING`) if a fresh DB ever runs it.
Applied to the live database, never committed to any branch. Confirmed absent
from git history. The repo cannot reproduce production.
**Blocked on:** `select version, applied_at from public.schema_migrations order by version;`

**NARROWED 2026-08-14 (owner supplied a table-only schema export, `swiftdb.sql`).**
Diffed prod's 99 tables and all their columns against baseline + every committed
migration: **every prod table and column is reproduced by the repo.** The lone
prod-only table, `schema_migration_runs`, is **not** a missing migration — the
runner `scripts/migrate.mjs:96` bootstraps it (`CREATE TABLE IF NOT EXISTS` + its
own RLS). So whatever 68/72 did, it was NOT tables or columns. The export is
table-only (no functions/indexes/policies), so the remaining candidates are a
function, index, RLS policy, or data backfill — or a migration **superseded** by a
later committed one (cf. 69 "supersedes 66"). Still OPEN, but the blast radius is
now "invisible objects", not the whole schema. To close: `schema_migrations` rows
WITH `notes` for the gap versions (62/64/65/66/68/72), or a real
`pg_dump --schema-only` (which carries functions/indexes/policies).

### A5 · P1 · CLOSED 08-10 · Documentation understated the system by two phases
Both documents now carry a status header stating what is actually true, rather
than being silently wrong.

`PHASE2-3-DESIGN.md` said *"For approval before code"* a week after the code
shipped — Phase 2a in `5ef0f08` (v47), Phase 2b+2c in `fee91cc` (v49), Phase 4's
central day close in `40f53ac` (v46). It now says to read it as a record of what
was decided and built, names the code as the authority where they disagree, and
lists the drift already known from running it (A19 replica-not-relay, A24 stale
reference data, A17 no node authority) — none of which the design anticipated.

`ROADMAP.md` (dated 2026-07-10) mentions **none** of Phase 2, Phase 4, Close
Branch, `/node/since`, the office role or the ESC/POS migration, so its "now vs
later" calls are not a guide to what is next. It now says so and points at the
register. Kept rather than deleted: §1's product north star — fast food first,
petrol/minimart/parking secondary — is the standing direction and is recorded
nowhere else.

**Not the same as rewriting them.** Restating a month of decisions as a fresh
plan would be inventing intent. A document that announces its own staleness is
honest; one that looks current and is not is the failure this item was about.

`ROADMAP.md` last touched 2026-07-10; no mention of Phase 2, Phase 4, Close
Branch, `/node/since`, events or the office role — all of which pass tests.
`PHASE2-3-DESIGN.md` still reads *"For approval before code."*

### A6 · P2 · CLOSED 08-10 · The 3-Aug handoff was never filed
Recovered from `git show 0f85155:HANDOFF.md` — 383 lines, intact — and filed at
`docs/history/handoffs/HANDOFF-2026-08-03.md`. It supersedes
`SESSION-HANDOFF-2026-08-02.md` and the interim 08-03 file, and its §5 (zip
supersession) is the origin of rule 3.

Recoverable: `git show 0f85155:HANDOFF.md`. Commit `a4aee05` overwrote the path
with a different document. Nothing in `docs/` records the tech DB console or the
wipe gates.

### A7 · P2 · CLOSED 2026-08-11 · `ParkingPOS` / `PetrolPOS` are UNWIRED UPGRADES — and the README said otherwise
**Closed by correcting the document that was actively wrong.** `README.md`'s
business-type table claimed `parking -> ParkingPOS` and `petrol_station ->
PetrolPOS`. Both are imported nowhere. The live path is `CashierScreen.tsx` —
bay grid at `:1141`, pump grid at `:1182` — which is what the table now says,
with a note pointing at this entry before anyone touches either file.

A README that names a dead component is worse than one that says nothing: it is
the first thing a new session reads, and it sends them to the wrong file.

The accuracy note added at the top of README.md also records what it still does
NOT cover: the Electron till, offline mode, the branch-node architecture and
failover, eTIMS, the print server, `apps/admin`, that there are 77 migrations
rather than two, and that each app installs its own dependencies (there is no
root workspace, so the `pnpm install` instruction was wrong as well).
**Re-characterised 2026-08-10 — the previous wording ("unrouted, no ROADMAP
line") invites someone to rebuild what already exists.**

Parking and petrol already ship. `CashierScreen.tsx` (2,739 lines) serves both
inline: `isParking`/`isPetrol` at `:184-185`, the bay grid at `:1141`, the pump
grid at `:1182`.

`ParkingPOS.tsx` (890) and `PetrolPOS.tsx` (889) are FINISHED replacement
components that carry their own wiring instructions in their headers —
*"INTEGRATION IN CashierScreen.tsx — Replace the existing bay-grid block:
`{isParking && view === 'bays' && (<ParkingPOS bays={tables} … />)}`"*. The block
they name is still the live code at `:1141`.

Their sibling `MinimartPOS.tsx` carries the same style of header and **was**
wired in (`CashierScreen.tsx` imports it). Two of three were connected.

**Rule 17's defining pattern exactly** — complete at every layer except one wire,
same as ESC/POS built and left unconnected, same as `adjust_product_stock`. The
decision is whether to wire or to delete; it is not a build.

### A8 · P2 · CLOSED 2026-08-31 · `SplitBillModal` unrouted while `PATCH /:id/split` is live
**CLOSED 2026-08-31 (browser-confirmed).** The table "Split Bill" button opens the
*same* PaymentModal as Charge, pre-toggled to even/by-item — no separate dead modal.
The old `SplitBillModal.tsx` was deleted and `PATCH /:id/split` retired earlier
(batch -p; documented at `orders.ts:1979`). Agent report 2026-08-31.
Confirmed 08-10: the endpoint is at `orders.ts:1932`, scopes edits to the order's
own items via `ownSet`, and works. `SplitBillModal.tsx` (152 lines) has zero
references anywhere in `apps/dashboard/src`.

**Full unreferenced sweep of the dashboard, 08-10** — six files, 2,903 lines:
`ParkingPOS` (890), `PetrolPOS` (889), `OrderHistoryTab` (361),
`BranchSelectScreen` (353), `VariantModal` (258), `SplitBillModal` (152).

**A9 ("empty" renderer directories) — CLOSED 08-10, was never true.** Retained as the original record. NOTE: an earlier A9 heading in this file covers a DIFFERENT subject (`npm audit` findings) — two unrelated findings were filed under one ID, which is precisely why IDs must not be reused.
The finding read *"Empty `apps/desktop/src/renderer/{lib,pages,components}/`"*.
Measured: **12, 12 and 14 files.** Not empty, and no history of being so.

RE-SCOPED 2026-08-23 (rule 17 — "wire the modal" was wrong): mounting
`SplitBillModal` is NOT the fix. Two things surfaced on re-verification:
  (1) **The pay-split need is already met.** `CashierScreen` has a working
  split-by-guest flow (`showSplitBill`/`splitGuests`, lines ~1592/2128): assign
  items to guests → build a per-guest sub-cart → open `PaymentModal` → charge each.
  It never touches `SplitBillModal`.
  (2) **`SplitBillModal` + `/split` + `order_items.sub_bill` are a dead triad — no
  consumer.** `sub_bill` is WRITTEN only (by `PATCH /:id/split`) and READ NOWHERE:
  grep across server, dashboard, shared, receipts, KDS, kitchen tickets and reports
  finds no reader. So persisting a by-item split changes nothing observable.
  `SplitBillModal`'s even-split mode is a pure calculator (no persistence). This is
  A130's shape (a half-built feature whose visible half does nothing), not A145's
  (there the capability existed elsewhere and the dup was a security risk — here the
  endpoint is merely inert, guard aside).

Mounting it would add a "Save split" button that writes to a column nothing reads —
a control that silently does nothing (rule 20). Not built.

DECISION NEEDED (pick one):
  • **Retire** the dead triad — delete `SplitBillModal`, retire `PATCH /:id/split`,
    optionally drop the `sub_bill` column. Cleanest; matches A145's retire pattern.
    (Default recommendation.)
  • **Complete** it — decide what a persisted per-item split should DO (e.g. print
    separate itemised receipts per sub-bill, or group kitchen tickets), build that
    consumer, then mount the modal and reconcile with CashierScreen's guest-split.
    A real feature with a spec, not a wire.
  • **Salvage** only the even-split calculator as a quick "how much each" helper
    (no persistence) — marginal, since the guest-split already divides a check.
Priority left at P2 (inert half-feature, no security angle). Delivery of this
re-scope: MANIFEST-2026-08-23-k.md.

RETIRED 2026-08-23 (dev; OPEN pending promote + a prod 404 check): `SplitBillModal.tsx`
deleted; `PATCH /api/orders/:id/split` removed from `orders.ts` and replaced with a
tombstone. Confirmed `/split` had no caller but the deleted modal, and `sub_bill`
has no reader (left in the schema; drop via a migration if desired). Bill splitting
now lives entirely in `PaymentModal` (by method / evenly / by item — see A151).
server `tsc`/`build` green, `check-permission-parity` + `check-table-usage` green.
Closes on promote + confirming `/split` 404s in prod. Delivery: MANIFEST-2026-08-23-p.md.

**ID COLLISION, and it is the register's own rule being broken.** `A9` is used
TWICE — this entry and *"A9 · RESOLVED 08-10 — `npm audit`, split by workspace"*
above. The header of this file says *"IDs are stable and never reused."* Reusing
one is how a closed item and an open one become indistinguishable in a changelog.
This copy retains the number because renumbering would break citations; the audit
entry is the one meant by "A9" elsewhere.

### A10 · P3 · CLOSED 08-12 · `PrinterSetupScreen` docstring claims a supersession that has only PARTLY happened
**Closed 08-12.** Docstring corrected to reality: it supersedes only `PrintersTab`
(now unrouted); it does NOT replace `PrinterSettingsModal` or `PaperWidthControl`,
both still live on the POS screen (`POSPage.tsx:21` imports the modal, which
renders the control at `:249`) — re-verified 08-12. Renderer `tsc` green.
**Confirmed still open 08-10, after first being wrongly dismissed.** The docstring
(`PrinterSetupScreen.tsx:4`) claims it *"Replaces PrinterSettingsModal,
PaperWidthControl, PrintersTab and PrintersPage."* Checked one by one:

| Claimed replaced | Reality |
|---|---|
| `PrintersTab` | **True** — unrouted. Deletion attempted 08-10 and reverted; see A43 |
| `PrinterSettingsModal` | **FALSE — still live.** Imported at `POSPage.tsx:21` and rendered at `:1351` behind `showPrinters` |
| `PaperWidthControl` | **FALSE** — still imported by `PrinterSettingsModal.tsx:6`. `PrinterSetupScreen` imports only React and `posApi` |
| `PrintersPage` | dashboard, out of this tree |

So one of four. A docstring that overstates what it replaced is how the next
reader deletes something still on the sell path.

### A11 · P3 · CLOSED 08-12 · `ManagerPage.tsx` comment contradicts itself
Confirmed present 08-10. The comment on the `printers` nav case said `PrintersTab`
*"stays reachable"* AND *"remains … unrouted"* — an unrouted tab is not reachable;
both cannot hold. **Closed 08-12:** rewritten to state plainly that `PrintersTab`
is unrouted and the Printers tab renders `PrinterSetupScreen`. (Line ref drifted
from the original 1061-65 after the A59 edits; the comment is now at the `case
'printers'` render.) Renderer `tsc` green.

### A12 · **P1** · OPEN · `ingredients.current_stock` has had no writer since migration 23
**Raised from P3/INVESTIGATE to P1 on 08-10 — it is no longer a question. It is
B6's sequel, exactly as this entry predicted, and it is live.**

Migration 23 moved ingredient stock to `ingredient_stock_levels`, backfilled once,
and says so in its own header: *"It does NOT drop `ingredients.current_stock` yet
(that's Phase 6…)"*. Phase 6 never came. Since then:

- **Nothing writes `ingredients.current_stock`.** `adjust_ingredient_stock`
  (migration 23) writes `ingredient_stock_levels`. `stock.ts:58` touches
  `ingredients` only for `unit_cost`. `stock.ts:190` creates catalogue rows with
  no stock at all, and says so.
- **`recipes.ts` reads it in three places** — `:28`, `:44`, `:110` — and serves it.
- **`RecipeDrawer.tsx:308-309` renders it**, red when `<= 0`.

So the Recipes drawer shows a snapshot frozen at whenever migration 23 ran, and
every ingredient created since reads **"0 in stock" in red**, while
`IngredientsPage` — which goes through `stock.ts:162` and flattens
`ingredient_stock_levels` — shows the true figure. Two screens, two numbers, one
ingredient, and the wrong one is styled as an alarm.

**Why no gate caught it.** `check-table-usage` compares TABLES. Both tables are
legitimately read and written, so it is satisfied. B6 was a dead table; this is a
dead COLUMN inside a live one. A column-level read/write comparator is the gap.

**Fix needs a decision and is NOT a one-line repoint:** `recipes` is
business-level and `ingredient_stock_levels` is per-branch, so pointing
`recipes.ts` at it requires choosing a branch (the caller's? summed? per-branch
rows returned?). Not started for that reason.

**FIX APPLIED 2026-08-14.** The decision was already made elsewhere: `stock.ts`'s
`GET /ingredients` flattens per-branch stock with `branchScope(req)` — scoped
branch → that branch, owner/no-branch → business-wide sum. `recipes.ts` now
mirrors it exactly (shared `branchScope`, same flatten), so the three reads join
`ingredient_stock_levels` instead of the dead column and the Recipes drawer and
the Ingredients page finally agree. Server `tsc` clean; the dead-column read is
gone. **OPEN pending live verification** (rule 16): on a real DB, an ingredient
with branch stock shows the true figure in the Recipes drawer (not "0 in red"),
and matches `IngredientsPage` for the same branch. **Follow-up, not done:** the
"dead column inside a live table" class still has no gate — a column-level
read/write comparator is the missing check (`check-table-usage` is table-level).

### A13 · P3 · NOTE · Two suites run on `node:sqlite`, not the app's driver
`test-node-ingest`, `test-sync-rejection-routing`. They say so themselves. A
local green is not hardware-equivalent.

**Pattern worth copying (08-08):** `test/heldOrders.test.mjs` selects
`better-sqlite3` when it resolves and falls back to `node:sqlite` only where the
native module cannot be built — then prints which driver ran. On any machine
that can run the app the real driver is used, so the green *is* hardware-
equivalent, and where it is not the output says so instead of implying otherwise.
**Confirmed on the target machine 08-08:** plain `node` cannot load the app's
`better-sqlite3` at all — `ERR_DLOPEN_FAILED`, built for `NODE_MODULE_VERSION`
133 (Electron 35) against the 115 that Node 20 requires. That is not a broken
checkout; `postinstall` runs `electron-builder install-app-deps`, which is
supposed to build for Electron's ABI. And `node:sqlite` needs Node >= 22.5 while
the tills run Node 20, so a suite that hard-imports it cannot run where it
matters either. **The only runtime that tests the real driver is Electron
itself:** `npm run test:held:electron` (see `test/run-under-electron.mjs`).
Verified green there: 21/21 on better-sqlite3 under Electron 35.7.5, Windows.

---

### A68 · P3 · CLOSED 2026-08-22 · Deploy environment is not visually distinguishable (dashboard + admin)

> **CLOSED 2026-08-22 (code↔register audit, bench/static).** `apps/dashboard/src/lib/appFlavor.ts` and `apps/admin/src/lib/appFlavor.ts` build an env-driven favicon + title from `VITE_APP_ENV`, and both are called via `applyAppFlavor()` in each app's `main.tsx` before render. Fully deterministic wiring — no runtime behaviour left to confirm. The remaining action is an owner one (set `VITE_APP_ENV=dev` on the dev Vercel projects), not code.

`main` (prod) and `dev` are separate cloud instances, separate Supabase
projects, separate Vercel URLs — and until now identical to the eye. Nothing in
a browser tab told you whether you were about to act on prod or dev, which is the
kind of two-things-that-must-agree gap this register exists to name — here the
two things are "which deploy am I looking at" and "what am I about to change."

Fixed **per deployment, not per branch**. A committed-per-branch favicon would
diverge on every `dev → main` merge (A39's class); instead a single env var
`VITE_APP_ENV` (set on each Vercel project) selects the badge at runtime, so the
two branches stay byte-identical in git. `apps/dashboard/src/lib/appFlavor.ts`
and `apps/admin/src/lib/appFlavor.ts` generate an SVG-data-URI favicon and set
the tab title: prod → blue `#3b82f6` "S" / `SwiftPOS`; dev → amber `#f59e0b`
"SD" / `[DEV] SwiftPOS`. Amber is already the UI's "attention" colour. Absent or
unknown env resolves to **prod**, so a missing variable never disguises dev as
prod. Called once in each app's `main.tsx` before render.

**OPEN, not closed:** the code is verified (dashboard `tsc` green on the bench),
but the badge only appears once `VITE_APP_ENV` is set on the three Vercel
projects (owner action — see MANIFEST-2026-08-14-a.md), and "looks right in the
tab" is a browser check the bench cannot make. Closes when the vars are set and
seen. Palette confirmed against the dashboard's own hex usage, not assumed.

---

### A69 · P2 · OPEN · Enrolment issuance moves to admin (billable), branch-bound; owner self-provisioning retired

> **2026-08-22 (code↔register audit).** Code-complete on dev: `AdminPortal.tsx` mints single-use, branch-bound enrolment codes (A69 comments + prompt present). Kept OPEN — the admin issue/redeem flow needs a browser pass before close (rule 16).

D4 shipped issuance on the **owner** side (`POST /api/enrol/code`, owner-scoped).
That is a revenue leak by design: a client who can provision their own tills has
nothing to be charged for. Owner's call — **provisioning is a billable act and
belongs behind the SwiftPOS admin gate.** So issuance moves; the redeem path
(`/api/auth/enrol/redeem`) is untouched.

Built and bench-verified:
- **New admin endpoint** `POST /api/admin/clients/:id/branches/:branchId/enrol-code`
  (`requireAdmin`). **Branch-bound** (branch from the URL, always set — the
  owner's optional-branch ambiguity is gone). **Licence-gated**: refuses with
  `BRANCH_NOT_LICENSED` unless the branch is desktop-licensed, which is also what
  the D11 init gate would enforce anyway — fail early, not at first sync. The
  code's `created_by` is the **owner's** `public.users.id` (resolved via
  `resolveOwnerUserId`, the same business_id+email match `resolveOwnerUserRow`
  uses on desktop-login), because redeem mints an owner-scoped token and
  `orders.cashier_id` REFERENCES `public.users(id)`. The **admin** is recorded in
  the audit log, not as the principal. Refuses (`NO_OWNER`) rather than mint a bad
  token if the owner can't be resolved.
- **Owner endpoint retired** to a 410 `ENROL_ISSUE_MOVED` (not a silent 404 — old
  callers are told where issuance went). No self-provisioning path remains.
- **Shared `lib/enrolCode.ts`** (makeCode/hashCode/expiry), rejection-sampled to
  drop the modulo bias the owner path had; hashes the upper-cased code. So the
  admin path and the retired path cannot drift.
- **Billing** needs nothing new: the branch-licence handler already auto-creates
  an `invoices` row when `invoice_amount` is passed, and the admin UI already
  prompts for the one-off desktop fee. Enrolment codes are provisioning, not a
  separate charge — the branch licence is the billable unit (per the owner's
  confirmed model: desktop = one-off **per branch**, unlimited tills, no trial).
- **Desktop InstallPage** now LOCKS the branch when the code carried one (it
  already pre-selected it), so a branch-bound code fixes placement — the installer
  confirms, can't reassign. Renderer `tsc` clean.
- **Admin UI**: "Enrol till" per licensed branch → shows Business ID + code once,
  copyable, with the 15-min expiry.
- `tests/enrol-endpoints.test.mjs` rewritten for the relocation (25 checks, run;
  the licence-gate guard mutation-checked after its first version was too loose —
  `/BRANCH_NOT_LICENSED/` matched a mutated `..._X`; tightened to a word boundary
  and the actual gate line, rule 23).

**OPEN, not closed (rule 16):** the HTTP flow, the admin token mint, owner
resolution against a real row, and a completed admin→till enrolment have NOT run
— the bench has no server round-trip or Electron. Closes when: an admin issues a
code for a licensed branch, a till redeems it, the branch is locked on the till,
and a second redeem of the same code is refused. The owner 410 and the licence
gate are the two new refusals to confirm live.

**Batch (2026-08-14):** the endpoint takes an optional `count` (1–20) and mints
N single-use codes in one insert, returning `codes: [...]`; the admin UI prompts
"how many tills?" and lists them. Batching is a **convenience, not a reusable
code** — each is its own single-use, branch-bound code, so a leak still enrols
exactly one till and the 1:1 `redeemed_device_id` trail is intact. A reusable
branch code was declined for that reason (owner's call): no seat cap on a
per-branch model means a reusable code's blast radius is unbounded.

---

### A70 · P3 · OPEN · Enrolled-device roster in the admin portal

> **2026-08-22 (code↔register audit).** Code-complete on dev: `AdminPortal.tsx` holds the roster state and fetches `GET /clients/:id/devices`. Kept OPEN — the roster render/reachability needs a browser pass before close (rule 16, nothing closed on bench alone).

Provisioning is now visible from the admin side (`GET /api/admin/clients/:id/
devices`, `requireAdmin`): the `user_devices` rows for a business, each with its
label, claimed role (till/node/office), bound branch (names resolved in one
round-trip, no N+1), status, last-seen, and app version. Rendered as an "Enrolled
Devices" card under the client Overview. Read-only — `device_role`/`branch_id`
are self-reported claims confirmed server-side elsewhere (migrations 52/74); this
is a view of the fleet, not the gate. Scoped to the business, capped at 500.

**OPEN (rule 16):** the query and shape are bench-verified (server `tsc`, source
guards), but the card populated from real rows — a till that enrolled, reported
its role, bound its branch, and phoned its version — is a live check. Closes when
an enrolled till shows in the roster with the right branch and role.

**Build fix 2026-08-14:** the roster card was added as a second top-level element
inside `{tab === "overview" && ( … )}` without a fragment — adjacent JSX, which
`vite build` rejects ("Expected ) but found {"). It shipped because the check was a
filtered `grep` of `tsc` output, not the actual build; the real gate is
`npm run build`. Wrapped grid + roster in `<>…</>`; **`vite build` now passes
(647 modules).** Lesson logged: verify UI with the build, not a grep.

---

### A71 · P3 · CLOSED 2026-08-22 · Owner device view showed only person + generic label — enriched with branch, role, last-active, version, enrolled

> **CLOSED 2026-08-22 (code↔register audit, bench/static).** `apps/dashboard/src/pages/settings/DevicesTab.tsx` renders branch, role, absolute last-active, app version and enrolled date per device. Fields are present in source; if a browser pass shows any column empty, that is a server payload gap, not this finding.

Settings → Devices (the owner's `user_devices` view, migration 14) led with the
cashier's name and an auto-generated label ("SwiftPOS till"), and nothing else —
no branch, no absolute last-active, no version. The person leads because the
screen was built for cashier-login *approval* (per-user-per-device), not till
management, and the data for a fuller picture was in `user_devices` all along; the
`GET /api/devices` list simply never selected it.

Fixed: the list now selects `branch_id, device_role, terminal_code, created_at`
and resolves branch names in one round-trip (not embedded — `user_devices` has two
FKs to `branches` via migration 52, so PostgREST embedding is ambiguous). The
DevicesTab row gains a detail line: **branch**, role, terminal, **last active as an
absolute date+time** (not just "2h ago"), app version, and enrolled date. Additive
— the person/label/status line is unchanged. Server + dashboard `tsc` clean.

**Not built (owner's call):** *renaming* a device to something meaningful ("Front
Till") — that needs an editable `device_label` + a PATCH, which changes data.
Recorded, not shipped, pending a decision.

**OPEN (rule 16):** verified by `tsc` only; the row populated from a real device
— branch name, a real last-active timestamp, the version — is a live check.

---

### A72 · P3 · CLOSED 2026-08-22 · Devices are owner-nameable; a stale-sync badge flags a till that has gone quiet

> **CLOSED 2026-08-22 (code↔register audit, bench/static).** `DevicesTab.tsx` carries the rename control and the "not synced" stale badge in source. Deterministic UI wiring; closed on read.

Devices carried only an auto-generated label ("SwiftPOS till"). The owner can now
give one a chosen name (`PATCH /api/devices/:id/label`, tenant-guarded, ≤60 chars),
edited inline in Settings → Devices. Safe against the clobber trap: `device_label`
is written by registration **only on the first insert** — the refresh path applies
`patch`, which never touches it — so a chosen name persists across sign-ins. No
migration; the admin roster (A70) reads the same column, so a renamed device shows
its name there for free.

Bundled with it: a **"not synced" badge** on any approved device whose
`last_sync_at` is over a day old — surfacing the failure the fleet code itself
warns about (a till that signed in, then silently stopped syncing, looks healthy
by last-seen while the day's takings quietly go missing in the cloud). Only shows
for devices that have ever synced, so a browser cashier login doesn't trip it.

Server + dashboard `tsc` clean.

**OPEN (rule 16):** `tsc`-verified; the live checks — a rename that sticks after
the till signs in again, a rename refused for another business's device, and the
stale badge appearing on a genuinely quiet till — are on the target. **Not built
(deferred):** naming a device *at enrolment*, and renaming from the admin roster;
both easy follow-ons if wanted.

---

### A73 · P2 · CLOSED 2026-08-31 · Fleet-health page was built, routed, and unreachable — nav drift
**CLOSED 2026-08-31 (browser-confirmed).** Settings → Devices and printers →
Terminals opens a clean table (Terminal / App / Schema / Last sync / Last sign-in)
for all 3 tills, no error; the "not syncing" banner rendered correctly. Nav reaches
it. Agent report 2026-08-31.

`FleetPage` (the "Terminals" screen — which build each till runs and, the number
that matters, when it last synced) is fully built and routed at
`/dashboard/terminals`, but had **no way to reach it**: `DashboardLayout` holds two
Setup definitions — a static one (with the Terminals link) and a dynamically
rebuilt one that "replaces the static Settings group" to inject the business-type
link. The rebuild was copied without the Terminals item, so the rendered nav
dropped it. Two things that must agree, with nothing comparing them — the exact
class this register exists for. A complete safety view (it exists to catch a till
that signed in then silently stopped syncing while the day's takings go missing)
sat invisible.

Fix: the missing item added back to the dynamic group, matching the static one.
Dashboard `tsc` clean. **Latent risk noted, not fixed (rule 12):** the two Setup
definitions still duplicate each other and will drift again — they should be one
source, but deduping the nav is its own change, not this one.

**OPEN (rule 16):** `tsc`-verified; the live check is the "Terminals" link
appearing under Setup and opening the fleet table.

---

## D. OPEN — desktop app audit, 2026-08-08

Every item below was verified against source at `a80c224`, not against docs.

### D1 · P0 · Owner login is a dead end when they own two businesses
`auth.ts:603` — `/desktop-login` returns 409 `MULTIPLE_BUSINESSES` with *"Choose
which one to open."* `ipcHandlers.ts:83` throws `data.error` and drops `code`.
There is no picker anywhere in `apps/desktop`. The owner reads an instruction
the app gives no way to follow.
**Not firing for Beryl** — that owner has exactly one business (verified 08-08).
Closed by the D4 enrolment work, which removes owner login from the till.

### D2 · P0 · CLOSED 08-08 · Open tables lived in localStorage
See §E. Held orders now sit in SQLite, one row per tab. D9 (cross-till recall)
remains open — that needs server state, not local storage.

### D3 · P1 · OPEN · No auto-update — scaffold added, release pipeline outstanding
No `electron-updater`, no `autoUpdater`. Every release is a hand-installed `.exe`
per till; `localDb.ts` says so itself. Root cause of A1 — no release pipeline is
why `pos.zip` gets hand-built from a working folder. Also the tax on every other
fix in this list.

**Scaffold added (08-13), NOT verified.** `apps/desktop/src/main/autoUpdate.ts`
wires electron-updater correctly (dev-guarded, silent, checks on launch + every
6h, installs on next quit so a till is never interrupted), and
`docs/DESKTOP-AUTOUPDATE.md` is the runbook to finish it. It is deliberately not
wired into `index.ts` and cannot be — it will not type-check or build until
`electron-updater` is a dependency and an electron-builder `publish` target
exists, and the bench has neither Electron nor a feed. **Excluded from the main
build (08-13):** `tsconfig.main.json` excludes `src/main/autoUpdate.ts`, because
the `src/main/**/*` glob otherwise pulls it into `tsc -b tsconfig.main.json` and
its unresolved `electron-updater` import fails the desktop build (it did, in CI).
It is an orphan (imported nowhere), so excluding it changes no runtime behaviour;
finishing D3 means adding the dependency, removing this exclude, and wiring it.

**Outstanding, all owner work:** add the dep, wire the one call, choose a publish target, obtain a Windows
signing certificate, cut the first published release, run the end-to-end check,
and put the release in CI (which is what actually closes A1). Stays OPEN — a
scaffold that has never run is not a fix.

### D4 · P1 · OPEN · Owner portal credential used to provision the till — implemented, pending live verification
No device-scoped enrolment. Couples portal and till blast radius, and is the D1
dead end: the owner's credentials belong to a person, and a two-business owner
cannot say which business a till serves.
**Agreed design:** business ID identifies, a single-use enrolment code authorises.
Portal issues it; server burns it, writes the `user_devices` row and returns a
device session. Copy `routes/tech.ts` — that flow is already this shape.

**Implemented across all three layers (08-13):**
- **Schema** — `migrations/81_device_enrolment_codes.sql` (single-use, expiring,
  business-scoped; `code_hash` UNIQUE, raw shown once; RLS on). Proven against
  real Postgres: `scripts/test-migration-81.mjs`, 13 checks, mutation-checked on
  the atomic burn. `schema-index.json` updated.
- **Server** — `POST /api/enrol/code` (owner issues; `routes/enrol.ts`) and
  `POST /api/auth/enrol/redeem` (burn + mint; in `auth.ts`, on the authLimiter
  surface, reusing the local session helpers). Redeem runs the exact atomic
  burn the migration test proved and mints the same owner-scoped desktop token
  `/desktop-login` does — the code replaces the password, not the token identity.
  Server `tsc` clean; `tests/enrol-endpoints.test.mjs` (19 assertions: code
  generation + hashing, and source guards pinning the burn guard, business scope,
  desktop surface, single non-oracle 401, owner-only issue).
- **Desktop** — `auth:enrolDevice` IPC handler (a near-mirror of `auth:login`),
  preload bridge + `posApi.auth.redeemEnrolment`, and the InstallPage now takes a
  **Business ID + enrolment code** instead of an owner email/password. Renderer
  `tsc` clean; IPC parity 139/139; main `tsc` adds no new errors.

**What has NOT run, and must before this closes:** the end-to-end path — a real
`POST /enrol/code` in the portal, the till redeeming it, the token minting, and a
completed install binding a branch. None of that is bench-verifiable (no server
round-trip, no Electron). Stays OPEN until that live test passes. **Closes D1**
when it does — the InstallPage no longer asks for owner credentials, so the
two-business dead end is structurally gone. Runbook: `docs/DEVICE-ENROLMENT-D4.md`.

### D5 · P1 · CLOSED 08-08 · Owner and staff tokens stored plaintext in SQLite
See §E. Wrapped at rest via `main/tokenStore.ts`; plaintext columns retained as
a fallback and never cleared until the wrapped value has been read back in the
same write.

### D6 · P2 · CLOSED 08-10 · Local schema 46-51 undocumented
`docs/LOCAL-SCHEMA-VERSIONS.md`, reconstructed from `localDb.ts` and its history.

**The mechanism is not numbered steps** — there is no `case 46:` ladder. New
tables arrive via `CREATE TABLE IF NOT EXISTS` and columns via `migrateColumns`,
which reads `PRAGMA table_info` and adds what is absent. Both additive and
idempotent, so any older till converges by running the whole file.
`LOCAL_SCHEMA_VERSION` labels the resulting SHAPE; it does not drive replay.

Traced: **43** baseline · **44** `device_id` on expenses/floats, never shipped
alone · **45** replication seq/outbox/cursors (`3763946`) · **46** Phase 4 node
tables (`40f53ac`) · **47** Phase 2a distribution (`5ef0f08`) · **49** events and
maintenance_state (`fee91cc`) · **51** `escpos_enabled`, `kitchen_exclusions`
(`a80c224`).

**48 and 50 NEVER EXISTED.** No commit sets either value; the constant jumped
47 → 49 → 51. Nothing broke, because the number labels a shape — but a reader
hunting "what did 48 do?" finds nothing, and would reasonably conclude a
migration was lost. **The same shape as the server side**, where 31 and 32 are
recorded SKIPPED and 64 never existed (A4, §M). Two independent numbering
schemes, both with gaps that looked like data loss until somebody checked.

Not reconstructed, and said so in the file: what 44 and below did in detail, and
whether every field till has actually reached 51 — nothing in this repo records
the fleet's state. `X-Schema-Version` puts it on every push; ask the machines.

`localDb.ts` explains 43/44/45 in detail, then goes silent through 51. Six
generations with no record, on the mechanism deciding whether a field till works.

### D7 · P2 · OPEN · IPC channels have no per-channel payload validation — shared mechanism now added, rollout pending
`check-ipc-parity` proves a channel is bridged AND handled, not that its two
sides agree on the payload. 136 channels crossed the boundary unchecked; a
renderer sending the wrong shape surfaced as an undefined-dereference deep in a
handler, or a silent wrong write. This is the gap §L already names, and what
P-09 and P-11 were.

**Shared mechanism added (08-13), rollout under way.** `apps/desktop/src/main/ipcValidate.ts` —
a dependency-free validator (the desktop has no zod, and adding one is its own
footprint call): `validatePayload` / `assertPayload` for object payloads,
`expectStringArray` for the bare-value channels, extra fields allowed so a schema
names only what a handler depends on. **Adopted so far:** `escpos:setKitchenExclusions`
(bare array — rejects a malformed payload instead of silently coercing it to an
empty list, which would wipe the list); and the auth / money-adjacent object
payloads `auth:verifyPin`, `order:void` and `auth:enrolDevice` (throwing
`assertPayload` at the top, so a malformed payload is a clean, uniform error
instead of an undefined-dereference mid-handler, and valid payloads pass through
untouched). Tested — `tests/ipc-validate.test.mjs`, 25 assertions (validator
truth table + source guards pinning every adoption, mutation-checked). **Still
open:** the remaining ~132 channels. `order:create` is **deliberately left
unvalidated** — its payload is a deep nested object and the primary sale path must
not get a validation schema written blind; it needs a schema designed against
`createLocalOrder` and a live test before adoption. Kept OPEN: the gap it names is
the unvalidated channels, and a few of 136 is progress, not a close.

**D8 (legacy summary line) — superseded.** The authoritative D8 entry is the CLOSED one earlier in this file (dispatch slips could print on neither system).
`POSPage.tsx:455` early-returns on `canPrint('kitchen')`, but the HTML path it
skips prints kitchen **and** dispatch. `escposBridge.ts:409` filters targets to
bound stations. Kitchen bound + dispatch unbound = the dispatch slip prints on
neither system, silently. Dormant while thermal is off.

### D9 · P3 · OPEN · Held orders are not visible across tills
Tabs (open restaurant tables — food cooking, no bill yet) are **local to one
till** by design: one row per tab in that till's SQLite, out of the sync queue.
`heldOrders.ts` says so and points here — *"Cross-till recall is register D9 and
needs server state."* So a tab opened on the floor terminal cannot be charged at
the counter, which for a multi-till restaurant is a real gap.

**Designed 08-13, deliberately NOT built — `docs/HELD-ORDERS-CROSS-TILL-D9.md`.**
This is the most dangerous data in the app (losing a tab is its worst failure),
and it is not "add `held_orders` to `REPLICATED_TABLES`": that mechanism is
seq-append and origin-scoped, built for write-once records (orders, shifts), and
held orders are **mutated and deleted** — a charged tab must vanish on every other
till at once or a second cashier charges it. Two things block a blind build:

1. **A concurrency decision the owner must make** — when till 2 wants a tab open
   on till 1: hard claim/handoff, soft-view-with-charge-lock, or view-only. A
   workflow choice about how the floor runs, and it decides the whole design.
2. **Multi-till runtime** — the real risk (two tills racing a claim, a till going
   offline mid-charge, a ghost tab) is exactly what the bench cannot exercise.

Recommended shape once the decision is made: **node-authoritative** — the branch
node is the single source of truth for open tabs, recall/charge is one atomic
claim (409 on double-claim, the same conditional-update shape proven for D4's
enrolment burn), so there is no peer-to-peer race to reconcile and delete
propagates for free. The claim is benchable; the multi-till behaviour is not.
**P3, on the worst-failure path, owner-decision-gated — should NOT ride the client
rollout.** Left unbuilt on purpose: a double-charged table is worse than the gap.
### D10 · P3 · `ipcHandlers.ts` at 1,639 lines
### D11 · P1 · CLOSED 08-13 · `/api/pos/init` licensed the till from the wrong branch, and 500'd on zero main branches
`pos.ts` fetched only the `is_main` branch with `.single()` and gated the desktop
licence on **that** branch's `desktop_licensed` — regardless of which branch the
till was bound to. Two bugs in one place:

1. **Wrong branch for the licence.** A till bound to branch B was licensed by
   branch A's `desktop_licensed` flag. A licensed till at B could be locked out
   by A being unlicensed, and an unlicensed B could ride A's licence. The route
   already knew the bound branch — it fetched it a second time, lower down, for
   per-branch pricing — but the licence check never used it.
2. **Fail-closed on zero main branches.** `one_main_branch_per_business` permits
   ZERO main branches; `.single()` errors on zero rows, and that error was in the
   hard-error check, so a business with no main branch got a 500 that killed the
   whole catalogue pull.

**Fix.** The bound branch (the caller's `branch_id`, validated to the business
and carrying `desktop_licensed`) is now resolved in the same parallel fetch as
`boundBranch`; the operating branch is `boundBranch ?? mainBranch`; the licence
gate keys off that, and per-branch pricing reuses the same resolution instead of
a second lookup — so licence and pricing can no longer disagree about which
branch the till is on. The main-branch query is `maybeSingle()`, so zero main
branches is no longer an error; a desktop till with no resolvable licensed branch
now gets a clean 403 `BRANCH_NOT_LICENSED` rather than a 500. `branchId` in the
response stays the MAIN branch — the desktop uses it only as the fallback for an
unbound till (`syncEngine`: `effectiveBranchId = boundBranchId || branchId`), so
that is deliberately unchanged.

**Verified on the bench:** server `tsc` clean; `tests/pos-init-desktop-licence.test.mjs`
— 14 assertions, **mutation-checked** (reverting the gate to the main branch, or
`maybeSingle` back to `single`, fails 3). The test pairs a licence truth table
(bound-licensed-under-unlicensed-main → allowed; the mirror → blocked; web exempt;
zero branches → clean block) with source guards that pin the fix in `pos.ts`, so
the bug cannot silently return. What the bench does NOT prove and a live check
should: an actual two-branch business where one branch is unlicensed, confirming
a till at the licensed branch syncs and a till at the unlicensed one gets the 403.

**Gate note.** The old title — *"fails closed and kills the catalogue pull"* —
contained the word "closed", which `check-register-consistency` reads as a CLOSED
status. D11 was therefore counted as closed while it was open; the header's D-P1
total happened to match only because of that. The title now avoids status words.
A heading whose prose trips the status parser is a latent false-positive worth
knowing about; the parser now reads only the status field — **A67**, fixed in
this same session, not silently worked around.

### D12 · P1 · CLOSED 08-08 · Inbound sync failures were entirely silent
See §E.

### D13 · P0 · PARTLY CLOSED 08-08 · Refresh rotation
Client side done — single-flight guard and stale-token retry, see §E.
**The crash window remains open** and cannot be closed from the client: the
server revokes the consumed token before the response is even sent, so any
interruption between there and the till's `UPDATE session` strands a dead token.
Only a server-side grace period fixes it — a briefly-superseded token returning
the current pair instead of a 401. That is the outstanding part of D13.

### D13 (original finding) · Refresh rotation with a non-atomic persist and no guard
`auth.ts:50-51` — access 15m, refresh 30d, **rotating**; `auth.ts:736` revokes
the consumed token before the desktop persists the new one at
`syncEngine.ts:117`. Killed between those points — crash, power cut, dropped
response — the till holds a revoked token and can never refresh. **The owner must
sign in again.** The window opens every ~15 minutes of trading.
Second path: `refreshAccessToken()` has no single-flight guard and is called from
the sync loop, IPC handlers and the PIN screen; concurrent callers present the
same token and the loser gets a 401.
**Fix:** single-flight mutex; on 401 re-read the token from SQLite once before
giving up; server-side, a short grace window returning the current pair.

**D14 (legacy summary line) — superseded.** The authoritative D14 entry is the CLOSED one earlier in this file; this one-line version predates it and is retained only as the original wording.
`user_devices` has **no row for Beryl at all**. `sync.ts:71` is an `UPDATE`, not
an upsert, so telemetry writes nothing; `checkDeviceBranch` returns `ok:true` for
unknown devices, so migration 52's binding is inert. Consequence: no remote
visibility of `app_version` or `schema_version` — every diagnosis needs someone
physically at the machine.

### D15 · P3 · CLOSED 08-12 · Two different tables named `sync_queue`
**Closed 08-12** by migration `80_drop_dead_sync_queue.sql` —
`DROP TABLE IF EXISTS public.sync_queue CASCADE`. Re-confirmed dead 08-12 (zero
`sync_queue` references in apps/server or apps/dashboard; nothing FK-references
it). Removed from `schema-index.json` in the same change so `verify-db-schema`
does not then report it missing. Migration test `test-migration-80.mjs` (PGlite,
5 assertions: drops when present, records itself, idempotent when absent) passes;
full harness green. The live SQLite queue of the same name on the till is
untouched.
`public.sync_queue` in Postgres (`retry_count`, `table_name`) is **dead** —
no hit for `from('sync_queue')` anywhere in `apps/server` or `apps/dashboard`.
The live one is the till's SQLite table (`attempts`, `last_error`). Same name,
different columns, one of them a decoy. Drop or rename it.

---

### D17 · P3 · OPEN · Desktop build has no dev/prod flavour (icon, appId, userData, update channel)

The desktop build was one identity regardless of which cloud it targets: same
icon, same `com.swiftpos.desktop` appId, same `%APPDATA%\SwiftPOS` data folder.
A dev-testing build and a prod build could not be told apart on the taskbar, and
worse, installing one over the other shared a single local `swiftpos.db` — dev
trading writing into prod's till data.

Two layers of fix, the split that matters here: **build-time identity** and
**runtime truth.**

- **Build-time (what you asked for):** `apps/desktop/electron-builder.config.js`
  (new) replaces the static `build` block in `package.json`. `SWIFTPOS_ENV=dev`
  swaps icon (`resources/icon.dev.ico`, an amber DEV-badged variant of the
  existing mark), `productName` → "SwiftPOS Dev", `appId` →
  `com.swiftpos.desktop.dev`, and the artifact name — all from one source so the
  four cannot disagree. Distinct `productName` gives dev its own
  `%APPDATA%\SwiftPOS Dev` (Electron derives userData from productName — the
  index.ts comment already warns of this), so dev and prod coexist with isolated
  local DBs, which is the point. Default (unset) is prod. **Version stays owned
  by the build tooling — the config sets no version (rule 22).** Resolution
  proven by requiring the config under both env values (prod + dev) and printing
  the result; not asserted. Named cross-platform release scripts
  (`release:patch:dev` etc.) route through `scripts/release-flavour.mjs` — a
  ~20-line wrapper we own rather than a `cross-env` dependency + lockfile change
  (rule 22); its flavour/bump parsing and env mapping are proven by a dry-run.
  Both flavours build at ONE version via `scripts/release-both.mjs` (`release:both`
  bumps once then packs prod + dev; `pack:both` rebuilds both at the current
  version) — running the two `release:*` scripts separately bumped the version
  twice, which is the build-up this removes. `pack:dev`
  (`release-flavour.mjs dev none`) builds the dev flavour at the CURRENT version —
  no bump, no tag — for the routine dev-test loop; only real releases (both
  flavours) move the number and get tagged.

- **Runtime (the honest signal):** a build's real environment is the cloud it is
  *enrolled* against (`getServerUrl()`), not a build flag — so `index.ts` now
  titles the window from the enrolled cloud host (`SwiftPOS — {host}`),
  collapsing to plain `SwiftPOS` only for hosts in `PROD_CLOUD_HOSTS` (owner
  fills this; empty default over-shows and never hides). Held against renderer
  `document.title` via `page-title-updated`.

**OPEN, not closed (rule 9/16):** the config logic is proven on the bench, but no
installer was built here — `electron-builder` cannot run on this Linux bench
against Electron's Windows ABI, and "the `.ico` renders crisply at 16/32px in the
taskbar and Start menu" is a target check only. Closes after a real
`SWIFTPOS_ENV=dev pack:installer` on Windows shows the DEV icon and an isolated
data folder, and a prod build still installs clean. **Interacts with D3:** if the
dev flavour ever self-updates it needs its own feed keyed on the dev appId, or a
dev build could be offered a prod installer — recorded in DESKTOP-AUTOUPDATE.md.

---

### D18 · P2 · OPEN · A tech token pasted into the reveal field is truncated — "not allowing the full string"

> **2026-08-22 (code↔register audit).** Code-complete on dev: the reveal-code flow now shows the branch reveal code beside the token and supports rotate (`AdminPortal.tsx`), and the 08-14 note records an `onPaste` fix routing an `st2.` token to the token step. Kept OPEN — the paste/truncation behaviour needs a browser pass before close (rule 16).

Admin Tech Access hands out a **token** (`st2.<payload>.<sig>`, a few hundred
chars) and nothing else — no reveal code. But the desktop tech entry (`PinPage`,
long-press the logo) asks for the 8-char **reveal code** first, in an
`<input maxLength={12}>` that also upper-cases. A tech holding only the token
pastes it there; `maxLength` truncates it to `st2.XXXXXXXX` and the upper-casing
corrupts the base64 — so the full token can never be entered, and even the stub
fails the reveal check as "Incorrect code". The token's own field (a `<textarea>`,
no maxLength) is only reachable *after* the reveal gate, which the tech can't pass
without a code admin never gave them.

Fix: an `onPaste` on the reveal field detects a token (`st2.` prefix) and routes
it straight to the token step with the **full** value, bypassing the truncation
and the doorknock. Safe — the reveal code grants nothing on its own (it only
reveals the prompt), and the token is branch-scoped and cryptographically
verified. Renderer `tsc` clean. Desktop change → version bumps at the next build
(rule 15).

**OPEN (rule 16):** the live check is pasting a real admin-issued token at the
reveal prompt and reaching an unlocked tech session. **Admin complement done
(2026-08-14):** the Tech Access page now also fetches and shows the branch
**reveal code** beside the token (`GET /branches/:branchId/reveal-code`, already
built), labelled "enter this FIRST on the till", so the intended reveal→token flow
works without relying on the paste shortcut — the two ends are now self-consistent.

---

## M. Migration ledger — reconciled against production, 2026-08-08

Source: `select version, applied_at from public.schema_migrations`, cross-checked
against the live schema dump. **`schema_migrations` under-reports** — several
migrations are demonstrably applied but have no row, so the log cannot be used to
decide what to run. That is worse than a known gap and is why 46 sat unapplied.

- **31 and 32** are recorded `SKIPPED`, "number never used". Resolved, not lost.
  **64 never existed.** The earlier concern about four missing numbers is one gap.
- **68 is real and prod-only.** `p_delta` → `p_points` on the loyalty RPC, applied
  2026-08-06 21:13. `CREATE OR REPLACE` cannot rename a parameter, so it needed a
  DROP. **Extract the live definition and commit it** — see §E.
- **66 is applied in production but filed under `archive/superseded`.** It is the
  live `create_order_atomic`, superseded only by 69's hotfix. 69 is a full
  redefinition, so the repo *can* rebuild the function.
- **71 is recorded as version `71`**; the file inserts `71_adjust_fuel_tank_level`.
  Re-running it creates a duplicate row.
- **Applied but unrecorded:** 57 (`onboarding_progress.owner_pin_set` exists),
  60 (`component_slots`, `order_item_units` etc. exist), and almost certainly
  53 and 61 (functions). 55/56/58 are recorded under legacy names.
- **Genuinely unapplied until 08-08: 46.** See §E.

---

## E. CLOSED 2026-08-08

| ID | What it was | Closed by |
|---|---|---|
| 46 | `payments_method_check` admitted only cash/mpesa/card/credit while `PaymentModal.tsx:49-57` offers Glovo on every till, unconditionally. The migration file predicted the symptom verbatim: *"the order fails to sync and sits in the queue with a constraint violation nobody can read from the till."* | Applied to production 08-08. Verified: `glovo` present in the constraint. **Was not the Beryl fault** — those payloads are cash. |
| D12 | Inbound sync failures were silent. `syncEngine.ts:328` was a bare `if (!res.ok) return false` — status and body discarded — on the **one** call that matters, while tables/pumps/stations all log properly. Compounding it, the desktop had **no durable logging at all**: every `console.warn` goes to a console that does not exist on a packaged build. | New `main/logFile.ts` (rolling, bounded, never throws). Catalogue pull and both token refreshes now record status + body. `getSyncStatus()` gains `pullError`, `pullErrorSince` and `logPath`, alongside the existing `failedReason`. |
| D2 | Held orders — restaurant tabs, with pre-assigned bill number and per-line kotSent flags — were one JSON blob in renderer `localStorage`, read through a catch that returned an empty list. A truncated write reported **zero open tables**, silently, with the KOTs already on the pass. | New `held_orders` table (one row per tab, so a bad row costs one table not all of them). Five IPC channels; the renderer API keeps its shape but is now async — 9 call sites and 5 functions in `POSPage.tsx`. **No `LOCAL_SCHEMA_VERSION` bump**: `CREATE TABLE IF NOT EXISTS` runs ungated on every open. A corrupt cart now returns the tab with an empty cart and a `corrupt` flag so it can be rebuilt from the KOT, rather than disappearing. One-time idempotent import of the legacy blob, and the old key is cleared only after the main process confirms it. Not cleared by `clearCatalogue()`. |
| D13 (client half) | Refresh tokens rotate and `auth.ts:736` revokes the consumed one, but `refreshAccessToken()` had no single-flight guard across three call sites (`ownerFetch`/PIN pad, the sync loop, the order push) and `refreshStaffToken()` none across four. Two concurrent refreshes present the same token; the loser gets a 401 for a token that was valid when it read it, and the owner is signed out. Offline that is unrecoverable — there is no way to sign back in. | Single-flight promise on both paths, so overlapping callers await one request. Plus a one-shot retry when a 401 arrives and the persisted token differs from the one sent — a stale in-memory copy is bookkeeping, not a revoked session. A genuinely revoked token is **not** retried. 10 new tests; mutation-checked by removing the guard and confirming they fail. |
| D16 (offline sign-in) | Everything on a till worked offline except the DOOR: `auth:verifyPin` called the server and threw, and the local `users` table carried no hash to check against, so a line fault stopped the floor starting a shift. | New `staff_pin_cache` table + `main/pinCache.ts`. Cached **only** for staff who signed in on this terminal while online, **only** bcrypt hashes (legacy upgrades on next online sign-in), **never** `override_pin_hash` — elevated actions stay online. Wrapped with safeStorage/DPAPI; nothing cached at all if the platform cannot wrap it. Expires after 14 days without server contact; cleared on logout. Offline verification scans all cached entries and refuses on two matches, same as the server. `bcryptjs` (pure JS) not `bcrypt` — a native module would hit the same ABI wall as better-sqlite3. Server returns the hash from `/api/auth/verify-pin` for `surface === 'desktop'` only. **The fallback fires on transport failure only, never on a 401/409** — otherwise a sacked cashier signs in by unplugging the cable. 16 tests. |
| D5 | `session.token` / `refresh_token` and the staff equivalents were plaintext in `swiftpos.db`. The refresh token is the durable one — 30 days, self-renewing — so anyone with a copy of the file held working owner-scoped access long after taking it. | New `main/tokenStore.ts`: values wrapped with safeStorage (DPAPI) into `*_enc` columns, 8 read sites and 3 write sites routed through it, `migratePlaintextTokens()` at startup so an upgraded till stops holding a clear credential within seconds. **The plaintext is cleared only after the wrapped value round-trips in the same write** — the naive version of this change is itself a lockout, and offline the owner cannot sign in again to replace what it destroyed. No safeStorage means plaintext, not a broken session. 14 tests, mutation-checked by removing the round-trip verification. Honest limit, same as PHASE2-3-DESIGN §2d: defeats a copied `.db`, a stolen backup and a pulled disk; not code running as the app user. |
| A1 (packaging) | `pos.zip` hand-built from the working folder, so `.env` rode along. Written as prose in five handoffs and committed as a script zero times — which is why it recurred. | `npm run package` → `git archive --format=zip HEAD -o pos.zip`, plus `npm run package:check` which fails if `.env` or `node_modules` appear. |

### Still open from the Beryl investigation

Eight orders failed on 2026-08-07 between 21:09 and 22:53 UTC, all `attempts=5`,
all `Failed to create order (ref: …)`. Ruled out by evidence, not by reasoning:

- **Not Glovo** — both sampled payloads are `"method":"cash"`.
- **Not the shift FK** — shift `79c4881f-…` exists, open, terminal `T1`.
- **Not the payment reconciliation guard** — 600 = 600 and 6040 = 6040 exactly;
  that path is 23514 and returns a readable 400 anyway.
- **Not an order-number collision** — 23505, handled as a 409 at `orders.ts:669`.

**CORRECTED 08-09 — "something threw after the RPC committed" is ruled out.**
`syncEngine.ts:1161` sends `X-Idempotency-Key: row.order_id`, identical on every
retry, and `orders.ts:360-372` checks that key **before anything else** and
returns `200 duplicate` when a matching order exists. So had attempt #1
committed — even if something then threw post-commit — attempt #2 would have
short-circuited and the row would have cleared at `attempts=2`. All eight
reached 5. **No attempt ever committed. The money is not banked and the till was
telling the truth.**

That leaves `throw createErr` on a code that is neither 23505 nor 23514.
**A14 is the candidate: 23503 on `orders_cashier_id_fkey`,** because the desktop
owner token can carry an `auth.users` id. It fits every ruled-out item, and it
fits the bounded window, because `/refresh` never re-resolves `userId`.

Settle it with either:

```sql
-- Expect ZERO rows. Any row means the deduction above is wrong.
select id, order_number, created_at, idempotency_key from public.orders
where idempotency_key in ( <the 8 local order ids from sync_queue> );

-- The smoking gun for A14: a cashier_id equal to businesses.owner_id
-- (an auth.users id) rather than a public.users id.
select b.name, b.owner_id as auth_id, u.id as users_id, u.email
from businesses b left join users u on u.business_id = b.id
where b.name ilike '%beryl%';
select distinct cashier_id from orders where business_id = '<beryl>';
```

The server log for `error 341849fb` remains the direct answer and now would
print the SQLSTATE (A15).

---

## B. CLOSED this session — audit findings

| ID | What it was | Closed by |
|---|---|---|
| A1 (rotation) | Live secrets in the archive | Rotated. **Packaging still open — see A1 above.** |
| B1 | `/pay` had no idempotency and no concurrency guard | Claim-before-write: `.eq('status','open').select()`. Loser returns the winner's payload; amount mismatch writes a `payment_exceptions` row. |
| B2 | Loyalty diverged 10× between counter and dine-in | `/pay` now uses `awardLoyaltyPoints` + earn rate + tier. Writes the ledger row, `total_spent` and `loyalty_points_used`. |
| B3 | ESC/POS built but `queueTickets()` never called | Wired into the sale path behind a per-terminal switch. |
| B4 | Two printer config stores | Stations from `print_stations`; printer bound per terminal. |
| B5 | `pump_id` end-to-end on desktop only | Added to `PaymentModal.buildOrderPayload`. `check-client-parity` proves it. |
| B6 | Low-stock alerts read `stock`, which nothing writes | Both jobs read `stock_levels`. `check-table-usage` proves it. |
| C1 | `fetchAllIds` paged without ORDER BY | `.order(idColumn)` + a `seen` set. |
| C2 | pageSize 1000 could silently truncate | 500, below every plausible row cap. |
| C3 | Racy read-then-write stock in 3 places | `adjust_product_stock` (existed, never called) + new `adjust_fuel_tank_level`. |
| C4 | Unescaped `ilike` pattern + `limit(20)` | `%`/`_`/`\` escaped, cap raised to 200. |
| C5 | BUG-18 owner lockout | **Three** sites, not two. Extracted to `lib/ownerBusiness.ts`; 409 + picker. |
| C7 | Numeric comparisons uncoerced | Fuel reorder, low-stock, discount floor. |
| C8 | `qty_pieces` fractional into an INTEGER column | Rounded in JS. |
| C9 | `dailySummary` `.lt()` — three bugs in one line | Removed; error destructured. |
| D1 | CI job named "Schema drift" did not run the drift gate | Added, plus both new gates. |
| D2 | `assert:built` warned instead of failing | Fails, and compares against newest `src/` mtime. |
| D3 | `build:all` did not clear `dist` | Cross-platform `clean` first. |
| BUG-16 | DB blip logged a cashier out | `try` narrowed to `jwt.verify`; 503 not 401. |
| BUG-19 | Till report overstated by every refunded bill | Nets off `refunded_amount`. |
| BUG-20 | Fuel deducted twice | Tank authoritative; `stock_levels` mirrors. |
| BUG-22 | `device_hint` stored a fleet-identical User-Agent | `device_id` first. Also fixes revocation. |
| — | `release:patch` built before bumping | Reordered. |
| — | `api.ts` stripped every error field but `code`/`status` | Preserved, so 409 payloads are usable. |

---

## P. CLOSED this session — printing

| ID | What it was |
|---|---|
| P-01 | Kitchen ticket empty: bridge used literal station ids that never matched real UUIDs. Now routes by **kind**. |
| P-02 | Combos opaque: components not sent. Now sent, routed by their own `category_id`. |
| P-03 | Plain products lost their variant entirely — `if (attrs.length && units.length)` dropped it when there were no components. |
| P-04 | Category never arrived: renderer sent `categories`, desktop products carry `category_id`. |
| P-05 | All three tickets fired at payment. Split: production on **send**, receipt on **pay**. |
| P-06 | Double printing when thermal was on — both systems fired. Old path now returns early. |
| P-07 | No receipt station possible on the till; receipt was never queued. "Till receipt" always offered. |
| P-08 | `Print receipt` said "sent" and printed nothing. Real reprint, marked **Duplicate Print**. |
| P-09 | Preview dead: handler expected a full `PrintContext`, screen sent `{stationId, paperWidthMm}`. |
| P-10 | Kitchen preview showed "0 items to cook" — sample routing ids didn't match the previewed station. |
| P-11 | Test print crashed on `station.kind` — same shape mismatch as P-09, missed once. |
| P-12 | **`-args` does not bind with `-Command`.** Root cause of three separate "printer" failures. Values now travel in the environment. |
| P-13 | Error classifier guessed from message text — `GetPrintQueue` was in the "not found" regex, so any fault in that call reported a wrong printer name. Now classifies on Win32 codes only, and says **"this is a fault in SwiftPOS"** when it is. |
| P-14 | USB needed manual sharing. Now Win32 `OpenPrinter`/`WritePrinter` RAW via P/Invoke — printer picked by name, no sharing, no native module. |
| P-15 | Receipt footer collapsed to one line — `wrap()` treats `\n` as a space. `wrapAuthored()` keeps author line breaks. |
| P-16 | **Every HTML print was truncated.** The measuring window had no width, so Electron defaulted it to 800px while printing at 302px. Shift report lost its entire cash reconciliation. |
| P-17 | Z-report was the last HTML document, via **two** routes (`printReceipt` and `window.open().print()`). Now ESC/POS through one helper. |
| P-18 | Drinks-only orders printed a kitchen slip reading **"0 items to cook"**. `hasPrintableContent()` — nothing routed, nothing printed. Receipts exempt. |
| P-19 | Both report screens set a failure message nothing displayed. Now shown. |

**New capability:** owner-stated kitchen exclusions (`business_settings.kitchen_exclusions`),
edited in Dashboard → Restaurant, cached on each till, applied to every source of
units. Your design — explicit beats inferred.

---

## I. Verified correct — do not re-audit

- **Item 10 numeric sweep:** additive coercion is clean. This codebase coerces at
  the API boundary, which is the right place. BUG-12 was in a *job* — no boundary.
  **Comparisons were not clean** — see C7.
- **The refund model is right.** `orders.status` stays `completed` on refund
  (migration 37), so the negative leg stays in shift-close scope. The bug was on
  the till only.
- **Constraints the code depends on all exist** — `stock_levels` and `users`
  composite uniques, and the `/orders` idempotency index. The schema dump does not
  render composite uniques; always cross-check `00_baseline.sql` before concluding
  one is missing.
- **`adjust_product_stock` already existed** (migration 61) and the sale path
  never called it. Same shape as `chunkIn`. Worth checking for more of these.
- **Ticket layouts match `SAMPLE-OUTPUT.txt` byte-for-byte**, both widths, and the
  sample is regenerated on every `npm test` in the printing package.

---

## L. The pattern

The 08-07 handoff ends: *"Every serious bug in this codebase came through the same
seam: two things that must agree, with nothing comparing them."*

This session was that, repeatedly — and now with gates on the two widest seams:

- `check-table-usage` — a table written under one name, read under another (B6)
- `check-client-parity` — a field the server reads that one client sends (B5)
- `check-ipc-parity` — caught P-17's handler landing in the wrong file **before** it shipped

The seam that kept biting and has **no** gate: **an IPC channel whose two sides
disagree about the payload shape** (P-09, P-11). `check-ipc-parity` proves a
channel exists, not that its arguments agree. That is the next gate worth building.

---

## Changelog

| Date | Change |
|---|---|
| 2026-08-28 | **A169 VERIFIED CLOSED + A181 T2 recovery confirmed (live cloud data).** Cloud rows show one till (`55e8dd9f`) crediting two different cashiers — `T001--6` to Bill, the rest to Eugene — proving per-order cashier attribution (not till, not owner); `credited_to`+`device_id` per row is the owner’s "which cashier, which till" ask. A181’s recovered `T2--6`/`T2--7` (old till `4396d282`) confirmed present, closing its last residual thread. Open P1 19→18. Docs-only (rule 18). |
| 2026-08-28 | **Four live P0s VERIFIED CLOSED on a real Windows till (v0.5.38 · win32).** A181/A183 — online sale `T001--1` reached the cloud DSR and offline-accrued sales drained to 0 on reconnect with no order-number collision (migration 94 per-device index live in prod). A167 — offline PIN sign-in, no NULL-token crash. A152 — on a real Render 503 (suspended service) offline auth fell through AND a wrong PIN was still rejected. A177 — pending queue drains on reconnect. A17 stays OPEN (build task). Open P0 5→1, P1 20→19. Non-blocking: A183 repo test + its `-p` delivery manifest still absent (rule 14); A181 historical `T2--%` recovery query un-run. Docs-only, no zip (rule 18). |
| 2026-08-20 | **A139 built (server-side; desktop unchanged).** Per-branch receipt header/footer + 24h overrides for franchises. Migration 91 `branch_settings` (PGlite-verified); `/pos/init` overlays this branch's overrides onto the business default (branch wins, absent→inherit) — the till already sends `?branch_id` so no desktop change; `GET/POST /api/branches/:id/settings` (upsert/clear) with tenant guard; per-branch editor on the branch detail page. Server+dashboard tsc/build, drift + route gates green. Stays OPEN: **NEEDS PROD-MIGRATE 90→91** + one till confirm. |
| 2026-08-20 | **A134 closed — Business Profile tab (Slice 1).** Owner-editable identity via new `PATCH /api/business` (whitelisted fields; currency locked once sales exist; login email stays admin), plus business-wide receipt header/footer + 24h toggle. New `BusinessProfileTab.tsx`, wired as the Business landing tab. Server + dashboard tsc/build green; route gate 278/278; drift gate clean; browser confirm pending. Per-branch franchise overrides split out to **A139** (cross-stack incl. desktop till + a migration). |
| 2026-08-20 | **A138 closed — catch-less mutation sweep.** Swept 124 mutating api calls / 39 dashboard files; only the vertical settings pages swallowed errors (siblings of the A135-fixed Restaurant page). Parking (saveBay/deleteBay/saveSetting), Minimart (saveSetting/saveProduct/runImport), Petrol (savePump/deletePump/saveTank/recordDelivery/saveSetting) now surface the real error via toast. FloorPlan/StockTransfers mutations already handled. 0 swallowers remain; tsc + build green. |
| 2026-08-20 | **A136 closed — both server↔schema drifts fixed.** `stock_movements.business_id` (fueltanks.ts, reports.ts) → scope by business via the `products!inner(business_id)` join (matches inventory.ts). `users.pin` (staff.ts /clock) → verify against `pin_hash` with the canonical `verifyPin` (bcrypt+legacy), now exported from auth.ts and reused (no duplicate security logic). Allowlist emptied; drift gate green with 0 allowlisted (self-test 11/11); server tsc clean. Runtime confirm pending (clock-in identifies staff; fuel movements + deliveries report return data). |
| 2026-08-20 | **A137 closed — bulk-create tables ("Add multiple").** Typed count (1–100) on the Tables header + empty state; creates T-numbered tables continuing after existing, reuses POST /api/tables (route gate: 275 calls, 0 breaks), surfaces errors. Declined the auto-seed-20-at-signup idea by design (wrong data, wrong verticals, riskier path; empty-state one-click covers it reversibly). tsc + build green; browser confirm pending. |
| 2026-08-20 | **A135 closed (owner-confirmed).** KDS blank → the array guards (2ff5de2) render the empty "All clear" board (green dot); owner screenshot confirms. Add-table → works with the silent-failure fix live (1ffc073); owner confirms "Table creates". Both halves resolved. Follow-ups noted (broader catch-less-mutation sweep; A136 unrelated). |
| 2026-08-20 | **A136 opened — full API check of the dashboard.** Route/method contract clean (274 dashboard calls vs 249 server routes, 0 missing/mismatched). DB contract: built the full schema in PGlite from all 85 migrations and checked every server `supabase.from`/`.rpc`/filter-column — found two real drifts: `stock_movements.business_id` (fueltanks.ts, reports.ts; table has `branch_id`) and `users.pin` (staff.ts; column is `pin_hash`), both PostgREST-400 at runtime; three false positives (chunkIn/float_transactions) verified and discarded. Caveat: `schema-index.json` is stale (16 tables) so prod can't be cross-checked — could be server bug or migrations-lagging-prod; not fixed (needs intent + live DB), both allowlisted. Delivered two CI gates: `check-api-routes.mjs` (Schema-drift job) and `check-api-schema-drift.mjs` (server-suites, needs PGlite), each with a `--self-test` mutation assert; ci.yml valid. |
| 2026-08-20 | **A133 opened (owner dashboard Settings consolidated — Slice 1, delivered for review)** — the flat Setup group (eight unlike items, two not settings) becomes a **Settings** group of three tabbed sections, the same group→page pattern Menu/Stock/Finance use: **Users and access** (Staff members · Roles and permissions), **Devices and printers** (Terminals · Devices · Printers · Print stations), **Business** (Branches · Tax & compliance · Payments · [vertical] Setup · Integrations). The arrangement change A132 explicitly deferred ("Arrangement unchanged"). Non-settings relocated: **Table Turnover → Finance** (a report), **KDS → top level** near POS (a live screen); **Payment methods → Business › Payments** (out of Menu). 6 new files under `apps/dashboard/src/pages/settings/` (`SettingsSection` shell + `UsersAccessPage`/`DevicesPrintersPage`/`BusinessPage` + `ReportSchedulerTab`/`WebhooksTab` extracted verbatim from `SettingsPage` so Integrations shares one copy, rule 17); 2 edits (`App.tsx` nested routes + back-compat redirects for every old deep link; `DashboardLayout.tsx` static three-item group replacing the dead static Setup group AND the runtime `setupGroup` rebuild AND the orphan `TYPE_SETTINGS`). `SettingsPage.tsx` now unrouted, left in place (additive), flagged for deletion. VERIFIED on-bench (deps present, unlike A132): `apps/dashboard` `tsc --noEmit` 0 errors + `npm run build` green (vite, new chunks emit). NOT verifiable here (rule 16): browser rendering incl. possible double-heading, nav open/active state, redirect bounce. **Slice 2 — manager parity — specified in MANIFEST-2026-08-20-a, NOT built** (1,357-line flat PIN/permission tab switcher, different context — its own slice, rule 12). Decisions for owner: Branches under Business; vertical Setup one type-resolved tab; **Profile deferred → A134**. Stays OPEN pending browser confirm + sign-off + Slice 2. Nothing merged/pushed. Delivery: MANIFEST-2026-08-20-a.md. · **A134 opened (Business › Profile tab, deferred)** — company-level settings (name, currency, receipt header, 24-hour operation) with no vertical-neutral home today; the one genuinely new page in the consolidation, so not shipped blind (rule 20) — needs its field list first. Filed, not built. |
| 2026-08-19 | **A132 closed (dashboard nav — accordion + desktop icons, original labels kept, UI only)** — presentation-only reshape of `DashboardLayout.tsx`, no routes/data/logic changed. (1) Accordion: nav used to open every group on load (`DEFAULT_OPEN` covered all vertical-relabelled variants), so four of five groups + all items showed at once; open-state lifted to the parent → one group open at a time, only the active-route group opens on load, persisted in localStorage; stale `DEFAULT_OPEN` removed. (2) ~30 emoji/glyphs → a monochrome outline SVG set (`NavIcon` + `ICONS`) in the desktop app's style, so both apps read as one product; the sidebar's theme toggle (sun/moon) and notification icons (warning/bar-chart/bell) are ported too, so the sidebar carries zero emoji. (3) Naming: an initial pass aligned labels to the desktop (POS→Till, Terminals→Tills, + casing/terseness) but on owner review the renames read as confusing in the web's single sidebar (Till the sell-screen vs Tills the device fleet), so they were reverted in full — every menu label is unchanged from the current dashboard; only icons + accordion ship; arrangement unchanged. Verified: esbuild bundles the TSX clean; gates green. Dashboard `tsc` NOT run on the bench (deps absent, rule 9) — confirm on CI/`npm run build`. Static preview `nav-preview.html`. No server/DB/desktop change, no migrate. Delivery: MANIFEST-2026-08-19-c.md. | — follow-on from A129. Cloud `applyStockEffects` Track C deducted `product_packaging` only for `order_type === 'takeaway'` (recipe/ingredient/variant/product tracks run for all types), so once A129 let delivery orders reach `POST /api/orders` their packaging went uncounted — packaging-ingredient stock drifts high by (delivery volume × packaging/item) for businesses that track packaging. Not a money/sale issue, no-op where packaging isn't configured, strictly better than pre-A129 (delivery reached cloud not at all). Owner's call: uniform across TO-GO orders — gate now `takeaway || delivery`, dine-in still excluded (on-site, no to-go packaging). One condition, one file (`apps/server/src/lib/stockEffects.ts`); no schema/migration/desktop change; no backfill (past delivery orders never synced). `tests/stock-effects-parity.test.mjs` extended: delivery asserts packaging −2 like takeaway + a new §6 reads the real source and pins the gate to `takeaway\|\|delivery`, mutation-checked (revert → §6 red naming the gate). Ships with the server on next deploy from `main`; no prod-migrate. Delivery: MANIFEST-2026-08-19-b.md. | — A128's twin on a different column. Migration 58 ("universal business types") re-ADDed `orders_order_type_check` narrowed to `dine_in\|takeaway\|retail\|parking_session\|fuel_sale`, dropping the baseline `delivery` — but `delivery` is a live POS selectable (`POSPage.tsx chooseOrderType`), Zod-accepted (`schemas.ts`), and the create path sets `delivery_person` for it. `create_order_atomic` (migration 69) inserts `order_type` verbatim, so a delivery order fails 23514, POST /api/orders errors, and the till parks it (`sync_queue` → 5 retries → `failed`); the till's LOCAL `order_type` is free TEXT, so the cashier sees a completed sale that never reaches cloud/dashboard. Migration 35's header even claimed "'delivery' is already an accepted order_type" — falsified by 58. Found by sweeping A128's class (rule 6): `schema-parity.mjs` compares column PRESENCE, by design not DOMAINS, so this was invisible to it. NEW GATE `check-push-domain-parity.mjs` + `push-domain-producers.json` diffs each push-table value-list CHECK against the reviewed set of values producers emit, goes red naming `orders.order_type emits {delivery}`, correctly ignores `payments.method` (A128's format check), and is wired into `ci.yml` beside `schema-parity`. FIX: migration 90 re-admits `delivery` only (DROP + guarded ADD, idempotent, REVERT). `aggregator`/`other` NOT re-admitted — nothing writes them (A130). Existing rows can't hold `delivery` so ADD CONSTRAINT can't fail on live data; parked orders drain via `retryFailedOrders()` (idempotent on `X-Idempotency-Key`). No desktop change. Verified real Postgres (PGlite), `test-migration-90.mjs` 9/9, mutation-checked (delivery → 23514 without the fix; '', 'aggregator', 'nonsense' still rejected post-fix); all 18 gates + doc-refs green on the bench. **NEEDS PROD-MIGRATE 86→90** (on `main` via the DB-migrate Action). Delivery: MANIFEST-2026-08-19-a.md. |
| 2026-08-19 | **A130 opened (Aggregators report is the display half of a never-wired feature)** — `GET /api/reports/aggregator` + the dashboard tab, `aggregator_commission_*` settings, and the baseline `orders.aggregator_name` column all exist to report aggregator revenue, but NOTHING writes an aggregator order: grep finds `order_type='aggregator'`/`aggregator_name` only in reads, no INSERT/UPDATE/assignment, and the Zod `order_type` enum never included `aggregator`. So the report always reads empty (looks like "zero", not "not set up"). NOT a migration-58 regression — aggregator orders were never produced even pre-58; this is the "complete at every layer except one wire" shape (rule 17), the missing wire being the writer. Re-admitting `aggregator` (as A129 does for `delivery`) would be wrong — nothing emits it. Decision needed: tag orders as aggregator at creation, build an import path, or retire the tab. Filed, not built. |
| 2026-08-19 | **A125/A126/A127 rows added (rule-14 catch-up)** — these shipped in git with no register entry (the gap the 08-18 header flagged). A127 (P2, closed): admin-portal Branches tab with tills + tech-audit drill-down (`46ad3ae`, `0f39c40`). A126 (P3, closed): admin-portal Phase-3 glass UI refresh (`97dbbb3`). A125 (P3, closed): suspend-purge Stage-2 non-destructive dry-run preview (`0f9e1dc`, `97dbbb3`). Body entries added in §A; no code change. |
| 2026-08-18 | **A128 closed (custom-method sales silently never sync — cloud `payments.method` domain, migration 89)** — Field report: a bill paid with a business's custom payment method (A95) stays on the till and never reaches cloud/dashboard. Root cause is NOT in the desktop app: the custom `code` (`coop_card`, `airtel_money`, …) is written to `payments.method`, but the CLOUD column is value-CHECK-constrained (`payments_method_check`: cash\|mpesa\|card\|credit\|glovo, baseline + migration 46) and only `varchar(20)`. `create_order_atomic` (migration 69) inserts `leg->>'method'`, so a custom code fails 23514 (unknown) or 22001 (>20 chars); the RPC aborts, POST /api/orders errors, the sync engine parks the order (`sync_queue` → 5 retries → `failed`). Silent because the till's LOCAL `payments.method` is free TEXT — cashier sees a completed sale. Same latent break hit `room_charge` (migration 07's "free text" note was also wrong). Migration 86's header claimed method is a "free string… never breaks" — half true (not an FK, but IS check-constrained); this is the register's recurring "two schemas disagree, nothing compares them" shape. FIX (matches the A95 free-text design): migration 89 widens method to varchar(40) (= `payment_methods.code`), drops the fixed-value check, adds a FORMAT check `^[a-z0-9_]{1,40}$` — a right-shaped gate (still rejects empty/whitespace/mixed-case/over-length), not a loosened one (rule 20). Also: the dead `PaymentSchema` z.enum in `schemas.ts` (a THIRD disagreeing list, unwired) rewritten to the same regex + comment so it can't lie if ever wired; migration 86 header gets a non-executable correction note. No desktop change: parked sales drain via existing `retryFailedOrders()`, idempotent on `X-Idempotency-Key: order_id`. Verified against real Postgres (PGlite), incl. the actual file applied twice with seeded rows and the gate mutation-checked (rule 23): pre-fix coop_card/room_charge → 23514, 24-char → 22001; post-fix all accepted, ''/`Bad Method`/41-char still rejected. `apps/server` tsc clean (deps installed + run on bench). **NEEDS PROD-MIGRATE** (89, on `main` via the DB-migrate Action — note `dev` is ahead of `main`), then each affected till taps "⟳ N failed". Delivery: MANIFEST-2026-08-18-a.md. |
| 2026-08-17 | **A124 closed (purge Stage 1: detector + pre-purge export — non-destructive)** — deletes nothing. Server: suspended_at in GET /clients; new GET /clients/:id/export (read-only JSON of normal user data, hashes stripped, financials excluded, audited). UI: isPurgeDue (180-day grace), purge-due badge on clients list, suspension banner + Export button on client detail. Depends on A122/migration 88. Verified: server tsc clean, admin build clean, 0 new type errors, gates green. Stage 2 awaits sign-offs. Delivery: MANIFEST-2026-08-17-o.md. |
| 2026-08-17 | **A123 opened (suspend-grace-period data purge plan — doc-only)** — filed docs/SUSPEND-PURGE-PLAN.md. Model: 6-month grace purges normal user data; financial/tax retained on accountant's schedule. Drafts RETAIN vs PURGE table classification; flags cascade-from-businesses FKs, order_items.product_id SET NULL, PII-in-retained-records (anonymise-vs-leave = accountant/DPO call). Staged: A122 clock done; Stage 1 detector+export; Stage 2 admin-confirmed purge after sign-off. Open Qs: retention number, PII anonymisation, RETAIN-list confirmation. |
| 2026-08-17 | **A122 closed (suspend timestamp — grace-period purge foundation, D2)** — D2: suspend is the client end-state; long-suspended clients purged after a grace window. Non-destructive groundwork: migration 88 adds `public.businesses.suspended_at`; suspend sets it, activate clears it. NO purge logic. Verified: server tsc clean, schema-drift green (88 public.-qualified), gates green. Needs prod-migrate. Delivery: MANIFEST-2026-08-17-m.md. |
| 2026-08-17 | **A121 closed (admin portal: close/reopen branch — G2)** — new admin `PATCH /clients/:id/branches/:branchId` sets status active|inactive; main branch cannot be closed (guard + button hidden); audited. Per-branch Close/Reopen button. Branch status is a soft flag (hides from selector); hard tills-stop/billing gate stays the licence, so Close confirm prompts to also Revoke. Verified green. Delivery: MANIFEST-2026-08-17-l.md. |
| 2026-08-17 | **A120 closed (admin portal: create branch — G1, admin-only per D1)** — owners must never create branches (billed separately); creation is a SwiftPOS-agent op. New admin `POST /clients/:id/branches` (requireAdmin, name<=100 + optional address/phone, is_main:false/status:active, audited) + "+ Add branch" form. Dashboard 403 unchanged. New branch shows "Not licensed"; billing via existing licence flow. Verified: server tsc clean, admin build clean, gates green. Delivery: MANIFEST-2026-08-17-k.md. |
| 2026-08-17 | **A119 closed (admin portal: edit business details + change owner email)** - implements G5/G6. G5: `PATCH /clients/:id` accepts `type` + client-header Edit panel (name/type/currency). G6: admin `POST /clients/:id/change-owner-email` (updates owner auth email auto-confirmed + contact email, audited; no reassignment) + Change Email button. Built on A118 (cumulative files). Verified: server tsc clean, admin vite build clean, +3 pre-existing-class S.input CSSProperties errors only (one real askPrompt-unknown looseness fixed), gates green. NOT bench-testable - click-test edit + email change. Delivery: MANIFEST-2026-08-17-j.md. |
| 2026-08-17 | **A118 closed (admin portal: revoke till + rotate reveal code + fix health chart)** - implements G4/G3/G8 from ADMIN-PORTAL-PLAN.md. G4: admin `DELETE /clients/:id/devices/:deviceId` (stolen-till kill switch, mirrors owner revoke + admin audit) + Revoke button per device row. G3: Rotate button wiring the existing `reveal-code/regenerate` endpoint (A114 kill switch, previously no UI). G8: Fleet Health card charts the three health bands (green/amber/red) not business type; dropped unused type breakdown. Verified: server tsc clean, admin vite build clean, 0 new type errors, gates green. NOT bench-testable (admin has no tests) - needs click-test. Delivery: MANIFEST-2026-08-17-i.md. |
| 2026-08-17 | **A117 opened (admin-portal plan - capability completion + glass refresh; doc-only, not scheduled)** - filed `docs/ADMIN-PORTAL-PLAN.md` from the admin-portal audit. Nine confirmed gaps (G1 add branch impossible; G2 close branch; G3 rotate reveal code - A114 kill switch unreachable; G4 revoke stolen till - read-only in admin, security; G5 edit business details; G6 change owner email/reassign; G7 offboard; G8 Fleet-Health chart plots type not health; G9 two uncross-checked fleet counts) mapped to 3 phases. Glass direction locked via `docs/admin-portal-glass-mockup.html`. Decisions: D1 branch-create model (a admin-only / b self-serve / c both), D2 client offboard vs suspend. |
| 2026-08-17 | **A116 opened (digital-signage module — design proposal for TVs/display screens; not scheduled, doc-only)** — filed `docs/SIGNAGE-DESIGN.md`: architecture for menu-boards/promos/media on standalone displays (Android-TV/smart-TV kiosk web player), managed from a new dashboard **Displays** section behind an RBAC `signage.manage` key. Principles: reuse the platform (Supabase Postgres + JWT/RBAC + Render — no second auth or DB); signage screens are unattended and kept SEPARATE from `user_devices` (staff tills), with their own pairing; a `menu_board` stores which categories/layout to show and resolves LIVE products + branch-specific prices + active promotions at play time (never copies prices); offline-tolerant via service-worker cache-first media. New tables all `business_id`-scoped, location ones also `branch_id` (`signage_screens`, `signage_screen_groups`, `signage_content`, `signage_media`, `signage_playlists`+items, `signage_schedules`+entries); new routes under `/api/signage/*` (admin = JWT+RBAC; player = per-screen HMAC token). Phased: P0 menu-board MVP → P1 media CMS (Supabase Storage + ffmpeg transcode on Render) → P2 Supabase Realtime + branch-node offline. Adapts the existing standalone **Content-Manager-Pro** signage codebase (pairing, offline cache, transcode, now-pluggable storage). Source-pointer decision (owner Q): cite the Content-Manager-Pro **repo**, not a personal account/email — add the GitHub URL once the repo is pushed (private; URL TBD). Adds **NO §A/§D open finding** — Open/Counts rows unchanged (roadmap/design item, like the A74–A111 changelog-only entries). No code, no migration, no manifest. NOTE: originally filed as A115, which a concurrent session took for the health-monitoring closure — re-filed under A116 to avoid an ID collision. `check-register-consistency` + `check-doc-refs` re-run green after re-file. |
| 2026-08-17 | **A115 closed (health monitoring documented + direct Supabase keep-alive)** — owner set up an UptimeRobot monitor on `/health`, but a sister app's Supabase still PAUSED at ~day 15 despite it. Root cause: `/health` keeps Supabase warm only through the Render→Supabase chain, and free Render (cold ~50s wake / monthly-hour cap) can drop the ping before it reaches Postgres, so Supabase accrues idle days and pauses anyway. The `/health` endpoint itself is well-built (bounded DB round-trip that reaches Supabase, cached schema check, 200-on-drift / 503-on-DB-down, strict check isolated in `/health/schema`; `render.yaml healthCheckPath: /health` correct) — no code fix needed. Added: (1) `.github/workflows/supabase-keepalive.yml` — a scheduled job (every 3 days + manual dispatch) that touches Supabase **directly**, independent of Render, closing the fragile-chain gap for dormant deployments (live stores stay warm via till sync); needs repo secrets `SUPABASE_URL`/`SUPABASE_ANON_KEY`. (2) RUNBOOK §6 documenting both UptimeRobot monitors (keep-warm on `/health` at 5-min/≥60s-timeout; drift alarm on `/health/schema` at 15–30-min, **excluded from uptime %**), the Supabase-chain caveat, and the honest fix (Render paid / Supabase Pro remove spin-down/pause). Verified: workflow YAML lints; doc-refs green. GitHub cron drift is immaterial for a 3-day touch inside a 7-day pause window. Delivery: MANIFEST-2026-08-17-h.md. |
| 2026-08-17 | **A114 closed (tech-access reveal code: stable-per-branch, auto-provisioned, self-healing on sync)** — resolves the "Incorrect code" lockout and the offline-till access design. Root cause: the branch reveal code (`branches.tech_reveal_code`) was minted lazily and only CACHED on the till at owner-login/enrol — but the till UI has no owner-login path, and the staff-PIN path (`auth:verifyPin`, A101 chain) never refreshed it, so a cashier-only till held a NULL/stale code and the technician reveal stage could never pass. Design agreed with owner: ONE stable reveal code per branch (doorknock, never rotated) + the per-tech, per-access, offline-verifiable `st2.` Ed25519 token (unchanged — it already verifies against the cached public key with zero connectivity, which is how a never-online till is serviced). Rejected a shared-symmetric-secret scheme: it would re-introduce token forgeability from a stolen till, the exact risk the asymmetric design removes. Changes: (1) server `GET /api/tech/branch-config` now auto-mints + persists a reveal code when missing (lazy provisioning; stable thereafter, never rotates here); (2) desktop `syncEngine.syncAll` calls `refreshTechConfig(_accessToken)` after each catalogue pull, so any online sync self-heals the cached reveal code + public key without an owner login (device token is restored at startup, so cashier-only tills have it); (3) **migration `87_backfill_branch_reveal_code.sql`** front-fills a stable code for every EXISTING branch that had NULL, using the same alphabet/length as `generateRevealCode()` (verified) and schema-qualified per A62. Token path untouched. Verified: server + desktop-main `tsc` clean; migration codes match the validator; schema-drift/sql-binds/table-usage/register/supabase-catch gates green. NOT bench-verifiable (rule 9): the on-till refresh + reveal-stage pass need a real online sync; the migration needs the prod-migrate step + a real-data check. Delivery: MANIFEST-2026-08-17-g.md. |
| 2026-08-17 | **A113 closed (tech-access hardening — retire legacy v1 HMAC tokens + hardcoded default secret)** — audit of the tech-access subsystem found two real issues (design otherwise sound: Ed25519 asymmetric, offline-verifiable, clock-rollback-guarded, 48h/4h bounds, audit-logged, prod refuses to boot without signing keys). **F1:** `tech.ts verifyTechToken` still ACCEPTED legacy v1 HMAC tokens though nothing minted them (v2 `st2.` Ed25519 is the only live mint via `signTechToken`) — pure forgery surface gated on a shared secret, exactly what v2 removed. **F2:** `admin.ts` held a hardcoded default `TECH_HMAC_SECRET` (`'…change-at-install'`) used only by a DEAD `generateTechToken`. Fix (all deletions, no behaviour change to the live v2 path): removed the v1 verify branch (`verifyTechToken` is now `st2.`-only), deleted `admin.ts`'s dead minter + default secret, and swept `TECH_HMAC_SECRET` out of `env.ts` (no longer required at boot), the `envGuard.ts` comment, and `render.yaml` (dead prod var; `TECH_SIGNING_PRIVATE/PUBLIC_KEY` remain). Verified: mode-switch tokens are unaffected (random codes looked up by sha256 hash, never HMAC); server `tsc` clean; no functional `TECH_HMAC_SECRET` refs remain; gates green; no test fed a v1 token. Remaining (owner): confirm `TECH_SIGNING_*` set in prod and the desktop's cached public key matches; low-sev residue noted (offline revocation lags to 48h expiry — rotate the branch reveal code when a tech's access ends). Delivery: MANIFEST-2026-08-17-f.md. |
| 2026-08-17 | **A112 closed (register header reconciled to the tree, doc-only)** — the header's Tree line had lagged since ~08-14 (`0215475` / desktop v0.5.27 / schema 51) and the header never explained where A74–A111 went. Corrected the Tree line to current reality (post-A111; desktop **v0.5.34**; `LOCAL_SCHEMA_VERSION` **52**; web/cloud runtime **Node 24**; desktop **Electron 43**) and added a **Reconciliation** row: A74–A111 live in the Changelog and were near-all closures, so the §A/§D-derived Open/Counts rows are unchanged and still accurate; the open **P0** is A17, now carried by its hardware-pending fix A99–A101; authoritative open list is `HANDOFF-2026-08-17.md` §7. No finding opened/closed by this edit; `check-register-consistency` + `check-doc-refs` green. |
| 2026-08-17 | **A111 opened (standardise on Node 24 LTS across web/cloud + CI; config-only)** — follows A108. The owner moved local to Node 24 (LTS, multi-year support) and, since Electron 43 (A108) already bundles a Node-24-era runtime, the whole stack now aligns on 24. Flipped every `engines.node` 22→24 (root `>=24`; dashboard/admin/server `24`; print-server `>=24`) and every CI `node-version` 22→24 across `ci.yml` (incl. the node:sqlite lane — still ≥22.5, comment updated) and `db-migrate-prod.yml`. Desktop unchanged (no `engines`; Electron owns its bundled Node). **Config-only — no code, no deps, no lockfiles shipped**: the engines line in each lockfile re-syncs on the next `npm install` under Node 24. Verified on the bench (Node 22): all five `package.json` parse, both workflow YAMLs lint, dashboard `vite build` clean, repo gates green; `npm install` now emits the EXPECTED `EBADENGINE required:{node:24} current:v22` — which confirms the new pin is live (silent on Node 24). NOT verified on a real Node-24 runtime here (nodejs.org isn't on the bench allowlist and apt only offers 22) — real proof is the owner's local + the CI run on 24; 22→24 is a modern low-risk step and the code already built+tested clean on 22 (A108). Owner action: confirm each Vercel project's Node.js Version UI offers 24; Render reads `engines`. Delivery: MANIFEST-2026-08-17-d.md. |
| 2026-08-17 | **A110 closed (recharts v2 deprecation resolved repo-wide; NO new charting library)** — the Vercel `npm warn deprecated recharts@2.x` line (a deprecation, not a vulnerability — audit was already 0). Root cause on inspection: recharts is barely used. **Dashboard used it ZERO times** — every chart (`MiniBarChart`, `HourlySparkline` in `OverviewPage.tsx`) is hand-rolled SVG; recharts survived only as a dead `package.json` dep, a stale `App.tsx` comment, and an orphaned `manualChunks` branch. Removed all three → `npm install` drops **37 packages** (recharts + d3), `vite build` clean, 0 vulns, warning gone. **Admin was the only real user** — a single `BarChart` in `AdminPortal.tsx` (client-type breakdown) plus dead `LineChart`/`Line` imports. Checked the official 3.0 migration guide against that exact usage: none of the breaking changes apply (no `Customized`, no custom-`content` Tooltip — it uses `contentStyle`, default axis IDs so the new `CartesianGrid` x/yAxisId rule is a no-op, single Y axis, no Scatter/Area/Pie/Reference). Bumped `recharts ^2.12.7 → ^3.10.1`, dropped the dead imports; `vite build` clean (603→590 KB), 0 vulns, and tsc shows **zero** new/chart-related errors. **Decided against adding a new charting library** — one 7-bar chart doesn't justify swapping one big dependency for another; v3 is the current supported major and the minimal fix. NOTE (pre-existing, untouched): admin has ~59 `tsc --noEmit` errors (inline-style `boxSizing` etc.) that predate this and are unrelated — admin builds via esbuild (`vite build`) with no tsc gate, so they don't block deploy; recorded, not fixed here. Residual: admin's one chart should be eyeballed in a browser (no e2e covers AdminPortal). Delivery: MANIFEST-2026-08-17-c.md. |
| 2026-08-17 | **A109 closed (green CI — offline suite `kitchen-exclusions-local` fixture drift, test-only)** — the "Server suites → Run offline suites" job went red on A108 with `table device_config has no column named continuous_operation` at `tests/kitchen-exclusions-local.test.mjs:121`. NOT a product bug and NOT caused by A108's deps: the test extracts the REAL `device_config` INSERT column list from `deviceConfig.ts` (which has included `continuous_operation` since **A104**) but drives it against a hand-rolled `CREATE TABLE` fixture that A104 never updated. The drift was **latent** because the test uses `node:sqlite` (`DatabaseSync`, Node ≥ 22.5) and self-skips on Node 20 — so on the old Node-20 offline lane it never executed its INSERT. A108's Node 20→22 bump activated the test, which immediately caught the stale fixture. Fix: add `continuous_operation INTEGER` to the fixture `CREATE TABLE`, matching `localDb.ts:941`. Verified on Node 22: 17/17 pass; mutation-checked (removing the column reproduces the exact CI error). Full sweep: only this one test hand-rolls a `device_config` schema; the other newly-active node:sqlite root test (`register-status-parse`) passes 12/12; all other jobs (Build, Secret scan, Desktop row scope, Type-check, Schema drift) were already green. Delivery: MANIFEST-2026-08-17-b.md. |
| 2026-08-17 | **A108 opened (Node 20 → 22 runtime + full npm vulnerability sweep to zero; desktop Electron 35 → 43) [web/cloud SHIPPABLE, desktop BLOCKED on two-till build]** — Vercel dropped Node 20, so every web/cloud surface moves to Node 22 and all five apps go to **0 npm vulnerabilities** in one batch. **Web/cloud (verified on the bench, ships on merge):** dashboard 4→0 (react-router 7.18.2), admin 2→0 (postcss/nanoid) — both `engines.node` 22, both `vite build` clean; server 6→0 (`nodemailer` 8→9, `overrides.exceljs.uuid ^11.1.1` — exceljs KEPT at 4.4.0, npm's "fix" was a bogus 3.4.0 downgrade; uuid flaw is v3/v5/v6-with-buf, unreachable via exceljs's v4 use), `tsc` clean + runtime smoke (exceljs writeBuffer, nodemailer 9 createTransport/sendMail); print-server 0→0 (**added a missing package-lock.json**); root + CI (`ci.yml`, `db-migrate-prod.yml`) node-version 20→22. **Desktop (24→0, NOT hardware-verified — rule 9):** electron 35.7.5→43.4.0, electron-builder 25→26.15.7, electron-rebuild@3 shim → @electron/rebuild@4.2.0, better-sqlite3 11→13 (mandatory for the newer runtime; N-API 10, ABI-stable, ships a win32-x64 prebuild — compiles+loads+runs WAL/FK/prepare/transaction on the bench). The 8-major Electron jump produced exactly ONE source break: `PrinterInfo.isDefault` removed in E43 (default-ness now in the platform `options` bag) — read defensively in `printService.ts`, display-only, printing unaffected. Renderer/main/shared `tsc` clean (only the pre-existing benign TS2688 node-types line); 8/9 desktop suites green; `test:pin` 8/8 is the pre-existing plain-node baseline (needs Electron `safeStorage`, only `test:pin:electron` injects it) — proven identical on the un-patched tree, NOT a regression. **Desktop BLOCKED per rule 9/§8: build `pack:dev` on Windows (VS Build Tools) and trade a full shift — app launch, swiftpos.db WAL open, sign-in, thermal print, printer "(default)" label — before any prod till build.** Server nodemailer 9 also needs a real Render SMTP send (bench proves construction only; RESEND_API_KEY still unset, A54). Delivery: MANIFEST-2026-08-17-a.md. |
| 2026-08-13 | **A54 — live log confirms SMTP dead (both ports blocked); test tool added** — `swiftpos-server.onrender.com` boot log shows 587 AND 465 time out (host filters SMTP), IPv4 pin intact. Resend (HTTPS) is the path: set `RESEND_API_KEY` + a verified `NOTIFY_FROM_EMAIL`. Added `sendEmailChecked()` (returns provider/error) and owner-only `POST /api/notifications/test-email` (self-only) to prove delivery on demand. `tests/mailer-transport.test.mjs` §7 (8 assertions). A54 stays OPEN, now blocked on Resend config. |
| 2026-08-13 | **D3 scaffold excluded from the main build** — the committed `autoUpdate.ts` scaffold broke `tsc -b tsconfig.main.json` in CI (unresolved `electron-updater`, an unheld dep). Added it to `tsconfig.main.json` exclude — it is an orphan (imported nowhere), so no runtime change; D3 stays held. Removing the exclude + adding the dep is part of finishing D3. |
| 2026-08-13 | **A66 CI regressions fixed** — the commit went red on two lanes. (1) `REQUIRED_DESKTOP_SCHEMA` was still 51 while A66 bumped `LOCAL_SCHEMA_VERSION` to 52; the two must move together (test-branch-close, test-events enforce it) — bumped to 52 (a till on 51 is merely shown behind, HARD_MIN unchanged). (2) `kitchen-exclusions-local.test.mjs` hard-imported `node:sqlite`, crashing the Node-20 server-suites lane which globs all of tests/; now skips gracefully when the module is absent, like the better-sqlite3 suites. Both verified against the app driver. |
| 2026-08-15 | **A107 closed (green CI — gitleaks false positives on the dev→main PR)** — the "Secret scan" job failed the dev→main PR: gitleaks (default config, no `.gitleaks.toml`) flagged `key = 'escpos_default_on_0527'` in localDb.ts as a `generic-api-key` on entropy alone. It is a `maintenance_state` FLAG KEY, not a credential, and can't be renamed without orphaning rows already written under it. Added a `.gitleaks.toml` that **keeps the full default ruleset** (`[extend] useDefault=true` — real secrets still fail CI) and allowlists only confirmed false positives by their exact match: the flag key; the Crockford base32 alphabet `23456789…XYZ` (enrolment codes, var name `SECRET_ALPHABET` tripped it); a SQL UPSERT column list (`refresh_token, logged_in_at=…`); and an `alg:"none"` TEST-FIXTURE JWT in `security.mjs` (fed in to prove it's rejected). Verified with gitleaks 8.24.3 (the CI version): full-history scan goes from 5 findings to **no leaks found**. Config-only; the `.env`-tracked check already passed. |
| 2026-08-15 | **A106 closed (green CI — test-print-resilience harness)** — the "Desktop row scope" CI job failed on `test-print-resilience.mjs` with `ReferenceError: escapeRegex is not defined`. Not a product bug: `kitchenPrepLines` word-boundaries each owner exclusion term via `escapeRegex` (added in A84), but the test's `new Function` harness — untouched since before A84 — only injected `KITCHEN_NOTE_EXCLUDE`, so the eval'd copy referenced a name not in scope. The test had been red since A84. Fix: extract `escapeRegex` from `ticketLines.ts` alongside `kitchenPrepLines` and inject it into the harness, so the eval'd function has the same dependency the module does. `test-print-resilience.mjs` now 55/55; all nine Desktop-row-scope test files green. Test-only change. |
| 2026-08-15 | **A105 closed (manager-nav consolidation — Shift+Report, Orders+Item Mix) [#6/#7]** — two pairs of sibling tabs folded into one nav item each, selected with a segmented control ("like the print option"). **#6:** the "Shift Report" tab is now a **Shift report** view inside the **Shift** tab (`ShiftAndReportTab` → Current shift | Shift report), so a manager sees the open shift and switches to view/print its Z-report without a second tab. **#7:** **Item Mix** (restaurant-only) is now a view inside **Orders** (`OrdersAndMixTab` → Orders | Item Mix; no selector shown for non-restaurant, which has no Item Mix). Low-risk: the existing `ShiftTab`/`ZReportTab`/`OrdersTab`/`TopItemsTab` are unchanged and simply wrapped; the `zreport`/`items` switch cases are kept as fallbacks though the nav no longer lists them. Renderer `tsc` clean; gates green. Remaining from the change doc: none — this closes the batch. |
| 2026-08-15 | **A104 closed (24-hour operation — grace window + Settings tab) [#3/#4]** — a business that never closes overnight was hard-locked the instant the trading day rolled over (only a manager could clear it), which also blocked cashiers from ever reaching the open-float modal (the reported "cashier doesn't get the opening float" — root cause was the stale-day gate suppressing `needsShift && !needsManager`, NOT a role bug in the modal, which is role-independent). Added a per-business **24-hour operation** setting: `checkDayGate` keeps the hard lock (cash must be confirmed to close a day) but, when continuous mode is on, grants a **2-hour grace window** after midnight during which the till keeps trading behind an amber reminder — so a cashier gets the open-float modal and service continues while a manager closes the prior day; after the window the red hard lock returns. Wired like receipt text: `continuous_operation` in `business_settings` → `/api/pos/init` → cached to `device_config` (new column via migrateColumns) → read by `checkDayGate`. New desktop **Settings** tab (renamed from Payments) with the 24-hour toggle and the payment-methods manager moved into it (owner asked to gather custom settings there). `tests/day-gate-grace.test.mjs` (6 assertions, mutation-checked). Server + desktop `tsc` clean; gates green. Note: the dedicated manager/supervisor role the owner mentioned for day-close is a later addition; today's close stays on the existing manager gate. |
| 2026-08-15 | **A102 closed (custom receipt header missing on the physical receipt)** — the owner's editable header (address/tagline lines under the business name) rendered in the on-screen `ReceiptView` but never on the thermal print: `renderReceipt` printed name/branch/PIN/telephone and skipped `receipt_header` entirely. Added `header?` to `BusinessConfig`, rendered it centred (one line per line, blanks dropped) right under the branch name to match the screen, and passed `cfg.receipt_header` into the print ctx from `queueThermal`. Footer already worked (`thankYouMessage`). Verified by rendering a sample ticket — all four header lines now print; a ticket with no header is unchanged. shared/printing + desktop `tsc` clean. |
| 2026-08-15 | **A103 closed (till Payments tab "Something went wrong")** — the desktop Payments manager (A97) hard-failed to a useless generic error when `manage:listPaymentMethods` couldn't reach the server (offline manager token / transport), because the list came only from `manageFetch`. Made the panel resilient: on a list failure it now falls back to the methods CACHED on this till (`pos:paymentMethods`, A96) shown read-only with a clear amber note ("Can't reach the server to manage… showing what's active on this till — reconnect to add, rename, or remove"), and hides the add/edit/delete controls while offline. Management still needs a connection; the manager always sees the live tenders. Desktop `tsc` clean. |
| 2026-08-15 | **PHASE5 GATE — A101 hardware sign-off REQUIRED before A19** (process entry, no code change) — the offline-auth chain (A99→A101) is code-complete on origin, but per PHASE5 §8 it must **trade a full service on the dev flavour across two tills** before A19 (the node→cloud relay, which moves money paths) is built or shipped. **A19 is BLOCKED** until the five A101 hardware checks pass on real hardware: (1) peer signs in via the node when both online (`node sign-in:` in the log); (2) cloud down + node up → peer still signs in; (3) wrong PIN → refused immediately, never falls through; (4) node+cloud both down → cached cashier signs in, and a node-configured till does NOT time-expire (30+ days); (5) a cashier deactivated on the dashboard is refused at the peer via the node after the node re-syncs. Checklist delivered: `swiftpos-a101-test-checklist.html`. Owner to report pass/fail before A19 begins. |
| 2026-08-15 | **A101 (PHASE5 slice 2) — peer authority chain + no time-bomb expiry [A17, closes P0]** — the behaviour change. A peer's `auth:verifyPin` is now **node → cloud → last resort**: it asks its branch node over the LAN first (`verifyPinAtNodeClient` → `POST /node/verify-pin`), then the cloud as before, then a local authority. The **08-08 rule holds across all three**: fall back only on a transport failure, never on a rejection — a `401` from the node is as final as one from the cloud, so a sacked cashier can't sign in by unplugging a cable. The node itself falls back to its OWN roster (`verifyPinAtNode`, never expires) rather than a cache. **Expiry is no longer a time bomb (owner's call):** a till with a node configured NEVER time-expires its offline cache — revocation for such a till is the node roster (wholesale-replaced each pull), not a clock — so a remote branch that relies on its node is never locked out. Only a STANDALONE till with no node keeps the 14-day bound. Accepted tradeoff, documented: a stolen node-configured peer, kept off the LAN, can sign in a previously-cached cashier indefinitely; physical security and §5's typed-Windows-password rule cover the node. `tests/peer-auth-chain.test.mjs` (7 assertions, mutation-checked on the rejection-is-final rule). Desktop main `tsc` clean; gates green. **Per PHASE5 §8 this must trade a full service on the dev flavour across two tills before it reaches a prod till.** |
| 2026-08-15 | **A100 (PHASE5 slice 1b) — node roster cache + /node/verify-pin [A17]** — second additive step. Node-only local `branch_staff` table (safeStorage-wrapped bcrypt PIN + override hashes, permissions, status) populated from `GET /api/pos/branch-staff` on every catalogue pull (node role only, best-effort AFTER the catalogue is stored so it can't fail the pull). New `branchStaff.ts` mirrors `pinCache`: bcrypt only, scan every candidate, **refuse on two matches**, but with **no TTL** — a node is the branch's authority and its roster is valid until replaced (§4e), replaced wholesale each pull so a deactivated staff member disappears. New `POST /node/verify-pin` on the node (guarded by the same X-Node-Secret + branch scope as every /node/* route): returns the identity + permissions on a match, 401 on a bad/ambiguous PIN (final — the peer must not fall back on a 'no'), 503 only when the node can't read its roster. **No JWT minted.** Still fully additive — the node can now answer, but no peer asks yet (slice 2). `tests/node-verify-pin.test.mjs` (5 assertions, mutation-checked). Desktop main `tsc` clean; gates green. |
| 2026-08-15 | **A99 (PHASE5 slice 1a) — node branch-staff endpoint [A17]** — first, fully ADDITIVE step of the branch-node auth work (PHASE5 §4b): `GET /api/pos/branch-staff` hands a branch NODE its active staff roster with bcrypt PIN + override hashes and effective permissions, so the node can later authenticate cashiers offline (closing the day-15 lockout). This is the one route that gives a machine the branch's PIN hashes, so the guard is four conditions: desktop surface, the caller's own business, a device registered as node/office (server-side `isNodeRole` via `user_devices.device_role` — the D4/D14 prerequisites, already in place), and that device's own branch. Effective permissions resolve exactly like `/verify-pin` and the JWT (role grants then per-user overrides); bcrypt-only (a legacy hash upgrades on the next online sign-in). Nothing on any till changes behaviour yet — the node roster table + `/node/verify-pin` (slice 1b) and the peer auth chain (slice 2, the behaviour change, hardware-tested before it ships per PHASE5 §8) follow. `tests/branch-staff-roster.test.mjs` (7 assertions, mutation-checked). Server `tsc` clean; gates green. |
| 2026-08-15 | **A98 closed (kitchen exclusions — chip editor + explicit Save)** — the desktop exclusions editor was a free-text box that saved silently on blur, so it was unclear whether a change had persisted. Replaced with a chip editor: each term is a removable chip (✕), a term is added with Enter or the Add button (a pasted comma/line-separated list is split and de-duped case-insensitively), and an explicit **Save** button persists the list — with "Unsaved"/"Saved" status. Same data and semantics (per-terminal override wins over the business default, survives sync; "Reset to cloud default" unchanged); built-in drinks rule still shown read-only. Renderer `tsc` clean; gates green. |
| 2026-08-15 | **A97 closed (custom payment methods — web POS + till management)** — completes #4. **Web POS:** `usePOSData` now surfaces `paymentMethods` from `/api/pos/init` (+ `POSInitResponse` type), CashierScreen passes them to the web `PaymentModal`, which renders them as tender buttons after Cash/M-Pesa/Card/On-Account (`method` widened to string); a custom method settles immediately like a card (non-cash, no STK), stored as its `code`. **Till management:** methods can now be added from the desktop too, not only the dashboard — new manage IPC (`manage:listPaymentMethods`/create/update/delete → `/api/payment-methods`) + a **Payments** tab in the till's manager (gated `settings.manage`||`products.manage`); after each write the local `payment_methods` cache is rewritten so a new tender appears at the POS at once. Server + dashboard + desktop `tsc` clean; gates green. A96/A97 close the feature end to end: define (dashboard or till) → offline-cached → tender on both POS clients → reports by name → non-cash in reconciliation. |
| 2026-08-15 | **A96 (Phase 2) closed (custom payment methods — POS wiring)** — the methods defined in A95 now work as tenders at the point of sale, offline. `/api/pos/init` returns active `paymentMethods` (per business); the till caches them in a local-only `payment_methods` table (replaced wholesale on each pull, like stations) so they are available with no network. `PaymentModal` renders them as extra tender buttons after Cash/M-Pesa/Card (`DraftLeg.method`/`PaymentLeg.method` widened to string); a custom leg carries its `code` as `method`, flows through `createLocalOrder` → payments → sync → server (stored as-is) → `/sales` (already groups by method), and reports under its name. Reconciliation is unaffected — expected cash filters on `method==='cash'` only, so every custom method is non-cash by construction (owner decision). Receipts and the shift report humanise an unknown code (`coop_card` → "Coop Card"). Wired through IPC (`pos:paymentMethods`, preload, posApi). Server + desktop + shared `tsc` clean; gates green. **Web POS wiring is the remaining slice** (desktop — the offline priority — is done here). |
| 2026-08-15 | **A95 (Phase 1) closed (custom payment methods — define)** — a business could not accept a tender beyond the built-in Cash / M-Pesa / Card (owner asked for "Coop Card" etc.). Phase 1 lets them DEFINE custom methods: migration 86 adds `payment_methods` (per business — id, business_id FK, name, code UNIQUE per business, is_active, sort_order); server CRUD at `/api/payment-methods` (list/create/patch/delete, business-scoped, `settings.manage`||`products.manage`, code generated once from the name and immutable so historical orders keep mapping); dashboard **Payment methods** page (add / rename / activate / delete) + nav. Scope per business, all methods non-cash for reconciliation (owner decisions). The server already stores `leg.method` as a free string and `/sales` groups by it, so defined methods report by name once used. `scripts/test-migration-86.mjs` (7 checks, PGlite, UNIQUE-per-business proven). Server + dashboard `tsc` clean; gates green. **Phase 2 (A96, next): wire the methods into the desktop till + web POS payment modals.** |
| 2026-08-15 | **A94 closed (reprint any receipt from Order History)** — the only reprint was the post-payment modal's button (`escpos:reprintReceipt`), which reprints the *last* order cached in memory — no way to reprint an earlier one after moving on. Added per-row **Reprint** on the Order History panel. Faithful by construction: `createLocalOrder` now stores the exact order payload in a local-only `receipt_payloads` table (pruned to 200), and `escpos:reprintReceiptForOrder(orderId)` replays it through the SAME `queueThermal` path as the original — byte-identical, marked "Duplicate Print". Wired through IPC (preload, posApi). Orders created on another terminal or before this shipped have no stored payload and report so honestly rather than printing something wrong. Renderer + main `tsc` clean; gates green. Advice items from the same review — exclusion "add term" chips (#1) and custom payment methods (#4) — recorded for later, not built here. |
| 2026-08-15 | **A93 closed (M-Pesa reported as "unaccounted" on the cloud) [#3]** — the desktop shift showed M-Pesa correctly but the dashboard payment-method breakdown booked it as "unaccounted". Cause: `/api/orders` wrote EVERY M-Pesa leg `status='pending'` (for the STK-push flow, where the Daraja callback later flips it to `completed`), but the desktop till is a **manual tender** — the cashier confirms on their phone, there is no STK and no callback — so its M-Pesa legs sat `pending` forever, and `/sales` counts only `completed`, surfacing the amount as the unaccounted remainder. Cash was `completed`, so only M-Pesa broke. Fix: the till now sends `status:'completed'` on its (always-confirmed) legs; the server honours an explicit `completed` for M-Pesa and keeps `pending` as the default only when none is sent (the STK path is untouched). Migration 85 backfills the historical stuck rows, guarded so it can never complete an in-flight STK payment (`mpesa_checkout_id IS NULL` AND older than 1h). `scripts/test-migration-85.mjs` (6 checks, PGlite). Server + desktop `tsc` clean; gates + 17 migration tests green. |
| 2026-08-15 | **A92 closed (one-click default stations seed)** — a fresh restaurant with no stations showed the "N categories print nowhere" warning and required creating stations + ticking every category by hand. Added `POST /api/stations/seed-defaults` (guarded: refuses if any station already exists) that atomically creates **Kitchen** (kitchen), **Packing** (dispatch) and **Till** (receipt), then routes every category so none prints nowhere — cooked categories (`is_kitchen`) to Kitchen, ALL categories to Packing (the packer bags the whole order); Till carries no category routing. Wired through IPC (`manage:seedDefaultStations`, preload, posApi) and surfaced as a **"Create default stations"** button on the empty Stations tab (gated on `canEdit`); refreshes the local station cache so routing works on the terminal at once. Server + desktop `tsc` clean; gates green. |
| 2026-08-15 | **A91 closed (restaurant shows 1 station instead of 3 defaults)** — a restaurant with no stations configured on the server showed only "Till receipt" on the Printers tab, not the expected Kitchen + Dispatch + Till. `FALLBACK_STATIONS` (Kitchen/Dispatch/Till) existed for exactly this day-one case, but the loader always pushed a synthetic receipt when the real list was empty, making it length-1 and so never reaching the fallback. Predates A89 (A89 fixed the source, not this empty-case). Fix: when `/api/stations` returns none, seed the defaults by venue type — restaurant gets all three (matching `shared/printing`'s kitchen/dispatch/receipt presets, the incumbent's three-station layout, and the escpos `is_kitchen`→kitchen/dispatch routing fallback which recognises these built-in ids); retail gets the receipt alone. Configured stations are used as-is, still adding a receipt fallback if the business defined none. Renderer `tsc` clean; gates green. Live check: a fresh restaurant enrolment now shows Kitchen/Dispatch/Till on the Printers tab for binding. |
| 2026-08-15 | **A90 closed (Receipt folded into a "Printing" nav item)** — the Receipt (header/footer text) screen moved from its own left-nav item into the tabbed print screen as a fourth tab, and the nav item was renamed **Printing**. Per-tab permission gating so no one loses access: Stations/Printers/Exclusions require `stations.manage`; the Receipt tab requires `receipt.manage` || `settings.manage`; the nav item shows if the user holds EITHER, and `PrintersScreen` renders only the tabs each permission allows (a manager with only `receipt.manage` keeps Receipt and gains no station control). Removed the standalone `receipt` nav item + its dead switch case + unused import. Renderer `tsc` clean; gates green. |
| 2026-08-15 | **A89 closed (Printers tab showed only 1 station)** — after the tabbed Printers screen (A83), the **Printers** tab listed just the synthetic "Till receipt" where a venue had Kitchen + Dispatch configured. Cause: `ManagerPage`'s station loader read `pos.init().stationRouting.stations` — a field the server **never emits** (zero references in `apps/server`) — so the list was always empty and the receipt-fallback added the one synthetic station. The real source is `GET /api/stations` (the `print_stations` table), which the **Stations** tab (`StationsPanel`) already used — so the two tabs disagreed. Fixed: the loader now calls `posApi.manage.listStations()` (active stations, same source as the Stations tab), keeping the "always have a receipt station" fallback. Both tabs now show the same real stations. Renderer `tsc` clean; gates green. Live check: open Printers on a till with Kitchen/Dispatch configured and confirm all three appear for printer binding. |
| 2026-08-15 | **A88 closed (D13 P0 remainder — refresh-token grace window)** — the last open part of D13. `/refresh` revoked the consumed token before the till persisted the new one; a lost response (crash, power cut, dropped packet) left the till holding a revoked token, and the reuse check then revoked EVERY session "for security" — so a dropped packet logged the owner out of the till, every ~15 min of trading. Fixed with chain-based reuse detection (time-independent, survives a power cut): migration 84 adds `refresh_tokens.replaced_by`; rotation links a consumed token to its replacement; on presenting a revoked token, `refreshGraceDecision` (pure, `lib/refreshGrace.ts`) returns **reissue** when the successor is still the live head (client never received the response — mint a fresh pair, revoke the orphan successor, no session nuke) and **replay** only when the chain advanced or there is no successor (logout) — preserving the security behaviour for real replays. `tests/refresh-grace.test.mjs` (5 assertions, imports real dist, mutation-checked) + `scripts/test-migration-84.mjs` (6 checks, PGlite, additive + idempotent). Server `tsc` clean; schema-index updated; all gates + 16 migration tests green. **D13 now fully closed.** Live verification wanted: pull the till's network mid-refresh and confirm it recovers on reconnect instead of demanding re-login. |
| 2026-08-15 | **A87 closed (A59 remainder — shifts.force_close wired)** — the last deferred A59 thread. `shifts.force_close` was a registered key (migration 75) that nothing used: the force-close route enforced the broad `settings.manage`, no role was granted the dedicated key, and the till's force-close trigger was ungated in the UI (visible to cashiers who then hit a 403). Now, all ADDITIVE: the route is `requireAnyPermission('shifts.force_close', 'settings.manage')`; migration 83 grants `shifts.force_close` to the manager role set (same normalised name match as 75/76/78, idempotent, `tests/`… `test-migration-83.mjs`, 6 checks, PGlite, mutation-checked); `POSPage` derives `canForceClose = has('shifts.force_close') || has('settings.manage')` from the staff session and `ShiftPanel` gates its "Can't count the drawer?" trigger on it — so the UI now matches server enforcement and `check-permission-parity` sees the gate (ungated stays 2, no new divergence). No one loses force-close. Server + desktop `tsc` clean; schema-drift + all gates green. A59 is now fully closed. |
| 2026-08-15 | **A86 closed (sync push — atomic mark-synced) [S3]** — `pushPendingOrders` flipped `sync_queue.status` and `orders.sync_status` to 'synced' in two separate statements in each success branch (201 and 409). A crash between them could leave the two disagreeing — queue synced while the order still read pending, or vice versa. Wrapped both in a single `db.transaction` (`markSynced`), prepared once and reused per row, so they move together or not at all. Behaviour otherwise unchanged. Desktop main `tsc` clean; gates green. (Noted-minor from the sync audit; the window was microseconds on synchronous better-sqlite3 writes, now closed.) |
| 2026-08-15 | **A85 closed (sync push — floats no longer silently dropped) [SS1]** — the server `/push` floats section filtered incoming floats to those whose parent shift is present for the business and **silently skipped the rest** — but the till marks every float NOT in `rejected` as synced, so a float whose shift was rejected earlier in the same push (its only cause) was marked synced and lost: a vanished cash-drawer movement. The exact "silent skip → marked synced → lost" mode the shifts/days path was built to prevent, which floats never got. Fix: floats now upsert **per-row** (like shifts), and a float with an unowned/absent shift is pushed into `rejected` with `table: 'float_transactions'`, `code: 'missing_shift'` — the till already buckets that table and parks it, so the float stays put instead of vanishing. Per-row also removes the batch-upsert failure that could 4xx the whole payload (SS2 for floats). `tests/sync-float-routing.test.mjs` (8 assertions, mutation-checked). Server `tsc` clean; gates green. Expenses SS2 (batch upsert, liveness only, no loss) and the cross-tenant-409-aborts-batch edge (SS3) left as noted. |
| 2026-08-15 | **A82 closed (cost-price editor)** — the server fully supported `products.cost_price` (create, update, CSV import) but the dashboard had no way to enter it, so `cost_price` stayed null and starved the Menu Matrix (A78), gross-margin, food-cost and the COGS export. Added a **Cost** field on the product form (live margin %), a **Cost** column in the product table (flags "no cost"), a **Set costs** bulk editor, and a server `PATCH /api/products/bulk-cost/by-ids` endpoint mirroring `bulk-tax/by-ids` (business-scoped, ≤1000 rows, clears on blank, rejects negatives). Server + dashboard `tsc` clean; all gates green. UI paths not component-unit-tested (no dashboard harness). |
| 2026-08-15 | **A84 closed (kitchen exclusions — word-boundary + visibility) [print Phase 2]** — two refinements after confirming the itemized-description exclusion already works (client shows the meal name; kitchen drops sauces/drinks from the split description via the built-in rule + owner terms; dispatcher shows everything). (1) Owner-added exclusion terms now match on **word boundaries** like the built-in rule, not raw substrings — the old `includes()` over-matched, so "water" clipped "watermelon" and "ice" clipped "rice"/"spice". `kitchenPrepLines` builds a `\bterm\b` regex per term (escaped for regex-safety); a few short regexes per ticket, off the bytes-to-printer path — speed-neutral. (2) The Exclusions tab now shows the **built-in list read-only** (sauces, dips, soft drinks, sodas, drinks, juices, water, coke, fanta, sprite, krest, stoney, minute maid) so the owner can see what's already filtered and not re-add it. Also fixed the stale `noteLines` comment that claimed "prose cannot be filtered" (it can, and does). `tests/kitchen-prep-wordboundary.test.mjs` (11 assertions, mutation-checked). Renderer `tsc` clean; gates green. Dispatcher exclusions were considered and **dropped** — dispatcher shows everything for packing, and takeaway packaging is already deducted server-side via the existing `product_packaging` feature. |
| 2026-08-15 | **A83 closed (print UI — tabbed Printers, Stations restored)** — StationsPanel (create/route Kitchen/Grill/Dispatch) was orphaned when PrinterSetupScreen superseded the unrouted PrintersTab; only binding + exclusions were ported. New PrintersScreen shell puts Stations, Printers and Exclusions under one nav item; ManagerPage routes printers to it; exclusions extracted to ExclusionsPanel. Confirmed upstream regression, not a local edit. |
| 2026-08-15 | **A80 closed (sync audit — stock delta-merge)** — `pullCatalogue` overwrote `stock_levels.quantity` with the server baseline (`quantity=excluded.quantity`) under a comment calling it "reference point for delta merges" and a header promising "delta deduction, never absolute overwrite" — but **no delta merge existed**. Since `syncAll` pulls before it pushes, every reconnect reset the accumulated offline-sale deductions to the server's pre-push baseline; the till showed stale-high stock until the next pull, and indefinitely while a push kept failing. Not data loss (orders survive as pending; stock isn't a hard sell-gate) but it misled staff and locally defeated the A74 low/negative signal exactly when offline. Fix: after the baseline upsert, re-apply `Σ(order_items.quantity)` for tracked products of orders still `sync_status='pending'`, grouped by product+branch (the merge always claimed). `'pending'` includes failed-to-push orders — the push-failure branch never flips `orders.sync_status`. `tests/sync-stock-merge.test.mjs` (11 assertions, mutation-checked). Desktop main `tsc` clean. NOT bench-run on a live offline→reconnect device — wants one field pass. Minor S3 (the two sync-state UPDATEs in `pushPendingOrders` aren't wrapped in one transaction — a microsecond window on synchronous better-sqlite3 writes) noted and accepted, not changed. |
| 2026-08-15 | **A81 closed (sync audit — offline clamp)** — `createLocalOrder` deducted stock with `Math.max(0, currentQty − qty)`, flooring at 0, while the server's `adjust_product_stock` lets `quantity` go negative (A74 "sold beyond stock"). Offline, an oversell stuck at 0 locally and disagreed with the server until the next pull, and the till could never show the A74 state offline. Removed the floor so the local deduction matches the server; the A80 merge likewise doesn't floor. Covered by the same test's negative-survival assertions (mutation-checked). |
| 2026-08-15 | **A79 closed** — the web POS room-charge (guest-split) button posted via a direct `/api/orders` create with a client-minted `generateOrderNumber()` and only a `roomCharging` *state* guard, so a fast double-tap posted two room charges (two distinct numbers, so the unique constraint didn't dedupe). Added a synchronous `roomChargeRef` returned-on before any await + reset in finally (`CashierScreen`). Same shape as A76's desktop guard. Dashboard `tsc` clean. UI path — not component-unit-tested (no renderer harness). |
| 2026-08-15 | **A78 closed** — the Menu Matrix report was a `ComingSoonTab` stub while the README advertised it as working (the one undocumented gap the first audit found). Built for real: `MatrixTab` reuses `/api/reports/products-v2` (already returns qty + `gross_margin_pct` + `total_cost`) and classifies Kasavana-Smith — popularity by the 70% rule (`qty ≥ 0.70 × totalQty/N`), profitability by unit contribution margin vs the average — into Stars / Puzzles / Plowhorses / Dogs, each with the standard action. Items with no `cost_price` are set aside (they'd distort the average) with a prompt to set cost in Inventory. No new server code. Dashboard `tsc` clean. Component (like its sibling tabs) — no unit test; thresholds documented inline. |
| 2026-08-15 | **A77 closed** — the onboarding owner PIN was removed. Traced first: it is a POS-terminal login only (ring sales / unlock), NOT the dashboard login (that's Supabase email+password), and it never actually worked — onboarding hashed it with `btoa()` while the server's `verifyPin` only accepts bcrypt (`$2…`) or legacy sha256-hex, so it could never match (and would throw in `timingSafeEqual`). Removed the whole PIN step (fields, pad, `validatePin`, the `btoa` `hashPin`, `ownerPinHash` from the POST). Server already stored `pin_hash: ownerPinHash ?? null` with an `owner_pin_set` flag and the column is nullable, so no server change. An owner who genuinely operates a till sets a PIN later in Settings → `/api/auth/set-pin` (proper bcrypt). Dashboard `tsc` clean. |
| 2026-08-15 | **A76 closed (bundle: PIN lockout · double-charge · round2)** — three interaction defects the static gates can't see. (1) **PIN lockout**: `LockCurtain` and `POSLoginScreen` auto-submitted at 4 digits, truncating and rejecting every 5–6 digit PIN — a hard lockout for 6-digit managers (`POSLoginScreen` also cleared the field on the failed attempt). Both now cap at 6 and require explicit submit, matching PinPage. (2) **Double-charge**: desktop `handleCharge` guarded on `setPlacing` (state, next-render), leaving a one-frame double-tap window; added synchronous `placingRef` + try/finally, and stopped the bill-reservation catch swallowing. (3) **round2**: desktop `payment.ts` aligned to the server `Number.EPSILON` form. (Register row backfilled — the code shipped in df47203 but this line missed that commit.) Not component-unit-tested (no renderer harness); onboarding owner-PIN excluded then, done in A77. |
| 2026-08-15 | **A74 closed** — negative product stock (a legitimate state: a transfer arrives physically and is sold before it is received in the system) raised no branch-visible warning. `checkLowStock` DID fire on negatives (a negative is below any threshold) but wrote the row owner-scoped and business-wide: `branch_id` was left NULL though the column exists, and the copy did not distinguish "sold beyond stock" from merely "low". A branch manager therefore saw nothing — the dashboard never read `notifications` at all. Now: pure `lib/stockAlerts.ts` (`classifyStockLevel` splits `negative_stock` vs `low_stock`, C7 string-coercion in one tested place); the checker sets `branch_id`, emits the right type with distinct copy/subject, and dedupes per product+branch+type via a `[product|branch]` marker (mirrors the ingredient path); `GET /api/notifications` gained `branch_id` in its select plus `?branch=` and `?type=` filters; ManagerDashboard Overview fetches unread `negative_stock,low_stock` for its own branch and shows a red (sold-beyond) / amber (low) card **on load, no realtime** (owner's call). `tests/negative-stock-alerts.test.mjs` (19 assertions, mutation-checked). Server `tsc` clean. NOT bench-run against live Postgres/RLS end-to-end — the notification insert/read path wants one field pass. |
| 2026-08-15 | **A75 closed** — a stock alert never cleared itself: nothing on the receive path resolved it, so after booking the arriving transfer the red banner lingered until dismissed by hand. Added `resolveStockNotifications` (jobs/lowStockChecker.ts) + pure `shouldResolveStockAlert` (lib/stockAlerts.ts): on `applyProductStockIn` (transfer receive AND cancel-return-to-source) it marks matching unread rows read once on-hand recovers — `negative_stock` clears at ≥ 0, `low_stock` only at/above threshold, so a partial receipt clears the negative and correctly leaves the low. Non-blocking (`void …`), never fails the receipt. Covered by the same suite's resolve assertions (mutation-checked). Restock via other paths is not yet a clear-point — only the two transfer paths call `applyProductStockIn` today. |
| 2026-08-13 | **A49 closed** — the stock report read `stock_adjustments` (a dead table), so restocked/written-off were permanently zero. Repointed `GET /reports/inventory` to fold `stock_movements` (sale excluded to avoid double-counting; correction split by sign). Extracted `lib/stockMovementSummary.ts` (pure); `tests/stock-movement-summary.test.mjs` (6 assertions, mutation-checked). Stale table-usage exception removed; `stock_adjustments` now fully dead (drop candidate). Also: the A59 stations.manage leftover was already enforced additively (migration 79) — only force-close remains, deferred as it touches a desktop file. |
| 2026-08-13 | **A63 closed** — the onboarding seeder matched role names un-normalised (`nm==='branch_manager'`), so a "Branch Manager" typed with a space would be seeded with ZERO permissions (A61 one layer up). Extracted `roleTier()` to `lib/roleTier.ts` (pure, supabase-free), normalising `lower(replace(name,' ','_'))` like the migrations. `tests/role-tier.test.mjs` (12 assertions, mutation-checked). |
| 2026-08-13 | **A64 closed** — owner chose the strict manager policy (receive + see, no adjust/manage/financial; management lives on web). Seeder MANAGER_DENY is authoritative; migration 82 revokes the three keys migration 59 over-granted from manager-type roles only, owner/admin and other grants untouched. `scripts/test-migration-82.mjs` (10 checks, mutation-checked). Run the blast-radius SELECT before applying to prod. |
| 2026-08-13 | **A37 closed** — the desktop licence was bypassable by a client sending `surface: 'web'` on /pos-login. Now the exempting surface is server-derived: honoured only when the business holds web access (`getWebAccess().canLogin`), else forced to desktop and licence-checked. `tests/auth-surface.test.mjs` (11 assertions, mutation-checked). Also fixed a D11 regression this test caught — §3 pinned the pre-D11 `pos.ts` gate shape and had been silently failing. Residual: dual web+desktop subscribers (business-policy call). |
| 2026-08-13 | **A59 closed** — the till/cloud permission-vocabulary mismatch. The renderer already gates on keys (`has()`), the gates were re-pointed, and `check-permission-parity` now sees the till; the one benchable gap — proving migration 78 grants `receipt.manage` to manager/supervisor/branch_manager — is closed by `scripts/test-migration-78.mjs` (7 checks, PGlite, mutation-checked). Closed on the A66/A43 basis: model proven, only the Windows render smoke-test remains. Two cloud-side inconsistencies (unenforced `stations.manage`, force-close key) recorded for a later pass. |
| 2026-08-13 | **D9 designed, not built** — cross-till held orders. Turned the bare title into a real entry + `docs/HELD-ORDERS-CROSS-TILL-D9.md`. It is the app's worst-failure data path (open tabs), needs an owner concurrency decision (claim/handoff vs charge-lock vs view-only) and a multi-till rig to verify, so it is deliberately unbuilt and should not ride the rollout. Recommended shape: node-authoritative with an atomic claim. |
| 2026-08-13 | **A51 closed (register was stale)** — the device-token sawtooth fix (`refreshDeviceTokenIfExpiring` in `syncEngine.ts`, refresh within 120s of expiry, device-scoped, reactive 401 backstop intact) was already implemented and passing `device-token-refresh.test.mjs` (21 assertions); the entry still read "not done". Corrected to CLOSED. NOT yet field-confirmed — a build predating the fix still sawtooths, so the fix must ship. |
| 2026-08-13 | **D4 implemented end-to-end (stays OPEN; closes D1 on live test)** — issue (`routes/enrol.ts`) + redeem (`auth.ts`, atomic burn, mints the owner-scoped desktop token) endpoints; desktop `auth:enrolDevice` + `posApi.auth.redeemEnrolment` + InstallPage now takes Business ID + enrolment code instead of owner email/password. Server/renderer `tsc` clean, IPC parity 139/139, `tests/enrol-endpoints.test.mjs` (19 assertions). The end-to-end HTTP/token/install path is unrun on the bench — `docs/DEVICE-ENROLMENT-D4.md` has the live-test checklist. |
| 2026-08-13 | **D7 rollout (stays OPEN)** — shared IPC validator now adopted on `auth:verifyPin`, `order:void` and `auth:enrolDevice` (throwing `assertPayload`, valid payloads unchanged), in addition to `escpos:setKitchenExclusions`. `tests/ipc-validate.test.mjs` up to 25 assertions (mutation-checked). `order:create` left unvalidated on purpose — the sale path needs a schema written against `createLocalOrder` and a live test, not a blind guard. ~132 channels remain. |
| 2026-08-13 | **A67 closed** — `check-register-consistency` read OPEN/CLOSED from the whole heading, so D11's "fails closed" title counted as CLOSED. Now matches a status label at the start of a leading field, via a pure `scripts/lib/register-status.mjs`; `tests/register-status-parse.test.mjs` (12 assertions). |
| 2026-08-13 | **D7 advanced (stays OPEN)** — added a shared, dependency-free IPC payload validator (`apps/desktop/src/main/ipcValidate.ts`: `validatePayload`/`assertPayload`/`expectStringArray`) — the desktop had none and no zod. Reference adoption on `escpos:setKitchenExclusions` (malformed → clean reject, not a silent coerce-to-empty). `tests/ipc-validate.test.mjs` (21 assertions). ~135 channels still to adopt; rollout is per-channel. |
| 2026-08-13 | **D3 advanced (stays OPEN)** — added an auto-update scaffold (`apps/desktop/src/main/autoUpdate.ts`, electron-updater, dev-guarded, installs on quit) + `docs/DESKTOP-AUTOUPDATE.md` runbook. Not bench-verifiable (no Electron/feed): needs the dep, wiring, a publish target, code-signing and a CI release — which is what actually closes A1. |
| 2026-08-13 | **D4 advanced (stays OPEN; closes D1 when finished)** — `migrations/81_device_enrolment_codes.sql`: single-use, business-scoped, expiring enrolment codes so a till provisions without an owner login. Proven against real Postgres — `scripts/test-migration-81.mjs` (13 checks, mutation-checked on the atomic burn); `schema-index.json` updated. Endpoints + desktop InstallPage are a reviewed proposal in `docs/DEVICE-ENROLMENT-D4.md`, held back because the token path can't be bench-verified. |
| 2026-08-13 | **D11 closed** — `/api/pos/init` gated the desktop licence on the `is_main` branch, so a till bound to branch B was licensed by branch A's flag; and `.single()` on the main branch 500'd the whole pull when a business had zero main branches (which the schema permits). Now resolves `boundBranch ?? mainBranch` in the parallel fetch, gates on that, reuses it for pricing, and uses `maybeSingle` so zero main branches is a clean 403 not a 500. `tests/pos-init-desktop-licence.test.mjs` (14 assertions, mutation-checked). Noticed in passing: the old title "fails closed" made `check-register-consistency` read D11 as CLOSED while it was open — title reworded; parser fixed under A67. |
| 2026-08-13 | **A66 opened and closed** — kitchen exclusions never persisted on the till: `saveDeviceConfig` omitted `kitchen_exclusions` from its INSERT/VALUES/SET, so the synced cloud list vanished and the printer applied nothing (invisible to `check-sql-binds` — the statement was balanced, it just never named the column). Fixed, and a per-terminal `kitchen_exclusions_override` added (`LOCAL_SCHEMA_VERSION` 52) so a till can own its list and keep it through every sync — "local is final". Proven by running the real INSERT under `node:sqlite` (`tests/kitchen-exclusions-local.test.mjs`, 17 assertions, mutation-checked). Windows render check outstanding (A43's limit). Two findings recorded: cloud lists are business-wide by design; a `deploy_mode:'local'` till is still not provisionable. |
| 2026-08-11 (f) | **A62 opened and closed** — migration 76 failed in the field with 42P01 on `role_permissions`. One unqualified table name in an otherwise fully-qualified file, shipped by this session. All of 75/76/77 qualified and re-verified under `search_path = ''`; `check-schema-drift` gained check D, ratcheted at 22, mutation-checked against the real bug. |
| 2026-08-11 (e) | **A55 closed** — `total_spent` was the last racy read-modify-write on the customer row, in three places, while loyalty_points and visit_count on the SAME row had been atomic since migration 53. Migration 77 adds `increment_customer_spend` and `adjust_customer_visits`; the void path now makes three RPC calls instead of one racy statement. Proven by RUNNING the race under PGlite: the old shape banks 100+250 and records 250. |
| 2026-08-11 (e) | **A60 closed** — `check-register-consistency`. Ten IDs had two headings (A4 A9 A25 A45 A46 A47 A50 A57 A58 D8 D14), several contradictory; the header claimed 0 P0 while A17 sat OPEN at P0. **Three duplicates were created by this session**, hours after it criticised the same failure. All merged; header re-derived from the body. |
| 2026-08-11 (e) | **A61 closed** — a bug THIS SESSION shipped in migration 75: grants matched `branch_manager` but not `Branch Manager`, so a business that typed the name with a space got nothing, silently. Migrations 24 and 49 carry the same blind spot since 2026-07. Fixed at source; migration 76 backfills only the rows the bug skipped. |
| 2026-08-11 (e) | **A7 closed** — README claimed `parking -> ParkingPOS` / `petrol_station -> PetrolPOS`; both are imported nowhere. Corrected to the live `CashierScreen` path, plus an accuracy note recording what the README still does not cover. |
| 2026-08-11 (e) | **A53 ratcheted** — 21 orphan audit-ID citations may shrink, never grow. The recorded fix was a policy nothing enforced. |
| 2026-08-11 (e) | **`check-schema-drift` gained a self-clearing pending declaration.** Migration 77 is written but not run, which the gate correctly called drift — leaving CI red on a correct commit. `schema-index.json` was NOT refreshed to hide it (that would claim production has functions it does not — the A49 shape). Instead `scripts/schema-pending.json` declares the window and FAILS once the functions appear live, so it cannot become a silencer. |
| 2026-08-11 | **A45 closed cloud-side.** `POST /business/settings` takes `receipt.manage` or `settings.manage` and narrows per key: without full settings access, only `receipt_header` / `receipt_footer` are writable. Allow-list, not deny-list; runs before the bcrypt and encrypted-credential branches. 21 assertions against the real compiled middleware. **Remaining step is yours: grant `receipt.manage` to Manager in the Roles screen.** No desktop change needed. |
| 2026-08-11 | **A59 opened (P1)** — the till has NO permission-key plumbing; every gate there is a role test, while the cloud enforces 17 keys. Not two gates disagreeing, two vocabularies. `check-permission-parity` scans the renderer and finds zero keys, so every till gate is invisible to the comparator meant to catch this. A45 was one symptom of it; 14 tabs share the shape. |
| 2026-08-11 | **Known limit of check-permission-parity, recorded not hidden:** it reads MIGRATIONS, not the live database. A key granted through the Roles UI — which is how `receipt.manage` will be granted — does not move its `ungated` count. The ratchet catches drift introduced in the repo; it cannot see grants made in production. |
| 2026-08-11 | **A46 partly closed** — `requireAnyPermission` built; 13 of 16 `settings.manage` routes split onto `devices.approve` / `tables.manage` / `etims.manage`, additively, so no existing role loses access. Three routes deliberately left: `receipt.manage` is a PER-KEY check inside a handler that also writes PIN hashes and M-Pesa secrets (A45's real fix, own batch); `shifts.force_close` needs a desktop file (rules 9, 15); `flags` correctly keeps the retained key. |
| 2026-08-11 | **A57 closed** — migration 75 registers all twelve keys. Idempotent, proven under PGlite (11 assertions), including that a row pre-existing with production's label keeps it. **Correction: the `-b` manifest said this needed the production query first. It did not — ON CONFLICT DO NOTHING makes it safe either way, and migrations 24 and 49 had already set that pattern.** |
| 2026-08-11 | **A58 fix shipped, confirmation wanted** — `orders.view_all` and `inventory.view` registered and granted to manager-level roles, restoring Orders, Turnover and Inventory. Isolated in its own migration block with a revert line, because Turnover shows branch revenue and that is the owner's call. |
| 2026-08-11 | **check-permission-parity revised.** `ungated` now ratchets only on keys GRANTED to some role — a key nobody can hold is owner-only and no screen can gate on it (FleetPage is read-only; devices' four write routes have no UI at all). Raw figure still printed. **Scrutinise this: it was changed while adding keys it then exempted.** Also gained a self-check after mutation showed the scanner could go blind to `requireAnyPermission` and still exit 0 — twice, because the first self-check compared the pattern against itself. |
| 2026-08-11 | **A56 built and CLOSED** — `check-permission-parity`, the comparator A45 asks for and A46 is blocked on. Compares THREE surfaces (cloud `requirePermission`, migration seeds, UI gates), not the two A45 names. Ratcheted on `typecheck-ratchet`'s semantics because the ground is not green (6/6/2) and a day-one-red gate gets switched off. Three defects in my own gate caught first: it walked never-run archive migrations, it assumed zero phantom keys, and its first mutation used an alias the scanner rightly ignores. |
| 2026-08-11 | **A57 opened (P1)** — 6 enforced keys have no `permissions` seed in any migration; `requirePermission` fails closed and `role_permissions` has an FK, so ~62 routes are owner-only on ANY database built from this repo. Not necessarily broken in production — one SQL query settles it, and it is in the entry. Fix deferred INTO A46 so the keys are seeded once, not twice. |
| 2026-08-11 | **A58 opened (P1)** — Orders, Turnover and Inventory nav items gate on `orders.view_all` / `inventory.view`, which the cloud never enforces and no migration defines. `hasPermission` can only ever return false for a non-owner, so three manager tabs are invisible with no error. A45 inverted. |
| 2026-08-11 | **A54 opened.** Mail still undelivered in production. A50's pin WORKED (74.125.195.108 is IPv4); the timeout survived it, falsifying "not two problems; one" in `mailer.ts` and the test header. Second cause is a filtered port, not DNS — `render.yaml` says `plan: starter`, the running instance is dashboard-managed and unverified. Shipped: failure classification by cause, alternate-port probe (diagnostic only), corrected comment. Blocked on the owner for the instance type and a Gmail App Password. **Delivery-level reporting NOT built (rule 12) — recorded as the remaining gap.** |
| 2026-08-11 | **A1 STRUCK** — owner confirms `SUPABASE_SERVICE_ROLE_KEY` was rotated long ago. The packaging half was already closed with two CI gates behind it; the rotation half was the only thing outstanding. Entry retained below per the never-reuse-IDs rule. |
| 2026-08-11 | Header count corrected: **0 P0 → 1 P0**. §A listed A17 as `P0 · OPEN` while the header claimed none. Same failure the preamble names — a header disagreeing with its own body — on the count that decides sequencing. |
| 2026-08-10 | **A5 closed** — `PHASE2-3-DESIGN.md` said "For approval before code" a week after Phase 2a/2b/2c and Phase 4 shipped; `ROADMAP.md` (2026-07-10) mentions none of it. Both now carry status headers naming the code as authority. Not rewritten: restating a month of decisions as a fresh plan would be inventing intent. |
| 2026-08-10 | **D6 closed** — `docs/LOCAL-SCHEMA-VERSIONS.md`. Local schema is additive and idempotent, not a numbered ladder; the version labels a shape. **48 and 50 never existed** — the constant jumped 47→49→51, the same shape as the server's SKIPPED 31/32 and never-existed 64. |
| 2026-08-10 | **A9 triage closed** — 3 critical and 16 of 18 high are devDependencies (electron-builder / node-gyp chain); the Electron CVE is macOS-only and every till is win32; the only prod vulns are `uuid`/`exceljs`, and the advisory covers v3/v5/v6 with a buffer while every call here is `v4` with none. **Shipped surface: none.** Server has real but lower items fixed by a plain `npm audit fix`. |
| 2026-08-10 | **A43 step 1 done** — the picker protection now exists on `PrinterSetupScreen`, the screen that is actually rendered, in the general form of the bug. Step 2 (§5 exclusions) still blocks the deletion. |
| 2026-08-10 | **A52**: idle lock built. OS idle via powerMonitor, so it cannot fire mid-sale by construction. Manager 5 min, POS 10. A curtain over mounted state — never clears the cart or the session; unlock is the PIN pad (A17) and only for the locked staff member. 27 tests, 3 mutation checks. |
| 2026-08-10 | **A53**: 20 audit IDs cited in code with no entry anywhere. The B/C/E/F/G/H sections went in the 08-08 restructure and were never in the first commit, so they are unrecoverable — a previous note suggesting recovery from `415e044` was wrong, that commit is not in this history. `docs/AUDIT-ID-INDEX.md` indexes all 20 with call sites. |
| 2026-08-10 | **A6 closed** — the 3-Aug handoff recovered from `0f85155:HANDOFF.md` (383 lines) and filed at `docs/history/handoffs/HANDOFF-2026-08-03.md`. |
| 2026-08-10 | **A51 fixed** — proactive device-token refresh, scoped so it cannot touch the staff token and mask A47's field test. An assertion fails if anyone later widens it. 21 tests, 4 mutation checks. |
| 2026-08-10 | **A50**: daily summaries never delivered — nine businesses, every run, both observed days. SMTP fallback died as ENETUNREACH on Google's IPv6. Not an unverified Resend domain (`RESEND_API_KEY` was absent) and not unreal test addresses (ENETUNREACH is pre-`RCPT TO`; Beryl failed identically). Fixed with `family: 4` plus a boot `verify()` so a dead mail path announces itself. |
| 2026-08-10 | **A51**: the device token sawtooths — 10-minute pull against a 15-minute token means every other catalogue pull 401s by construction. ~72 refresh rotations/day and a till log that can no longer show a real auth failure. Held out of 0.5.28 so it cannot mask A47's idle test. |
| 2026-08-10 | **A47**: `manageFetch` served 35 manager handlers with no 401 branch while `ownerFetch` in the same file always had one. Staff access token 15m, refresh 30d — so idling produced "This till was signed out" on a signed-in till. Field report. Gate `check-auth-retry` built and in CI; it found `refreshTechConfig` on its first run. |
| 2026-08-10 | **A48**: the receipt closing block (thank-you, TAX RECEIPT) lived only in the HTML receipt and went with it in 0.5.27. Restored in `render.ts`, tax line gated on VAT. Also: `SAMPLE-OUTPUT.txt` is NOT regenerated by `npm test`, contrary to §I. |
| 2026-08-10 | **A49**: `stock_adjustments` is read by the stock report and written nowhere, so restocked/written-off are permanently zero. `check-table-usage` was silenced on it by an exception that had never been true. Exceptions file now warns that its reasons are unchecked prose. |
| 2026-08-10 | **A43 stays OPEN** — deletion attempted, `test-print-resilience` went red (ENOENT, 4 reads). Its §4 pins a real field bug (PrinterPicker remount = dropdown snaps shut) and `PrinterSetupScreen.tsx:270` has an unguarded `<select>` of its own, so deleting drops the ONLY guard on the screen that is now live. §5 asserts exclusions are edited on a tab nobody can open. Reverted per rules 12 and 20; sequence recorded. |
| 2026-08-10 | Register reconciled against the tree. A9 closed (dirs were never empty; ID collision with the npm-audit A9 recorded). A10 REOPENED — only 1 of its 4 claimed supersessions happened; `PrinterSettingsModal` is still live in `POSPage`. A12 raised P3 → **P1**, it is live. A7 re-characterised: parking/petrol ship inside `CashierScreen`; the two files are unwired upgrades carrying their own integration instructions. A1 split — packaging closed, key rotation still unconfirmed. A39 down to one missing document. A4 (22/68) and A46 (30 routes) refreshed. |
| 2026-08-07 | Opened. A1, B1-B5, C1-C6, D1-D3, E1-E4, F, G1-G2, H1-H2, I. |
| 2026-08-07 | Live schema dump reviewed. Added B6, C7-C9, §0 dump caveat. BUG-19 upgraded and sized. |
| 2026-08-08 | G1-G7 shipped. 31 items closed. Printing migrated to ESC/POS end to end (P-01…P-19). Two new gates. Register restructured: open items first, closed items retained as evidence. |
| 2026-08-08 | Desktop audit (D1-D15) and Beryl sync investigation. Migration ledger reconciled against production (§M). Migration 46 applied. D12 and A1 packaging closed. Header counts and commit corrected. |
| 2026-08-10 | A45: the Receipt tab is shown on `isManagerRole` while the server demands `settings.manage` — a UI gate and a server gate disagreeing. A46: that one permission covers 16 routes from receipt text to eTIMS registration and till revocation; owner asked for a fine-grained split, proposed with seven keys. |
| 2026-08-10 | A42: the thermal toggle's OFF label reassured while nothing would print — corrected. A43: 0.5.27's exclusions box went onto PrintersTab, which is superseded and unrendered; deferred to PHASE6 as per-station. A44: station creation already exists on the dashboard. |
| 2026-08-10 | 0.5.26 built and installed. 0.5.27: HTML SALE path removed after thermal proved itself; D8 closed by reporting skipped stations rather than routing around them; escpos_enabled defaults ON with a guarded backfill; localStorage exclusion list retired. Shift reports and calibration deliberately kept. |
| 2026-08-10 | A40: DESKTOP_DESIGN.md confirmed lost; stub records what the citations preserve and where it lives, nothing reconstructed. A41: check-header-keys and check-test-registration added to CI — both caught defects in their own first versions. |
| 2026-08-10 | **A39**: BRANCH_AUTHORITY_AND_SYNC_DESIGN.md — cited by section in six source files, absent from the repo. Now in docs/. It already specifies A19, A24, PHASE5 §4 and PHASE6; status line reads "agreed design, not yet implemented". |
| 2026-08-10 | Rule 21 (node vs cloud vocabulary). PHASE6 designed: branch-local settings owned by the node, cloud-backed, manager-editable offline — the first payload for A24's downstream channel. |
| 2026-08-10 | **A38**: the till sent X-Device-Id twice; every server reader got a comma-joined, truncated value. Third independent cause of the empty fleet, alongside D14's opt-in flag and A36's surface. Normalised server-side so old and new builds resolve the same terminal key. |
| 2026-08-10 | **A36 (P0)**: `/desktop-login` minted `surface: 'web'` while its own header said `'desktop'`. Four features silently dead on every till — offline sign-in (D16) never worked in the field, device registration never ran, the licence gate never fired, requireWebSurface bypassed. One word. A37 opened. |
| 2026-08-10 | D14 measured in production: **0 registered devices across all 10 businesses**, and one `require_device_registration` row anywhere (Lovers Rock, false). Registration has never run for any tenant; deviceBinding.ts, devices.ts, migration 43 telemetry and migration 52 binding have all been dead code in production. |
| 2026-08-10 | CI #44 (PR dev→main): secret scan 403 — no permissions block, so gitleaks could not read PR commits and scanned nothing. Passing on push for 40+ runs, never exercised on the event that gates main. Fixed; .env check moved first so one fault cannot skip both gates. |
| 2026-08-10 | CI #42: desktop-scope red — the three desktop suites import dist/main and the job never built it. Build + the two installs added, verified from a clean checkout. Other five jobs green, including all 7 migration files. |
| 2026-08-10 | A32: six migration tests existed and none ran; test-migration-47 had never worked (hardcoded sandbox path, 19 dead assertions). Runner added, all 7 in CI. A33: Windows path bug in my harness. |
| 2026-08-10 | Target run: 92 desktop tests green under real Electron ABI. A31 found — failover-cursors was never wired into test:desktop, A16 repeated in the batch that closed A16. A9 measured: 23/3-critical is desktop, server is 6/0. |
| 2026-08-10 | Migration 74 failed on the owner's database (42P16). Fixed, plus a second idempotency bug only execution found. Migrations now run against real Postgres (PGlite) in CI — 17 tests. A30 closed. |
| 2026-08-10 | D4: migration 74 makes a claimed role verifiable — TOFU per branch, recorded conflicts, one-hour handover window, unique index. A25 closed; A22 partly closed. A29 found: --merge-migrations resurrects renamed columns and weakens the audit. |
| 2026-08-10 | Office role (view-only node) brought into scope. PHASE5 §4b corrected from `=== 'node'` to `isNodeRole()`. Migration 73 adds device_role; till reports it; registry stores and labels it. A27, A28 closed. A4 measured: 20/66. A25 still open — a role can now be seen, not verified. |
| 2026-08-10 | Rule 17 sweep on D14. Cause found at `auth.ts:432` — an opt-in flag, not a missing upsert; far more was built than credited. D14 and A26 closed; approval and registration separated. A25 still open by design. |
| 2026-08-09 | Owner's correction upheld: most of the architecture is built. A24 opened as the unifying finding — the node has no downstream distribution. PHASE5 §11 rewrites the delta; `branch_staff` dropped in favour of columns on the existing `users` table. |
| 2026-08-09 | Failover clarified: data replicates to all tills, a peer can be promoted. Promotion machinery confirmed present and sound. A20-A23 opened against the gaps; PHASE5 gains §10. |
| 2026-08-09 | Owner's design clarification: node is branch source of truth, sole cloud uplink, may stay offline forever and may authorise. A17/A19 resolved to a design; `PHASE5-NODE-AUTHORITY.md` written for approval. Reverses D16's override-PIN decision (§5) and makes D4/D14 prerequisites (§7). |
| 2026-08-09 | Batch 1 (server). A14 Beryl root cause found and fixed, A15 error classification, A16 CI gap, A2 closed. Beryl post-commit hypothesis ruled out by idempotency deduction. 17 new tests, mutation-checked. |
| 2026-08-08 (eve) | D2, D12, D13 (client half), D16 offline sign-in, A1 packaging closed. Migration 46 applied. 78 desktop tests added, green on Windows/Node 20 with SQLite suites on the real Electron ABI. Working rules moved into the handoff §0. |
