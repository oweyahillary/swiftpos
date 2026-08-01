# Parking — design

You said parking doesn't fit the basket model. I want to argue the opposite, because
the answer changes what you build for modules three and four.

---

## 1. Parking already has an analogue in your codebase

A restaurant table is opened, accrues *items*, then closes and pays.
A parking bay is opened, accrues *time*, then closes and pays.

Same lifecycle. Different accrual unit. You already built the first one — it's the
order-first flow (`POST /orders/:id/open` → `POST /orders/:id/pay`), the same path
whose VAT bug was H2.

And whoever wrote the parking schema already saw this:

- Bays are `tables` rows with `slot_type = 'parking_bay'` — the same seating primitive
- `orders.order_type` already includes `'parking_session'`
- `parking_sessions.order_id` is **nullable**

That last one is the tell. It says: the session is an accrual, the order is the sale,
and the order doesn't exist until the money does. That's correct, and it's the thing
this design builds on rather than replaces.

So the unifying rule across all four modules:

> **Something accrues, then converts to order lines at the moment of payment.**
> Restaurant accrues items. Fuel accrues litres. Parking accrues minutes.
> All three land in `orders` / `order_items`.

Hold that line and shifts, business days, blind cash counts, expected-cash,
Z-reports, VAT and sync all work unchanged for every module. Break it — give parking
its own revenue table — and a parking attendant's drawer reconciles through a
different path than a cashier's. That's exactly the divergence that produces a
variance nobody can explain.

---

## 2. What's actually wrong today

Not the shape. Three specific gaps.

### It cannot work offline — this is the disqualifying one

`parking_sessions` is absent from `SYNC_DIRECTION`, has no local SQLite table, and
`POST /:id/close` computes `new Date()` **on the server**.

A gate booth in a basement is the worst connectivity in your entire product, and the
module currently cannot bill anybody when the line drops. For something whose only
job is taking money at a barrier, that's not a limitation — it's a no-sale.

### The pricing model is one number

`rate_per_hour`, `Math.ceil`, minimum one hour. That cannot express a grace period, a
different first hour, a daily maximum, per-vehicle-class rates, or a lost-ticket fee.
Every one is standard at a Kenyan mall or county lot. `vehicle_type` exists and
changes nothing.

The worst omission is the cap. **A car left three days currently bills 72 hours** — a
figure no operator would issue and no driver would pay.

### Nothing ties it to cash control

No shift, no business day, no device, no staff attribution. Everything you validated
on the restaurant module last night simply doesn't reach parking revenue.

---

## 3. The design

### Tariffs, in integer cents

```
parking_tariffs
  vehicle_class            any | motorbike | car | van | lorry | bus
  grace_minutes            free-exit window
  first_period_minutes     + first_period_price_cents
  increment_minutes        + increment_price_cents
  daily_cap_cents          ceiling per rolling 24h
  flat_daily_rate_cents    overrides the ladder entirely
  lost_ticket_fee_cents
```

That covers mall (grace + ladder + cap), county street (flat daily), and boda
(30-minute granularity, low cap) without being a rules engine.

**Integer cents, deliberately.** The restaurant module stores money as `REAL` in the
till's SQLite and accumulates float dust that surfaces as an unexplainable 0.01
drawer variance. Parking multiplies a rate by an increment count — precisely where
that compounds. Don't let anyone "simplify" these to `numeric` later.

### Three decisions worth defending

**Grace is a window, not a deduction.** Leave inside it, free. Stay a minute longer,
pay from entry. Deducting grace gives a bill that jumps oddly at the boundary in a
way no attendant can defend to a driver. Print it on the ticket.

**The cap is per rolling 24h from entry, not per calendar day.** A car in from 22:00
to 02:00 crossed midnight but was there four hours. Charging it two days' cap would
be indefensible at the barrier.

**The tariff is snapshotted onto the session at entry, not looked up at close.** This
does three jobs at once:

- A manager raising the rate at 14:00 can't reprice a car that entered at 09:00
- The till can close a session with no network and no tariff table
- A disputed bill is answerable — the rules that produced the number are stored
  *beside* the number, so "why is it 500?" is answered by the row rather than by
  whatever the tariff happens to say today

### One pricing implementation, run by both sides

`shared/parkingTariff.ts` — pure, no imports, integer cents throughout. Byte-identical
copies in `apps/server` and `apps/desktop`, with `scripts/check-shared-sync.mjs`
failing CI if they drift.

This is the whole point. **H2 happened because two code paths priced the same money
differently.** Parking has the same shape with worse odds — the till prices offline at
the barrier, the server prices again on sync, and if they ever disagree the drawer
won't balance and nobody will know which figure was right.

Two copies of one file is acceptable. Two implementations is not.

### Clock trust — made visible, not prevented

Offline pricing means the *device* clock decides the bill, and a device clock can be
wound back. You cannot prevent that at a disconnected barrier. So don't pretend to:
the till stamps its own clock, the server records arrival, and `clock_skew_seconds`
is computed on sync.

A till reporting consistent negative skew is a report someone can act on. Today that
report couldn't exist at all.

---

## 4. Worked examples

Mall tariff: 15 min grace, 100 first hour, 50/hr after, 500 daily cap.

| Stay | Bill | Why |
|---|---|---|
| 5 min | 0 | dropping someone off |
| 15 min | 0 | exactly the grace boundary |
| 16 min | 100 | one minute past grace — pays from entry |
| 60 min | 100 | the first hour |
| 61 min | 150 | one minute into hour two |
| 3h05 | 250 | 100 + 3 × 50 |
| 12 h | 500 | cap holds it |
| 24h01 | 1,000 | tips into a second rolling day |
| 3 days | 1,500 | three caps — **not 72 hours** |
| lost ticket | 1,000 | flat fee, elapsed time ignored |

All 30 vectors pass, including two properties that must always hold: **price never
decreases as time increases** (a tariff that violates this creates a queue of drivers
waiting for the price to drop), and **lines always sum to the total in integer cents**.

---

## 5. Open questions for you

**Day attribution.** A car enters Monday 22:00, leaves Tuesday 09:00. Revenue lands on
the day the session *closes*, because that's when cash is taken — consistent with how
shifts work. Confirm that's what your clients expect on a daily report.

**The day gate must not block on open sessions.** A car parked overnight is normal, not
an exception. The restaurant day gate refuses to sell with an unclosed day; parking
must not inherit that for open sessions. Needs an explicit carve-out.

**Barrier hardware.** Is there one, or is this attendant-with-a-phone? It changes
whether you need ticket printing, ANPR, or nothing.

**Prepaid/monthly.** Do any clients want season tickets? That's a different accrual
(a prepayment drawn down) and I'd keep it out of v1 unless someone's asked.

---

## 6. What I'd build, in order

1. **Migration 51** — tariffs and session columns *(done, 11 assertions)*
2. **`parking_sessions: 'push'`** in `SYNC_DIRECTION` + local SQLite table
   — this is what makes it offline-capable, and it's the smallest change with the
   biggest effect
3. **Rewrite `POST /:id/close`** to accept a till-computed price and *verify* it
   server-side with the same function, rather than computing it fresh
4. **Till UI** — bay grid, plate entry, close-and-pay
5. **Ticket printing** through the existing `ticketLines.ts` and station routing

Steps 1–3 are the foundation. 4–5 are the visible product.

---

## 7. And fuel, briefly

Same principle, and you're one column away.

`orders.pump_id` exists in Postgres and **not** in the till's SQLite — your own
`schema-parity.mjs` has been saying so for weeks:

```
orders.pump_id  in Postgres, missing locally — the till cannot populate it
```

So every fuel sale rung offline loses its pump attribution permanently. That's why
fuel reports read zero. Not a reporting bug — a missing column three layers down.

~20 lines: add `pump_id TEXT` via `migrateColumns`, thread it through
`createLocalOrder`, include it in the sync payload. It needs a till rebuild, so **ride
it along with the M33 rebuild** rather than triggering a second one.

One thing to check before fuel goes far: confirm `order_items.quantity` is numeric,
not integer. 12.47 litres has to survive the round trip.
