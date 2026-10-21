/**
 * branchBrandingStore.ts — A544: a branch's override of the business branding (migration 156, public.branch_branding).
 *
 * Owner, 2026-10-21: "phase 2 branding — we need to do it before value add" … "yes start" (per-branch branding). The rules
 * (what may be stored, how a till resolves it) are the shared, pure lib/branchBranding.ts; this is the one read.
 *
 * Premium: served only while the business's `themes` flag is on (A325) — the caller decides (pos/init passes
 * `themesOn`); with it off a row is kept but never served, so no till or web POS applies it.
 */
import { supabase } from './supabase';
import type { BranchBranding } from './branchBranding';

export interface BranchBrandingRow {
  branch_id: string;
  theme_id: string | null;
  accent_hex: string | null;
  receipt_footer: string | null;
  updated_at?: string | null;
}
export const BRANCH_BRANDING_COLUMNS = 'branch_id, theme_id, accent_hex, receipt_footer, updated_at';

/** The row as a till stores it (pos/init `branchBranding`, the branch_branding change). */
export function branchBrandingWire(row: BranchBrandingRow | null | undefined): BranchBranding | null {
  if (!row?.branch_id) return null;
  if (row.theme_id == null && row.accent_hex == null && (row.receipt_footer == null || row.receipt_footer === '')) return null;
  return { branchId: row.branch_id, themeId: row.theme_id ?? null, accentHex: row.accent_hex ?? null, receiptFooter: row.receipt_footer ?? null };
}

/**
 * The override of ONE branch, as served — null when themes are off, there is none, or it cannot be read (before
 * migration 156 the table is not there: the pull carries no override, never an error).
 */
export async function servedBranchBranding(branchId: string | null | undefined, themesOn: boolean): Promise<BranchBranding | null> {
  if (!themesOn || !branchId) return null;
  try {
    const { data, error } = await supabase.from('branch_branding').select(BRANCH_BRANDING_COLUMNS).eq('branch_id', branchId).maybeSingle();
    if (error) return null;
    return branchBrandingWire(data as BranchBrandingRow | null);
  } catch { return null; }
}
