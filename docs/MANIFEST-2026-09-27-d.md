# MANIFEST 2026-09-27-d — Cross-sync stage 1: the web's sales on a till's drawer appear on the till (A336) + A335 + the B5 fix

**Base commit:** `7d786f0` (origin/dev = 2026-09-27-c). One commit on `claude/modest-cray-f21ll5`; the owner fast-forwards `dev`.
**Deploy: cloud + desktop v0.6.10** (the dashboard is unchanged). Local schema 54 → **55**.

Why — owner, 2026-09-27: "calculations are off from web to desktop pos the orders should cross sync what i sell on the web using
the same till should appear on the till or branch if its a different till. fix it"; B5–B7 "not correct" (expected 6,210 for 4,720);
"can it be instant like 30sec not a minute". Owner decisions: a different till → **branch view, read from the cloud**; void =
manager / supervisor / owner, refund = owner / manager, cashiers neither; offline refunds need a manager PIN (the roles and
offline are stages 2–3, not in this delivery).

## What changed
1. **B5 double count (A334):** `foreign-cash` matched the till's LOCAL order ids against the cloud's own ids; the cloud keeps the
   till's id as `idempotency_key`, so every till sale counted again as the web's. Now matched by `idempotency_key` too.
2. **Pushes at once:** shift open / float / close / force-close and a joined drawer push immediately; the backstop timer is 30 s (was 60).
3. **Web sales download to the till (A336 stage 1):** NEW `POST /api/shifts/:id/foreign-orders` (read-only, same auth as
   foreign-cash) → the till's NEW `webSales.ts` stores them under the cloud id, `orders.origin = 'web'`, synced, never queued, never
   relayed to the node, never overwriting a till sale. Every ~20 s, after each full sync, and at sign-in. They show in the POS's
   recent orders (tagged **web**), the manager's Orders, the shift panel ("Includes the web POS on this drawer: …"), the Z-report and
   the day close. A void or refund made on the web reaches the till on the next pull.
4. **Branch view:** Manager → Orders → **This till / All tills at this branch** — the second reads the cloud's order list for the
   branch ("this till" marked); offline it shows this till and says the cloud could not be reached.
5. **A335:** the till's void / refund posts its LOCAL id; the cloud routes now resolve id OR `idempotency_key` in the caller's business.

## Files (30)
| File | Change |
|---|---|
| `apps/server/src/lib/foreignCash.ts` | `idempotency_key` match (B5); NEW `foreignOrders()`. |
| `apps/server/src/routes/shifts.ts` | foreign-cash fetches `idempotency_key`; NEW `POST /:id/foreign-orders`. |
| `apps/server/src/lib/resolveOrder.ts` | NEW — A335 resolver. |
| `apps/server/src/routes/orders.ts` | void / refund resolve the id; order list carries `device_id`. |
| `apps/server/src/lib/desktopSchema.ts` | `REQUIRED_DESKTOP_SCHEMA` 55. |
| `apps/desktop/src/main/webSales.ts` | NEW — store / refresh web sales; branch-list mapper. |
| `apps/desktop/src/main/localDb.ts` | `orders.origin`; `LOCAL_SCHEMA_VERSION` 55. |
| `apps/desktop/src/main/nodeIngest.ts` | Outbox skips downloaded sales. |
| `apps/desktop/src/main/syncEngine.ts` | NEW `pullWebSales()`; runs after a full sync. |
| `apps/desktop/src/main/index.ts` | 20-s poll pulls web sales; push backstop 30 s. |
| `apps/desktop/src/main/ipcHandlers.ts` | Push at once on shift changes; pull at sign-in; NEW `manager:branchOrders`. |
| `apps/desktop/src/main/ipcSchemas.ts`, `preload.ts`, `renderer/lib/posApi.ts` | The new channel; `webSales` type. |
| `apps/desktop/src/main/shiftService.ts` | Z-report reports `webSales` (already inside the totals). |
| `apps/desktop/src/main/managerReports.ts` | Recent orders carry `origin`. |
| `apps/desktop/src/renderer/pages/POSPage.tsx`, `ManagerPage.tsx` | "web" tag; scope toggle; offline note; shift note. |
| `apps/desktop/src/renderer/pages/ShiftPanel.tsx` | The web line counts downloaded + cloud-only web sales. |
| `apps/desktop/src/renderer/components/ReportRangeBar.tsx` | `scopeOverride` for the branch view. |
| `apps/desktop/test/web-sales.test.mjs` | NEW — 25 checks, real engine + SQLite. |
| `tests/cross-sync.test.mjs` | NEW — 16 checks. |
| `tests/foreign-cash.test.mjs` | The owner's B5 case (4,720); key pins. |
| `tests/theme-access.test.mjs`, `apps/desktop/test/theme-pull.test.mjs` | Schema pins → "54 or later" (their intent). |
| `scripts/schema-parity-exceptions.json` | `origin` local-only, with its reason. |
| `.github/workflows/ci.yml` | Step "Desktop web sales on this till". |
| `docs/AUDIT-REGISTER.md` | A336, A335, A334 target result; header; Tree row v0.6.10, schema 55; changelog. |
| `docs/VERIFY-LOG-2026-09-27.md` | NEW — the owner's v0.6.9 results. |
| `docs/MANIFEST-2026-09-27-d.md` | This file (NEW). |

## Verification (bench: Linux, Node 22)
```
apps/desktop test/web-sales.test.mjs → 25 passed (compiled webSales + shiftService + nodeIngest on SQLite)
  7 mutations: synced→pending · outbox exclusion dropped · ownOrderIds keeps web rows · own-sale guard dropped ·
  status not updated · pending payments stored · webSales counts voided → each reddens its check
tests/cross-sync.test.mjs → 16 passed; 4 mutations (id-only match · 'voided' dropped · no key lookup · void on req.params.id)
tests/foreign-cash.test.mjs → 17 passed; id-only matching reddens the B5 case (4,720)
tests/*.test.mjs → all pass · desktop CI tests (shared-drawer 16, theme-pull 14, sync suites …) → all pass
desktop main + renderer tsc OK · server tsc + build OK · typecheck-ratchet server OK
schema-parity PASS · own-rows · sql-binds · row-attribution · ipc-parity · ipc-validation · header-keys · api-routes ·
  api-schema-drift · table-usage · client-parity · reference-names · till-green · register-consistency (with the bump) → OK
scripts/test-* (node ingest 50, branch close 28, distribution 25, events 27, maintenance 20, office 26, print 55,
  tech console 38, sync rejection 18) → all pass
```
Not verified here (rule 16): the live till + web.

## Owed on target (till on 0.6.10, cloud deployed)
- **B5–B7 again** (web opens the drawer, till joins, one sale each side, close on the till): expected = float + till sale + web
  sale, once; the count balances; the dashboard agrees.
- **F1.** Web POS on T1's drawer: ring a sale. Within ~20 s it is in the till's POS recent orders, tagged **web**.
- **F2.** Till shift panel: "Includes the web POS on this drawer: 1 sale, … cash"; the order count includes it.
- **F3.** Void that sale on the web (manager). Within ~20 s the till shows it voided and expected cash drops.
- **F4.** Till Manager → Orders → **All tills at this branch**: another till's sales are listed, "this till" marked. Wi-Fi off →
  "The cloud could not be reached — showing this till only."
- **F5.** On the till, void a sale the TILL rang (within 30 min) and refund another: both succeed (A335).
- **F6.** Open a shift on the till: the dashboard shows it within ~30 s.

## Rollback
```bash
git revert <this commit>   # the desktop keeps orders.origin (additive, harmless); REQUIRED_DESKTOP_SCHEMA returns to 54
```
