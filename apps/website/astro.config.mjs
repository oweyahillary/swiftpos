// ZapTill website: a fully static Astro site (no server, no adapter).
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { GUIDES } from './src/lib/guides.ts';
import { INDUSTRIES_PARKED } from './src/lib/site.ts';

// Night 3: a guide still in draft (src/lib/guides.ts) is left out of the sitemap, and so is the guides hub while every
// guide is a draft; the pages carry a robots noindex as well.
// Public scope (owner, 2026-11-13): the parked verticals (shops, minimarts, petrol, parking) are kept out of the
// sitemap too; their /for pages also carry a robots noindex (set in Industry.astro).
const drafts = GUIDES.filter((g) => g.status === 'draft').map((g) => `/guides/${g.slug}/`);
if (GUIDES.every((g) => g.status === 'draft')) drafts.push('/guides/');
const excluded = [...drafts, ...INDUSTRIES_PARKED.map((i) => i.href)].map((p) => p.replace(/\/$/, ''));

export default defineConfig({
  site: 'https://zaptill.co.ke',
  output: 'static',
  trailingSlash: 'ignore',
  build: { format: 'directory' },
  integrations: [sitemap({ filter: (page) => !excluded.includes(new URL(page).pathname.replace(/\/$/, '')) })],
  devToolbar: { enabled: false },
});
