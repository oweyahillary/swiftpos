# Barcodes and labels

ZapTill gives your products barcodes and prints labels for them on almost any printer, at almost any label size. This manual covers:

- giving products a barcode;
- setting the label's size and what is printed on it;
- printing on a label printer, on A4 sticker sheets, or on the receipt printer;
- setting up the printer driver for Xprinter, TSC and Zebra label printers.

> A label shows the item's price on the day you print it. When you change a price, reprint that item's labels.

## 1. Barcodes

### Products that already have a barcode

A product's own barcode (the EAN-13 or UPC-A printed by the manufacturer, or any code you scan or type) stays as it is. To add one, open the product on the web (**Menu › Products**, then **Edit**), click in **Barcode** and scan the item, or type the code. The tills can scan it as soon as they next refresh the menu.

### Products without a barcode: Generate

Things you pack or make yourself (bread, cut vegetables, own-brand items) have no manufacturer's barcode. ZapTill can give them one:

1. On the web, open **Menu › Products**.
2. To do only some products, tick them first. If you tick nothing, every active product without a barcode gets one.
3. Click **Generate barcodes**. ZapTill shows how many products will get a barcode and what the first codes will be.
4. Click **Generate**.

To do one product at a time, open the product and click **Generate** beside **Barcode**.

**About the codes.** They are 13-digit EAN-13 codes that start with **20**, for example `2000000000015`. GS1, the body that issues barcodes, keeps codes starting with 20 to 29 for a shop's own use: no manufacturer's product carries one, so your codes never clash with a real product's. ZapTill uses only **20**. Codes starting with 21 to 29 are left free for weighing scales that print the price or weight inside the barcode.

- A product that already has a barcode is never changed.
- Two products in your business never get the same code.
- These codes work in your own shops only. To sell your products in other shops (a supermarket chain, for example), you need GS1 Kenya codes; type those into **Barcode** instead.

## 2. The label

On the web the label is set on **Menu › Print labels**. On the till it is set on **Manager › Stock › Labels**. Both screens use the same settings. When someone allowed to edit the menu clicks **Save**, every till and the web use the new settings.

| Setting | What it does |
|---|---|
| Size | 30×20, 38×25, 40×30, 50×25, 50×30, 58×40 or 60×40 mm, or type any width × height. Measure one label on the roll, without the gap. |
| Item name | The product's name, on up to two lines. |
| Price | Today's price at this branch (on the till) or the main price (on the web). |
| Barcode / Digits | The bars and the digits under them. |
| Business name | Your business's name at the top. On a small label it is the first thing left off. |
| After the price | Optional text, for example "per kg". |
| Printer dpi | 203 dpi (most label printers) or 300 dpi. Check the printer's box or its test page. |
| Gap | The gap between labels on the roll (usually 2 or 3 mm). Only TSPL printing uses it. |

The text sizes itself to fit the label. A preview shows the first label. When something had to give way (a long name cut to one line, very thin bars), a warning under the preview says so. If the bars are very thin, use a wider label and test-scan one label.

## 3. Choosing what to print

- Search by name or barcode, or pick a category, then type how many labels you want of each item.
- **Add all shown** adds one label for each item in the list.
- **Add every generated code** adds every product that has a ZapTill code (starting with 20).
- On the web, **Delivery since**: pick the day a delivery came in and click **Add the items restocked**. Each product restocked since that day is added, with one label for each unit received.
- On the web, tick products on **Menu › Products** and click **Print labels**. The ticked products are already chosen.

## 4. Printing on a label printer (with its driver)

This works with any label printer that has a Windows driver installed (Xprinter, TSC, Zebra, Godex and others) and with office printers too.

**Web:** on **Print labels**, click **Print … labels** under *On a label printer*. In the print window:

1. Choose the label printer.
2. Set **Margins** to **None** and **Scale** to **100%** (or "Actual size").
3. Print.

To make a PDF, choose **Save as PDF** instead of a printer.

**Till:** on **Manager › Stock › Labels**, under **3. Printer**, choose **Windows printer (driver installed)** and pick the printer. Then click **Print**. The till prints without opening a window.

**The driver must use the same paper size as the label.** This is the setting that matters most: if the driver's paper is 100 × 150 mm and the label is 40 × 30 mm, the labels come out shrunk or spread over several labels. See section 7.

## 5. Printing on A4 sticker sheets

**Web only.** On **Print labels**, under *On A4 / Letter sticker sheets*:

1. Pick the sheet: **3 × 7** (21 labels, 63.5 × 38.1 mm), **3 × 8** (24 labels, 63.5 × 33.9 mm), **4 × 10** (40 labels, 45.7 × 25.4 mm), **5 × 13** (65 labels, 38.1 × 21.2 mm), or **Custom**. For a custom sheet, give the columns, rows, top and side margins and the gaps; ZapTill works out the label size.
2. **Start at label**: on a sheet that is partly used, type the number of the first free label. Labels are counted left to right, top row first, so on a 3 × 7 sheet label 4 is the first one on the second row.
3. Click **Print on sheets**. In the print window choose **A4** paper, **Margins: None** and **Scale: 100%**.

> Print one test sheet on plain paper first and hold it against a sticker sheet up to the light. If everything is shifted, change the margins (Custom) and try again.

## 6. Label printers with no driver, and the receipt printer

**Till only.** Under **3. Printer** on **Manager › Stock › Labels**:

- **Label printer, no driver: TSC / Xprinter (TSPL)**: most TSC and Xprinter label printers (XP-365B, XP-420B, TSC TE200 and others).
- **Label printer, no driver: Zebra (ZPL)**: Zebra printers (ZD220, ZD420, GK420 and others).

Type the printer's **IP address** (for example `192.168.1.50`; the port is 9100) for a network printer. For a USB printer, choose it from **USB: pick the Windows printer…**. ZapTill sends the label straight to the printer in its own language, so the driver's paper settings do not matter. The label size, gap and dpi come from the label settings in section 2.

**Receipt printer**: prints a barcode slip on the till's receipt roll, for a shelf tag or when the label printer is down. ZapTill uses this till's receipt printer (**Settings › Printing**, Till station) unless you type another address. If the barcode does not print, choose **Send the barcode as an image**.

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
| "No barcode" next to an item | Give it one: **Menu › Products › Generate barcodes**. |
| The till says the label printer did not answer | Check the IP address (print the printer's self-test page to see it), that the printer is on the same network, and that it is switched on. |
| The price on the shelf is wrong | Labels show the price on the day they were printed. Reprint them after a price change. |
