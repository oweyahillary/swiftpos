# ZapTill for Android — changelog

The version shows on the PIN screen (`ZapTill v<x.y.z>`) and in the APK filename (`ZapTill-<x.y.z>-debug.apk`). It is set
in one place — `apps/android/package.json` `version` — and bumped per build the owner tests, so one install is never
mistaken for the next. Newest first.

## 0.3.0 — PIN-first offline sign-in + device-id visibility
**Sign-in:**
- Offline sign-in is now **PIN-first**, the same as online and the same as the desktop POS: the person keys their PIN and
  the cached bcrypt verifier resolves it to the one person — **no name list**. This matches the online experience, drops a
  tap, and stops the offline screen from showing who works here. A wrong PIN is refused on the spot; a PIN shared by two
  people is refused the way the cloud refuses it (ask a manager to reset).

**Device / reinstall:**
- The **This device** page (long-press the PIN-screen header) now shows this POS's **device id**, and flags it in red if
  it ever drifts from the seat the POS joined as — so a technician can confirm on a live till that a reinstall keeps the
  same seat, without resetting. (The reinstall "new seat" cause — a random id before the fixed debug key — is resolved;
  the id is now a stable `Settings.Secure.ANDROID_ID`.)

## 0.2.0 — Till stage 2 (keeps selling offline) + fixes
**Offline (Till stage 2):**
- Keeps selling with no connection — sales are buffered and replay when the connection returns.
- Cold start offline: the POS opens and shows its catalogue from a cold boot with no internet (cached pos/init, tables,
  pumps, printers, order mode).
- Offline sign-in: pick your name from the cached roster and enter your PIN; the PIN is checked **locally with bcrypt**
  (a wrong PIN is refused at the till), and verified again with the cloud on reconnect — no second PIN entry.
- Offline **table-move** and **fire-course**: a restaurant keeps moving tables and firing courses during an outage.

**Fixes (owner device test, 2026-11-11):**
- Removed the old "No connection — can't sell" cover that wrongly blocked the (now working) offline sign-in and
  contradicted the "Offline — sales are saved" banner.
- After settling a bill, **New order** now lands on the **tables** grid (the phone cart sheet closes), instead of an empty
  "Select a table" cart sheet.
- Roster now also caches right after an online sign-in, so the next offline sign-in reliably finds the staff list.
- **Server:** the branch-staff roster route was gated to the desktop surface only, so the Android Shop POS (surface
  `android-till`) was silently 403'd and its offline roster stayed empty ("No staff are saved on this POS yet"). The gate
  now accepts any POS device (desktop or android-till), as the stage-2 design intends. No app change — the dev API carries
  the fix; sign in online once after it deploys and the roster caches for offline use.

**Housekeeping:**
- Versioning: the build shows on the PIN screen; this changelog tracks what changed.
- Reinstall keeps the same seat (fixed, committed debug key); offline cold-start device test pending.

## 0.1.0 — initial Android builds
Till stage 0/1: native shell, status-bar insets, join (enrol code / branch server), PIN sign-in (online), the embedded
web POS, printing to a network printer, in-app update, device page, UI-polish batches 1–4c, device-id hardening.
