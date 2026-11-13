/**
 * schema.org structured data (JSON-LD) for search engines. Every value here must stay inside WORKPLAN §3's "Say" column:
 * no ratings, review counts or offers until they are real.
 */
import { SITE } from './site.ts';
import type { FaqItem } from './faq.ts';

/**
 * The business behind the site: in the layout on every page. ZapTill is a service-area local business — we set the point
 * of sale up at the client's own premises across Kenya ("we come to you"), rather than a storefront people visit. Google
 * advises marking a service-area business up as a LocalBusiness with `areaServed` and NO street address (the address is
 * managed in a Google Business Profile instead), which is what we do here. Only truthful fields; no invented address,
 * hours or social links.
 */
export function organization() {
  return {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    '@id': `${SITE.url}/#organization`,
    name: 'ZapTill',
    description:
      'Point-of-sale system for restaurants, cafés and bars in Kenya: M-Pesa on every receipt, orders straight to the kitchen, drawers by cashier, and a desktop app that keeps selling offline.',
    url: SITE.url,
    logo: `${SITE.url}/favicon.png`,
    image: `${SITE.url}/og-zaptill.png`,
    telephone: SITE.phoneIntl,
    areaServed: { '@type': 'Country', name: 'Kenya' },
    knowsLanguage: ['en', 'sw'],
    contactPoint: {
      '@type': 'ContactPoint',
      telephone: SITE.phoneIntl,
      contactType: 'sales',
      areaServed: 'KE',
      availableLanguage: ['en', 'sw'],
    },
    // TODO(owner): add "email", "address" and "openingHoursSpecification" once confirmed, "sameAs" (social-profile URLs)
    // once the accounts exist, and — the biggest local-search win — a Google Business Profile for ZapTill.
  };
}

/**
 * Who the product is for, in search engines' words. Public scope (owner, 2026-11-13): only the tested restaurant/hotel
 * POS is marketed publicly, so only the food-service audiences are named here. The other verticals are parked.
 */
export const AUDIENCES = [
  'Restaurants and cafés',
  'Bars and lounges',
  'Quick-service restaurants and takeaways',
];

/** The product: on Home, Features and Analytics. */
export function softwareApplication(description: string) {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'ZapTill',
    applicationCategory: 'BusinessApplication',
    applicationSubCategory: 'Point of sale',
    operatingSystem: 'Windows; web dashboard in any browser',
    description,
    url: SITE.url,
    publisher: { '@id': `${SITE.url}/#organization` },
    // Public scope (owner, 2026-11-13): only the food-service audiences (AUDIENCES), the tested restaurant/hotel POS.
    audience: AUDIENCES.map((audienceType) => ({ '@type': 'BusinessAudience', audienceType, geographicArea: { '@type': 'Country', name: 'Kenya' } })),
    // TODO(owner): add an "offers" block (price, KES) once the prices are final; left out while they are a draft.
  };
}

const strip = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/** Questions and answers: on Pricing and the industry pages. */
export function faqPage(items: FaqItem[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((i) => ({
      '@type': 'Question',
      name: i.q,
      acceptedAnswer: { '@type': 'Answer', text: strip(i.a) },
    })),
  };
}

/** A trail for search results: Home > section > page. `items` are [name, path] pairs after Home. */
export function breadcrumb(items: [string, string][]) {
  const all: [string, string][] = [['Home', '/'], ...items];
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: all.map(([name, path], i) => ({ '@type': 'ListItem', position: i + 1, name, item: `${SITE.url}${path}` })),
  };
}

/** A guide (/guides/…). Written by ZapTill, the organisation; no author names, ratings or reviews. */
export function article(a: { title: string; description: string; path: string; date: string; image?: string }) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: a.title,
    description: a.description,
    datePublished: a.date,
    dateModified: a.date,
    inLanguage: 'en-KE',
    mainEntityOfPage: `${SITE.url}${a.path}`,
    url: `${SITE.url}${a.path}`,
    image: `${SITE.url}${a.image ?? '/og-zaptill.png'}`,
    author: { '@id': `${SITE.url}/#organization` },
    publisher: { '@id': `${SITE.url}/#organization` },
  };
}

/** The site itself, on Home: its name for search results. */
export function website() {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': `${SITE.url}/#website`,
    name: 'ZapTill',
    url: SITE.url,
    inLanguage: 'en-KE',
    publisher: { '@id': `${SITE.url}/#organization` },
  };
}
