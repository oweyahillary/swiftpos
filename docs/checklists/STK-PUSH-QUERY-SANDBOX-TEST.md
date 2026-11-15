# ZapTill — A623 STK Push Query recovery: Daraja sandbox test

**What this closes:** A623 — a lost or late M-Pesa STK callback used to let `GET /api/mpesa/status` mark a customer who **had already paid** as **failed** at the 70 s timeout (the exact fault seen on 2026-11-15: a prompt was accepted and paid, but the system waited ~60 s and then failed it). A623 asks Safaricom the real outcome first (Daraja STK Push Query, `lib/stkQuery.ts`) and settles on it. The code is built and bench-green (`tests/stk-query.test.mjs` 21/21, the M-Pesa route suites green); this is the live sandbox pass that turns it from BUILT into CLOSED (rule 16).

**You need:** a **sandbox**-configured business or branch (Daraja sandbox consumer key / secret / shortcode / passkey, M-Pesa › STK push), the **A623 server deployed**, **migration 191 run** on that database, a **real phone** that can accept the prompt (the sandbox still moves **KES 1** — keep every amount at 1), and access to the **server log** (to see the `[mpesa]` lines) and to that environment's **env vars** (to simulate a lost callback). Do this on the **sandbox / test server — never touch production callbacks.**

> If a test FAILS, stop and send me the exact POS message, the status the sale ended in, and the matching `[mpesa] …` log line. That is a real bug, not a checklist gap (rule 11). Nothing here needs new code.

## How to simulate a lost callback (the heart of the test)
The recovery only has to run when the callback does **not** settle the prompt in time. Make that happen without waiting for a real network fault, in **one** of these ways on the sandbox server:
1. **Reject the callback (simplest):** set `MPESA_ALLOWED_IPS` to a bogus value (for example `203.0.113.1`) so every incoming callback is refused at the IP gate — the server never settles via callback, exactly as a lost one. Restore the real value after the test.
2. **Black-hole the callback:** point `CALLBACK_BASE` (the STK callback host) at a URL that is not your server, so Safaricom's callback never arrives. Restore it after.

Either way the prompt stays pending with no callback, so the query at ~25 s is what resolves it.

## Setup — do this first
1. Confirm the sandbox business/branch has **M-Pesa STK configured** and the server shows A623 (the `/api/mpesa/status` route is the A623 build) with **migration 191 applied** (the `mpesa_queried_at` column exists on `payments` and `mpesa_stk_requests`).
2. Turn on the **lost-callback simulation** (one method above).
3. Open the **server log** and keep it visible.

## Test 1 — The real bug: paid, callback lost, must still complete (headline)
- With the simulation ON, ring a **KES 1** sale and send the STK prompt to the phone.
- On the phone, **accept and enter the PIN — actually pay.**
- Do **not** expect a callback (it is being dropped). Watch the POS and the log.
- **Expect, all of:**
  - At about **25 s** the log shows a query firing, then **`[mpesa] STK query CONFIRMED paid without a callback`**.
  - Within a poll or two the POS flips to **PAID / completed** — **not** failed — and the sale closes.
  - The payment's note reads **"Confirmed by Safaricom query — M-Pesa receipt reconciles later"** (no M-Pesa receipt yet, by design).
  - It resolves **before** the old 70 s timeout. Pass / Fail.
- (Before A623 this same run ended **failed** at ~70 s — that is the fault this proves fixed.)

## Test 2 — The customer ignores the prompt (no response)
- Simulation still ON. Ring a **KES 1** prompt and **do nothing on the phone** (let it sit).
- **Expect:** at ~25 s the query runs and the sale is marked **failed** with **"No response from the customer (timed out)"** — a real, named reason, and sooner than the 70 s blind timeout. Pass / Fail.

## Test 3 — The customer cancels
- Simulation still ON. Ring a **KES 1** prompt and **Cancel** it on the phone.
- **Expect:** the sale is marked **failed** with **"Cancelled by the customer"** (from the query's ResultCode). Pass / Fail.

## Test 4 — One query per prompt, not a flood (rate guard)
- During Test 1 or 2, watch the log while the POS polls every 3 s.
- **Expect:** the query fires **about once every 20 s**, not on every 3 s poll — the `mpesa_queried_at` claim is working, so Daraja is not hammered. Pass / Fail.

## Test 5 — Regression: a normal callback still completes fast
- **Turn the simulation OFF** (restore `MPESA_ALLOWED_IPS` / `CALLBACK_BASE`).
- Ring a **KES 1** prompt and **pay** normally.
- **Expect:** the sale completes **within a few seconds** on the callback, **with** the real M-Pesa receipt number — the recovery query never needed to fire (it settled well before 25 s). Pass / Fail.

## Test 6 — Both surfaces
- Run Test 1 once from a **web POS order** (settles on the `payments` row) and once from a **desktop POS prompt** (the A607 `mpesa_stk_requests` row).
- **Expect:** the recovery works the same on both. Pass / Fail.

## Teardown
- **Restore `MPESA_ALLOWED_IPS` and `CALLBACK_BASE`** to their real values. Confirm a final normal payment completes on the callback (Test 5 again) so the environment is back to normal.

## Copy this back to close A623
Build tested is the **A623 server** with **migration 191**.

| # | Check | Result | Note |
|---|---|---|---|
| T1 | Paid + callback lost → completed via query (not failed), with the reconcile note, before 70 s | PASS / FAIL | |
| T2 | No response → failed "No response (timed out)" at ~25 s | PASS / FAIL | |
| T3 | Cancelled → failed "Cancelled by the customer" | PASS / FAIL | |
| T4 | One query per ~20 s, not every 3 s poll | PASS / FAIL | |
| T5 | Normal callback still completes fast, with the real receipt | PASS / FAIL | |
| T6 | Works on both web (`payments`) and desktop POS (`mpesa_stk_requests`) | PASS / FAIL | |
| — | Env vars restored after the test | DONE / — | |

**Note on the receipt:** a query-confirmed payment has **no M-Pesa receipt number** (the query does not return one). The sale is complete and the money is in; the receipt reconciles against the Daraja statement, or fills in if a late callback still arrives. That is the owner's decision (2026-11-15) and is expected, not a failure. Once every box above passes, A623 is **CLOSED** and clear for production.
