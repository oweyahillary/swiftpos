# Android premium — Batch 3 (overnight, 2026-11-09)

**Written for: Stephen (owner).** Built overnight on branch `android-ui-polish`, on top of Batch 2. **Nothing committed, pushed, deployed, or flashed** — the paste-ready commit command is at the bottom; the app changes still need you to flash the APK and check them on the tablet.

---

## Desktop v1.1.0 — DONE ✅ (separate from this batch)
The release finished while you were testing: both "Release desktop" builds succeeded and the **GitHub Release `v1.1.0` is published** (`ZapTill-1.1.0.exe`, `ZapTill-1.1.0.exe.blockmap`, `latest.yml`). The production web POS + server are live on 1.1.0 and the deploy verified. **Next for desktop:** approve **v1.1.0 for one canary till** in the admin portal, confirm it opens/sells/prints, then release to the fleet. (Your local `main` is stale — a `git fetch && git checkout main && git reset --hard origin/main` cleans it; the remote is correct.)

---

## The six issues you listed (root cause → fix)

1. **Start-up screens not centred (esp. the PIN pad).** Cause: `viewport-fit=cover` makes CSS `env(safe-area-inset-*)` non-zero, but `MainActivity` already insets the web view inside the bars → the top inset was counted twice, pushing centred content low. Fix: centred screens now use `100dvh` + **symmetric** vertical padding (`styles.css`), and the "What is this device?" screen is centred (`ChooseMode.tsx`). **Needs your eyes on the device.**

2. **No client logo on the keypad → now branding, properly.** See the Branding section — the logo (and colours) now load **at registration**, not only after a sign-in.

3. **The "back shadow" = the payment modal's own `bg-black/70` backdrop**, exposed because the amount field (`autoFocus` text input) summoned the OS keyboard, which shrank the view and pushed the card up. Fix (your call — "quick fix"): `autoFocus` is **off on the Android POS** (`PaymentModal.tsx`), so the keyboard no longer ambushes and there's no dark gap; tapping the field still lets a cashier type a free amount. **Needs device check.**

4. **Fonts too small on table / menu / cart.** Desktop pixel sizes were showing on a phone. Fix: a phone-scoped `big()` helper bumps the read-at-a-glance sizes (table name/subtitle/labels, product name/price, cart item name/price/total) **only on a phone** — desktop/tablet unchanged (`CashierScreen.tsx`). **Needs device check — tell me if you want them bigger still.**

5. **Top menu overflowed (your "Float" was cut).** Fix (your call — "slim icon bar + More"): on a phone the header buttons are **icon-only** (Customer / Z-Report / Clock / Float / Expense / End Shift), the `☰` menu stays as the "More" drawer, and the desktop-only "Customer screen" window button stays hidden (`CashierScreen.tsx`). **Needs device check for fit.**

---

## Branding — logo + colours (your requirement: load right after a device is registered)

Built as a first-class thing, not a patch:
- **At enrolment** (`tillSession.cacheBranding`): the moment a device is joined, the app fetches `pos/init` with the **till's own token** and caches the client's **logo + brand colours** — so a freshly-registered tablet is branded **before anyone signs in**. Best-effort; the per-sign-in cache backs it up.
- **The native shell wears the client's colours** (`brandTheme.applyShopBrand`): the PIN / start / setup screens now take the client's accent instead of the fixed ZapTill teal, applied on first paint (`main.tsx`) and whenever the PIN pad shows (`PinScreen.tsx`).
- **The client logo** shows on the PIN pad (`PinScreen.tsx`) in place of the "Z" mark.
- **The POS screens** were already themed by the client's colours (`usePOSData → posColours`) — confirmed; no change needed there.

**Needs device check:** that the shell shows the client's logo and colour right after joining, and on the PIN pad.

---

## Step 6 — device remembered on a clean reinstall (A182-style)

Cause: the device id was a random UUID in Capacitor Preferences — **wiped on reinstall**, so a reinstalled POS enrolled as a brand-new device. Fix:
- A tiny native method `CrashReports.hardwareId()` returns `Settings.Secure.ANDROID_ID` (stable across reinstall; scoped to the app's signing key — not a serial number).
- `tillSession.deviceId()` now uses it for **new installs** (existing enrolled devices keep their current id — never changed).
- **The server already reattaches**: enrol/redeem looks up `user_devices` by `(business_id, device_id)` and updates the existing row (`routes/auth.ts`), so a reinstall presenting the same id lands on the **same** POS record — no duplicate. The one-time enrolment code stays the credential, as we agreed.

**Needs device check — this is the one to test hardest:** flash → enrol → note the POS in the admin portal → uninstall → reinstall → enrol again with a code → confirm it's the **same** device/seat, not a new one.

---

## Verified (automated, against the working tree)
- Android app `tsc --noEmit`: **0 errors**. Dashboard type-check ratchet: **0 errors**.
- Android suites: stage-0 (28), stage-1 (59), stage-2 (40) — all pass.
- Android app integration build (bundles the web POS): **clean**.
- Full local CI (`ci.yml`): **304 steps, 7 failed — all known environmental noise, none from this batch.** The failures: `python3 schema-audit` (python3 not aliased locally), the `${{ matrix.part }}` shard placeholder (cisteps doesn't expand it), three libuv `UV_HANDLE_CLOSING` teardown crashes on **desktop** tests I didn't touch (server-join, A503, A554 — the test passes, the process crashes on exit), the etims-offline teardown, and money-reports (local TZ; green on GitHub CI). No new failure from the Android/dashboard changes — the Android suites, the ratchet and the build are all clean.

## Must test on the tablet (your rule — I'm not calling these "done")
Flash the new APK, then: centring on the start/PIN screens · client **logo + colours** on the PIN pad and after joining · bigger table/menu/cart text · the slim icon header fits (no cut-off) · payment: **no dark shadow**, tapping the amount still types · **reinstall → same device** (step 6).

---

## Commit (run in Git Bash — the features are this batch's code only; `docs/reports/` stays local)

```bash
git -C /c/swiftpos/pos add apps/android/android/app/src/main/java/com/zaptill/app/CrashReportsPlugin.java apps/android/src/main.tsx apps/android/src/native/plugins.ts apps/android/src/screens/ChooseMode.tsx apps/android/src/screens/shop/PinScreen.tsx apps/android/src/shop/tillSession.ts apps/android/src/shop/brandTheme.ts apps/android/src/styles.css apps/dashboard/src/pages/pos/CashierScreen.tsx apps/dashboard/src/pages/pos/PaymentModal.tsx && git -C /c/swiftpos/pos commit -m "Android premium Batch 3: centre start-up screens, client logo + brand colours on the shell, bigger phone fonts, slim icon header, no OS-keyboard shadow, stable device id (reinstall-safe)" -m "Branding as a requirement (owner 2026-11-09): tillSession.cacheBranding fetches pos/init with the till token at enrolment and caches the client logo + brand colours, so the shell is branded before the first sign-in; CashierScreen also caches them each sign-in; brandTheme.applyShopBrand paints the PIN/start/setup screens in the client's accent (main.tsx, PinScreen); the PIN pad shows the client logo. The POS screens were already themed (usePOSData posColours)." -m "Centre the start-up screens: 100dvh + symmetric padding on the centred screens (the native insets already handle the bars, so env(safe-area) must not bias centring), and the 'What is this device?' screen centred." -m "Phone POS: bump table/menu/cart text a notch (isPhone-scoped big() helper); header buttons icon-only on a phone with the menu drawer as More (desktop/web unchanged). Payment amount: autoFocus off on the Android POS so the OS keyboard does not ambush and expose the modal backdrop (the shadow)." -m "Device remembered on a clean reinstall (A182): CrashReports.hardwareId() returns Settings.Secure.ANDROID_ID; tillSession.deviceId uses it for new installs (existing ids unchanged); the server already reattaches by (business_id, device_id)." -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

After committing, push `android-ui-polish` and let PR #103's CI build the APK, then flash and run the checklist above.

## Known follow-ups (not built)
- First-launch branding depends on `pos/init` accepting the till token; if it doesn't on your cloud, branding falls back to the per-sign-in cache (still branded after one sign-in). Verify on device.
- `android-ui-polish` is behind `dev` (it predates the v1.1.0 bump); merge `dev` into it before the final PR to stay current (no conflicts expected — different files).
