# Barcodes and labels

ZapTill gives your products barcodes and prints labels for them on almost any printer, at almost any label size. This manual covers:

- giving products a barcode;
- setting the label's size and what is printed on it;
- printing on a label printer, on A4 sticker sheets, or on the receipt printer;
- setting up the printer driver for Xprinter, TSC and Zebra label printers.

> A label shows the item's price on the day you print it. When you change a price, reprint that item's labels.

> **Every label has a barcode.** You cannot print a label without one. If an item you choose has no barcode yet, ZapTill gives it one when you print (section 3).

## 1. Barcodes

### Products that already have a barcode

A product's own barcode (the EAN-13 or UPC-A printed by the manufacturer, or any code you scan or type) stays as it is. To add one, open the product on the web (**Menu › Products**, then **Edit**), click in **Barcode** and scan the item, or type the code. The points of sale can scan it as soon as they next refresh the menu.

### Products without a barcode: Generate

Things you pack or make yourself (bread, cut vegetables, own-brand items) have no manufacturer's barcode. ZapTill can give them one:

1. On the web, open **Menu › Products**.
2. To do only some products, tick them first. If you tick nothing, every active product without a barcode gets one.
3. Click **Generate barcodes**. ZapTill shows how many products will get a barcode and what the first codes will be.
4. Click **Generate**.

To do one product at a time, open the product and click **Generate** beside **Barcode**.

**About the codes.** Unless you change the numbering (below), they are 13-digit EAN-13 codes that start with **20**, for example `2000000000015`. GS1, the body that issues barcodes, keeps codes starting with 20 to 29 for a shop's own use: no manufacturer's product carries one, so your codes never clash with a real product's. Codes starting with 21 to 29 are often used by weighing scales that print the price or weight inside the barcode, so **20** is the safe choice.

- A product that already has a barcode is never changed.
- Two products in your business never get the same code.
- These codes work in your own shops only. To sell your products in other shops (a supermarket chain, for example), you need GS1 Kenya codes; type those into **Barcode** instead.

### Barcode numbering: format, prefix, start number, digits

You choose how new barcodes are made. On the web it is the **Barcode numbering** section of **Menu › Print labels**; on the POS it is the same section on **Manager › Stock › Labels**. Changing it needs the right to edit the menu, and the POS needs the internet to save it. Everyone else sees it but cannot change it.

| Setting | What it does |
|---|---|
| Format | **EAN-13** (13 digits, read by every scanner; the default), **EAN-8** (8 digits, for small items), **UPC-A** (12 digits), or **Code 128, digits only** (any length from 4 to 20 digits). |
| Prefix | The digits every new code starts with, for example `20`. |
| Start at | The first item number to use, for example `1000`. The next code always comes after the highest one already used with the same prefix and length, so you never get a duplicate. |
| Digits | Fixed for EAN-13 (13), EAN-8 (8) and UPC-A (12). For Code 128 you choose the length, and you can add a check digit. |

**What the digits are made of.** A code is the prefix, then the item number (filled with zeros), then a **check digit** worked out from the other digits. The scanner uses the check digit to catch a misread. For example, EAN-13 with prefix 20: `20` + `0000000001` + `5` = `2000000000015`. The screen spells this out ("13 digits: prefix 20 (2) + item number (10) + check digit (1)").

**The preview** under the settings shows the next three codes and how many codes are left in the range.

- **Prefix warnings.** For EAN-13 and EAN-8, use a prefix that starts with **20**. For UPC-A, start it with **4**. Any other prefix could match a manufacturer's barcode, so ZapTill warns you. It still lets you save, in case you have your own reason.
- **Weighing scales.** EAN-13 codes starting with **21 to 29**, and UPC-A codes starting with **2**, are the ones weighing scales print with the weight or price inside. If your prefix would make codes like these, ZapTill warns you: a scale label could be read as one of your items, or one of your codes as a weighed item. Keep **20** for EAN-13.
- **When the range is used up**, for example a short Code 128 length with a long prefix, ZapTill generates no codes and says so. It does not give some items a code and skip the rest. Choose a shorter prefix or more digits.
- **Changing the numbering never changes existing barcodes.** Only codes made from then on follow it.

## 2. The label

Labels work the same for every kind of business: a shop's shelf labels, a restaurant's or café's grab-and-go and packaged items (bottled drinks, take-away packs), a petrol station's shop items (lubricants, gas, snacks; pump fuel is sold at the pump and is not listed), and anything a car park sells besides parking.

On the web the label is set on **Menu › Print labels**. On the POS it is set on **Manager › Stock › Labels**. Both screens use the same settings. When someone allowed to edit the menu clicks **Save**, every POS and the web use the new settings.

| Setting | What it does |
|---|---|
| Size | 30×20, 38×25, 40×30, 50×25, 50×30, 58×40 or 60×40 mm, or type any width × height. Measure one label on the roll, without the gap. |
| Item name | The product's name, on up to two lines. |
| Price | Today's price at this branch (on the POS) or the main price (on the web). |
| Barcode | Always printed. There is no setting to turn it off. |
| Digits under the bars | The barcode's digits printed under the bars. On by default; turn it off for a cleaner label. |
| Business name | Your business's name at the top. On a small label it is the first thing left off. |
| After the price | Optional text, for example "per kg". |
| Printer dpi | 203 dpi (most label printers) or 300 dpi. Check the printer's box or its test page. |
| Gap | The gap between labels on the roll (usually 2 or 3 mm). Only TSPL printing uses it. |

The text sizes itself to fit the label. A preview shows the first label. When something had to give way (a long name cut to one line, very thin bars), a warning under the preview says so. If the bars are very thin, use a wider label and test-scan one label.

## 3. Choosing what to print

- Search by name or barcode, or pick a category, then type how many labels you want of each item.
- **Add all shown** adds one label for each item in the list.
- **Add every generated code** adds every product that has a code ZapTill generated (by your barcode numbering, or starting with 20).
- On the web, **Delivery since**: pick the day a delivery came in and click **Add the items restocked**. Each product restocked since that day is added, with one label for each unit received.
- On the web, tick products on **Menu › Products** and click **Print labels**. The ticked products are already chosen.

### Items without a barcode

A label is never printed without a barcode. If some of the items you chose have none, the screen says so. When you click **Print**:

- **If you may edit the menu**, ZapTill asks: "3 items have no barcode yet — generate them and print?" Click **OK**. ZapTill gives those items, and only those items, a barcode using your numbering. Then it prints every label. Click **Cancel** to print nothing. The new barcodes are saved to the products, and the points of sale can scan them after their next menu refresh.
- **If you may not edit the menu**, those items are left out. The other items print, and the screen lists the items left out: "ask a manager to generate barcodes for: Bread, Eggs".
- **On the POS without internet**, barcodes cannot be made, because the codes come from the cloud. Those items are left out and named, and the others print. Print them again when the POS is back online.
- **A barcode that cannot be printed.** A code with letters outside A to Z, such as "Café", cannot be drawn. That item is left out and named. Change its barcode on **Menu › Products**. Any other code you typed prints, as Code 128 if it is not a valid EAN or UPC.

## 4. Printing on a label printer (with its driver)

This works with any label printer that has a Windows driver installed (Xprinter, TSC, Zebra, Godex and others) and with office printers too.

**Web:** on **Print labels**, click **Print … labels** under *On a label printer*. In the print window:

1. Choose the label printer.
2. Set **Margins** to **None** and **Scale** to **100%** (or "Actual size").
3. Print.

To make a PDF, choose **Save as PDF** instead of a printer.

**POS:** on **Manager › Stock › Labels**, under **3. Printer**, choose **Windows printer (driver installed)** and pick the printer. Then click **Print**. The POS prints without opening a window.

**The driver must use the same paper size as the label.** This is the setting that matters most: if the driver's paper is 100 × 150 mm and the label is 40 × 30 mm, the labels come out shrunk or spread over several labels. See section 7.

## 5. Printing on A4 sticker sheets

**Web only.** On **Print labels**, under *On A4 / Letter sticker sheets*:

1. Pick the sheet: **3 × 7** (21 labels, 63.5 × 38.1 mm), **3 × 8** (24 labels, 63.5 × 33.9 mm), **4 × 10** (40 labels, 45.7 × 25.4 mm), **5 × 13** (65 labels, 38.1 × 21.2 mm), or **Custom**. For a custom sheet, give the columns, rows, top and side margins and the gaps; ZapTill works out the label size.
2. **Start at label**: on a sheet that is partly used, type the number of the first free label. Labels are counted left to right, top row first, so on a 3 × 7 sheet label 4 is the first one on the second row.
3. Click **Print on sheets**. In the print window choose **A4** paper, **Margins: None** and **Scale: 100%**.

> Print one test sheet on plain paper first and hold it against a sticker sheet up to the light. If everything is shifted, change the margins (Custom) and try again.

## 6. Label printers with no driver, and the receipt printer

**POS only.** Under **3. Printer** on **Manager › Stock › Labels**:

- **Label printer, no driver: TSC / Xprinter (TSPL)**: most TSC and Xprinter label printers (XP-365B, XP-420B, TSC TE200 and others).
- **Label printer, no driver: Zebra (ZPL)**: Zebra printers (ZD220, ZD420, GK420 and others).

Type the printer's **IP address** (for example `192.168.1.50`; the port is 9100) for a network printer. For a USB printer, choose it from **USB: pick the Windows printer…**. ZapTill sends the label straight to the printer in its own language, so the driver's paper settings do not matter. The label size, gap and dpi come from the label settings in section 2.

**Receipt printer**: prints a barcode slip on the POS's receipt roll, for a shelf tag or when the label printer is down. ZapTill uses this POS's receipt printer (**Settings › Printing**, POS station) unless you type another address. If the barcode does not print, choose **Send the barcode as an image**.

## 7. Driver set-up tips

The rule for every brand: **the driver's paper size must be the label's size** (width × height, without the gap). Set it once and the label prints at the same size every time.

### Xprinter (XP-365B, XP-420B, XP-470B and others)

1. Install the driver from the CD or Xprinter's website. On Windows 10 and 11 use the "Windows" driver, not the "POS" one.
2. Open **Control Panel › Devices and Printers**, right-click the printer, then **Printing preferences**.
3. On **Page Setup** (or **Paper**), click **New**, name the size (for example "40x30"), type **Width 40 mm** and **Height 30 mm**, and save. Choose it.
4. On **Options** (or **Media**), set the media to **Labels with gaps**, gap **2 mm** (or whatever your roll has).
5. Do a calibration: with the printer on, hold the FEED button until it beeps once and release it. It feeds a few labels and finds the gap.

### TSC (TE200, TE210, TTP-244 and others)

1. Install TSC's "Seagull" Windows driver.
2. **Printing preferences › Page Setup › Stock**: **New**, type the label's width and height, and choose it.
3. **Stock › Type**: **Labels With Gaps**, and the gap height (for example 2 mm).
4. Calibrate from the **TSC Console** utility (Calibrate) or by holding FEED at power-on as the manual says.

### Zebra (ZD220, ZD420, GK420 and others)

1. Install the **ZDesigner** driver from Zebra's website.
2. **Printing preferences › Options**: set **Paper Format** to mm, then **Width** and **Height** to the label's size.
3. **Advanced Setup › Media**: **Label with gaps** (non-continuous, web sensing).
4. Calibrate: with the printer on, hold FEED until the light flashes twice, then release it. On a ZD420, use the media calibration in the menu.

### Office printers (A4)

Only sticker sheets (section 5). Choose **A4**, **Margins: None** and **100%** in the print window. Turn off **Fit to page**.

## 8. When something is wrong

| What you see | What to do |
|---|---|
| A blank label between printed ones, or one label printed over two | The driver's paper size or the gap does not match the roll. Set the size (section 7) and calibrate. |
| The label is printed too small, in a corner | The driver's paper is bigger than the label. Set it to the label's size. Scale must be 100%. |
| The scanner does not read the code | Print larger (a wider label), turn on **Digits** and check them, raise the print darkness in the driver, and keep a white margin each side of the bars. |
| "No barcode yet" next to an item | Nothing to do if you may edit the menu: it gets a barcode when you print. Otherwise ask a manager, or use **Menu › Products › Generate barcodes**. |
| "Not printed: ask a manager to generate barcodes for: …" | You may not create barcodes. Someone who may edit the menu prints those items, or generates their barcodes first. |
| "The barcode numbering range is used up" | Change **Barcode numbering**: a shorter prefix or more digits. |
| The POS says the label printer did not answer | Check the IP address (print the printer's self-test page to see it), that the printer is on the same network, and that it is switched on. |
| The price on the shelf is wrong | Labels show the price on the day they were printed. Reprint them after a price change. |

## 9. Items sold by weight (scale labels)

Meat, fruit and vegetables, loose sweets and nyama choma can be sold **by the kilo**: the weight is the quantity (0.452 kg) and the amount is the price per kg × the weight. The full guide is **Items sold by weight** (`WEIGHED-ITEMS`); in short:

1. On the web, edit the item: price **per kg**, switch on **Sold by weight**, and give it its **Scale code (PLU)** — the number it has on your weighing scale.
2. At any POS, tapping the item asks for the weight (a keypad in kg).
3. With a **label scale**, scan the sticker the scale prints: the item is added with its weight and amount. Choose your scale (CAS, DIGI, Ishida or standard) and test one label in **Settings › Business › Scale labels**.

> Scale labels start with **21–29**. The codes ZapTill generates for your products start with **20** and are never read as scale labels, so the two never clash.
