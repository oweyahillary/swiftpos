/**
 * androidApproval.ts — which Android app version each business may run, per surface (migration 189).
 *
 * Like the desktop's A348 (businesses.desktop_approved_version): NULL = HOLD, the default — a new release reaches a
 * client only once ZapTill approves it for them in the admin portal (routes/adminAndroid.ts). One column per surface, so
 * a client's shop tablets can stay on a version that works while the owner's phone takes a newer one.
 */
import { ANDROID_SURFACES, isAppVersion, type AndroidSurface } from '@zaptill/core/androidApp';
import { supabase } from './supabase';

export const APPROVAL_COLUMN: Record<AndroidSurface, 'android_till_approved_version' | 'mobile_approved_version'> = {
  'android-till': 'android_till_approved_version',
  mobile: 'mobile_approved_version',
};

export type AndroidApprovals = Record<AndroidSurface, string | null>;

/** The stored row → each surface's approved version; anything that is not x.y.z counts as held. */
export function approvalsOf(row: Record<string, unknown> | null | undefined): AndroidApprovals {
  const out = {} as AndroidApprovals;
  for (const s of ANDROID_SURFACES) {
    const v = row?.[APPROVAL_COLUMN[s]];
    out[s] = isAppVersion(v) ? v : null;
  }
  return out;
}

/**
 * The business's approvals. `missing` = the columns are not there yet (migration 189 not run): every surface held, and
 * the caller says so instead of failing.
 */
export async function readAndroidApprovals(businessId: string): Promise<{ approvals: AndroidApprovals; missing: boolean; error: unknown }> {
  const { data, error } = await supabase
    .from('businesses')
    .select(Object.values(APPROVAL_COLUMN).join(', '))
    .eq('id', businessId)
    .maybeSingle();
  if (error) {
    const missing = (error as { code?: string }).code === '42703' || /approved_version/.test(String((error as { message?: string }).message ?? ''));
    return { approvals: approvalsOf(null), missing, error: missing ? null : error };
  }
  return { approvals: approvalsOf(data as unknown as Record<string, unknown> | null), missing: false, error: null };
}
