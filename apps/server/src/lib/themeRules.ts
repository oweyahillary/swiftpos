/**
 * themeRules.ts — A325: the two theme rules the cloud enforces, as PURE functions (no database, no client), so
 * tests can run them directly. The one query (is the flag on?) is in themeAccess.ts.
 */
import { isThemeId, DEFAULT_THEME_ID, cleanBrandHex, type ThemeId } from '@zaptill/core/themes';

/** feature_flags key that turns themes on for a business (premium; OFF by default — A323). */
export const THEMES_FLAG = 'themes';

/** What /api/pos/init serves as `themeId`: null while themes are off (the till keeps today's look, pixel for pixel),
 *  otherwise the chosen id — or the default (Ocean) when nothing, or an unknown/retired id, is stored. */
export function effectiveThemeId(enabled: boolean, stored: unknown): ThemeId | null {
  if (!enabled) return null;
  return isThemeId(stored) ? stored : DEFAULT_THEME_ID;
}

/** A branding write's theme_id: null clears it (always allowed); choosing a theme needs the business's flag.
 *  Returns the error message, or null when acceptable. */
export function themeWriteError(value: unknown, enabled: boolean): string | null {
  if (value === null) return null;
  if (!isThemeId(value)) return 'theme_id must be one of the curated themes (or null)';
  if (!enabled) return 'Themes are not enabled for this business';
  return null;
}

// ── A597: the owner's brand colours (primary / secondary) ────────────────────────────────────────────────────────────
/** The two branding fields that are the owner's alone and need the business's `themes` flag. */
export const BRAND_COLOUR_FIELDS = ['primary_hex', 'secondary_hex'] as const;
export type BrandColourField = typeof BRAND_COLOUR_FIELDS[number];

/** A branding write's primary_hex / secondary_hex: any #rrggbb colour (never refused for legibility — the apps derive
 *  readable shades, themes.ts brandTokens) or null to clear. Only the business OWNER, signed in as themselves (never a
 *  partner, a manager or a POS's own session), and only while the business has themes. Returns the refusal, or null.
 *  `status` 400 = a bad value, 403 = not allowed. Clearing (null) needs the owner too, but not the flag — so an owner can
 *  always remove a colour, even after the premium switch is turned off. */
export function brandColourWriteError(field: BrandColourField, value: unknown, who: { owner: boolean; enabled: boolean }):
  { status: 400 | 403; error: string; code: string } | null {
  if (!who.owner) return { status: 403, error: 'Only the owner chooses the brand colours.', code: 'OWNER_ONLY' };
  if (value === null) return null;
  if (!cleanBrandHex(value)) return { status: 400, error: `${field} must be a #rrggbb hex colour (or null)`, code: 'BAD_COLOUR' };
  if (!who.enabled) return { status: 403, error: 'Brand colours are part of Themes, which is not enabled for this business - ask ZapTill.', code: 'THEMES_OFF' };
  return null;
}

/** What the POS is served as the business's brand colours: none while themes are off (today's look). */
export function effectiveBrandColours(enabled: boolean, row: { primary_hex?: unknown; secondary_hex?: unknown } | null | undefined):
  { primaryHex: string | null; secondaryHex: string | null } {
  if (!enabled) return { primaryHex: null, secondaryHex: null };
  return { primaryHex: cleanBrandHex(row?.primary_hex), secondaryHex: cleanBrandHex(row?.secondary_hex) };
}
