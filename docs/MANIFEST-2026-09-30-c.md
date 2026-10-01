# MANIFEST 2026-09-30-c — desktop 0.6.26 + cloud: a web void or refund of a till's own sale reaches the till (A336 follow-up)

**Base:** origin/dev `94ef7dd` (0.6.25, all verified). **Delivered as a patch:** `swiftpos-2026-09-30-v0.6.26.patch`. It
**includes the version bump** (apps/desktop → 0.6.26). **Cloud change too** (one route's answer). No migration; local schema stays
58. No dashboard change.

Owner, 2026-09-30: "go ahead with the A336 follow-up".

## What changed
- **The gap (known limit of A359).** When a manager refunded or voided on the web a sale the **till** rang, the cloud was right,
  but the till never heard: its History, shift figures, Z-report and day close still counted the sale in full. Sales rung **on the
  web** were already fine — their voids and refunds came down with them.
- **Cloud.** The till's web-sales pull (`POST /api/shifts/:id/foreign-orders`, every ~20 s) already sends the ids of the sales the
  till rang. The answer now also lists which of those the cloud has **voided or refunded** (`own_reversals`: when, why, how much,
  and the refund's money-out rows). An older till ignores the field.
- **Till.** It applies them exactly as its own void and refund do: a void once (and the branch node hears the same `order_voided`
  event); a refund only if the till has not already refunded that sale itself (so it is never counted twice), each money-out row
  once. Sales rung on the web are not touched by this (they keep their own path).
- **A race closed (found in review before shipping).** When the till refunds a sale itself (online), the ~20 s pull can store
  the cloud's copy of that same refund between the cloud accepting it and its answer reaching the till. The till's refund now
  writes its local copy only if the sale is not already refunded here (`mirrorTillRefund`), so whichever lands first, the money
  comes out once. (For web-rung sales the same race already healed itself on the next pull; it no longer happens at all.)
- **Reach:** the same as web-rung sales — drawers still open or awaiting reconcile. A reversal made on the web after the till's
  shift has closed and synced is right on the cloud and its reports, not re-pulled onto the closed till shift.

## Files
| Area | Files |
|---|---|
| Cloud | `apps/server/src/lib/foreignCash.ts` (`ownReversals`), `apps/server/src/routes/shifts.ts` (foreign-orders returns `own_reversals`) |
| Till | `apps/desktop/src/main/webSales.ts` (`applyOwnReversals`, `mirrorTillRefund`), `apps/desktop/src/main/ipcHandlers.ts` (order:refund mirrors through `mirrorTillRefund`), `apps/desktop/src/main/syncEngine.ts` (`pullWebSales` applies them; void → `order_voided` for the node) |
| Version | `apps/desktop/package.json`, `package-lock.json` → 0.6.26 |
| Tests | NEW `apps/desktop/test/own-reversals.test.mjs` (18; CI step "Desktop web reversals of the till's own sales"), `tests/cross-sync.test.mjs` (+4, 20) |
| Docs | `docs/AUDIT-REGISTER.md` (A336, A359 note, Tree v0.6.26), `docs/checklists/VERIFY-CHECKLIST-v0.6.26.html` + `.md`, this file |

## Verification (bench)
```
own-reversals 18/18 on the REAL compiled webSales + shiftService + SQLite (web refund 1950 → 1550, idempotent; a till refund not
counted twice; web void 1250 → 1000, the node hears once; web-rung and unknown ids untouched; the refund race both ways) · 5
mutations bite (the "already refunded" guard; the money-out rows; the origin filter; the node event; the till mirror's guard). cross-sync 20/20 on the real ownReversals · 3 mutations
bite (matching by id only; the sale's own payments sent as refunds; the route not sending own_reversals). Every desktop test ·
every cloud suite (without shared/printing built, as CI) · every gate · desktop typecheck, main and renderer builds; cloud build.
```

## Rollout (owner)
1. Apply, commit, push; CI green. Deploy the **cloud**.
2. Tag **v0.6.26** → approve B Foods → T1 updates.
3. Checklist v0.6.26 (§X).

## Rollback
```bash
git revert <the owner's commit>   # the cloud's extra field is ignored by 0.6.25 tills either way
```
