# SwiftPOS — consolidated code review & remediation (handoff)

This is the single consolidated drop of everything from the review session. It
contains, in repo-relative structure, the NEWEST version of every file changed —
merged so cumulative files (orders.ts, the create_order_atomic migration) are the
final version, not an intermediate one.

Import the folders over your working tree. Then read the "Apply order" section
below before deploying — several changes interact, and a couple must ship
together.

────────────────────────────────────────────────────────────────────────────────
## 1. What's in here
────────────────────────────────────────────────────────────────────────────────

  migrations/           60, 61, 63, 65 — the four to run (see order below)
  shared/printing/      the printing rebuild (renderer, transport, spool, tests)
  apps/print-server/    rewritten silent-print bridge for the web POS
  apps/desktop/         PrinterSetupScreen, sqlite spool store, syncEngine change
  apps/server/          all server route/lib/middleware changes
  apps/dashboard/       web POS changes (discount ceiling, order number, etc.)
  docs/                 PRINTER-SETUP.md, menu composition draft + importer proof
  tests/                every standalone test (node <file>.mjs, no server needed)
  apply-notes/          the per-fix APPLY-*.md, kept for detail per change

────────────────────────────────────────────────────────────────────────────────
## 2. Findings — what changed and where
────────────────────────────────────────────────────────────────────────────────

Money / data-integrity (highest value):

  #1  Numeric-string stock corruption. PostgREST returns numeric columns as
      STRINGS, so "10.00" + 5 = "10.005". Stock adjustments now go through the
      adjust_product_stock RPC (migration 61) — math in Postgres under a row
      lock, which also closes a lost-update race. orders.ts (void/refund
      restore), stock.ts (product receive), migration 61.

  #10/#15  No order transaction + no payment validation. ~15 sequential inserts
      with no transaction; payment legs never checked against the total.
      create_order_atomic (migration 65) writes order+items+payments in ONE
      transaction and REJECTS legs that don't reconcile to the total. orders.ts.

  #8/#9  Refund & levy reporting. Refunds were counted at full value; the levy
      was re-derived in a way that double-applied the rate. New lib/orderTax.ts
      reads stored vat/ctl and nets out refunds; wired across the reports.
      reports.ts, lib/orderTax.ts.

  #4  Three reports hung. branchScope was passed as middleware and never called
      next(). Called inline now. reports-daily.ts.

  #6  Web POS ignored the discount ceiling. It was the only client not clamping,
      so it charged an uncapped discount the server then capped — the charged
      total and the stored total disagreed. Now clamps to the server-advertised
      ceiling. cashier/types.ts, usePOSData.ts, CashierScreen.tsx, PaymentModal.tsx.

  #13 + terminal scenario  Shifts keyed on cashier, not terminal. Cashier A's
      sale on terminal T2 was attributed to A's shift opened on T1, so the money
      (in T2's drawer) reconciled against T1 — phantom shortage on one drawer,
      surplus on another. Shifts are now drawer sessions bound to a terminal
      (industry-standard fixed-till model); close is authorised (opener /
      same-terminal / manager). migration 63, lib/terminalKey.ts, shifts.ts,
      orders.ts.

  #7  Offline sales dated at sync time. A till offline overnight booked
      yesterday's takings as today's. The sale's real timestamp now flows through
      to the order. migration 65, orders.ts, desktop syncEngine.ts.

  #19 Offline orders silently re-priced. If a catalogue price changed between an
      offline sale and its sync, the re-priced total diverged from the printed
      receipt with no signal. Divergence is now detected and logged; the
      re-priced figure is still stored (anti-tampering preserved) — deciding what
      to DO about it is a business-policy call. orders.ts.

  #5  M-Pesa STK dead on arrival. The atomic RPC hardcoded every leg 'completed',
      so the M-Pesa leg was complete before payment and the STK push 409'd. The
      leg is now written 'pending' and the callback completes it. migration 65,
      orders.ts.

  #14 /pay didn't enforce payment reconciliation. POST /orders rejects mismatched
      legs; /pay only logged. /pay now rejects too. (Its other divergences —
      credit, tax, discount — were already fixed under prior audit work.)
      orders.ts.

Security / correctness:

  #11 Shared PINs mis-attributed sales. Login looped all staff and took the FIRST
      bcrypt match, so two people with the same PIN had sales booked to whoever's
      row returned first. Login now refuses an ambiguous PIN; set-pin rejects a
      duplicate. auth.ts.

  #12 Auth rate-limiter bypass. It keyed on x-device-id (client-supplied), so a
      brute-forcer rotating the header never hit the limit. Auth attempts now key
      on IP; the general API limiter keeps the device key for fairness. index.ts.

  #16 Relocated-till branch check never called. Migration 52 built the binding
      and lib/deviceBinding.ts implemented the check, but it had zero call sites.
      Wired into order creation: a moved till is refused until a manager
      authorises the move. orders.ts.

  #18 safeRouter broke Express error handlers. It wrapped every handler in a
      3-arg function; Express identifies an error handler by arity 4, so wrapping
      demoted it to ordinary middleware. 4-arg handlers now pass through.
      asyncHandler.ts.

  #20 Order-number collisions. 6-digit time slice + 3 random digits collided at
      volume, and the unique index then rejected the second SALE. Now a
      per-process monotonic counter (zero same-process collisions) + wide random
      + the server unique index as backstop, with the atomic path returning a
      clean 409 on a genuine collision. cart.ts, orders.ts.

Deliverables (not "findings" but part of the work):

  Printing rebuild. From ~10s to ~5-8ms. Zero runtime deps. One renderer →
      bytes OR preview (so the settings-screen preview matches paper exactly).
      Verified to the cent against your two photographed incumbent receipts.
      shared/printing/, apps/print-server/, apps/desktop/.../PrinterSetupScreen.tsx,
      docs/printing/PRINTER-SETUP.md.

  Adaptive menu. A five-primitive schema with NO concept of combo/spice/Kudo,
      proven to hold three unrelated businesses (chicken shop, coffee shop,
      butchery) on one schema with no code change. migration 60,
      docs/menu/importer-proof.py, kudo-menu-composition-draft.xlsx.

NOT done tonight (flagged honestly):

  #21 strict:false on four tsconfigs. Flipping to strict surfaces dozens of
      pre-existing type errors — a multi-day migration, not something to rush.

  #14 full structural convergence. /pay and POST /orders now enforce the same
      money rules but still run separate code paths. Merging them is a clean
      follow-up; the risk of rushing it (breaking the dine-in path) isn't worth
      it tonight.

  #5 order lifecycle. A pure-M-Pesa order is still CREATED 'completed' (unchanged
      behaviour; the STK panel treats it as voidable). Whether it should sit
      'open' until the callback ripples into stock/reports/callback logic — a
      considered follow-up, deliberately not rushed.

────────────────────────────────────────────────────────────────────────────────
## 3. Apply order
────────────────────────────────────────────────────────────────────────────────

MIGRATIONS — run in this order:

  60_menu_composition.sql        (menu schema; independent)
  61_adjust_product_stock.sql    (stock RPC; independent)
  63_shift_drawer_sessions.sql   (drawer sessions; see WARNING below)
  65_order_atomic_leg_status.sql (create_order_atomic — FINAL; supersedes 62/64)

  Migrations 62 and 64 are NOT included — 65 is a CREATE OR REPLACE that contains
  their changes plus the M-Pesa leg-status fix. If you already ran 62/64 in a
  prior deploy, running 65 simply replaces the function again. If you never ran
  them, 65 is self-contained.

  >> 63 WARNING: it demotes any duplicate open shifts sharing a terminal to
     'closed_unreconciled'. In practice this is only the web fallback — if
     several cashiers currently have open shifts with no device_id, they now key
     to 'web:<branch>' and only the newest stays open; the rest need a manager to
     count them. Desktop tills each have their own device_id and are unaffected.

CODE — deploy the three surfaces:

  server     — after the migrations. Whole apps/server/ tree here is consistent
               and typechecks clean together.
  dashboard  — run `npm run build` FIRST (see verification note). Then deploy.
  desktop    — build and roll out. Needed for #7 (offline dating sends the
               timestamp) to take full effect; the server is backward compatible
               so you can deploy it first and update tills as convenient.

────────────────────────────────────────────────────────────────────────────────
## 4. Deploy-ordering interactions (READ THIS)
────────────────────────────────────────────────────────────────────────────────

These changes are not fully independent. Two orderings matter:

  A) The atomic-order payment guard (#10/#15) REJECTS orders whose legs don't sum
     to the total. TWO things must be right before it goes live:

     • The web discount-ceiling fix (#6) must ship WITH or BEFORE it. Without it,
       a web sale with an over-ceiling discount charges one number and the server
       stores another — a mismatch the guard would REJECT at checkout. #6 makes
       the client charge what the server stores, so the legs reconcile.

     • The tip check. If ANY client sends payment legs whose amount includes a
       tip (rather than sending legs that sum to `total`, with tip in the
       separate tip field), the guard will reject those sales. Before deploying:
       grep your logs for [payment-mismatch] on a staging run, and confirm the
       clients send legs summing to total. This applies to BOTH POST /orders and
       /pay now (#14).

  B) #11 (PIN uniqueness). After deploy, any existing pair of staff sharing a PIN
     will get PIN_NOT_UNIQUE at login until a manager resets one. That is the
     correct outcome — it surfaces a silent attribution ambiguity — but WARN YOUR
     MANAGERS so a shared-PIN login failure isn't mistaken for a bug.

────────────────────────────────────────────────────────────────────────────────
## 5. What was verified vs reasoned (be honest with yourself here)
────────────────────────────────────────────────────────────────────────────────

VERIFIED:
  • The entire apps/server/ tree typechecks CLEAN together against your project
    (one pre-existing tsconfig deprecation warning, not from these changes).
  • Every fix has a standalone test in tests/ that passes (11 tests). Run them:
        for t in tests/*.mjs; do node "$t"; done
  • Printing output verified to the cent against your two photographed receipts;
    .bin files are in shared/printing/out/ ready to send to a printer.
  • The menu importer proof loads three unrelated businesses on one schema.

NOT VERIFIED HERE (you must):
  • The DASHBOARD (React/JSX) could not be compiled where this was prepared —
    node_modules for apps/dashboard wasn't installed, so React didn't resolve.
    The dashboard changes (#6 discount ceiling, #20 order number) are verified by
    reasoning and by the arithmetic tests, NOT by a compile. RUN `npm run build`
    in apps/dashboard before deploying and fix anything it flags — the changes
    are small and greppable: maxDiscountPct, cappedDiscount, chargedTotal,
    grandTotal, generateOrderNumber.
  • The DESKTOP change (syncEngine.ts, one added field) likewise wasn't compiled
    against desktop node_modules. Build apps/desktop before rolling out.
  • NOTHING is hardware-tested. The printing is byte-verified but has not driven a
    physical printer. Send a .bin to your printer: nc <printer-ip> 9100 <
    shared/printing/out/receipt-80.bin

────────────────────────────────────────────────────────────────────────────────
## 6. Two things only YOU can do (non-code, repeatedly flagged)
────────────────────────────────────────────────────────────────────────────────

  1. ROTATE ALL SECRETS in apps/server/.env. This is the single most important
     item in the entire review. The service_role key in there bypasses RLS
     entirely, so every row-level protection is moot while it is exposed. Rotate
     the Supabase service_role key, any M-Pesa credentials, and the JWT secret.
     No code change substitutes for this.

  2. HARDWARE-TEST THE PRINTING. The bytes are verified against your receipts,
     but a real printer is the last unchecked link. Send each .bin in
     shared/printing/out/ to the corresponding printer and confirm the paper
     matches the SAMPLE-OUTPUT.txt / the settings-screen preview.

Also, once deployed and confirmed: git rm the two dead qzTray.ts files
(apps/dashboard/src/lib/qzTray.ts, apps/desktop/src/renderer/lib/qzTray.ts) —
they're replaced by the new print bridge.

────────────────────────────────────────────────────────────────────────────────
## 7. Per-fix detail
────────────────────────────────────────────────────────────────────────────────

Each change has a full APPLY-*.md in apply-notes/ with the specific mechanism,
the exact deploy caution for that fix, and its test. Start with:
  apply-notes/APPLY-shift-drawer-sessions.md      (the terminal scenario)
  apply-notes/APPLY-atomic-order-fix.md           (the payment guard + tips)
  apply-notes/APPLY-web-discount-ceiling-fix.md   (pairs with the above)
