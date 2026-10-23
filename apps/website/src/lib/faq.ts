/**
 * FAQ copy, shared by Home (an excerpt) and Pricing (the full pricing FAQ, analysis §7.10).
 * Answers are HTML we write; keep every claim inside WORKPLAN §3's "Say" column.
 */
export interface FaqItem { q: string; a: string }

export const FAQ_INTERNET: FaqItem = {
  q: 'Do I need internet?',
  a: `<p>Not to sell. Your tills keep selling and printing receipts with no internet, and a branch server keeps every
till in the shop in step. When the internet comes back, everything catches up by itself.</p>
<p>You need internet to see your numbers from somewhere else, and for the daily summary to reach you.</p>`,
};

export const FAQ_POWER: FaqItem = {
  q: 'What about power cuts?',
  a: `<p>The till is a Windows PC, so it needs power like any computer. That is why a UPS is on our recommended hardware
list: it keeps the computers and the receipt printer going through a short cut, so the cashier keeps selling. Ask us
what size to get when we visit.</p>`,
};

export const FAQ_HARDWARE: FaqItem = {
  q: 'What hardware do I need, and can I use my own?',
  a: `<p>For each branch:</p>
<ul>
<li>Two Windows computers: the branch server and the till (a POS terminal works as the till)</li>
<li>A receipt printer</li>
<li>A UPS, recommended, so a short power cut doesn't stop the counter</li>
</ul>
<p>If you want them: a cash drawer, a kitchen printer or a kitchen screen, a barcode scanner, and a label printer (or
use A4 sticker sheets on an office printer). If you already have hardware, we'll check it and use what fits. Anything
new is quoted for your setup; an extra computer is from about KES 10,000.</p>`,
};

export const FAQ_MPESA: FaqItem = {
  q: 'How does M-Pesa work?',
  a: `<p>Your Buy Goods or Paybill number prints on every receipt. A customer can pay part M-Pesa and part cash, and the
day close shows M-Pesa totals for each cashier. M-Pesa charges are Safaricom's, not ours.</p>`,
};

export const FAQ_DATA: FaqItem = {
  q: 'Who owns my data?',
  a: `<p>You do. Your reports download to Excel whenever you want them, and your data is yours to export.</p>`,
};

export const FAQ_STOP: FaqItem = {
  q: 'What happens if I stop paying for the cloud?',
  // Owner, 2026-10-23: the till keeps working; the cloud stops syncing and the till cannot be re-registered until the
  // client pays again; reminders are emailed before expiry.
  a: `<p>Your tills keep selling. They were paid for once, so they stay yours. What stops is the cloud: the web
dashboard, your phone access, the daily email and syncing, until you pay again. Your sales wait safely on the till and
arrive in the cloud when you renew. Adding a till, or registering one again, needs an active cloud plan.</p>
<p>We remind you by email before your plan ends, so it never lapses by surprise.</p>`,
};

export const FAQ_ETIMS: FaqItem = {
  q: 'What about eTIMS?',
  a: `<p>ZapTill clients handle eTIMS with their own provider today; ask us how others do it.</p>`,
};

export const FAQ_SETUP_TIME: FaqItem = {
  q: 'How long does setup take?',
  // TODO(owner): give a typical number of days from the first visit to the first day of selling.
  a: `<p>It depends on the size of your menu or product list and how many tills you have. We load your items and stock,
set up the printers and screens, and train your staff on site. We'll give you a date at the first visit.</p>`,
};

export const FAQ_ONCE: FaqItem = {
  q: 'Do I pay for the tills every month?',
  a: `<p>No. Setting up a branch is paid once, and the tills are yours: once paid, it's a done deal. The monthly fee is
for the cloud: your dashboard on the web and on your phone, the daily email, and the online features. It is one fee
for your whole business, however many branches you have.</p>`,
};

export const FAQ_TRIAL: FaqItem = {
  q: 'Is there a free trial?',
  a: `<p>Yes, for the cloud. When your first branch is set up, the cloud is free for the first month, so you can see
your numbers on your phone and get the daily email before you pay a shilling for it.</p>`,
};

export const FAQ_PAY_AHEAD: FaqItem = {
  q: 'Can I pay for the cloud for a year?',
  // Owner, 2026-10-23: no reward for paying ahead for now.
  a: `<p>Yes. Pay month to month, or for 3, 6 or 12 months at once. We recommend 6 or 12 months: one payment, and
nothing to remember every month. Paying ahead is simpler, not cheaper: there is no discount.</p>`,
};

export const FAQ_TILLS: FaqItem = {
  q: 'What is a branch, and can I have more tills?',
  // Owner, 2026-10-23: "10k, in fact the price might vary depending on the client, even installation costs".
  a: `<p>A branch is a two-computer setup: the branch server and a till. A busy place can add more tills or a kitchen
screen; each extra computer is from about KES 10,000, quoted for your setup. The branch setup is KES 30,000;
installation can vary with the site, and we confirm the price before we start.</p>`,
};

export const FAQ_SUPPORT: FaqItem = {
  q: 'What support do I get?',
  // Owner, 2026-10-23: 8 am to 7 pm for every client (no days given, so none are stated); 24 hours for priority clients.
  a: `<p>Call or WhatsApp us on 0717 675 635. Support is from 8 am to 7 pm; priority clients get support 24 hours a
day. Many problems are fixed
without anyone driving to your shop: support can pull a till's log remotely to see what went wrong, and updates
install themselves.</p>`,
};

export const FAQ_BRANCH: FaqItem = {
  q: 'Can I add a branch later?',
  a: `<p>Yes. A new branch is set up the same way, paid once, and shows up on the same web dashboard as the others, so
you see every branch side by side. You pay its setup once; your monthly cloud fee stays the same, because it covers
the whole business, not each branch.</p>`,
};

export const FAQ_CONTRACT: FaqItem = {
  q: 'Is there a contract?',
  // TODO(owner): state the notice period (beyond "month to month"), then replace this answer.
  a: `<p>The tills are a one-off purchase. The cloud is month to month. We'll go through the terms with you before you
pay anything. There is no percentage of your sales, ever.</p>`,
};

export const HOME_FAQ: FaqItem[] = [FAQ_INTERNET, FAQ_ONCE, FAQ_MPESA, FAQ_HARDWARE, FAQ_DATA];

export const PRICING_FAQ: FaqItem[] = [
  FAQ_ONCE,
  FAQ_TRIAL,
  FAQ_PAY_AHEAD,
  FAQ_TILLS,
  FAQ_INTERNET,
  FAQ_POWER,
  FAQ_HARDWARE,
  FAQ_SUPPORT,
  FAQ_STOP,
  FAQ_ETIMS,
  FAQ_SETUP_TIME,
  FAQ_BRANCH,
  FAQ_CONTRACT,
];

// ── Industry pages (Phase 2). Each answer keeps to WORKPLAN §3's "Say" column. ──────────────────────────────────

export const FAQ_KITCHEN_PRINTERS: FaqItem = {
  q: 'Can different dishes go to different printers?',
  a: `<p>Yes. Each part of your menu can go to its own station: the grill, the kitchen, the bar or dispatch. The cook only
gets what they cook, and the dispatch ticket lists everything that goes into the bag or onto the tray.</p>`,
};

export const FAQ_KDS: FaqItem = {
  q: 'Do I need a kitchen screen, or will printers do?',
  a: `<p>Either works. Many kitchens start with a printer. A kitchen display shows each order as a card with a timer, and
the cook taps it through Pending, In progress and Ready.</p>`,
};

export const FAQ_TABLES: FaqItem = {
  q: 'Can waiters keep a table open and add to it?',
  a: `<p>Yes. Open a table, send the first round to the kitchen, add more later, and take payment when the table asks for
the bill. An order can also be held and picked up again.</p>`,
};

export const FAQ_CREDIT: FaqItem = {
  q: 'Can regulars pay later?',
  a: `<p>Yes. Give a customer an account with a credit limit, including customers already in your list. At the till,
the cashier puts the bill on their account, within the limit; every sale on account is confirmed by a manager, and the
dashboard shows who owes you and for how long.</p>`,
};

export const FAQ_VOIDS: FaqItem = {
  q: 'Can a cashier cancel a sale on their own?',
  a: `<p>Not a paid one. Voiding a paid order or giving a refund needs a manager's PIN, and every void shows up against
the cashier's name in the day's report.</p>`,
};

export const FAQ_NIGHT_CLOSE: FaqItem = {
  q: 'We close after midnight. Which day do the sales count on?',
  a: `<p>You set when your business day ends. A bar that closes at 2 a.m. keeps the night's sales on the night they
belong to.</p>`,
};

export const FAQ_COMBOS: FaqItem = {
  q: 'How do combos and variants print?',
  a: `<p>On one line where they can: "Chips Masala - Spicy" on the receipt and the kitchen ticket. A combo lists its parts
under it, so the kitchen sees every piece and dispatch packs every piece.</p>`,
};

export const FAQ_OFFERS: FaqItem = {
  q: 'Can I run offers?',
  a: `<p>Yes, with ZapTill Online. Set up an offer and the till applies it; the receipt prints each offer by name.</p>`,
};

export const FAQ_DELIVERY: FaqItem = {
  q: 'Do you handle delivery orders?',
  a: `<p>The till takes dine-in, takeaway and delivery orders. A delivery fee for the rider can go on the bill, and the
shift report shows what was paid to riders.</p>`,
};

export const FAQ_STOCK_TILL: FaqItem = {
  q: 'Can staff count stock and record deliveries at the till?',
  // TODO(owner): confirm which package includes stock on the WEB dashboard (on the till it needs the online licence, A460).
  a: `<p>Yes, with ZapTill Online: stock levels, deliveries, transfers between branches, counts and wastage, right at the
till.</p>`,
};

export const FAQ_BARCODES: FaqItem = {
  q: 'Some of my products have no barcode. What then?',
  a: `<p>ZapTill makes one. It gives every product without a barcode its own in-store code, in your own numbering, and
never changes a code you already have. The manufacturer's barcodes keep working as they are, and a scanner reads both at
the till.</p>`,
};

export const FAQ_LABELS: FaqItem = {
  q: 'Which label printer do I need?',
  a: `<p>Any. Print labels on a label printer (TSC, Xprinter, Zebra and others, in the common sizes or your own), on A4
sticker sheets from an office printer, or on the receipt printer. Every label carries the item's barcode, and its name
and price if you want them.</p>`,
};

export const FAQ_ZERO_STOCK: FaqItem = {
  q: 'What happens when an item runs out?',
  a: `<p>You choose, once, for the whole business, for the items you keep stock of: keep selling as normal, show it as
sold out so the cashier can't add it, or hide it from the till until stock comes in. It is back on sale by itself once
the delivery is in.</p>`,
};

export const FAQ_OTHER_BRANCH: FaqItem = {
  q: 'A customer wants something we have run out of. Can we check the other shop?',
  a: `<p>Yes, with ZapTill Online. Staff who can see stock look up the item at your other branches from the till, and a
manager asks that branch to send some. The other branch accepts it (or says why not), and the transfer keeps both stock
levels right.</p>`,
};

export const FAQ_TRANSFERS: FaqItem = {
  q: 'I have two shops. Can I move stock between them?',
  a: `<p>Yes. Send a transfer from one branch, and the other branch receives it, so both stock levels stay right.</p>`,
};

export const RESTAURANT_FAQ: FaqItem[] = [FAQ_KITCHEN_PRINTERS, FAQ_KDS, FAQ_TABLES, FAQ_COMBOS, FAQ_INTERNET];
export const BAR_FAQ: FaqItem[] = [FAQ_VOIDS, FAQ_CREDIT, FAQ_NIGHT_CLOSE, FAQ_TABLES, FAQ_INTERNET];
export const QUICK_FAQ: FaqItem[] = [FAQ_COMBOS, FAQ_OFFERS, FAQ_DELIVERY, FAQ_KITCHEN_PRINTERS, FAQ_INTERNET];
export const RETAIL_FAQ: FaqItem[] = [FAQ_BARCODES, FAQ_LABELS, FAQ_ZERO_STOCK, FAQ_OTHER_BRANCH, FAQ_STOCK_TILL, FAQ_MPESA, FAQ_HARDWARE, FAQ_INTERNET];
