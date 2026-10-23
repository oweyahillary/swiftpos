import type { Request, Response } from 'express';
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { supabase } from '../lib/supabase';
import { requireAuth } from '../middleware/auth';
import { requireAnyPermission, requirePermission, assertBranchAccess, can } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import { CreateBranchSchema, UpdateBranchSchema } from '../lib/schemas';
import { cutoffSettingValue } from '../lib/businessDay';   // 0.6.34
import { CASHIER_HISTORY_METHODS_KEY, historyMethodsSettingValue } from '../lib/cashierHistory';   // 0.6.37 (A387)
import { PAYMENT_METHODS_ENABLED_KEY, enabledSettingValue } from '../lib/paymentCatalogue';   // A429
import { invalidateHistoryMethods } from '../lib/historyMethods';
import { invalidateDayCutoff } from '../lib/dayCutoff';
import { cleanMpesaReceive, mpesaFromSettings, mpesaLabel, mpesaDescribe, type MpesaReceive } from '../lib/mpesaReceive';   // A492
import { maySetMpesa } from '../lib/permissions';                 // A492
import { permissionsOpenBefore } from '../lib/permissionsState'; // A492
import { hiddenWhileCounting } from '../lib/stockTakeAccess';     // A494

const router = safeRouter();

/**
 * A494: the columns a branch is read with — EXPLICIT, never '*'. '*' sent tech_reveal_code (the code that surfaces the
 * technician prompt on a till) to every signed-in user, and the admin e-mails behind desktop_licensed_by /
 * mode_switched_by; a column added later would have gone out the same way. A new column a screen needs is added here.
 */
export const BRANCH_PUBLIC_COLUMNS = 'id, business_id, name, address, phone, city, country, is_main, status, created_at, updated_at, '
  + 'desktop_licensed, deploy_mode, web_sync_enabled';

/** A582: a partner (lib/webPartners.ts) reads a branch named in the path only when it is theirs — another branch of the
 *  business is "not found" to them (its name, address, staff and settings). The owner and managers as before. */
const partnerOutside = (req: any, branchId: string): boolean => req.webPartner === true && !assertBranchAccess(req, branchId);

// GET /api/branches — list all branches for this business
router.get('/', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('branches')
    .select(BRANCH_PUBLIC_COLUMNS)
    .eq('business_id', req.businessId)
    .order('is_main', { ascending: false })
    .order('created_at', { ascending: true });

  if (error) { sendError(res, error); return; }
  // A550: a partner who works at some branches is offered those in the dashboard's picker (one of every branch: all).
  if (req.webPartner && !req.allBranches) {
    res.json(((data ?? []) as unknown as Array<{ id: string }>).filter((b) => req.partnerBranches.includes(b.id)));
    return;
  }
  res.json(data);
});

// GET /api/branches/:id
router.get('/:id', requireAuth, async (req, res) => {
  if (partnerOutside(req, req.params.id)) { res.status(404).json({ error: 'Branch not found' }); return; }   // A582
  const { data, error } = await supabase
    .from('branches')
    .select(BRANCH_PUBLIC_COLUMNS)   // A494
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)
    .single();

  if (error) { res.status(404).json({ error: 'Branch not found' }); return; }
  res.json(data);
});

// POST /api/branches — BLOCKED for owner tokens
// Branch creation is admin-portal-only to enforce the per-branch licensing fee (KES 30,000).
// Clients cannot self-provision branches. Contact SwiftPOS to add a branch.
router.post('/', requireAuth, (_req, res) => {
  res.status(403).json({
    error: 'Branch creation is managed by ZapTill agents. Contact ZapTill to add a branch.',
    code:  'BRANCH_CREATION_RESTRICTED',
  });
});

// ── Audit 2026-10-14: every write here is gated ───────────────────────────────
// The update / set-main / deactivate / stock routes were requireAuth ONLY: any signed-in cashier could rename or close a
// branch, move the main branch, or set any stock level — and the stock route never checked the branch was this
// business's, so it wrote another tenant's stock. Every write now needs its key (settings.manage for the branch itself,
// inventory.adjust for stock; the owner and '*' pass in rbac), the branch must be THIS business's (404 otherwise), and a
// non-owner may touch only the branch they are signed in at (assertBranchAccess).

/** The branch row when :id is this business's and the caller may act on it; otherwise the response is sent and null. */
async function branchForWrite(req: Request, res: Response, branchId: string, cols = 'id'): Promise<Record<string, any> | null> {
  const { data, error } = await supabase
    .from('branches').select(cols).eq('id', branchId).eq('business_id', req.businessId).maybeSingle();
  if (error) { sendError(res, error); return null; }
  if (!data) { res.status(404).json({ error: 'Branch not found' }); return null; }
  if (!assertBranchAccess(req, branchId)) { res.status(403).json({ error: 'You do not have access to this branch' }); return null; }
  return data as unknown as Record<string, any>;
}

// PUT /api/branches/:id — update branch
router.put('/:id', requireAuth, requirePermission('settings.branches'), validate(UpdateBranchSchema), async (req, res) => {
  const { name, address, phone, status } = req.body;

  const branch = await branchForWrite(req, res, req.params.id, 'id, is_main');
  if (!branch) return;
  // The same rule as DELETE: the main branch is never closed (PUT { status: 'inactive' } was a way round it).
  if (status === 'inactive' && branch.is_main) { res.status(400).json({ error: 'Cannot deactivate the main branch' }); return; }

  const { data, error } = await supabase
    .from('branches')
    .update({ name, address, phone, status, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)
    .select()
    .single();

  if (error) { sendError(res, error); return; }
  res.json(data);
});

// PUT /api/branches/:id/set-main — change main branch
router.put('/:id/set-main', requireAuth, requirePermission('settings.branches'), async (req, res) => {
  // The target must be this business's (and the caller's) BEFORE the current main is unset — an unknown id used to leave
  // the business with no main branch at all.
  if (!(await branchForWrite(req, res, req.params.id))) return;

  // Unset current main
  await supabase
    .from('branches')
    .update({ is_main: false })
    .eq('business_id', req.businessId);

  // Set new main
  const { data, error } = await supabase
    .from('branches')
    .update({ is_main: true, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)
    .select()
    .single();

  if (error) { sendError(res, error); return; }
  res.json(data);
});

// DELETE /api/branches/:id — deactivate branch
router.delete('/:id', requireAuth, requirePermission('settings.branches'), async (req, res) => {
  const branch = await branchForWrite(req, res, req.params.id, 'id, is_main');
  if (!branch) return;
  if (branch.is_main) { res.status(400).json({ error: 'Cannot deactivate the main branch' }); return; }

  const { error } = await supabase
    .from('branches')
    .update({ status: 'inactive', updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('business_id', req.businessId);

  if (error) { sendError(res, error); return; }
  res.json({ success: true });
});

// GET /api/branches/:id/staff
router.get('/:id/staff', requireAuth, requirePermission('staff.view'), async (req, res) => {   // A490: staff.view
  if (partnerOutside(req, req.params.id)) { res.status(404).json({ error: 'Branch not found' }); return; }   // A582
  // Audit 2026-10-14: user_branches has no business_id — without this, any signed-in user read another tenant's staff
  // (names, emails, phones) by branch id.
  if (!(await assertOwnBranch(req.businessId, req.params.id))) { res.status(404).json({ error: 'Branch not found' }); return; }
  const { data, error } = await supabase
    .from('user_branches')
    .select(`
      user_id,
      users (id, name, email, phone, status, role_id,
        roles (name)
      )
    `)
    .eq('branch_id', req.params.id);

  if (error) { sendError(res, error); return; }

  const staff = (data ?? []).map((row: any) => ({
    ...row.users,
    role_name: row.users?.roles?.name ?? null,
  }));

  res.json(staff);
});

// GET /api/branches/:id/stock
// A494: any signed-in user read any branch's stock by naming it — the caller's own branch only (the owner any), and
// blind for the items a count at that branch is counting.
router.get('/:id/stock', requireAuth, async (req, res) => {
  if (!assertBranchAccess(req, req.params.id)) { res.status(403).json({ error: 'You do not have access to this branch' }); return; }
  const { data, error } = await supabase
    .from('stock_levels')
    .select(`
      *,
      products!inner (id, name, base_price, status, business_id,
        categories (name)
      )
    `)
    .eq('branch_id', req.params.id)
    .eq('products.business_id', req.businessId)
    .order('quantity', { ascending: true });

  if (error) { sendError(res, error); return; }
  const hide = await hiddenWhileCounting(req, req.params.id);
  res.json(hide.size ? ((data ?? []) as any[]).map((r) => (hide.has(`p:${r.product_id}`) ? { ...r, quantity: null, qty_pieces: null, counting: true } : r)) : data);
});

// PUT /api/branches/:id/stock/:productId — adjust stock
// Audit 2026-10-14: was requireAuth only, with no tenant, branch or product check and an unvalidated body.
router.put('/:id/stock/:productId', requireAuth, requireAnyPermission('inventory.adjust'), async (req, res) => {
  const { id: branch_id, productId: product_id } = req.params;
  const body = (req.body ?? {}) as { quantity?: unknown; low_stock_threshold?: unknown };
  const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  if (!finite(body.quantity)) { res.status(400).json({ error: 'quantity (a number) is required' }); return; }
  if (body.low_stock_threshold !== undefined && body.low_stock_threshold !== null
    && !(finite(body.low_stock_threshold) && (body.low_stock_threshold as number) >= 0)) {
    res.status(400).json({ error: 'low_stock_threshold must be a number of 0 or more' });
    return;
  }
  const quantity = body.quantity as number;

  if (!(await branchForWrite(req, res, branch_id))) return;
  const { data: product, error: pErr } = await supabase
    .from('products').select('id').eq('id', product_id).eq('business_id', req.businessId).maybeSingle();
  if (pErr) { sendError(res, pErr); return; }
  if (!product) { res.status(404).json({ error: 'Product not found' }); return; }

  // What it was, so the movement records the real change (it used to record the new level as the change).
  const { data: before } = await supabase
    .from('stock_levels').select('quantity').eq('branch_id', branch_id).eq('product_id', product_id).maybeSingle();
  const previous = Number((before as { quantity?: unknown } | null)?.quantity ?? 0) || 0;

  const row: Record<string, unknown> = { branch_id, product_id, quantity, updated_at: new Date().toISOString() };
  if (body.low_stock_threshold !== undefined) row.low_stock_threshold = body.low_stock_threshold;
  const { data, error } = await supabase
    .from('stock_levels')
    .upsert(row, { onConflict: 'product_id,branch_id' })
    .select()
    .single();

  if (error) { sendError(res, error); return; }

  const { error: mErr } = await supabase.from('stock_movements').insert({
    branch_id,
    product_id,
    movement_type: 'correction',
    quantity_change: quantity - previous,
    quantity_after: quantity,
    notes: 'Branch stock correction',
    created_by: req.userId,
  });
  if (mErr) console.error('[branches] stock correction movement not recorded:', mErr.message);

  res.json(data);
});

// A145: the branch-centric user-assignment routes were RETIRED here —
//   POST   /api/branches/:id/assign-user
//   DELETE /api/branches/:id/remove-user/:userId
// They were redundant with the staff flow (POST/PATCH /api/staff write
// user_branches, gated by requirePermission('staff.edit') + business/branch
// scoping) and, unlike that flow, were guarded by requireAuth ONLY — no
// permission, no business/branch scoping, service-role client — which allowed
// within-tenant privilege escalation and cross-tenant user_branches writes.
// Zero callers (dashboard/admin/desktop). Do NOT re-add a branch-centric writer
// without those guards; assign branches via the staff endpoints instead.

// A139: per-branch setting overrides (receipt text + hours) that supersede the
// business default. Only these three keys are overridable; the resolution
// (branch → business default) happens server-side in GET /pos/init, so the
// branch-bound till just receives its own values.
const OVERRIDABLE_KEYS = ['receipt_header', 'receipt_footer', 'continuous_operation', 'business_day_cutoff',   // 0.6.34 + the day's end
  'cashier_history_methods',   // 0.6.37 (A387): the methods a cashier's History shows
  'cashier_sees_shift_sales',   // A416: a cashier closing a shift sees their sales
  'cashier_history_totals',    // A418: a cashier's History shows the total of what is filtered
  'payment_methods_enabled',   // A429: the payment methods this branch takes
  'receipt_pay_label', 'receipt_pay_number', 'receipt_pay_account'];   // A450 / A492: each branch its own M-Pesa number

/** A490: the keys that may set one branch override (any one of them). */
export function branchSettingKeys(key: string): string[] {
  if (key === 'payment_methods_enabled') return ['settings.payments'];
  if (['receipt_header', 'receipt_footer'].includes(key)) return ['settings.branches', 'receipt.manage'];
  return ['settings.branches'];
}

// Confirms :id is a branch of THIS business — never let an owner read or write
// overrides on another tenant's branch (the till resolves by branch_id alone).
async function assertOwnBranch(businessId: string | undefined, branchId: string): Promise<boolean> {
  const { data } = await supabase
    .from('branches').select('id').eq('id', branchId).eq('business_id', businessId).maybeSingle();
  return !!data;
}

// GET /api/branches/:id/settings — this branch's overrides as a { key: value } map.
router.get('/:id/settings', requireAuth, async (req, res) => {
  if (partnerOutside(req, req.params.id)) { res.status(404).json({ error: 'Branch not found' }); return; }   // A582
  if (!(await assertOwnBranch(req.businessId, req.params.id))) {
    res.status(404).json({ error: 'Branch not found' });
    return;
  }
  const { data, error } = await supabase
    .from('branch_settings')
    .select('key, value')
    .eq('business_id', req.businessId)
    .eq('branch_id', req.params.id);
  if (error) { sendError(res, error); return; }
  const map: Record<string, string> = {};
  for (const row of data ?? []) map[(row as any).key] = (row as any).value;
  res.json(map);
});

// POST /api/branches/:id/settings — set or clear one override.
//   { key, value }        → upsert the override (branch value wins over default)
//   { key, value: null }  → delete the override (branch reverts to the default)
router.post('/:id/settings', requireAuth, requireAnyPermission('settings.branches', 'settings.payments', 'receipt.manage'), async (req, res) => {
  const { key, value } = req.body ?? {};
  if (!OVERRIDABLE_KEYS.includes(key)) {
    res.status(400).json({ error: 'That setting cannot be overridden per branch' });
    return;
  }
  // A492: the branch's M-Pesa number is set as one thing (Buy Goods, or Paybill with its account) on the till by its
  // manager — PUT /:id/mpesa — never piece by piece here.
  if (MPESA_KEYS.includes(key)) {
    res.status(400).json({ error: 'The branch\'s M-Pesa number is set on its till: Manager › Settings › M-Pesa.', code: 'MPESA_ON_TILL' });
    return;
  }
  // A490: the branch's payment methods are settings.payments; its receipt lines settings.branches or receipt.manage;
  // everything else settings.branches.
  const needed = branchSettingKeys(key);
  if (!can(req, ...needed)) { res.status(403).json({ error: 'Forbidden', detail: `Missing permission: ${needed[0]}` }); return; }
  if (!(await assertOwnBranch(req.businessId, req.params.id))) {
    res.status(404).json({ error: 'Branch not found' });
    return;
  }
  // Audit 2026-10-14: a manager with settings.manage changes their own branch's overrides, not another branch's.
  if (!assertBranchAccess(req, req.params.id)) {
    res.status(403).json({ error: 'You do not have access to this branch' });
    return;
  }
  if (value === null || value === undefined) {
    const { error } = await supabase
      .from('branch_settings')
      .delete()
      .eq('business_id', req.businessId)
      .eq('branch_id', req.params.id)
      .eq('key', key);
    if (error) { sendError(res, error); return; }
    res.json({ key, inherited: true });
    return;
  }
  // 0.6.34: a branch's own day end must be a valid time too (stored "HH:MM", like the business default).
  let stored = String(value);
  if (key === 'business_day_cutoff') {
    const clean = cutoffSettingValue(value);
    if (clean === null) { res.status(400).json({ error: 'The business day may end from 00:00 to 06:00 (HH:MM).' }); return; }
    stored = clean;
    invalidateDayCutoff(req.businessId);
  }
  // A429: the payment methods this branch takes — only catalogue codes.
  if (key === PAYMENT_METHODS_ENABLED_KEY) {
    const clean = enabledSettingValue(value);
    if (clean === null) { res.status(400).json({ error: 'Choose payment methods from the list.' }); return; }
    stored = clean;
  }
  // 0.6.37 (A387): a branch's own History methods — a list of method codes ([] = every method).
  if (key === CASHIER_HISTORY_METHODS_KEY) {
    const clean = historyMethodsSettingValue(value);
    if (clean === null) { res.status(400).json({ error: 'Choose payment methods from the list.' }); return; }
    stored = clean;
    invalidateHistoryMethods(req.businessId);
  }
  const { error } = await supabase
    .from('branch_settings')
    .upsert(
      { business_id: req.businessId, branch_id: req.params.id, key, value: stored, updated_at: new Date().toISOString() },
      { onConflict: 'branch_id,key' },
    );
  if (error) { sendError(res, error); return; }
  res.json({ key, value: stored });
});

// ── A492: the branch's M-Pesa number ─────────────────────────────────────────────────────────────────────────────────
// Owner, 2026-10-15: "each branch has a till number or paybill number … that should be set on the desktop app not web,
// the manager should be the one doing it not the owner, if its paybill they have to set an account number if its buy
// goods they dont have to". It is where customers' money goes, so: its own permission (settings.mpesa — a manager's by
// default, the owner can take it away), a person's own sign-in only (never a till's own session), the manager's own
// branch only, and the owner is told of every change (notifications: from what, to what, who).
const MPESA_KEYS = ['receipt_pay_label', 'receipt_pay_number', 'receipt_pay_account'];

async function readBranchMpesa(businessId: string, branchId: string): Promise<{ own: MpesaReceive | null; inherited: MpesaReceive | null }> {
  const [{ data: b, error: bErr }, { data: d, error: dErr }] = await Promise.all([
    supabase.from('branch_settings').select('key, value').eq('business_id', businessId).eq('branch_id', branchId).in('key', MPESA_KEYS),
    supabase.from('business_settings').select('key, value').eq('business_id', businessId).in('key', MPESA_KEYS),
  ]);
  if (bErr || dErr) throw new Error((bErr ?? dErr)!.message);
  const pick = (rows: any[] | null) => {
    const m: Record<string, unknown> = {};
    for (const r of rows ?? []) m[r.key] = typeof r.value === 'string' ? r.value : r.value ?? '';
    return mpesaFromSettings(m.receipt_pay_label, m.receipt_pay_number, m.receipt_pay_account);
  };
  return { own: pick(b as any[]), inherited: pick(d as any[]) };
}

function mpesaAllowed(req: Request): boolean {
  if (req.isTill) return false;   // a person decides where money goes, never a till by itself
  if (req.isOwner) return true;
  return maySetMpesa(req.permissionKeys ?? [], permissionsOpenBefore());
}

// GET /api/branches/:id/mpesa — what the branch's customers pay to: its own, and (read-only) the business-wide value an
// older set-up left, which applies until the branch has its own.
router.get('/:id/mpesa', requireAuth, async (req, res) => {
  if (!(await assertOwnBranch(req.businessId, req.params.id))) { res.status(404).json({ error: 'Branch not found' }); return; }
  if (!assertBranchAccess(req, req.params.id)) { res.status(403).json({ error: 'You do not have access to this branch' }); return; }
  try {
    const r = await readBranchMpesa(req.businessId, req.params.id);
    res.json({ ...r, canEdit: mpesaAllowed(req) });
  } catch (e: any) { res.status(503).json({ error: `Could not read the M-Pesa number right now (${e?.message ?? e}).` }); }
});

// PUT /api/branches/:id/mpesa  { kind: 'buy_goods' | 'paybill', number, account? }  — or { clear: true }.
router.put('/:id/mpesa', requireAuth, async (req, res) => {
  if (!mpesaAllowed(req)) {
    res.status(403).json({ error: 'Your role may not change the branch\'s M-Pesa number.', detail: 'Missing permission: settings.mpesa' });
    return;
  }
  if (!(await assertOwnBranch(req.businessId, req.params.id))) { res.status(404).json({ error: 'Branch not found' }); return; }
  if (!assertBranchAccess(req, req.params.id)) { res.status(403).json({ error: 'You do not have access to this branch' }); return; }
  const clear = req.body?.clear === true;
  const cleaned = clear ? null : cleanMpesaReceive(req.body);
  if (cleaned && 'error' in cleaned) { res.status(400).json({ error: cleaned.error, code: 'MPESA_INVALID' }); return; }
  const next = cleaned && cleaned.ok ? cleaned.value : null;

  let before: MpesaReceive | null = null;
  try { before = (await readBranchMpesa(req.businessId, req.params.id)).own; }
  catch (e: any) { res.status(503).json({ error: `Could not read the M-Pesa number right now (${e?.message ?? e}).` }); return; }

  const now = new Date().toISOString();
  const base = { business_id: req.businessId, branch_id: req.params.id, updated_at: now };
  if (!next) {
    const { error } = await supabase.from('branch_settings').delete()
      .eq('business_id', req.businessId).eq('branch_id', req.params.id).in('key', MPESA_KEYS);
    if (error) { sendError(res, error); return; }
  } else {
    const rows = [
      { ...base, key: 'receipt_pay_label', value: mpesaLabel(next.kind) },
      { ...base, key: 'receipt_pay_number', value: next.number },
      ...(next.account ? [{ ...base, key: 'receipt_pay_account', value: next.account }] : []),
    ];
    // business_id: every row is built from `base`, which carries req.businessId (the branch is checked as this business's above).
    const { error } = await supabase.from('branch_settings').upsert(rows, { onConflict: 'branch_id,key' });
    if (error) { sendError(res, error); return; }
    if (!next.account) {
      const { error: dErr } = await supabase.from('branch_settings').delete()
        .eq('business_id', req.businessId).eq('branch_id', req.params.id).eq('key', 'receipt_pay_account');
      if (dErr) { sendError(res, dErr); return; }
    }
  }

  // The owner is told — this is where the branch's money goes. Never fails the change (it is saved).
  const changed = mpesaDescribe(before) !== mpesaDescribe(next);
  if (changed) {
    try {
      const [{ data: biz }, { data: br }, { data: who }] = await Promise.all([
        supabase.from('businesses').select('owner_id').eq('id', req.businessId).maybeSingle(),
        supabase.from('branches').select('name').eq('id', req.params.id).maybeSingle(),
        req.userId ? supabase.from('users').select('name').eq('id', req.userId).maybeSingle() : Promise.resolve({ data: null }),
      ]);
      const by = (who as any)?.name ?? (req.isOwner ? 'the owner' : 'a manager');
      const branchName = (br as any)?.name ?? 'a branch';
      const { error: nErr } = await supabase.from('notifications').insert({
        business_id: req.businessId, branch_id: req.params.id, user_id: (biz as any)?.owner_id ?? null,
        type: 'mpesa_changed',
        title: `${branchName}: M-Pesa number changed`,
        message: `${by} changed it from ${mpesaDescribe(before)} to ${mpesaDescribe(next)}. If you did not expect this, check it now — customers pay to this number.`,
        link: `/dashboard/branches/${req.params.id}`,
      });
      if (nErr) console.warn('[mpesa] A492: the owner could not be notified:', nErr.message);
      console.log(`[mpesa] A492: ${req.businessId} branch ${req.params.id}: ${mpesaDescribe(before)} -> ${mpesaDescribe(next)} by ${req.userId ?? '?'}`);
    } catch (e: any) { console.warn('[mpesa] A492: notification failed:', e?.message ?? e); }
  }
  res.json({ own: next, changed });
});

export default router;
