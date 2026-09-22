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

## E. What this checklist does NOT cover (owed builds, not owed checks)
- Receipt logo (SCOPE §10 item 4) — not built; no check possible yet.
- Receipt preview on the web page (addendum §C) — not built.
