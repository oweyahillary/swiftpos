/**
 * tillScope.ts — A490: what a till's OWN sign-in may do (no person signed in on it).
 *
 * A till signs in as itself (A415) to send its sales, drawers and days and pull its menu. Its token carried '*', so
 * every permission check let it through — a leaked till token could read every report and change any setting a
 * permission guards (writes were held only by the terminal-write guard, itself dry-run). A person signed in on the till
 * uses their OWN token for anything a permission guards; the till's token needs only what the till does by itself.
 *
 * TILL_KEYS is that list, measured from the till's code (2026-10-15): branch prices it pushes (menu.prices), a forced
 * close it relays (shifts.force_close), the logo it relays (receipt.manage), station routing (stations.manage),
 * wastage it relays (inventory.waste), and selling.
 *
 * DRY-RUN by default — the same as the terminal-write guard: a check outside the list is LOGGED ("would refuse") and
 * allowed, so a missed entry cannot stop a shop's sales syncing. Set TILL_SCOPE_ENFORCE=true once the log is clean.
 */
import type { Request } from 'express';

export const TILL_KEYS: ReadonlySet<string> = new Set([
  'orders.create', 'menu.prices', 'shifts.force_close', 'receipt.manage', 'stations.manage', 'inventory.waste',
]);

export const TILL_SCOPE_ENFORCE = String(process.env.TILL_SCOPE_ENFORCE || '').toLowerCase() === 'true';

const warned = new Map<string, number>();

/**
 * A545: a sale the till ALREADY TOOK, pushed under the till's own sign-in — POST /api/orders (the sync push / replay),
 * carrying the till's own time (created_at / client_created_at: the P0-2 till-sale shape), from a till token naming
 * itself (req.deviceId comes from the token, never a header or the body). Never /:id/pay or /open (live, at a counter).
 */
export function isTillOwnSalePush(req: Request): boolean {
  const body = (req as { body?: { created_at?: unknown; client_created_at?: unknown } }).body;
  const path = String(req.originalUrl || req.url || '').split('?')[0].replace(/\/+$/, '');
  return req.isTill === true && !!req.deviceId && req.method === 'POST' && path === '/api/orders'
    && !!(body?.created_at || body?.client_created_at);
}

/**
 * A545: the PRECISE exemptions — a key the till's own sign-in may pass on ONE request shape only, never a blanket key in
 * TILL_KEYS. Owner, 2026-10-21: "for credit I think the manager has to know which sale is on credit and they have to
 * confirm that it was done." A credit sale a till already took is RECORDED (awaiting a manager's confirmation,
 * lib/creditConfirm.ts), never refused for a manager's PIN the till cannot send (A534's audit: the one refusal left under
 * TILL_SCOPE_ENFORCE). The till's token still cannot manage credit (limits, repayments, adjustments, confirming).
 */
export const TILL_EXEMPTIONS: ReadonlyArray<{ key: string; why: string; applies: (req: Request) => boolean }> = [
  { key: 'customers.credit', why: "A545: the till's push of a credit sale it already took", applies: isTillOwnSalePush },
];

/** May the till's own sign-in pass a check for any of `keys`? Logged (once an hour per key and path) when not. */
export function tillMay(req: Request, keys: string[], log: (line: string) => void = console.warn): boolean {
  if (keys.some((k) => TILL_KEYS.has(k))) return true;
  if (TILL_EXEMPTIONS.some((x) => keys.includes(x.key) && x.applies(req))) return true;   // A545
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  const key = `${keys.join('|')} ${req.method} ${path}`;
  const now = Date.now();
  if ((warned.get(key) ?? 0) < now - 3_600_000) {
    warned.set(key, now);
    log(`[tillScope] ${TILL_SCOPE_ENFORCE ? 'REFUSED' : 'DRY-RUN would refuse'}: a till's own sign-in (device ${req.deviceId ?? '?'}) asked for ${keys.join(' / ')} on ${req.method} ${path}`);
  }
  return !TILL_SCOPE_ENFORCE;
}
