/**
 * The seeded demo restaurant's Analytics, from the app's own screens (Analytics after A560, A561 and A565): the "Do this
 * next" cards, the week at a glance, what sells in each part of the day, the top 3 at every hour, and the stock moves
 * between branches. Made-up data ("Mama Lishe Grill": Westlands, Ngong Road, Kilimani), never a client's.
 *
 * Card wording comes from apps/server/src/lib/analyticsRules.ts (read, not edited) and the captures in
 * docs/website/screenshots/app-analytics-dark.webp and app-analytics-branches.webp. The site's only change: the app's
 * long dashes are written as colons or semicolons, as everywhere else on the site.
 *
 * Owner rules (2026-10-22): Analytics never suggests raising a price ("prices should be competitive"); a cashier's voids
 * or discounts are a WARNING to look into, never money "to recover"; a stock move between branches is said in words, with
 * no quantity and no KES.
 */

export type CardKind = 'stock_low' | 'stock_out' | 'stock_up' | 'credit' | 'promote' | 'leak' | 'stock_move';

export interface DemoCard {
  n: number;
  kind: CardKind;
  title: string;
  body: string;
  /** A stock card's plan: "Order: ≈ 70 more to have 100 by Friday" or "Have in for Saturday: 65 Tusker lager · …". */
  plan?: { label: string; strong: string; rest?: string };
  /** A KES estimate, when there is an honest one ("KES 25,200" + "a month more profit"). */
  estimate?: string;
  unit?: string;
  /** What the card says instead of an estimate ("No estimate: look into it first"). */
  instead?: string;
  assumes: string;
  /** 3 = Strong evidence, 2 = Good evidence, 1 = Worth a try */
  evidence: 1 | 2 | 3;
  tab: string;
  /** A warning to look into (drawn amber, no number, no estimate). */
  warning?: boolean;
}

const STOCK_LEVEL_BASIS =
  'Your stock level as the cloud has it now, against the average of each weekday in this period, plus 10%. KES = the units you would be short × what it sells for on average (sales at risk, not profit).';

export const DEMO_CARDS: DemoCard[] = [
  {
    n: 1, kind: 'stock_low', title: 'Order about 70 more Tusker lager before Friday',
    body: 'You have 30 Tusker lager; a normal Friday sells about 49, and from today to the end of Friday about 91.',
    plan: { label: 'Order:', strong: '≈ 70 more', rest: 'to have 100 by Friday' },
    estimate: 'KES 18,255', unit: 'of sales at risk if it runs out',
    assumes: STOCK_LEVEL_BASIS, evidence: 2, tab: 'What sells when',
  },
  {
    n: 2, kind: 'stock_out', title: 'Cooking oil runs out in about 2 days at your current rate: order now',
    body: 'You have 6 litres left and use about 3.2 a day (95 in 30 days, 3 of it thrown away).',
    plan: { label: 'Order:', strong: '≈ 19 more', rest: 'to have 25 for a week' },
    assumes: "At this period's average use a day (sales and wastage), with the stock level as the cloud has it now; a week's worth is 7 days of use plus 10%, rounded up.",
    evidence: 3, tab: 'Stock',
  },
  {
    n: 3, kind: 'stock_up', title: 'Stock up for Friday: 55 Tusker lager',
    body: 'Fridays: you sell about 49 Tusker lager (vs 30 on an average day).',
    plan: { label: 'Have in for Friday:', strong: '55', rest: 'Tusker lager' },
    assumes: 'The average Friday in this period (4 of them), plus 10% so a busier one does not run you out, rounded up.',
    evidence: 3, tab: 'What sells when',
  },
  {
    n: 4, kind: 'stock_up', title: 'Stock up for Saturday: Tusker lager and 3 more',
    body: 'Saturdays: you sell about 58 Tusker lager (vs 30 on an average day), 27 Chicken wings (vs 18), 22 Nyama choma 1kg (vs 14) and 1 more.',
    plan: { label: 'Have in for Saturday:', strong: '65 Tusker lager · 30 Chicken wings · 25 Nyama choma 1kg' },
    assumes: 'The average Saturday in this period (4 of them), plus 10% so a busier one does not run you out, rounded up.',
    evidence: 3, tab: 'What sells when',
  },
  {
    n: 5, kind: 'credit', title: 'Chase KES 87,400 owed for over 60 days',
    body: 'County Office KES 52,000, Safari Tours Ltd KES 28,000 and Peter Oduya KES 7,400: owed for more than two months.',
    estimate: 'KES 87,400', unit: 'once to collect',
    assumes: 'Money already owed to you: counted once, if it is paid.',
    evidence: 3, tab: 'Credit ageing',
  },
  {
    n: 6, kind: 'promote', title: 'Feature Tilapia whole at lunch',
    body: 'It leaves KES 900 each, KES 649 more than your average, but only 140 sold in 30 days, 75% of them at lunch.',
    estimate: 'KES 25,200', unit: 'a month more profit',
    assumes: 'If featuring it lifts its sales by 20% (about 140 to 168 a month) at today’s margin.',
    evidence: 1, tab: 'Menu engineering',
  },
  {
    n: 7, kind: 'leak', warning: true, title: "Check Otieno's voids",
    body: '47 voids (KES 42,050) in 30 days: 5.0 times the branch median rate. Worth a look; a void before payment is not always a loss.',
    instead: 'No estimate: look into it first',
    assumes: 'A warning to look into, not money lost: no KES estimate.',
    evidence: 3, tab: 'Money leaks',
  },
];

/** A565: a stock move between branches, as the app words it: no quantity, no KES; how much to move is the owner's call. */
export const DEMO_MOVE_CARD: DemoCard = {
  n: 3, kind: 'stock_move', title: 'Consider moving some stock from Westlands to Ngong Road',
  body: 'Tusker lager, Soda and Mandazi are moving slowly at Westlands but sell fast at Ngong Road, where some are about to run out: consider moving some across.',
  instead: 'How much to move is your call.',
  assumes: "A suggestion, not an order: how much to move is your call or your manager's.",
  evidence: 3, tab: 'Branches',
};

export const DEMO_MOVES = [
  {
    items: 'Tusker lager, Soda, Mandazi', route: 'Westlands → Ngong Road',
    text: 'Tusker lager, Soda and Mandazi are moving slowly at Westlands but sell fast at Ngong Road, where some are about to run out: consider moving some across.',
  },
  {
    items: 'Chips masala', route: 'Kilimani → Ngong Road',
    text: 'Chips masala sells well at Ngong Road (about 9 a day) and is about to run out there, but sells slowly at Kilimani, where you hold plenty: consider moving some to Ngong Road.',
  },
];

/** The line the app puts above the cards, in the site's words (the demo's seven cards, counted). */
export const DEMO_FOUND = {
  things: 7,
  atRisk: 'KES 18,255',
  credit: 'KES 87,400',
  monthly: 'KES 25,200',
};

/** The banner over the cards when items are sold with no cost (A561), as the app shows it. */
export const DEMO_NO_COST = { items: 6, share: '5%' };

/** A560: "Your week at a glance: what to prepare each day". The top 3 each weekday, with what a typical one sells. */
export const DEMO_WEEK: { day: string; top: [string, number][] }[] = [
  { day: 'Monday', top: [['Chips masala', 26], ['Chapati', 23], ['Beef burger', 20]] },
  { day: 'Tuesday', top: [['Chips masala', 17], ['Beef burger', 13], ['Chapati', 13]] },
  { day: 'Wednesday', top: [['Chips masala', 17], ['Chapati', 16], ['Tusker lager', 16]] },
  { day: 'Thursday', top: [['Tusker lager', 26], ['Chips masala', 23], ['Chapati', 21]] },
  { day: 'Friday', top: [['Tusker lager', 49], ['Chips masala', 25], ['Chapati', 24]] },
  { day: 'Saturday', top: [['Tusker lager', 58], ['Chips masala', 33], ['Chapati', 32]] },
  { day: 'Sunday', top: [['Tusker lager', 32], ['Chips masala', 31], ['Chapati', 26]] },
];

export const DEMO_DAYPARTS = [
  { name: 'Morning', hours: '05:00–11:00', share: '9%', items: [['Chapati', 61], ['Masala tea', 28], ['Samosa (2)', 11]] },
  { name: 'Lunch', hours: '11:00–15:00', share: '36%', items: [['Chapati', 15], ['Beef burger', 15], ['Pilau', 15], ['Ugali', 11], ['Chips masala', 11]] },
  { name: 'Afternoon', hours: '15:00–18:00', share: '10%', items: [['Samosa (2)', 23], ['Passion juice', 20], ['Masala tea', 18], ['Chips masala', 17], ['Tusker lager', 12]] },
  { name: 'Evening', hours: '18:00–22:00', share: '39%', items: [['Tusker lager', 23], ['Chicken wings', 15], ['Nyama choma 1kg', 15], ['Chips masala', 14], ['Beef burger', 12]] },
  { name: 'Late at night', hours: '22:00–05:00', share: '6%', items: [['Tusker lager', 62], ['Chicken wings', 26], ['Chips masala', 12]] },
] as const;

export const DEMO_TOP3: [string, string][] = [
  ['08:00', 'Chapati · Masala tea · Samosa (2)'],
  ['11:00', 'Chapati · Beef burger · Pilau'],
  ['13:00', 'Pilau · Beef burger · Chapati'],
  ['15:00', 'Samosa (2) · Passion juice · Masala tea'],
  ['18:00', 'Tusker lager · Nyama choma 1kg · Chicken wings'],
  ['19:00', 'Tusker lager · Chicken wings · Nyama choma 1kg'],
  ['21:00', 'Tusker lager · Nyama choma 1kg · Chicken wings'],
  ['23:00', 'Tusker lager · Chicken wings · Chips masala'],
];

/** Looks a card up by number (fails the build if a page asks for one that is gone). */
export function demoCard(n: number): DemoCard {
  const c = DEMO_CARDS.find((x) => x.n === n);
  if (!c) throw new Error(`No demo card ${n}`);
  return c;
}
