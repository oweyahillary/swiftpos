// ZapTill website: a fully static Astro site (no server, no adapter).
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://zaptill.co.ke',
  output: 'static',
  trailingSlash: 'ignore',
  build: { format: 'directory' },
  integrations: [sitemap()],
  devToolbar: { enabled: false },
});
