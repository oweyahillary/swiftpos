/**
 * posFilter.ts — A279 (2026-09-28): say which filter the POS grid is showing.
 *
 * Owner idea 2026-09-15: the cashier POS shows category tabs but nothing says "you are looking at Soft Drinks only",
 * and a leftover search silently hides most of the menu ("No products found" with no way back but guessing). Built in
 * 0.6.18: a line under the tabs whenever a category or a search narrows the grid, with one Clear that restores All.
 *
 * Pure, so the test runs it.
 */
export interface FilterState { categoryName: string | null; search: string; count: number }

/** The summary line, or null when the grid shows everything (All, no search). */
export function filterSummary(f: FilterState): string | null {
  const q = f.search.trim();
  if (!f.categoryName && !q) return null;
  const parts = [f.categoryName, q ? `"${q}"` : null].filter(Boolean).join(' · ');
  return `Showing ${parts} — ${f.count} item${f.count === 1 ? '' : 's'}`;
}

/** What an empty grid says: why it is empty, so the cashier knows Clear will fix it. */
export function emptyGridMessage(f: FilterState): string {
  return filterSummary(f) ? 'Nothing matches this filter.' : 'No products found';
}
