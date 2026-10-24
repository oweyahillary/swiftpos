/**
 * The guides (/guides/): practical articles for owners, written night 3 (2026-10-23) as DRAFTS for the owner to review.
 *
 * Rules for every guide (WORKPLAN §3): say only what ships; no invented statistics, clients or quotes; every business
 * type in the examples, not only restaurants; "point of sale" or "POS", never the other word; demo businesses are the
 * fictional ones (Kijani Basket, Mama Lishe Grill, Mvua Café, Kifaru Fuel & Mart); each ends with a soft call to action.
 *
 * `status: 'draft'` keeps a guide out of search engines (a robots noindex and no sitemap entry) and shows a note in
 * `npm run dev` only. When the owner has read one and is happy, change it to 'ready'.
 */
import { PRICES } from './site.ts';

export type GuideStatus = 'draft' | 'ready';

export interface Guide {
  slug: string;
  /** The H1 and the card title. */
  title: string;
  /** The <title>, at most 65 characters with " | ZapTill". */
  metaTitle: string;
  /** The meta description, 70 to 165 characters. */
  description: string;
  /** One or two sentences under the H1 and on the card. */
  summary: string;
  /** Minutes to read, rounded. */
  minutes: number;
  /** ISO date first written. */
  date: string;
  status: GuideStatus;
  /** Pages this guide sends a reader on to (internal links). */
  related: { href: string; label: string }[];
}

export const GUIDES: Guide[] = [
  {
    slug: 'stop-cash-going-missing',
    title: 'How to stop cash going missing at your shop',
    metaTitle: 'How to stop cash going missing at your shop | ZapTill',
    description:
      'Practical habits and point of sale checks that show where cash and stock go missing in a shop, bar, restaurant or petrol station in Kenya, and who was on the drawer.',
    summary:
      'Most missing money is not one big theft. It is small, daily and hard to see. Here is how to make it visible, by name, without accusing anyone.',
    minutes: 7,
    date: '2026-10-23',
    status: 'draft',
    related: [
      { href: '/for/bars/', label: 'ZapTill for bars and lounges' },
      { href: '/for/minimarts/', label: 'ZapTill for minimarts' },
      { href: '/pricing/#calc-title', label: 'Work out what leaks could be costing you' },
    ],
  },
  {
    slug: 'run-two-branches-without-being-there',
    title: 'Running two branches without being there',
    metaTitle: 'Running two branches without being there | ZapTill',
    description:
      'How Kenyan owners run a second shop, restaurant or station without standing in it all day: one daily routine, the numbers that matter, and what to check by phone.',
    summary:
      'You cannot be in two places at once. You can know, every night, what happened in both. A routine for the owner who is away.',
    minutes: 7,
    date: '2026-10-23',
    status: 'draft',
    related: [
      { href: '/features/#branches', label: 'Branches and branding' },
      { href: '/analytics/', label: 'ZapTill Analytics' },
      { href: '/for/retail/', label: 'ZapTill for shops and supermarkets' },
    ],
  },
  {
    slug: 'pos-when-the-internet-goes-off',
    title: 'What a POS should do when the internet goes off',
    metaTitle: 'What a POS should do when the internet goes off | ZapTill',
    description:
      'Internet and power cuts happen. What your point of sale should keep doing offline, what can wait, and the questions to ask before you buy one in Kenya.',
    summary:
      'The queue does not wait for Safaricom or KPLC. What a point of sale has to keep doing with no internet, what can wait, and what to ask before you buy.',
    minutes: 6,
    date: '2026-10-23',
    status: 'draft',
    related: [
      { href: '/features/#offline', label: 'Works offline' },
      { href: '/for/petrol-stations/', label: 'ZapTill for petrol stations' },
      { href: '/for/restaurants/', label: 'ZapTill for restaurants and cafés' },
    ],
  },
  {
    slug: 'pos-pricing-setup-vs-monthly',
    title: "Pricing your POS: setup vs monthly, and what you're really paying for",
    metaTitle: 'POS pricing: setup vs monthly, what you pay for | ZapTill',
    description:
      'One-off setup or a monthly fee? How to compare point of sale prices in Kenya over three years, what the setup should include, and the costs people forget.',
    summary:
      'A low monthly price can cost more over three years, and a "free" POS rarely is. How to add it up, and what each shilling should buy you.',
    minutes: 7,
    date: '2026-10-23',
    status: 'draft',
    related: [
      { href: '/pricing/', label: 'ZapTill pricing' },
      { href: '/pricing/#compare-title', label: 'ZapTill, a cash book or a basic POS' },
      { href: '/contact/', label: 'Ask for a quote' },
    ],
  },
];

export const guideHref = (g: Pick<Guide, 'slug'>) => `/guides/${g.slug}/`;
export const guideBySlug = (slug: string) => {
  const g = GUIDES.find((x) => x.slug === slug);
  if (!g) throw new Error(`No guide "${slug}" in src/lib/guides.ts`);
  return g;
};
/** Paths kept out of the sitemap while a guide is a draft (astro.config.mjs). */
export const DRAFT_GUIDE_PATHS = GUIDES.filter((g) => g.status === 'draft').map(guideHref);

/**
 * What ZapTill costs over a number of years, from the draft prices in site.ts (the pricing guide's worked example).
 * Setup once per branch; the cloud is per business with the first month free; Analytics optional, per business.
 * Hardware and any extra computers are quoted separately and are not included.
 */
export function zaptillCost({ branches = 1, years = 3, analytics = false }: { branches?: number; years?: number; analytics?: boolean } = {}) {
  const months = years * 12;
  const setup = PRICES.setup * branches;
  const cloud = PRICES.monthly * Math.max(0, months - PRICES.trialMonths);
  const analyticsTotal = analytics ? PRICES.analyticsMonthly * months : 0;
  const total = setup + cloud + analyticsTotal;
  return { setup, cloud, analytics: analyticsTotal, total, perDay: Math.round(total / (years * 365)), perMonth: Math.round(total / months) };
}
