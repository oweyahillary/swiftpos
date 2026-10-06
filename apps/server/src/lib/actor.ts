/**
 * actor.ts — who did it, for records that keep a name (stock counts, supplier bills and payments).
 *
 * A users row of this business (staff, or an owner who has one) gives its id and name; an owner signed in through
 * Supabase with no users row is "Owner" with no id (the id columns reference users, so never a broken key).
 */
import type { Request } from 'express';
import { supabase } from './supabase';

export async function actor(req: Request): Promise<{ id: string | null; name: string }> {
  if (req.isTill) return { id: null, name: 'Till' };   // A415: the till's own session names no person
  if (!req.userId) return { id: null, name: 'Owner' };
  const { data } = await supabase.from('users').select('id, name')
    .eq('id', req.userId).eq('business_id', req.businessId).maybeSingle();
  const row = data as { id?: string; name?: string } | null;
  if (row?.id) return { id: row.id, name: row.name || (req.isOwner ? 'Owner' : 'Staff') };
  return { id: null, name: 'Owner' };
}
