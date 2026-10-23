// IPC: A564 — find an item in another branch's stock, and ask that branch for it (Manager › Stock › Other branches).
// Owner, 2026-10-22: "add a feature where employees can search if items are in an inventory of another branch and the
// manager can request for them".
//
// Everything here is the cloud's (routes/stock.ts): other branches' stock is never on this till. Each call goes with the
// signed-in person's own sign-in (manageFetch) — through the branch server on a till that has one (A410: only the server
// talks to the cloud at a branch). No connection → "Needs a connection", never an old figure.
//   branchStock:find      inventory.view          GET  /api/stock/other-branches
//   branchStock:requests  inventory.transfer      GET  /api/stock/requests
//   branchStock:request   inventory.transfer      POST /api/stock/requests                (for this branch)
//   branchStock:decide    inventory.transfer      POST /api/stock/requests/:id/accept|decline|cancel
// Shown with the online licence only, as Transfers (A460).
import { assertPayload } from '../ipcValidate';
import { OFFLINE_SESSION_MESSAGE } from '../offlineSession';
import { syncAll } from '../syncEngine';
import { type IpcShared } from './shared';

export const NEEDS_CONNECTION = 'Needs a connection — other branches\' stock is on the cloud. Try again once this till is online.';
export const FIND_REFUSED = 'Your role does not see stock.';
export const REQUEST_REFUSED = 'Only a manager who transfers stock can ask another branch for it.';
export const DECIDE_STEPS = ['accept', 'decline', 'cancel'] as const;

export type BranchStockAnswer<T> = { ok: true; data: T } | { ok: false; offline: boolean; error: string; code: string | null };

/** The cloud's answer, or why not: no connection (no HTTP status — the network, the branch server's uplink, an
 *  offline sign-in) is "offline", said plainly; a refusal keeps the cloud's own words and code. */
export async function cloudAnswer<T>(fn: () => Promise<T>): Promise<BranchStockAnswer<T>> {
  try { return { ok: true, data: await fn() }; }
  catch (e: any) {
    if (typeof e?.status === 'number') return { ok: false, offline: false, error: e?.message ?? 'The cloud refused this.', code: e?.code ?? null };
    return { ok: false, offline: true, error: e?.message === OFFLINE_SESSION_MESSAGE ? OFFLINE_SESSION_MESSAGE : NEEDS_CONNECTION, code: null };
  }
}

/** The search as it is sent: trimmed, at most 60 characters; under 2 letters is not sent. */
export function findQuery(q: unknown): string | null {
  const t = typeof q === 'string' ? q.trim().slice(0, 60) : '';
  return t.length >= 2 ? t : null;
}

export function registerBranchStockHandlers(ctx: Pick<IpcShared, 'handle' | 'requireKey' | 'manageFetch' | 'transferBranch' | 'requireOnlineLicence'>) {
  const { handle, requireKey, manageFetch, transferBranch, requireOnlineLicence } = ctx;

  handle('branchStock:find', async (_e, payload) => {
    const p = assertPayload<{ q?: string; product_id?: string }>({ q: { t: 'string', optional: true }, product_id: { t: 'string', optional: true } }, payload);
    requireOnlineLicence();
    requireKey(['inventory.view'], FIND_REFUSED);
    const productId = String(p.product_id ?? '').trim();
    const q = findQuery(p.q);
    if (!productId && !q) return { ok: false, offline: false, error: 'Type at least 2 letters of the item.', code: 'SEARCH_TOO_SHORT' };
    const qs = productId ? `product_id=${encodeURIComponent(productId)}` : `q=${encodeURIComponent(q as string)}`;
    return cloudAnswer(() => manageFetch(`/api/stock/other-branches?${qs}&limit=20`, 'GET'));
  });

  handle('branchStock:requests', async () => {
    requireOnlineLicence();
    requireKey(['inventory.transfer'], REQUEST_REFUSED);
    if (!transferBranch()) return { ok: false, offline: false, error: 'This till is not bound to a branch.', code: null };
    return cloudAnswer(() => manageFetch('/api/stock/requests?limit=100', 'GET'));
  });

  handle('branchStock:request', async (_e, payload) => {
    const p = assertPayload<{ from_branch_id: string; product_id: string; quantity: number; note?: string }>(
      { from_branch_id: { t: 'string', min: 1 }, product_id: { t: 'string', min: 1 }, quantity: { t: 'number' }, note: { t: 'string', optional: true } }, payload);
    requireOnlineLicence();
    requireKey(['inventory.transfer'], REQUEST_REFUSED);
    const to = transferBranch();   // always FOR this branch (the person's, else this till's) — the cloud checks it is theirs
    if (!to) return { ok: false, offline: false, error: 'This till is not bound to a branch.', code: null };
    if (!(p.quantity > 0)) return { ok: false, offline: false, error: 'Ask for a quantity above 0.', code: 'INVALID_QUANTITY' };
    return cloudAnswer(() => manageFetch('/api/stock/requests', 'POST',
      { from_branch_id: p.from_branch_id, to_branch_id: to, product_id: p.product_id, quantity: p.quantity, note: p.note?.trim() || undefined }));
  });

  handle('branchStock:decide', async (_e, payload) => {
    const p = assertPayload<{ id: string; step: string; reason?: string; quantity?: number }>(
      { id: { t: 'string', min: 1 }, step: { t: 'string', min: 1 }, reason: { t: 'string', optional: true }, quantity: { t: 'number', optional: true } }, payload);
    requireOnlineLicence();
    requireKey(['inventory.transfer'], REQUEST_REFUSED);
    if (!(DECIDE_STEPS as readonly string[]).includes(p.step)) return { ok: false, offline: false, error: 'Unknown step.', code: null };
    if (p.step === 'decline' && !p.reason?.trim()) return { ok: false, offline: false, error: 'Say why it is declined.', code: 'REASON_REQUIRED' };
    const body = p.step === 'decline' ? { reason: p.reason?.trim() } : p.step === 'accept' && p.quantity !== undefined ? { quantity: p.quantity } : {};
    const id = encodeURIComponent(p.id);
    // Each step its own path, written out (the terminal-write guard's scan reads every cloud write of the till).
    const send = p.step === 'accept' ? () => manageFetch(`/api/stock/requests/${id}/accept`, 'POST', body)
      : p.step === 'decline' ? () => manageFetch(`/api/stock/requests/${id}/decline`, 'POST', body)
      : () => manageFetch(`/api/stock/requests/${id}/cancel`, 'POST', body);
    const r = await cloudAnswer(send);
    // Accepted: the stock left this branch (a despatched transfer) — this till's levels follow now, not at the next pull.
    if (r.ok && p.step === 'accept') void syncAll().catch(() => { /* the next pull brings them */ });
    return r;
  });
}
