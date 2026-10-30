/**
 * themeAccess.ts — A325 (client branding Phase 2, slice 2): is a business allowed to use themes?
 * A per-business feature flag, feature_flags key 'themes', OFF by default — the premium switch (A323). Same table
 * and shape as 'web_hosting' (lib/webAccess.ts); switched from the admin portal. The rules that use the answer are
 * pure functions in themeRules.ts.
 */
import { supabase } from './supabase';
import { THEMES_FLAG } from './themeRules';
export { THEMES_FLAG, effectiveThemeId, themeWriteError, brandColourWriteError, effectiveBrandColours, BRAND_COLOUR_FIELDS } from './themeRules';

export async function themesEnabled(businessId: string): Promise<boolean> {
  const { data } = await supabase
    .from('feature_flags')
    .select('enabled')
    .eq('business_id', businessId)
    .eq('key', THEMES_FLAG)
    .maybeSingle();
  return data?.enabled === true;
}

/** A597: migration 179's columns. A read that names them on a database not yet migrated is retried without them, so the
 *  Branding page, the dashboard and every POS's pull keep working whatever order the deploy and the migration land in. */
const BRAND_COLOUR_COLUMN = /primary_hex|secondary_hex/;
export function withoutBrandColourColumns(columns: string): string {
  return columns.split(',').map((c) => c.trim()).filter((c) => !BRAND_COLOUR_COLUMN.test(c)).join(', ');
}
export function isMissingBrandColourColumn(error: { message?: string; code?: string } | null | undefined): boolean {
  return !!error && BRAND_COLOUR_COLUMN.test(String(error.message ?? '')) && (error.code === '42703' || /does not exist|column/i.test(String(error.message ?? '')));
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function selectBusinessBranding(businessId: string, columns: string): Promise<{ data: any; error: any }> {
  const read = (cols: string) => supabase.from('business_branding').select(cols).eq('business_id', businessId).maybeSingle();
  const r = await read(columns);
  if (isMissingBrandColourColumn(r.error)) return read(withoutBrandColourColumns(columns));
  return r;
}
