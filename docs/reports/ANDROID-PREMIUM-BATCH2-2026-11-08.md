# Android premium build — Batch 2 (overnight, 2026-11-08)

**Written for: Stephen (owner).** Built overnight on branch `android-ui-polish`, on top of Batch 1 (`9d2469f4`, already committed + pushed). Nothing committed, pushed, or deployed — the commit command is at the bottom for you to run.

## What I built (the five you asked for)

1. **Reprint receipt — BACK button fixed.** The trap was the payment/receipt screen: a React overlay with no dismiss the hardware back could reach, and the app registered no back handler at all. Added a decoupled `zaptill:back` event from the app shell + a LIFO `useBackDismiss` hook in the web POS. Hardware back now = close the topmost overlay (receipt, covers, parking, pump, fuel keypad) → else leave the tech page → else **nothing** (a stray press never signs a cashier out or exits the app; they lock with the Lock button). Listens only for the Android event, so the web/desktop POS is untouched.

2. **Category "pin" hidden on Android.** Threaded a `pinnable` flag through the shared panel; the tablet gets no pin button and no stuck-pinned state. Web/desktop keep it.

3. **"This device" hidden behind a long-press.** Removed the visible links; an **800 ms press-and-hold** on the PIN header (and on the offline cover) opens it — the same gesture the desktop uses. No server token, deliberately: that page (printer setup, Reset app) must open **offline**, so a server check would lock the technician out. Tell your techs: *hold the business-name header for ~1 second.*

4. **Client logo on the POS header.** Premium/themed businesses now show their logo where the ⚡ was (the same gated logo the customer screen uses); others keep ⚡. (The logo is a `data:` image, so it was never CSP-blocked — Batch 1's CSP fix was for the **product photos**.)

5. **Offline selling — WIRED.** This is the big one. With no connection the selling screen keeps working: a sale is buffered, answered provisionally so it completes and prints, and the queue drains to the cloud automatically when the connection returns (idempotent — no double-charge; priced as of when it was rung up). The "No connection — can't sell" cover no longer blocks the selling screen; a thin status strip shows "Offline — sales are saved and will sync". Built android-side only (the web/desktop POS code is untouched), online selling is an unchanged pass-through.

## Verified (automated)
- Type-checks clean: Android app, and the server/dashboard/admin ratchet (0 errors).
- Android suites: stage-0 (28), stage-1 (59, bundles the whole web POS with these changes), buffer rules (37), **stage-2 offline (40)** — including a new end-to-end test: offline → buffered + provisional answer + `created_at` stamped; online → passes straight through.
- Dashboard build clean. Full local CI run (known local-only noise aside).
- The native Java (`MainActivity`) compiles in the Android CI build (I can't run gradle here).

## MUST test on the tablet before trusting (your rule — I'm not calling these "done")
Flash the new APK (open the PR to build it), then:
1. **Offline selling:** turn Wi-Fi OFF mid-shift → ring a cash sale → it should complete, print, and show "Offline — sales are saved". Turn Wi-Fi ON → it should sync once (check the dashboard shows the sale exactly once, no double-charge).
2. **Receipt back:** complete a sale → on the receipt, press the hardware **back** → it should close like "New order".
3. **Tech door:** press-and-hold the business-name header on the PIN screen ~1s → "This device" opens.
4. **Logo / tables / status bar:** client logo on the header (premium), neutral table cards + green/amber dot, status bar clean on every screen.

## Known follow-ups (not built)
- **Cold-start offline** (tablet that never synced this session): needs cached `pos/init` + offline PIN sign-in. The common **mid-shift disconnect works**; a cold start at the PIN pad still needs a connection.
- The offline status strip sits at the very top and may overlap the POS header — a position tweak once you see it on the device.
- Device "reattach + recognise" on a clean reinstall (we agreed on this earlier) — still to build.

## Commit (run in Git Bash)

```bash
git -C /c/swiftpos/pos add apps/android/src/App.tsx apps/android/src/screens/shop/NoConnection.tsx apps/android/src/screens/shop/PinScreen.tsx apps/android/src/screens/shop/ShopPos.tsx apps/android/src/shop/offlineWrites.ts apps/android/src/shop/useLongPress.ts apps/dashboard/src/hooks/useBackDismiss.ts apps/dashboard/src/pages/pos/CashierScreen.tsx apps/dashboard/src/pages/pos/MinimartPOS.tsx apps/dashboard/src/pages/pos/PaymentModal.tsx packages/ui/src/CategoryPanel.tsx tests/android-till-stage2.test.mjs && git -C /c/swiftpos/pos commit -m "Android premium Batch 2: offline selling, reprint back button, hide category pin + This device, client logo on header" -m "Offline selling (android-only fetch seam, online is an unchanged pass-through): fix the provisional response to the camelCase { orderId, orderNumber } the web POS reads and stamp created_at into the buffered body so a replayed sale is priced as of when it was rung up; ShopPos installs the seam, drains the queue on reconnect (runReplay), sweeps retention hourly and mounts the sync status bar; the No-connection cover no longer blocks the selling screen." -m "Reprint receipt back: a cancelable zaptill:back event from App.tsx + a LIFO useBackDismiss hook; wired PaymentModal (the stuck receipt screen) and the CashierScreen covers/parking/pump/fuel overlays. Back closes the topmost overlay, else leaves the tech page, else nothing (never signs a cashier out)." -m "Hide the category pin on the Android Shop POS (pinnable threaded through the shared CategoryPanel + useCategoryPanel). Hide This device behind an 800 ms long-press on the PIN header and the offline cover (mirrors the desktop; no server token, so it still opens offline). Show the client logo on the POS header for premium/themed businesses, else the default mark." -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

After committing, **push and open the PR** on `android-ui-polish` to build the APK, then flash and run the checklist above.
