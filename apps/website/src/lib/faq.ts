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
  a: `<p>The till is a Windows PC, so it needs power like any computer. A small UPS keeps it and the printer going
through a short cut. Ask us what to get when we visit.</p>`,
};

export const FAQ_HARDWARE: FaqItem = {
  q: 'What hardware do I need, and can I use my own?',
  a: `<p>A Windows PC or POS terminal and a receipt printer. A cash drawer, a kitchen printer or a kitchen screen if you
want them. If you already have hardware, we'll check it and use what fits. Anything new is quoted separately.</p>`,
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
  q: 'What happens if I stop paying?',
  // TODO(owner): say exactly what happens to the tills and the dashboard, then replace this answer.
  a: `<p>Your records stay yours, and you can download your reports. Ask us how the tills and the dashboard are handled;
we'll explain it plainly before you sign anything.</p>`,
};

export const FAQ_ETIMS: FaqItem = {
  q: 'What about eTIMS?',
  a: `<p>ZapTill clients handle eTIMS with their own provider today; ask us how others do it.</p>`,
};

export const FAQ_SETUP_TIME: FaqItem = {
  q: 'How long does setup take?',
  // TODO(owner): give a typical number of days from the first visit to the first day of selling.
  a: `<p>It depends on the size of your menu and how many tills you have. We load your menu and stock, set up the
printers and screens, and train your staff on site. We'll give you a date at the first visit.</p>`,
};

export const FAQ_BRANCH: FaqItem = {
  q: 'Can I add a branch later?',
  a: `<p>Yes. A new branch gets its own tills and shows up on the same web dashboard as the others, so you see every
branch side by side. We'll quote the new branch's setup.</p>`,
};

export const FAQ_CONTRACT: FaqItem = {
  q: 'Is there a contract?',
  // TODO(owner): state the contract length and the notice period, then replace this answer.
  a: `<p>We'll go through the terms with you before you pay anything. There is no percentage of your sales, ever.</p>`,
};

export const HOME_FAQ: FaqItem[] = [FAQ_INTERNET, FAQ_MPESA, FAQ_HARDWARE, FAQ_DATA];

export const PRICING_FAQ: FaqItem[] = [
  FAQ_INTERNET,
  FAQ_POWER,
  FAQ_HARDWARE,
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
  a: `<p>Yes. Give a customer an account with a limit. Every sale on account is confirmed by a manager, and the
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

export const FAQ_TRANSFERS: FaqItem = {
  q: 'I have two shops. Can I move stock between them?',
  a: `<p>Yes. Send a transfer from one branch, and the other branch receives it, so both stock levels stay right.</p>`,
};

export const RESTAURANT_FAQ: FaqItem[] = [FAQ_KITCHEN_PRINTERS, FAQ_KDS, FAQ_TABLES, FAQ_COMBOS, FAQ_INTERNET];
export const BAR_FAQ: FaqItem[] = [FAQ_VOIDS, FAQ_CREDIT, FAQ_NIGHT_CLOSE, FAQ_TABLES, FAQ_INTERNET];
export const QUICK_FAQ: FaqItem[] = [FAQ_COMBOS, FAQ_OFFERS, FAQ_DELIVERY, FAQ_KITCHEN_PRINTERS, FAQ_INTERNET];
export const RETAIL_FAQ: FaqItem[] = [FAQ_STOCK_TILL, FAQ_TRANSFERS, FAQ_MPESA, FAQ_HARDWARE, FAQ_INTERNET];
