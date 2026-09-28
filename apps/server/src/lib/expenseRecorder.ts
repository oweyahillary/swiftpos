// expenseRecorder.ts — who RECORDED an expense (A361, 2026-09-28; owner: "expense should also capture who recorded it").
//
// The signed-in account, never the form. Staff: req.userId is always a users.id. An owner signed in through Supabase may
// have no users row (see inventory.ts), so theirs is used only when it names a users row of this business — otherwise NULL
// rather than a broken foreign key (expenses.recorded_by REFERENCES users).
import type { Request } from 'express';
import { supabase } from './supabase';

export async function recorderId(req: Request): Promise<string | null> {
  if (!req.userId) return null;
  if (!req.isOwner) return req.userId;
  const { data } = await supabase.from('users').select('id')
    .eq('id', req.userId).eq('business_id', req.businessId).maybeSingle();
  return (data as { id?: string } | null)?.id ?? null;
}
