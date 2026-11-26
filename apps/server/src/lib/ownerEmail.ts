/**
 * ownerEmail.ts — the owner's email for a billing notice/receipt: the auth user's email, falling back to the business
 * email. Moved here from jobs/cloudPlanReminders so both the reminders job and cloud billing (lib/cloudBillingAllocate)
 * can use it without a lib↔job import cycle.
 */
import { supabase } from './supabase';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function ownerEmailOf(ownerId: string | null | undefined, fallback: string | null | undefined): Promise<string | null> {
  if (ownerId && UUID_RE.test(ownerId)) {
    try {
      const { data, error } = await supabase.auth.admin.getUserById(ownerId);
      const e = !error ? data?.user?.email?.trim() : null;
      if (e) return e;
    } catch { /* fall through to the business email */ }
  }
  const f = String(fallback ?? '').trim();
  return f.includes('@') ? f : null;
}
