/**
 * The seeded demo restaurant's Analytics, word for word from the app's own screens (Analytics v3, A558): the "Do this
 * next" cards, what sells in each part of the day, and the top 3 at every hour. Made-up data, never a client's.
 * Card wording comes from apps/server/src/lib/analyticsRules.ts; every card says what its estimate assumes.
 */

export interface DemoCard {
  n: number; title: string; body: string; estimate: string; unit: string; assumes: string; evidence: 1 | 2 | 3; tab: string;
}

export const DEMO_CARDS: DemoCard[] = [
  {
    n: 2, title: 'Raise the price of Tusker lager by KES 40',
    body: 'It is a best seller (880 sold, number 1) but leaves KES 110 each after its cost: KES 141 below your average of KES 251.',
    estimate: 'KES 35,200', unit: 'a month more profit', assumes: 'If the same 880 a month still sell at KES 340.',
    evidence: 3, tab: 'Menu engineering',
  },
  {
    n: 3, title: 'Talk to Otieno about voids',
    body: '47 voids (KES 42,050) in 30 days: 5.0 times the branch median rate.',
    estimate: 'KES 33,608', unit: 'a month to recover', assumes: 'If their void rate comes down to the branch median (1.6%).',
    evidence: 3, tab: 'Money leaks',
  },
  {
    n: 4, title: 'Feature Tilapia whole at lunch',
    body: 'It leaves KES 900 each, KES 649 more than your average, but only 140 sold in 30 days, 75% of them at lunch.',
    estimate: 'KES 25,200', unit: 'a month more profit', assumes: 'If featuring it lifts its sales by 20% (about 140 to 168 a month) at today’s margin.',
    evidence: 1, tab: 'Menu engineering',
  },
  {
    n: 6, title: 'Put an extra cashier on Saturday 19:00–22:00',
    body: 'You take 9.3% of all your sales in those three hours (KES 274,001, 287 orders in 30 days). Most bought then: Tusker lager, Chicken wings and Nyama choma 1kg; have them ready.',
    estimate: 'KES 13,700', unit: 'a month more profit', assumes: 'If quicker service there adds 5% to those hours’ sales.',
    evidence: 1, tab: 'Busy times',
  },
];

/** The total the demo page leads its cards with (A558's header line). */
export const DEMO_FOUND = { monthly: 'KES 134,469', credit: 'KES 87,400' };

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
