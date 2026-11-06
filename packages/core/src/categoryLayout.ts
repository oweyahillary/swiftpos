/**
 * categoryLayout.ts — how a branch's POS shows its categories: the side panel behind ☰ (A537, today's look) or a bar of
 * category pills across the top of the grid (the look before A537). ONE file for the key, its values, the reader, the
 * cloud's check and the words both POS show the manager.
 *
 * Owner, 2026-11-05: "initially we used to have a horizontal navbar for categories then we introduced the current vertical
 * one can we have the option for both which can be toggled per branch by the manager? in the desktop app?" — and "yes we
 * are unifying them so no change hits one without the other being affected": the desktop POS and the web POS (and the
 * Android Shop POS, which runs the web POS's screens) read the same branch value and switch together.
 *
 *   Stored in branch_settings (a key/value row), set by a manager with settings.pos_layout (a Manager's by default —
 *   migration 190) or settings.branches for their own branch (the owner any branch) — POST /api/branches/:id/settings.
 *   Absent = 'panel', so nobody's screen changes until a manager chooses. Not premium: it works without the online licence.
 *
 * Pure: no imports. Used by the cloud (routes/branches.ts check, routes/pos.ts init), the desktop POS (main caches it,
 * Manager › Settings changes it) and the web dashboard (Settings › Branches › the branch, the web POS).
 */

/** The branch_settings key. */
export const CATEGORY_LAYOUT_KEY = 'pos_category_layout';

/** 'panel' — the side panel behind ☰ (A537); 'top' — a bar of category pills across the top of the grid. */
export const CATEGORY_LAYOUTS = ['panel', 'top'] as const;
export type CategoryLayout = (typeof CATEGORY_LAYOUTS)[number];

/**
 * Who may change it (any one of these): settings.pos_layout — owner, 2026-11-05: "lets go with your recommendations since
 * in future we might get more items under POS layout" — or settings.branches (the branch's own settings, as before), so the
 * owner, a General Manager and the holders of settings.manage are unaffected. The cloud, the desktop and the web read this.
 */
export const CATEGORY_LAYOUT_PERMISSIONS = ['settings.pos_layout', 'settings.branches'] as const;

/** No choice made: today's side panel. */
export const DEFAULT_CATEGORY_LAYOUT: CategoryLayout = 'panel';

/** The cloud's check: the stored value, or null when it is not one of the two (refused, never stored). */
export function categoryLayoutSettingValue(raw: unknown): CategoryLayout | null {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return (CATEGORY_LAYOUTS as readonly string[]).includes(v) ? (v as CategoryLayout) : null;
}

/** The reader every POS uses: anything that is not a known value (absent, an older build's, garbled) is the panel. */
export function categoryLayoutOf(raw: unknown): CategoryLayout {
  return categoryLayoutSettingValue(raw) ?? DEFAULT_CATEGORY_LAYOUT;
}

/** The words both POS show the manager — the same on the desktop's Manager › Settings and the web's branch page. */
export const CATEGORY_LAYOUT_WORDS = {
  title: 'Categories on the POS',
  explain: 'How this branch\'s POS shows the categories: a side panel opened with ☰, or a bar across the top of the items.',
  options: [
    { value: 'panel' as CategoryLayout, label: 'Side panel', hint: 'Behind ☰ at the left of the search (the standard)' },
    { value: 'top' as CategoryLayout, label: 'Top bar', hint: 'Every category as a button across the top' },
  ],
  saved: 'Saved for this branch',
} as const;
