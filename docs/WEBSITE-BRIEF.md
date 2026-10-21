# ZapTill website: brief and copy

Status: **planned, not being built yet** (2026-10-21). This file holds the structure, the wording and the technical plan, so
the build can start from it.

---

## 1. What the site is for

1. **To explain ZapTill in plain words** to a restaurant, café, bar, shop or petrol-station owner in Kenya.
2. **To turn interest into a conversation**, by WhatsApp or a demo request.
3. **To be the front door for existing clients**, with a clear **Sign in** button.

Addresses:

| Address | Shows |
|---|---|
| `zaptill.co.ke`, `www.zaptill.co.ke` | The website (new) |
| `app.zaptill.co.ke` | The dashboard sign-in, as today. Add a small "← zaptill.co.ke" link to the sign-in page |
| `<client>.zaptill.co.ke` | That client's own sign-in, unchanged |

Today `zaptill.co.ke` redirects to `app.zaptill.co.ke`. When the site goes live, that redirect is replaced by the site. The
dashboard is **never** redirected to the website, because people open it to sign in.

---

## 2. Who reads it, and what they worry about

| Reader | Their worry | What the site must say |
|---|---|---|
| Owner of a busy restaurant | "The system goes down when the internet does." | The till keeps selling with no internet and catches up by itself. |
| Owner who isn't on site | "I don't know what happens when I'm away." | Daily summary, voids and cash shortages by cashier, all visible from the phone. |
| Owner of several branches | "Each branch is a separate mess." | One dashboard, every branch, side by side. |
| Manager | "Closing the day takes an hour." | Day close in minutes, with drawers counted and differences shown. |
| Accountant or partner | "I need the numbers without the owner's password." | Their own login, with only what their role allows. |

Tone: warm, direct, Kenyan English. Short sentences, no jargon ("sync engine", "SaaS"). Say "your till", "your cashier",
"M-Pesa" and "KES". Talk about the owner's day, not our technology.

---

## 3. Pages

1. **Home**
2. **Features**: one section per area, each with a screenshot
3. **Who it's for**: restaurants, cafés and bars, quick service, retail, petrol stations (fuel and parking)
4. **Pricing**
5. **Request a demo**
6. **Contact**: WhatsApp, phone, location
7. **Sign in**: a button in the header, not a page; it goes to `app.zaptill.co.ke`
8. Privacy policy and terms, both needed for the demo form and for the WhatsApp Business account

---

## 4. Copy

### Home

**Hero**

> # The till that keeps selling, even when the internet doesn't.
> ZapTill runs your counter, your kitchen and your books — and shows you every branch from your phone.
>
> [ Chat with us on WhatsApp ]  [ Request a demo ]

Small line under the buttons: *Built in Kenya for Kenyan businesses. M-Pesa and KES, right out of the box.*

**Three promises** (icon + two lines each)

- **Never stops selling.** No internet? Your tills keep ringing up sales and printing receipts. Everything catches up the
  moment you're back online.
- **Know what's happening when you're not there.** A summary of the day lands on your phone each night: sales, payments,
  voids and who was short at close.
- **Every branch, one place.** Compare branches, move stock between them and close the day from wherever you are.

**How a day looks with ZapTill** (a short story, 4 steps with screenshots)

1. *Morning:* the cashier signs in with their PIN and the till opens with yesterday's float.
2. *Lunch rush:* orders go straight to the kitchen printer or screen, and M-Pesa, cash and card are taken in one tap.
3. *Evening:* the manager counts the drawer. ZapTill shows any difference before the day is closed.
4. *Night:* you get the day's numbers on your phone, wherever you are.

**Trust strip**: "Trusted by restaurants and shops across Kenya." Show client logos only with each client's written
permission. Until then, show a quote placeholder.

**Closing call to action**

> ### See it working in your own shop.
> We'll set it up, load your menu and train your team.
> [ Chat on WhatsApp ]  [ Request a demo ]

### Features

Each block has a heading, two or three sentences and a screenshot.

1. **Fast, simple selling.** Big buttons, your menu in categories, menus for breakfast, lunch and the bar. Split bills, hold
   a table's order, add notes for the kitchen.
2. **Kitchen that keeps up.** Orders print in the kitchen the moment they're placed, in a compact font that fits more on the
   ticket, or show on a kitchen screen.
3. **M-Pesa, cash and card.** Buy Goods and Paybill on every receipt. Split payments, change worked out for you.
4. **Works offline.** Each till keeps working on its own. With a branch server, all the tills in the shop stay in step even
   when the internet is down.
5. **Day close without the headache.** Count drawers, confirm shifts, see over and short by cashier, and close the
   branch with confidence.
6. **Stock and recipes.** Know what you have, what you used and what was wasted. Deliveries, transfers between branches,
   stock counts.
7. **Customer accounts (credit).** Sell on account, set limits, take repayments. Every credit sale is confirmed by a
   manager, so nothing slips through.
8. **Staff and roles.** PINs for cashiers. Ready-made roles for supervisors, waiters, storekeepers, accountants, general
   managers and more. Give your partner or accountant their own login without sharing yours.
9. **Your brand on everything.** Your logo and colours on the till, the receipt and each branch, with your address and
   socials in the receipt footer.
10. **Reports you'll actually read.** Sales by hour, item and cashier, tax, costs and a monthly pack for your accountant.
    Download to Excel.
11. **Analytics (Premium).** Which dishes make you money and which don't, when you're busy, where money is leaking, who
    owes you and for how long, all in plain sentences like *"Wings sell well but earn KES 40 less than average – consider
    a small price rise."*
12. **We look after it.** Updates install themselves. If something goes wrong, our support team can see what happened
    without driving to your shop.

### Who it's for

Short cards, each with one line:

- **Restaurants and cafés:** tables, kitchen tickets, menus by time of day.
- **Bars and lounges:** fast rounds, held orders, credit accounts for regulars.
- **Quick service and takeaways:** speed at the counter, combos, offers.
- **Shops and retail:** stock, suppliers and deliveries.

Before publishing, check every feature named on the site against the current release, and keep the claims to what ships.
- **Petrol stations:** pumps, attendants, tank deliveries, plus parking.

### Pricing

The pricing model is still being decided. **Draft**, based on what current clients pay:

| | |
|---|---|
| **Setup** | **KES 30,000** once. Installation, your menu loaded, staff trained. |
| **ZapTill Online** | **KES 3,000 a month**, paid every 6 months (KES 18,000) or yearly (KES 36,000). The dashboard, reports, branches and backups. |
| **Premium extras** | Analytics, and WhatsApp alerts when they launch. Ask us. |

Note: KES 100 a day works out to KES 36,500 a year. Quoting "KES 3,000 a month" matches the KES 36,000 clients pay today,
so use the monthly figure on the site.

If prices aren't published yet, use this instead:

> **Simple pricing: one setup fee, then a small monthly fee — no surprises.** Tell us about your business and we'll send you
> a quote today. [ Chat on WhatsApp ]

Questions under the pricing (FAQ):

- *Do I need internet?* Only to see your numbers remotely and back up. The tills keep selling without it.
- *What hardware do I need?* A Windows PC or POS terminal, a receipt printer, and optionally a cash drawer and kitchen
  printer. We can advise or supply.
- *Can I move from my current system?* Yes. Send us your menu in Excel and we'll load it.
- *Who owns my data?* You do. You can download your reports at any time.
- *What if something breaks?* Call or WhatsApp us. Most problems we can see and fix remotely.

### Request a demo

> ### Let's set up a demo for your business.
> Tell us a little about you — we'll call or WhatsApp you within one working day.

Fields: name; business name; phone (required, Kenyan format); email (optional); type of business (list); number of branches
(1 / 2–5 / 6+); message (optional). A consent checkbox: *"ZapTill may contact me about this request."* Button: **Request my
demo**.

Thank-you message: *"Thank you, {name}! We'll be in touch within one working day. Can't wait? WhatsApp us on 0717 675 635."*

### Contact

- WhatsApp and phone: **0717 675 635** (+254 717 675 635), click-to-chat link `https://wa.me/254717675635`
- Email: *to add once there is a company address* (e.g. hello@zaptill.co.ke)
- Business hours, and the location (city only is fine)

---

## 5. Screenshots

- Taken from the real app running against a **demo business with made-up data**: a restaurant called something like
  "Mama Lishe Grill", three branches, a realistic Kenyan menu, made-up cashiers, made-up customers and made-up M-Pesa
  references.
- Never a real client's data, names or receipts.
- A clean, consistent frame: the till in a monitor mock-up, the dashboard in a laptop mock-up, the owner's view on a phone.
- Needed: the till's selling screen, a kitchen ticket, the receipt, day close, the dashboard overview, branch comparison,
  stock, the analytics menu matrix and insights, the Staff screen with roles, and branded receipts side by side.
- Dark and light versions where the screen supports both.

---

## 6. Demo requests reach you everywhere

One request goes to all of these:

1. **The admin portal**: a "Demo requests" list with status (new / contacted / demo booked / won / lost) and notes. This is
   the record; the channels below are notifications only.
2. **WhatsApp**: until the WhatsApp Business account exists, the thank-you page offers the visitor a click-to-chat link
   (free, nothing to set up). Once the account is live, a template message to 0717 675 635 for each new request.
3. **Telegram**: the existing ZapTill alert bot posts each new request. It's free and works today.
4. **Email**: once there is a company address.

---

## 7. Keeping spam out

The form is protected in layers, so real people are never bothered with puzzles:

| Layer | What it does | Cost |
|---|---|---|
| **Cloudflare Turnstile** | An invisible "are you human" check, with no picture puzzles for real visitors | Free |
| **Honeypot field** | A hidden field real people never fill in; bots do, and are dropped silently | Free |
| **Time check** | A form submitted less than ~3 seconds after the page loaded is a bot | Free |
| **Rate limit** | At most a few requests per IP address and per phone number per hour | Free (server) |
| **Phone validation** | Must be a valid Kenyan mobile number (07xx / 01xx / +254) | Free |
| **Email checks** (when given) | Correct format; the domain actually receives mail (MX lookup); not a throwaway domain (open blocklist of disposable providers) | Free |
| **Link and keyword filter** | Messages full of links or known spam words are held as "suspected spam" rather than notified | Free |

**Checking an email is real.** The checks above catch typos, fake domains and throwaway addresses without sending
anything. The only way to prove a person owns an inbox is to send them a code or link. That makes sense later, for
self-sign-up, but is too heavy for a demo request. For a demo, the phone number matters most: the first call or WhatsApp
proves it.

**Email sent to ZapTill** (once there is a company address): the mail provider's spam filter handles most of it. Never
publish the address as plain text on the site; use the form or a contact button. Set SPF, DKIM and DMARC on zaptill.co.ke
so nobody can send email pretending to be ZapTill.

Nothing a visitor types is ever placed in a link or address. Requests are stored only as long as needed, as the privacy
policy says.

---

## 8. Technical plan (for when it's built)

- **Location:** a separate small app in the repo (`apps/website`), static, built with Astro or Vite. Deployed on Vercel as
  its own project, so it never affects the dashboard.
- **Speed:** fast on a phone over mobile data. Images in WebP, under ~1.5 MB per page, no heavy scripts.
- **Search:** a proper title and description on every page, Open Graph images for WhatsApp and Facebook previews, a
  sitemap, a Google Business Profile, and "POS system Kenya" / "restaurant POS Nairobi" written naturally into the copy.
- **Demo form:** posts to a new cloud route (`POST /api/public/demo-request`) with the protections in §7, stored in a
  table, with notifications to the admin portal and Telegram. Needs a migration.
- **Analytics for the site itself:** privacy-friendly (Plausible or Vercel Analytics), so no cookie banner is needed.
- **Brand:** the ZapTill logo and colours already used in the app.

## 9. Still needed from the owner

- [ ] Final pricing, or "quote only"
- [ ] A company email address
- [ ] Location to show (city)
- [ ] Permission from any client whose logo or quote appears
- [ ] Hours for support
