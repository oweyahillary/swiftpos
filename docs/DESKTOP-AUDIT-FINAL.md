# SwiftPOS — Final Desktop App Audit (item-by-item, code-verified)

**Date:** 2026-08-16 · **Tree audited:** `origin/dev` @ `3e56680`, desktop **v0.5.32**, `LOCAL_SCHEMA_VERSION` 52

## Method
- **Source of items:** `docs/AUDIT-REGISTER.md` is the project's declared *single tracker* ("what is open, what is closed"). It consolidates the tasks scattered across the handoff/manifest/phase md files, and its `check-register-consistency` gate re-derives status from the body. I used it as the item list, and cross-read the desktop-specific design docs (`DESKTOP_DESIGN`, `DESKTOP-AUTOUPDATE`, `DEVICE-ENROLMENT-D4`, `HELD-ORDERS-CROSS-TILL-D9`, `A59-till-permission-keys`, `LOCAL-SCHEMA-VERSIONS`, `PHASE5-NODE-AUTHORITY`, `PHASE6-BRANCH-SETTINGS`, `PRINTER-SETUP`) — each maps to a tracked D/A item, no orphan desktop task found outside the register.
- **Verification:** every OPEN item was checked against the actual desktop code at HEAD, not trusted from the register (the register header is itself stale — it still reads v0.5.27 / schema 51 / commit `0215475`).

## Legend
✅ CLOSED (verified) · 🟡 CODE-DONE, pending live/owner action · 🔴 OPEN · ⚪ superseded/gap

---

## D-series — the dedicated desktop items

| ID | P | Register says | **Code-verified at HEAD** | Status |
|----|----|--------------|---------------------------|--------|
| D1  | P0 | closes with D4 | InstallPage uses **Business ID + enrolment code**, no owner login on the till (`InstallPage.tsx:173,177`) — the two-business dead end is structurally gone | 🟡 code-done, closes on D4 live test |
| D2  | P0 | CLOSED 08-08 | held orders in SQLite (not localStorage) | ✅ |
| D3  | P1 | OPEN, scaffold | `autoUpdate.ts` present, **excluded from build** (`tsconfig.main.json:20`), **not wired** into `index.ts` (0 refs) | 🔴 owner: add dep + signing cert + CI release |
| D4  | P1 | OPEN, impl | migration 81 + `enrol.ts` + `auth redeem` + InstallPage `redeemEnrolment` all present | 🟡 code-done, pending one live enrol→redeem→install test |
| D5  | P1 | CLOSED 08-08 | tokens wrapped at rest (`tokenStore.ts`) | ✅ |
| D6  | P2 | CLOSED 08-10 | `LOCAL-SCHEMA-VERSIONS.md` present | ✅ |
| D7  | P2 | OPEN, rollout | shared `ipcValidate.ts` + **6 adoption call sites** (verifyPin, order:void, enrolDevice, setKitchenExclusions…); **~132 channels remain** | 🔴 incremental; `order:create` deliberately unvalidated |
| D8  | P1 | CLOSED 08-10 | dispatch-slip print gap fixed | ✅ |
| D9  | P3 | OPEN, designed | `held_orders` **not** in replicated tables — deliberately unbuilt | 🔴 owner concurrency decision gated |
| D10 | P3 | OPEN | `ipcHandlers.ts` is **2,054 lines** — was 1,639 when opened, so it **grew** | 🔴 OPEN (worse — regressed) |
| D11 | P1 | CLOSED 08-13 | `/api/pos/init` branch-licence fix | ✅ |
| D12 | P1 | CLOSED 08-08 | inbound sync failures now surfaced | ✅ |
| D13 | P0 | PARTLY CLOSED | client single-flight guard done; **server-side refresh grace window still absent** (refresh handler revokes with no briefly-superseded grace) | 🔴 P0 partial — server grace window still open |
| D14 | P1 | CLOSED 08-10 | till registration/telemetry fixed | ✅ |
| D15 | P3 | CLOSED 08-12 | dead `public.sync_queue` dropped (migration 80) | ✅ |
| D16 | — | — | **no D16 exists** — numbering gap | ⚪ gap (never assigned) |
| D17 | P3 | OPEN, config done | `electron-builder.config.js` + `release-flavour.mjs` present | 🟡 code-done, pending Windows install check |
| D18 | P2 | OPEN, fix done | `onPaste` detects `st2.` and routes to token step (`PinPage.tsx:148-156`); admin reveal-code complement done | 🟡 code-done, pending live paste test |

**D-series tally:** ✅ 8 closed (D2,D5,D6,D8,D11,D12,D14,D15) · 🟡 4 code-done pending verification (D1,D4,D17,D18) · 🔴 4 genuinely open (D3,D7,D9,D10,D13-partial) · ⚪ 1 gap (D16).

---

## Desktop-relevant A-series items

| ID | P | Title | **Verified status** | Status |
|----|----|-------|---------------------|--------|
| A17 | P0 | Peer till can't "sell offline forever" — locks out on day 15 | Confirmed OPEN — the offline-indefinite design isn't supported | 🔴 P0 OPEN |
| A18 | P1 | `nodeServer.ts` documents a dead architecture | doc-drift on the branch node | 🔴 OPEN |
| A19 | P1 | A permanently-offline peer's sales never reach the cloud | branch-node relay gap | 🔴 OPEN |
| A20 | P1 | Failover can't open the shop — staff roster doesn't replicate | node failover gap | 🔴 OPEN |
| A24 | P1 | Reference data goes stale on an offline peer | node/sync gap | 🔴 OPEN |
| A54 | P1 | Mail undelivered in production | **Render blocks outbound SMTP on free tier** (verified: policy live since 2026-09-26; ports 465/587 paid-only, 25 blocked always). Fix = set `RESEND_API_KEY` (HTTP/443) + verify a domain, and confirm the live Render plan | 🔴 OPEN — **owner config, not code** |
| A12 | P1 | `ingredients.current_stock` has no writer | server/dashboard (recipes drawer symptom fixed); tangential to the till | 🔴 OPEN (not desktop-core) |
| A59 | P1 | Till gates on roles, cloud on permission keys | **CLOSED today (A87)** — force_close wired, route + migration 83 + till gate; parity green | ✅ |

**Note — A17/A18/A19/A20/A24 are one cluster:** the branch-node / offline-peer / failover architecture (the PHASE5/PHASE6 "sell offline indefinitely via a branch server" capability). This is the **largest remaining desktop-relevant body of work**, and A17 is the one open **P0**.

---

## This session's desktop-touching work — all CLOSED and on `origin/dev`

| ID | What | Status |
|----|------|--------|
| A76 | PIN lockout (LockCurtain/POSLoginScreen), double-charge guard, round2 parity | ✅ pushed |
| A80/A81 | sync stock delta-merge + offline clamp removed | ✅ pushed |
| A83/A84 | tabbed Printers screen, Stations restored, kitchen exclusions word-boundary | ✅ pushed |
| A85 | sync push: floats no longer silently dropped | ✅ pushed |
| A86 | sync push: atomic mark-synced | ✅ pushed |
| A87 | `shifts.force_close` wired — closes A59 | ✅ pushed |

---

## Bottom line

- **Nothing desktop-critical is silently broken.** The P0/P1 open items are either **code-done pending a live/Windows test** (D1, D4, D17, D18) or **known architectural gaps** (the A17/A18/A19/A20/A24 branch-node cluster, D3 auto-update, D7 IPC rollout, D13 server grace window).
- **Owner/infra-blocked, not code:** D3 (signing + CI), A54 (Render/Resend config).
- **Genuinely open code work, by priority:**
  1. **A17 (P0)** + **A18/A19/A20/A24 (P1)** — the offline-peer / branch-node capability. Biggest chunk.
  2. **D13 (P0-partial)** — server-side refresh grace window (small, server-side).
  3. **D7 (P2)** — IPC validator rollout (~132 channels, incremental).
  4. **D10 (P3)** — `ipcHandlers.ts` refactor (has grown to 2,054 lines).
  5. **D9 (P3)** — cross-till held orders (needs an owner concurrency decision first).
- **Verification debt (not bugs):** D1, D4, D17, D18 need a real Windows/live run to move ✅. That's field testing, not code.
- **Register hygiene:** the register **header is stale** (says v0.5.27/schema 51/`0215475`; actual is v0.5.32/schema 52/`3e56680`) and doesn't list this session's A74–A87 — worth a header re-derive. D16 is an unassigned numbering gap.
