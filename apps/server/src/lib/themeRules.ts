/**
 * themeRules.ts — A325: the two theme rules the cloud enforces, as PURE functions (no database, no client), so
 * tests can run them directly. The one query (is the flag on?) is in themeAccess.ts.
 */
import { isThemeId, DEFAULT_THEME_ID, type ThemeId } from './themes';

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
