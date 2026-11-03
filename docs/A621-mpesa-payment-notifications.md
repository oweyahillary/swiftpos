# A621 — M-Pesa payment notifications (C2B)

**Owner, 2026-11-02.** *"Some customers do not like giving out their number, they prefer paying to the till or paybill
directly; what the cashier gets is a notification of the payments done, then they match it to the bill."*

The owner's decisions:

1. The cashier always **taps** the payment that belongs to the bill. Nothing is matched by amount alone. On a Paybill, a
   payment whose account number is the bill's or table's number is listed first, but it still needs a tap.
2. It is part of the **online licence** (premium), like the M-Pesa prompt.
3. It ships in the **next desktop release**, not 1.0.23.

## 1. What it does

- A customer pays the branch's **Buy Goods Till number** or **Paybill** from their own phone. Safaricom tells ZapTill's
  cloud about the payment within seconds.
- On the POS, a notice shows: **"KES 1,080 received — JOHN — QJK7XT3L5P"**.
- On the payment screen, under an **M-Pesa** payment, a list **"Payments received"** shows the branch's payments from the
  last 30 minutes that nobody has used yet **and that pay exactly the bill** (owner, 2026-11-03: "show payments that
  match the bill only"): the amount, the first name, the time and the M-Pesa code. A bill with cents is matched by its
  shillings rounded up, as the M-Pesa prompt asks. A payment for more or less is not listed; if it is right, the cashier
  types its code by hand.
- The cashier **taps** the customer's payment, and the sale completes and the receipt prints by itself. No need to press
  Charge.
- Two cashiers tapping the same payment: the first one gets it. The second is told "Another POS has just taken that
  payment" and picks again.
- If the cashier takes the payment off the bill, or closes the payment screen without a sale, the payment goes back to the
  list for any POS.
- **Typing the M-Pesa code by hand still works**, exactly as before. A code typed by hand also counts as used.
- **Reports › M-Pesa unmatched** lists the payments no sale used, by day and branch, so the owner sees money nobody put
  on a bill.

## 2. Setting it up

**Settings › Business › Integrations › M-Pesa**, below the STK push details. Only the owner sees it.

1. First save the branch's **M-Pesa (STK push)** details (A618) and press **Test connection**. Safaricom is asked with the
   same details.
2. Under **Payment notifications**, switch it on for the branch.
3. **Buy Goods only:** enter the **store number** (the head office shortcode). This is *not* the Till number printed on the
   receipt. Leave it blank to use the store number already in the STK details.
4. Press **Register with Safaricom**. The screen shows the result, or Safaricom's own reason for refusing.
5. **Sandbox only:** press **Send a test payment (sandbox)**. A KES 1 test payment from Safaricom's test number shows on the
   branch's POS a few seconds later. No real money moves.

## 3. Limits — read before registering

- **One registration per number.** Safaricom sends a Paybill's or Till's payment notifications to **one** place. If the
  business's bank or accounting system already receives them, registering here **stops theirs**. Check with them first.
  Two branches of the business cannot register the same number either; the screen names the branch that has it.
- **Buy Goods registers the store number**, not the Till number on the receipt.
- **Masked phone numbers.** Safaricom now hides most of the payer's number (for example `2547 ***** 149`), or sends a code
  instead. ZapTill never keeps a full phone number, and the cashier matches by amount, name, time and code — never by
  phone.
- **Internet is needed** on the POS. Offline, nothing new shows and the cashier types the M-Pesa code by hand.
- **The notice** (the pop-up on the POS) shows on a desktop POS that talks to the cloud itself. A POS behind a branch
  server, and the web POS, see the payment in the payment screen's list (it checks every 5 seconds while open).
- **Without the online licence**, nothing new shows on the POS and the owner can only switch notifications off.
- A payment a cashier took for a sale that never reached the cloud stays **"Held by a POS"** in the unmatched list until
  that sale arrives (for example a POS that went offline after the tap). The owner can press **Release** there, and the
  payment shows on every POS again (owner, 2026-11-03).

## 4. Run order

1. **Migration 188** (`migrations/188_mpesa_c2b.sql`) — any time, before or after the server deploy. Until it runs, the
   cloud answers Safaricom "Accepted" and keeps nothing, the POS shows nothing new, and the settings screen says the
   database update is needed.
2. Deploy the server. `MPESA_CALLBACK_BASE_URL` must be the cloud's public **https** address and must not contain the words
   Safaricom refuses (`mpesa`, `m-pesa`, `safaricom`, `exe`, `exec`, `cmd`, `sql`, `query`) — the screen says so if it does.
3. Release the desktop POS (the next batch). The web POS and the dashboard get it with the deploy.
4. Register each branch (section 2).

## 5. Technical

- **Safaricom's addresses** (no sign-in — the branch's secret token in the path is the proof; only its SHA-256 is stored):
  - `POST /api/payments/c2b/confirm/<token>` — keeps the payment once per M-Pesa code and rings the branch's POSs. Always
    answers `{ ResultCode: 0, ResultDesc: "Accepted" }`.
  - `POST /api/payments/c2b/validate/<token>` — always accepts.
  - A new token is made at every **Register**; it is saved only after Safaricom accepted, so a refusal never breaks the
    registration that worked before.
- **POS:** `GET /api/payments/c2b/recent?amount=&ref=&since=`, `POST /api/payments/c2b/claim`, `POST /api/payments/c2b/release`
  (the right to sell, the POS's branch, the online licence). An unchanged list costs the cloud no database read (the
  `since` stamp). An order whose M-Pesa reference is the code marks the payment used (`POST /api/orders` and `/pay`).
- **Owner:** `GET /api/mpesa/c2b-settings`, `PUT /branches/:id`, `POST /branches/:id/register`, `POST /branches/:id/test-payment`,
  `POST /payments/:code/release` (a held payment back to every POS's list).
  **Reports:** `GET /api/payments/c2b/unmatched?from=&to=` (reports.payments).
- **Tables** (migration 188, service role only): `branch_c2b_settings` (on/off, store number, token hash, registration,
  Safaricom's last refusal) and `mpesa_c2b_payments` (the payments: received → held → used; never a full phone number).
- **Code:** `apps/server/src/lib/c2b.ts` (the rules), `c2bStore.ts` (the database), `c2bDaraja.ts` (Safaricom),
  `c2bActivity.ts`, `c2bAccess.ts`, `c2bOrders.ts`; `apps/server/src/routes/c2b.ts`, `c2bSettings.ts`;
  `shared/mpesaPayments.ts` (both POSs); desktop `main/mpesaC2b.ts`, `main/ipc/mpesaC2b.ts`,
  `renderer/components/MpesaReceivedPanel.tsx`, `MpesaArrivedNotice.tsx`; web `pages/pos/MpesaReceivedList.tsx`,
  `pages/settings/MpesaNotificationsSettings.tsx`, `pages/reports/MpesaUnmatchedTab.tsx`.
- **Tests:** `tests/mpesa-c2b-a621.test.mjs`, `apps/desktop/test/mpesa-c2b-a621.test.mjs`, `scripts/test-migration-188.mjs`
  (in CI).
