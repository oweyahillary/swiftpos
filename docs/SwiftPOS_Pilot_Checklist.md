# SwiftPOS — Fast Food Pilot Checklist

**Pilot client:** fast food, single till, pay-first
**Code sprint:** Sat 25 Jul (2 hours)
**Test window:** Sun 26 – Mon 27 Jul
**Client install:** Tue 28 Jul

---

## Reality check on the 2 hours

Two hours is enough for **Block A only** — the code changes. It is not enough to also
configure the tenant, test the till, or rehearse the install. Those are Blocks B–E and
they need roughly 6–8 more hours across Sunday and Monday.

Finishing Block A does not mean you are ready for Tuesday. It means Sunday's test day
has something worth testing.

**Rule for the whole sprint:** every change below is additive, guarded, or cosmetic.
Nothing touches the order fulfilment block in `orders.ts`. If a change starts growing
beyond its time-box, stop and defer it — a half-finished edit to the sell path is worse
than the bug it was fixing.

---

## Block A — the 2-hour code sprint

Work top down. A1 blocks everything else; if you only get one thing done, get that one.

### A1 · `render.yaml` env vars — server will not boot without this (40 min)

**File:** `render.yaml`

25 variables referenced in `apps/server/src` are missing from the deploy manifest.
`routes/tech.ts:32` throws at module load without `TECH_HMAC_SECRET`, so the process
dies on start.

Add all of the following with `sync: false`, then set the real values in the Render
dashboard:

```
ADMIN_JWT_SECRET          TECH_HMAC_SECRET          TECH_SIGNING_PRIVATE_KEY
TECH_SIGNING_PUBLIC_KEY   RESEND_API_KEY            PORT
MPESA_ALLOWED_IPS         ADMIN_EMAIL               ADMIN_PASSWORD
DAILY_SUMMARY_CRON
```

Set these two with explicit values, not `sync: false`:

```yaml
- key: MPESA_ENVIRONMENT
  value: production      # unset defaults to sandbox AND disables the callback IP allowlist
- key: ETIMS_PROVIDER
  value: none            # stops the retry job scheduling; per-business flag stays off too
```

Skip the remaining `ETIMS_*`, `WHATSAPP_*` and `TWILIO_*` vars — not in pilot scope.

Generate what you need:
```bash
openssl rand -hex 32                          # TECH_HMAC_SECRET, ADMIN_JWT_SECRET
openssl genpkey -algorithm ed25519            # TECH_SIGNING_* keypair
```

- [ ] Vars added to `render.yaml`
- [ ] Real values set in Render dashboard
- [ ] Deployed
- [ ] **Verify:** service reaches healthy state; `GET /health` returns 200; logs show no
      `Missing TECH_HMAC_SECRET` throw
- [ ] **Verify:** logs show `[etimsRetry] eTIMS disabled` — confirms `ETIMS_PROVIDER=none` took

---

### A2 · Receipt VAT line (15 min)

**File:** `apps/desktop/src/renderer/components/ReceiptView.tsx:89`

Currently prints the literal string `VAT (16%)`. The *amount* is correct; only the label
is hardcoded. Two changes:

1. Read the rate from business settings instead of the literal
2. Hide the VAT row entirely when the rate is 0 — otherwise a non-VAT-registered client
   gets a `VAT 0.00` line on every customer receipt

The dashboard's web POS receipt (`apps/dashboard/src/pages/pos/ReceiptView.tsx:66`)
already reads from settings — no change needed there.

- [ ] Rate read from settings
- [ ] Row hidden when rate is 0
- [ ] **Verify:** print one receipt at the client's real rate, one with rate set to 0

---

### A3 · Tax report rate (5 min)

**File:** `apps/server/src/routes/reports.ts:1010`

Returns `rates: { vatRate: 16 }` as a literal while computing VAT from
`businesses.vat_rate`. Return the real value. Finding **M1**.

If you decide to hide the tax tab from the pilot client entirely, skip this — but do it
anyway, it's five minutes and it's a document people file from.

- [ ] Literal replaced with the computed rate
- [ ] **Verify:** set a test business to a non-16% rate, call `/api/reports/tax`, confirm
      the returned rate matches

---

### A4 · Discount cap (15 min)

**File:** `apps/server/src/routes/orders.ts:197`

Currently `Math.min(Math.max(0, discountAmount), subtotal)` — clamped to the subtotal and
nothing else. No permission, no cap, no reason code. This is finding **M4**, the most
common POS fraud vector, and it is fully live in a minimum build.

**Not** the full M4 fix. Add a single constant cap as a percentage of subtotal:

```ts
const MAX_DISCOUNT_PCT = 10;   // pilot stopgap — full fix is M4 (gate + reason code + supervisor auth)
```

Clamp to `min(discountAmount, subtotal * MAX_DISCOUNT_PCT / 100)`.

- [ ] Cap applied
- [ ] **Verify:** attempt a 50% discount at the till → clamped to 10%; a 5% discount goes
      through unchanged

---

### A5 · Icon and version (15 min)

**Files:** `apps/desktop/resources/` (currently empty), `apps/desktop/package.json`

- [ ] Icon added (`.ico` for Windows NSIS, 256×256 minimum)
- [ ] `build.win.icon` path set in `package.json`
- [ ] Version bumped `0.0.1` → `0.1.0`
- [ ] **Verify:** build the installer, confirm it shows your icon not the default Electron one

---

### A6 · Nav filtering — the strip-down (30 min, defer if short on time)

**File:** `apps/dashboard/src/components/DashboardLayout.tsx`

Nav is not permission-filtered, so out-of-scope features still show links that 403 on
click. Hide sections the pilot role has no permission for.

**Hide:** Ingredients · Recipes · Suppliers · Purchase Orders · GRN · Stock Transfers ·
Promotions · Discounts · Loyalty/CRM · Credit Accounts · Reservations · QR Menu ·
Floor Plan · Webhooks

**Keep:** Products · Categories · Staff · Reports · Orders · Settings

This is cosmetic and additive. If it starts touching routing or permissions logic, stop —
Block B's role setup already blocks access at the API. The nav filter is polish.

- [ ] Sections filtered by permission
- [ ] **Verify:** log in as the pilot owner, confirm only the six kept sections appear

---

## Block B — tenant configuration (1 hour, no code)

Can run in parallel with Block A. Nothing here is a code change.

- [ ] Business created, `business_type` = `restaurant`
- [ ] **Service model = pay-first** — puts the till on `POST /api/orders` and takes
      findings H2, H4 and H5 off the table entirely. Single most valuable setting here.
- [ ] `vat_rate` set to the client's actual rate
- [ ] `feature_flags.etims_enabled` absent or false for this business
- [ ] Owner role: `products.manage`, `orders.create`, `orders.void`, `reports.view`,
      `staff.manage`, `settings.manage`
- [ ] Cashier role: `orders.create`, `orders.void` only
- [ ] Zero rows in `promotions` for this business — the sync engine does not pull them,
      so anything active here silently fails to apply at the till
- [ ] `require_device_registration` set false for install day, or owner available to approve
- [ ] Device configured `device_role: 'till'` — **never** `'node'`. Node mode opens an
      unauthenticated HTTP server on port 4100.
- [ ] Product catalogue imported via `POST /api/products/bulk` (no import UI exists —
      do this yourself before Tuesday, do not type 300 SKUs on site)
- [ ] Variants and modifiers configured (sizes, meal upgrades, no-onions)
- [ ] Staff created with PINs
- [ ] Receipt header/footer set
- [ ] Remote access tool installed on the till (AnyDesk / RustDesk) — **this is your
      update channel**, there is no auto-updater

---

## Block C — Sunday: does it survive?

Run this as a script on the **actual till hardware and the actual printers**. Unstructured
clicking will find nothing.

- [ ] Fresh install from the built NSIS installer, timed
- [ ] Both printers installed as Windows drivers and selected in printer settings
- [ ] Open shift with a float
- [ ] Run 40 orders in an hour: singles, 2-way splits, cash + M-Pesa, two voids, one discount
- [ ] **Pull the network cable mid-service.** Keep selling 20 minutes. Reconnect.
- [ ] Verify every offline order landed exactly once; `sync_queue` has no `failed` rows
- [ ] **Kill the app from Task Manager mid-order.** Restart. Confirm shift and held tabs survived
- [ ] Close the shift offline, reconnect, watch `reconcileClosedShifts` fire
- [ ] Confirm server `expected_cash` matches a hand count of the drawer, not the till's own number

### Printing — test explicitly, this is the client's stated priority

- [ ] 20 receipts and 20 KOTs printed back to back
- [ ] **Check for a long blank feed after each receipt** — `printService.ts` sets page height
      to a fixed 297mm and some thermal drivers honour it literally. One-line fix if seen.
- [ ] **Turn the printer off mid-sale.** The sale must still complete. Verify it does and
      that the receipt can be reprinted from order history afterwards.
- [ ] Confirm the browser print-dialog fallback never fires in normal operation — a dialog
      popping up at the counter during a rush is a bad failure mode
- [ ] Reprint from order history works
- [ ] KOT lands on the kitchen printer, not the till printer

---

## Block D — Monday: do the numbers agree?

- [ ] Reconcile Sunday's takings by hand → Z report → dashboard. Three numbers, must match.
- [ ] Run the reconciliation query: `orders.total` vs `SUM(payments.amount)` per order.
      Any disagreement is finding **H1** showing up in your own data — find it now, not
      after the client does.
- [ ] Check shift variance figures are sane
- [ ] Cold-install twice more, timed — you are doing this in the client's shop Tuesday morning
- [ ] Write the one-page cashier cheat sheet (open shift, sell, void, close shift, what to
      do if the printer dies)
- [ ] Update `SwiftPOS_Audit_Tracker.xlsx` — use the dropdown value
      **`Fixed - Pending Verification`**, not the plain `Fixed` currently in the sheet.
      Plain `Fixed` matches no Dashboard formula, so twelve fixes are counting as nothing.

---

## Block E — Tuesday: install day

- [ ] Arrive before service, not during
- [ ] Install, activate, PIN login, confirm catalogue pulled
- [ ] Test print on the client's own printers before anyone queues
- [ ] Open the shift with the real float
- [ ] **Stand there for the first service.** Do not install and leave.
- [ ] Confirm the ETR reconciliation routine with whoever closes the till

### Tell the client, in writing

1. Keep the old system running in parallel this week; count the drawer by hand every night
2. Voids work within 30 minutes only. **There is no refund flow at all** — anything older,
   call you
3. Ignore the food cost report — ingredient tracking is not enabled
4. eTIMS fiscalisation is on their separate device. Agree who reconciles SwiftPOS totals
   against the ETR at close, and which record is the source of truth for their books

### Watch daily, first week

- `sync_queue` rows with status `failed`
- Shift cash variances
- Orders where payments don't sum to the total
- Discount totals per cashier as a percentage of sales

---

## Explicitly not doing — accepted risk

Know what you're carrying in, so nothing is a surprise on Friday:

| ID | Risk carried into the pilot |
|---|---|
| **H1** | Payment legs never validated against the order total. Mitigated by the till enforcing balance client-side and by the daily reconciliation query — not by a server-side control. |
| **H3** | Void reverses only one leg of a split tender. Watch split-tender voids specifically. |
| **M3** | 30-minute void window, no refunds, ever. Client must be told. |
| **M7** | No transaction boundary on order creation. Low probability, silent when it happens. |
| **M8** | Shift variance excludes void reversals — every cash void reads as a false shortage of exactly that amount. Expect it, don't chase it. |
| **M4** | Only partially mitigated by A4's cap. No reason code, no supervisor auth, no permission gate. |
| — | No auto-update. Every fix is a remote session. |
| — | Desktop app unsigned — SmartScreen warning on install. Acceptable because you install it yourself. |
| — | Desktop renderer has never been audited by anyone but us. |

---

## Sequence summary

| When | Block | Hours |
|---|---|---|
| Sat (now) | A — code sprint | 2 |
| Sat / Sun | B — tenant config | 1 |
| Sun | C — survival testing | 4 |
| Mon | D — reconciliation + rehearsal | 3 |
| Tue | E — install and first service | — |
