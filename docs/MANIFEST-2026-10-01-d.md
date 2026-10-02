# MANIFEST 2026-10-01-d — desktop 0.6.30 + cloud + dashboard: A336 stage 3 (offline void/refund, the owner's rules)

**Base:** origin/dev `7748aa5`. **Delivered as:** `swiftpos-2026-10-01-v0.6.30.patch` — includes the version bump (apps/desktop and
`shared/release.ts` → 0.6.30). **No migration** (the rules live in `business_settings`). Local till schema **61**.

Owner, 2026-10-01: "Void window yes let it remain 30 min but i thing we can add a feature for owner to either increase or reduce
the threshold but default is 30, we will set it to manager only not cashier since we removed that option from the cashier window,
for offline we will let the owner decide the refund method in the managers setting which methods are allow we need to add that to
the web also. scope leave it to till own sales but let it be a feature on the owners page also".

## What changes
- **The void window is the owner's** (default 30 minutes, 1 minute to a day). Managers void within it; the owner at any age;
  cashiers never (History's Void / Refund is managers' and the owner's, as before). The cloud, the dashboard's Orders page and the
  till's History all follow it.
- **Offline void and refund on the till.** Tried online first; only when the cloud cannot be reached (no network, a gateway error,
  an offline sign-in) the till checks the approving manager's PIN itself (branch node, else its saved sign-ins), applies the
  owner's rules, does it at once (the order voided / the refund's money-out rows — the Z-report and expected cash are right
  straight away) and queues it. When the sale is on the cloud, the till sends it with who approved it and when; the cloud checks it
  came from the till that holds the sale and that the approver may approve. A refusal is parked and shown in the sync status.
- **The owner's offline rules:** which payment methods a till may refund offline (default **cash** — a refund hands back each
  payment in its own method, so every payment on the sale must be allowed), and whether, offline, a till may also reverse the web
  sales on its drawer (default **off** — its own sales only).
- **Where the owner sets them:** web — Settings › Business › **Voids & refunds**; till — Manager → Settings (signed in as the
  owner; a manager sees them read-only). Only the owner can change them (the cloud refuses anyone else).

## Files
NEW `shared/reversalRules.ts` (+ copies: till renderer and main, dashboard, cloud; `check-shared-sync`); cloud: NEW
`lib/reversalSettings.ts`, `routes/orders.ts` (window from the setting; till replay: `reversalGate`, `checkTillReplay`;
`ALREADY_VOIDED` / `ALREADY_REFUNDED`), `routes/business.ts` (readable; owner-only, validated writes), `routes/pos.ts` (pos/init
`reversalRules`), `lib/desktopSchema.ts` (61); till: NEW `main/offlineReversal.ts`, `ipcHandlers.ts` (offline path,
`pos:reversalRules`, `manage:setReversalRule`), `syncEngine.ts` (pull, `pushOfflineReversals`, sync status), `localDb.ts`
(`pending_reversals`, `device_config.reversal_rules`, schema 61), `deviceConfig.ts`, `referenceBundle.ts` (node relay),
`ipcSchemas.ts`, `preload.ts`, renderer `VoidModal.tsx`, `POSPage.tsx`, `lib/voidRefund.ts`, `lib/posApi.ts`, NEW
`components/ReversalRulesPanel.tsx`, `components/SettingsPanel.tsx`, `pages/ManagerPage.tsx`; web: NEW
`pages/settings/VoidRefundRulesTab.tsx`, `BusinessPage.tsx`, `App.tsx`, `OrdersPage.tsx`; tests: NEW
`apps/desktop/test/offline-reversal.test.mjs` (35; mutations bite; CI step added), NEW `tests/reversal-rules.test.mjs` (9);
pins moved in `tests/{order-notes,owner-void-refund}`, `apps/desktop/test/{catalogue-refresh-signal,offline-session,void-refund}`;
`apps/desktop/package.json` + lock 0.6.30; `docs/AUDIT-REGISTER.md` (A336 stage 3 built), checklist v0.6.30 (`.md` + `.html`),
this file.

## Rollout (owner)
1. Apply, commit, push; CI green.
2. Deploy the cloud, the dashboard and the admin portal (no migration). The cloud goes first: a 0.6.30 till's replay needs it.
3. Tag **v0.6.30** → approve B Foods → T1 updates.
4. Checklist v0.6.30.
