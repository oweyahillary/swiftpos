/**
 * schema.org structured data (JSON-LD) for search engines. Every value here must stay inside WORKPLAN §3's "Say" column:
 * no ratings, review counts or offers until they are real.
 */
import { SITE } from './site.ts';
import type { FaqItem } from './faq.ts';

/** The business behind the site: in the layout on every page. */
export function organization() {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': `${SITE.url}/#organization`,
    name: 'ZapTill',
    url: SITE.url,
    logo: `${SITE.url}/favicon.png`,
    telephone: SITE.phoneIntl,
    areaServed: 'KE',
    contactPoint: {
      '@type': 'ContactPoint',
      telephone: SITE.phoneIntl,
      contactType: 'sales',
      areaServed: 'KE',
      availableLanguage: ['en', 'sw'],
    },
    // TODO(owner): add "email" and "address" once the company email and office address are confirmed.
  };
}

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
