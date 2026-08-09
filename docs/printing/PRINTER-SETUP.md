# Printer setup

For whoever installs a till. Assumes no prior knowledge of thermal printers.

---

## 1. What to buy

Any **ESC/POS thermal receipt printer**. This is the near-universal standard —
Epson TM-T series, Xprinter, Rongta, Gprinter, Bixolon and most unbranded units
all speak it. The box or listing usually says "ESC/POS compatible".

| | Recommendation |
|---|---|
| Paper width | **80mm.** 58mm works and is supported, but everything is cramped and harder to read under a heat lamp. |
| Connection | **Ethernet (LAN)**, in that order of preference, then USB, then Windows shared. |
| Auto-cutter | Yes. Tearing by hand at a busy counter wastes more than the cutter costs. |
| Cash drawer port | Only on the till printer. Marked `DK` or `RJ11`. |

**Avoid** printers sold as "driver-only" or "Windows GDI" with no ESC/POS mode.
They can only be driven by rendering a picture of the receipt, which is exactly
the slow path this system was built to get away from.

### Why Ethernet

A network printer takes bytes on TCP port 9100 and prints them. Nothing is
installed on the till, any till can reach any printer, and moving a printer
means changing one number. USB ties a printer to one machine; Windows sharing
drags the job through the Windows spooler and adds seconds.

---

## 2. Plug it in

### Ethernet

1. Connect the printer to the same switch or router as the tills.
2. Hold **FEED** while switching the printer on. It prints a self-test slip.
3. Read the **IP address** off that slip, e.g. `192.168.1.50`.
4. If it says `0.0.0.0` or `169.254.x.x`, the printer did not get an address.
   Check the cable, then the router's DHCP.

**Give it a fixed address.** A printer that gets a new IP after a power cut
stops printing and nobody knows why. Either set a static IP in the printer's
web page (browse to its IP), or reserve its MAC address in the router. Do this
during installation, not after the first outage.

### USB

Plug it in. On Windows it appears under **Settings → Bluetooth & devices →
Printers**. Note the exact name shown, spelling and spaces included.

### Windows shared

Only if a printer is physically on one machine and another till must use it.
Share it, then note `\\COMPUTERNAME\PrinterName`. Slower than Ethernet — treat
it as a stopgap.

---

## 3. Test the printer before touching the POS

Do this first. It proves the printer works, on its own, with no software in the
way. If this step fails, nothing in the POS will help.

`shared/printing/out/` contains ready-made receipts as raw bytes:

```
kitchen-80.bin      dispatch-80.bin      receipt-80.bin
kitchen-58.bin      receipt-58.bin
```

Send one straight at the printer.

**Network printer** — any machine on the same network:

```bash
nc 192.168.1.50 9100 < receipt-80.bin
```

Windows PowerShell, if `nc` is not available:

```powershell
$c = New-Object System.Net.Sockets.TcpClient('192.168.1.50', 9100)
$s = $c.GetStream()
$b = [System.IO.File]::ReadAllBytes('receipt-80.bin')
$s.Write($b, 0, $b.Length); $s.Flush(); $c.Close()
```

**Windows USB or shared printer:**

```
copy /b receipt-80.bin \\localhost\YourPrinterName
```

**Linux USB:**

```bash
cat receipt-80.bin > /dev/usb/lp0
```

### Reading the result

Compare the paper against `shared/printing/SAMPLE-OUTPUT.txt`.

| What you see | What it means |
|---|---|
| Matches the sample | Printer and paper width are correct. Move on. |
| Nothing prints | Wrong address or port, or the printer is not on the network. Ping the IP. |
| Prints but does not cut | Printer has no auto-cutter, or ignores `GS V 66`. Tell me the model. |
| Right-hand side wraps onto the next line | You sent an 80mm file to a 58mm printer. Try `receipt-58.bin`. |
| Garbled characters or odd symbols | Wrong code page. Tell me the model — this is a one-line fix. |
| Prints the escape codes as visible text | The printer is in a non-ESC/POS mode, or is a GDI-only unit. |

A `.bin` that prints correctly means the renderer and the byte layer are both
right, and only the connection remains.

---

## 4. Stations and printers

A **station** is a job — Kitchen, Dispatch, Till, Bar. It belongs to the
business and is the same at every branch.

A **printer** is a physical machine, and belongs to one terminal. Three tills
in one branch have three different printers attached, so the printer is never
part of the station.

Setting up a branch:

1. Create the stations once, for the business. Most restaurants need three:
   Kitchen, Dispatch, Till. Add Bar, Grill or Cold prep if separate people work
   them.
2. Route each **menu category** to the stations that should see it. Chicken
   goes to Kitchen and Dispatch. Soft Drinks goes to Dispatch only. Sauces go
   to Dispatch only.
3. On each terminal, assign a printer to each station it prints for.

A till that has no printer assigned for a station simply does not print that
station's ticket — it does not fail the sale. A category routed to no station
at all prints nowhere, which is why the setup screen flags unassigned
categories.

### Which categories go where

Rule of thumb: **Kitchen sees what is cooked. Dispatch sees everything that
goes in the bag. The till prints what the customer pays.**

If a cook would ignore it, do not route it to the kitchen. A fryer reading soda
orders stops reading carefully.

---

## 5. Paper

58mm and 80mm rolls both fit many printers, but the printer must be told which
it has, and so must the station. A mismatch is the commonest cause of a receipt
that wraps.

Thermal paper has a printable side. If a roll comes out blank, it is loaded
upside down — flip it. Store rolls out of sunlight and away from heat; a roll
left on a windowsill turns grey and unreadable.

---

## 6. When something goes wrong

**Nothing prints, no error.** Check the station has a printer assigned on that
terminal. Then send a `.bin` file to confirm the printer itself is alive.

**Kitchen ticket missing items.** The item's category is not routed to the
kitchen station. Categories, not products, carry routing.

**Prints twice.** Two stations are assigned the same physical printer. That is
allowed and sometimes wanted — a small shop may run kitchen and dispatch on one
machine — but check it is deliberate.

**Printer offline mid-service.** Jobs queue and print when it comes back, the
same as an office printer. The till does not block and the sale is never held
up. Nothing needs re-ringing.

**A duplicate is needed.** Reprint from the order. It prints with `Duplicate
Print` at the top and the reprint time, so it can never be passed off as an
original.

---

## Known limits

- **No fiscal or eTIMS block.** The receipt carries no KRA QR code or control
  unit number, because that has not been specified yet. It is absent rather
  than faked.
- **Text headers only.** No logo bitmaps yet.
- **Untested on hardware.** As of this document, the byte stream has been
  validated against the ESC/POS command set and every ticket renders correctly,
  but no physical printer has printed one. The `.bin` files in section 3 exist
  precisely so that first test needs nothing but a printer and a cable. Please
  run it and send me a photo of the paper.
