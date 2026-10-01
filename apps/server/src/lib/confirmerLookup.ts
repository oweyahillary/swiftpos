/**
 * confirmerLookup.ts — who a manager's PIN belongs to (A365 shift confirmation; 0.6.28 the web POS's kitchen voids).
 *
 * Moved out of routes/shifts.ts unchanged so routes/orders.ts can ask the same question: the refund rule's lookup
 * (findApprover — the login PIN or the override PIN), widened to anyone who may confirm a shift (mayConfirm: the owner,
 * a manager/supervisor/admin role, or orders.void / shifts.manage / settings.manage).
 */
import bcrypt from 'bcrypt';
import { supabase } from './supabase';
import { findApprover, type ApproverRow } from './approver';
import { mayConfirm } from './shiftConfirm';
import { verifyPin } from '../routes/auth';

export async function confirmerRows(businessId: string) {
  const [{ data: rows }, { data: biz }] = await Promise.all([
    supabase
      .from('users')
      .select('id, name, pin_hash, override_pin_hash, roles ( name, role_permissions ( permissions ( key ) ) ), user_permissions ( granted, permissions ( key ) )')
      .eq('business_id', businessId)
      .eq('status', 'active'),
    supabase.from('businesses').select('owner_id').eq('id', businessId).maybeSingle(),
  ]);
  return { rows: (rows ?? []) as (ApproverRow & { name?: string | null })[], ownerId: ((biz as any)?.owner_id ?? null) as string | null };
}

export async function confirmerByPin(businessId: string, pin: string, authorizerId?: string) {
  const { rows, ownerId } = await confirmerRows(businessId);
  const found = await findApprover(rows, { pin, authorizerId, ownerId, may: mayConfirm }, {
    loginPin:    async (p, h) => (await verifyPin(p, h, businessId)).valid,
    overridePin: (p, h) => bcrypt.compare(p, h),
  });
  if (found.result !== 'ok') return null;
  const row = rows.find((r) => r.id === found.userId);
  return { id: found.userId, name: row?.name ?? null };
}
