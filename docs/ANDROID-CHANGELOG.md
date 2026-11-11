# ZapTill for Android — changelog

The version shows on the PIN screen (`ZapTill v<x.y.z>`) and in the APK filename (`ZapTill-<x.y.z>-debug.apk`). It is set
in one place — `apps/android/package.json` `version` — and bumped per build the owner tests, so one install is never
mistaken for the next. Newest first.

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

**Housekeeping:**
- Versioning: the build shows on the PIN screen; this changelog tracks what changed.
- Reinstall keeps the same seat (fixed, committed debug key); offline cold-start device test pending.

## 0.1.0 — initial Android builds
Till stage 0/1: native shell, status-bar insets, join (enrol code / branch server), PIN sign-in (online), the embedded
web POS, printing to a network printer, in-app update, device page, UI-polish batches 1–4c, device-id hardening.
