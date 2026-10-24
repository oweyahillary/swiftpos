// ZapTill website: a fully static Astro site (no server, no adapter).
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { GUIDES } from './src/lib/guides.ts';

// Night 3: a guide still in draft (src/lib/guides.ts) is left out of the sitemap, and so is the guides hub while every
// guide is a draft; the pages carry a robots noindex as well.
const drafts = GUIDES.filter((g) => g.status === 'draft').map((g) => `/guides/${g.slug}/`);
if (GUIDES.every((g) => g.status === 'draft')) drafts.push('/guides/');

export default defineConfig({
  site: 'https://zaptill.co.ke',
  output: 'static',
  trailingSlash: 'ignore',
  build: { format: 'directory' },
  integrations: [sitemap({ filter: (page) => !drafts.some((d) => new URL(page).pathname === d) })],
  devToolbar: { enabled: false },
});
