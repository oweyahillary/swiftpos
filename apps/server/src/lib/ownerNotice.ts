/**
 * ownerNotice.ts — A522: one in-app notification to the business owner, best-effort.
 *
 * Owner, 2026-10-17: "check if anything will break or fail to respond because a till has not responded, I know not all
 * tills will run 24/7". When the cloud acts without a till (a drawer closed on the web, a day closed as abandoned) and the
 * till later sends something that does not agree — its own count, sales made after the close — the owner is told, once,
 * in the notifications list. Never throws: a notice that could not be written must not fail the sale or the sync behind it.
 */
import { supabase } from './supabase';

export async function notifyOwner(businessId: string, branchId: string | null, type: string, title: string, message: string,
  link = '/dashboard/shifts'): Promise<void> {
  try {
    const { data: biz } = await supabase.from('businesses').select('owner_id').eq('id', businessId).maybeSingle();
    const ownerId = (biz as { owner_id?: string | null } | null)?.owner_id ?? null;
    const { error } = await supabase.from('notifications').insert({
      business_id: businessId, branch_id: branchId, user_id: ownerId, type, title: title.slice(0, 200), message: message.slice(0, 1000), link,
    });
    if (error) console.error('[ownerNotice] not written:', error.message);
  } catch (e) {
    console.error('[ownerNotice] not written:', (e as Error)?.message ?? e);
  }
}

/** A money figure as the notices write it: "KES 1,250". */
export function kes(n: number | string | null | undefined, currency = 'KES'): string {
  const v = Math.round(Number(n ?? 0) * 100) / 100;
  return `${currency} ${v.toLocaleString('en-KE')}`;
}
