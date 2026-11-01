# A618 — M-Pesa (STK push) details per branch

**Owner, 2026-11-01.** STK push (Lipa Na M-Pesa Online: the payment prompt on the customer's phone) was tested on dev the
same day. The web POS was tried with a payment, a cancel, a time-out, a double tap and a wrong number. But the Daraja
details could only be put in by SQL, and only for the whole business. The owner: *"it should be per branch since different
branches might have different payment method some paybill some buy goods"*.

## 1. What it does

- **A business default and a branch's own.** A branch with its own details uses them. A branch without its own, or whose
  own are incomplete, uses the business default. If neither exists, the POS offers the manual M-Pesa reference only.
- **Every prompt uses the right branch:**
  - the desktop POS's prompt uses the POS's branch;
  - the web POS's prompt uses the branch the order was made at;
  - `/api/mpesa/config` answers for the session's branch.
- **Buy Goods.** Safaricom signs the request with the **store number** (the shortcode). The money goes to the **Buy Goods
  Till number**. If the Till number is left blank, the money goes to the store number. **Paybill:** the shortcode does both.
- **Secrets stay on the server.** The consumer secret and the passkey are encrypted when saved. The screen never gets
  them back, and it never gets the whole consumer key: it shows "saved" and the key's last 4 characters.

## 2. Where on screen

**Settings › Business › Payments › M-Pesa (STK push)**. Only the owner sees it. Managers, partners and POS sessions are
refused, the same as the business's other M-Pesa settings.

- **Business default** card: what it is (for example "Paybill 174379"), Sandbox or Live, the key's last 4, and who saved
  it and when. Buttons: **Set up** or **Edit**, and **Test connection**.
- **One row per branch**: "Own settings — Buy Goods 163726 (store 600100)", or "Uses the business default — Paybill
  174379". Buttons: **Give it its own** or **Edit own**, **Test connection**, and **Remove own** (the branch goes back to
  the default).
- **The form** has these fields:
  - Paybill or Buy Goods;
  - the Paybill number, or for Buy Goods the store number and the Buy Goods Till number;
  - consumer key;
  - consumer secret and passkey (hidden; leave them blank to keep the saved ones, so you can change a number without
    typing the secrets again);
  - Sandbox or Live.
- **Test connection** asks Safaricom for an access token with the saved details, from Sandbox or Live as saved. Nobody is
  charged and no phone gets a prompt. It shows "Connected", or Safaricom's own reason (for example "Invalid
  Authentication passed"). The test gives up after 15 seconds.

## 3. The receipt-number warning

The M-Pesa line printed on a branch's receipts is set by the branch manager on the POS (**Manager › Settings › M-Pesa**,
A492). If it names a different number from the one STK payments go to, the branch's row says so, for example:

> Receipts at this branch say Buy Goods 163726, but STK payments go to Paybill 174379.

Fix whichever is wrong. If they disagree, a customer who pays by hand from the receipt pays to a different number.

If the saved details say Sandbox but the server sends prompts to Live M-Pesa (or the other way round), the screen warns
too. Prompts would fail.

## 4. How to fill in the Daraja details

From the Safaricom Daraja portal (developer.safaricom.co.ke):

- **Sandbox (testing):**
  - the test app's consumer key and secret;
  - shortcode `174379`, and the sandbox passkey shown on the portal's Lipa Na M-Pesa Online simulator.
- **Live:**
  - the production app's consumer key and secret;
  - the Paybill number, or for Buy Goods the store number (head office number) and the Till number;
  - the passkey Safaricom e-mails when the shortcode goes live.

Save, then press **Test connection**.

## 5. Run order

- **Migration 186** (`migrations/186_branch_mpesa.sql`) can run any time, before or after the server deploy.
- Until it runs, the server uses the business default for every branch and never fails a payment because of the missing
  table. The screen says a branch's own details need the database update, and the default can still be saved.
- The business default stays in `business_settings` as before (`mpesa_*`). A618 adds three keys there:
  `mpesa_till_number`, `mpesa_environment` and `mpesa_updated_by`.

## 6. Technical

- **Table** `branch_mpesa_settings` (one row per branch; deleted with its branch; service role only). Columns: type,
  shortcode, till_number, consumer_key, consumer_secret and passkey (both encrypted), environment, updated_at, updated_by.
- **Code:**
  - `apps/server/src/lib/branchMpesa.ts`: reads and resolves the details, builds the STK parties, cleans the form, makes
    the receipt warning and runs the connection test;
  - `apps/server/src/routes/mpesaSettings.ts`: `GET /api/mpesa/settings`, `PUT /default`, `PUT` and `DELETE /branches/:id`,
    and `POST /test`;
  - `apps/dashboard/src/pages/settings/MpesaStkSettings.tsx`: the screen.
- **Tests:** `tests/a618-branch-mpesa.test.mjs` and `scripts/test-migration-186.mjs` (in CI).
