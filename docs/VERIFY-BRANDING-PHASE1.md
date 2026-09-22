# VERIFY — Branding Phase 1 target checks (register A295)

Run on a real till (Windows, Electron 43, v0.6.1 or later) with the cloud reachable. Each line is
PASS/FAIL; write what the screen or paper actually showed (rule 7). These are the checks that
move A308 and A278 from FIX BUILT to CLOSED. Nothing here needs a printer except §C.

## A. Web Branding page → till (closes A308)
1. Dashboard → Settings → Business → Branding. Pick **Teal** from the palette, upload a PNG logo
   under 250 KB. Save. PASS = the lock-screen preview on the page updates before you save.
2. On the till, sign a cashier out to the PIN screen. Wait up to 30 s (do NOT restart).
   PASS = divider, active PIN dot and Enter button turn teal; the logo appears on its own chip;
   "powered by SwiftPOS" is still there bottom-left.
3. On the web, upload a 300 KB PNG. PASS = rejected with a size message, nothing saved.
4. On the web, upload an SVG. PASS = rejected.
5. Custom hex: enter `#F5B800` (Taste Town yellow). PASS = accepted; Enter button text goes
   **black**, not white. Enter `#777777`. PASS = rejected by the contrast guard, or falls back to
   SwiftPOS blue on the till — record which.

## B. Propagation without restart (closes A278)
1. On the web, change one product price. Keep the till on the POS grid.
   PASS = the new price shows on the till within ~20 s with no restart. Record the seconds.
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
