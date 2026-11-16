# A129 — delivery-sync live verification checklist

**Proves:** a `delivery` sale now reaches the cloud and dashboard after migration 90,
parked delivery orders drain without duplicating, and nothing else regressed.
**Environment:** real Windows till + **prod** cloud/DB (the only place this is
verifiable — the bench can't run Electron). Record what you actually see next to
each box; "looks fine" doesn't count (rule 7).

**Order of operations:** do §0 *before* the prod-migrate, then merge → migrate
86→90 → §1 onward.

---

## 0. Capture the pre-state (before migrating) — proves the bug is real
- [ ] On a till that has taken delivery orders, note the **"⟳ N failed"** count: N = ______
- [ ] Ring **one test delivery order** now (pre-fix). Confirm it shows **complete on the till** but is **absent from the dashboard** Orders view. Record its order number: ______
- [ ] (Optional, cloud SQL) confirm it's not there:
      `SELECT count(*) FROM orders WHERE order_type='delivery';`  → expect **0**

## 1. Confirm the migrate landed
- [ ] `DB migrate (production)` Action ran green; **`--plan` listed `90_order_type_delivery_check` pending** (86→90), apply + `verify-db-schema.mjs` both green.
- [ ] (Cloud SQL) constraint now admits delivery:
      `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='orders_order_type_check';`
      → includes **`delivery`** alongside dine_in/takeaway/retail/parking_session/fuel_sale.

## 2. A new delivery sale flows end-to-end
- [ ] Ring a **fresh delivery order** on the till (assign a delivery person). Order #: ______
- [ ] It appears on the **dashboard** Orders view within the normal sync window.
- [ ] (Cloud SQL) the row is real and complete:
      `SELECT order_type, delivery_person, status FROM orders WHERE order_number='<#>';`
      → `order_type='delivery'`, **`delivery_person` populated**, `status='completed'`.
- [ ] The **thermal receipt / KOT** for it still prints the "Delivery Boy" line correctly.

## 3. Parked delivery orders drain — and don't duplicate
- [ ] On the till from §0, tap **"⟳ N failed"**. The count **drops** (the stuck delivery orders push).
- [ ] Your §0 pre-state test order (and any real backlog) now appears on the dashboard.
- [ ] **No duplicates:** each drained order appears **once** on the dashboard / in cloud
      (idempotent on `X-Idempotency-Key: order_id`). Spot-check one order number = one cloud row.

## 4. No regression on the other order types
- [ ] Ring one each of **dine_in, takeaway, retail** (and **parking_session / fuel_sale** if that business uses them) — all sync to the dashboard as before.
- [ ] The till's **"⟳ N failed"** count does **not** climb after normal trading.

## 5. No downstream reader breaks on `delivery` reappearing
- [ ] Dashboard **Reports → Hourly / channel split** renders with a delivery order present (the channel map already maps `delivery`).
- [ ] The **Master/DSR** report totals include the delivery sale and don't error.
- [ ] (Sanity) the **Aggregators** tab is unchanged/empty — that's A130, out of scope here.

## 6. Sign-off / roll-out
- [ ] Trade **one full shift** on one migrated site with delivery in use — drawer balances, no new failed-sync backlog.
- [ ] Then the remaining sites are already covered (this was a cloud/DB change only — **no till rebuild**). Confirm each site's tills show **0 failed** after their next delivery order.

---

**If any box fails, capture the exact error (full text + status + server `ref`, rule 11)**
and stop before rolling wider. The likely failure modes to watch: a delivery order
still 23514-rejected (migrate didn't take — re-check §1), or a downstream report
throwing on `delivery` (a reader that assumed the 5-value set — note which report).
