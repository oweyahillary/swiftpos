# A326 — the till's 222 green uses, classified (client branding Phase 2, slice 3)

Every green Tailwind class in `apps/desktop/src/renderer` at `b69eeca` (v0.6.5), classified BEFORE any screen changed (owner approved
2026-09-24). **With themes OFF nothing changes** — `action-*` and `brand-*` default to Tailwind's exact greens (proven in Chromium: all
23 distinct utilities render identically). With themes ON: *action* takes the theme; *brand* takes the business's own colour; *status*,
*money* and the *SwiftPOS wordmark* stay green. `scripts/check-till-green.mjs` keeps it that way (per-file ratchet, baseline
`scripts/till-green-baseline.json`).

How it was built: an extractor found every green class with its surrounding code; a first-pass classifier settled 134 by explicit rules
(focus rings; checkbox/radio accents; fills on pressable controls; selected-state ternaries; success wording nearby); the other 88 were
reviewed by hand. The risky direction — a *status* green wrongly called *action* — was audited separately: none found. One correction after
the owner's review: the PIN page's 7 greens are dialog buttons and input focus rings (its own accent is already brand-driven by Phase 1
inline styles) → *action*, not *brand*. The 154 changes were applied by script from this list (154 classified, 154 rewritten).

| Category | Uses |
|---|---|
| Action — takes the theme colour (`action-*`) | 150 |
| Brand — takes the business's own colour (`brand-*`; the in-app lock curtain) | 4 |
| Status — stays green | 59 |
| Money — stays green (never the theme's to change) | 7 |
| SwiftPOS wordmark — stays green | 2 |
| **Total** | **222** |

## Action — takes the theme colour (`action-*`) (150)

| File:line (at `b69eeca`) | Class | Why |
|---|---|---|
| `App.tsx:123` | `border-green-400` | reviewed: pressable, selected, link or active state |
| `components/ChoicesEditor.tsx:161` | `bg-green-500/15` | fill/hover on a pressable control |
| `components/ChoicesEditor.tsx:161` | `text-green-400` | selected/active-state styling |
| `components/ExclusionsPanel.tsx:179` | `bg-green-500` | fill/hover on a pressable control |
| `components/ExclusionsPanel.tsx:179` | `hover:bg-green-400` | fill/hover on a pressable control |
| `components/HeldOrdersModal.tsx:64` | `bg-green-500` | fill/hover on a pressable control |
| `components/HeldOrdersModal.tsx:64` | `hover:bg-green-400` | fill/hover on a pressable control |
| `components/OpenDrawerModal.tsx:122` | `focus:border-green-500` | focus ring on an input = active state |
| `components/OpenDrawerModal.tsx:137` | `bg-green-600` | fill/hover on a pressable control |
| `components/OpenDrawerModal.tsx:137` | `hover:bg-green-500` | fill/hover on a pressable control |
| `components/PaperWidthControl.tsx:54` | `bg-green-500/10` | reviewed: pressable, selected, link or active state |
| `components/PaperWidthControl.tsx:54` | `text-green-400` | reviewed: pressable, selected, link or active state |
| `components/PaymentMethodsPanel.tsx:76` | `focus:border-green-500` | focus ring on an input = active state |
| `components/PaymentMethodsPanel.tsx:81` | `bg-green-500` | fill/hover on a pressable control |
| `components/PaymentMethodsPanel.tsx:81` | `hover:bg-green-400` | fill/hover on a pressable control |
| `components/PaymentMethodsPanel.tsx:104` | `text-green-400` | selected/active-state styling |
| `components/PaymentMethodsPanel.tsx:104` | `border-green-500/30` | selected/active-state styling |
| `components/PaymentMethodsPanel.tsx:104` | `hover:border-green-500/60` | fill/hover on a pressable control |
| `components/PaymentModal.tsx:185` | `focus:border-green-500` | focus ring on an input = active state |
| `components/PaymentModal.tsx:211` | `focus:border-green-500` | focus ring on an input = active state |
| `components/PaymentModal.tsx:230` | `bg-green-500/10` | fill/hover on a pressable control |
| `components/PaymentModal.tsx:230` | `border-green-500` | selected/active-state styling |
| `components/PaymentModal.tsx:230` | `text-green-400` | selected/active-state styling |
| `components/PaymentModal.tsx:248` | `focus:border-green-500` | focus ring on an input = active state |
| `components/PaymentModal.tsx:258` | `focus:border-green-500` | focus ring on an input = active state |
| `components/PaymentModal.tsx:270` | `focus:border-green-500` | focus ring on an input = active state |
| `components/PaymentModal.tsx:286` | `text-green-400` | reviewed: pressable, selected, link or active state |
| `components/PaymentModal.tsx:286` | `hover:text-green-300` | fill/hover on a pressable control |
| `components/PaymentModal.tsx:302` | `bg-green-500` | fill/hover on a pressable control |
| `components/PaymentModal.tsx:302` | `hover:bg-green-400` | fill/hover on a pressable control |
| `components/PrinterSettingsModal.tsx:134` | `focus:border-green-500` | focus ring on an input = active state |
| `components/PrinterSettingsModal.tsx:185` | `text-green-400` | reviewed: pressable, selected, link or active state |
| `components/PrinterSettingsModal.tsx:185` | `hover:text-green-300` | fill/hover on a pressable control |
| `components/PrinterSettingsModal.tsx:217` | `border-green-500` | reviewed: pressable, selected, link or active state |
| `components/PrinterSettingsModal.tsx:217` | `text-green-400` | success/paid/online wording nearby |
| `components/PrinterSettingsModal.tsx:259` | `bg-green-500/10` | fill/hover on a pressable control |
| `components/PrinterSettingsModal.tsx:259` | `text-green-400` | selected/active-state styling |
| `components/PrinterSettingsModal.tsx:268` | `border-green-500` | reviewed: pressable, selected, link or active state |
| `components/PrinterSettingsModal.tsx:268` | `text-green-400` | reviewed: pressable, selected, link or active state |
| `components/PrinterSettingsModal.tsx:268` | `bg-green-500/10` | fill/hover on a pressable control |
| `components/PrinterSettingsModal.tsx:283` | `focus:border-green-500` | focus ring on an input = active state |
| `components/PrinterSettingsModal.tsx:294` | `bg-green-500` | reviewed: pressable, selected, link or active state |
| `components/PrinterSettingsModal.tsx:294` | `hover:bg-green-400` | reviewed: pressable, selected, link or active state |
| `components/PumpsView.tsx:88` | `hover:border-green-500` | reviewed: pressable, selected, link or active state |
| `components/PumpsView.tsx:133` | `focus:border-green-500` | focus ring on an input = active state |
| `components/PumpsView.tsx:143` | `focus:border-green-500` | focus ring on an input = active state |
| `components/PumpsView.tsx:151` | `hover:border-green-500` | fill/hover on a pressable control |
| `components/PumpsView.tsx:173` | `bg-green-500` | fill/hover on a pressable control |
| `components/PumpsView.tsx:173` | `hover:bg-green-400` | fill/hover on a pressable control |
| `components/PumpsView.tsx:173` | `disabled:hover:bg-green-500` | fill/hover on a pressable control |
| `components/ReportRangeBar.tsx:97` | `bg-green-500/10` | fill/hover on a pressable control |
| `components/ReportRangeBar.tsx:97` | `text-green-400` | selected/active-state styling |
| `components/ReportRangeBar.tsx:128` | `bg-green-600/80` | fill/hover on a pressable control |
| `components/ReportRangeBar.tsx:129` | `hover:bg-green-600` | fill/hover on a pressable control |
| `components/SettingsPanel.tsx:60` | `bg-green-500` | reviewed: pressable, selected, link or active state |
| `components/StationsPanel.tsx:177` | `bg-green-500` | fill/hover on a pressable control |
| `components/StationsPanel.tsx:177` | `hover:bg-green-400` | fill/hover on a pressable control |
| `components/StationsPanel.tsx:235` | `bg-green-500/15` | fill/hover on a pressable control |
| `components/StationsPanel.tsx:235` | `border-green-500/40` | reviewed: pressable, selected, link or active state |
| `components/StationsPanel.tsx:235` | `text-green-300` | reviewed: pressable, selected, link or active state |
| `components/StationsPanel.tsx:306` | `bg-green-600` | fill/hover on a pressable control |
| `components/StationsPanel.tsx:306` | `hover:bg-green-500` | fill/hover on a pressable control |
| `components/TablesView.tsx:104` | `bg-green-500/10` | fill/hover on a pressable control |
| `components/TablesView.tsx:104` | `text-green-400` | selected/active-state styling |
| `components/VariantModal.tsx:86` | `border-green-400` | reviewed: pressable, selected, link or active state |
| `components/VariantModal.tsx:103` | `border-green-500` | selected/active-state styling |
| `components/VariantModal.tsx:103` | `bg-green-500/10` | fill/hover on a pressable control |
| `components/VariantModal.tsx:105` | `border-green-500` | selected/active-state styling |
| `components/VariantModal.tsx:106` | `bg-green-500` | reviewed: pressable, selected, link or active state |
| `components/VariantModal.tsx:137` | `border-green-500` | selected/active-state styling |
| `components/VariantModal.tsx:137` | `bg-green-500/10` | fill/hover on a pressable control |
| `components/VariantModal.tsx:139` | `border-green-500` | selected/active-state styling |
| `components/VariantModal.tsx:139` | `bg-green-500` | fill/hover on a pressable control |
| `components/VariantModal.tsx:164` | `bg-green-500` | fill/hover on a pressable control |
| `components/VariantModal.tsx:164` | `hover:bg-green-400` | fill/hover on a pressable control |
| `pages/DayCloseTab.tsx:308` | `bg-green-600` | fill/hover on a pressable control |
| `pages/DayCloseTab.tsx:308` | `hover:bg-green-500` | fill/hover on a pressable control |
| `pages/InstallPage.tsx:242` | `border-green-500` | selected/active-state styling |
| `pages/InstallPage.tsx:242` | `bg-green-500/10` | fill/hover on a pressable control |
| `pages/InstallPage.tsx:244` | `text-green-400` | selected/active-state styling |
| `pages/InstallPage.tsx:249` | `focus:border-green-500` | focus ring on an input = active state |
| `pages/InstallPage.tsx:293` | `text-green-400` | reviewed: pressable, selected, link or active state |
| `pages/InstallPage.tsx:293` | `hover:text-green-300` | fill/hover on a pressable control |
| `pages/InstallPage.tsx:306` | `bg-green-500` | reviewed: pressable, selected, link or active state |
| `pages/InstallPage.tsx:306` | `hover:bg-green-400` | reviewed: pressable, selected, link or active state |
| `pages/InstallPage.tsx:345` | `bg-green-500` | fill/hover on a pressable control |
| `pages/InstallPage.tsx:345` | `hover:bg-green-400` | fill/hover on a pressable control |
| `pages/InstallPage.tsx:432` | `accent-green-500` | checkbox/radio accent = the control itself |
| `pages/InstallPage.tsx:496` | `bg-green-500` | fill/hover on a pressable control |
| `pages/InstallPage.tsx:496` | `hover:bg-green-400` | fill/hover on a pressable control |
| `pages/ManageTabs.tsx:25` | `focus:border-green-500` | focus ring on an input = active state |
| `pages/ManageTabs.tsx:28` | `bg-green-500` | reviewed: pressable, selected, link or active state |
| `pages/ManageTabs.tsx:28` | `hover:bg-green-400` | reviewed: pressable, selected, link or active state |
| `pages/ManageTabs.tsx:247` | `border-green-700` | reviewed: pressable, selected, link or active state |
| `pages/ManageTabs.tsx:247` | `text-green-400` | reviewed: pressable, selected, link or active state |
| `pages/ManageTabs.tsx:306` | `border-green-500` | reviewed: pressable, selected, link or active state |
| `pages/ManageTabs.tsx:306` | `text-green-400` | reviewed: pressable, selected, link or active state |
| `pages/ManageTabs.tsx:321` | `border-green-500` | reviewed: pressable, selected, link or active state |
| `pages/ManageTabs.tsx:321` | `text-green-400` | reviewed: pressable, selected, link or active state |
| `pages/ManageTabs.tsx:1417` | `text-green-400` | reviewed: pressable, selected, link or active state |
| `pages/ManageTabs.tsx:1417` | `hover:text-green-300` | fill/hover on a pressable control |
| `pages/ManagerPage.tsx:1040` | `border-green-600/50` | reviewed: pressable, selected, link or active state |
| `pages/ManagerPage.tsx:1040` | `text-green-300` | reviewed: pressable, selected, link or active state |
| `pages/MenuWorkbench.tsx:240` | `bg-green-500/10` | fill/hover on a pressable control |
| `pages/MenuWorkbench.tsx:240` | `text-green-400` | selected/active-state styling |
| `pages/MenuWorkbench.tsx:291` | `bg-green-500/5` | fill/hover on a pressable control |
| `pages/MenuWorkbench.tsx:436` | `bg-green-600` | fill/hover on a pressable control |
| `pages/MenuWorkbench.tsx:436` | `hover:bg-green-500` | fill/hover on a pressable control |
| `pages/POSPage.tsx:875` | `bg-green-500` | fill/hover on a pressable control |
| `pages/POSPage.tsx:875` | `hover:bg-green-400` | fill/hover on a pressable control |
| `pages/POSPage.tsx:1014` | `text-green-400` | reviewed: pressable, selected, link or active state |
| `pages/POSPage.tsx:1014` | `hover:text-green-300` | fill/hover on a pressable control |
| `pages/POSPage.tsx:1014` | `border-green-900` | reviewed: pressable, selected, link or active state |
| `pages/POSPage.tsx:1014` | `hover:border-green-700` | fill/hover on a pressable control |
| `pages/POSPage.tsx:1147` | `focus:border-green-500` | focus ring on an input = active state |
| `pages/POSPage.tsx:1154` | `bg-green-500` | reviewed: pressable, selected, link or active state |
| `pages/POSPage.tsx:1180` | `border-green-500/60` | reviewed: pressable, selected, link or active state |
| `pages/POSPage.tsx:1180` | `bg-green-500/5` | reviewed: pressable, selected, link or active state |
| `pages/POSPage.tsx:1183` | `bg-green-500` | reviewed: pressable, selected, link or active state |
| `pages/POSPage.tsx:1234` | `bg-green-500/10` | fill/hover on a pressable control |
| `pages/POSPage.tsx:1234` | `text-green-400` | selected/active-state styling |
| `pages/POSPage.tsx:1250` | `focus:border-green-500` | focus ring on an input = active state |
| `pages/POSPage.tsx:1260` | `focus:border-green-500` | focus ring on an input = active state |
| `pages/POSPage.tsx:1265` | `bg-green-500/10` | reviewed: pressable, selected, link or active state |
| `pages/POSPage.tsx:1265` | `border-green-500/40` | reviewed: pressable, selected, link or active state |
| `pages/POSPage.tsx:1265` | `text-green-400` | reviewed: pressable, selected, link or active state |
| `pages/POSPage.tsx:1274` | `focus:border-green-500` | focus ring on an input = active state |
| `pages/POSPage.tsx:1371` | `bg-green-500` | reviewed: pressable, selected, link or active state |
| `pages/POSPage.tsx:1371` | `hover:bg-green-400` | reviewed: pressable, selected, link or active state |
| `pages/PinPage.tsx:193` | `focus:border-green-500` | PIN-screen dialog button / input focus (the PIN screen's own accent is already brand-driven by Phase 1 inline styles) |
| `pages/PinPage.tsx:199` | `bg-green-500` | PIN-screen dialog button / input focus (the PIN screen's own accent is already brand-driven by Phase 1 inline styles) |
| `pages/PinPage.tsx:199` | `hover:bg-green-400` | PIN-screen dialog button / input focus (the PIN screen's own accent is already brand-driven by Phase 1 inline styles) |
| `pages/PinPage.tsx:212` | `focus:border-green-500` | PIN-screen dialog button / input focus (the PIN screen's own accent is already brand-driven by Phase 1 inline styles) |
| `pages/PinPage.tsx:218` | `bg-green-500` | PIN-screen dialog button / input focus (the PIN screen's own accent is already brand-driven by Phase 1 inline styles) |
| `pages/PinPage.tsx:218` | `hover:bg-green-400` | PIN-screen dialog button / input focus (the PIN screen's own accent is already brand-driven by Phase 1 inline styles) |
| `pages/PinPage.tsx:269` | `focus:border-green-500` | PIN-screen dialog button / input focus (the PIN screen's own accent is already brand-driven by Phase 1 inline styles) |
| `pages/PrintersTab.tsx:412` | `accent-green-500` | checkbox/radio accent = the control itself |
| `pages/ShiftPanel.tsx:154` | `focus:border-green-500` | focus ring on an input = active state |
| `pages/ShiftPanel.tsx:175` | `border-green-500` | reviewed: pressable, selected, link or active state |
| `pages/ShiftPanel.tsx:201` | `bg-green-500` | reviewed: pressable, selected, link or active state |
| `pages/ShiftPanel.tsx:201` | `hover:bg-green-400` | reviewed: pressable, selected, link or active state |
| `pages/ShiftPanel.tsx:217` | `bg-green-500` | fill/hover on a pressable control |
| `pages/ShiftPanel.tsx:217` | `hover:bg-green-400` | fill/hover on a pressable control |
| `pages/ShiftPanel.tsx:236` | `bg-green-500` | fill/hover on a pressable control |
| `pages/ShiftPanel.tsx:357` | `bg-green-500` | fill/hover on a pressable control |
| `pages/ShiftPanel.tsx:357` | `hover:bg-green-400` | fill/hover on a pressable control |
| `pages/UpdateBanner.tsx:94` | `bg-green-700` | fill/hover on a pressable control |
| `pages/UpdateBanner.tsx:94` | `hover:bg-green-600` | fill/hover on a pressable control |
| `screens/PrinterSetupScreen.tsx:166` | `accent-green-500` | checkbox/radio accent = the control itself |
| `screens/PrintersScreen.tsx:73` | `border-green-500` | reviewed: pressable, selected, link or active state |

## Brand — takes the business's own colour (`brand-*`; the in-app lock curtain) (4)

| File:line (at `b69eeca`) | Class | Why |
|---|---|---|
| `components/LockCurtain.tsx:133` | `bg-green-400` | lock screen — the business's own colour (brand layer) |
| `components/LockCurtain.tsx:149` | `bg-green-600` | lock screen — the business's own colour (brand layer) |
| `components/LockCurtain.tsx:150` | `hover:bg-green-500` | lock screen — the business's own colour (brand layer) |
| `components/LockCurtain.tsx:150` | `active:bg-green-700` | lock screen — the business's own colour (brand layer) |

## Status — stays green (59)

| File:line (at `b69eeca`) | Class | Why |
|---|---|---|
| `components/ExclusionsPanel.tsx:127` | `text-emerald-400` | success/paid/online wording nearby |
| `components/PaperWidthControl.tsx:23` | `text-green-400` | reviewed: success / online / variance-ok / done state |
| `components/PrinterSettingsModal.tsx:120` | `text-green-400` | success/paid/online wording nearby |
| `components/PrinterSettingsModal.tsx:181` | `bg-green-400` | reviewed: success / online / variance-ok / done state |
| `components/PumpsView.tsx:94` | `bg-green-400` | reviewed: success / online / variance-ok / done state |
| `components/SettingsPanel.tsx:70` | `text-emerald-400` | success/paid/online wording nearby |
| `components/VoidModal.tsx:142` | `bg-green-500/10` | reviewed: success / online / variance-ok / done state |
| `components/VoidModal.tsx:142` | `text-green-400` | reviewed: success / online / variance-ok / done state |
| `components/VoidModal.tsx:142` | `border-green-500/20` | reviewed: success / online / variance-ok / done state |
| `pages/BranchCloseTab.tsx:139` | `bg-green-600/20` | reviewed: success / online / variance-ok / done state |
| `pages/BranchCloseTab.tsx:139` | `text-green-300` | reviewed: success / online / variance-ok / done state |
| `pages/BranchCloseTab.tsx:139` | `border-green-600/40` | reviewed: success / online / variance-ok / done state |
| `pages/BranchCloseTab.tsx:162` | `text-green-300` | reviewed: success / online / variance-ok / done state |
| `pages/DayCloseTab.tsx:142` | `text-green-400` | reviewed: success / online / variance-ok / done state |
| `pages/InstallPage.tsx:298` | `text-green-400` | success/paid/online wording nearby |
| `pages/InstallPage.tsx:298` | `bg-green-400/10` | success/paid/online wording nearby |
| `pages/InstallPage.tsx:298` | `border-green-400/20` | success/paid/online wording nearby |
| `pages/InstallPage.tsx:356` | `text-green-400` | reviewed: success / online / variance-ok / done state |
| `pages/InstallPage.tsx:356` | `bg-green-400/10` | reviewed: success / online / variance-ok / done state |
| `pages/InstallPage.tsx:356` | `border-green-400/20` | reviewed: success / online / variance-ok / done state |
| `pages/ManageTabs.tsx:37` | `bg-green-500/10` | success/paid/online wording nearby |
| `pages/ManageTabs.tsx:37` | `border-green-500/30` | success/paid/online wording nearby |
| `pages/ManageTabs.tsx:37` | `text-green-300` | success/paid/online wording nearby |
| `pages/ManageTabs.tsx:1394` | `bg-green-500/10` | reviewed: success / online / variance-ok / done state |
| `pages/ManageTabs.tsx:1394` | `border-green-500/30` | reviewed: success / online / variance-ok / done state |
| `pages/ManageTabs.tsx:1394` | `text-green-300` | reviewed: success / online / variance-ok / done state |
| `pages/ManagerPage.tsx:311` | `bg-green-500/20` | reviewed: success / online / variance-ok / done state |
| `pages/ManagerPage.tsx:311` | `text-green-400` | reviewed: success / online / variance-ok / done state |
| `pages/ManagerPage.tsx:639` | `bg-green-500/15` | success/paid/online wording nearby |
| `pages/ManagerPage.tsx:639` | `text-green-400` | success/paid/online wording nearby |
| `pages/ManagerPage.tsx:845` | `bg-green-500/10` | success/paid/online wording nearby |
| `pages/ManagerPage.tsx:845` | `text-green-400` | success/paid/online wording nearby |
| `pages/MenuWorkbench.tsx:206` | `bg-green-500/10` | success/paid/online wording nearby |
| `pages/MenuWorkbench.tsx:206` | `border-green-500/30` | success/paid/online wording nearby |
| `pages/MenuWorkbench.tsx:207` | `text-green-300` | success/paid/online wording nearby |
| `pages/POSPage.tsx:830` | `text-green-400` | success/paid/online wording nearby |
| `pages/POSPage.tsx:912` | `bg-green-400` | reviewed: success / online / variance-ok / done state |
| `pages/POSPage.tsx:966` | `bg-green-400` | reviewed: success / online / variance-ok / done state |
| `pages/POSPage.tsx:967` | `text-green-400` | success/paid/online wording nearby |
| `pages/POSPage.tsx:1457` | `text-emerald-400` | success/paid/online wording nearby |
| `pages/POSPage.tsx:1501` | `bg-green-500/15` | success/paid/online wording nearby |
| `pages/POSPage.tsx:1501` | `text-green-400` | success/paid/online wording nearby |
| `pages/PrintersTab.tsx:148` | `text-green-400` | success/paid/online wording nearby |
| `pages/PrintersTab.tsx:267` | `text-green-400` | success/paid/online wording nearby |
| `pages/ShiftPanel.tsx:256` | `text-green-400` | reviewed: success / online / variance-ok / done state |
| `pages/ShiftPanel.tsx:256` | `bg-green-400/10` | reviewed: success / online / variance-ok / done state |
| `pages/ShiftPanel.tsx:256` | `border-green-400/20` | reviewed: success / online / variance-ok / done state |
| `pages/ShiftPanel.tsx:352` | `text-green-400` | reviewed: success / online / variance-ok / done state |
| `pages/TechPage.tsx:212` | `text-green-400` | success/paid/online wording nearby |
| `pages/TechPage.tsx:242` | `text-green-400` | success/paid/online wording nearby |
| `pages/TechPage.tsx:293` | `text-green-400` | reviewed: success / online / variance-ok / done state |
| `pages/TechPage.tsx:314` | `text-green-400` | reviewed: success / online / variance-ok / done state |
| `pages/TechPage.tsx:397` | `text-green-400` | reviewed: success / online / variance-ok / done state |
| `pages/TechPage.tsx:411` | `text-green-400` | success/paid/online wording nearby |
| `pages/UpdateBanner.tsx:69` | `border-green-700/50` | reviewed: success / online / variance-ok / done state |
| `pages/UpdateBanner.tsx:73` | `text-green-400` | reviewed: success / online / variance-ok / done state |
| `pages/UpdateBanner.tsx:78` | `text-green-400` | success/paid/online wording nearby |
| `screens/PrinterSetupScreen.tsx:347` | `bg-emerald-950/60` | reviewed: success / online / variance-ok / done state |
| `screens/PrinterSetupScreen.tsx:347` | `text-emerald-200` | reviewed: success / online / variance-ok / done state |

## Money — stays green (never the theme's to change) (7)

| File:line (at `b69eeca`) | Class | Why |
|---|---|---|
| `components/HeldOrdersModal.tsx:57` | `text-green-400` | reviewed: a price, total or revenue — not the theme's to change |
| `components/PumpsView.tsx:100` | `text-green-400` | reviewed: a price, total or revenue — not the theme's to change |
| `components/VariantModal.tsx:110` | `text-green-400` | reviewed: a price, total or revenue — not the theme's to change |
| `components/VariantModal.tsx:144` | `text-green-400` | reviewed: a price, total or revenue — not the theme's to change |
| `pages/ManagerPage.tsx:307` | `text-green-400` | reviewed: a price, total or revenue — not the theme's to change |
| `pages/ManagerPage.tsx:323` | `text-green-400` | reviewed: a price, total or revenue — not the theme's to change |
| `pages/POSPage.tsx:1198` | `text-green-400` | reviewed: a price, total or revenue — not the theme's to change |

## SwiftPOS wordmark — stays green (2)

| File:line (at `b69eeca`) | Class | Why |
|---|---|---|
| `pages/InstallPage.tsx:257` | `text-green-400` | reviewed: the SwiftPOS wordmark (the product, not the client) |
| `pages/POSPage.tsx:890` | `text-green-400` | reviewed: the SwiftPOS wordmark (the product, not the client) |
