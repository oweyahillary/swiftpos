# Close-out checklist — items awaiting test (2026-09-14)

Verify-and-close session. **No code.** Work top to bottom; tick each box, write what
ran + what it showed on the evidence line. A pass → I move it FIX BUILT → CLOSED in
`docs/AUDIT-REGISTER.md` (docs-only, rule 18). A fail → it stays FIX BUILT with the
failure recorded. The detailed step-by-step for A273/A274/A275 lives in
`docs/VERIFY-SHIFT-DAY-PARITY.md` — use it alongside Group A/C for those four.

---

## 0. Precondition — CI must be green first (gates everything)

- [ ] **[CI]** Typecheck ratchet — server `tsc` **and** dashboard `tsc`. PASS: no new errors above baseline.
- [ ] **[CI]** `run-migration-tests` incl. `test-migration-102`. PASS: all green.
- [ ] **[CI]** Full test suite / offline suites. PASS: all green.

> If any of these is red, that is the ONE thing that forces a fix before hardware testing. Stop and send me the output.

---

## Group A — single till + cloud + web (no special setup)

- [ ] **A274 · P1** — Web POS could ring a sale with `shift_id:null` — no hard shift gate, and a failed /current check was swallowed
  - **Close when:** on-screen behaviour (Charge disabled with no shift; opening one enables it; the sale carries the shift id) + dashboard tsc (esbuild build has no type-check — the A265 class).
  - **Evidence:** _____________________  **Result:** pass / fail

- [ ] **A265 · P1** — Charge crashed the web POS — receiptHeader was referenced but never declared
  - **Close when:** a live Charge on the till. A-P1 19→20. Web-only.
  - **Evidence:** _____________________  **Result:** pass / fail

- [ ] **A266 · P1** — After payment the receipt was a blank white box and did not auto-print
  - **Close when:** a live Charge → auto-print + a non-blank preview on the till. Web-only. A-P1 20→21.
  - **Evidence:** _____________________  **Result:** pass / fail

- [ ] **A267 · P1** — Every POS api call 401'd after the access token expired — the ROOT of the "business null" saga
  - **Close when:** a live session past the access-token TTL on the till (the definitive check — no 401s after ~expiry). Web-only. A-P1 21→22.
  - **Evidence:** _____________________  **Result:** pass / fail

- [ ] **A273 · P1** — Web POS had no per-register identity — all web sales in a branch shared one `web:<branch>` drawer and could no
  - **Close when:** live two-surface behaviour (till + web-as-that-till share one drawer; a web sale carries the till's device_id; the offline till → web → till-returns re-sync path), and server + dashboard tsc (no node_modules on the bench — run the ratchet on push).
  - **Evidence:** _____________________  **Result:** pass / fail

- [ ] **A275 · P1** — No remote day close — an off-site manager could not close a branch's trading day
  - **Close when:** the whole live loop — manager queues → till pulls on cloud sync → closes locally with correct expected/variance → acks → manager sees it; date-mismatch refusal; idempotent re-run after an ack drop; and server + dashboard tsc + a PGlite migration test on CI (no node_modules/Postgres on the bench).
  - **Evidence:** _____________________  **Result:** pass / fail

- [ ] **A264 · P2** — Web POS cart converges on the desktop's shared core (order type + Send to Kitchen)
  - **Close when:** the live cart on the till.
  - **Evidence:** _____________________  **Result:** pass / fail

- [ ] **A259 · P2** — Reports showed "Unknown" cashier and "No shifts" despite a running shift
  - **Close when:** needs the live report; if it persists, the orders created_at falls outside every shift window (diagnostic query provided to the owner). **A259d 2026-09-07 — ACTUAL FIX (owner ran the query; data was fine all along).** The orders carry a valid cashier_id (Eugene) that resolves in users; the server /staff response even c
  - **Evidence:** _____________________  **Result:** pass / fail

- [ ] **A260 · P2** — Printed documents show "SwiftPOS" instead of the client's business name
  - **Close when:** a GRN/delivery print on the manager surface.
  - **Evidence:** _____________________  **Result:** pass / fail

- [ ] **A262 · P3** — No shift report under Shifts
  - **Close when:** a physical print on the till.
  - **Evidence:** _____________________  **Result:** pass / fail

- [ ] **A257 · P3** — Validation errors showed "Validation failed" with no field; category placeholder was petrol-specific
  - **Close when:** the message on a real rejected save in the UI. Rollback: revert.
  - **Evidence:** _____________________  **Result:** pass / fail

- [ ] **A256 · P2** — New default permissions never reach roles created before they existed (backfill)
  - **Close when:** the preview on the live DB + apply. Immediate single- business path for B Fastfoods: Settings → Roles → owner role → enable "manage ingredients".
  - **Evidence:** _____________________  **Result:** pass / fail

- [ ] **A179 · P1** — Till-created expenses never sync (non-UUID id 500s the whole cash batch) — FIX BUILT + SELF-HEAL
  - **Close when:** pending that never move," found from the till's own `swiftpos.
  - **Evidence:** _____________________  **Result:** pass / fail

- [ ] **A157 · P2** — Input-validation schemas written but never wired — `LoginSchema`, `CreateProductSchema`, `UpdateProductSchema`
  - **Close when:** a live login + product create/update on prod (auth/money path) before close. The staff/expenses/branches/discounts/shifts schemas were wired in an earlier pass.
  - **Evidence:** _____________________  **Result:** pass / fail

- [ ] **A141 · P2** — No bulk ingredient import (must seed opening stock)
  - **Close when:** the `adjust_ingredient_stock` RPC + stock write (needs a live DB, rule 16) — live-test a small import and confirm the ingredients appear and opening stock lands in the chosen branch with an 'opening' movement.
  - **Evidence:** _____________________  **Result:** pass / fail

- [ ] **A129 · P1** — Delivery sales silently never sync — cloud `orders.order_type` dropped `delivery` (A128's twin)
  - **Close when:** See the entry's "NOT verified / close condition" in docs/AUDIT-REGISTER.md.
  - **Evidence:** _____________________  **Result:** pass / fail

- [ ] **A139 · P3** — Per-branch (franchise) receipt text + hours overriding the business default
  - **Close when:** See the entry's "NOT verified / close condition" in docs/AUDIT-REGISTER.md.
  - **Evidence:** _____________________  **Result:** pass / fail

- [ ] **A182 · P2** — MAC-binding so a reinstalled till keeps its name/terminal code (the ROOT of A181's collisions) + session-resto
  - **Close when:** See the entry's "NOT verified / close condition" in docs/AUDIT-REGISTER.md.
  - **Evidence:** _____________________  **Result:** pass / fail

- [ ] **A168 · P2** — Order-push 401 refreshed the wrong token for an offline shift
  - **Close when:** See the entry's "NOT verified / close condition" in docs/AUDIT-REGISTER.md.
  - **Evidence:** _____________________  **Result:** pass / fail

- [ ] **A234 · P3** — Doc-spec builders duplicated across four files (drift risk)
  - **Close when:** See the entry's "NOT verified / close condition" in docs/AUDIT-REGISTER.md.
  - **Evidence:** _____________________  **Result:** pass / fail

- [ ] **A258 · P3** — Overview wasted space — Top Items + Payment Methods now side by side
  - **Close when:** the rendered page.
  - **Evidence:** _____________________  **Result:** pass / fail

- [ ] **D18 · P2** — A tech token pasted into the reveal field is truncated — "not allowing the full string"
  - **Close when:** paste the token on the amber build and confirm it lands on the token step with the full value.
  - **Evidence:** _____________________  **Result:** pass / fail


## Group B — printing (needs the print-bridge .exe installed + a real printer)

- [ ] **A209 · P2** — Web receipts print in a different format from the desktop (no shared render)
  - **Close when:** See the entry's "NOT verified / close condition" in docs/AUDIT-REGISTER.md.
  - **Evidence:** _____________________  **Result:** pass / fail

- [ ] **A235 · P2** — Web silent receipt printing never worked (dashboard↔bridge contract mismatch)
  - **Close when:** See the entry's "NOT verified / close condition" in docs/AUDIT-REGISTER.md.
  - **Evidence:** _____________________  **Result:** pass / fail

- [ ] **A236 · P2** — Print bridge can't be built to an .exe (and its require paths were broken)
  - **Close when:** See the entry's "NOT verified / close condition" in docs/AUDIT-REGISTER.md.
  - **Evidence:** _____________________  **Result:** pass / fail

- [ ] **A239 · P2** — Silent printing needs a small installer + actually-matching contracts (57 MB bridge, dashboard↔bridge mismatch
  - **Close when:** See the entry's "NOT verified / close condition" in docs/AUDIT-REGISTER.md.
  - **Evidence:** _____________________  **Result:** pass / fail

- [ ] **A240 · P1** — Print bridge was DNS-rebinding-exploitable + leaked printer names (loopback + token were not enough)
  - **Close when:** ** the Windows spooler RAW path on real hardware; the owner must rebuild + ship the `.exe` together with this dashboard (token-on- `/printers` is a paired change — an old dashboard would 401 on enumeration).
  - **Evidence:** _____________________  **Result:** pass / fail

- [ ] **A241 · P2** — Dashboard read VITE_PRINT_SERVER_URL despite the register claiming "hard-coded, no Vercel env" — a silent-misr
  - **Close when:** See the entry's "NOT verified / close condition" in docs/AUDIT-REGISTER.md.
  - **Evidence:** _____________________  **Result:** pass / fail

- [ ] **A243 · P3** — Retire the dead A209/A235 print path + sweep printToQZ; honour copies; fix modifier receipt field
  - **Close when:** See the entry's "NOT verified / close condition" in docs/AUDIT-REGISTER.md.
  - **Evidence:** _____________________  **Result:** pass / fail

- [ ] **A245 · P2** — Kill the pairing-token copy-paste — trust the dashboard origin, and survive Chrome's Local Network Access
  - **Close when:** ** real thermal print; the one-time Chrome LNA permission prompt on a real till; full dashboard tsc/vite (no node_modules — transpile-checked). Sits on top of A240–A243 (ship together).
  - **Evidence:** _____________________  **Result:** pass / fail

- [ ] **A249 · P2** — Print parity Phase 2 — routing logic extracted to shared/ (one copy, DB-free), characterization-tested
  - **Close when:** See the entry's "NOT verified / close condition" in docs/AUDIT-REGISTER.md.
  - **Evidence:** _____________________  **Result:** pass / fail

- [ ] **A251 · P3** — Print parity Phase 2b — desktop adopts the shared routing module (duplicate copy removed)
  - **Close when:** ** the desktop `tsc -b` (CI runs it on push — the `@swiftpos/printing` dist rebuilds via the `tsconfig.main.json` project reference) and the runtime print on hardware. **Release gate applies:** a till build carrying any routing change must trade a full shift on the **dev flavour** across two tills before production — a
  - **Evidence:** _____________________  **Result:** pass / fail


## Group C — two-till LAN / node / offline / failover (needs ≥2 machines, one as node)

- [ ] **A160 · P1** — Offline peers can't refresh their session without the cloud — node now brokers the refresh (Phase a+b built)
  - **Close when:** pending on-till verification (rule 16).
  - **Evidence:** _____________________  **Result:** pass / fail

- [ ] **A161 · P1** — Node serves no reference data downstream — the A24 snapshot channel (node-serve half built)
  - **Close when:** See the entry's "NOT verified / close condition" in docs/AUDIT-REGISTER.md.
  - **Evidence:** _____________________  **Result:** pass / fail

- [ ] **A162 · P1** — Node now forwards peer sales to the cloud — the A19 relay (node-side half built)
  - **Close when:** See the entry's "NOT verified / close condition" in docs/AUDIT-REGISTER.md.
  - **Evidence:** _____________________  **Result:** pass / fail

- [ ] **A163 · P1** — Node now replicates the staff roster to peers — the A20 failover channel (built on bench)
  - **Close when:** See the entry's "NOT verified / close condition" in docs/AUDIT-REGISTER.md.
  - **Evidence:** _____________________  **Result:** pass / fail

- [ ] **A164 · P1** — Till runs as the owner and bypasses the write-guard — the cloud device-grant (Phase 1, server half built)
  - **Close when:** pending terminal is refused) / `buildDeviceTokenPayload` (the `isOwner:false`, branch-bound claims).
  - **Evidence:** _____________________  **Result:** pass / fail

- [ ] **A19 · P1** — A permanently-offline peer's sales never reach the cloud
  - **Close when:** See the entry's "NOT verified / close condition" in docs/AUDIT-REGISTER.md.
  - **Evidence:** _____________________  **Result:** pass / fail

- [ ] **A20 · P1** — Failover cannot open the shop — the staff roster does not replicate
  - **Close when:** See the entry's "NOT verified / close condition" in docs/AUDIT-REGISTER.md.
  - **Evidence:** _____________________  **Result:** pass / fail

- [ ] **A24 · P1** — Reference data goes permanently stale on an offline peer
  - **Close when:** See the entry's "NOT verified / close condition" in docs/AUDIT-REGISTER.md.
  - **Evidence:** _____________________  **Result:** pass / fail

- [ ] **A22 · P2** — Promotion had no split-brain check — now guarded on promote + surfaced in the fleet
  - **Close when:** the live two-node scenario (promote-while-up refusal on a real till; a reconnected old node lighting the fleet badge) + server/dashboard tsc.
  - **Evidence:** _____________________  **Result:** pass / fail

- [ ] **D9 · P3** — Held orders are not visible across tills
  - **Close when:** See the entry's "NOT verified / close condition" in docs/AUDIT-REGISTER.md.
  - **Evidence:** _____________________  **Result:** pass / fail


## Group D — release / provisioning (needs a Windows build + a v* tag push)

- [ ] **D3 · P1** — No auto-update — scaffold added, release pipeline outstanding
  - **Close when:** ** the end-to-end loop on a real Windows till — push a `v*` tag, install the published prod build, bump+tag again, confirm the running till downloads and installs on next quit. Owner-only remaining bits: optionally add a signing cert; cut the first release. **ROLLOUT (rule 13):** unsigned first installs need a one-time
  - **Evidence:** _____________________  **Result:** pass / fail

- [ ] **D4 · P1** — Owner portal credential used to provision the till — implemented, pending live verification
  - **Close when:** See the entry's "NOT verified / close condition" in docs/AUDIT-REGISTER.md.
  - **Evidence:** _____________________  **Result:** pass / fail


## Group E — owner action, no till (≈5 min)

- [ ] **A54 · P1** — Mail still undelivered — and A50's recorded diagnosis was wrong
  - **Close when:** Remaining is OWNER ACTION, not code: set `RESEND_API_KEY` + `NOTIFY_FROM_EMAIL` (verified domain) on the server;** then A146's "Send test email" button confirms delivery.
  - **Evidence:** _____________________  **Result:** pass / fail


## Group F — needs a decision, not just a test

- [ ] **A159 · P2** — A stolen till token could write dashboard data — device-surface write guard (dry-run shipped, enforce pending)
  - **Close when:** pending enforce + verification.
  - **Evidence:** _____________________  **Result:** pass / fail

---

## Closing them out

As each passes, tell me the id + one line of evidence and I'll edit the register
(FIX BUILT → CLOSED with your note), then re-run `check-register-consistency` so the
Open counts stay honest. That recording is not development.

**Realistic scope:** Group A + E + the CI-verifiable items are very doable in a day.
Groups B (printer), C (two machines + LAN), and D (tag push) only close if that gear
is set up — don't let them block the Group A wins.

_Total items awaiting test in this checklist: 46._
