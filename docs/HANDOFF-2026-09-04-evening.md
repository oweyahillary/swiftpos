# SwiftPOS — Handoff 2026-09-04 (evening)

## §0 Working rules (unchanged — carry forward)
Same standing rules as `HANDOFF-2026-08-08-evening.md §0`. The ones that bit us most this session:
- **Rule 16/17:** read source before building — several "features" turned out already-built or
  needing a decision (A197 wired, A145 retired). Always rule-17 sweep first.
- **Rule 14:** every finding gets an ID (we filed A199–A209 as we went).
- **Nothing closes on bench evidence** — only a live browser pass. Built work sits `FIX BUILT` until verified.
- **Deploy ≠ merge:** repeatedly, a "FAIL" was a stale deploy, not the code. Confirm the deployed
  commit before trusting a verify. (Dashboard deploys from `dev`; confirm it's caught up to the tip.)

## §1 Goal
Bring the SwiftPOS **web manager portal** to completeness/parity so the web is attractive enough to
drive online subscriptions, while keeping deliberate premium boundaries (desktop stays offline-lean).
Clear the audit register's active-cloud backlog; leave desktop/node items parked (need hardware).

## §2 Current state
- **Repo:** branch `dev`, tip **`f0b7582`** on `origin`. Everything below is on `origin/dev`
  (verified byte-identical). `main` is behind — dev-first; merge to main only when fully verified.
- **Open register counts (A-side):** `1 P0 · 15 P1 · 17 P2 · 6 P3` (D-side: `1 P0 · 2 P1 · 2 P2 · 3 P3`).
- **Deploy topology:** dashboard → `swiftpos-three.vercel.app` (from `dev`); dev API →
  `swiftpos-20c2.onrender.com`; dev DB → Supabase (migrations applied through **98**). The
  print-server (`apps/print-server`) must `npm run build` `shared/printing` to run (dist is gitignored).

### Verified-closed this engagement (browser-verified)
A184, A199, A192, A195, A194, A193, A190, A185, A200, A143, A12, A202, A145, A203, A201, A148
(+ A129 duplicate-90 resolved).

### Built this session, on dev, awaiting the manager-PIN verify pass (FIX BUILT)
- **A133** — manager sidebar grouped into sections (Overview · Inventory[Inventory·Receiving] ·
  Finance[Orders·Shifts·Reports·Turnover·Expenses] · Customers · Settings).
- **A205** — manager **Receiving** tab: incoming transfers (mark received) + supplier deliveries (GRN).
- **A206** — manager **Open POS** now works (CashierScreen guard only redirects the owner).
- **A207** — manager **Shifts** tab: open drawers + force-close a stranded one (reason required).
- **A208** — manager **Menu** tab (READ-ONLY; editing stays owner-only by decision).
- **A209** — web receipts render in the **desktop ESC/POS format** — *core* built + proven; last-mile
  wiring pending (see §6).

## §3 Active files (touched tonight)
- `apps/dashboard/src/pages/manager/ManagerDashboard.tsx` — grouped nav + Receiving/Shifts/Menu wiring.
- `apps/dashboard/src/pages/manager/ManagerReceivingTab.tsx` — NEW (transfers + GRN receive).
- `apps/dashboard/src/pages/manager/ManagerShiftTab.tsx` — NEW (open shifts + force-close).
- `apps/dashboard/src/pages/manager/ManagerMenuTab.tsx` — NEW (read-only menu).
- `apps/dashboard/src/pages/pos/CashierScreen.tsx` — A206 guard fix.
- `apps/dashboard/src/lib/buildReceiptOrder.ts` — NEW (pure sale→Order/BusinessConfig mapper, cents).
- `apps/print-server/src/index.js` — NEW `POST /print/receipt` (renders via shared/printing).
- Tests: `tests/manager-nav-grouped`, `manager-receiving`, `pos-manager-open`, `manager-shift-tab`,
  `manager-menu-readonly`, `receipt-escpos-format` (all `.test.mjs`, mutation-checked).
- `docs/AUDIT-REGISTER.md` + `docs/MANIFEST-2026-09-04-{j..o}.md`.

## §4 Changes made (this session, in order)
Register clears + fixes → A143 exports (auth + missing expenses route) → A12 dead-column drop
(migration 98) → A202 owner-permission wildcard → A203 transfer-received hang (v1 then v2 proactive)
→ A201 export 401 retry → A145 close, A148 add-option, A129 dup-90 archive → A204 filed → then the
manager portal: A133, A205, A206, A207, A208, A209. Commit trail (recent):
```
f0b7582 A209 web receipt server-render (desktop format) + mapper + test
1fd0026 Manager portal: A133 + A205 + A206 + A207 + A208
9470558 Register: close A203 + A201; A148 deploy-state note
39ff357 A145 close + A148 add-option + A129/dup-90 archive + A203 v2 + A204
```

## §5 Failed attempts / traps hit (so tomorrow avoids them)
- **A203 v1 was incomplete** — added an in-app modal but still went through the server-409 catch, so a
  native `window.confirm` still fired for a normal user. v2 fixed it by deciding same-user on the
  CLIENT before any server call. Lesson: don't rely on catching a server 409 to drive UX.
- **Deploy lag masqueraded as bugs** — A148 and A203 "failed then passed between rounds"; both were
  stale deploys, not code. Always confirm the deployed commit before believing a FAIL.
- **`git am` pain** — globs (`0001-*.patch`) picked up stale patch files → 36-patch replays; and mixing
  a zip-extract with `git am` half-applied things. Settled on: **zip-extract + explicit `git add` +
  commit**, and for renames/deletes do the `git rm`/`git mv` by hand (the zip can't express them).
- **`s/ A203//` broad sed** corrupted the register once — always anchor register sed edits precisely.
- **A209 render crashed** first try — `BusinessConfig` requires `vatRate`+`ctlRate`; the mapper now
  supplies them. And `shared/printing/dist` is gitignored, so it must be built before the endpoint/test.

## §6 Next steps
### Immediate (close what's built)
1. **Run the manager-PIN verify pass** (`QA-VERIFY-MANAGER-2026-09-04.md`): grouped nav, receive a
   transfer, receive a GRN, confirm no adjust/edit control, Open POS opens the cashier screen, Shifts
   tab lists open drawers + force-close, read-only Menu. Closes A133/A205/A206/A207/A208.
2. **A209 last-mile** (needs print-server config): add print-server URL/token/target to
   `PrinterSettings` (+ PrinterSettingsModal fields); `printReceiptViaServer` POSTs `/print/receipt`
   with `X-Print-Token`; wire `PaymentModal` to prefer the ESC/POS path when configured. Then the
   **hardware print test** (real printer via the running print-server). Closes A209.

### Active cloud backlog (not hardware-blocked)
- **A129** — delivery sync (needs the prod-migrate through the dup-resolved migration 90).
- **A146** — notifications/webhook UI caller (endpoints live) — pairs well with the Alerts feature below.
- **A141** bulk ingredient import · **A157** wire validation schemas · **A159** flip device write-guard
  to enforce · **A204** Cancel confirm+reason (P3) · **A139** per-branch franchise receipts.

### Blocked on owner
- A54/A50/A146-email (verified sending **domain**) · A188 (a genuine **no-layout branch** to test).

### Parked (desktop/node cluster — needs two-till hardware)
A17, D1, A18/19/20/24, A158, A160–164, A179, D3/D4, A182/A168/A22/A23/D7/D18/D9/D10/D17.

### CI / tooling debt
A189 (E2E run nowhere), A53, A186, A13.

### Skipped by decision (recorded, do NOT re-flag)
- **Desktop inventory receive/adjust** — deliberately absent (premium, online-only).
- **Web "Close Day" / "Close Branch"** — trading-day (`business_days`) is a desktop/offline construct;
  the web's end-of-day unit is the shift (A207 covers it).
- **Web menu editing** — owner-only; managers get the read-only Menu tab (A208).
- **Shared-code refactor** — parked as its own project (see `SHARED-CODE-ANALYSIS.md`); build features
  to completeness first.

## §7 Proposed features — make the web portal attractive (my recommendation)
Lean into what the web does that the till can't (online, real-time, multi-branch, in-pocket):
1. **Approvals inbox (build first)** — voids/refunds/discounts/price-overrides above a threshold route
   to the manager's phone for one-tap approve/reject. Turns the portal into an action surface. Infra
   partly exists (refund authorizer fields A193, `mode_switch_requests` pattern).
2. **Live oversight + alerts** — live "today so far", who's on shift now (A184 data), push alerts for
   big refunds / drawer variance / low stock / "day not closed". Delivery pipe = the webhook infra
   (also closes **A146**).
3. **Multi-branch roll-up** — one screen across branches (a pure web superpower; strong 2+-location upsell).
4. **Mobile-first "today" home** — glanceable sales/alerts/approvals; managers carry phones.
5. **Staff/attendance oversight** — who's clocked in / late / hours, off the on-shift data.
Suggested sequence: **Approvals → Alerts (closes A146) → Multi-branch.**

## §8 Note on pending
Nothing is stranded locally — `origin/dev` (`f0b7582`) has all of tonight's work. The manager portal is
feature-built but **not yet browser-verified** (A133/A205/A206/A207/A208 are `FIX BUILT`), and **A209
is core-only** (last-mile wiring + hardware test outstanding). The realistic first move tomorrow is the
verify pass to bank 5 closes, then either A209 wiring or the Approvals inbox.

## §9 Verify scripts available (in the outputs from tonight)
`QA-VERIFY-MANAGER-2026-09-04.md` (manager pass), `QA-REVERIFY-2026-09-04.md` (transfer/export),
`SHARED-CODE-ANALYSIS.md` (the deferred shared-code plan).
