# MANIFEST 2026-09-27-j — A342 till close closes the web's shift · A343 web till · A344 payment colours

**Base:** origin/dev `0e5e1b3` (v0.6.13; CI #415 green; Release desktop #29 green), plus the two docs commits on
`claude/modest-cray-f21ll5` (`7cd19af` checklist v0.6.13, `9199ea4` results). The owner fast-forwards `dev` onto this commit.
**Deploy: cloud + dashboard + desktop v0.6.14.** No migration.

Owner, 2026-09-27, after the 0.6.13 checklist (31 pass / 0 fail / 8 skip):
- "if a shift is closed on the till it should also close the web" — and "Till's count covers both".
- "if cashier A has a shift running on Till 1 and logs into the web it should detect the shift and logs him in directly … but if
  cashier b does the same they are asked to join cashier A shift or proceed to create a shift"; on the desktop "they proceed to the
  current shift running on the till"; "this can be called branchname_web_till".
- "we can make the payment method color full each with a color" — "Buttons + reports".

## What changed
1. **A342 — the till's close covers the web's shift on that till.**
   - The cloud tells the till about any OTHER shift open on the same till (the web standing in as it) with its expected cash.
     The till adds it to expected cash and says so: "Also counted in this drawer … Closing here closes it too".
   - The Z-report shows "+ Web shift on this till", on screen and on paper.
   - When the TILL's close reaches the cloud, the web's shift is closed too (counted, variance 0, with a note).
   - A web close never closes the till's shift.
   - A till close whose figures moved afterwards is recorded with a note, never refused (a refusal would retry forever).
   - Found on the way: the cloud's terminal-write guard (currently log-only) would have blocked the till's read-only
     `foreign-cash` / `foreign-orders` requests the day it was switched on. Both are now on its allowlist.
2. **A343 — web sign-in: join the running shift, or your own on "<Branch> Web Till".**
   - Goes straight in: the cashier who opened the running shift, a cashier who already joined it on this browser, and a cashier
     with exactly one open drawer of their own (a till's or the web till's).
   - Everyone else gets the picker. It now lists **"<Branch> Web Till"** first and says "A's shift is running on T1 … Join it, or
     start your own shift on <Branch> Web Till".
   - The web till is the branch's existing web drawer, now named and offered (NEW `GET /api/shifts/web-till`).
   - The desktop is unchanged.
3. **A344 — payment methods in colour.** One colour per method (Cash amber, M-Pesa green, Card blue, On Account violet, Glovo
   orange; custom tenders a stable colour from five). Where it shows:
   - payment buttons on the till and the web POS: unselected ones are tinted in their method colour, and the selected one keeps
     the theme highlight;
   - a coloured dot beside the method name in orders, the shift panel, the manager's Orders / Overview / Shift, and the web's
     order history and reports;
   - breakdown bars take the method colour.

   Each colour is the mid-tone that reads on both the till's dark screen and the web's white.

## Files
| Area | Files |
|---|---|
| Cloud | `lib/siblingDrawers.ts` (NEW), `routes/shifts.ts` (foreign-cash `siblings`, desktop /close closes siblings, replayed-close note, NEW `/web-till`), `lib/terminalLabel.ts` (`webTillName`), `middleware/auth.ts` (allowlist) |
| Till | `main/shiftService.ts` (siblings in expected), `renderer/pages/ShiftPanel.tsx`, `renderer/components/ZReportView.tsx`, `renderer/lib/printShiftReport.ts`, `renderer/lib/posApi.ts`, `renderer/components/PaymentModal.tsx`, `renderer/components/MethodDot.tsx` (NEW), `renderer/pages/ManagerPage.tsx`, `renderer/pages/POSPage.tsx`, `shared/paymentColours.ts` (NEW copy) |
| Web | `lib/posTerminal.ts` (web till helpers), `pages/pos/CashierScreen.tsx`, `pages/pos/ShiftModal.tsx`, `pages/pos/PaymentModal.tsx`, `pages/pos/POSOrderHistoryTab.tsx`, `pages/pos/POSReportsTab.tsx`, `components/MethodDot.tsx` (NEW), `lib/paymentColours.ts` (NEW copy), `lib/escposRenderer.js` (rebuilt) |
| Shared | `shared/paymentColours.ts` (NEW, canonical), `shared/printing/src/shiftReport.ts` (web-shift line) |
| Gates | `scripts/check-shared-sync.mjs` (+ paymentColours), `scripts/back-office-colour-baseline.json` + `docs/A329-back-office-colour-classification.md` (addendum) |
| Tests | NEW `tests/sibling-drawers.test.mjs` (9), `tests/web-till.test.mjs` (13), `tests/payment-colours.test.mjs` (7); `apps/desktop/test/shared-drawer.test.mjs` (+3); `tests/shift-join.test.mjs`, `tests/terminal-write-guard.test.mjs` (pins updated) |
| Docs | `docs/AUDIT-REGISTER.md` (A342–A344, Tree v0.6.14), `docs/checklists/VERIFY-CHECKLIST-v0.6.14.html` + `docs/VERIFY-CHECKLIST-v0.6.14.md` (NEW), this file |

## Verification (bench: Linux, Node 22)
```
tests/sibling-drawers.test.mjs → 9 (COMPILED shifts router + real auth over HTTP: 1000+400+(500+230)=2130 counted once, web shift
  closed as counted with its note, other till / web till untouched, a web close closes nothing else, replayed-close note,
  the REAL write guard allows the two POSTs). 5 mutations bite.
tests/web-till.test.mjs → 13 (real web rules; COMPILED /web-till over HTTP). 4 mutations bite.
tests/payment-colours.test.mjs → 7 (real palette: dots ≥ 3:1 on 5 surfaces, labels ≥ 4.5:1 on every tint, dark and light).
  4 mutations bite. First palette failed on white (amber/orange) — caught by the test, fixed.
apps/desktop test/shared-drawer.test.mjs → 19 (+3: 2050 + 730 = 2780). Mutation bites.
tests/*.test.mjs → all 131 pass · every desktop test · scripts/test-* · 30 migration tests · printing · both builds · ratchet
every static gate OK (incl. shared-sync 14 copies, colour gates, api-routes) · register-consistency OK with the 0.6.14 bump
Chromium: payment buttons in dark and light (preview sent); the checklist at 390 px.
```
Not verified here (rule 16): the live till, web POS and cloud.

## Rollout
1. Deploy the cloud (Render) and the dashboard from `dev`.
2. Install 0.6.14 on every till.
3. Run `docs/checklists/VERIFY-CHECKLIST-v0.6.14.html` (29 checks: §R, §K, §L, §M, the 8 skipped on 0.6.13, regression).

## Rollback
```bash
git revert <this commit>   # no schema change
```
