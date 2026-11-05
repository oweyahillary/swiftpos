# Installing ZapTill on an Android phone or tablet

For owners and managers installing ZapTill on their own phone, and for technicians setting up a shop tablet as a Shop POS.

ZapTill for Android is not in the Play Store. You install it from a file (an APK) that ZapTill gives you. This guide shows
how, and what to tap when Android asks questions on the way.

> **This first version** sets up the device and checks with ZapTill for updates. Signing in, reports and selling come
> in the next version, which you install the same way as this one (a new link from ZapTill). Once a device is signed in,
> it updates itself whenever ZapTill approves a new version for your business.

## Before you start

| You need | How to check |
|---|---|
| Android 10 or newer | **Settings › About phone › Android version** (on some phones **Settings › About phone › Software information**) |
| About 30 MB of free space | **Settings › Storage** |
| The download link from ZapTill | ZapTill support sends it to you, or your technician installs the app for you |
| An internet connection | Wi-Fi or mobile data |

## Step 1 — Download the app

1. Open the link from ZapTill on the phone or tablet, in **Chrome**.
2. The link works for **a few minutes only**. If it says the link has expired (or "AccessDenied"), ask ZapTill for a new one.
3. Chrome may warn: **"This type of file can harm your device."** Tap **Download anyway**. ZapTill files come only from
   ZapTill; never install a ZapTill file someone else sends you.

## Step 2 — Allow installs from Chrome (first time only)

1. When the download finishes, tap **Open** (or open **Files › Downloads** and tap **ZapTill-x.y.z.apk**).
2. Android says: **"For your security, your phone is not allowed to install unknown apps from this source."**
3. Tap **Settings**, switch on **Allow from this source**, then tap the back arrow.

The words differ a little by phone make. On Samsung, Tecno, Infinix and most others the setting is called
**Install unknown apps**.

## Step 3 — Install

1. Tap **Install**.
2. **Google Play Protect** may say it has not seen this app before ("Unsafe app blocked" or "Send app for scanning?").
   This is because ZapTill is installed from a file, not from the Play Store. Tap **More details › Install anyway**
   (or **Don't send**, then **Install**).
3. When it says **App installed**, tap **Open**.

## Step 4 — What is this device?

The first time ZapTill opens it asks **"What is this device?"**

| Choose | When |
|---|---|
| **Shop POS** | A tablet at the counter that sells. Staff use their PINs. |
| **Owner / manager phone** | Your own phone or tablet, for reports and quick tasks. You sign in as yourself. |

Tap your choice, read the note, then tap **Use as …**. The choice stays until **Reset app** (below), which clears everything
ZapTill keeps on the device.

## For technicians — check the file before installing it

Every update the app installs by itself is checked against its SHA-256 first, and Android refuses an update that is not
signed by ZapTill. For the **first** install you can check the file yourself:

1. In the admin portal, open the client, tab **Updates**, card **ZapTill for Android**, and tap **Get download link**. The
   card shows the file's **SHA-256**.
2. Download the file on a PC and run, in PowerShell: `Get-FileHash .\ZapTill-x.y.z.apk -Algorithm SHA256`
3. The two values must be the same. Then copy the file to the tablet (USB cable, or a shared folder) and install it from
   **Files** as in Steps 2 and 3.

## Updates

- ZapTill approves each new version for your business before it reaches your devices. Nothing updates by itself without
  that approval.
- A device that is not signed in yet (this first version) gets no updates by itself: it says **Updates start once this
  device is joined to your business**. Install a newer version from a new ZapTill link, as in Steps 1 to 3; your choice of
  device type is kept.
- When an update is approved, the app shows **Update to x.y.z**. Tap it; Android asks **"Do you want to update this app?"**
  — tap **Update**.
- A **Shop POS** updates only when no shift is open, never during service.
- The first time, Android may ask you to allow **Install unknown apps** for **ZapTill** itself: the app opens that setting
  for you. Switch on **Allow from this source**, come back and tap **Update** again.

## Reset app

**Reset app** (at the bottom of the app's screen) clears the device type and everything ZapTill keeps on the device, and
asks **"What is this device?"** again. Use it to turn an owner's phone into a Shop POS or the other way round, or before
giving the device to someone else.

## If something goes wrong

| What you see | What to do |
|---|---|
| "App not installed" or "conflicts with an existing package" | An older ZapTill signed differently (a test version) is on the device. Uninstall it (**Settings › Apps › ZapTill › Uninstall**), then install again. |
| "There was a problem parsing the package" | The phone runs an Android older than 10, or the download was cut short. Check the Android version; download again. |
| The link says it has expired, or "AccessDenied" | Ask ZapTill for a new link; each one works for a few minutes. |
| Play Protect blocked the install | Tap **More details › Install anyway** (Step 3). |
| "Could not reach ZapTill. Check the internet connection." | Connect to Wi-Fi or mobile data and tap **Check for updates** again. |
| "The downloaded update does not match its SHA-256 — it was not installed." | The download was damaged or changed on the way; nothing was installed. Try again on another network. If it repeats, call ZapTill. |
| The app closed by itself | Open it again. ZapTill is told about the crash automatically when the app next opens. |
