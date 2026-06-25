# SwiftPOS — Step 2: Branch Price Editor (apply & test)

Builds on step 1. Gives the manager a screen to **set and clear branch prices
locally** on the desktop app — the manager is the branch authority, edits work
fully offline, and they take effect on that device immediately.

> This zip is **cumulative — it contains steps 1 and 2 together**, so apply
> order can't bite you. If you already applied step 1, re-extracting is safe
> (same files, newer content).

---

## 1. What changed (step 2 only)

| File | Change |
|------|--------|
| `apps/desktop/src/main/localDb.ts` | New `local_price_edits` table — tracks manager edits that haven't synced up. Survives catalogue pulls and is the queue step 6 will flush to the cloud. |
| `apps/desktop/src/main/syncEngine.ts` | After a catalogue pull, **re-applies unsynced local price edits** so a routine sync never wipes an offline price change. |
| `apps/desktop/src/main/managerReports.ts` | `getPriceList`, `setBranchPrice`, `clearBranchPrice` — local read/write of branch prices. |
| `apps/desktop/src/main/ipcHandlers.ts` | IPC channels `manager:priceList` / `setBranchPrice` / `clearBranchPrice`. |
| `apps/desktop/src/main/preload.ts`, `renderer/lib/posApi.ts` | Bridge + types for the three price methods. |
| `apps/desktop/src/renderer/pages/ManagerPage.tsx` | New **Prices** tab: searchable product list, per-row branch price input, Save / Clear, an "unsynced" badge, and a one-line explainer. |

The manager edits write to local SQLite only. No cloud call — propagation to the
cloud and to other tills comes with the later sync steps (by design).

---

## 2. Apply

Same as step 1 — migration + code at repo root, rebuild desktop on Windows.
The migration (`20_branch_prices.sql`) is unchanged from step 1; if you already
ran it, skip it. The new `local_price_edits` table is created automatically by
the desktop app's own schema init on next launch (no manual SQL).

```bash
cd /c/swiftpos/pos
unzip -o /path/to/desktop-pricing-steps-1-2.zip -d .
git add -A && git commit -m "Desktop steps 1-2: per-branch pricing + branch price editor" && git push origin main
cd apps/desktop && npm run build      # picks up the new tab + local table
```

---

## 3. Test

### 3a. See the editor
- PIN in as a **manager** → the sidebar now has a **Prices** tab.
- It lists active products (fuel excluded) with Default price, an editable Branch
  price, and Save / Clear.

### 3b. Set a branch price (takes effect immediately, offline)
1. Disconnect the network (prove it's offline-local).
2. On a product, type a new price → **Save**. The field turns green; the row
   shows an **unsynced** badge.
3. Switch to **Open POS** and ring that product up — it uses the **new price**.
   (Same machine, so the edit is effective instantly.)

### 3c. Survives a sync (the clobber test — important)
1. With that unsynced override set, reconnect and **Force sync** (tech screen)
   or wait a cycle — the catalogue pulls down.
2. Back on the Prices tab, the override is **still there** (not wiped), still
   selling at the branch price. (This is the `local_price_edits` re-apply.)

### 3d. Clear → revert to default
- Hit **Clear** on an overridden product → the branch price is removed, the POS
  goes back to the Default price.

### 3e. Reboot durability
- Set an override, restart the app — the override persists (local SQLite).

---

## 4. Boundaries (by design, next steps)

- **Single till / manager's PC = till:** fully solved — edit and sell on the same
  machine, offline. This is the common 1–2-till case.
- **Multi-till branch:** an edit is **local to the device it's made on** until the
  sync steps land. Make price edits on the **designated manager/node device**;
  cross-till propagation arrives with:
  - **cloud up-sync** of `local_price_edits` (flips `synced=1`), and
  - **two-way price sync + newest-wins + HQ collision notification** (step 6 of
    `BRANCH_AUTHORITY_AND_SYNC_DESIGN.md`).
- **Fuel** is excluded from this editor (pump/price-per-litre driven).
- **Product creation & staff management** (the rest of "management UI") are
  separate follow-ons — this step is prices only, the direct payoff of step 1.
