# Till stage 3b — client (shared held orders in the POS)

Consume the branch node's `/node/tabs…` routes (see `docs/BUILD-TILL-STAGE-3B-SERVER.md`) from the shared web/Android POS,
so a held order (tab) opened on one till is **seen, locked, edited and charged** from another, with the owner's
**see-it-then-take-over** UX (owner, 2026-11-14).

> **Scope of THIS build.** It lands the **client + the web-POS bridge seam, fully built and tested**, and deliberately
> does **not** yet rewire the `CashierScreen` selling-screen flow — that is the §"Selling-screen integration" plan below,
> kept separate because it is the core selling screen and the take-over UX wants the owner's eye. Until it is wired, a
> joined POS has the host available but the screen still keeps tabs local; a server-less POS is byte-for-byte unchanged.

## What's built (this slice)

| File | What |
|---|---|
| **new** `apps/android/src/shop/branchTabs.ts` | Typed client: `listTabs` · `registerTab` · `claimTab` · `forceClaim` · `updateTab` · `releaseTab` · `deleteTab`, over `branchServer.nodeRequest` (pinned TLS). The **lock holder is the proven device** (`x-device-id`); the staff **display name** rides in the body (`opened_by`/`name`) so another waiter sees "Held by Jane". Pure parsers (`readClaimOutcome`/`readEditOutcome`/`parseTabList`) split out; injectable deps. No `cloud/client` import (no cycle). |
| **mod** `apps/dashboard/src/lib/shopPos.ts` | The `BranchTabsHost` **seam** — `setBranchTabsHost(h)` / `branchTabsHost()`, mirroring the existing `setShopPosHost`/`shopPosHost`. `branchTabsHost()` is `null` in a browser / on a server-less POS. |
| **mod** `apps/android/src/env.d.ts` | Declares `setBranchTabsHost` on the `@zaptill/dashboard-pos` module (the narrow boundary this app sees). |
| **mod** `apps/android/src/screens/shop/ShopPos.tsx` | `startScreens()` installs the host **only when a ServerLink is present** (`readServerLink()`), else `null`. So the host exists iff this POS joined a branch server. |
| **new** `tests/android-till-tabs.test.mjs` | Hermetic (esbuild, Capacitor stubbed) — **36 assertions**: the parsers' decision table, each IO call's path/method/body/`x-device-id`, no-link → neutral, a thrown transport → `unreachable`, and source checks (imports `nodeRequest`; no `cloud/client`/`react`). |
| **mod** `.github/workflows/ci.yml`, `apps/android/package.json` (0.4.3→**0.4.4**), `docs/ANDROID-CHANGELOG.md` | CI step, version, changelog. |

### The claim decision table (drives the UX)
| client result | from | the screen does |
|---|---|---|
| `claimed` (`stole:false`) | 200, unlocked/mine | open it, edit normally |
| `claimed` (`stole:true`) | 200, a **lapsed** lease auto-taken | open it + a "took over an idle table" toast |
| `locked` (`lockedBy`) | 409, a **live** foreign lock | read-only + "Held by <name>" + **Take over** (manager) → `forceClaim` |
| `unreachable` | no link / 404 / 503 / thrown | **stay local-only** for this action (A410 preference, never a block) |

## Selling-screen integration (the next step — precise plan)

All of this is **additive and gated on `branchTabsHost()`**; the `host === null` path is the existing code, untouched
(a server-less POS must stay byte-for-byte the same). Restaurant tables first; parking/petrol/retail parked orders stay
local-only for now (out of "shared tables" scope). Hook points, already located in `CashierScreen.tsx`:

- **See (occupancy).** `tableStatus(table)` (~L643): occupied if `openOrders[table.id]` **or** a node tab for that table id
  exists; show the holder name on an other-till tab. Keep a `nodeTabs` state from `host.listTabs(branchId)`, refreshed when
  the tables view opens and on a modest interval (e.g. 10 s) while on it.
- **Register.** `confirmCovers()` (~L679, a new table) and `startTakeaway()`: after setting `openOrders`, `host.registerTab({ id:key, branch_id, order_number, label:tableName, order_type, table_number, cart:[], opened_by:session.staffName })`, then `host.claimTab(key, staffName)` so the opener holds the lock.
- **Claim before editing a shared tab.** `onTableTap()` (~L650) for an occupied table that is a **node** tab: `claimTab` first — `claimed` → load `tab.cart` into `openOrders[key]` + `setActiveKey` + products; `locked` → a "Held by <name>" modal with a manager-gated **Take over** (`forceClaim`, reuse the existing manager-PIN pattern; surface the returned steal audit as a toast); `unreachable` → today's local resume.
- **Lease renew.** the cart-sync effect (~L632): while holding a node tab, a **debounced** `host.updateTab(activeKey, cart, label)`; an `outcome:'lost'` means the lease was stolen → surface "This table was taken over" and drop to read-only.
- **Release.** `goBackToSlotPicker()` (~L720): `host.releaseTab(activeKey)` for a node tab.
- **Delete.** `onPaid`/`onSuccess` (~L2738): `host.deleteTab(key,'charged')`. `clearTable()` (~L664) and `closeVoidedTab()` (~L1145): `host.deleteTab(key,'cleared')` (surface the clear audit).

**Deferred follow-ups (flagged):** (1) a full **read-only browse** of another till's cart (vs a "Held by X" info modal) — needs new read-only rendering in the products/cart view; (2) a **cloud-relayed manager alert** for a force-steal/clear (the server logs + returns the audit today — see the server build sheet); (3) non-restaurant held orders (parking/petrol/retail) on the node.

## Selling-screen wiring — SHIPPED (v0.4.5)

`CashierScreen.tsx` is now wired to the host, gated on `branchTabsHost() && isRestaurant` (a browser / server-less /
non-restaurant POS is byte-for-byte unchanged). The decision logic is a pure module, `pages/pos/branchTabsUx.ts`
(`tableOccupied`/`heldBy`/`tapAction`/`claimAction`/`editLost`), unit-tested hermetically in `tests/branch-tabs-ux.test.mjs`
(18 assertions). What the screen does now:

- **Occupancy** (`tableStatus`): occupied if a local order **or** a node tab exists; `nodeTabs` state polled via
  `host.listTabs` every ~5 s while on the tables grid, refreshed on entry (`view`-gated).
- **New table** (`confirmCovers`): `registerTab` + `claimTab`, and the local order is marked `node:true`.
- **Tap a shared table** (`onTableTap`→`takeNodeTab`): `claimTab` → `claimed` loads the cart + opens it (a **lapsed**
  steal toasts "took over an idle table"); `locked` opens the **read-only "Held by &lt;name&gt;" browse modal**;
  `unreachable` falls back to opening it fresh (local-only).
- **Resume** (`resumeTable`): re-claims first; if taken over meanwhile → the Held modal, else resume (local on any fallback).
- **Lease**: a debounced `updateTab` on cart edits renews the 90 s lease; `lost` → toast + `goBackToSlotPicker`; a ~60 s
  heartbeat keeps an open-but-idle table held. **Release** on `goBackToSlotPicker`.
- **Delete**: `onPaid` → `deleteTab('charged')`; `clearTable`/`closeVoidedTab` → `deleteTab('cleared')`.

### Deferred / flagged (NOT in v0.4.5)
1. ✓ **SHIPPED in v0.4.6** — see "Manager take-over" below. *(Originally deferred, for the record:)* **Manager-approved force-steal of an ACTIVELY-held table.** The Held modal browses read-only and tells the waiter the
   table frees itself if idle — it does **not** offer a force take-over. Reason (flag, not a guess): the node's
   `/node/tabs/:id/force-claim` **trusts the caller** (no PIN check), there is **no manager-PIN pattern inside
   CashierScreen** to reuse (the existing ones verify server-side, e.g. `ShiftModal` `approvePin`), and **which permission
   authorises a take-over is undecided**. A correct build needs: node-side manager-PIN verification on force-claim (server
   slice) **or** a host `verifyManagerPin` via `/node/verify-pin` (plumbing), **plus** an owner call on the authorising
   permission. The **idle-auto-takeover** (a lapsed >90 s lease) already covers an abandoned table with no manager.
2. **Holder name on the table tile** — shown in the Resume/Held modal; a caption on the tile itself (two tile renderers:
   floor-plan + grid) is a small follow-up, left out to avoid editing the tile layout blind.
3. Non-restaurant held orders (parked retail / pumps / bays) stay local-only (owner: restaurant tables only for v1).

## Manager take-over — SHIPPED (v0.4.6)

Deferred item 1 above is now built. Owner decisions (2026-11-15): **node-verified PIN in one call** · reuse the existing
**`tables.manage`** permission · the taken-over waiter is **dropped with a toast** (no two-editor merge).

- **Node gate** (`nodeServer.ts` `/node/tabs/:id/force-claim`). The route no longer trusts the caller: it reads the
  manager's `pin`, verifies it against the branch roster with **`verifyPinAtNodeAsync`** (the `/node/verify-pin` path), then
  runs the pure **`forceClaimVerdict`** (`nodeTabs.ts`), which requires **`tables.manage`** via an injected `personCan` (the
  owner's role holds it as `*`). `forceClaim` runs **only on allow**. Bad/ambiguous PIN → **401 (final)**; roster-read
  failure → **503 (retry)**; verified-but-no-permission → **403**. PIN tries are **rate-limited** like verify-pin (10/min per
  device and per address). The steal audit records **approved_by / approved_by_id**.
- **Client** (`branchTabs.ts`). `forceClaim(id, name, pin, branchId)` relays the PIN + branch; `readClaimOutcome` maps
  401/403/429/400 to a new **`refused`** outcome (reason + message) — a **final** answer, never a local fallback (there is no
  local way to steal a live lock). The host interface (`shopPos.ts` / `env.d.ts`) carries the new signature and the
  `refused`/`approvedBy` fields; `ShopPos.tsx` forwards it unchanged (no wrapper — the dashboard already holds `branchId`).
- **UX** (`CashierScreen.tsx` + pure `branchTabsUx.ts` `takeOverAction`). The read-only "Held by &lt;name&gt;" overlay now has
  a **Take over** button + a **manager-PIN field**: `claimed` → open the taken-over cart + a toast naming the approver;
  `refused` → the node's message under the field (PIN cleared); `retry` → "the branch server didn't answer". The **previous
  holder is dropped** via the existing `editLost` path (their next lease-renew gets 423 → toast + back to the grid).
- **Tests** (all green; the gate assertion mutation-checked). `branch-tabs-ux` — `takeOverAction` open/refused/retry +
  approver toast. `android-till-tabs` — `forceClaim` relays pin+branch; 401/403/429/400 → `refused`. `node-tabs-claim` — the
  pure **`forceClaimVerdict`** gate (allow only a verified manager with `tables.manage`; 401/403/503) **and** a route-wiring
  source assertion (the force-claim route verifies the PIN, gates on `tables.manage` via `personCan`, and calls `forceClaim`
  only after allow). No new test files — the three suites are already named in `ci.yml`.

## Rig test — two tills + two tablets (required before any floor use)
The hermetic test proves the client's wiring, not the live cross-device behaviour (the point of D9):
1. Open a tab on **till A** → it appears on **till B**'s table grid as occupied + "Held by A".
2. B taps it → read-only + "Held by A"; a **manager Take over** on B bumps A to read-only (A sees "taken over").
3. Leave A's tab idle **>90 s** → B's tap auto-claims it (a "took over an idle table" toast), no manager needed.
4. Edit on the holder keeps the lease alive — the other till cannot claim meanwhile.
5. **Charge** on one, or **clear** on one, removes the tab on both; a clear carries the who-opened/changed/cleared audit.
6. Pull B off the network mid-service → B falls back to its **local** tabs; nothing is lost, and it re-syncs on reconnect.
7. A **server-less** tablet and the **browser** POS behave exactly as before (the host is null).
