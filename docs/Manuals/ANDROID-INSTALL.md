# Installing ZapTill on an Android phone or tablet

For owners and managers installing ZapTill on their own phone, and for technicians setting up a shop tablet as a Shop POS.

ZapTill for Android is not in the Play Store. You install it from a file (an APK) that ZapTill gives you. This guide shows
how, and what to tap when Android asks questions on the way.

> **This version** sets up the device, joins a **Shop POS** tablet to your business and sells with your staff PINs
> while the tablet is online. The owner's phone screens (reports, quick tasks) come in a later version, which you
> install the same way. Once a device is joined, it updates itself whenever ZapTill approves a new version for your
> business.

## Before you start

| You need | How to check |
|---|---|
| Android 10 or newer | **Settings › About phone › Android version** (on some phones **Settings › About phone › Software information**) |
| About 60 MB of free space | **Settings › Storage** |
| The download link from ZapTill | ZapTill support sends it to you, or your technician installs the app for you |
| An internet connection | Wi-Fi or mobile data |

For a **Shop POS** you also need:

| You need | Why |
|---|---|
| The ZapTill online licence for the business | A Shop POS sells through the ZapTill cloud |
| A POS licence on the branch | The tablet takes a POS seat, like a desktop POS |
| The shop Wi-Fi, with internet | A Shop POS sells only while online (see **No connection** below) |
| A ZapTill technician | Joining a tablet to a business is done by a technician |
| Network receipt and kitchen printers (or a branch server) | The tablet prints over the shop network |

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

## Step 5 — Join the Shop POS to the business (technician)

A ZapTill technician joins each Shop POS tablet, once. First type a name for it under **Name this POS** (for example
"Front counter"). Then join it one of two ways.

> **ZapTill recommends a dedicated branch server** — a computer at the branch running the ZapTill desktop app in
> branch-server mode. It keeps a backup of the branch's work and makes printing easier: printers are set up once, on the
> server, and every tablet prints through it. A tablet also works without one.

**A. Through the branch server** (when the shop has one, on the same Wi-Fi)

1. The tablet searches the shop network and shows **Join the … server at …?** Tap it.
2. The tablet shows a **Security code**. Check the branch server's screen shows the same code.
3. Tap **Ask to join**. At the branch server, the request appears — press **Allow**.
4. The tablet joins by itself and shows the PIN pad. (The request waits 10 minutes; if nobody presses Allow, search
   again.)

**B. Enter the enrolment code from ZapTill** (no branch server)

1. In the admin portal, open the client, the **Branches** tab, the branch, and press **Enrol POS**. It shows the
   **business ID** and a one-time **enrolment code**.
2. On the tablet, under **Enter the enrolment code from ZapTill**, type the business ID and the code, and tap **Join**.
3. The tablet shows the PIN pad with the business and branch.

## Selling on a Shop POS

- Each person signs in with their **PIN** on the PIN pad — cashiers, managers and owners alike. The tablet then shows the
  same POS screens as the ZapTill web POS: the menu, sizes and add-ons, notes, discounts, held orders, delivery and
  rider, payments and split payments.
- **🔒 Lock** returns to the PIN pad for the next person.
- **Shifts** are this tablet's own drawer: open the shift with the opening float; whoever signs in next sells into the
  running shift; close it with the counted amounts (a blind close when the business uses one).
- **No connection — can't sell**: a Shop POS sells only while it is online. Without internet the screen says so and
  waits; nothing on the screen is lost, and selling continues when the connection is back.

## Printing on a Shop POS

- **With a branch server** (joined as in A): kitchen tickets and receipts print on the branch server's printers, set up
  once on the server. If the server does not answer, the tablet prints straight to the printers below and says so.
- **Without a branch server**: the tablet prints over the shop network to network printers.
  - Kitchen, bar and dispatch printers: in the web dashboard, **Settings › Printers**, set each printer's name to its
    address on the shop network, for example **192.168.1.50** (or **192.168.1.50:9100**).
  - The receipt printer: on the tablet, PIN pad › **This device › Receipt printer** — type the address and tap **Save
    and print a test ticket**.
- If a printer is off, the tablet says which one did not answer. **The sale is always saved** — reprint it from History
  when the printer is back.

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
- A device that is not joined yet gets no updates by itself: it says **Updates start once this device is joined to your
  business**. Install a newer version from a new ZapTill link, as in Steps 1 to 3; your choice of device type is kept.
- When an update is approved, the app shows **Update to x.y.z** (on a Shop POS: PIN pad › **This device**). Tap it;
  Android asks **"Do you want to update this app?"** — tap **Update**.
- A **Shop POS** updates only when its shift is closed, never during service.
- The first time, Android may ask you to allow **Install unknown apps** for **ZapTill** itself: the app opens that setting
  for you. Switch on **Allow from this source**, come back and tap **Update** again.

## Reset app

**Reset app** (on a Shop POS: PIN pad › **This device**) clears the device type and everything ZapTill keeps on the
device — on a Shop POS, its sign-in too, so a technician must join it again — and asks **"What is this device?"** again.
Use it to turn an owner's phone into a Shop POS or the other way round, or before giving the device to someone else.

## If something goes wrong

| What you see | What to do |
|---|---|
| "App not installed" or "conflicts with an existing package" | An older ZapTill signed differently (a test version) is on the device. Uninstall it (**Settings › Apps › ZapTill › Uninstall**), then install again. |
| "There was a problem parsing the package" | The phone runs an Android older than 10, or the download was cut short. Check the Android version; download again. |
| The link says it has expired, or "AccessDenied" | Ask ZapTill for a new link; each one works for a few minutes. |
| Play Protect blocked the install | Tap **More details › Install anyway** (Step 3). |
| "Could not reach ZapTill. Check the internet connection." | Connect to Wi-Fi or mobile data and try again. |
| "That code is wrong, expired or already used." | Issue a new enrolment code in the admin portal (Step 5 B). |
| "That branch server must be updated before a tablet joins through it." | Update the desktop app on the branch server, or join with the enrolment code instead. |
| No branch server is found | Check the server is on and the tablet is on the same Wi-Fi, then **Search again** — or join with the enrolment code. |
| "A Shop POS tablet sells through the ZapTill cloud, which needs the ZapTill online licence." | Contact ZapTill to enable the online licence for the business. |
| "No connection — can't sell" | Check the shop Wi-Fi and the internet. Selling continues when the connection is back. |
| "The printer at … is not answering." | Check the printer is on, has paper and is on the shop network. The sale is saved; reprint it from History. |
| "The printer "…" has no network address." | In the web dashboard, **Settings › Printers**, set that printer's name to its address (for example 192.168.1.50). |
| "The branch server is not answering — tickets go straight to the printers set up on this POS." | Check the branch server is on. Meanwhile the tablet prints directly. |
| "The branch server's identity changed" | The server was reinstalled or replaced. A technician joins the tablet to it again (**This device › Join again**). |
| "This POS is no longer joined to the business." | The POS was retired, or its sign-in was refused. A technician joins it again with a new enrolment code. |
| "The downloaded update does not match its SHA-256 — it was not installed." | The download was damaged or changed on the way; nothing was installed. Try again on another network. If it repeats, call ZapTill. |
| The app closed by itself | Open it again. ZapTill is told about the crash automatically when the app next opens. |
