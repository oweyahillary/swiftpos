# A328 (part 2) — the web POS's inline colours: 181 uses, classified

The first 4b-1 sweep matched Tailwind green CLASSES only; `CashierScreen.tsx` and the other POS layouts colour with inline hex/rgba
styles, so they were invisible to it (the owner saw Charge green next to a themed pink Confirm, 2026-09-25). This sweep matches hex,
`rgb(a)()` and Tailwind blue classes, lists every file it scanned (35; 17 with hits), and records each colour's style name.
Owner decisions 2026-09-25: blue primary buttons take the theme; M-Pesa's green stays; Minimart, Parking and Petrol are included.
**Themes OFF: every use falls back to its own original colour — unchanged.** Status, money, data colours and M-Pesa keep theirs.

Rules settled 89 by style name / wording; 92 reviewed by hand; the status→action direction audited — 2 corrected (a loyalty-points
figure and an idle-pumps count had matched `num`).

| Category | Uses |
|---|---|
| Action — takes the theme | 94 |
| Status — keeps its colour | 41 |
| Money — keeps its colour | 15 |
| Data / identity colour — keeps its colour (zones, fuel grades, payment methods, report charts, info panels) | 18 |
| Third-party brand — keeps its colour (M-Pesa) | 13 |
| **Total** | **181** |

## Action — takes the theme (94)

| File:line (at `352dded`) | Colour | Style | Why |
|---|---|---|---|
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:890` | `bg-blue-600` | `o` | primary button |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:890` | `hover:bg-blue-500` | `o` | primary button |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:1016` | `#10b981` | `—` | Clock button |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:1016` | `#10b981` | `—` | Clock button |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:1314` | `#22c55e` | `—` | active category (fallback colour) |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:1413` | `rgba(34,197,94,0.12)` | `active` | style "active" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:1413` | `#22c55e` | `active` | style "active" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:2123` | `#3b82f6` | `key` | selected transfer target |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:2124` | `rgba(59,130,246,0.12)` | `key` | selected transfer target |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:2125` | `#60a5fa` | `key` | selected transfer target |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:2172` | `#3b82f6` | `next` | transfer confirm |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:2377` | `#22c55e` | `spinnerLg` | loading spinner |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:2405` | `rgba(34,197,94,0.12)` | `parkedBadgeActive` | style "parkedBadgeActive" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:2405` | `#22c55e` | `parkedBadgeActive` | style "parkedBadgeActive" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:2405` | `#4ade80` | `parkedBadgeActive` | style "parkedBadgeActive" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:2485` | `rgba(34,197,94,0.12)` | `activeTablePill` | style "activeTablePill" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:2485` | `rgba(34,197,94,0.4)` | `activeTablePill` | style "activeTablePill" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:2486` | `#4ade80` | `activeTablePill` | style "activeTablePill" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:2488` | `#4ade80` | `coversPill` | style "coversPill" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:2517` | `rgba(34,197,94,0.5)` | `productCardActive` | style "productCardActive" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:2517` | `rgba(34,197,94,0.06)` | `productCardActive` | style "productCardActive" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:2519` | `#22c55e` | `cartBadge` | cart count badge |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:2599` | `#22c55e` | `chargeBtn` | style "chargeBtn" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:2625` | `rgba(59,130,246,0.15)` | `typeBtnActive` | style "typeBtnActive" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:2625` | `#3b82f6` | `typeBtnActive` | style "typeBtnActive" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:2625` | `#60a5fa` | `typeBtnActive` | style "typeBtnActive" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:2641` | `#3b82f6` | `modalConfirm` | style "modalConfirm" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:2671` | `rgba(34,197,94,0.15)` | `variantOptionSelected` | style "variantOptionSelected" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:2671` | `#22c55e` | `variantOptionSelected` | style "variantOptionSelected" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/MinimartPOS.tsx:915` | `#1d4ed8` | `scanSubmitBtn` | style "scanSubmitBtn" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/MinimartPOS.tsx:959` | `#3b82f6` | `parkedCount` | parked-sales count badge |
| `apps/dashboard/src/pages/pos/MinimartPOS.tsx:1034` | `rgba(59,130,246,0.15)` | `catBtnActive` | style "catBtnActive" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/MinimartPOS.tsx:1035` | `rgba(59,130,246,0.4)` | `catBtnActive` | style "catBtnActive" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/MinimartPOS.tsx:1036` | `#60a5fa` | `catBtnActive` | style "catBtnActive" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/MinimartPOS.tsx:1080` | `rgba(59,130,246,0.6)` | `productCardActive` | style "productCardActive" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/MinimartPOS.tsx:1081` | `rgba(59,130,246,0.06)` | `productCardActive` | style "productCardActive" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/MinimartPOS.tsx:1087` | `#3b82f6` | `cartBadge` | cart count badge |
| `apps/dashboard/src/pages/pos/MinimartPOS.tsx:1261` | `#1d4ed8` | `chargeBtn` | style "chargeBtn" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/MinimartPOS.tsx:1261` | `#2563eb` | `chargeBtn` | style "chargeBtn" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/MinimartPOS.tsx:1339` | `#1d4ed8` | `modalConfirm` | style "modalConfirm" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/MinimartPOS.tsx:1351` | `rgba(59,130,246,0.1)` | `modalSecondary` | secondary button |
| `apps/dashboard/src/pages/pos/MinimartPOS.tsx:1352` | `rgba(59,130,246,0.3)` | `modalSecondary` | secondary button |
| `apps/dashboard/src/pages/pos/MinimartPOS.tsx:1354` | `#60a5fa` | `modalSecondary` | secondary button |
| `apps/dashboard/src/pages/pos/POSCustomersTab.tsx:196` | `#3b82f6` | `spinner` | loading spinner |
| `apps/dashboard/src/pages/pos/POSDrawer.tsx:399` | `#3b82f6` | `railTabActive` | style "railTabActive" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/POSDrawer.tsx:399` | `rgba(59,130,246,0.08)` | `railTabActive` | style "railTabActive" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/POSDrawer.tsx:419` | `#3b82f6` | `subTabActive` | style "subTabActive" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/POSDrawer.tsx:419` | `#3b82f6` | `subTabActive` | style "subTabActive" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/POSDrawer.tsx:419` | `rgba(59,130,246,0.06)` | `subTabActive` | style "subTabActive" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/POSInventoryTab.tsx:161` | `rgba(59,130,246,0.15)` | `chipActive` | style "chipActive" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/POSInventoryTab.tsx:161` | `#3b82f6` | `chipActive` | style "chipActive" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/POSInventoryTab.tsx:171` | `#3b82f6` | `spinner` | loading spinner |
| `apps/dashboard/src/pages/pos/POSLoginScreen.tsx:219` | `rgba(59,130,246,0.4)` | `pinReady` | selectable branch |
| `apps/dashboard/src/pages/pos/POSLoginScreen.tsx:228` | `#60a5fa` | `—` | licensed-branch arrow (link) |
| `apps/dashboard/src/pages/pos/POSLoginScreen.tsx:355` | `rgba(59,130,246,0.1)` | `bizPill` | style "bizPill" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/POSLoginScreen.tsx:355` | `rgba(59,130,246,0.2)` | `bizPill` | style "bizPill" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/POSLoginScreen.tsx:363` | `#3b82f6` | `dotFilled` | PIN dots |
| `apps/dashboard/src/pages/pos/POSLoginScreen.tsx:363` | `#3b82f6` | `dotFilled` | PIN dots |
| `apps/dashboard/src/pages/pos/POSLoginScreen.tsx:363` | `rgba(59,130,246,0.5)` | `dotFilled` | PIN dots |
| `apps/dashboard/src/pages/pos/POSLoginScreen.tsx:365` | `#1d4ed8` | `confirmBtn` | style "confirmBtn" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/POSLoginScreen.tsx:372` | `#3b82f6` | `spinner` | loading spinner |
| `apps/dashboard/src/pages/pos/POSOrderHistoryTab.tsx:173` | `rgba(59,130,246,0.4)` | `res` | button |
| `apps/dashboard/src/pages/pos/POSOrderHistoryTab.tsx:173` | `#60a5fa` | `res` | button |
| `apps/dashboard/src/pages/pos/POSOrderHistoryTab.tsx:223` | `#3b82f6` | `spinner` | loading spinner |
| `apps/dashboard/src/pages/pos/POSReportsTab.tsx:173` | `#3b82f6` | `applyBtn` | style "applyBtn" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/POSReportsTab.tsx:180` | `#3b82f6` | `spinner` | loading spinner |
| `apps/dashboard/src/pages/pos/ParkingPOS.tsx:715` | `rgba(59,130,246,0.15)` | `pillActive` | style "pillActive" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/ParkingPOS.tsx:715` | `rgba(59,130,246,0.4)` | `pillActive` | style "pillActive" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/ParkingPOS.tsx:715` | `#60a5fa` | `pillActive` | style "pillActive" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/ParkingPOS.tsx:773` | `rgba(34,197,94,0.1)` | `listActionBtn` | style "listActionBtn" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/ParkingPOS.tsx:774` | `rgba(34,197,94,0.3)` | `listActionBtn` | style "listActionBtn" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/ParkingPOS.tsx:775` | `#22c55e` | `listActionBtn` | style "listActionBtn" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/ParkingPOS.tsx:825` | `#3b82f6` | `vehicleTypeBtnActive` | style "vehicleTypeBtnActive" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/ParkingPOS.tsx:825` | `rgba(59,130,246,0.1)` | `vehicleTypeBtnActive` | style "vehicleTypeBtnActive" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/ParkingPOS.tsx:825` | `#60a5fa` | `vehicleTypeBtnActive` | style "vehicleTypeBtnActive" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/ParkingPOS.tsx:835` | `rgba(59,130,246,0.15)` | `ratePresetActive` | style "ratePresetActive" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/ParkingPOS.tsx:835` | `#3b82f6` | `ratePresetActive` | style "ratePresetActive" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/ParkingPOS.tsx:835` | `#60a5fa` | `ratePresetActive` | style "ratePresetActive" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/ParkingPOS.tsx:878` | `#1d4ed8` | `btnPrimary` | style "btnPrimary" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/PaymentModal.tsx:560` | `bg-blue-600` | `—` | button |
| `apps/dashboard/src/pages/pos/PaymentModal.tsx:560` | `hover:bg-blue-500` | `—` | button |
| `apps/dashboard/src/pages/pos/PetrolPOS.tsx:782` | `#1d4ed8` | `pumpActionBtn` | style "pumpActionBtn" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/PetrolPOS.tsx:843` | `#22c55e` | `gradeCheckmark` | selected-grade tick |
| `apps/dashboard/src/pages/pos/PetrolPOS.tsx:861` | `rgba(59,130,246,0.15)` | `presetBtnActive` | style "presetBtnActive" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/PetrolPOS.tsx:861` | `#3b82f6` | `presetBtnActive` | style "presetBtnActive" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/PetrolPOS.tsx:861` | `#60a5fa` | `presetBtnActive` | style "presetBtnActive" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/ShiftModal.tsx:483` | `#3b82f6` | `primaryBtn` | style "primaryBtn" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/ShiftModal.tsx:492` | `rgba(59,130,246,0.15)` | `toggleActive` | style "toggleActive" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/ShiftModal.tsx:492` | `#3b82f6` | `toggleActive` | style "toggleActive" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/SplitPaymentPanel.tsx:377` | `rgba(59,130,246,0.04)` | `addMethodRow` | style "addMethodRow" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/SplitPaymentPanel.tsx:378` | `rgba(59,130,246,0.2)` | `addMethodRow` | style "addMethodRow" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/SplitPaymentPanel.tsx:396` | `#1d4ed8` | `btnCharge` | style "btnCharge" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/SplitPaymentPanel.tsx:396` | `#2563eb` | `btnCharge` | style "btnCharge" is a pressable/selected control |
| `apps/dashboard/src/pages/pos/ZReportModal.tsx:233` | `#22c55e` | `—` | print / confirm button |

## Status — keeps its colour (41)

| File:line (at `352dded`) | Colour | Style | Why |
|---|---|---|---|
| `apps/dashboard/src/components/Toast.tsx:26` | `bg-blue-500/15` | `STYLES` | info toast |
| `apps/dashboard/src/components/Toast.tsx:26` | `border-blue-500/40` | `STYLES` | info toast |
| `apps/dashboard/src/components/Toast.tsx:26` | `text-blue-300` | `STYLES` | info toast |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:908` | `rgba(34,197,94,0.55)` | `—` | status wording |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:910` | `#4ade80` | `—` | status wording |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:925` | `rgba(34,197,94,0.35)` | `—` | status wording |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:926` | `rgba(34,197,94,0.15)` | `—` | status wording |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:927` | `#16a34a` | `—` | status wording |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:1077` | `#22c55e` | `—` | status wording |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:1176` | `#22c55e` | `—` | status wording |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:1217` | `#22c55e` | `—` | fuel-pump "Idle" legend |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:1516` | `rgba(34,197,94,0.12)` | `—` | item sent to kitchen |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:1516` | `rgba(34,197,94,0.4)` | `—` | item sent to kitchen |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:1516` | `#22c55e` | `—` | item sent to kitchen |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:2395` | `rgba(34,197,94,0.12)` | `modeBadge` | business-mode label (e.g. Restaurant) |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:2396` | `rgba(34,197,94,0.3)` | `modeBadge` | business-mode label (e.g. Restaurant) |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:2397` | `#4ade80` | `modeBadge` | business-mode label (e.g. Restaurant) |
| `apps/dashboard/src/pages/pos/MinimartPOS.tsx:369` | `#22c55e` | `scanBorderColor` | scan found |
| `apps/dashboard/src/pages/pos/MinimartPOS.tsx:392` | `#22c55e` | `scanBorderColor` | scan found |
| `apps/dashboard/src/pages/pos/MinimartPOS.tsx:426` | `#22c55e` | `—` | scan found / error |
| `apps/dashboard/src/pages/pos/POSInventoryTab.tsx:33` | `#22c55e` | `categories` | status wording |
| `apps/dashboard/src/pages/pos/POSLoginScreen.tsx:364` | `#22c55e` | `dotSuccess` | PIN accepted |
| `apps/dashboard/src/pages/pos/POSLoginScreen.tsx:364` | `#22c55e` | `dotSuccess` | PIN accepted |
| `apps/dashboard/src/pages/pos/POSLoginScreen.tsx:364` | `rgba(34,197,94,0.5)` | `dotSuccess` | PIN accepted |
| `apps/dashboard/src/pages/pos/POSLoginScreen.tsx:367` | `#4ade80` | `successText` | success message |
| `apps/dashboard/src/pages/pos/POSOrderHistoryTab.tsx:39` | `#22c55e` | `STATUS_COLOR` | status wording |
| `apps/dashboard/src/pages/pos/ParkingPOS.tsx:243` | `#22c55e` | `checkoutAmount` | status wording |
| `apps/dashboard/src/pages/pos/ParkingPOS.tsx:264` | `#22c55e` | `—` | occupancy level |
| `apps/dashboard/src/pages/pos/ParkingPOS.tsx:366` | `#22c55e` | `overstay` | status wording |
| `apps/dashboard/src/pages/pos/ParkingPOS.tsx:434` | `#22c55e` | `overstay` | status wording |
| `apps/dashboard/src/pages/pos/ParkingPOS.tsx:741` | `rgba(34,197,94,0.06)` | `bayFree` | free bay |
| `apps/dashboard/src/pages/pos/ParkingPOS.tsx:741` | `rgba(34,197,94,0.2)` | `bayFree` | free bay |
| `apps/dashboard/src/pages/pos/ParkingPOS.tsx:749` | `#22c55e` | `bayFreeLabel` | free bay |
| `apps/dashboard/src/pages/pos/PetrolPOS.tsx:228` | `#22c55e` | `canConfirm` | idle-pumps count |
| `apps/dashboard/src/pages/pos/ShiftModal.tsx:345` | `#22c55e` | `—` | cash variance OK / over |
| `apps/dashboard/src/pages/pos/ShiftModal.tsx:347` | `#22c55e` | `—` | cash variance OK / over |
| `apps/dashboard/src/pages/pos/ShiftModal.tsx:363` | `#86efac` | `—` | cash variance OK / over |
| `apps/dashboard/src/pages/pos/SplitPaymentPanel.tsx:152` | `#22c55e` | `availableMethods` | can charge / over / remaining |
| `apps/dashboard/src/pages/pos/SplitPaymentPanel.tsx:152` | `#3b82f6` | `availableMethods` | can charge / over / remaining |
| `apps/dashboard/src/pages/pos/ZReportModal.tsx:414` | `#4ade80` | `variance` | variance |
| `apps/dashboard/src/pages/pos/ZReportModal.tsx:423` | `#4ade80` | `variance` | variance |

## Money — keeps its colour (15)

| File:line (at `352dded`) | Colour | Style | Why |
|---|---|---|---|
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:1560` | `#22c55e` | `—` | discount / total amount |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:1561` | `#22c55e` | `—` | discount / total amount |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:1750` | `#22c55e` | `—` | discount / total amount |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:2535` | `#22c55e` | `productPrice` | price |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:2673` | `#22c55e` | `variantOptionPrice` | price |
| `apps/dashboard/src/pages/pos/MinimartPOS.tsx:1111` | `#22c55e` | `productPrice` | price |
| `apps/dashboard/src/pages/pos/MinimartPOS.tsx:1316` | `#22c55e` | `modalTotal` | total |
| `apps/dashboard/src/pages/pos/MinimartPOS.tsx:1318` | `rgba(34,197,94,0.06)` | `modalTotal` | total |
| `apps/dashboard/src/pages/pos/MinimartPOS.tsx:1319` | `rgba(34,197,94,0.15)` | `modalTotal` | total |
| `apps/dashboard/src/pages/pos/MinimartPOS.tsx:1386` | `#22c55e` | `notFoundResultPrice` | price |
| `apps/dashboard/src/pages/pos/POSCustomersTab.tsx:143` | `#22c55e` | `—` | loyalty points |
| `apps/dashboard/src/pages/pos/POSCustomersTab.tsx:215` | `#22c55e` | `pointsNum` | loyalty points figure |
| `apps/dashboard/src/pages/pos/POSOrderHistoryTab.tsx:156` | `#22c55e` | `—` | order total |
| `apps/dashboard/src/pages/pos/SplitPaymentPanel.tsx:170` | `#22c55e` | `Allocated` | allocated amount |
| `apps/dashboard/src/pages/pos/ZReportModal.tsx:372` | `#4ade80` | `—` | net profit |

## Data / identity colour — keeps its colour (zones, fuel grades, payment methods, report charts, info panels) (18)

| File:line (at `352dded`) | Colour | Style | Why |
|---|---|---|---|
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:49` | `#2563eb` | `ZONE_COLORS` | table-zone identity colour |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:50` | `#16a34a` | `ZONE_COLORS` | table-zone identity colour |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:50` | `#86efac` | `ZONE_COLORS` | table-zone identity colour |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:2472` | `rgba(34,197,94,0.05)` | `barcodeHint` | decorative hint panel |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:2559` | `rgba(59,130,246,0.08)` | `parkingBillBox` | information panel |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx:2559` | `rgba(59,130,246,0.15)` | `parkingBillBox` | information panel |
| `apps/dashboard/src/pages/pos/POSReportsTab.tsx:99` | `#22c55e` | `—` | report stat accent |
| `apps/dashboard/src/pages/pos/POSReportsTab.tsx:100` | `#3b82f6` | `—` | report stat accent |
| `apps/dashboard/src/pages/pos/POSReportsTab.tsx:138` | `#3b82f6` | `pct` | report bar |
| `apps/dashboard/src/pages/pos/POSReportsTab.tsx:192` | `#22c55e` | `barFill` | report bar |
| `apps/dashboard/src/pages/pos/PetrolPOS.tsx:111` | `#3b82f6` | `GRADE_COLOURS` | fuel-grade identity colour |
| `apps/dashboard/src/pages/pos/PetrolPOS.tsx:112` | `#22c55e` | `GRADE_COLOURS` | fuel-grade identity colour |
| `apps/dashboard/src/pages/pos/PetrolPOS.tsx:267` | `#3b82f6` | `colour` | fuel-grade identity colour |
| `apps/dashboard/src/pages/pos/SplitPaymentPanel.tsx:60` | `#22c55e` | `cash` | payment-method identity colour |
| `apps/dashboard/src/pages/pos/SplitPaymentPanel.tsx:62` | `#3b82f6` | `card` | payment-method identity colour |
| `apps/dashboard/src/pages/pos/cashier/types.ts:112` | `#2563eb` | `ZONE_COLORS` | table-zone identity colour |
| `apps/dashboard/src/pages/pos/cashier/types.ts:113` | `#16a34a` | `ZONE_COLORS` | table-zone identity colour |
| `apps/dashboard/src/pages/pos/cashier/types.ts:113` | `#86efac` | `ZONE_COLORS` | table-zone identity colour |

## Third-party brand — keeps its colour (M-Pesa) (13)

| File:line (at `352dded`) | Colour | Style | Why |
|---|---|---|---|
| `apps/dashboard/src/pages/pos/MpesaStkPanel.tsx:226` | `#22c55e` | `—` | M-Pesa brand colour |
| `apps/dashboard/src/pages/pos/MpesaStkPanel.tsx:285` | `#3b82f6` | `spinner` | M-Pesa brand colour |
| `apps/dashboard/src/pages/pos/MpesaStkPanel.tsx:300` | `#16a34a` | `btnConfirm` | M-Pesa brand colour |
| `apps/dashboard/src/pages/pos/MpesaStkPanel.tsx:300` | `#22c55e` | `btnConfirm` | M-Pesa brand colour |
| `apps/dashboard/src/pages/pos/MpesaStkPanel.tsx:306` | `#60a5fa` | `linkBtn` | M-Pesa brand colour |
| `apps/dashboard/src/pages/pos/MpesaStkPanel.tsx:310` | `rgba(34,197,94,0.1)` | `pulseRing` | M-Pesa brand colour |
| `apps/dashboard/src/pages/pos/MpesaStkPanel.tsx:310` | `rgba(34,197,94,0.3)` | `pulseRing` | M-Pesa brand colour |
| `apps/dashboard/src/pages/pos/MpesaStkPanel.tsx:313` | `#22c55e` | `waitingAmount` | M-Pesa brand colour |
| `apps/dashboard/src/pages/pos/MpesaStkPanel.tsx:321` | `rgba(34,197,94,0.15)` | `successIcon` | M-Pesa brand colour |
| `apps/dashboard/src/pages/pos/MpesaStkPanel.tsx:321` | `rgba(34,197,94,0.4)` | `successIcon` | M-Pesa brand colour |
| `apps/dashboard/src/pages/pos/MpesaStkPanel.tsx:321` | `#22c55e` | `successIcon` | M-Pesa brand colour |
| `apps/dashboard/src/pages/pos/MpesaStkPanel.tsx:322` | `#22c55e` | `successTitle` | M-Pesa brand colour |
| `apps/dashboard/src/pages/pos/SplitPaymentPanel.tsx:61` | `#16a34a` | `mpesa` | M-Pesa brand colour |
