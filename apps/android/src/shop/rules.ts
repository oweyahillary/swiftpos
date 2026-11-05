/**
 * rules.ts — the Shop POS's own rules, pure (Till stage 1, docs/ANDROID-APP-DESIGN.md §11). No imports that run, so
 * tests/android-till-stage1.test.mjs loads this file as it is.
 *
 * What a person reads says "POS", never "till" (A586); a technician joins the tablet (owner, 2026-11-05: "joining should
 * be done by a tech").
 */

// ── The branch server's beacon (A427; apps/desktop serverBeacon.ts parseBeacon — the same checks) ────────────────────────

export const BEACON_MAGIC = 'ZAPTILL-SERVER/1';

export interface FoundServer { url: string; ip: string; port: number; business: string | null; server: string | null }

/** A beacon heard from `ip`, or null for anything that is not one of ours. Never trusts a port outside 1-65535. */
export function parseBeacon(text: string, ip: string): FoundServer | null {
  if (typeof text !== 'string' || text.length > 2048) return null;
  let b: Record<string, unknown>;
  try { b = JSON.parse(text) as Record<string, unknown>; } catch { return null; }
  if (!b || b.magic !== BEACON_MAGIC) return null;
  const port = Number(b.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) return null;
  const words = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : null);
  return { url: `http://${ip}:${port}`, ip, port, business: words(b.business), server: words(b.server) };
}

/** Every server heard, once per address. */
export function serversHeard(heard: Array<{ ip: string; text: string }>): FoundServer[] {
  const found = new Map<string, FoundServer>();
  for (const h of heard) { const f = parseBeacon(h.text, h.ip); if (f) found.set(f.url, f); }
  return [...found.values()];
}

/** "Join the Westlands server at 192.168.1.20?" */
export function joinQuestion(s: FoundServer): string {
  const name = s.server || s.business || 'branch';
  return `Join the ${name} server at ${s.ip}?`;
}

/**
 * The branch server's grant is used only for THIS app's cloud: a server on the shop network that names another cloud is
 * refused (the desktop's A494 sameCloud check) — a stranger's "server" cannot send the tablet to its own sign-in.
 */
export function sameCloud(a: string, b: string): boolean {
  const norm = (u: string) => String(u || '').trim().replace(/\/+$/, '').toLowerCase();
  return !!norm(a) && norm(a) === norm(b);
}

// ── The enrolment code (A69: the technician reads both halves out of the admin portal) ────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Why the typed business ID / code cannot be sent yet, or null. */
export function joinFormProblem(businessId: string, code: string, name: string): string | null {
  if (!UUID_RE.test(businessId.trim())) return 'Enter the business ID exactly as the admin portal shows it.';
  if (code.trim().length < 6) return 'Enter the enrolment code from the admin portal.';
  if (!name.trim()) return 'Give this POS a name, for example "Front counter".';
  return null;
}

/** The cloud's refusal of an enrolment, in words for the technician. */
export function joinRefusal(code: string | null, fallback: string): string {
  switch (code) {
    case 'ENROL_INVALID': return 'That code is wrong, expired or already used. Issue a new one in the admin portal.';
    case 'CLOUD_SUBSCRIPTION_ENDED': return "This client's cloud plan has lapsed — a POS cannot join until the payment is recorded.";
    case 'ACCOUNT_SUSPENDED': return 'This business is suspended. Contact ZapTill.';
    case 'OFFLINE': return 'No internet. Connect this tablet to the shop Wi-Fi and try again.';
    default: return fallback;
  }
}

// ── The POS's own session ────────────────────────────────────────────────────────────────────────────────────────────

/** When a JWT expires (ms since 1970), or 0 when it cannot be read — a token that cannot be read is renewed. */
export function tokenExpiresAt(jwt: string): number {
  try {
    const part = jwt.split('.')[1] ?? '';
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='));
    const exp = Number((JSON.parse(json) as { exp?: unknown }).exp);
    return Number.isFinite(exp) ? exp * 1000 : 0;
  } catch { return 0; }
}

/** Renew a minute before it runs out, so no call meets an expired token. */
export function needsRenewal(jwt: string, now: number): boolean { return tokenExpiresAt(jwt) - now < 60_000; }

// ── Staff PINs (online, Till stage 1) ────────────────────────────────────────────────────────────────────────────────

export const PIN_MIN = 4;
export const PIN_MAX = 6;

/** The cloud's refusal of a PIN, in words for the person at the counter. */
export function pinRefusal(status: number, code: string | null, fallback: string): string {
  if (code === 'OFFLINE') return NO_CONNECTION;
  if (code === 'ONLINE_LICENCE_REQUIRED' || code === 'BRANCH_NOT_LICENSED' || code === 'PIN_NOT_UNIQUE') return fallback;
  if (status === 429) return 'Too many PIN attempts — wait a minute and try again.';
  if (status === 401) return 'That PIN is not right.';
  return fallback;
}

export const NO_CONNECTION = "No connection — can't sell. Check the shop Wi-Fi or the internet; this POS sells only while online.";

/** What the web POS screens are handed after a PIN sign-in (their CashierSession). Pure. */
export function cashierSessionFrom(a: {
  accessToken?: string; token?: string; refreshToken?: string;
  staff: { id: string; name: string; role?: string | null }; permissions?: Record<string, boolean>;
}, till: { branchId: string; branchName: string; businessType: string; currency: string }) {
  return {
    token: a.accessToken ?? a.token ?? '',
    refreshToken: a.refreshToken ?? '',
    staffId: a.staff.id,
    staffName: a.staff.name,
    role: a.staff.role ?? '',
    branchId: till.branchId,
    branchName: till.branchName,
    businessType: till.businessType,
    currency: till.currency,
    permissions: a.permissions ?? {},
  };
}

// ── Printing ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The network printer a web POS print names. The web POS addresses a printer as "printer:<its name>"; on a Shop POS the
 * name is the printer's address on the shop network — "192.168.1.50" or "192.168.1.50:9100" (port 9100 when none).
 */
export function printerAddress(target: string): { host: string; port: number } | null {
  const name = String(target ?? '').replace(/^printer:/, '').trim();
  const m = /^([A-Za-z0-9.-]{1,253}?)(?::(\d{1,5}))?$/.exec(name);
  if (!m) return null;
  const host = m[1];
  const port = m[2] ? Number(m[2]) : 9100;
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(host) && host.split('.').every((o) => Number(o) <= 255);
  const hostname = /^[A-Za-z0-9]([A-Za-z0-9-]{0,62})(\.[A-Za-z0-9]([A-Za-z0-9-]{0,62}))*$/.test(host) && !/^[\d.]+$/.test(host);
  if (!(ipv4 || hostname) || port < 1 || port > 65535) return null;
  return { host, port };
}

/** Words when a printer's name is not an address the tablet can reach. */
export function notAnAddress(target: string): string {
  const name = String(target ?? '').replace(/^printer:/, '').trim() || '(no name)';
  return `The printer "${name}" has no network address. On a Shop POS, set the printer's name to its address on the shop network, for example 192.168.1.50. The sale is saved.`;
}

/**
 * The branch server's /node/print answer, as the web POS screens count prints. Anything but 200 printed nothing there, so
 * the tablet prints the ticket directly instead (shop/branchServer.ts) — the words say so.
 */
export function serverPrintResult(status: number, body: { ok?: boolean; skipped?: string[]; failed?: string[]; problem?: string | null } | null) {
  const skipped = body?.skipped ?? [], failed = body?.failed ?? [];
  const missing = skipped.length + failed.length;
  if (status === 200) {
    return { printed: missing ? 0 : 1, failed: missing, configured: 1, problem: body?.problem ?? null };
  }
  const why = body?.problem || 'The branch server did not print this ticket.';
  return { printed: 0, failed: 1, configured: 1, problem: `${why} Printing straight to this POS's printers instead.` };
}

/** The branch server this POS prints through did not answer: say what happens instead, and that nothing is lost. */
export const SERVER_NOT_ANSWERING = 'The branch server is not answering — tickets go straight to the printers set up on this POS. If nothing prints, the sale is still saved: reprint it from History when a printer is back.';
