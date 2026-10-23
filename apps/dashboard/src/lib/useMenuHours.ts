/**
 * useMenuHours.ts — A578: the web POS (CashierScreen, MinimartPOS) and menus by time of day (shared/menuHours.ts).
 *
 * Works out, by this browser's clock, which menus are open now: the menus and categories to give the menu
 * bar and the ☰ panel, which items are asleep (off the grid, the All tab and search; refused when scanned or tapped),
 * the tabs' hints ("until 11:00"). One timer to the next opening or closing (never a poll; at most an hour, for a
 * clock moved by hand or a till asleep), and a look again when the window comes back to the front.
 *
 * The till has the same hook (apps/desktop/src/renderer/lib/useMenuHours.ts) — the two differ only in their import path.
 */
import { useEffect, useMemo, useState } from 'react';
import { menuHoursView, menuTimerDelay, type HoursCategoryLike, type HoursMenuLike, type MenuHoursView } from './menuHours';

export function useMenuHours<M extends HoursMenuLike, C extends HoursCategoryLike>(
  menus: readonly M[], categories: readonly C[], opts: { cutoff?: number; showAll?: boolean; later?: boolean } = {},
): MenuHoursView<M, C> {
  const [now, setNow] = useState(() => new Date());
  const { cutoff = 0, showAll = false, later = false } = opts;   // A580: later — the closed menus greyed ("Later")
  const view = useMemo(() => menuHoursView(menus, categories, now, { cutoff, showAll, later }), [menus, categories, now, cutoff, showAll, later]);
  const nextMs = view.nextChange ? view.nextChange.getTime() : null;
  useEffect(() => {
    const delay = menuTimerDelay(nextMs === null ? null : new Date(nextMs), Date.now());
    if (delay === null) return;
    const t = setTimeout(() => setNow(new Date()), delay);
    return () => clearTimeout(t);
  }, [nextMs, now]);
  useEffect(() => {
    const again = () => { if (document.visibilityState !== 'hidden') setNow(new Date()); };
    window.addEventListener('focus', again);
    document.addEventListener('visibilitychange', again);
    return () => { window.removeEventListener('focus', again); document.removeEventListener('visibilitychange', again); };
  }, []);
  return view;
}
