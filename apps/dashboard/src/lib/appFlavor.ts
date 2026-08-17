/**
 * appFlavor.ts — badge the browser tab per DEPLOYMENT, not per branch (A68).
 *
 * The differentiator is driven by VITE_APP_ENV, set on each Vercel project — so
 * `main` and `dev` stay byte-identical in git and a dev→main merge can never
 * carry the wrong badge. That is the whole point: a favicon committed
 * differently per branch is "two things that must agree, with nothing comparing
 * them" (see HANDOFF-2026-08-08-evening.md §0). Absent/unknown env → prod, so a
 * missing variable never dresses dev up as prod.
 *
 * Colours come from the app's own palette: blue #3b82f6 (accent) for prod,
 * amber #f59e0b (already "attention" across the UI) for dev.
 */
type Flavor = { label: string; title: string; color: string; fg: string };

const FLAVORS: Record<string, Flavor> = {
  prod: { label: 'S', title: 'SwiftPOS', color: '#3b82f6', fg: '#ffffff' },
  dev: { label: 'SD', title: '[DEV] SwiftPOS', color: '#f59e0b', fg: '#0f172a' },
};

function faviconDataUri(f: Flavor): string {
  const fontSize = f.label.length > 1 ? 34 : 44;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<rect width="64" height="64" rx="14" fill="${f.color}"/>` +
    `<text x="50%" y="52%" fill="${f.fg}" font-family="system-ui,sans-serif" ` +
    `font-size="${fontSize}" font-weight="700" text-anchor="middle" ` +
    `dominant-baseline="central">${f.label}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function applyAppFlavor(): void {
  if (typeof document === 'undefined') return; // SSR/tests guard
  const env = (import.meta.env.VITE_APP_ENV ?? 'prod').toLowerCase();
  const f = FLAVORS[env] ?? FLAVORS.prod;

  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.type = 'image/svg+xml';
  link.href = faviconDataUri(f);

  document.title = f.title;
}
