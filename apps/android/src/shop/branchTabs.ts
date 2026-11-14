/**
 * branchTabs.ts — Till stage 3b (client): the Shop POS's typed client for the branch node's shared held-order store
 * (apps/desktop nodeTabs.ts, served as /node/tabs… — see docs/BUILD-TILL-STAGE-3B-SERVER.md). A tab (held order) opened
 * on one till is registered to the node so another till/tablet SEES it, and editing/charging/clearing it requires holding
 * its lock (a 90-second lease, atomic claim — two tills can never both hold it).
 *
 * Every call goes over the joined server's pinned TLS (branchServer.nodeRequest); the branch access code (X-Node-Secret)
 * is added for us, and this POS proves which it is with x-device-id (the LOCK HOLDER is the proven device — the server
 * derives `who` from it, exactly as /node/verify-pin does). The staff display name rides in the body so another waiter is
 * shown "Held by Jane", not a device id.
 *
 * Preference-with-fallback: when there is no ServerLink, or the server does not answer, a call returns a neutral
 * `unreachable` result and the caller stays LOCAL-only — a POS with no branch server is byte-for-byte unchanged (the shell
 * does not even install the host seam without a link). Pure parsers are split out so this is tested without a device.
 */
import { readServerLink, nodeRequest, type ServerLink, type NodeResponse } from './branchServer';
import { deviceId } from './tillSession';

/** A tab as the node lists it (nodeTabs.TabRow + the computed `locked`). cart is JSON text on the wire. */
export interface NodeTab {
  id: string; branch_id: string; order_number: string; label: string;
  order_type: string; table_number: string;
  cart: unknown; opened_by: string; opened_at: string;
  last_changed_by: string | null; last_changed_at: string | null;
  locked_by: string | null; lock_expires: string | null; locked: boolean;
}

export interface TabInput {
  id: string; branch_id: string; order_number: string; label: string;
  order_type: string; table_number?: string; cart: unknown; opened_by: string;
}

/** The outcome of trying to take a tab's lock, as the caller drives the see-it-then-take-over UX. */
export type ClaimOutcome =
  | { outcome: 'claimed'; tab: NodeTab; stole: boolean }   // we hold it now (stole = took a LAPSED lease — show a toast)
  | { outcome: 'locked'; lockedBy: string }                // 409: a LIVE foreign lock — read-only + manager take-over
  | { outcome: 'unreachable' };                            // no link / server silent → caller falls back to local-only

export type EditOutcome =
  | { outcome: 'ok'; tab: NodeTab }
  | { outcome: 'lost'; lockedBy?: string }                 // 423/409: our lease lapsed or the tab is gone
  | { outcome: 'unreachable' };

// ── pure parsers (tested without a device) ─────────────────────────────────────────────────────────────────────────────

function parseTab(v: unknown): NodeTab | null {
  const o = (v && typeof v === 'object') ? v as Record<string, unknown> : null;
  if (!o || typeof o.id !== 'string') return null;
  return {
    id: o.id, branch_id: String(o.branch_id ?? ''), order_number: String(o.order_number ?? ''),
    label: String(o.label ?? ''), order_type: String(o.order_type ?? ''), table_number: String(o.table_number ?? ''),
    cart: typeof o.cart === 'string' ? safeJson(o.cart) : (o.cart ?? []),
    opened_by: String(o.opened_by ?? ''), opened_at: String(o.opened_at ?? ''),
    last_changed_by: o.last_changed_by == null ? null : String(o.last_changed_by),
    last_changed_at: o.last_changed_at == null ? null : String(o.last_changed_at),
    locked_by: o.locked_by == null ? null : String(o.locked_by),
    lock_expires: o.lock_expires == null ? null : String(o.lock_expires),
    locked: !!o.locked,
  };
}
function safeJson(s: string): unknown { try { return JSON.parse(s); } catch { return []; } }

/** Classify a /node/tabs/:id/claim (or /force-claim) answer (PURE). null = request threw → unreachable. */
export function readClaimOutcome(r: NodeResponse | null): ClaimOutcome {
  if (!r) return { outcome: 'unreachable' };
  if (r.status === 404 || r.status === 503) return { outcome: 'unreachable' };   // old build / node transport
  const body = r.body ? safeJson(r.body) : null;
  const o = (body && typeof body === 'object') ? body as Record<string, unknown> : {};
  if (r.status >= 200 && r.status < 300 && o.ok) {
    const tab = parseTab(o.tab);
    if (tab) return { outcome: 'claimed', tab, stole: !!o.stole };
    return { outcome: 'unreachable' };
  }
  if (r.status === 409) return { outcome: 'locked', lockedBy: String(o.lockedBy ?? o.locked_by ?? '') };
  return { outcome: 'unreachable' };   // any other non-2xx → be safe, stay local
}

/** Classify a /node/tabs/:id edit (PURE). 423/409 = we no longer hold it. */
export function readEditOutcome(r: NodeResponse | null): EditOutcome {
  if (!r) return { outcome: 'unreachable' };
  if (r.status === 404 || r.status === 503) return { outcome: 'unreachable' };
  const body = r.body ? safeJson(r.body) : null;
  const o = (body && typeof body === 'object') ? body as Record<string, unknown> : {};
  if (r.status >= 200 && r.status < 300 && o.ok) { const t = parseTab(o.tab); return t ? { outcome: 'ok', tab: t } : { outcome: 'unreachable' }; }
  if (r.status === 423 || r.status === 409) return { outcome: 'lost', lockedBy: o.lockedBy ? String(o.lockedBy) : undefined };
  return { outcome: 'unreachable' };
}

export function parseTabList(r: NodeResponse | null): NodeTab[] {
  if (!r || r.status < 200 || r.status >= 300) return [];
  const body = r.body ? safeJson(r.body) : null;
  const rows = Array.isArray(body) ? body : (body && typeof body === 'object' ? (body as { tabs?: unknown }).tabs : null);
  return Array.isArray(rows) ? rows.map(parseTab).filter((t): t is NodeTab => !!t) : [];
}

// ── IO (injectable deps; defaults use the pinned-TLS native path) ───────────────────────────────────────────────────────

export interface BranchTabsDeps {
  link?: () => Promise<ServerLink | null>;
  request?: (link: ServerLink, method: 'GET' | 'POST', path: string, body: string | undefined, headers: Record<string, string>) => Promise<NodeResponse | null>;
  device?: () => Promise<string>;
}

async function call(path: string, method: 'GET' | 'POST', body: string | undefined, deps: BranchTabsDeps):
  Promise<{ link: ServerLink; r: NodeResponse | null } | null> {
  const link = await (deps.link ?? readServerLink)();
  if (!link) return null;
  const device = await (deps.device ?? deviceId)();
  const send = deps.request ?? ((l: ServerLink, m: 'GET' | 'POST', p: string, b: string | undefined, h: Record<string, string>) => nodeRequest(l, m, p, b, h));
  try {
    const r = await send(link, method, path, body, { 'x-device-id': device });
    return { link, r };
  } catch { return { link, r: null }; }   // never let a transport throw escape — the caller stays local
}

/** Every open tab the node holds for this branch (∪ with the till's own local tabs, by the caller). [] when no server/answer. */
export async function listTabs(branchId: string, deps: BranchTabsDeps = {}): Promise<NodeTab[]> {
  const c = await call(`/node/tabs?branch_id=${encodeURIComponent(branchId)}`, 'GET', undefined, deps);
  return c ? parseTabList(c.r) : [];
}

/** Register (upsert) an opened tab so other tills see it. Best-effort; a silent server leaves the tab local-only. */
export async function registerTab(t: TabInput, deps: BranchTabsDeps = {}): Promise<void> {
  await call('/node/tabs', 'POST', JSON.stringify({ ...t, cart: t.cart }), deps);
}

/** Take the lock to edit/charge. Auto-wins an unlocked / mine / LAPSED tab; 409 on a LIVE foreign lock. */
export async function claimTab(id: string, name: string, deps: BranchTabsDeps = {}): Promise<ClaimOutcome> {
  const c = await call(`/node/tabs/${encodeURIComponent(id)}/claim`, 'POST', JSON.stringify({ name }), deps);
  return c ? readClaimOutcome(c.r) : { outcome: 'unreachable' };
}

/** Manager-approved take-over of a LIVE lock (the caller gates this on a manager PIN). Audited at the node. */
export async function forceClaim(id: string, name: string, deps: BranchTabsDeps = {}): Promise<ClaimOutcome> {
  const c = await call(`/node/tabs/${encodeURIComponent(id)}/force-claim`, 'POST', JSON.stringify({ name }), deps);
  return c ? readClaimOutcome(c.r) : { outcome: 'unreachable' };
}

/** Save the cart and RENEW the lease (only the holder may). 'lost' = our lease lapsed / was stolen. */
export async function updateTab(id: string, cart: unknown, label: string | undefined, deps: BranchTabsDeps = {}): Promise<EditOutcome> {
  const c = await call(`/node/tabs/${encodeURIComponent(id)}`, 'POST', JSON.stringify({ cart, label }), deps);
  return c ? readEditOutcome(c.r) : { outcome: 'unreachable' };
}

/** Give up the lock without other change (parked away / hold-again). Best-effort. */
export async function releaseTab(id: string, deps: BranchTabsDeps = {}): Promise<void> {
  await call(`/node/tabs/${encodeURIComponent(id)}/release`, 'POST', undefined, deps);
}

/** Remove the tab from the node — 'charged' (routine) or 'cleared' (audited). Best-effort. */
export async function deleteTab(id: string, reason: 'charged' | 'cleared', deps: BranchTabsDeps = {}): Promise<void> {
  await call(`/node/tabs/${encodeURIComponent(id)}/delete`, 'POST', JSON.stringify({ reason }), deps);
}
