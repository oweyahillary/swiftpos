# MANIFEST 2026-09-25-b — A328 part 2: the web POS's inline colours follow the theme (fixes green Charge beside pink Confirm)

**Base commit:** `352dded` (origin/dev, delivery 2026-09-25-a — A328 part 1, deployed). **Deploy: the dashboard only.**

**Why.** After part 1 was deployed the owner saw the web POS half-themed: **Charge green**, Confirm pink; the All chip, Dine in, the
T3 chip, the selected product and "Spicy" green; Open Table / Add to Order blue. Part 1's sweep matched Tailwind green CLASSES only —
`CashierScreen.tsx` and the other POS layouts use **inline hex/rgba styles**, so they were counted as zero.

**What.**
- **Re-swept** with hex + `rgb(a)` + Tailwind blue classes; every scanned file listed (35; 17 with hits). 181 uses classified
  (`docs/A328-web-pos-inline-colours.md`): 94 action · 41 status · 15 money · 18 data/identity · 13 M-Pesa. Owner decisions: blue
  primaries take the theme; M-Pesa stays; Minimart/Parking/Petrol included. Audit corrected 2 risky auto-calls.
- **Per-use fallbacks:** each themed use is `rgb(var(--act-fill|strong|text, <its own original r g b>))`; the aliases in `index.css`
  have NO default, so with themes OFF every use renders its own original (green or blue). Role per occurrence: white label → strong
  (theme 700); dark label / border / dot / tint → fill (500); text → 400 dark / 700 light — following the POS's own `data-pos-theme`
  toggle as well as the dashboard's `.dark` (the part-1 link token too).
- **Gate** `check-web-pos-green` now matches hex / rgba / blue classes (baseline 14 → 101). **Test** 13 → 21.
- WORKING-METHOD §9: a sweep must match every colour form and list every file scanned.

## Files (22)
- `apps/dashboard/src/index.css`
- `apps/dashboard/src/pages/pos/CashierScreen.tsx`
- `apps/dashboard/src/pages/pos/MinimartPOS.tsx`
- `apps/dashboard/src/pages/pos/POSCustomersTab.tsx`
- `apps/dashboard/src/pages/pos/POSDrawer.tsx`
- `apps/dashboard/src/pages/pos/POSInventoryTab.tsx`
- `apps/dashboard/src/pages/pos/POSLoginScreen.tsx`
- `apps/dashboard/src/pages/pos/POSOrderHistoryTab.tsx`
- `apps/dashboard/src/pages/pos/POSReportsTab.tsx`
- `apps/dashboard/src/pages/pos/ParkingPOS.tsx`
- `apps/dashboard/src/pages/pos/PaymentModal.tsx`
- `apps/dashboard/src/pages/pos/PetrolPOS.tsx`
- `apps/dashboard/src/pages/pos/ShiftModal.tsx`
- `apps/dashboard/src/pages/pos/SplitPaymentPanel.tsx`
- `apps/dashboard/src/pages/pos/ZReportModal.tsx`
- `docs/A328-web-pos-inline-colours.md`
- `docs/AUDIT-REGISTER.md`
- `docs/MANIFEST-2026-09-25-b.md`
- `docs/WORKING-METHOD.md`
- `scripts/check-web-pos-green.mjs`
- `scripts/web-pos-green-baseline.json`
- `tests/web-pos-theme.test.mjs`

## Verification (rule 7)
```
rewrite: 94 classified = 94 rewritten (fill 56 · strong 20 · text 18); no themed line holds a colour meant to stay
BENCH — Chromium, the dashboard's REAL compiled CSS, 4 contexts (dashboard dark / light, POS toggle dark / light):
  themes OFF: 94/94 rewritten uses identical to their originals — in every context
  7 themes × 4 contexts: white labels on strong fills worst 5.36 · dark labels on fills worst 4.96 · text on panels worst 5.36
node tests/web-pos-theme.test.mjs 21/21 — mutations: alias given a default → FAIL · Charge back to raw hex → 2 FAIL
node scripts/check-web-pos-green.mjs OK (101) · --self-test (incl. an inline-hex button) OK · Charge raw hex → FAIL (26 vs 25)
dashboard tsc 0 + build 0 · ratchet OK · run-all GREEN 121/121 · all 26 apps/desktop/test pass
```

## Not verified here (rule 16) — owner, after the dashboard deploy (B Foods, themes ON)
1. Web POS: **Charge**, **All**, **Dine in**, the **T3** chip, the **selected product** and **Spicy** option, **Open Table**,
   **Add to Order**, **Clock** — all in the theme; prices, totals, discounts and the tables' "free" green unchanged.
2. The POS's own ☀/☾ toggle: in light, the themed text and links are darker and readable.
3. Themes OFF (admin): the web POS looks exactly as before — green and blue where they were.

## Rollback
```bash
git checkout 352dded -- . && rm -f docs/A328-web-pos-inline-colours.md docs/MANIFEST-2026-09-25-b.md
```
