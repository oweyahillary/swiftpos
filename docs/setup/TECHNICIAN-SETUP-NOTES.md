# ZapTill technician setup: source notes for the guide

Prepared 2026-10-22 from branch `dev`, including the uncommitted working tree with A562.

These are working notes for writing the technician guide. They are not the guide itself.

**How labels are quoted.** UI text in "quotes" is copied from the source or read off the running app. `{x}` marks a value the app fills in. File references are relative to `C:\swiftpos\pos`.

**Abbreviations used below:**
- AP = `apps/admin/src/AdminPortal.tsx`
- ADM = `apps/server/src/routes/admin.ts`
- D = `apps/dashboard/src`
- DT = `apps/desktop/src/renderer`

## How the screenshots were made

### The local stack

Almost every screenshot comes from the **real apps, run end to end on this PC against a local backend**. No production, no dev cloud and no real sign-ins were used. The stack was:

- **Database and sign-in.** A local Supabase stack (Docker, `supabase start`, project `zaptill-setup-shots` in the scratchpad), running Postgres 17, GoTrue, PostgREST, Kong and Mailpit. The schema was built with `scripts/setup-clean-db.sh` (baseline plus every migration up to `162_analytics_stock_customers_costs`). The admin user was created with `scripts/seed-admin.sql`.
- **API.** `apps/server` (`src/index.ts` run with tsx) on `localhost:4410`, using an env file in the scratchpad. Email went over SMTP to Mailpit, which is how the sign-in codes were read.
- **Admin portal.** The vite dev server on `:5176`.
- **Dashboard.** The vite dev server on `:5173`.
- **Till.** The real Electron app (`apps/desktop`, built `dist`), started with `--user-data-dir` set to a scratchpad folder and driven with Playwright.
  - Its server address was set to `http://localhost:4410` in the real setup screen.
  - It was enrolled with a real enrolment code from the local admin portal.
  - It made real sales, a real void, a real shift close and a real day close, and sent real logs.

### Where the real apps were helped along

- **Branch server search on the till.** On the 07c, 07c2 and 08a screens, the search result was stubbed inside the running till so the screen shows a demo "Mama Lishe Grill · Office PC · 192.168.1.20" (or nothing).
  - Reason: the real search found a live ZapTill branch server of a real client on the office network. That result was not photographed or used, and the test till never sent it a join request.
- **Printer list on the till.** On 09d and 09e, the Windows printer list was replaced with two demo names ("EPSON TM-T20III", "XP-80C Kitchen"), so that no real PC printer names appear and nothing reaches the PC's spooler.
  - The kitchen printer was pointed at the reserved test address 192.0.2.50, where nothing answers.
  - The assignments were cleared again afterwards.
- **Idle time.** The till locks when Windows reports the PC as idle (see Gotchas, step 10). The test till was told the PC was never idle.

### Stubbed screens

Three screens come from the **stubbed till harness** (`apps/website/tools/till-shots`, copied to the scratchpad), not the live stack:
- 08b (the till waiting for "Allow")
- 08c (the server's "A till wants to join this branch server" prompt)
- 10y (Close Branch on a branch server)

Reason: running a second ZapTill as a branch server on this PC would have opened port 4100 and the Windows firewall dialog, next to the real branch server already running here.

### Other notes on the screenshots

- The till build reports itself as **v1.0.19**: the dev build's `package.json` version. The code is the current `dev` code.
- The admin portal shows "ZapTill v1.0.19" for the same reason.
- Window title and devtools: the test till ran unpackaged, so it loaded its screens from `localhost:5174`. Nothing of that shows in the shots.

## The demo data used

| What | Value |
|---|---|
| Client | **Mama Lishe Grill**, Restaurant, KES, VAT 16% |
| Branch | **Ngong Road** (main) |
| Owner | Achieng Odhiambo, `owner@mamalishe.example` |
| Temporary password | `Karibu-2026`, later changed to `MamaLishe#2026` |
| Staff | Wanjiru Kamau (Cashier, PIN 1234) |
| | Otieno Ouma (Supervisor, PIN 5678) |
| | Brian Kiptoo (Manager, PIN 2468) |
| | Njeri Mwangi (Accountant, PIN 4321, given web access) |
| Till | "Counter", terminal code T1 |
| Branch server (shown only) | "Office PC", S1 |
| Credit customer | "Kamau Hardware (staff lunches)", limit KES 20,000 |
| M-Pesa | Buy Goods till 512345 |

---

## Step 1. Create the business and its owner (admin portal)

**Where:** the admin portal, sidebar › "New client" (page title "New Client").

**Signing in to the portal:**
- The page shows "ZapTill / Admin portal", with "Email", "Password" and the button "Sign in".
- Every admin then gets a code step, "Enter your sign-in code":
  - By email: "We emailed a 6-digit code to {masked email}. It works for 10 minutes."
  - By authenticator app: "Open your authenticator app and type the 6-digit code for ZapTill."
- There is a tick box "Remember this browser for 30 days" and the button "Verify and sign in".
- Links: "← Back", and "Send a new code" (or "Email me a code instead" for an authenticator user) (AP:297-345).

**The sidebar** (AP:374-394):
- **Overview:** "Dashboard", "Alerts"
- **Clients:** "All clients", "New client"
- **Money & support:** "Billing", "Tech access"
- **System:** "Team", "Audit log", "Database", "System", "My account"

**The New Client form, in order** (AP:2596-2716). The subtitle reads: "Create a new business account. A trial subscription is automatically applied."

1. **"Business Type"** tiles: "Restaurant", "Café", "Retail", "Minimart", "Parking", "Petrol Station", "Other".
   - The default is Minimart, so a technician must click the right tile.
   - The server accepts `restaurant, cafe, retail, minimart, parking, petrol_station, other`.
2. **"Business Details":**
   - "Business Name *" (required; placeholder "e.g. Lovers Rock Minimart")
   - "Phone" (optional; "+254 7XX XXX XXX")
   - "Currency": KES, USD, UGX, TZS, ETB, GHS, NGN or ZAR (default KES)
   - "VAT Rate (%)": 0–30 in steps of 0.5, default 16
3. **"Main Branch":**
   - "Branch Name *" (required; default "Main Branch")
   - "Address" (optional; "e.g. Kisumu Mall, Ground Floor")
4. **"Owner Login Account".** The note reads "A Supabase auth account is created with these credentials. The owner logs in at /login."
   - "Owner Name" (optional)
   - "Email *" (required; "owner@business.com")
   - "Temporary Password * (min 8 chars)". While it is too short the field shows "Must be at least 8 characters.", and the note "⚠ Owner will be forced to change password on first login." sits underneath.
   - The password is a plain text box, so it is visible as it is typed.
5. **Button:** "Create {type}", for example "Create Restaurant". While working it reads "Creating client…".

**Success panel:**
- "Client created!" and "{name} is ready to go."
- Rows: "Business ID", "Type", "Branch", "Owner login", "Temp password".
- "⚠ The owner will be prompted to change their password on first login."
- Buttons: "View client →" and "+ Add another".

**Not on this form.** There are no fields for licence, plan, expiry, sign-in address or features. All are set afterwards on the client's tabs.

**The client page:**
- Tabs, in order: "Overview", "Branches & tills", "Plan & billing", "Features", "Tills & days", "Desktop updates", "Owner & account", "Notes".
- Header tiles: "Web portal", "Plan", "Branches", "Tills", "Desktop version", "Outstanding".
- "Edit details" changes Name, Type and Currency.

**Sign-in address (subdomain).** Optional. It is on **Overview › "Support and sign-in" › "Sign-in address"**:
- With none set: "None — signs in on the main address", with the button "Set" (or "Change").
- Placeholder "e.g. africanfries".
- Help text: "Leave empty and save to remove. Only this client's owner and staff can sign in on it."
- Rules: 3–32 characters, lowercase letters, digits and hyphens, no "--", and not a reserved name (`apps/admin/src/lib/tenantHost.ts`).
- Without TENANT_ROOT_DOMAIN on the cloud: "TENANT_ROOT_DOMAIN is not set on the cloud — the address is saved but not live yet."

The same card has **"Support tech"**: "None (ZapTill support)" or a team member, "Shown on the shop's Help".

**What happens behind:** `POST /api/admin/clients` (ADM:444-578), in this order:
1. Creates the Supabase sign-in with `email_confirm: true`. No invite or reset email is sent.
2. Creates the `businesses` row (`status 'active'`).
3. Creates the **main branch**. It is **not desktop-licensed**.
4. Creates the owner role (named "owner") plus every built-in role for the business type (`seededRoleRows` and `seedDefaultRolePermissions`).
5. Creates the owner's staff row in `users`, on the owner role, linked to the main branch, with `must_change_password: true`.
6. Creates the onboarding row.
7. Creates a 30-day **trial subscription, but only if a plan named like "trial" exists**.
8. Writes the audit entry `create_client` and emails the super admins.

**Built-in roles, in order** (`shared/permissions.ts` BUILT_IN_ROLES):

| Role | Description |
|---|---|
| Manager | "Runs a branch" |
| Cashier | "Sells at the till" |
| Supervisor | "Sells, and approves voids, refunds, sales on account and drawers with their PIN" |
| Waiter | "Takes orders, sends them to the kitchen and takes payment" |
| Kitchen | "Kitchen staff - reads the menu (the kitchen display has its own sign-in)" |
| Storekeeper | "Receives deliveries, transfers, counts and writes off stock" |
| Accountant | "Reads the books - every report, the orders and the expenses, changes nothing" |
| Fuel attendant | Petrol stations only |
| General Manager | "Runs the whole business day to day - every permission, never the owner" |
| Operations Manager | "Runs operations - menu, stock, kitchen, shifts and the day, staff and the operational reports" |
| Finance Manager | "The accountant who acts - pays suppliers, records expenses, customer credit and drawer checks" |
| Auditor | "Sees every report, list and figure a non-owner can be shown, changes nothing" |
| Kitchen Manager | "Runs the kitchen - the menu and recipes, receiving, counting and writing off stock" |

The local run showed 13 roles on Roles and permissions: these 12 (no Fuel attendant for a restaurant) plus the owner role.

**How the owner gets a password.** The technician hands over the temporary password typed on the form. The owner signs in on the dashboard at `/login`. See step 3, and the gotcha on the forced password change.

**Owner & account tab** (super admin only):
- **"Change email".** Prompt: `New login email for the owner of "{name}":`. On success: "Owner login email changed to {email}.", followed by "The previous address was told." or "The previous address could not be emailed — tell the owner yourself."
- **"Reset password".** Prompt: `New password for the owner of "{name}" (min 8 characters):`. Result: "Password reset for {email}. They are signed out everywhere and must choose a new password at their next sign-in. Share it securely."
- **"Reset to email code".**
- The "Account status" card: "Suspend" (asks "Reason for suspension:"), "Activate", "Export".
- "Clear test data…" (described in step 12).

**A562: change the owner email only here, and deliberately.**
- Before A562, changing the owner email left the old staff row behind. The next owner sign-in then created a second "Owner" staff row.
- Now, with uncommitted code (ADM:1073-1120, `moveOwnerRowEmail`), the change also moves the owner's own staff row. It moves only an exact match, only when there is exactly one such row, and never onto an address another row uses.
- The owner cannot change their own sign-in email on the staff form. Error: "Your e-mail is how you sign in — ZapTill support changes it for you."
- Duplicate owner rows already in production are not cleaned up. They show "Not your sign-in account".
- Nobody can give the owner's role to anyone. Error: "The owner's role belongs to the owner alone — choose another role (for full rights, a role such as General Manager)."

**Gotchas and errors:**
- From the browser: "Temporary password must be at least 8 characters."
- From the server (ADM:451-463):
  - "businessName is required"
  - "businessType is required"
  - "ownerEmail is required"
  - "ownerPassword must be at least 8 characters"
  - "Invalid type. Must be one of: restaurant, cafe, retail, minimart, parking, petrol_station, other"
  - "VAT rate must be a number from 0 to 100."
  - "Currency must be a three-letter code, e.g. KES."
  - "Auth creation failed", when the email is already a sign-in somewhere
  - "Client creation failed"
- **Plan shows "None" after creating.** This happened in the local run, because the local database has no "trial" plan. The subtitle's promise of an automatic trial depends on that plan existing.
- **The owner cannot sign in to the web dashboard until web access is on.** See step 2. The message is "Web portal access is not enabled for your account. Please contact ZapTill to upgrade." (auth.ts:812-820). The dashboard shows it as the full-screen "Web portal access not enabled" with "Your licence covers the desktop POS app only…".
- **Forced password change did not happen locally.** The owner signed in with the temporary password and went straight to the dashboard, not to `/change-password`. The cause: `auth.ts:828-840` clears `must_change_password` when the auth user's `updated_at` is later than `created_at`. The server's own `signInWithPassword` call, made just before, appears to move `updated_at`. See the unsure list. In the guide, tell the technician to have the owner change the password themselves (Settings › Users and access › My sign-in › Password), or to check on the dev cloud first.

**Screenshots:**
- `01a-admin-sign-in.png`: the email and password form (cropped)
- `01b-admin-sign-in-code.png`: the sign-in code step (cropped)
- `01c-admin-new-client-form.png`: the New Client form, filled for Mama Lishe Grill (Restaurant)
- `01d-admin-client-created.png`: "Client created!" with the Business ID and temporary password
- `01e-admin-owner-account.png`: the Owner & account tab (Change email, Reset password, Reset to email code, Suspend, Clear test data)
- `01f-admin-overview-sign-in-address.png`: the Overview tab, with "Support and sign-in" and "Sign-in address"

---

## Step 2. Licences and features (admin portal)

**Where:** admin portal › All clients › the client › tabs "Plan & billing", "Branches & tills" and "Features".

### Web access (the online and dashboard licence)

**Plan & billing › "Web portal access".** Only a super admin can press these buttons. Others see "Super admin only".
- The state reads "Web portal not enabled": "Desktop-only licence. Enabling web access (KES 10,000 a year) raises an invoice."
- Button **"Enable web access"**. It asks to confirm: "Enable web portal access? This will allow the client to log into the dashboard. Ensure payment of KES 10,000 has been received."
  - It then creates a pending invoice "Web Portal Hosting — Annual Access" for KES 10,000.
  - In the local run, the header tile changed to "Web portal · Active" and "Outstanding · KES 10,000".
- **"Web access expiry"**: a date, then "Set expiry" and "Clear".
  - With a date: "Renewal is measured against {date}."
  - Without: "No expiry set — the renewal reminders have no date to measure against."
- **When web access lapses** (`apps/server/src/lib/webAccess.ts`):
  - Up to 21 days after expiry is a grace period with full access.
  - Days 21 to 28 are reports only.
  - After that the owner sign-in is refused: "Your web portal subscription has expired. Please renew to continue."
  - Desktop tills are not affected.

**Online licence = premium features on the till.** The memory note's "online licence" is this web access (`web_hosting`). It is not a separate "online licence" toggle.
- On the till, the Manager screens for offers, wastage and transfers depend on it (`lib/managerNav.ts:102,111,112`, `a.online`).
- The till's main process refuses with "This is part of the online licence — ask ZapTill to turn it on for your business." (`main/ipc/shared.ts:700`).
- **Unsure:** exactly which flag `a.online` reads. It is not traced; see the unsure list.

### Desktop licence, per branch

**Branches & tills.** The note reads "A branch needs a desktop licence before its tills can be enrolled."
- Each branch shows "✗ Not licensed — desktop POS blocked" or "✓ Licensed {date} · {n} tills".
- **"Activate licence"** (super admin only):
  - It asks `One-off desktop licence fee for "{branch}" (KES). Leave blank to create invoice later:`.
  - If an amount is given, it then asks "Payment reference (M-Pesa ref / bank ref):". With a reference the invoice is marked paid.
- **"Revoke licence"** asks `Revoke the desktop licence for "{branch}"? The desktop app on this branch will be blocked on its next sync.`
- There is **no expiry date** on a desktop licence.
- **Without a desktop licence:**
  - The till's PIN screen shows "This branch has no desktop licence. Contact ZapTill to activate it." and the branch list reads "{name} (no desktop licence)".
  - The server says "This branch does not have a desktop licence. Please contact ZapTill to activate."
- The other buttons on this tab: "Enrol till" (step 7), "Tills →", "+ Add branch" (fields "Name *", "Address", "Phone", then "Create").

### Features tab

The tab is headed "Features", with the note "Changes take effect at once; tills pick them up at their next sync." Toggles, in order on screen:

- **"App themes"**:
  - Off: "Tills keep the standard look. Turn on to let the client pick an app theme."
  - On: "The client picks an app theme on the Branding page; tills follow it."
  - Confirm: "Enable themes? The client can then pick an app theme on the Branding page; their tills pick it up within about 20 seconds."
  - This also unlocks per-branch branding (A544).
- **"Analytics"**:
  - Off: "The Analytics page shows "part of ZapTill Premium". Turn on when the client has paid for it."
  - Confirm: "Enable Analytics? The owner (and managers with the sales report) see the Analytics page on the web dashboard at once."
- **"POS SWITCHES"** are read-only ON/OFF here: "Set by the owner — Settings › Business › POS options."
  - "Delivery fee and rider"
  - "Cashiers see only their own sales" (amber, now per role)
  - "No reprint for cashiers" (amber)
  - "Eat now, pay later"
  - "Pay before kitchen"
  - "Sign-in codes (OTP)"
  - "Only managers record expenses and cash in / out" (amber)
- **"RECEIPT OPTIONS"**. Note: "All off = the standard receipt: the classic layout at 3.75 mm line spacing with a small logo. Thermal receipts on the tills and the web POS; kitchen tickets never change." The toggles:
  - "Compact receipt layout" (`receipt_compact_layout`): "Fewer lines: Type and Bill No. on one line, Cashier and time on one line, no Kots line, Round Off only when not zero, Total only with a tip or delivery fee, no Payment Detail heading. Saves more paper; some find it crowded."
  - "Classic line spacing (4.23 mm)" (`receipt_classic_spacing`): "Receipt lines at the printer’s own spacing (4.23 mm a line) instead of the standard 3.75 mm. Turn on if a printer runs the lines together."
  - "Full-size receipt logo (up to 36 mm)" (`receipt_full_logo`): "The receipt logo prints at its full height (up to 36 mm) instead of shrunk to 15 mm."
  - "Extra paper before the cut (3 lines) — for a cutter that clips the last line" (`receipt_extra_feed`): "Three blank lines before the receipt is cut instead of one. A printer without a cutter always feeds three."
- **"KITCHEN TICKET OPTIONS"**:
  - "Kitchen tickets in the small font" (`kitchen_font_b`): "Kitchen tickets print in the printer’s smaller Font B (64 characters a line on 80 mm) instead of the normal Font A (48 a line, like the dispatch ticket). Fits long orders on less paper; harder to read at a distance."
  - **Gotcha:** the section note above this toggle is out of date. It still says "Off = the standard kitchen ticket: the printer’s smaller Font B…". Since A551, off means Font A. Do not copy that note into the guide.
- **"STAFF OPTIONS"**:
  - "Separate approval PIN for managers" (`approval_pin`, A562, uncommitted): "A separate approval PIN for managers (instead of their sign-in PIN). Off: managers approve voids, refunds, sales on account and drawers with their sign-in PIN, and the staff form offers no approval PIN. One already set keeps working until removed."
- **"Other flags"**: any other stored flag, shown by its raw key.
- **Behind:** `PATCH /api/admin/clients/:id/features/:key {enabled}`.

**Screenshots:**
- `02a-admin-enable-web-access-confirm.png`: the confirm for "Enable web access"
- `02b-admin-plan-billing-web-access.png`: Plan & billing after enabling ("Web portal active", the expiry)
- `02f-admin-branch-not-licensed.png`: Branches & tills before the licence ("✗ Not licensed — desktop POS blocked")
- `02c-admin-activate-licence-fee.png`: the licence fee prompt
- `02d-admin-enable-analytics-confirm.png`: the Analytics confirm
- `02e-admin-features.png`: the whole Features tab (Analytics and App themes on, receipt and kitchen options, approval PIN)

---

## Step 3. The owner's first sign-in on the web dashboard

**Where:** the dashboard `/login` (`D/pages/LoginPage.tsx`), or the client's own sign-in address if one was set.

**Steps:**
1. **The "Sign in" page** ("to your {Business }dashboard").
   - "Email" (placeholder "you@business.com") and "Password" ("••••••••", with "show"/"hide").
   - Link "Forgot password?", button "Sign in" ("Signing in…" while working).
   - Footer: "No account? Contact your ZapTill agent to get set up."
2. **Sign-in code.** This step appears only if the owner has turned on Settings › Business › POS options › "Sign-in codes (OTP)". It is off on a new client, and the local run went straight in until it was switched on.
   - Heading "Enter your sign-in code": "We emailed a 6-digit code to {masked}. It works for 10 minutes."
   - The code box (placeholder "••••••"), the tick box "Remember this browser for 30 days", and "Verify and sign in".
   - Links "← Back" and "Send a new code".
   - Rules: 10 minutes, 5 tries, at most one email per 45 seconds (`apps/server/src/lib/loginOtp.ts`).
   - Partners and accountants (A550) always get a code, whatever the switch.
3. **"/change-password"** (`ForcePasswordChangePage.tsx`):
   - "Welcome — let's secure your account", and "Your account was set up by a ZapTill agent. Please choose a new private password before continuing."
   - "Set your password" / "Choose something only you know."
   - "New password" (placeholder "Min. 8 characters"), with a strength bar Weak / Acceptable / Good / Strong.
   - "Confirm password" ("Repeat new password").
   - Button "Save password & continue →".
   - The footer says "You can update your password anytime in Settings → My account". The real place is Settings › Users and access › "My sign-in".
   - See the step 1 gotcha: locally this page was not shown by itself. The screenshot was taken by opening `/change-password` directly.
4. **Onboarding: there is none.** `OnboardingPage.tsx` (`/onboarding`) exists, but nothing links to it. The owner lands on the Overview.

### Settings › Business

**Where:** `/dashboard/settings/business/...`. The tabs are "Profile", "Branding", "Branches", "Tax & compliance", "Payments", "Voids, refunds & delivery", "POS options", "Restaurant setup" (the label depends on the business type) and "Integrations".

**Profile › "Business details":**
- Fields: "Business name", "Address", "Phone", "Contact email", "Tax PIN (KRA)", "VAT rate (%)", "Catering/Tourism Levy (%)", "Logo image URL", "Currency".
- "Contact email" help: "Business contact address. Your sign-in email is changed by your ZapTill admin."
- "Currency" help: "Locked once you have recorded sales — historical amounts are denominated in it."
- Button "Save business details". Toast "Business profile saved"; if the name is empty, "Business name is required".

**Profile › "Receipt text":**
- "Free-text printed above and below every receipt — address, PIN, a thank-you line. Saved as you leave each field."
- Fields "Header (top of receipt)" and "Footer (bottom of receipt)".
- The read-only "Pay by M-Pesa (printed under the payments)" says the number is set on each till (step 6).

**Profile, hours:**
- **"Business day ends at"** is the day cut-off. Options run every 30 minutes from "00:00 (midnight)" to "06:00".
  - Help: "Sales before this time count to the night before — on the tills, the reports and the daily email. A bar open until 3 am sets 04:00, and closes the day after service. Midnight (00:00) unless you change it."
- "24-hour operation"
- "What cashiers see in History"
- "Cashiers see their sales when closing a shift"
- "Cashiers see a total in History"
- The footer note "Per-branch receipt text and hours that override these defaults are coming separately" is out of date. Per-branch overrides already exist on the branch detail page under "Receipt & hours for this branch".

**Branches:**
- "Branches" shows "{n} locations" and the badge "Contact ZapTill to add a branch". There is no create button.
- The server refuses with "Branch creation is managed by ZapTill agents. Contact ZapTill to add a branch."
- Each branch card has "View Detail →", "Edit" (the "Edit Branch" form: "Branch Name *", "Address", "Phone", "Save Branch"), "Set as Main" and "Deactivate".
- The branch detail page has "Receipt & hours for this branch", with an "Override for this branch" or "Override" check per item, and that branch's "Payment methods".

**Branding:**
- Heading "Branding": "Your logo and accent colour on the till lock screen. Changes reach tills automatically."
- "Accent colour" palette, or a custom hex.
- "Logo": "PNG or JPEG. Shrunk to fit automatically (≤250 KB). SVG isn't supported yet."
- "Print logo on customer receipts" (off by default).
- Buttons "Save branding" / "Reset to default". Saving shows "Saved. Tills pick up the new branding within about 20 seconds — no restart needed."
- **"App theme" and "Per branch"** (A544: a theme, brand colour and receipt footer for each branch) appear only when App themes is on in the admin portal. Otherwise: "Per-branch branding (a branch's own theme, colour and receipt footer) is part of Themes — ask ZapTill."
- Per-branch footer limits: 48 characters a line at 80 mm, 32 at 58 mm, at most 6 lines and 300 characters.

**POS options:**
- "Delivery fee and rider", "Eat now, pay later", "Pay before kitchen", "Sign-in codes (OTP)" (owner only), and "Loyalty points".
- Behind: `PUT /api/controls/pos/:key`.

**Gotchas:**
- "Not this business": "This sign-in address belongs to another business. Use your own business's address, or the main ZapTill sign-in."
- Wrong password: "Invalid email or password".
- Lockout: "Too many failed sign-ins for this account — try again in 15 minutes."
- Wrong code: "That code is not right. Check the email and try again."
- Expired code: "That code has expired or was tried too often. Send a new code."
- Email failure: "Could not email your sign-in code. Try again in a minute, or call ZapTill support."

**Screenshots:**
- `03a-dashboard-sign-in.png`: the dashboard sign-in
- `03h-dashboard-sign-in-code.png`: the sign-in code step, after "Sign-in codes (OTP)" was turned on
- `03b-dashboard-set-password.png`: "Set your password"
- `03c-dashboard-first-overview.png`: the first Overview of an empty business
- `03d-dashboard-business-profile.png`: Profile, filled in (address, KRA PIN, receipt header and footer, "Business day ends at" 02:00)
- `03e-dashboard-branding.png`: Branding, with themes on (App theme, Per branch)
- `03f-dashboard-branches.png`: Branches, with "Contact ZapTill to add a branch"
- `03g-dashboard-pos-options.png`: POS options

---

## Step 4. Load the menu

**Where:** dashboard › Menu › "Menu Items" (`/dashboard/products`; Restaurant and Café relabel Products as "Menu Items" and Categories as "Menu Sections"). The header buttons are "Menu upload", "Bulk images", "Bulk price", "Set costs" and "+ New product".

### Menu upload (`D/pages/products/MenuUpload.tsx`)

The panel is headed "Menu upload": "One workbook — products, upgrades, recipes and ingredients."

1. Press "↓ Template" to download `zaptill-restaurant-import-template.xlsx`. Its sheets are "Read me", "Products", "Upgrades & Spices", "Recipe" and "Ingredients".
2. Press "Choose an .xlsx workbook". The tabs are recognised by sheet name and applied in the order Ingredients → Products → Upgrades → Recipe.
3. A preview appears. Then press **"Apply {n} rows"**.
4. The results show "{a} added · {u} updated", "{n} skipped" and "New: …". The local run also showed "4 categories moved to a menu · new menus: Food, Soft drinks".

**Products columns, in order:**

| Column | Meaning |
|---|---|
| `name` | Required; the matching key |
| `category` | Category name |
| `price` | Required for a new product; 0 or more |
| `cost_price` | 0 or more, or DELETE |
| `description` | |
| `sold_by` | each / weight / volume / piece |
| `unit_label` | |
| `pieces_per_unit` | Whole number, 1 or more |
| `track_stock` | yes / no |
| `source` | purchased / central_kitchen |
| `is_kitchen` | yes / no |
| `tax_type` | A–E |
| `kra_item_class_code` | |
| `reorder_level` | |
| `plu_code` | A stable key, so items can be renamed freely |
| `barcode` | |
| `status` | active / inactive |
| `show_days` | e.g. "Tue, Thu" |
| `menu` | Puts the CATEGORY in that menu; created if needed |

- "Upgrades & Spices" columns: `product, group, type (free|upgrade), option, price_added, notes`. A free group has every option at 0. An upgrade group must have one option at 0.
- "Recipe" columns: `product, ingredient, quantity_per_serving, unit, notes`.
- "Ingredients" columns: `name, category, unit, unit_cost, reorder_level, is_packaging, notes`.
- The Read me sheet's rules: matched by name and updated, never duplicated; a blank cell leaves the value alone; DELETE clears it; one row per item.
- Behind: `POST /api/products/bulk` (at most 500 rows: "Maximum 500 rows per import"), `/api/variants/bulk`, `/api/recipes/bulk` and `/api/stock/ingredients/bulk`.

**Gotchas:**
- **One menu per category.** The demo file put Passion Juice, Soda and Water under "Soft drinks" and Masala Tea under "Tea", all in the Drinks category. Masala Tea was skipped with `row 15: menu "Tea" clashes with row 13 ("Soft drinks") — one menu per category; the first row wins`. This is shown in `04c`.
- Server row errors include:
  - "price is required for a new product"
  - "invalid sold_by: x (use each/weight/volume/piece)"
  - "invalid track_stock: x (use yes/no)"
  - "invalid tax_type: x (use A/B/C/D/E)"
  - 'upgrade "X" needs one option at 0 (the included baseline)'
  - 'free choice "X" cannot have a price — set every option to 0 or make it an upgrade'
- The Ingredients tab needs a branch picked in the top bar: "Ingredients carry per-branch opening stock — pick a specific branch in the top bar first."

### Categories, menus, variants, extras, combos, images, costs, stock

- **Categories / Menu Sections** (`/dashboard/categories`): "+ New category", with "Name", "Color" and "Menu". There is no printing field here; printing is routed through Print stations (step 9).
- **Menus** (A537, `/dashboard/menus`):
  - "Group your categories into menus — Food, Soft drinks, Alcohol, Tea. Put a category under a menu on the categories page. The POS shows the menus as tabs in its category panel."
  - Placeholder "New menu, e.g. Soft drinks", then "+ Add menu".
- **Variants and extras.** The row's "Variants" link opens "Variants & Modifiers":
  - "Variant groups": "Variants change the base price (e.g. Size: Small +0, Large +50) and can move stock. Customer picks one option per group."
  - "Modifier groups": "Modifiers are add-ons with their own price (e.g. Extras: Extra Cheese +30). Customer can pick multiple."
  - "+ Add group" opens "New variant group" / "New modifier group":
    - "Group name" ("e.g. Size" / "e.g. Extras")
    - Variants only: "Required selection"
    - Modifiers only: "Min select", "Max select (blank = unlimited)"
    - Options, with "+ Add option"
    - "Save group"
  - Demo: Chicken Burger got the variant "Spice level" (Normal/Spicy, from the upload) and the extra "Extras: Extra Cheese +KES 50" (added by hand).
- **Combos** ("Combo Meals" / "Set Meals", restaurant and café only): "+ New combo", with "Combo name *", "Combo price *" and "Items in combo".
- **Bulk images:**
  - Files are matched by file name: barcode first, then PLU, then exact product name.
  - The button is "📷 Choose images". Images go to Cloudinary.
  - **Not tried locally** (the Cloudinary settings were blanked).
- **Costs: stress these for analytics.**
  - "Set costs" opens "Set cost prices": "The unit cost drives margin, COGS and the Menu Matrix. Leave blank to clear." Then "Save costs".
  - Alternatively, put cost_price in the upload, or a recipe ("Recipe" link: "Ingredient", "Qty per serving", "Save Recipe").
  - Analytics says "{n} items have no cost — {x}% of your sales, so your margins are partly blind." and "Set these costs to see your real margins".
- **Stock tracking.** The product form has "Track stock for this product". The upload column is `track_stock`. The list has bulk "Track stock" / "Untrack".

**Screenshots:**
- `04a-dashboard-menu-upload-open.png`: the Menu upload panel
- `04b-dashboard-menu-upload-preview.png`: the preview after choosing the demo workbook
- `04c-dashboard-menu-upload-result.png`: the result, with 15 added, 1 skipped (the one-menu-per-category clash) and new menus
- `04d-dashboard-products.png`: the Menu Items list, with prices and costs
- `04e-dashboard-variants-drawer.png`: Variants & Modifiers for Chicken Burger
- `04i-dashboard-new-modifier-group.png`: a new modifier group "Extras" with "Extra Cheese" at 50
- `04f-dashboard-set-costs.png`: "Set cost prices"
- `04g-dashboard-categories.png`: Menu Sections
- `04h-dashboard-menus.png`: Menus

---

## Step 5. Staff, roles and PINs

**Where:** dashboard › Settings › "Users and access" (`/dashboard/settings/users/staff`). The tabs are "Staff members", "Roles and permissions" and "My sign-in".

### Add staff

Press **"+ Add Staff"** to open "Add Staff Member". Fields, in order:
1. Mode: "🔢 PIN Login" | "✉️ Email Invite".
2. "Full name", then "Role". The role list shows only roles you may give; the owner's role is never offered.
3. "Email — used for sign-in". Required: "Email is required". Help in PIN mode: "Staff use their email and PIN to sign in to the POS."
4. "PIN (4–6 digits)", then "Phone (optional)".
5. "Approval PIN (optional)". Shown only when "Separate approval PIN for managers" is on in the admin portal.
6. "Branch access". The first branch is preselected. With none: "⚠ No branch selected — staff will access all branches".
7. "Hourly rate (optional)".
8. "This person's permissions": "Pre-filled from their role. Tick or untick to give or take away a single permission for this person only." Groups: Selling, Drawers and the day, Reports, Orders, Menu, Stock, Customers, Expenses, Staff, Front of house, Settings.
9. Button "Add Staff" ("Send Invite" in invite mode).

**PIN rules:**
- Digits only, 4 to 6 (`/^\d{4,6}$/`). Error: "PIN must be 4–6 digits".
- Two people with the same PIN: the till refuses an ambiguous PIN. This is from the code; see the unsure list.

**The staff list:**
- Each row shows a role badge, "active", and "Web: invited|active|revoked".
- Actions: "Give web access", "Resend invite", "Revoke web access", "Reset sign-in code", "Edit", "Deactivate".

### Web dashboard access for partners and accountants (A550)

1. On the row, press "Give web access".
2. Confirm "Give {name} web dashboard access?": "{name} will sign in to this dashboard with {email} and a password they set (the invitation says how), plus a one-time code each time. They see and do only what their role allows — never what is yours alone."
3. Press "Give access". The page notes "Invitation sent to {email}." and the row shows "Web: invited".

The email subject is "You can now sign in to {Business} on ZapTill" (this arrived locally in Mailpit). Its link opens Forgot password with the email filled in.

**Advice:** add the person with "PIN Login" first, then "Give web access". A550 notes that the "Email Invite" mode's Supabase invite link lands nowhere.

Server refusals:
- "The owner's role signs in as the owner. Give them another role (for example General Manager) first."
- "Add an email address for this staff member first."
- "Activate this staff member first."
- "That email is the owner's own sign-in."

### Roles and permissions

- "+ New role" opens "Name", "Description (optional)" and "Start from", then "Create and set permissions".
- Each role shows "{n} of 68 permissions" with "Edit permissions", "Rename" and "Delete".
- Saving shows "Saved — it applies the next time each person signs in or their till refreshes."
- **A562:** "The owner's role belongs to the owner alone — choose another role (for full rights, a role such as General Manager)." The owner's own row cannot change role: "The owner's own role cannot be changed."

**Till behaviour seen in the local run:**
- A **Cashier** has no "Void" button in History. Voids are done by a Supervisor or Manager (step 10).
- A **Supervisor or Manager** lands on the Manager screen after the PIN and presses "Open POS" to sell.

**Screenshots:**
- `05a-dashboard-add-staff.png`: Add Staff Member, filled for Wanjiru Kamau, Cashier (full form with permissions)
- `05c-dashboard-staff-list.png`: the staff list, with Njeri at "Web: invited"
- `05d-dashboard-roles.png`: Roles and permissions, all built-in roles
- `05e-dashboard-give-web-access-confirm.png`: the "Give web access" confirm

---

## Step 6. Payments, M-Pesa, cash drawer and credit accounts

### Payment methods

**Where:** dashboard › Settings › Business › "Payments".
- "PAYMENT METHODS THE BUSINESS TAKES": "Every branch takes these unless it chooses its own (Settings › Business › Branches › a branch)."
- "MONEY": 💵 Cash, 📱 M-Pesa, 💳 Card, 📒 On account, 📲 Airtel Money, 📲 T-Kash, 🏦 Bank transfer / Pesalink, 🧾 Cheque, 🎟️ Voucher / gift card, 🛏️ Room charge.
- "DELIVERY APPS": 🛵 Glovo, Uber Eats, Bolt Food, Yum.
- On by default: Cash, M-Pesa, Card, Glovo, On account. The till's Payment dialog showed exactly these.
- Saving shows "Saved — the tills follow on their next sync."
- Below that, "Payment methods" (custom), placeholder "e.g. Coop Card", then "Add".

### M-Pesa number

The number is **set on each till, by a manager, not on the web.**

**Where:** till › Manager › "Settings" › "General" › **"M-Pesa for this branch"**: "The number customers pay this branch to. It is printed on every receipt. The owner is told whenever it changes."

1. Choose "Buy Goods" or "Paybill".
   - Buy Goods: "Customers choose Buy Goods and Services and enter this till number." Field "Till number".
   - Paybill: "Business number" plus the account number. Help: "Customers choose Pay Bill, enter the business number and then the account number."
2. Press "Save".

- Behind: `PUT /api/branches/:id/mpesa`. Locally it saved `receipt_pay_label = Buy Goods` and `receipt_pay_number = 512345` for the branch.
- The person needs `settings.mpesa`. Otherwise: "Your role may not change the branch's M-Pesa number."
- Validation:
  - "The till number is 5 to 8 digits."
  - "The business number is 5 to 8 digits."
  - "A Paybill needs the account number customers enter."
- **On the receipt** (A551/A557): the "BUY GOODS:" or "PAYBILL:" block prints centred, bold and double height. The web only shows it, read-only, under Profile › "Pay by M-Pesa".
- There is no screen for Daraja / STK push credentials.

### Cash drawer

- There is no drawer setting and no "open drawer" button.
- The drawer opens by itself from the printer on the **Receipt** station: "Prints the customer receipt and opens the cash drawer."
- The pulse is ESC p 0 25 250 on pin 2 (`shared/printing/src/escpos.ts`).
- The drawer must be cabled to the receipt printer.

### Credit accounts (A545, A552)

**Where:** dashboard › Customers › "Credit Accounts" (`/dashboard/customers/credit`).
- Headed "Credit Accounts", "Total outstanding", "Customers buying on account. Debtors shown first."
- Columns: Customer, Phone, Limit, Owed, Available, then "Manage →".
- The Manage panel has "Credit limit" with "Save", "Record repayment" (Amount, Cash/M-Pesa/Card, "Ref (optional)", "Record payment"), "Manual adjustment" ("Post adjustment", reason required), and "Statement".
- "Credit sales to confirm": every sale on account is confirmed or disputed by a manager. This never blocks a day close.

**Gotcha: there is no screen that gives a customer their first credit limit.**
- Customers › "+ New Customer" has only "Name *", "Phone *", "Email" and "Notes".
- Credit Accounts lists only customers whose limit or balance is above 0, so a new customer never appears there to be given a limit.
- In the local run the limit was set through the same API the Manage panel uses (`PATCH /api/credit/customer/:id/limit`). Only then did the customer appear.
- **The guide needs a decision (or a fix) here.** See the unsure list.

**On the till, "On account" shows only when:**
- the branch takes On account,
- the till holds at least one customer with a credit account, and
- the person has `customers.view` or `customers.credit` (A559).

**Screenshots:**
- `06a-dashboard-payment-methods.png`: Payments, with the methods the business takes
- `06b-dashboard-new-customer.png`: New Customer (no credit field)
- `06c-dashboard-credit-accounts.png`: Credit Accounts, with Kamau Hardware at a KES 20,000 limit
- `06d-dashboard-credit-manage.png`: the Manage panel (Credit limit, Record repayment, Manual adjustment, Statement)
- `06e-till-mpesa-buy-goods.png`: till › Manager › Settings › M-Pesa for this branch, Buy Goods 512345
- `06f-till-mpesa-saved.png`: the M-Pesa panel after saving (cropped)

---

## Step 7. Install ZapTill on the till PC and join it

### The installer

- **Release flow:** `.github/workflows/release.yml` runs on a `v*` tag. It builds the prod flavour and publishes `ZapTill-<version>.exe` plus `latest.yml` as a **GitHub pre-release** on `oweyahillary/swiftpos`. The note reads "Desktop {v}. Held for every client until approved in the admin portal (Desktop updates)."
  - One installer covers x64 and ia32.
  - It is unsigned, so expect Windows SmartScreen ("More info › Run anyway").
  - There is no in-product download page. Where technicians fetch the `.exe` is unsure.
- **Installer:**
  - NSIS, per-machine, so it **needs administrator rights** (UAC).
  - The install folder can be changed. It makes desktop and Start-menu shortcuts.
  - It adds firewall rules on the private profile: "SwiftPOS Branch Server" (TCP 4100-4103) and "ZapTill Server Discovery" (UDP 4199).
  - It registers the scheduled tasks "ZapTill start at sign-in" (A513/A541/A546: 45 s after Windows sign-in; a branch server starts in the tray, a till installs a waiting update and exits) and **"ZapTill Updater"** (A509: SYSTEM, installs approved updates without a Windows prompt).
  - If the updater task fails, the install log says "Could not register the updater task (exit $0). Updates install when ZapTill is closed, with Windows' prompt."
- **Updates are per client.** Admin portal › client › "Desktop updates" › "Choose a version…" › "Approve" (super admin). Until then: "Held — tills stay on the version they run."

### Before going to site

The technician needs:
- the **Business ID**, from admin › client header, or the "Client created!" panel;
- a **branch with a desktop licence** (step 2);
- an **enrolment code** for that branch: admin › "Branches & tills" › "Enrol till". It asks "How many tills for {branch}? (1–20)".
  - The panel shows "Enrolment codes (n) — {branch}", then "Single-use. Expire {HH:MM:SS}. Give each till the Business ID + one code.", the "Business ID" and "Code 1…n" rows with "Copy", and "Dismiss".
  - Codes are 10 characters from ABCDEFGHJKMNPQRSTUVWXYZ23456789, single-use, tied to that branch, and **expire after 15 minutes**. Mint them on site.
  - Without the licence: "Could not issue an enrolment code — {branch}: Assign a desktop licence to this branch before enrolling a till."

### First run on the till (InstallPage)

The header reads "ZapTill / Device setup · step {1|2|3} of 3".

1. **Search.** "Looking for the branch server on this network…" then "This takes a few seconds."
   - Found servers are listed as "{business}" / "{server} · {ip}", with "Choose the server to join. Someone at that server is asked to allow it." For an extra till, see step 8.
   - Nothing found: "No branch server answered on this network." / "Check the server is on and ZapTill is running there, and that both computers' Windows network is set to Private." With the link "Server not found? Enter its address".
   - Buttons: "Search again" and **"Set up without a server"**. Use the second for the first or only till, or for the branch server itself.
2. **Server address.** Field "Server address" (placeholder `https://api.zaptill.co.ke`), then "Test connection".
   - Success: "Connected — ZapTill server responded."
   - The button reads "Test connection first", then "Continue".
   - Errors:
     - "Server URL must start with http:// or https://"
     - "Something answered but it is not the ZapTill server (HTTP 404). Check the address is the base URL only — no /health or other path on the end."
     - "Couldn't reach server: {err}."
     - Port 4100 typed here: "That looks like a branch server address. Port 4100 relays sales between tills — it cannot sign anyone in. Put the hosted server URL here (https://…), and the branch server address at step 3."
3. **Activate.** "Activate this device": "Enter the business ID and the one-time enrolment code from the owner portal. Requires internet for this step only."
   - Fields "Business ID" ("e.g. 3f9a…") and "Enrolment code" ("ABCD23WXYZ", turned to capitals).
   - Buttons "Back" and "Activate".
   - Behind: `POST /api/auth/enrol/redeem`. It uses up the code, adds the till as an approved device with its own secret and session, caches the branch reveal code, and runs a full sync.
4. **Bind.** The banner reads "Activated for {business}".
   - "Branch" is locked to the code's branch: "Set by the enrolment code — this device belongs to this branch. All its sales belong here."
   - **"Device role":** "Till" (A point of sale terminal) / "Branch server" (Other tills sync to this one) / "Office" (Branch server that cannot sell — reports and day close only).
   - **"Terminal code"** (placeholder "T1", up to 4 letters or digits): "Prefixes every bill number from this till, e.g. T1--1042. Each till at this branch must have a different code — T1, T2, T3 — or their bill numbers will collide." If the code is taken, a "Use {suggestion}" button appears.
   - "Branch server" (for a till): "None — this till works on its own. To join the branch server, find it on this network and press Allow there.", with "Find my server" and "Network: put the branch server and its tills on a wired or separate network — not the customer Wi-Fi."
   - "Business type" is read-only.
   - "Device name (optional)" ("Front till 1").
   - Press **"Complete setup"**: "After setup this screen locks. Changing it again requires a technician."
5. The till opens on the **PIN screen** (step 10).

### Device approval

There is **no "approval pending" screen for a desktop till**. Redeeming the code approves it.
- The dashboard's Settings › Devices and printers › "Devices" ("Require device registration", "Approve" / "Reject") is for **cashiers signing in to the web POS from a new browser**, not for tills.
  - Its text: "When enabled, cashiers logging in from a new device will be blocked until you approve the device here. Managers, supervisors, and the owner are never restricted — only cashier-level roles require approval."
  - The message: "This device is not yet approved. Please ask your manager to approve it in Settings → Devices."
- After the first sign-in the till appears in dashboard › Devices and printers › **"Terminals"**, and in admin › Desktop updates › "TILLS NOW".
  - Seen locally in the terminals list: "Counter · Ngong Road · v1.0.19 · Up to date".

**Gotchas:**
- The code expired (15 minutes) or was already used: "Invalid, expired or already-used code". The till shows "The server did not accept that enrolment. Check the business ID, the enrolment code, and the server address."
- Empty fields: "Enter the business ID and the enrolment code".
- Branch step: "Select the branch this device belongs to" and "Terminal code must be 1–4 letters or digits, e.g. T1".
- A till enrolled earlier that lost its link: "This till is already joined to its business. A technician rejoins it from the technician console." Use Tech › "Rejoin this till" (step 11).
- **The search lists every branch server on the network.** The local run found another business's server on the office LAN. Check the business name and server name before choosing.

**Screenshots:**
- `07a-admin-enrol-till-count.png`: "How many tills for Ngong Road? (1–20)"
- `07b-admin-enrolment-codes.png`: the Business ID and two single-use codes, with the expiry time
- `07c-till-setup-find-server.png`: step 1, a branch server found (the demo result)
- `07c2-till-setup-no-server-found.png`: "No branch server answered on this network."
- `07d-till-setup-server-address.png`: the server address and "Connected — ZapTill server responded."
- `07e-till-setup-activate.png`: "Activate this device", with the Business ID and enrolment code
- `07f-till-setup-branch-role.png`: step 3 (Branch, Device role Till, Terminal code T1, Device name Counter)
- `07h-dashboard-terminals.png`: dashboard Terminals after the till signed in

---

## Step 8. Branch server and extra tills on the shop network

**The design:**
- One branch server per branch: the "Branch server" role, or "Office" for a server that cannot sell.
- The other tills join through it, and from then on every cloud request goes through it (A410, `<node_url>/node/cloud/api/…`). If the server has no internet, the tills queue their sales.
- Approve updates for the server first.

**Setting up the server:**
- In step 3 of setup, pick "Branch server" (or "Office") and use its own enrolment code.
- It shows **"Branch access code"** (e.g. `XXXX-XXXX-XXXX-XXXX`): "Keep a note of it for support. The tills do not type it: each one finds this server (Find my server) and someone here presses Allow — the code goes to the till with that answer."
- It shows **"Keep the branch server running"**:
  1. Windows signs in by itself (netplwiz: untick "Users must enter a user name and password").
  2. Settings › System › Power: "When plugged in, put my device to sleep after" — Never.
  3. "Leave ZapTill open. Closing its window keeps it running by the clock; it starts with Windows and starts itself again within 5 minutes if it stops."

**Joining an extra till:**
1. On the new till: setup step 1 (or EnrolPage "Find the branch server", or Tech › "Find my server") › choose the server.
2. The till shows **"Now go to the branch server and press Allow"**:
   - "1. Go to "{server}" ({ip}), {business}."
   - "2. On its screen: "A till wants to join this branch server" — with this till's name, "{name}". If ZapTill is hidden, click its icon by the clock, or the notification."
   - "3. Press Allow. This till carries on by itself once it is allowed."
   - "Security code {code} — the server shows the same code. If it shows a different one, press Deny there."
   - "The request waits {n} more minutes." The request lasts 10 minutes.
3. On the server, over every screen: **"A till wants to join this branch server"**, "{name} at {ip}", "Allow it only if it is a till you are setting up in this shop. It joins this branch and syncs through this server.", the security code, and **"Deny" / "Allow"**.
4. "Allow" fetches a one-time code from the cloud, so the server needs internet at that moment. No enrolment code is typed on the extra till.

**Ports and the firewall:**
- TCP **4100** (it falls back to 4101-4103) and UDP **4199** for discovery. The installer adds both rules, private profile only.
- **Both PCs' Windows network must be set to "Private".**
- If 4100 is busy, the server waits about 20 s, then moves to 4101-4103. This shows **only in the log**, never on screen:
  - "[node] port 4100 in use — trying it again for 20 s (a ZapTill still closing?) before another"
  - "[node] listening on :{p} — NOT the default 4100. Other tills must use this port in their branch server address."
- **A554, one copy:** a second launch of ZapTill only brings the running window forward. Before A554, two copies were the usual cause of "port in use". To check: double-click ZapTill while the server runs in the tray. Its window comes up, and Task Manager shows no second ZapTill.

**What a technician checks:** on the till's Tech page,
- "Shop network": "Encrypted · security code {c}"
- "Branch sync": Reachable, Send records, Receive records, Instructions, Staff list, Menu & prices, Cloud via server, Encryption
- On the server: "Tills on this server", "Distribution to the cloud" ("Nothing waits — every record on this server is on the cloud.")

**Errors:**
- "No branch server answered on this network. Check the server computer is on, ZapTill is running there, and both are on the same network."
- "Could not reach that branch server. Check this till is on the same network."
- "This till is already joined to this branch server. To join it again, revoke it at the server first (Close Branch → Show tills → Revoke this till), then join it from here."
- "The server needs the internet to add a till — check the connection and press Allow again."
- "The server did not allow this till to join."
- "The request ran out — ask again."
- "Too many tills are waiting to join — answer them on the server first."
- Promoting a till while the old server still answers: "The current branch server at {url} is still reachable. Promoting now would put TWO servers on this branch (split-brain). Demote or disconnect it first, then promote."

**Screenshots:**
- `08a-till-setup-branch-server-role.png`: setup step 3 with "Branch server" picked (Branch access code and Keep the branch server running). Real app; setup was not completed.
- `08b-till-join-wait-press-allow.png`: a new till waiting, "Now go to the branch server and press Allow" (stub)
- `08c-server-join-prompt-allow.png`: the server's "A till wants to join this branch server" with Deny / Allow (stub)

---

## Step 9. Printers and stations

### On the web: which categories print where

**Where:** dashboard › Settings › Devices and printers › "Print stations".
- "A station is a job — the grill, the bar, the packing bench. Point menu categories at it here, then bind a printer to it on each till under Manager → Printers. The printer is per terminal; the station is shared."
- Fields "New station" and "Type": Kitchen ("Prints only what is cooked. No prices."), Dispatch ("Prints everything that goes in the bag, including drinks. No prices.") or Receipt ("Prints the customer receipt and opens the cash drawer."). Then "Add".
- Click the category chips on each station. "A receipt station prints the whole bill, so it is not routed by category."
- With no stations: "No stations yet. Until one exists, tills fall back to the built-in Kitchen / Dispatch / Till stations and keep printing as they do today."
- Demo: "Kitchen" (Grill, Mains, Sides), "Packing" (all four, Dispatch) and "Till" (Receipt).
- The other "Printers" tab on the web (Customer Receipt / Master KOT / Dispatcher, "Print method") is for the browser / web POS only.

### On the till: which printer each station uses

**Where:** till › Manager › Settings › **"Printing"**. The tabs are "Stations", "Printers", "Exclusions" and "Receipt". The old `PrintersTab.tsx` is not used.
- **Stations tab:** "Stations": "Where each category prints. Shared by every till — the printer for each station is set per terminal below." Each station shows its categories and "· no printer on this till".
- **Printers tab, "Stations on this terminal":**
  - Master switch **"Print through these printers"**. It is **off by default: "OFF — nothing will print. Turn this on before trading."** On: "On. Sales on this terminal print here."
  - Pick a station on the left, then under "Printer":
    - **USB or any Windows printer:** the list "Pick a printer on this machine…".
    - **Network printer:** type its IP in "or a network printer's IP, e.g. 192.168.1.50". Port 9100 is assumed; "IP:port" also works. Help: "Pick from the list above for anything plugged into this machine — it needs no sharing. This field is for everything else: a network printer's IP address, a shared printer as \\localhost\Name, or Linux /dev/usb/lp0. Leave blank so this station does not print here."
  - **"Paper width": "80mm" / "58mm"**: "Must match the roll physically loaded. A mismatch is the commonest cause of a receipt whose right-hand column wraps."
  - **"Test print".** Success: "Printed {bytes} bytes in {ms}ms." There is a preview: "Preview — exactly what this printer will produce".
  - The footer reads "{n} stations have no printer on this terminal and will not print here. That is normal if another terminal handles them."
- **Receipt tab:** "Header — printed under the business name", "Footer — printed at the bottom", "Save receipt text". "This applies to every till at the business, not just this one."

**What prints where** (A551, A557, A559):
- **Kitchen ticket:** only kitchen items. Font A by default (Font B only with `kitchen_font_b`). Dish names bold at normal size. A variant goes on the item's own line. From A559, extras print as "+ Extra Cheese" under the dish, along with notes.
- **Dispatch (packing):** everything on the order, the same format.
- **Receipt:** the customer copy. The "BUY GOODS:" / "PAYBILL:" number prints centred, bold and double height. The receipt station opens the cash drawer.
- Kitchen exclusions are set on the web and are read-only on the till.

**Kitchen display (KDS)** (owner only): dashboard › Devices and printers › "Kitchen display".
- "Kitchen display (KDS)": "Generate a token for a kitchen screen, then open /kds on that screen and paste it once. The token is branch-scoped — it can only read and advance that branch's tickets. Owners only."
- "Branch" › "Generate token" › "Copy token".
- **Gotcha:** the page says "Generating again does not revoke an earlier token", but the server does revoke it (A495). An older screen then shows "This kitchen display token was replaced — set the display up again".
- Non-owners get "Could not generate a token (owners only)."

**Errors, seen locally:**
- Test print to an address where nothing answers: "timed out after 8000ms connecting to 192.0.2.50:9100", followed by **"Looks like the printer is off or unreachable. Check power and cable."**
- Other hints:
  - "The address itself looks wrong. Check the spelling."
  - "Windows took too long to accept the job. Press Test print again (the first print after starting is the slowest); if it keeps happening, open the printer's queue in Windows (Settings → Printers & scanners → the printer → Open print queue), cancel stuck jobs and make sure it is not paused or offline."
  - "This is a fault in ZapTill, not your printer or the address. Report it with this message."
- Windows codes are translated: 1801 "the spooler does not recognise that printer name"; 1722 "the print spooler service is not running".
- On the POS, "🍳 Send to kitchen" is disabled with the tooltip "Kitchen printing disabled in printer settings", and after a sale: "The sale is saved, but this did not print: {x}. Check the printer — a manager can reprint it from History."

**Screenshots:**
- `09a-dashboard-print-stations.png`: web Print stations (Kitchen, Packing, Till, with category chips)
- `09b-till-printing-stations.png`: till Printing › Stations
- `09c-till-printers-off.png`: till Printing › Printers with the master switch OFF ("OFF — nothing will print…")
- `09d-till-receipt-printer-usb.png`: the Till (receipt) station on a USB/Windows printer (demo printer name)
- `09e-till-kitchen-network-test-print.png`: Kitchen on network IP 192.0.2.50, 80mm, and the Test print timeout with its hint
- `09f-till-receipt-tab.png`: Printing › Receipt (header and footer)
- `09g-dashboard-kitchen-display.png`: dashboard Kitchen display (KDS token)

---

## Step 10. The test run with the client

Done for real on the local stack, in this order.

1. **PIN sign-in** (`DT/pages/PinPage.tsx`).
   - The screen shows "{Business}", "Branch: {name}", "Enter your PIN" / "to start a shift", keys 0-9, "Clear", "⌫" and "Enter".
   - Errors:
     - "PIN must be 4–6 digits"
     - "That PIN was not recognised. Please try again."
     - Lockout: "Too many wrong PINs on this till. Try again in {when}."
2. **Opening float** (a cashier with no shift).
   - "Open your drawer": "{cashier} — count the cash in the drawer before you start.", "Till T1", "Opening float (KES)".
   - Help: "What is physically in the drawer now — not what it should be."
   - Button "Start selling" (or "Not you? Sign out").
   - Without a figure: "Count the cash in the drawer and enter it. Enter 0 if the drawer is empty."
3. **Selling screen.**
   - A restaurant opens on **"Tables"**. With no tables: "No tables synced yet. Configure them in the dashboard under Setup → Restaurant Setup, then hit Sync in the top bar."
   - Press **"🥡 Takeaway"** for the product grid.
   - The top bar shows "Synced", "Shift open", "held", "History", 🖨, "← Manager" (back office only), "? Help" and "Sign out".
4. **A variant and an extra.** Tap "Chicken Burger" and the picker opens ("Customise your order").
   - "Spice level" shows "Required"; options show "Included" or "+KES n".
   - "Extras" shows "Optional", e.g. "+KES 50".
   - "Item total", then "Add to order".
   - The cart line reads "Spice level: Spicy" and "+Extra Cheese". Chips Masala asked for "Portion" (Regular/Large).
   - The cart shows "🍳 Send to kitchen (3)", "⏸ Hold order", "+ Note", "+ Note for the order" and "Charge KES 1,250".
5. **Kitchen ticket.** "🍳 Send to kitchen" prints the kitchen and dispatch tickets. Success: "Sent {n} item(s) to kitchen".
   - **Not printed locally:** there was no thermal printer, and printing was off.
   - With "Print through these printers" off, the button is disabled.
6. **Split payment.** Press **"Charge KES {total}"** (there is no "Pay" button) to open "Payment".
   - It shows "Total due", "▸ Discount / tip" and the method buttons.
   - On the first leg, pick Cash and fill "Amount" and "Tendered".
   - Press **"+ Split payment"**. The new leg is M-Pesa, with "Amount" and "Reference (optional)".
   - Press **"Charge KES 1,250"**.
   - Result: "Payment successful", bill "T1--2", with Bill / Paid / Cash / M-Pesa / Change, then "New order".
   - Errors: "Payments must add up to {cur} {n}" and "Cash tendered is less than the cash amount due".
7. **Sale on account** (A552).
   - Pick "📒 On account" and type in "Customer name or phone". Choose the customer.
   - The panel shows "On the customer's account", "Credit limit" / "Owed now" / "Left to use", and **"Manager's PIN — approves this sale on account"**.
   - Press "Charge". Result: "Payment successful" with "Credit KES 1,250.00".
   - **Gotcha, seen locally:** on a till with **no branch server**, the approving manager must have **signed in on this same till at least once** first. Before Brian had signed in on T1, his PIN gave: "That PIN was not recognised. Enter the PIN of a manager (or the owner) on duty." After one sign-in it worked.
   - Other refusals:
     - "{name} has no credit limit."
     - "Over {name}'s credit limit."
     - "Someone else must approve this — enter the PIN of another manager (or the owner)."
     - "This till does not take sales on account."
8. **Void with approval.**
   - A cashier has no void button. Sign in as a Supervisor or Manager, press **"Open POS"**, then "History".
   - "Order History" lists the rows with "Reprint" and **"Void / Refund"**. After the void window (default 30 min) the button is "Refund".
   - The **"Void Order"** panel shows "Paid — manager PIN needed", then "Void · cancels the sale" / "Refund · money back".
   - "Reason for void": Customer changed mind / Wrong items ordered / Duplicate order / Test order / Other.
   - "Manager PIN" ("Manager or owner PIN"): "The PIN of the manager approving this — recorded with the sale."
   - Press **"Confirm Void"**.
   - Errors:
     - "A reason is required"
     - "A manager PIN is required for paid orders"
     - "This order is {n} minutes old, past the {window} void window. Refund it instead."
9. **End of shift**, by the cashier: press the "Shift open" pill to open "Current shift" › "Close shift".
   - "Counted cash in drawer (KES) — include the opening float"
   - "{Method} total (KES)", one per other method (here "M-Pesa total (KES)")
   - "Count the drawer and enter each method's total. A manager checks them." This is the blind close.
   - Press "Close shift". It shows "Closing…" for several seconds while it tries to print the slip.
   - Message: "Shift closed — your count is saved and your slip printed. A manager checks it."
10. **Day close**, by a manager: Manager › "Close" › "Close Day".
    - "Close the day", "Trading date {d} on this till."
    - "{n} shift awaits a manager's check" › "Confirm" opens "Confirm {cashier}'s shift": "Manager: count every payment method — the drawer, the M-Pesa statement, the card machine's total…". It has a table of Method / Expected / Cashier / Manager (KES) / Variance, showing "balanced" or over/short, then "Confirm shift".
    - Then "Cash you counted" › "Show expected cash (count first)" › "Notes" › **"Count verified — close the day"**.
    - Result: "Day closed", with Trading date / Counted / Expected / Variance.
    - Until each shift is confirmed: "Confirm every shift above before closing the day."
11. **Branch close** (on a branch server only): Manager › Close › "Close Branch".
    - "Close the branch", "The day's totals — all tills" (Method / Sales / Expected / Confirmed / Variance: "balanced" / "short {x}" / "over {x}"), "Show tills (n)".
    - The tick box "I have checked the day's totals by payment method above — {x} confirmed — and they are the day's takings.", then **"Close branch"**.
    - On a plain till: "Close Branch lives on the branch server."
12. **Check the dashboard.**
    - Overview shows the sales.
    - "Tills & Days" shows "T1 — Counter · v1.0.19 · last synced … · No open trading day."
    - Customers › Credit Accounts.
    - Orders.
13. **Daily email:** dashboard › Settings › Business › "Integrations" › **"Daily Report Email"**.
    - "Send time (EAT)", "Recipients" ("owner@example.com"), "What the daily email includes", "Alerts as they happen".
    - The job `apps/server/src/jobs/dailySummary.ts` runs every 15 minutes and sends once a day at or after the send time (default 21:00 EAT), only if the scheduler is enabled.
    - It goes to the owner, staff with `reports.overview` who have an email, and the added recipients.
    - Subject: "📊 Daily summary — {business} · {d MMM}".
    - **Not waited for locally.**

**Gotcha: idle lock.** The till locks ("Till locked / Enter {name}'s PIN to continue / Nothing was lost — the screen is exactly as you left it.") from **Windows' own idle time** (`powerMonitor.getSystemIdleTime`). On a PC nobody has touched for a while, it locked straight after sign-in.

**Screenshots:**
- `10a-till-pin-sign-in.png`: the PIN screen, with digits entered
- `10b-till-opening-float.png`: "Open your drawer", opening float 2000
- `10c-till-pos-screen.png`: the selling screen (Tables view, "Shift open")
- `10d-till-product-grid.png`: the product grid (Takeaway)
- `10e-till-variant-and-extra.png`: the Chicken Burger picker (Spicy + Extra Cheese)
- `10f-till-cart.png`: the cart, with the variant and extra lines, "Send to kitchen (3)" and "Charge KES 1,250"
- `10g-till-payment.png`: the Payment dialog
- `10h-till-split-cash-mpesa.png`: Cash 500 + M-Pesa with a reference
- `10i-till-payment-successful.png`: "Payment successful" T1--2
- `10j-till-sale-on-account.png`: On account, Kamau Hardware, with limit, owed, left and the manager PIN
- `10l-till-history.png`: Order History (cashier view)
- `10m-till-void-with-manager-pin.png`: Void Order (reason, Manager PIN, Confirm Void)
- `10n-till-close-shift.png`: the cashier's blind close (counted cash, M-Pesa total)
- `10p-till-close-day-confirm-shifts.png`: Close Day, with a shift awaiting a manager's check
- `10q-till-confirm-shift-modal.png`: "Confirm Wanjiru Kamau's shift" (balanced)
- `10r-till-close-day.png`: Close Day, the count filled in
- `10s-till-day-closed.png`: "Day closed" (Counted, Expected, Variance KES 0.00)
- `10y-server-close-branch.png`: Close Branch on a branch server (stub data: cash short KES 350)
- `10z-till-manager-overview.png`: the till Manager overview after the sales
- `10t-dashboard-overview-after-test.png`: the dashboard Overview after the test
- `10u-dashboard-tills-days.png`: Tills & days
- `10v-dashboard-credit-sales-to-confirm.png`: Credit Accounts after the test (the on-account sale was voided in the void test, so owed is 0)
- `10w-dashboard-orders.png`: Orders
- `10x-dashboard-daily-report-email.png`: Integrations › Daily Report Email

---

## Step 11. Technician access

### Getting a token

**Where:** admin portal › sidebar "Tech access" › **"Generate Tech Access Token"**: "48h offline token. Tech enters this on the client machine — no internet required on site."
1. Pick "Client", then "Branch", then press "Generate Token".
2. The result shows "TOKEN — share securely with tech. Shown once only.", then **"Reveal code — the tech enters this FIRST on the till."** with the code (e.g. `B99CBSUQ`), "Copy" and "Rotate".
3. Then the `st2.…` token, "Valid for {branch} until {date}", and "Copy token".

More on tokens and codes:
- Tokens appear under "access request(s) awaiting confirmation". A **different** super admin confirms them with "✓ Confirm" or "Revoke". Your own token shows "Another admin confirms". (The till accepted the unconfirmed token locally; see the unsure list.)
- **"Rotate"**: "Rotate this branch's reveal code? The current code stops working immediately; tills refresh the new one on their next online sync. Do this when a tech's access should end."
- **Where the reveal code lives:**
  - It is stored per branch in `branches.tech_reveal_code`, created the first time it is asked for.
  - Tills fetch it from `GET /api/tech/branch-config/:branchId` when they join and at every sync.
  - It cannot be set by hand.
  - **A547 is not about this.** A547 is kitchen-ticket and receipt leftovers. The reveal-code history is D18 / A114 / G3 / A494 / A495.

### Opening the Tech page on the till

1. On the PIN screen, **press and hold the logo or business name for about a second** (800 ms).
2. "Technician access" / "Enter the branch access code.": type the reveal code into "ACCESS CODE", then "Continue". A wrong code gives "Incorrect code".
3. "Technician token" / "Paste the access token issued for this branch.": paste `st2.…`, then "Unlock".
   - Errors: "Invalid or expired token", "This token is for a different branch", "This token is for a different business".

### What the Tech page shows

Headed "Technician mode", "{tech} · session ends in 3h 59m", with "End session".
- **"Device":** Device ID, Name, Role, Branch, Mode, Server, Build.
- **"Sync":**
  - Pending / Failed / Online, with "Force sync" and "Retry failed".
  - "Changes: as they happen (push)", "Push line: connected since …", and the menu/staff/money/look/setup/stock lines.
  - "Whole catalogue: …"
- **"Rejoin this till":** "Business ID", "Enrolment code", "Rejoin this till". "Nothing on the till is cleared."
- **"Diagnostics":** "Scan printers", "Test connection", "View log", **"Send logs to support"**.
- **"Branch role":** "This machine: till", "Promote to branch server", "Find my server".
- **"Updates":**
  - "Up to date.", "Approved for this business: …" or "Not checked yet."
  - "Updater task: installed — updates install without a Windows prompt." or "Updater task: not installed — … Run the ZapTill installer once as administrator…"
  - "Graphics acceleration" Auto/On/Off, and "Show update log".
- **"Backups & retention":** "Back up now", "Choose backup folder…". With the default folder it warns "These backups are on the same disk as the database — a failed disk or a stolen PC loses both. Choose a USB drive or a second disk below."
- **"Database (read-only)":** "Run query".
- **"Client branding".**
- **"Reset this device":** "Check what this would delete".
- Footer: "All actions in this session are recorded against {tech} for this branch."

### Logs: sent from the till versus pulled from the admin portal (A533)

- **Sent from the till:** Tech › "Send logs to support" sends the last 24 hours with secrets removed.
  - Locally it showed **"Sent — reference DZG52F"**. The client reads this reference to support.
  - Limited to 5 an hour. Failures:
    - "This till cannot reach the cloud right now. Save the log to a file instead, and send it another way."
    - "Five logs were sent from this till in the last hour — wait a little, or save the log to a file."
  - On failure, "Save log to file" appears.
- **Pulled from the admin portal:** client › "Desktop updates" › **"Pull logs"**: "Ask a till or the branch server to send its log — no one at the shop needs to press anything. Secrets are removed on the till."
  1. "Choose a till or server…" (e.g. "Counter (T1) · v1.0.19 · till · Ngong Road · seen 13:20").
  2. Choose "24 hours" / "3 days" / "7 days".
  3. Optionally tick "Include sign-in history".
  4. Fill the reason, "Why (kept with the request and in the admin log)".
  5. Press "Request".
  - The row shows "Waiting", then **"Delivered"** with a reference, "View" and "Download".
  - Locally the running till answered within about two minutes (reference V78DDU), even though the portal warned "This till runs 1.0.19 — it can only send logs from its Tech page from 1.0.18, and answer a pull from 1.0.20. The request may wait until it updates (kept 7 days)." That warning comes from the version the dev build reports.
- **"Support logs"** (same tab): "Reference, e.g. K7Q2XM", then "Find" and "All". Rows have "View" and "Download".

### Desktop updates (A534, A541)

- "Approved: {v}…" or "Held — tills stay on the version they run."
- "Choose a version…" › "Approve" / "Hold" (super admin).
- **"TILLS NOW"** gives one line per till, e.g.:
  - "Up to date"
  - "Downloading {v} ({p}%)"
  - "Downloaded — installs when ZapTill is next closed…"
  - "Downloaded {v} — can't install silently on this PC (no ZapTill Updater task): run the installer once as administrator, or it installs the next time ZapTill is opened (Windows will ask)"
  - "Waiting for the branch server's copy of {v}…"
- There is no update "channel" setting. The only markers are "(pre-release)" or "(draft)" on each version.

**Remote help:** there is no remote-desktop feature. Remote work is:
- the log pull;
- "Tills & days" in the admin portal (close a day or a drawer remotely, with a reason; the owner is emailed);
- the sign-in fixes in the admin portal ("Reset password", "Reset to email code");
- the read-only views.

**Screenshots:**
- `11a-admin-tech-access-token.png`: Tech access with the token, reveal code and "Another admin confirms"
- `11b-till-technician-reveal-code.png`: the till's "Technician access", with the reveal code typed
- `11c-till-technician-token.png`: "Technician token", with the token pasted
- `11d-till-tech-page.png`: the top of the Tech page
- `11e-till-tech-page-full.png`: the whole Tech page (its backup folder line shows the test PC's scratch path)
- `11f-till-send-logs.png`: "Send logs to support", "Sent — reference DZG52F"
- `11g-admin-pull-logs-request.png`: Desktop updates, with TILLS NOW, Pull logs (a waiting request and the version warning) and the Support logs list showing DZG52F
- `11h-admin-pull-logs-delivered.png`: the pull request "Delivered" (V78DDU)

---

## Step 12. Handover checklist and common problems

### Handover checklist

1. Admin portal:
   - Web access on, with the expiry date set.
   - The branch desktop-licensed.
   - Analytics and the receipt options as sold.
   - The sign-in address, if any.
   - A desktop version approved.
2. Owner:
   - Signed in on the dashboard and set their own password.
   - Sign-in codes chosen.
3. Business profile:
   - Address, KRA PIN, receipt header and footer.
   - "Business day ends at" matches the closing time.
4. Menu uploaded, with **costs** set (or recipes), variants and extras checked, and menus making sense on the POS.
5. Staff:
   - Each person has their own PIN; no two the same.
   - Managers have signed in once on each till (see step 10, credit sales).
   - Web access given to partners and accountants.
6. Payments:
   - The methods the shop takes are switched on.
   - The M-Pesa number is set **on each branch's till**.
   - Credit customers' limits are set (see the gap in step 6).
7. Every till:
   - Correct branch, unique terminal code, device name.
   - "Updater task: installed" shown on Tech › Updates.
8. Printers:
   - "Print through these printers" ON.
   - Every station has a printer, or another till handles it.
   - Paper width matches the roll.
   - Test print OK for each.
   - The drawer opens on a cash sale.
9. Branch server, if any:
   - Keep-running settings done.
   - Every till joined ("Encrypted").
   - Close Branch visible on it.
10. Test run done (step 10). Then clear the test sales: admin › "Owner & account" › "Clear test data…".
    - Set "Testing started" and "Testing stopped", choose stock "Put back as before testing", press "Show what will be removed".
    - Type the client's name to confirm, then press "Clear test data".
    - Super admin only. The menu stays unless "Also delete the whole menu" is ticked.
11. Daily Report Email: enabled, with recipients and a send time.

### Common problems

| What the technician sees | Where | Meaning | Fix |
|---|---|---|---|
| "This branch has no desktop licence. Contact ZapTill to activate it." / "(no desktop licence)" | Till PIN screen | The branch is not licensed | Admin › Branches & tills › "Activate licence" (super admin) |
| "Invalid, expired or already-used code"; on the till "The server did not accept that enrolment. Check the business ID, the enrolment code, and the server address." | Till setup | The code is older than 15 minutes, already used, or for another business | Mint a new code: "Enrol till" |
| "That code is for a different branch. Rejoin needs a code for this till's own branch." | Tech › Rejoin | Wrong branch's code | Use a code from the till's own branch |
| "This till is no longer joined to the business. A technician can rejoin it." | Till | The till was revoked or lost its link | Tech › "Rejoin this till" with a new code |
| "This device is not yet approved. Please ask your manager to approve it in Settings → Devices." | Web POS, cashiers only | "Require device registration" is on | Dashboard › Devices › "Approve". Tills never need this. |
| "OFF — nothing will print. Turn this on before trading." | Till › Printing › Printers | Master switch off (the default) | Tick "Print through these printers" |
| "timed out after 8000ms connecting to {ip}:9100", then "Looks like the printer is off or unreachable. Check power and cable." | Test print | Network printer off, wrong IP, or on another subnet | Check power, cable and IP; print the printer's self-test page for its IP |
| "the spooler does not recognise that printer name" / "the print spooler service is not running" | Test print (USB) | Windows printer name changed, or the spooler is stopped | Pick the printer again from the list; restart the Print Spooler service |
| Receipt's right-hand column wraps | Paper | Paper width wrong | Set "Paper width" to the roll in use |
| "No branch server answered on this network. Check the server computer is on, ZapTill is running there, and both are on the same network." | Till search | Server off, not running, other network, or Public network profile | Turn the server on, set both PCs' network to Private, or use "Server not found? Enter its address" |
| "Could not reach that branch server. Check this till is on the same network." | Join | Network path or firewall | Check the firewall rules (TCP 4100-4103, UDP 4199) and the Private profile |
| "The server needs the internet to add a till — check the connection and press Allow again." | Server | Allow needs the cloud | Restore the internet, press Allow again |
| Port 4100 in use: nothing on screen, only the log line "[node] listening on :{p} — NOT the default 4100…" | Server log (Tech › View log) | Another program holds 4100 | Close the other program. If the server moved, give tills that port; a till that has seen the server follows it by itself. |
| "That PIN was not recognised. Enter the PIN of a manager (or the owner) on duty." | Till, sale on account | Approver's PIN unknown to this till (never signed in here) or lacks `customers.credit` | Have the manager sign in once on this till, or use a branch server |
| A cashier sees no "Void" button | Till History | Cashiers do not void | A supervisor or manager signs in › "Open POS" › History › "Void / Refund" |
| Owner: "Web portal access is not enabled for your account. Please contact ZapTill to upgrade." | Dashboard login | Web access off | Admin › Plan & billing › "Enable web access" |
| "Your web portal subscription has expired. Please renew to continue." | Dashboard login | More than 28 days past the web access expiry | Renew: set a new expiry |
| Sign-in code not arriving / "Could not email your sign-in code. Try again in a minute, or call ZapTill support." | Dashboard / admin login | Email provider issue, spam folder, or 45 s resend limit | Check spam, wait 45 s, "Send a new code"; switch to an authenticator app; admin "Reset to email code" |
| "That code has expired or was tried too often. Send a new code." | Login | 10 minutes or 5 tries used | "Send a new code" |
| "Trading day {date} was never closed on this till. A manager must count the cash and close it before {today} can start…" | Till, cannot sell | Yesterday's day still open | A manager: Manager › Close › Close Day; or remotely in dashboard or admin "Tills & days" |
| "This till's clock is {n} min ahead of/behind the server — set it right; the server's time counts." | Close Branch | Windows clock wrong; the till's business date comes from its own clock | Fix the Windows time and time zone (Nairobi), turn on automatic time |
| Late-night sales land on the wrong day | Reports | Day cut-off left at midnight | Profile › "Business day ends at" (e.g. 02:00 or 04:00) |
| "Till locked" straight after sign-in | Till | The idle lock uses Windows idle time | Expected; the person enters their PIN |
| "This is part of the online licence — ask ZapTill to turn it on for your business." | Till | Premium screen without the online licence | Admin: web access (online licence) |
| Pull logs stays "Waiting" with "…answer a pull from 1.0.20…" | Admin | Old till version, or the till is off | Use Tech › "Send logs to support" and get the reference; or update the till |

**Screenshot:**
- `12a-dashboard-devices-approval.png`: dashboard Devices ("Require device registration": for web POS cashiers, not tills)

---

## Facts I'm unsure about

1. **The forced password change.** On the local stack the owner was never sent to "Set your password". `auth.ts:828-840` clears `must_change_password` when the auth user's `updated_at` > `created_at`, and the server signs in just before that check. Check on the dev cloud whether production owners are ever forced to change the temporary password. This looks like a bug.
2. **The trial plan.** Whether a plan named "trial" exists in production. Locally there was none, so "Plan: None", although the form promises an automatic trial.
3. **The first credit limit.** No screen sets a customer's first credit limit. I set it through `PATCH /api/credit/customer/:id/limit`. The guide needs either a product fix or an agreed workaround. A552 says limits are set "only on the web (Customers › Credit)", but that page only lists customers who already have a limit.
4. **What "online licence" is.** Whether it is exactly web access (`web_hosting`). The till's `a.online` flag was not traced.
5. **Where technicians get the installer.** The `.exe` is a GitHub pre-release. Where technicians actually get it (GitHub, a shared drive or a page) is not in the code. It is also unconfirmed that the prod build pre-fills `https://api.zaptill.co.ke` in "Server address", or only shows it as the placeholder.
6. **Tech token confirmation.** Whether the till really refuses a token not yet confirmed by a second super admin. The locally generated token showed "Pending / Another admin confirms", yet the till accepted it.
7. **The tech session length.** Shown as 3h 59m after unlocking. The token's 48 hours is the admin text.
8. **Version-based log-pull warnings.** The dev build reports v1.0.19, so the portal's version warnings for log pulls may differ for a real 1.0.20 till. The pull was delivered anyway.
9. **Kitchen and dispatch tickets were not printed.** There was no thermal printer, and printing was off. The ticket layout claims (Font A, "+ Extra Cheese", centred BUY GOODS) come from A551/A557/A559 and `shared/printing`, not from paper.
10. **The daily email was not waited for.** Its timing (21:00 EAT default, every 15 minutes) comes from the code.
11. **Duplicate PINs.** The till refuses an ambiguous PIN (`pinCache.ts`). I did not check whether the dashboard stops two staff sharing a PIN at save time.
12. **Bulk image upload was not tried.** Cloudinary was disabled locally.
13. **The firewall prompt.** A second branch server and the firewall prompt were not run live. Steps 8b, 8c and Close Branch are stubbed.
14. **The bill number format.** It shows as "T1--2" (two dashes), as in the setup help text "T1--1042". The guide should show the same.
15. **Admin portal sign-in code for new admins.** Every admin got an emailed code on each fresh browser, so OTP is always on for admins. I did not confirm whether that can be switched off.

---

## 1.0.20 update (2026-10-23)

The guide was brought up to the 1.0.20 batch (version 1.1). What changed, and where each fact comes from:

| Guide | Feature | Source |
|---|---|---|
| Step 1 | Business type decides the wording (Menus / Departments / Groups) and the food-service screens | A573, `shared/businessTerms.ts` |
| Step 2 | Desktop licence first; the first licence starts a 30-day cloud trial (once per client, no invoice; none if web access was ever on); reports only for 7 days after it, then `CLOUD_TRIAL_ENDED`; Convert to paid / End trial; the owner's notice in the last 7 days | A569, `apps/server/src/lib/cloudTrial.ts`, `lib/webAccess.ts`, `apps/admin/src/cloudPlan.ts`, `apps/dashboard/src/lib/cloudTrialNotice.ts`, `LoginPage.tsx` |
| Step 2c, Step 5 | Approval PIN is the "Staff options" feature switch, off by default; old approval PINs keep working; the staff form shows the real role; the owner's role cannot be given | A562, `shared/posFeatures.ts`, `StaffTab.tsx` |
| Step 3 | Forced password change at the owner's first sign-in and after an admin reset; not after Forgot password; partners never | A568, `ForcePasswordChangePage.tsx`, `routes/auth.ts` |
| Step 3 | "When an item's stock reaches zero": Sell as normal (default) / Show as sold out / Hide | A563, `OwnerControls.tsx`, `lib/stockGate.ts` |
| Step 4 | Menus as top tabs on the till and web POS; Check other branches from the sale screen | A566 |
| Step 4 | Other branches' stock and transfer requests (inventory.view / inventory.transfer; online licence) | A564, `OtherBranchesPanel.tsx`, `managerNav.ts` |
| Step 4 | Barcodes and labels, pointing to `docs/Manuals/BARCODE-LABELS.html` | A571, A574 |
| Step 6 | + Give credit (`GiveCreditPicker`), the profile's Credit limit (`CreditLimitEditor`), New Customer's limit; `customers.credit` (owner, Manager, Supervisor, General Manager, Finance Manager by default); a till session refused; audit_log rows with who/when/before/after; no screen shows them | A567, `lib/creditLimit.ts`, migrations 134/140/142/159 |
| Step 7a | Download ZapTill (client's Desktop updates tab, and the menu); one-use 2-minute links; agents limited to latest/approved; audited; `DESKTOP_DOWNLOAD_BASE_URL` wins over `GITHUB_RELEASES_TOKEN` | A570, `DownloadZapTill.tsx`, `lib/installerSource.ts` |
| Step 7d | Server address is NOT pre-filled: `InstallPage.tsx` starts `serverUrl` empty and shows `https://api.zaptill.co.ke` only as the placeholder | code read |

**Facts above now settled:** 1 (forced password change: fixed by A568), 2 (trial plan: replaced by the A569 cloud trial), 3 (first credit limit: A567), 5 (installer: A570; the server address is a placeholder only).

**How the 1.0.20 screenshots were made.** Docker Desktop was not running on this PC, and starting it could have started the owner's other containers, so the local Supabase stack was not used this time. Instead:

- **Admin portal** (02g, 02h, 07a2): the real `apps/admin` vite dev server, pointed at a small mock API in the scratchpad that answers the admin routes with made-up data (Mama Lishe Grill, a made-up business ID, a made-up SHA-256). The licence activation was clicked through the real screens (the prompts, then the trial confirmation).
- **Dashboard** (03i, 03j, 03k, 06g, 06h): the real page components (`ForcePasswordChangePage`, `LoginPage`, `OwnerControls` › POS options, `CreditAccountsPage` with `GiveCreditPicker`) built by vite with the dashboard's Tailwind config, with `lib/api`, `lib/supabase` and the contexts stubbed; the forms were filled and submitted through the DOM. The trial-ended screen is the login page answering a stubbed `CLOUD_TRIAL_ENDED`.
- Captured with headless Edge over CDP. No production, no dev cloud, no real client data.
