/**
 * tenantHost.ts — A378: a client's own sign-in address, e.g. africanfries.zaptill.co.ke.
 *
 * Owner, 2026-10-02: "is there a way we can customize each client to use their subdomain eg africanfries … to log in we
 * can even add their logo on the sign in page". Decisions (owner, 2026-10-02): a field of its own (`businesses.subdomain`,
 * not the QR menu's `menu_slug`); on a client's address only that client's people can sign in; SwiftPOS sets it in the
 * admin portal, not the client.
 *
 * The root domain is configuration, never written here: TENANT_ROOT_DOMAIN on the cloud, VITE_TENANT_ROOT_DOMAIN on the
 * web (e.g. "zaptill.co.ke"). Unset = the feature is off and every address behaves as before.
 *
 * ONE file: shared/tenantHost.ts, copied to the cloud, the web and the admin portal (scripts/check-shared-sync.mjs).
 */

/** Our own names — never a client's (the apps, mail, DNS). Checked when one is set and when an address is read. */
export const RESERVED_SUBDOMAINS: readonly string[] = [
  'www', 'app', 'api', 'admin', 'portal', 'dashboard', 'pos', 'menu', 'login', 'auth', 'account', 'accounts',
  'mail', 'email', 'smtp', 'imap', 'pop', 'send', 'bounce', 'em', 'mx', 'ns', 'ns1', 'ns2', 'dns',
  'cdn', 'static', 'assets', 'img', 'images', 'files', 'docs', 'help', 'support', 'status', 'blog',
  'dev', 'staging', 'test', 'demo', 'swiftpos', 'zaptill', 'billing', 'pay', 'payments', 'mpesa', 'webhook', 'webhooks',
];

/** 3–32 characters: lowercase letters, digits and hyphens; starts and ends with a letter or digit. */
const SUBDOMAIN_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

/** Why a subdomain cannot be used, or null when it can. Expects the cleaned (lowercase, trimmed) value. */
export function subdomainProblem(sub: string): string | null {
  if (sub.length < 3 || sub.length > 32) return 'Use 3 to 32 characters.';
  if (!SUBDOMAIN_RE.test(sub)) return 'Use lowercase letters, numbers and hyphens only (not at the start or end).';
  if (sub.includes('--')) return 'Do not use two hyphens in a row.';
  if (RESERVED_SUBDOMAINS.includes(sub)) return `"${sub}" is reserved for ZapTill.`;
  return null;
}

/**
 * 2026-10-03 (A386): an address suggested from the business name — "African Fries" → "africanfries" (letters and digits
 * only, at most 32). '' when nothing usable comes out (too short, reserved). The admin still confirms it.
 */
export function suggestSubdomain(businessName: unknown): string {
  const s = String(businessName ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '').slice(0, 32);
  return subdomainProblem(s) ? '' : s;
}

/**
 * A value to store: the cleaned subdomain, null to clear (empty / null), or undefined when it cannot be used (the caller
 * refuses it with subdomainProblem's reason).
 */
export function cleanSubdomain(raw: unknown): string | null | undefined {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  return subdomainProblem(s) ? undefined : s;
}

/** The root domain from configuration, cleaned ("Zaptill.co.ke." → "zaptill.co.ke"); '' when unset. */
export function cleanRootDomain(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase().replace(/^\.+|\.+$/g, '') : '';
}

/**
 * The client's subdomain in a hostname ("africanfries.zaptill.co.ke" → "africanfries"), or null: no root configured,
 * another domain, the root itself, a deeper name ("a.b.zaptill.co.ke"), a reserved name (app., www., …) or a malformed one.
 */
export function subdomainFromHost(hostname: unknown, rootDomain: unknown): string | null {
  const root = cleanRootDomain(rootDomain);
  if (!root || typeof hostname !== 'string') return null;
  const host = hostname.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.+$/, '');
  if (!host.endsWith(`.${root}`)) return null;
  const label = host.slice(0, -(root.length + 1));
  if (!label || label.includes('.')) return null;
  return subdomainProblem(label) ? null : label;
}

/**
 * May a browser on this origin call the cloud? An https address on the root domain itself or one level under it (a
 * client's address, or one of ours such as app.). Never http, never a deeper name, never a look-alike
 * ("evilzaptill.co.ke", "zaptill.co.ke.evil.com").
 */
export function isTenantOrigin(origin: unknown, rootDomain: unknown): boolean {
  const root = cleanRootDomain(rootDomain);
  if (!root || typeof origin !== 'string') return false;
  let u: URL;
  try { u = new URL(origin); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  if (origin !== u.origin) return false;                    // an Origin header is scheme://host[:port] and nothing else
  const host = u.hostname.toLowerCase();
  if (host === root) return true;
  if (!host.endsWith(`.${root}`)) return false;
  const label = host.slice(0, -(root.length + 1));
  return !!label && !label.includes('.') && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label);
}
