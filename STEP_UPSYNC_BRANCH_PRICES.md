# SwiftPOS — Branch Price Up-Sync (cloud) — apply & test

The **upward half** of the two-way price sync (BRANCH_AUTHORITY_AND_SYNC_DESIGN.md
§5): the manager's local branch-price edits now flow up to the cloud. The
downward half (head-office push + newest-wins + collision notification) is the
next step. Builds on steps 1–2.

> Cumulative zip — contains steps 1, 2 and this up-sync. Re-extracting is safe.

---

## 1. What changed

| File | Change |
|------|--------|
| `apps/server/src/routes/branch-prices.ts` | **New.** `POST /api/branch-prices/sync` — accepts `{ branch_id, edits[] }`, upserts `branch_prices` (or deletes on a cleared edit), stamps `updated_by='pc'`, keeps the edit's own `updated_at`, bumps `version`. Tenant- and branch-access checked. |
| `apps/server/src/routes/index.ts` | Mounts the route at `/api/branch-prices`. |
| `apps/desktop/src/main/syncEngine.ts` | New `pushBranchPriceEdits()` in the push cycle (both `syncAll` and `syncPush`): sends unsynced `local_price_edits`, and on success flips `synced=1` for exactly the products the server applied. 401 → token refresh + retry, like the other push paths. |

No schema change beyond step 1 (the `branch_prices` table and metadata columns
already exist).

---

## 2. How the loop closes

1. Manager sets/clears a price → `local_price_edits(synced=0)` + live `branch_price`.
2. Next sync (`Force sync`, post-sale flush, or the background cycle) posts the
   unsynced edits to the cloud.
3. Server upserts/deletes `branch_prices` for the branch and returns `applied[]`.
4. Device flips those rows to `synced=1`.
5. Next catalogue pull brings the (now-matching) cloud price back down; since the
   edit is synced, the step-2 anti-clobber pass leaves it alone. No flip-flop.

A cleared override (price `null`) deletes the cloud row, so the product reverts
to `base_price` everywhere.

---

## 3. Apply

Extract at repo root, push (server redeploys), rebuild desktop on Windows. No new
migration. (The `branch_prices` table from step 1 must already exist.)

```bash
cd /c/swiftpos/pos
unzip -o /path/to/desktop-pricing-upsync.zip -d .
git add -A && git commit -m "Branch price up-sync to cloud" && git push origin main
cd apps/desktop && npm run build
```

---

## 4. Test

1. **Edit offline, then sync.** On the manager PC (online or reconnected), set a
   branch price → the row shows **unsynced**. Trigger **Force sync**.
2. **Cloud has it.** In Supabase, `branch_prices` has a row for `(branch, product)`
   with your price, `updated_by = 'pc'`, `version = 1`. The Prices tab no longer
   shows **unsynced** for that product.
3. **Clear syncs too.** Clear the override → Force sync → the `branch_prices` row
   is **deleted** in the cloud; the product is back to `base_price`.
4. **No flip-flop.** After a synced edit, let a catalogue pull run — the price
   stays put (doesn't revert and doesn't duplicate).
5. **Offline durability.** Edit with the network off; the edit stays **unsynced**
   and flushes automatically when connectivity returns.
6. **Bump.** Edit the same product again after it synced → it re-queues
   (`synced=0`), pushes, and `version` increments to 2 in the cloud.

---

## 5. Boundaries / notes

- **Not yet web-access-gated.** Like order push today, this sends to whatever
  server the device is configured for. The uniform sync-bridge gating (only sync
  a branch when the business has web access and the branch is `web_sync_enabled`)
  is a separate step that will gate orders and prices together. For a pure-offline
  business this is moot — there's no cloud in the loop.
- **Edit on the cloud-connected manager device.** Up-sync posts to the device's
  own server URL; price editing is intended on the manager/node PC (the branch
  authority), not peer tills.
- **Timestamps.** The edit's own `updated_at` is preserved (so an offline edit
  keeps its real time for the upcoming newest-wins comparison). Server-anchored
  clock correction is part of the two-way (downward) step, where collisions are
  actually resolved.
- **Next:** head-office push (cloud → branch), server-anchored newest-wins on the
  `(branch, product)` grain, the HQ confirm/reject collision notification, and the
  audit log.
