/**
 * Site-wide facts in one place, so a number or a link is changed once.
 *
 * WhatsApp links only ever carry a fixed message that WE wrote for the page.
 * Never put anything a visitor typed (name, phone, email) into a URL.
 */

export const SITE = {
  name: 'ZapTill',
  url: 'https://zaptill.co.ke',
  signIn: 'https://app.zaptill.co.ke',
  phoneDisplay: '0717 675 635',
  phoneIntl: '+254717675635',
  waNumber: '254717675635',
  // TODO(owner): add the company email once it exists (e.g. hello@zaptill.co.ke).
  email: null as string | null,
};

/** The draft prices (WORKPLAN §6). Change them here only. */
export const PRICES = {
  setup: 30000,
  monthly: 3000,
  yearly: 36000,
  analyticsMonthly: 10000,
};

/** Pre-filled WhatsApp messages, one per page or intent. */
export const WA_MESSAGES = {
  general: "Hi ZapTill, I'd like to know more about your till system.",
  demo: "Hi ZapTill, I run a business in Kenya and I'd like a demo.",
  restaurant: "Hi ZapTill, I run a restaurant and I'd like a demo.",
  pricing: "Hi ZapTill, I've seen your prices and I'd like a quote for my business.",
  visit: "Hi ZapTill, I'd like to book a visit to see ZapTill running.",
  analytics: "Hi ZapTill, I'd like to see what Analytics would show for my business.",
  leakReport: "Hi ZapTill, I'd like to ask about a first-month money-leak report for my business.",
  bar: "Hi ZapTill, I run a bar and I'd like a demo.",
  quickService: "Hi ZapTill, I run a quick-service restaurant and I'd like a demo.",
  retail: "Hi ZapTill, I run a shop and I'd like a demo.",
  petrol: "Hi ZapTill, I run a petrol station and I'd like to talk about ZapTill.",
  features: "Hi ZapTill, I've read your features and I'd like a demo.",
} as const;

/** A wa.me click-to-chat link with a URL-encoded, pre-filled message. */
export function waLink(message: string): string {
  return `https://wa.me/${SITE.waNumber}?text=${encodeURIComponent(message)}`;
}

export const telLink = `tel:${SITE.phoneIntl}`;

/** "30000" -> "30,000". Grouping by hand so the output is the same on every machine. */
export function kes(n: number): string {
  const whole = Math.round(n);
  const sign = whole < 0 ? '-' : '';
  return sign + String(Math.abs(whole)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** The industry pages, linked from the hub (/who-its-for/), the footer and Home. */
export const INDUSTRIES = [
  { href: '/for/restaurants/', name: 'Restaurants and cafés', short: 'Restaurants' },
  { href: '/for/bars/', name: 'Bars and lounges', short: 'Bars' },
  { href: '/for/quick-service/', name: 'Quick service and takeaways', short: 'Quick service' },
  { href: '/for/retail/', name: 'Shops and retail', short: 'Shops' },
];

export const NAV = [
  { href: '/how-it-works/', label: 'How it works' },
  { href: '/features/', label: 'Features' },
  { href: '/who-its-for/', label: "Who it's for" },
  { href: '/analytics/', label: 'Analytics' },
  { href: '/pricing/', label: 'Pricing' },
];
