/**
 * appFlavor.ts — badge the admin-portal tab per DEPLOYMENT (A68).
 *
 * Same contract as the dashboard's copy: driven by VITE_APP_ENV set on the
 * admin Vercel project, NOT by the branch, so main and dev stay identical in
 * git. Absent/unknown env → prod (a missing variable never disguises dev).
 * The admin portal is the highest-stakes surface to confuse between
 * environments, so its badge matters most.
 */
type Flavor = { label: string; title: string; color: string; fg: string };

const FLAVORS: Record<string, Flavor> = {
  prod: { label: 'S', title: 'SwiftPOS Admin', color: '#3b82f6', fg: '#ffffff' },
  dev: { label: 'SD', title: '[DEV] SwiftPOS Admin', color: '#f59e0b', fg: '#0f172a' },
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
  if (typeof document === 'undefined') return;
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
