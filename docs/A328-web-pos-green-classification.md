# A328 — the web POS + shared components: 81 green uses, classified (Phase 2 slice 4b-1)

Every green Tailwind class in `apps/dashboard/src/pages/pos`, `components` and `layouts` at `15bb4d3`, classified BEFORE any screen
changes (owner approved the 4b split 2026-09-25: web POS + shared components first; the ~606 back-office uses later, after a product
decision on whether back-office screens take the client's theme). **With themes OFF nothing changes.** With themes ON: *action* takes
the theme — the 500/400 shades in dark mode and the proposal's darker 600/700 in light mode (the dashboard is dark-first); *status* and
*money* stay green.

Same method as A326: extracted with context; 52 settled by explicit rules; 29 reviewed by hand; the risky direction (status → action)
audited — none. No line mixes categories.

| Category | Uses |
|---|---|
| Action — takes the theme colour (`action-*`) | 67 |
| Status — stays green | 10 |
| Money — stays green | 4 |
| **Total** | **81** |

## Action — takes the theme colour (`action-*`) (67)

| File:line (at `15bb4d3`) | Class | Why |
|---|---|---|
| `apps/dashboard/src/components/BranchSelector.tsx:22` | `focus:border-green-500` | focus ring = active state |
| `apps/dashboard/src/components/DashboardLayout.tsx:191` | `text-green-400` | reviewed: selected option, link, active nav, spinner or unread marker |
| `apps/dashboard/src/components/DashboardLayout.tsx:199` | `text-green-400` | reviewed: selected option, link, active nav, spinner or unread marker |
| `apps/dashboard/src/components/DashboardLayout.tsx:212` | `bg-green-500/10` | selected/active-state styling |
| `apps/dashboard/src/components/DashboardLayout.tsx:212` | `text-green-400` | selected/active-state styling |
| `apps/dashboard/src/components/DashboardLayout.tsx:432` | `text-green-500` | reviewed: selected option, link, active nav, spinner or unread marker |
| `apps/dashboard/src/components/DashboardLayout.tsx:432` | `hover:text-green-400` | fill/hover on a pressable control |
| `apps/dashboard/src/components/DashboardLayout.tsx:445` | `bg-green-500/5` | fill/hover on a pressable control |
| `apps/dashboard/src/components/DashboardLayout.tsx:450` | `bg-green-500` | reviewed: selected option, link, active nav, spinner or unread marker |
| `apps/dashboard/src/components/DashboardLayout.tsx:480` | `bg-green-500/10` | selected/active-state styling |
| `apps/dashboard/src/components/DashboardLayout.tsx:480` | `text-green-400` | selected/active-state styling |
| `apps/dashboard/src/components/ErrorBoundary.tsx:65` | `bg-green-500` | fill/hover on a pressable control |
| `apps/dashboard/src/components/ErrorBoundary.tsx:65` | `hover:bg-green-400` | fill/hover on a pressable control |
| `apps/dashboard/src/components/ProtectedRoute.tsx:21` | `border-green-500/60` | reviewed: selected option, link, active nav, spinner or unread marker |
| `apps/dashboard/src/pages/pos/ByItemSplitPanel.tsx:128` | `bg-green-500/10` | fill/hover on a pressable control |
| `apps/dashboard/src/pages/pos/ByItemSplitPanel.tsx:128` | `border-green-500` | reviewed: selected option, link, active nav, spinner or unread marker |
| `apps/dashboard/src/pages/pos/ByItemSplitPanel.tsx:128` | `text-green-400` | reviewed: selected option, link, active nav, spinner or unread marker |
| `apps/dashboard/src/pages/pos/ByItemSplitPanel.tsx:155` | `bg-green-500/10` | fill/hover on a pressable control |
| `apps/dashboard/src/pages/pos/ByItemSplitPanel.tsx:155` | `border-green-500` | reviewed: selected option, link, active nav, spinner or unread marker |
| `apps/dashboard/src/pages/pos/ByItemSplitPanel.tsx:155` | `text-green-400` | reviewed: selected option, link, active nav, spinner or unread marker |
| `apps/dashboard/src/pages/pos/ByItemSplitPanel.tsx:189` | `bg-green-600` | fill/hover on a pressable control |
| `apps/dashboard/src/pages/pos/DiscountPanel.tsx:95` | `focus:border-green-500` | focus ring = active state |
| `apps/dashboard/src/pages/pos/DiscountPanel.tsx:101` | `bg-green-500` | fill/hover on a pressable control |
| `apps/dashboard/src/pages/pos/DiscountPanel.tsx:101` | `hover:bg-green-400` | fill/hover on a pressable control |
| `apps/dashboard/src/pages/pos/EvenSplitPanel.tsx:110` | `bg-green-500/10` | fill/hover on a pressable control |
| `apps/dashboard/src/pages/pos/EvenSplitPanel.tsx:110` | `border-green-500` | reviewed: selected option, link, active nav, spinner or unread marker |
| `apps/dashboard/src/pages/pos/EvenSplitPanel.tsx:110` | `text-green-400` | reviewed: selected option, link, active nav, spinner or unread marker |
| `apps/dashboard/src/pages/pos/EvenSplitPanel.tsx:142` | `bg-green-600` | fill/hover on a pressable control |
| `apps/dashboard/src/pages/pos/LoyaltyPanel.tsx:168` | `text-green-500` | reviewed: selected option, link, active nav, spinner or unread marker |
| `apps/dashboard/src/pages/pos/LoyaltyPanel.tsx:168` | `hover:text-green-400` | fill/hover on a pressable control |
| `apps/dashboard/src/pages/pos/LoyaltyPanel.tsx:180` | `focus:border-green-500` | focus ring = active state |
| `apps/dashboard/src/pages/pos/LoyaltyPanel.tsx:216` | `focus:border-green-500` | focus ring = active state |
| `apps/dashboard/src/pages/pos/LoyaltyPanel.tsx:222` | `bg-green-500` | fill/hover on a pressable control |
| `apps/dashboard/src/pages/pos/LoyaltyPanel.tsx:222` | `hover:bg-green-400` | fill/hover on a pressable control |
| `apps/dashboard/src/pages/pos/LoyaltyPanel.tsx:237` | `focus:border-green-500` | focus ring = active state |
| `apps/dashboard/src/pages/pos/LoyaltyPanel.tsx:243` | `bg-green-500` | fill/hover on a pressable control |
| `apps/dashboard/src/pages/pos/LoyaltyPanel.tsx:243` | `hover:bg-green-400` | fill/hover on a pressable control |
| `apps/dashboard/src/pages/pos/PaymentModal.tsx:577` | `bg-green-500` | fill/hover on a pressable control |
| `apps/dashboard/src/pages/pos/PaymentModal.tsx:577` | `hover:bg-green-400` | fill/hover on a pressable control |
| `apps/dashboard/src/pages/pos/PaymentModal.tsx:655` | `bg-green-500` | fill/hover on a pressable control |
| `apps/dashboard/src/pages/pos/PaymentModal.tsx:664` | `bg-green-500` | fill/hover on a pressable control |
| `apps/dashboard/src/pages/pos/PaymentModal.tsx:683` | `bg-green-500` | fill/hover on a pressable control |
| `apps/dashboard/src/pages/pos/PaymentModal.tsx:719` | `bg-green-500/10` | fill/hover on a pressable control |
| `apps/dashboard/src/pages/pos/PaymentModal.tsx:719` | `border-green-500` | reviewed: selected option, link, active nav, spinner or unread marker |
| `apps/dashboard/src/pages/pos/PaymentModal.tsx:719` | `text-green-400` | reviewed: selected option, link, active nav, spinner or unread marker |
| `apps/dashboard/src/pages/pos/PaymentModal.tsx:731` | `bg-green-500/10` | fill/hover on a pressable control |
| `apps/dashboard/src/pages/pos/PaymentModal.tsx:731` | `border-green-500` | reviewed: selected option, link, active nav, spinner or unread marker |
| `apps/dashboard/src/pages/pos/PaymentModal.tsx:731` | `text-green-400` | reviewed: selected option, link, active nav, spinner or unread marker |
| `apps/dashboard/src/pages/pos/PaymentModal.tsx:757` | `bg-green-500/10` | fill/hover on a pressable control |
| `apps/dashboard/src/pages/pos/PaymentModal.tsx:757` | `border-green-500` | selected/active-state styling |
| `apps/dashboard/src/pages/pos/PaymentModal.tsx:757` | `text-green-400` | selected/active-state styling |
| `apps/dashboard/src/pages/pos/PaymentModal.tsx:794` | `bg-green-500/10` | fill/hover on a pressable control |
| `apps/dashboard/src/pages/pos/PaymentModal.tsx:794` | `border-green-500` | reviewed: selected option, link, active nav, spinner or unread marker |
| `apps/dashboard/src/pages/pos/PaymentModal.tsx:794` | `text-green-400` | reviewed: selected option, link, active nav, spinner or unread marker |
| `apps/dashboard/src/pages/pos/PaymentModal.tsx:805` | `focus:border-green-500` | focus ring = active state |
| `apps/dashboard/src/pages/pos/PaymentModal.tsx:898` | `bg-green-500` | fill/hover on a pressable control |
| `apps/dashboard/src/pages/pos/PaymentModal.tsx:898` | `hover:bg-green-400` | fill/hover on a pressable control |
| `apps/dashboard/src/pages/pos/PaymentModal.tsx:907` | `bg-green-500` | fill/hover on a pressable control |
| `apps/dashboard/src/pages/pos/PaymentModal.tsx:907` | `hover:bg-green-400` | fill/hover on a pressable control |
| `apps/dashboard/src/pages/pos/PrinterSettingsModal.tsx:42` | `bg-green-500` | fill/hover on a pressable control |
| `apps/dashboard/src/pages/pos/PrinterSettingsModal.tsx:57` | `bg-green-500` | fill/hover on a pressable control |
| `apps/dashboard/src/pages/pos/PrinterSettingsModal.tsx:127` | `focus:border-green-500` | focus ring = active state |
| `apps/dashboard/src/pages/pos/PrinterSettingsModal.tsx:136` | `text-green-400` | reviewed: selected option, link, active nav, spinner or unread marker |
| `apps/dashboard/src/pages/pos/PrinterSettingsModal.tsx:150` | `bg-green-500` | fill/hover on a pressable control |
| `apps/dashboard/src/pages/pos/PrinterSettingsModal.tsx:150` | `hover:bg-green-400` | fill/hover on a pressable control |
| `apps/dashboard/src/pages/pos/TableTurnoverPage.tsx:68` | `bg-green-600` | reviewed: selected option, link, active nav, spinner or unread marker |
| `apps/dashboard/src/pages/pos/TableTurnoverPage.tsx:72` | `bg-green-600` | fill/hover on a pressable control |

## Status — stays green (10)

| File:line (at `15bb4d3`) | Class | Why |
|---|---|---|
| `apps/dashboard/src/components/Toast.tsx:23` | `bg-green-500/15` | success/paid/online wording nearby |
| `apps/dashboard/src/components/Toast.tsx:23` | `border-green-500/40` | success/paid/online wording nearby |
| `apps/dashboard/src/components/Toast.tsx:23` | `text-green-300` | success/paid/online wording nearby |
| `apps/dashboard/src/pages/pos/DiscountPanel.tsx:58` | `bg-green-500/10` | reviewed: applied / sufficient-credit state |
| `apps/dashboard/src/pages/pos/DiscountPanel.tsx:58` | `border-green-500/20` | reviewed: applied / sufficient-credit state |
| `apps/dashboard/src/pages/pos/DiscountPanel.tsx:60` | `text-green-400` | reviewed: applied / sufficient-credit state |
| `apps/dashboard/src/pages/pos/PaymentModal.tsx:489` | `text-green-400` | success/paid/online wording nearby |
| `apps/dashboard/src/pages/pos/PaymentModal.tsx:500` | `text-green-400` | success/paid/online wording nearby |
| `apps/dashboard/src/pages/pos/PaymentModal.tsx:624` | `text-green-400` | reviewed: applied / sufficient-credit state |
| `apps/dashboard/src/pages/pos/PaymentModal.tsx:863` | `text-green-400` | reviewed: applied / sufficient-credit state |

## Money — stays green (4)

| File:line (at `15bb4d3`) | Class | Why |
|---|---|---|
| `apps/dashboard/src/pages/pos/DiscountPanel.tsx:62` | `text-green-500/70` | reviewed: an amount or a discount code line |
| `apps/dashboard/src/pages/pos/DiscountPanel.tsx:66` | `text-green-400` | reviewed: an amount or a discount code line |
| `apps/dashboard/src/pages/pos/LoyaltyPanel.tsx:183` | `text-green-400` | reviewed: an amount or a discount code line |
| `apps/dashboard/src/pages/pos/PaymentModal.tsx:746` | `text-green-400` | reviewed: an amount or a discount code line |
