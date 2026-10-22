# ZapTill Technician Setup Guide

*Version 1.0 · 22 October 2026 · for ZapTill field technicians*

This guide takes a ZapTill technician from an empty account to a client selling on a working till, then to the technician access used for support afterwards. Follow the steps in order; each one depends on the one before.

## Before you go

Collect these from the client before the visit. Most setup delays come from a missing item on this list.

| What | Why you need it | Example |
| --- | --- | --- |
| Business name and type | Creates the account and picks the right features (restaurant, retail, petrol station) | Mama Lishe Grill, restaurant |
| Owner's full name, email and phone | The owner's sign-in to the web dashboard; the email must be one they can open on the day | Jane Wanjiru, jane@example.com |
| Branches | One per physical shop; each gets its own tills, printers and stock | Ngong Road, Westlands |
| M-Pesa Buy Goods or Paybill number (and account) | Printed large on every receipt | Buy Goods 777111 |
| The menu in Excel | Loaded in one upload instead of typing every item | The ZapTill menu template |
| Logo (PNG) and receipt footer text | Branding on the till and the receipt | Address, phone, socials |
| Staff list with roles | Each person gets a PIN and a role | 2 cashiers, 1 supervisor, 1 manager |

Bring or confirm on site:

- [ ] A Windows 10 or 11 PC (64-bit) for each till; one of them becomes the branch server when there is more than one till
- [ ] An 80 mm or 58 mm thermal receipt printer (USB or network), and a kitchen printer if the kitchen will print
- [ ] A cash drawer connected to the receipt printer, if used
- [ ] Internet for the setup day (the tills keep selling offline afterwards)
- [ ] A small UPS for the till PC: the till needs power to keep selling during a power cut
- [ ] Your ZapTill admin portal sign-in, and the ZapTill installer

The three places you will work in:

| Site | Address | Who uses it |
| --- | --- | --- |
| Admin portal | admin.zaptill.co.ke | ZapTill staff only: creates clients, switches features |
| Web dashboard | app.zaptill.co.ke (or the client's own address) | The owner, managers, partners |
| Till | The ZapTill app on the Windows PC | Cashiers, waiters, managers |

## Step 1 — Create the client in the admin portal

One form creates the business, its first branch, the owner's sign-in and every built-in role. Licences and features come in Step 2.

1. Sign in at **admin.zaptill.co.ke** with your email and password, then enter the 6-digit sign-in code (emailed, or from your authenticator app). Tick **Remember this browser for 30 days** on your own laptop only.
2. In the sidebar, under **Clients**, click **New client**.
3. **Business Type**: click the right tile — Restaurant, Café, Retail, Minimart, Parking, Petrol Station or Other. The default is **Minimart**, so always click the tile.
4. **Business Details**: **Business Name** (required), **Phone**, **Currency** (default KES) and **VAT Rate (%)** (default 16).
5. **Main Branch**: **Branch Name** (required) and **Address**.
6. **Owner Login Account**: **Owner Name**, **Email** (required) and **Temporary Password** (at least 8 characters). The password field shows what you type, so type it with the owner beside you.
7. Click **Create Restaurant** (the button names the type). Wait for **Client created!**

![The New Client form filled in for a demo restaurant](screenshots/01c-admin-new-client-form.png)

The success panel shows the Business ID, branch, owner login and temporary password. Write the temporary password down for the owner, then click **View client →**.

![Client created, with the Business ID and temporary password](screenshots/01d-admin-client-created.png)

**What was created:** the business, the main branch (not yet licensed for tills), the owner's sign-in, the owner's staff record on the owner's role, and these built-in roles: Manager, Cashier, Supervisor, Waiter, Kitchen, Storekeeper, Accountant, General Manager, Operations Manager, Finance Manager, Auditor, Kitchen Manager (plus Fuel attendant for a petrol station). No email is sent to the owner.

**Optional — the client's own sign-in address.** On the client's **Overview** tab, under **Support and sign-in › Sign-in address**, click **Set** and enter a short name such as `mamalishe` (3–32 lowercase letters, digits or hyphens). The owner and staff then sign in at their own address. In the same card, **Support tech** names who appears on the shop's Help page.

![The Overview tab with the sign-in address](screenshots/01f-admin-overview-sign-in-address.png)

**If it fails**

| Message | Meaning |
| --- | --- |
| Auth creation failed | That email is already a ZapTill sign-in. Use another email or ask the owner which one they use. |
| Temporary password must be at least 8 characters. | Make it longer. |
| Plan shows **None** after creating | No trial plan exists on that system. Set the plan on **Plan & billing** if the client is not paying yet. |

**Changing the owner's email later:** only from **Owner & account › Change email**, and only on purpose. This also moves the owner's staff record. Never ask the owner to sign up again with a new email: that creates a second "Owner" record.

## Step 2 — Turn on the licences and features

A new client can do nothing yet: the owner cannot sign in to the web dashboard and no till can join. Two licences fix that; the Features tab sets the rest. These buttons need a **super admin**; others see "Super admin only".

**2a. Web access (the dashboard and the online features).** On the client, open **Plan & billing › Web portal access** and click **Enable web access**. Confirm only when payment is agreed: it raises an invoice "Web Portal Hosting — Annual Access". Set **Web access expiry** to the paid-up date so renewal reminders work.

![Plan & billing with web access enabled](screenshots/02b-admin-plan-billing-web-access.png)

Without web access the owner sees "Web portal access not enabled" when signing in. Web access also unlocks the online-licence features on the till (offers, wastage, transfers, pictures and variants). After the expiry date there are 21 days of full access, then 7 days of reports only, then the owner is refused. Tills keep selling throughout.

**2b. Desktop licence, per branch.** Open **Branches & tills**. Each branch shows "✗ Not licensed — desktop POS blocked" until you click **Activate licence**. Enter the one-off fee (or leave it blank to invoice later) and the M-Pesa or bank reference if paid. A desktop licence has no expiry. Repeat for every branch.

![A branch before its desktop licence](screenshots/02f-admin-branch-not-licensed.png)

**2c. Features.** Open the **Features** tab. Changes take effect at once; tills pick them up at their next sync.

| Switch | Turn on when |
| --- | --- |
| App themes | The client wants their colours on the till and per-branch branding |
| Analytics | The client has paid for Analytics (premium) |
| Compact receipt layout | The client wants shorter receipts (some find it crowded) |
| Classic line spacing (4.23 mm) | A printer runs receipt lines together |
| Full-size receipt logo | The client wants a big logo (up to 36 mm) |
| Extra paper before the cut | The printer's cutter clips the last line |
| Kitchen tickets in the small font | Long kitchen orders need less paper (harder to read at a distance) |
| Separate approval PIN for managers | Managers prefer a different PIN for approvals than for signing in |

The **POS switches** on this tab (delivery fee, cashiers see only their own sales, pay before kitchen and others) are read-only here. The owner sets them in the dashboard under **Settings › Business › POS options**.

![The Features tab](screenshots/02e-admin-features.png)

## Step 3 — The owner's first sign-in and business settings

The owner signs in on the web dashboard with the temporary password, chooses a private one, and you fill in the business details together.

1. Open **app.zaptill.co.ke** (or the client's own address) and sign in with the owner's email and temporary password.
2. Have the owner change the password straight away: **Settings › Users and access › My sign-in › Password**. Don't rely on the automatic prompt; it does not always appear.
3. The owner lands on **Overview**. There is no setup wizard; the rest is done in **Settings › Business**.

![The dashboard sign-in page](screenshots/03a-dashboard-sign-in.png)

**Settings › Business › Profile**

- **Business details**: name, address, phone, contact email, Tax PIN (KRA), VAT rate, Catering/Tourism Levy, currency. Click **Save business details**. The currency locks once sales are recorded.
- **Receipt text**: **Header (top of receipt)** and **Footer (bottom of receipt)**, saved as you leave each field. Typical footer: address, phone, socials, a thank-you line.
- **Business day ends at**: the day cut-off. Sales before this time count to the night before. A bar open until 3 am sets 04:00; most restaurants keep midnight or 02:00.

![Business profile with receipt text and the day cut-off](screenshots/03d-dashboard-business-profile.png)

**Branches**: the owner can rename and edit branches, set the main one and deactivate one, but **cannot add a branch**. Add branches yourself in the admin portal (**Branches & tills › + Add branch**) and license each one (Step 2b). Each branch's detail page can override the receipt text, hours and payment methods for that branch.

![Branches in the dashboard](screenshots/03f-dashboard-branches.png)

**Branding**: pick the accent colour, upload the logo (PNG or JPEG, shrunk to 250 KB or less, no SVG), and tick **Print logo on customer receipts** if wanted. Tills pick it up within about 20 seconds. With App themes on (Step 2c), the page also offers an app theme and **Per branch** colours and receipt footers (at most 6 lines, 48 characters a line on 80 mm).

**POS options**: delivery fee and rider, eat now pay later, pay before kitchen, loyalty points, and **Sign-in codes (OTP)**. With sign-in codes on, the owner gets a 6-digit code by email at every sign-in (10 minutes, 5 tries). Partners and accountants always get a code.

**If sign-in fails**

| Message | Meaning |
| --- | --- |
| Web portal access not enabled | Step 2a was not done |
| Invalid email or password | Wrong password; check caps and the temporary password |
| Too many failed sign-ins for this account | Locked for 15 minutes |
| This sign-in address belongs to another business | Wrong client address; use the main address |
| Could not email your sign-in code | Email delivery failed; try again in a minute |

## Step 4 — Load the menu

Load the whole menu from one Excel workbook, then add variants, extras and costs. For a restaurant or café the dashboard calls products **Menu Items** and categories **Menu Sections**.

1. Go to **Menu › Menu Items** and click **Menu upload**.
2. Click **↓ Template** and fill the workbook. Its sheets are **Products**, **Upgrades & Spices**, **Recipe** and **Ingredients**, plus a **Read me**.
3. Click **Choose an .xlsx workbook**. A preview appears.
4. Click **Apply {n} rows** and read the result: added, updated, skipped, and any new menus.

![The Menu upload panel](screenshots/04a-dashboard-menu-upload-open.png)

![The preview before applying](screenshots/04b-dashboard-menu-upload-preview.png)

**Products sheet: the columns that matter on day one**

| Column | What to put |
| --- | --- |
| name | The item's name (required; matching key) |
| category | e.g. Grill, Drinks |
| price | Selling price, required for a new item |
| cost_price | What one serving costs you (needed for margins in Analytics) |
| is_kitchen | yes for food the kitchen cooks |
| track_stock | yes for bottled or packed stock you count |
| menu | Puts the item's category in a menu tab (Food, Soft drinks, Alcohol) |
| plu_code | A stable code, so items can be renamed later |

The sheet's rules: a row matching an existing item updates it and never duplicates it; a blank cell leaves the value as it is; DELETE clears it. At most 500 rows per upload.

**Variants and extras.** Put them in **Upgrades & Spices** (`product, group, type, option, price_added`), or open an item's **Variants** link. A **variant group** (e.g. Spice level: Normal / Spicy) lets the customer pick one option and can change the price. A **modifier group** (e.g. Extras: Extra Cheese +50) is an add-on the customer can pick several of. Variants print on the item's own line ("Chicken Burger - Spicy"); extras print under the dish on the kitchen ticket.

**Costs: don't skip this.** Click **Set costs** and enter what one serving costs, or give each item a **Recipe** of ingredients. Without costs, Analytics cannot show margins and lists the items under "Set these costs to see your real margins".

![Set cost prices](screenshots/04f-dashboard-set-costs.png)

**Also on this page:** **Menus** (group categories into tabs on the till: one menu per category), **Combo Meals** (combo name, price, items), **Bulk images** (matched by barcode, then PLU, then exact name), and **Track stock** per item.

**Upload problems**

| Message | Fix |
| --- | --- |
| menu "Tea" clashes with row 13 ("Soft drinks") — one menu per category | A category can be in one menu only; split the category |
| price is required for a new product | Add the price |
| invalid sold_by / track_stock / tax_type | Use each/weight/volume/piece, yes/no, or A–E |
| upgrade "X" needs one option at 0 | Give the upgrade group a free baseline option |
| Ingredients carry per-branch opening stock — pick a specific branch | Choose the branch in the top bar first |
| Maximum 500 rows per import | Split the file |

## Step 5 — Staff, roles and PINs

Every person gets a role and a 4–6 digit PIN; the role decides what they can do on the till and the dashboard.

1. Go to **Settings › Users and access › Staff members** and click **+ Add Staff**.
2. Keep **PIN Login** selected. Enter **Full name** and pick the **Role**.
3. Enter **Email** (used for sign-in) and a **PIN (4–6 digits)**. Give every person a different PIN.
4. Under **Branch access**, tick the branches they work at. With none ticked they get every branch.
5. Optional: **Hourly rate**, and single permissions under **This person's permissions** (pre-filled from the role).
6. Click **Add Staff**.

![Add Staff Member, filled in for a cashier](screenshots/05a-dashboard-add-staff.png)

**Which role to give**

| Person | Role |
| --- | --- |
| Sells at the counter | Cashier (or Waiter for table service) |
| Approves voids, refunds and sales on account at the till | Supervisor |
| Runs a branch | Manager |
| Runs the whole business, not the owner | General Manager |
| Menu, stock and kitchen | Operations Manager or Kitchen Manager |
| Books and reports only | Accountant (reads) or Finance Manager (acts) |
| Receives and counts stock | Storekeeper |

Nobody can be given the owner's role, not even by the owner. A cashier has no Void button: a supervisor or manager does voids. A supervisor or manager lands on the Manager screen after their PIN and presses **Open POS** to sell.

**Web dashboard access for a partner or accountant.** Add the person with **PIN Login** first. Then, on their row, click **Give web access** and confirm. They receive an email titled "You can now sign in to {Business} on ZapTill", set their own password, and enter a one-time code at every sign-in. Use **Revoke web access** to remove it.

![The Give web access confirmation](screenshots/05e-dashboard-give-web-access-confirm.png)

**Custom roles:** **Roles and permissions › + New role**, start from an existing role, then tick permissions. Changes apply at the person's next sign-in or till refresh.

## Step 6 — Payments, M-Pesa and credit accounts

The dashboard sets which payment methods the business takes; the M-Pesa number is set on each branch's till.

**Payment methods.** **Settings › Business › Payments**. On by default: Cash, M-Pesa, Card, Glovo and On account. Tick others the business takes (Airtel Money, bank transfer, delivery apps…) and save. A branch can choose its own on its detail page.

![Payments: the methods the business takes](screenshots/06a-dashboard-payment-methods.png)

**M-Pesa number (on the till, by a manager).** On the till, open **Manager › Settings › General › M-Pesa for this branch**. Choose **Buy Goods** and enter the **Till number**, or **Paybill** with the **Business number** and the account number. Click **Save**. It prints large and centred on every receipt ("BUY GOODS:" then the number), and the owner is told whenever it changes. Numbers are 5 to 8 digits.

![M-Pesa for this branch on the till](screenshots/06e-till-mpesa-buy-goods.png)

**Cash drawer.** No setting: cable the drawer to the receipt printer. It opens when the **Receipt** station prints (Step 9).

**Credit accounts (sales on account).** **Customers › Credit Accounts** lists customers who buy on account, with Limit, Owed and Available, and **Manage →** for limits, repayments, adjustments and statements. A manager confirms or disputes every credit sale under **Credit sales to confirm**; this never blocks the day close. On the till, **On account** appears only when the branch takes it, at least one customer has a credit account, and the cashier may view customers.

> **Known gap:** a brand-new customer cannot be given a first credit limit from the dashboard yet (**+ New Customer** has no limit field, and Credit Accounts lists only customers who already have one). Ask ZapTill support to set the first limit until this is fixed.

## Step 7 — Install ZapTill on the till PC and join it

A till joins with the **Business ID** plus a **single-use enrolment code** that expires 15 minutes after you create it, so create codes on site.

**7a. Install.** Run the approved ZapTill installer (`ZapTill-<version>.exe`) on the till PC as an administrator. It is not code-signed: if Windows SmartScreen appears, click **More info › Run anyway**. The installer:

- adds firewall rules for the branch server (TCP 4100–4103) and server discovery (UDP 4199);
- registers **ZapTill start at sign-in** (starts 45 seconds after Windows sign-in) and **ZapTill Updater** (installs approved updates without a Windows prompt);
- creates desktop and Start-menu shortcuts.

Updates are approved per client in the admin portal (**Desktop updates › Choose a version… › Approve**). Until then tills stay on the version they run.

**7b. Create the enrolment code.** In the admin portal, on the client's **Branches & tills** tab, click **Enrol till** next to the licensed branch and enter how many tills (1–20). Copy the **Business ID** and one **Code** per till. Codes are 10 characters, single-use and tied to that branch.

![Enrolment codes with the Business ID](screenshots/07b-admin-enrolment-codes.png)

**7c. First run on the till.** Open ZapTill. The **Device setup** has three steps:

1. **Find the server.** ZapTill looks for a branch server on the network. For the **first or only till**, or for the PC that will **be** the branch server, click **Set up without a server**. For an extra till, choose the server (Step 8) — and check the business and server name first: the search lists every ZapTill server on the network, including other businesses'.
2. **Server address.** Leave the ZapTill cloud address (`https://api.zaptill.co.ke`), click **Test connection** until it says "Connected — ZapTill server responded", then **Continue**.
3. **Activate this device.** Enter the **Business ID** and the **Enrolment code**, then click **Activate**. This step needs internet.

![Activate this device](screenshots/07e-till-setup-activate.png)

**7d. Branch and role.** After "Activated for {business}":

- **Branch** is fixed by the enrolment code.
- **Device role**: **Till** (sells), **Branch server** (sells, and other tills sync to it) or **Office** (a branch server that cannot sell: reports and day close only).
- **Terminal code**: T1, T2, T3… Every till at a branch needs a different code; it prefixes every bill number (T1--1042).
- **Device name**: e.g. Counter, Bar, Front till 1.

Click **Complete setup**. The screen locks; changing it later needs a technician (Step 11). The till opens on the PIN screen.

![Branch, device role and terminal code](screenshots/07f-till-setup-branch-role.png)

**There is no approval step for a till:** redeeming the code approves it. The dashboard's **Devices** approval is only for cashiers signing in to the web POS from a new browser. The new till appears under **Settings › Devices and printers › Terminals** after its first sign-in.

**If it fails**

| Message | Fix |
| --- | --- |
| The server did not accept that enrolment / Invalid, expired or already-used code | Create a new code (15-minute expiry, single use) |
| Could not issue an enrolment code — Assign a desktop licence to this branch | Step 2b |
| That looks like a branch server address. Port 4100… | Put the cloud address here, not the branch server's |
| Something answered but it is not the ZapTill server (HTTP 404) | Remove any path after the address |
| This till is already joined to its business | Rejoin from the Tech page (Step 11) |
| This branch has no desktop licence (PIN screen) | Step 2b |

## Step 8 — Branch server and extra tills

A branch with more than one till needs one **branch server**. Every other till joins through it and keeps selling, and in step, even when the internet is down.

**8a. Set up the server first.** On the PC that will be the server, follow Step 7 with its own enrolment code, and at **Device role** choose **Branch server** (or **Office** for a back-office PC that does not sell). Write down the **Branch access code** it shows, for support; tills never type it.

![Setup with the Branch server role chosen](screenshots/08a-till-setup-branch-server-role.png)

Make the server always available, as the setup screen asks:

- [ ] Windows signs in by itself (run `netplwiz`, untick "Users must enter a user name and password")
- [ ] **Settings › System › Power**: sleep when plugged in = **Never**
- [ ] Leave ZapTill open; closing its window keeps it running in the tray, and it restarts itself within 5 minutes if it stops
- [ ] Both PCs' Windows network is set to **Private**, on a wired or separate network, not the customer Wi-Fi

**8b. Join each extra till.** No enrolment code is needed on an extra till.

1. On the new till, at setup step 1 (or **Tech › Find my server**), choose the branch server. Check the business and server name.
2. The till shows **Now go to the branch server and press Allow**, with a **Security code**.
3. On the server, **A till wants to join this branch server** appears over every screen, with the till's name and IP and the same security code. If the codes match, click **Allow**; otherwise click **Deny**. The server needs internet at that moment.
4. The till carries on by itself: give it a unique terminal code (T2, T3…) and its device name.

The request waits 10 minutes.

![The new till waiting for Allow](screenshots/08b-till-join-wait-press-allow.png)

![The server's Allow prompt](screenshots/08c-server-join-prompt-allow.png)

**Check it worked.** On a till's **Tech** page, **Shop network** reads "Encrypted" and **Branch sync** shows Reachable for each item. On the server, **Distribution to the cloud** says "Nothing waits — every record on this server is on the cloud".

**Ports.** The server listens on TCP **4100** (falling back to 4101–4103) and answers discovery on UDP **4199**; the installer opens both on the Private profile only. Only one copy of ZapTill runs at a time: opening it again just brings the running window forward.

| Message | Fix |
| --- | --- |
| No branch server answered on this network | Server PC on, ZapTill running, both networks Private, same network |
| The server needs the internet to add a till | Restore the server's internet, then press Allow again |
| The request ran out — ask again | Ask again from the till and Allow within 10 minutes |
| This till is already joined to this branch server | Revoke it on the server (Close Branch › Show tills › Revoke this till), then join again |
| …still reachable. Promoting now would put TWO servers on this branch | Demote or disconnect the old server first |

## Step 9 — Printers and stations

Printing is set in two places: the dashboard decides **what** prints at each station, and each till decides **which printer** a station uses. **Printing is OFF on a new till** — nothing prints until you switch it on (9b).

**9a. Stations, on the dashboard.** **Settings › Devices and printers › Print stations**. Add a station per job and pick its type:

| Type | Prints | Example |
| --- | --- | --- |
| Kitchen | Only what is cooked, no prices | Grill, Kitchen, Bar |
| Dispatch | Everything that goes in the bag, drinks included, no prices | Packing |
| Receipt | The customer receipt, and opens the cash drawer | Till |

Then click the category chips on each kitchen or dispatch station. A receipt station prints the whole bill. Until any station exists, tills use the built-in Kitchen, Dispatch and Till stations.

![Print stations with their categories](screenshots/09a-dashboard-print-stations.png)

**9b. Printers, on each till.** On the till: **Manager › Settings › Printing › Printers**.

1. Switch on **Print through these printers**. It reads "OFF — nothing will print. Turn this on before trading." until you do.
2. Pick a station on the left. Under **Printer**, choose a printer plugged into this PC from **Pick a printer on this machine…**, or type a **network printer's IP** (e.g. `192.168.1.50`; port 9100 is assumed).
3. Set **Paper width** to the roll actually loaded: **80mm** or **58mm**. A mismatch is the commonest cause of wrapped receipts.
4. Click **Test print**. A good print says "Printed {bytes} bytes in {ms}ms"; the preview shows exactly what the printer will produce.
5. Repeat for each station. A station with no printer on this till is normal when another till prints it.

![Printers switched off on a new till](screenshots/09c-till-printers-off.png)

![The receipt station on a USB printer](screenshots/09d-till-receipt-printer-usb.png)

**What prints where**

- **Kitchen ticket:** kitchen items only, bold normal-size dish names, variants on the dish's line ("Chicken Burger - Spicy"), extras and notes under the dish.
- **Dispatch ticket:** the whole order in the same format, for packing.
- **Receipt:** the customer copy, with "BUY GOODS:" or "PAYBILL:" and the number centred and bold. It opens the cash drawer.
- The **Receipt** tab on the till holds the header and footer text for the whole business.

**Kitchen display (optional).** The owner opens **Settings › Devices and printers › Kitchen display**, picks the branch, clicks **Generate token** and copies it. Open `/kds` on the kitchen screen and paste the token once. Generating a new token replaces the old one: the old screen then asks to be set up again.

| Message | Fix |
| --- | --- |
| timed out after 8000ms connecting to …:9100 / Looks like the printer is off or unreachable | Printer power, cable or IP address |
| Windows took too long to accept the job | Press Test print again; clear stuck jobs in Windows' print queue |
| the spooler does not recognise that printer name (1801) | Re-pick the printer from the list |
| the print spooler service is not running (1722) | Start the Print Spooler service in Windows |
| Send to kitchen is greyed out | Printing is switched off on this till (9b step 1) |
| The sale is saved, but this did not print | Fix the printer; a manager reprints from History |

![A network kitchen printer and a failed test print](screenshots/09e-till-kitchen-network-test-print.png)

## Step 10 — Test run with the client

Run one full trading day in ten minutes with the client watching: sell, print, pay, void and close. Fix anything that fails before you leave.

- [ ] **PIN sign-in.** A cashier enters their PIN and presses **Enter**.
- [ ] **Opening float.** **Open your drawer**: count the cash in the drawer, enter it (0 if empty), **Start selling**.
- [ ] **Sell with a variant and an extra.** A restaurant opens on **Tables**; press **Takeaway** for the menu. Tap an item with a variant, pick it (e.g. Spicy) and an extra (e.g. Extra Cheese), then **Add to order**.
- [ ] **Kitchen ticket.** Press **Send to kitchen**. Check the kitchen ticket shows "CHICKEN BURGER - SPICY" on one line and "+ Extra Cheese" under it, and that the dispatch ticket prints.
- [ ] **Split payment.** Press **Charge KES {total}** (there is no "Pay" button). Pay part in Cash, press **+ Split payment**, put the rest on M-Pesa with its reference, then **Charge**. Check the receipt: items, the BUY GOODS number, and the cash drawer opening.
- [ ] **Sale on account.** Choose **On account**, pick the customer, have a manager enter their PIN, then **Charge**. The receipt shows the balance owed.
- [ ] **Void.** A supervisor or manager signs in, presses **Open POS › History**, opens the sale, **Void / Refund**, picks a reason, enters the manager PIN and **Confirm Void**.
- [ ] **Close the shift.** The cashier presses **Shift open › Close shift**, enters the counted cash (with the float) and the M-Pesa total. This is a blind count: the cashier never sees the expected figure.
- [ ] **Close the day.** A manager opens **Manager › Close › Close Day**, confirms each shift (Expected vs Cashier vs Manager, by method), counts the cash and presses **Count verified — close the day**.
- [ ] **Close the branch** (only on a branch server): **Manager › Close › Close Branch**, tick that the totals are checked, **Close branch**.
- [ ] **Check the dashboard.** Overview shows the sales; **Tills & Days** shows the till and its last sync; **Orders** lists the test sales.
- [ ] **Daily email.** **Settings › Business › Integrations › Daily Report Email**: set the send time and recipients. It sends once a day at or after that time (default 21:00).

![The PIN screen](screenshots/10a-till-pin-sign-in.png)

![A variant and an extra being chosen](screenshots/10e-till-variant-and-extra.png)

![The cart with the variant, the extra and Charge](screenshots/10f-till-cart.png)

![A split cash and M-Pesa payment](screenshots/10h-till-split-cash-mpesa.png)

![Payment successful](screenshots/10i-till-payment-successful.png)

![A sale on account with the manager's PIN](screenshots/10j-till-sale-on-account.png)

![Void with the manager's PIN](screenshots/10m-till-void-with-manager-pin.png)

![The cashier's blind shift close](screenshots/10n-till-close-shift.png)

![A manager confirming the shift](screenshots/10q-till-confirm-shift-modal.png)

![Day closed](screenshots/10s-till-day-closed.png)

**Things that catch people out**

- **A manager's PIN is refused for a sale on account** on a till with no branch server: that manager must have signed in on this till at least once. Have each manager sign in once during setup.
- **The till locks itself** after Windows has been idle for a while ("Till locked"). Nothing is lost; enter the PIN to continue.
- **No Void button for cashiers.** That is by design: voids need a supervisor or manager.
- **Close Day refuses** until every shift above it is confirmed.

| Message | Meaning |
| --- | --- |
| That PIN was not recognised | Wrong PIN, or the person has no access at this branch |
| Too many wrong PINs on this till | Wait for the lockout to end |
| Payments must add up to KES {n} | The split legs don't add up to the total |
| {name} has no credit limit / Over {name}'s credit limit | Set or raise the limit (Credit Accounts) |
| This order is {n} minutes old, past the void window | Use Refund instead |
| Confirm every shift above before closing the day | Confirm each shift first |

## Step 11 — Technician access

The Tech page on each till is how a technician fixes things later: sync, rejoining, printers, updates, logs and backups. It opens with a branch reveal code plus a 48-hour token from the admin portal, with no internet needed on site.

**11a. Get a token (admin portal).** Sidebar › **Tech access › Generate Tech Access Token**. Pick the **Client** and **Branch**, click **Generate Token**. You see, once only:

- the **Reveal code** (entered first on the till), with **Copy** and **Rotate**;
- the **token** (`st2.…`), valid for that branch for 48 hours, with **Copy token**.

A second super admin confirms each token. Click **Rotate** to end a technician's access: the old reveal code stops at once, and tills fetch the new one at their next sync.

![Tech access: the reveal code and token](screenshots/11a-admin-tech-access-token.png)

**11b. Open the Tech page on the till.**

1. On the PIN screen, **press and hold the logo or business name** for about a second.
2. **Technician access**: type the reveal code into **ACCESS CODE**, click **Continue**.
3. **Technician token**: paste the token, click **Unlock**.

![Technician access on the till](screenshots/11b-till-technician-reveal-code.png)

**11c. What the Tech page does.** A session lasts about 4 hours (**End session** to finish), and every action is recorded against you.

| Section | Use it to |
| --- | --- |
| Device | See the device ID, name, role, branch, server and build |
| Sync | See waiting and failed records; **Force sync**, **Retry failed** |
| Rejoin this till | Rejoin with a Business ID and a new enrolment code; nothing is cleared |
| Diagnostics | **Scan printers**, **Test connection**, **View log**, **Send logs to support** |
| Branch role | **Promote to branch server**, **Find my server** |
| Updates | Check the version and that **Updater task: installed** |
| Backups & retention | **Back up now**; choose a USB drive or second disk for backups |
| Reset this device | **Check what this would delete** before any reset |

![The top of the Tech page](screenshots/11d-till-tech-page.png)

**11d. Logs, two ways.**

- **From the till:** **Tech › Send logs to support** sends the last 24 hours (secrets removed) and shows a reference, e.g. "Sent — reference DZG52F". The client can read it to you over the phone. Up to 5 an hour; if the till is offline, **Save log to file** instead.
- **From the admin portal, with nobody at the shop:** client › **Desktop updates › Pull logs**. Choose the till, the period (24 hours, 3 days, 7 days), optionally **Include sign-in history**, give a reason, **Request**. The row turns **Delivered** with **View** and **Download**. Find any log by its reference under **Support logs**.

![Send logs to support, with the reference](screenshots/11f-till-send-logs.png)

![Pull logs: a request delivered](screenshots/11h-admin-pull-logs-delivered.png)

**11e. Updates.** Client › **Desktop updates**: **Choose a version… › Approve** (super admin). **TILLS NOW** shows each till's state: Up to date, Downloading, Downloaded, or "can't install silently on this PC (no ZapTill Updater task)" — run the installer once as administrator on that PC to fix it.

**Remote help without a visit:** pull logs; close a day or a drawer remotely from **Tills & days** (with a reason; the owner is emailed); reset the owner's password or sign-in code from **Owner & account**. There is no remote-desktop feature.

## Handover checklist

Tick every line before you leave the site.

- [ ] **Admin portal:** web access on with its expiry date; every branch desktop-licensed; Analytics and receipt options as sold; a desktop version approved
- [ ] **Owner:** signed in on the dashboard and set a private password; sign-in codes on or off as agreed
- [ ] **Business profile:** address, KRA PIN, receipt header and footer; **Business day ends at** matches the closing time
- [ ] **Menu:** uploaded, with costs or recipes, variants and extras checked, menus making sense on the till
- [ ] **Staff:** everyone has their own PIN (no two the same); each manager has signed in once on each till; web access given to partners and accountants
- [ ] **Payments:** the methods the shop takes are on; the M-Pesa number is set on each branch's till; credit customers have limits
- [ ] **Every till:** right branch, unique terminal code, device name; **Updater task: installed** on Tech › Updates
- [ ] **Printers:** **Print through these printers** ON; every station has a printer (or another till handles it); paper width matches the roll; test print OK; the drawer opens on a cash sale
- [ ] **Branch server** (if any): keep-running settings done; every till joined and "Encrypted"; Close Branch visible on it
- [ ] **Test run** done (Step 10), then the test sales cleared: admin › **Owner & account › Clear test data…** — set the testing start and stop times, choose "Put back as before testing" for stock, **Show what will be removed**, type the client's name, **Clear test data** (super admin; the menu stays)
- [ ] **Daily Report Email:** on, with recipients and a send time
- [ ] **Hand the owner:** the dashboard address, the support number, and the reveal-code note for the branch server

## Common problems

| What you see | Fix |
| --- | --- |
| This branch has no desktop licence (till PIN screen) | Admin › Branches & tills › **Activate licence** |
| Invalid, expired or already-used code | Mint a new code with **Enrol till** (15-minute expiry, single use) |
| That code is for a different branch | Use a code from the till's own branch |
| This till is no longer joined to the business | Tech › **Rejoin this till** with a new code |
| This device is not yet approved (web POS) | Dashboard › Devices › **Approve**; tills never need this |
| OFF — nothing will print | Tick **Print through these printers** |
| Looks like the printer is off or unreachable | Check power, cable and IP; print the printer's self-test page to read its IP |
| Receipt's right-hand column wraps | Set **Paper width** to the roll in use |
| No branch server answered on this network | Server on and ZapTill running; both PCs on the same network, profile **Private** |
| Could not reach that branch server | Check the firewall rules (TCP 4100–4103, UDP 4199) and the Private profile |
| Port 4100 in use (only in the server log) | Close the program holding 4100; tills that know the server follow it |
| That PIN was not recognised (sale on account) | The manager signs in once on this till, or use a branch server |
| Web portal access is not enabled for your account | Admin › Plan & billing › **Enable web access** |
| Your web portal subscription has expired | Renew: set a new web access expiry |
| Sign-in code not arriving | Check spam, wait 45 seconds, **Send a new code**; admin › **Reset to email code** |
| Trading day {date} was never closed on this till | A manager closes it (Manager › Close › Close Day), or close it remotely in Tills & days |
| This till's clock is {n} min ahead of/behind the server | Fix Windows time and time zone (Nairobi); turn on automatic time |
| Late-night sales land on the wrong day | Profile › **Business day ends at** (e.g. 02:00) |
| This is part of the online licence | Admin › enable web access |
| Pull logs stays Waiting | Use Tech › **Send logs to support** and ask for the reference |

**Open questions for ZapTill** (to settle before the guide is final):

- Where technicians download the installer, and whether the server address is pre-filled in the production build.
- A first credit limit for a new customer (no screen yet; see Step 6).
- Whether the owner is reliably forced to change the temporary password (Step 3 tells the technician to do it by hand).
- Whether a "trial" plan exists, since new clients may show Plan: None.

*Screenshots show the real ZapTill apps running a made-up demo business (Mama Lishe Grill). The branch-server Allow prompts are mock-ups.*
