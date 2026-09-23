# Verification log — 2026-09-23 (Branding Phase 1 retest)

Session: **Eugene**, till **mamangina** (B Foods / Mama Ngina — the client's own till), desktop **0.6.2**, cloud +
dashboard deployed from the tip at the time (`a5a3a3f`; stated as "current"). Checklist:
`docs/VERIFY-BRANDING-PHASE1.md` / `docs/checklists/verify-branding-phase1.html` (delivery -r/-s). Register updated
alongside this log (delivery -t). First run the same morning (Tester 1): A2, A5, B1 FAILED — causes A316, A319, A317,
fixed the same day (deliveries -n, -p).

## Results as returned
```
VERIFY-BRANDING-PHASE1 — results (retest)
By: Eugene · Date: 23-09-2026 · Till: mamangina · Desktop: 0.6.2 · Cloud/dashboard from: current
A1: PASS — YES      A2: not run   A3: PASS   A4: PASS   A5: not run
B1: PASS — but i had to log in a log out a cashier it was not automatic      B2: PASS
C1: PASS            D1: PASS
F1: PASS  F2: PASS  F3: PASS  F4: PASS  F5: PASS  F6: PASS
G1: PASS  G2: PASS  G3: PASS  G4: PASS  G5: PASS
Summary: 18 PASS · 0 FAIL · 0 SKIP · 2 not run
```

## Closed on target (7)
| ID | What was verified |
|---|---|
| A316 (P1) web receipt logo codec | A1 "Saved." (no `logo_receipt` 400) · F1 preview shows the logo · F5 web POS + reprint print it |
| A317 (P2) empty description | G2 web + till Manager › Menu |
| A318 (P3) Edit/Delete clipped | G1 Family Meals + Burgers |
| A320 (P3) blank product name | G3 refused with "name: Cannot be empty" |
| A311 (P3) receipt logo data + sync | F2 till pulled toggle + raster |
| A312 (P3) till prints the logo | F3 logo on receipt, none on kitchen/dispatch · F4 toggle off works · F6 bad logo visible on screen first |
| A313 (P3) web page toggle + preview | F1 + F5 |

## Verified, item stays open
- **A315** — G4 (web: one thank-you) and G5 (paper) PASS. Till receipts change only with desktop **0.6.3**.
- **A295** — §10 item 4 (receipt logo) now closed on target. Still open on item 5 (A2, A5 not run) and item 7
  (propagation — see A321).
- **A301–A304** regression holds: C1 offline read PASS. D1 un-branded fallback PASS.

## Not run
- **A2** (lock screen turns teal without a restart) — would fail today by design of A321: the lock screen never refreshes.
- **A5** (custom `#F5B800`) — web-only; the only check holding **A319**.

## B1 — recorded PASS, read as "not automatic"
The price reached the till, but only after a cashier signed in and out. A278's goal is a change that applies to the running
till by itself, so A278 **stays open**. Diagnosed the same day from source and opened as **A321**: the data DOES arrive in the
till's local DB (a PIN sign-in only pulls on a branch change, so the price was already there); only ONE of the till's eight
pull paths tells the open screen to reload, the 20-s check fails silently on any error, and the lock screen never listens.
Fix planned for desktop 0.6.3 — held at the owner's request until testing finished.
