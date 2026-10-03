import { supabase } from './supabase';
import { supportWire, type SupportWire } from './support';

/**
 * supportContact.ts — 0.6.35 (A384): the tech allocated to a client (admin portal), as the till and the web receive it.
 *
 * null = no tech, a tech no longer active, or one with no number → the Help shows SwiftPOS support's numbers. Never
 * throws: a failed read is null (SwiftPOS support), never a broken pos/init.
 */
export async function getSupportContact(businessId: string | undefined | null): Promise<SupportWire | null> {
  if (!businessId) return null;
  try {
    const { data: biz } = await supabase
      .from('businesses').select('support_admin_id').eq('id', businessId).maybeSingle();
    const techId = (biz as any)?.support_admin_id;
    if (!techId) return null;
    const { data: tech } = await supabase
      .from('admin_users').select('name, phone, is_active').eq('id', techId).maybeSingle();
    if (!tech || (tech as any).is_active === false) return null;
    return supportWire({ name: (tech as any).name, phone: (tech as any).phone });
  } catch {
    return null;
  }
}
