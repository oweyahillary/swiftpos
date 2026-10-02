# MANIFEST 2026-10-02-d — desktop 0.6.33: free delivery, switched by the owner (A379)

**Base:** origin/dev `255bfac`. **Delivered as:** `swiftpos-2026-10-02-v0.6.33.patch` — includes the version bump
(apps/desktop and `shared/release.ts` → 0.6.33). **No migration.** Cloud, web and till.

Owner, 2026-10-02: "in adition to the delivery with delivery fee can we add an option of free delivery where its not a must
for the cashier to key in delivery fee? but that can be turned on and of by the hotel owner".

## What changes
- A new owner switch, **Allow free delivery** (off by default): web Settings › Business › **Voids, refunds & delivery**
  (renamed from "Voids & refunds"), and on the till Manager → Settings (signed in as the owner). Only the owner can change it.
- With it on, on a client whose deliveries need a fee (the admin portal's "Delivery fee and rider" switch): the cashier may
  leave the fee empty (or 0) — a free delivery. The rider's name is still required; a fee that is typed must be a real one.
  The fee box reads "Delivery fee (empty = free)". A free delivery adds nothing to the bill and pays the rider nothing.
- With it off: unchanged — every delivery needs its fee.

## Files
`shared/reversalRules.ts` (+ 4 copies: the rule `delivery_free_allowed`), `shared/delivery.ts` (+ 4 copies:
`deliveryProblem(…, freeAllowed)`, `isNoFee`, `deliveryFeePlaceholder`), `apps/server/src/routes/business.ts` (readable key),
`apps/desktop/src/main/ipcHandlers.ts` (the owner's save keeps it), `renderer/pages/POSPage.tsx`,
`renderer/components/ReversalRulesPanel.tsx`, `renderer/lib/posApi.ts`, `apps/dashboard/src/pages/pos/CashierScreen.tsx`,
`pages/pos/cashier/usePOSData.ts`, `pages/pos/cashier/types.ts`, `pages/settings/VoidRefundRulesTab.tsx`,
`pages/settings/BusinessPage.tsx` (tab name); version 0.6.33 (`shared/release.ts` + copies, `apps/desktop/package.json` +
lock); NEW `tests/free-delivery.test.mjs` (12); `tests/reversal-rules.test.mjs`, `tests/prospect-features.test.mjs` (pins);
`docs/AUDIT-REGISTER.md` (A379), this file.

## Rollout (owner)
1. Apply, commit, push to dev; CI green. Merge to main (the cloud and web deploy; no migration).
2. Tag **v0.6.33** from dev: `git fetch origin && git push origin origin/dev:refs/tags/v0.6.33` → Release desktop green.
3. On T1 (a client with "Delivery fee and rider" on), as the owner: Manager → Settings → **Allow free delivery** on.
   Ring a delivery with a rider and no fee → it pays; the receipt has no delivery fee; the drawer has no rider pay-out.
4. Switch it off (web or till) → after the till's next sync, a delivery with no fee is refused again: "Enter the delivery
   fee for this delivery."
