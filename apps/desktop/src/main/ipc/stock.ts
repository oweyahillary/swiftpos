// IPC: wastage (A414), expiring batches (A413) and stock transfers (A197).
// Registered from ipcHandlers.ts (D10); two register functions so the channels register in the order they always did.
import { assertPayload } from '../ipcValidate';
import { getLocalDb } from '../localDb';
import { mayWaste, recordingProblem, queueRecording, readPending as readPendingWaste, readRefused as readRefusedWaste, dismissRefused, ITEMS_KEY as WASTE_ITEMS_KEY, type WasteItem } from '../tillWastage';   // A414
import { v4 as uuid } from 'uuid';
import { syncAll, pushWastageNow } from '../syncEngine';
import { signedInCan } from '../tillAccess';
import { getDeviceConfig } from '../deviceConfig';
import { type IpcShared } from './shared';

/** A414: wastage recorded on the till; A413: expiring batches. */
export function registerWastageHandlers(ctx: IpcShared) {
  const { handle, requireKey, manageFetch, withoutCosts, requireOnlineLicence } = ctx;

  // ── A414: wastage recorded on the till — saved here first, sent to the cloud now or at the next sync ──────────────
  // Items: the cloud's list (with what the branch holds) when it can be reached, kept for offline use; else the last one
  // kept; else this till's own products. Ingredients come only from the cloud's list.
  const WASTE_REFUSED = 'Your role does not allow recording wastage.';
  handle('wastage:items', async () => {
    requireKey(['inventory.waste'], WASTE_REFUSED);   // A490: the list carries what the branch holds and its cost
    const db = getLocalDb();
    const branch = (db.prepare(`SELECT branch_id FROM staff_session WHERE id = 1`).get() as { branch_id?: string } | undefined)?.branch_id
      ?? getDeviceConfig()?.branch_id ?? '';
    try {
      const items = await manageFetch(`/api/wastage/items?branch_id=${encodeURIComponent(branch)}`, 'GET') as any[];
      db.prepare(`INSERT OR REPLACE INTO maintenance_state (key, value, updated_at) VALUES (?, ?, ?)`)
        .run(WASTE_ITEMS_KEY, JSON.stringify(items ?? []), new Date().toISOString());
      return { source: 'cloud', items: withoutCosts(items ?? []) };
    } catch {
      const kept = db.prepare(`SELECT value, updated_at FROM maintenance_state WHERE key = ?`).get(WASTE_ITEMS_KEY) as { value: string; updated_at: string } | undefined;
      if (kept?.value) { try { return { source: 'saved', saved_at: kept.updated_at, items: withoutCosts(JSON.parse(kept.value)) }; } catch { /* fall through */ } }
      // branch-wide: this till's own product list (the catalogue is the business's)
      const rows = db.prepare(`SELECT id, name, track_stock FROM products WHERE status = 'active' ORDER BY name`).all() as Array<{ id: string; name: string; track_stock: number }>;
      return { source: 'till', items: rows.map((p) => ({ kind: 'product', id: p.id, name: p.name, unit: null, by_piece: false, stocked: p.track_stock === 1, held: null, cost: null })) };
    }
  });
  handle('wastage:record', async (_e, payload: { reason: string; note?: string; items: any[] }) => {
    requireOnlineLicence();   // A460
    const db = getLocalDb();
    const staff = db.prepare(`SELECT staff_id, staff_name, role_name, permissions, branch_id FROM staff_session WHERE id = 1`).get() as
      { staff_id: string | null; staff_name: string; role_name: string | null; permissions: string; branch_id: string } | undefined;
    if (!staff) throw new Error('Not signed in');
    if (!mayWaste(staff.role_name, staff.permissions)) throw new Error('Your role does not allow recording wastage.');
    const items: WasteItem[] = (payload.items ?? []).map((i: any) => ({
      kind: i?.kind === 'ingredient' ? 'ingredient' : 'product', id: String(i?.id ?? ''), name: String(i?.name ?? ''), quantity: Number(i?.quantity),
    }));
    const rec = { client_id: uuid(), branch_id: staff.branch_id, reason: String(payload.reason ?? ''), note: String(payload.note ?? '').trim().slice(0, 300),
      items, recorded_by_name: staff.staff_name, recorded_by: staff.staff_id ?? null, recorded_at: new Date().toISOString() };   // A545: who
    const problem = recordingProblem(rec);
    if (problem) throw new Error(problem);
    queueRecording(db, rec);
    const outcome = (await pushWastageNow())[rec.client_id];
    return { client_id: rec.client_id, ...(outcome ?? { state: 'pending', message: 'Saved on this till — it goes to the cloud at the next sync.' }) };
  });
  handle('wastage:state', async () => {
    const db = getLocalDb();
    return { pending: readPendingWaste(db), refused: readRefusedWaste(db) };
  });
  handle('wastage:dismiss', async (_e, clientId: string) => { requireKey(['inventory.waste'], WASTE_REFUSED); dismissRefused(getLocalDb(), String(clientId)); return { ok: true }; });
  // A413: expired / expiring batches at this branch — the cloud's list; offline it says so.
  handle('batches:expiring', async () => {
    if (!signedInCan('inventory.view')) return { online: false, message: 'Your role does not see stock.' };   // A490
    try { return { online: true, ...(await manageFetch('/api/batches?soon_days=7', 'GET') as object) }; }
    catch (e: any) { return { online: false, message: e?.message ?? 'Could not reach the cloud.' }; }
  });
}

/** A197: stock transfers between branches. */
export function registerTransferHandlers(ctx: IpcShared) {
  const { handle, requireKey, manageFetch, transferBranch, requireOnlineLicence } = ctx;

  // ── A197: stock transfers between branches, on the till (online licence; inventory.transfer) ──────────────────────
  // Owner, 2026-10-13: "A197 … add it yes but it's tied to the online licence just like stock … inside the stock tab".
  // The cloud does the work (routes/stock.ts: pending → in_transit → received / cancelled; stock moves on each step).
  const transferAnswer = async (fn: () => Promise<any>) => {
    try { return { ok: true, data: await fn() }; }
    catch (e: any) { return { ok: false, error: e?.message ?? 'Could not reach the cloud', code: e?.code ?? null }; }
  };
  // A490: stock transfers — inventory.transfer.
  const TRANSFER_REFUSED = 'Your role does not transfer stock.';
  handle('transfers:list', async () => {
    requireOnlineLicence();
    requireKey(['inventory.transfer'], TRANSFER_REFUSED);
    const branch = transferBranch();
    if (!branch) return { ok: false, error: 'This till is not bound to a branch.' };
    const r = await transferAnswer(() => manageFetch(`/api/stock/transfers?branch_id=${encodeURIComponent(branch)}&limit=100`, 'GET'));
    return r.ok ? { ...r, branch_id: branch } : r;
  });
  handle('transfers:branches', async () => {
    requireOnlineLicence();
    requireKey(['inventory.transfer'], TRANSFER_REFUSED);
    const branch = transferBranch();
    return transferAnswer(async () => ((await manageFetch('/api/branches', 'GET')) ?? []).filter((b: any) => b.id !== branch)
      .map((b: any) => ({ id: b.id, name: b.name })));
  });
  handle('transfers:create', async (_e, payload) => {
    const { to_branch_id, notes, items } = assertPayload<{ to_branch_id: string; notes?: string; items: Array<{ product_id: string; quantity: number }> }>(
      { to_branch_id: { t: 'string', min: 1 }, notes: { t: 'string', optional: true }, items: { t: 'any' } }, payload);
    requireOnlineLicence();
    requireKey(['inventory.transfer'], TRANSFER_REFUSED);
    const from = transferBranch();
    if (!from) return { ok: false, error: 'This till is not bound to a branch.' };
    const clean = (Array.isArray(items) ? items : []).map((i) => ({ product_id: String(i?.product_id ?? ''), quantity: Number(i?.quantity) }))
      .filter((i) => i.product_id && Number.isFinite(i.quantity) && i.quantity > 0);
    if (!clean.length) return { ok: false, error: 'Add at least one item with a quantity.' };
    return transferAnswer(() => manageFetch('/api/stock/transfers', 'POST', { from_branch_id: from, to_branch_id, notes: notes?.trim() || undefined, items: clean }));
  });
  handle('transfers:status', async (_e, payload) => {
    const p = assertPayload<{ id: string; status: string; reason?: string; received_items?: unknown; receipt_note?: string; allow_same_user?: boolean }>(
      { id: { t: 'string', min: 1 }, status: { t: 'string', min: 1 }, reason: { t: 'string', optional: true }, received_items: { t: 'any', optional: true },
        receipt_note: { t: 'string', optional: true }, allow_same_user: { t: 'boolean', optional: true } }, payload);
    requireOnlineLicence();
    requireKey(['inventory.transfer'], TRANSFER_REFUSED);
    if (!['in_transit', 'received', 'cancelled'].includes(p.status)) return { ok: false, error: 'Unknown step.' };
    const { id, ...body } = p;
    const r = await transferAnswer(() => manageFetch(`/api/stock/transfers/${encodeURIComponent(id)}/status`, 'PATCH', body));
    if (r.ok && p.status !== 'cancelled') void syncAll().catch(() => { /* the stock levels follow on the next pull */ });
    return r;
  });
}
