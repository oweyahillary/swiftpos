# VERIFY — Branding Phase 1 target checks (register A295)

Run on a real till (Windows, Electron 43, v0.6.1 or later) with the cloud reachable. Each line is
PASS/FAIL; write what the screen or paper actually showed (rule 7). These are the checks that
move A308 and A278 from FIX BUILT to CLOSED. Nothing here needs a printer except §F and §G5.

> **RETEST 2026-09-23 (second run).** First run (Tester 1, till mamangina, 0.6.2): A2, A5, B1 FAILED;
> C, D, F skipped. The causes were found and fixed the same day — A316 (web logo save rejected), A317
> (product Edit form rejected an empty description), A319 (web colour rule stricter than the till's).
> **Before starting:** the cloud AND the dashboard must be deployed from `67a5480` or later — ask the
> owner. The till stays on 0.6.2. Re-run **A1–A5, B1, F1–F6 and the new §G**; C and D if time allows.
> Lines marked *(changed)* have a different expectation or extra thing to record than the first run.

## A. Web Branding page → till (closes A308)
1. *(changed)* Dashboard → Settings → Business → Branding. Pick **Teal** from the palette, upload a PNG
   logo under 250 KB. PASS = the lock-screen preview on the page updates before you save. Then Save.
   PASS = the page says **"Saved."** and NO red text appears under the buttons (the first run showed
   `logo_receipt must be a mono1…` here — that was A316). **Record: did "Saved." appear?**
2. On the till, sign a cashier out to the PIN screen. Wait up to 30 s (do NOT restart).
   PASS = divider, active PIN dot and Enter button turn teal; the logo appears on its own chip;
   "powered by SwiftPOS" is still there bottom-left.
3. On the web, upload a 300 KB PNG. PASS = rejected with a size message, nothing saved.
4. On the web, upload an SVG. PASS = rejected.
5. *(changed)* Custom hex: enter `#F5B800` (a strong yellow). PASS = the page shows **"Legible ✓"**
   (no orange warning) and the preview's Enter button is yellow with **black** text. Save; on the till
   PASS = the same yellow with black Enter text.
   Then enter `#1e293b` (dark slate). PASS = the orange "isn't legible" warning shows and the preview
   stays teal. *(The first run used `#777777` here: that grey IS legible — the till accepts it with
   black text — so it is no longer the rejected example.)* Put the accent back to Teal and Save.

## B. Propagation without restart (closes A278)
1. *(changed)* On the web, open a product **whose description is empty** with its **Edit** button
   (not by clicking the price), change the price, Save. PASS = it saves with no red text (the first
   run's `description: Invalid input… received null` was A317). Keep the till on the POS grid.
   PASS = the new price shows on the till within ~20 s with no restart. **Record the seconds, and that
   the Edit form was used.**
2. Pull the till's network cable. Wait 60 s. Reconnect. PASS = the till is still trading and the
   next branding/price change lands after reconnect.

## C. Offline read (regression on A301–A304)
1. With branding set, pull the cable, restart the till. PASS = the branded PIN screen renders
   from the local `branding` row, no error, no SwiftPOS fallback.

## D. Un-branded business (fallback)
1. On the web, clear the logo and reset the accent to SwiftPOS Blue. Save.
   PASS = within 30 s the till shows the SwiftPOS mark and blue; layout stays two-column.

## E. Paper (A310) — DONE 2026-09-22
`receipt-with-logo-80.bin` printed perfectly on the XP-80 via RAW spool. Nothing further owed here.

## F. Receipt logo end-to-end (closes A311, A312, A313 → A295)
Needs: migration 105 on prod, cloud deployed, dashboard deployed, till on ≥ 0.6.2.
1. **Browser.** Settings › Business › Branding. Upload the client's real logo. PASS = the *Receipt preview*
   box shows a black-and-white version of it above the business name. Tick **Print logo on customer
   receipts**. Save. Reload the page. PASS = the tick and the preview are both still there.
2. **Till pull.** On a till, wait 30 s (no restart). Tech feed › Branding. PASS = the same mono preview and
   the tick show on the till; tech console `SELECT receipt_logo_enabled, length(logo_receipt) FROM branding`
   returns `1` and a number in the low thousands.
3. **Real sale.** Ring a small sale and pay. PASS = the receipt has the logo above the business name, the
   rest identical to yesterday's receipts. The KITCHEN and DISPATCH tickets have NO logo.
4. **Toggle off.** In the browser untick the box, Save. Wait 30 s. Ring a sale. PASS = no logo, receipt
   identical to the pre-branding form. The logo is still on the lock screen.
5. **Web POS.** With the toggle back on, ring a sale from the web POS through the Go bridge. PASS = logo
   printed. Reprint the same order from the orders list. PASS = logo printed again.
6. **Bad-logo case.** Upload a gradient/photographic logo. PASS = the receipt preview looks washed-out or
   wrong *on screen* — the client sees it before any paper is spent. Leave the toggle off; upload a solid
   mark instead.
Record what each printed (rule 7). A295 closes when F1–F5 pass on the client's own hardware.
*(F note)* On F5 the WEB receipt now prints "Thank you for your business!" only once (A315 is live on the
web with the dashboard deploy). The TILL's own receipts keep the old closing block until desktop 0.6.3.

## G. The other fixes of 2026-09-23 (new)
Needs: cloud + dashboard deployed from `67a5480` or later. G5 needs the printer.
1. **A318 — Edit/Delete on every row.** Dashboard → Menu → filter **Family Meals**, in the same window
   size that hid Edit before. PASS = **Edit** and **Delete** show at the right end of EVERY row; Edit
   opens the product. Repeat with **Burgers**. (The Cost/Status columns may scroll under the buttons —
   that is expected.)
2. **A317 — empty description saves.** Web: Edit any product with an empty description, change nothing
   but the price, Save → saves. Till: Manager screen › **Menu** tab, edit a product, clear its description,
   Save → saves.
3. **A320 — a blank name is refused.** Web: Edit a product, replace the name with spaces only, Save.
   PASS = refused with **"name: Cannot be empty"** and the product keeps its name. Cancel.
4. **A315 (web) — one thank-you.** On a business whose Receipt footer is blank, ring a web-POS sale and
   print. PASS = "Thank you for your business!" appears ONCE, then "TAX RECEIPT UPON REQUEST" (if VAT
   applies), then "Powered by SwiftPOS" last.
5. **A315 (paper, owner).** Send `shared/printing/out/receipt-80.bin` to the XP-80 by the same RAW path as
   §E. PASS = one "Thank you for your business!", the TAX line, the credit last.

## Results template (paste back)
```
VERIFY-BRANDING-PHASE1 — results (retest)
By: ____ · Date: ____ · Till: ____ · Desktop: 0.6.2 · Cloud/dashboard deployed from: ____
A1: ____  ("Saved." appeared? yes/no)
A2: ____  A3: ____  A4: ____
A5: ____  (#F5B800 on the till: ____ · #1e293b warning shown? ____)
B1: ____  (seconds: __ · Edit form used? yes/no)   B2: ____
C1: ____  D1: ____
F1: ____  F2: ____  F3: ____  F4: ____  F5: ____  F6: ____
G1: ____  G2 web: ____ till: ____  G3: ____  G4: ____  G5: ____
Anything odd (exact message/what the screen or paper showed): ____
```
