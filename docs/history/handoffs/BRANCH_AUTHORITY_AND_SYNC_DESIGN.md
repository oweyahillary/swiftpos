# SwiftPOS — Branch Authority & Sync Design

Status: agreed design, not yet implemented. Companion to `DESKTOP_DESIGN.md`.
Covers how editing, local sync, and cloud sync work for offline branches, and
what happens to all of it when web access lapses.

---

## 1. The one rule everything hangs off

**The manager's PC is the branch authority.** It is the single place prices,
products, and staff are edited for that branch.

- **Edits flow DOWN:** Manager PC → tills.
- **Orders flow UP:** tills → Manager PC → cloud.
- Tills never edit reference data and never talk to the cloud directly.

One writer per direction ⇒ no conflicts by construction — except the one
deliberate two-writer case in section 5 (head-office price push).

```
            edits (prices, staff, products)
Manager PC ─────────────────────────────────▶ Till 1, Till 2
          ◀─────────────────────────────────
                      orders only
```

The Manager PC is the `node` role from `DESKTOP_DESIGN.md`, widened from
"receives orders" to "also owns the branch catalogue/staff and hosts the
management UI." No separate box, no bundled Postgres/Supabase — it reuses the
desktop app's existing local SQLite.

---

## 2. Local sync (always on, no internet ever required)

This is the whole product for an offline (30k, one-off) client.

- Manager edits on the PC → written to the PC's local SQLite.
- Tills pull catalogue/staff/prices on their normal sync cycle (or on manual
  Sync). A price change is just new pull data on the next cycle.
- Tills push completed orders up to the PC; PC aggregates branch totals.
- **A till keeps selling even if the PC is off** — it sells off its local
  cache and reconciles to the PC when it returns. Hard requirement, unchanged.

No cloud, no licence, no conflicts. Works forever offline.

### PIN login must also be local
Today PIN login is a server round-trip (`/api/auth/verify-pin`), so a till
can't open a shift offline at cold start. Required for this model:
- The PC (authority) creates cashiers and sets PINs.
- Each till caches a local verifier the first time a cashier logs in
  (stored via Electron `safeStorage`, OS-backed — not plain SQLite).
- That cashier then opens shifts on that till regardless of PC/cloud state.
- Orders carry `cashier_id` on push (don't rely on the server reading it from
  the token), so offline-opened shifts attribute correctly when they sync.

---

## 3. Cloud sync (only when web access is paid)

Web access (10k/yr, per business) adds a bridge on the **Manager PC only**.

- Orders flow up: PC → cloud → web portal shows all branches combined.
- The bridge is **off** for offline-only businesses — the cloud never sees them.
- Tills are never involved in cloud sync; the PC is the sole uplink.

---

## 4. When the web licence lapses

Only the cloud side is affected. The local loop doesn't know it happened.

| | During lapse |
|---|---|
| Tills selling | ✅ unaffected |
| **Manager editing prices/staff** | ✅ **unaffected — local authority, not cloud** |
| Orders → cloud | ⏸ queue on the PC |
| Head-office price push (section 5) | ⛔ blocked — portal is locked, HQ can't push |
| On renewal | queue flushes up, portal back-fills, nothing lost |

Because HQ push is blocked during a lapse, **a lapse produces zero price
conflicts** — only the manager edits locally, and those sync up clean on renewal.

---

## 5. Two-way price sync (head-office push) — the one deliberate exception

Head office can push prices from the cloud so a branch updates even with no
manager present. This makes the cloud a **second writer of price**, between
cloud ⇆ Manager PC only. Tills stay one-way (pull down) and never conflict.

```
Head office (cloud)  ⇆  Manager PC  ──▶ tills
                                     ◀── orders only
```

### Resolution: newest-wins, applied immediately, reviewed after
1. Every price edit is stamped with **who** (cloud / PC) and **when**.
   Timestamps are **server-anchored** when the PC is online (same monotonic
   approach as the tech clock-floor) so a misset PC clock can't win by accident.
2. On sync, **newest edit wins and applies immediately** — never blocks selling
   or local editing. (No approval-gate: an offline branch must be able to
   change a price without waiting for HQ.)
3. **Notify head office ONLY on a true collision:** the same item was edited on
   **both** sides since they last agreed. A plain local edit the cloud never
   touched is not a conflict — sync it silently.
4. The notification is a **review-after**: HQ **Confirms** (keeps the winning
   price) or **Rejects** (pushes HQ's price back down → PC → tills).
5. Every collision + resolution is **logged to an audit trail** (item, both
   prices, who won, who confirmed/rejected, when) — the record people argue
   over later.

### Optional future hardening (not now)
A per-product `priced_centrally` flag (cloud owns) vs local-owned removes the
two-writer case entirely. Skip unless newest-wins proves noisy in practice.

---

## 6. Schema implications to settle BEFORE building

- **Price ownership / location.** `products.base_price` is one number per item
  business-wide. Decide now:
  - Uniform pricing → keep `base_price`, cloud/PC owned, flows down. Simple.
  - Per-branch pricing → need a branch-level price (table or override column),
    regardless of sync direction. Cheap to decide now, expensive to retrofit.
- **Edit metadata.** Reference rows that sync up need `updated_at` +
  `updated_by` (source) for newest-wins. Sync **per-row deltas**, not the
  current replace-all (replace-all is correct downward, destructive upward).
- **Audit.** A `price_conflict_log` (or reuse the tech-audit pattern) for
  section 5.5.

---

## 7. What is conditional (don't build speculatively)

- **Pure offline client (no web access):** sections 1–2 only. Bridge off,
  zero reconciliation code. Ship this first — it's correct and complete on its own.
- **Web client, no HQ push:** add section 3 (orders up only). Still one-way, no
  conflicts.
- **Web client WITH HQ price push:** add section 5. This is the only part that
  needs two-way sync + newest-wins + notification + audit. Build it when a
  paying customer needs it, not before.

---

## 8. Build sequence (this spec)

1. **Local management UI on the PC** (node role): price/product/staff editors,
   writing to local SQLite. *(Bulk of the new code — the dashboard editors
   currently call the cloud REST API; here they target the node locally.)*
2. **Offline PIN login**: PC issues cashiers; tills cache local verifiers
   (`safeStorage`); `cashier_id` on order push.
3. **Local price propagation**: tills pull edited prices from the PC (mostly
   existing downward-pull machinery).
4. **Cloud order uplink + lapse queue** (web-access clients): gate on web
   access; queue-and-flush on renewal. *(Ties into steps 5–6 of `DESKTOP_DESIGN.md`.)*
5. **Two-way price sync** (section 5): per-row deltas, server-anchored
   newest-wins, collision-only HQ notification, confirm/reject, audit log.
