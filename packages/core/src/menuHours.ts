/**
 * menuHours.ts — A578: menus by time of day (Breakfast Mon–Fri 06:00–11:00, Lunch 11:00–16:00, an alcohol department
 * only in licensed hours …).
 *
 * Owner, 2026-10-23 (approved): each menu (a restaurant's Menus, a shop's Departments, anyone else's Groups — A573) may
 * carry optional availability: days of the week and one or more time windows. No schedule = always available (every
 * menu before A578, and the default). Stored as menus.availability (jsonb, migration 165):
 *
 *   null                                                  → always
 *   { "days": [1,2,3,4,5], "windows": [{ "start": "06:00", "end": "11:00" }] }   → Mon–Fri 06:00–11:00
 *   { "days": null, "windows": [{ "start": "22:00", "end": "02:00" }] }          → every night 22:00–02:00
 *   { "days": [0], "windows": [] }                                               → Sundays, all day
 *
 * 0 = Sunday … 6 = Saturday (Date.getDay(), as productDays / offers). A window's end is not included (11:00 is Lunch's).
 *
 * THE CLOCK. The till's own clock (offline too) and the browser's on the web POS — the machine's local time, as offers
 * (shared/offers.ts) and the business day (shared/businessDay.ts). The business day's cut-off (business_day_cutoff,
 * 00:00–06:00) decides which DAY a moment belongs to: with the day ending at 04:00, Saturday 01:30 is still Friday's
 * night, so "Fri 22:00–02:00" runs to 02:00 on Saturday morning and a Sunday-only menu does not open at Saturday-night
 * midnight. A window that ends before it starts runs past midnight and belongs to the day it STARTED (as an offer). With
 * the cut-off at midnight (the default) that is exactly the calendar rule.
 *
 * ON THE POS (till and web — menuHoursView): a menu outside its hours is HIDDEN from the top tabs (not greyed under
 * "Later": a cashier cannot sell from it, so a tab there would only be tapped and refused), its categories leave the ☰
 * panel and its items leave the grid, the All tab and search; an item scanned or tapped anyway is refused in plain words
 * (hoursRefusal — a licensed-hours alcohol department needs the scan refused, not only the tab hidden). An item in no
 * menu, or in a menu with no schedule, is never touched; fuel never. A person with menu.edit may switch on "Show all"
 * for the session (showAll). An open menu with hours carries a small hint on its tab ("until 11:00"). The bar changes
 * by itself at the next opening or closing (nextChange — one timer, never a poll).
 *
 * A580 (owner, 2026-10-23: "let it remain as built, but add a 'Later' button to the menu list to show closed menus in
 * greyed-out form"): closed menus stay hidden by default; ANY staff member may tap "Later" (session only, never stored)
 * to see them greyed on the bar with when they open ("from 17:00 (Mon–Sat)") — `later`. A greyed menu can be opened to
 * LOOK at its items (greyed tiles — laterPeek), but nothing in it is sold: the asleep map stays full, so hoursRefusal
 * still refuses with A578's words. The All tab and search stay as A578 (closed items left out). Distinct from the
 * manager's "Show all" (showAll — menu.edit), which brings everything back AND lets it be sold; Show all wins over Later.
 *
 * A stored value that cannot be read is treated as NO schedule — never hide a menu by mistake (as productDays).
 *
 * Pure (no React, no storage, no imports — Node runs it as is in the tests). Copied verbatim: shared/,
 * apps/desktop/src/shared/ (the till's sale screen), apps/dashboard/src/lib/ (the web POS and the Menus page),
 * apps/server/src/lib/ (the cloud checks what it stores) — scripts/check-shared-sync.mjs.
 */

export const MAX_MENU_WINDOWS = 6;
export const HOURS_DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
/** The week as an owner reads it: Monday first. */
export const WEEK_MON_FIRST = [1, 2, 3, 4, 5, 6, 0] as const;

export interface MenuWindow { start: string; end: string }
export interface MenuAvailability { days: number[] | null; windows: MenuWindow[] }
/** ok, or the words of the refusal (one shape — the server builds without strictNullChecks). */
export interface AvailabilityCheck { ok: boolean; value: MenuAvailability | null; error: string }

const DAY_MIN = 24 * 60;
const pad = (n: number) => String(n).padStart(2, '0');

/** "6:00" / "06:00" / "06:00:00" → "06:00"; undefined = not a time of day. */
export function cleanMenuTime(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(v.trim());
  if (!m) return undefined;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return undefined;
  return `${pad(h)}:${pad(min)}`;
}
const minutesOf = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/**
 * What the owner sent (an object, JSON text of one, or nothing) → the availability to store (null = always), or the
 * words of why not. Days: 0–6, sorted, de-duplicated; all seven = every day (null). Windows: at most six, each a start
 * and an end that differ; an end before the start runs past midnight. No days and no windows = always (null).
 */
export function checkAvailability(raw: unknown): AvailabilityCheck {
  const yes = (value: MenuAvailability | null): AvailabilityCheck => ({ ok: true, value, error: '' });
  const no = (error: string): AvailabilityCheck => ({ ok: false, value: null, error });
  if (raw === null || raw === undefined || raw === '') return yes(null);
  let v: unknown = raw;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s || s === 'null') return yes(null);
    try { v = JSON.parse(s); } catch { return no('The hours could not be read'); }
  }
  if (v === null) return yes(null);
  if (typeof v !== 'object' || Array.isArray(v)) return no('The hours must be days and times');
  const o = v as Record<string, unknown>;
  let days: number[] | null = null;
  if (o.days !== undefined && o.days !== null) {
    if (!Array.isArray(o.days)) return no('The days must be a list of days');
    const set = new Set<number>();
    for (const d of o.days) {
      const n = typeof d === 'string' && /^\d$/.test(d.trim()) ? Number(d) : d;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 6) return no('A day must be Sunday (0) to Saturday (6)');
      set.add(n);
    }
    if (set.size === 0) return no('Choose at least one day');
    days = set.size === 7 ? null : [...set].sort((a, b) => a - b);
  }
  const windows: MenuWindow[] = [];
  if (o.windows !== undefined && o.windows !== null) {
    if (!Array.isArray(o.windows)) return no('The times must be a list of from–to times');
    if (o.windows.length > MAX_MENU_WINDOWS) return no(`At most ${MAX_MENU_WINDOWS} times a day`);
    for (const w of o.windows) {
      const start = cleanMenuTime((w as Record<string, unknown> | null)?.start);
      const end = cleanMenuTime((w as Record<string, unknown> | null)?.end);
      if (!start || !end) return no('Each time needs a from and a to, like 06:00 and 11:00');
      if (start === end) return no(`${start} to ${end} is no time at all — the from and the to must differ`);
      if (!windows.some((x) => x.start === start && x.end === end)) windows.push({ start, end });
    }
    windows.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  }
  if (days === null && windows.length === 0) return yes(null);
  return yes({ days, windows });
}

/** The stored value as the POS reads it: a schedule, or null (always — also for anything unreadable). */
export function readAvailability(raw: unknown): MenuAvailability | null {
  const r = checkAvailability(raw);
  return r.ok ? r.value : null;
}

/** The business day a moment belongs to (0 = Sunday) and its minute within that business day (0 = the cut-off). */
function businessClock(now: Date, cutoff: number): { day: number; minute: number } {
  const c = Math.max(0, Math.min(360, Math.round(Number(cutoff) || 0)));
  const shifted = new Date(now.getTime() - c * 60_000);
  return { day: shifted.getDay(), minute: shifted.getHours() * 60 + shifted.getMinutes() };
}

/** Is a menu with this schedule open at `now` (local clock; `cutoff` = minutes after midnight the business day ends)? */
export function isMenuOpenAt(av: MenuAvailability | null, now: Date, cutoff = 0): boolean {
  if (!av) return true;
  const c = Math.max(0, Math.min(360, Math.round(Number(cutoff) || 0)));
  const { day, minute } = businessClock(now, c);
  const dayOk = (d: number) => !av.days || av.days.includes(d);
  if (av.windows.length === 0) return dayOk(day);
  for (const w of av.windows) {
    const s = (minutesOf(w.start) - c + DAY_MIN) % DAY_MIN;
    const e = (minutesOf(w.end) - c + DAY_MIN) % DAY_MIN;
    if (e > s) { if (dayOk(day) && minute >= s && minute < e) return true; }
    else {
      // runs past the business day's end: the evening part is today's, the early part yesterday's
      if (dayOk(day) && minute >= s) return true;
      if (dayOk((day + 6) % 7) && minute < e) return true;
    }
  }
  return false;
}

/**
 * The next moment (after `now`) at which any of these schedules opens or closes — the one timer the POS sets. null = no
 * change within the next eight days (no schedules, or every one always open / always shut).
 */
export function nextMenuChange(avs: ReadonlyArray<MenuAvailability | null>, now: Date, cutoff = 0): Date | null {
  const scheduled = avs.filter((a): a is MenuAvailability => !!a);
  if (scheduled.length === 0) return null;
  const c = Math.max(0, Math.min(360, Math.round(Number(cutoff) || 0)));
  const marks = new Set<number>([c]);
  for (const a of scheduled) for (const w of a.windows) { marks.add(minutesOf(w.start)); marks.add(minutesOf(w.end)); }
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const at: number[] = [];
  for (let d = 0; d <= 8; d++) {
    for (const m of marks) {
      const t = new Date(base.getFullYear(), base.getMonth(), base.getDate() + d, Math.floor(m / 60), m % 60, 0, 0).getTime();
      if (t > now.getTime()) at.push(t);
    }
  }
  at.sort((a, b) => a - b);
  const was = scheduled.map((a) => isMenuOpenAt(a, now, c));
  for (const t of at) {
    const d = new Date(t);
    if (scheduled.some((a, i) => isMenuOpenAt(a, d, c) !== was[i])) return d;
  }
  return null;
}

/** How long the POS waits before looking again: to the next change (+ a quarter second), never longer than an hour (a
 *  clock moved by hand, a laptop asleep), never shorter than a quarter second. null = no change coming: no timer. */
export function menuTimerDelay(next: Date | null, nowMs: number): number | null {
  if (!next) return null;
  return Math.max(250, Math.min(60 * 60_000, next.getTime() - nowMs + 250));
}

const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** The days in words, Monday first: "Every day", "Mon–Fri", "Sat, Sun", "Mon, Wed, Fri". */
export function daysLabel(days: readonly number[] | null): string {
  if (!days || days.length === 0 || days.length >= 7) return 'Every day';
  const idx = WEEK_MON_FIRST.map((d, i) => (days.includes(d) ? i : -1)).filter((i) => i >= 0);
  const runs: number[][] = [];
  for (const i of idx) { const r = runs[runs.length - 1]; if (r && r[r.length - 1] === i - 1) r.push(i); else runs.push([i]); }
  return runs.map((r) => r.length >= 3
    ? `${HOURS_DAY_SHORT[WEEK_MON_FIRST[r[0]]]}–${HOURS_DAY_SHORT[WEEK_MON_FIRST[r[r.length - 1]]]}`
    : r.map((i) => HOURS_DAY_SHORT[WEEK_MON_FIRST[i]]).join(', ')).join(', ');
}

/** The schedule in words: "Always", "Mon–Fri, 06:00–11:00", "Every day, 11:00–16:00 and 18:00–22:00", "Sun, all day". */
export function availabilityLabel(av: MenuAvailability | null): string {
  if (!av) return 'Always';
  const t = av.windows.length === 0 ? 'all day' : av.windows.map((w) => `${w.start}–${w.end}`).join(' and ');
  return `${daysLabel(av.days)}, ${t}`;
}

// ── The POS's view ───────────────────────────────────────────────────────────────────────────────────────────────────
export interface HoursMenuLike { id: string; name?: string; active?: boolean | number | null; deleted_at?: string | null; availability?: unknown }
export interface HoursCategoryLike { id: string; menu_id?: string | null }
export interface AsleepMenu { menuId: string; menuName: string; label: string }
export interface MenuHoursView<M, C> {
  /** The menus the POS shows now (an asleep one left out — unless Show all). */
  menus: M[];
  /** The categories the POS shows now (an asleep menu's left out — unless Show all). */
  categories: C[];
  /** Category id → the asleep menu it is under (empty with Show all). An item in one of these is off the grid and refused. */
  asleep: Map<string, AsleepMenu>;
  /** A tab's small hint, by menu id: "until 11:00" (open, with hours); with Show all an asleep one's "from 17:00". */
  hints: Record<string, string>;
  /** Some menu is outside its hours right now (the Show all switch and A580's Later are offered). */
  anyAsleep: boolean;
  /** A580: the asleep menus shown GREYED on the bar because "Later" is on (empty otherwise, and with Show all). */
  later: Set<string>;
  /** When the bar changes next (the POS's one timer), or null. */
  nextChange: Date | null;
}

const isOn = (v: unknown): boolean => v === undefined || v === null ? true : v === true || v === 1 || v === '1' || v === 'true';

/**
 * What the POS shows at `now`: the menus and categories to give the menu bar and the ☰ panel (shared/menuFilter.ts —
 * unchanged), which categories are asleep, the tabs' hints, and when to look again. `showAll` = a manager's "Show all"
 * for this session: everything shows, nothing is refused, the hints still say when each opens.
 */
export function menuHoursView<M extends HoursMenuLike, C extends HoursCategoryLike>(
  menus: readonly M[] | null | undefined, categories: readonly C[] | null | undefined, now: Date,
  opts: { cutoff?: number; showAll?: boolean; later?: boolean } = {},
): MenuHoursView<M, C> {
  const ms = Array.isArray(menus) ? menus : [];
  const cs = Array.isArray(categories) ? categories : [];
  const cutoff = opts.cutoff ?? 0;
  const live = ms.filter((m) => m && typeof m.id === 'string' && m.id && isOn(m.active) && !m.deleted_at);
  const asleepMenus = new Map<string, AsleepMenu>();
  const hints: Record<string, string> = {};
  const avs: Array<MenuAvailability | null> = [];
  for (const m of live) {
    const av = readAvailability(m.availability);
    avs.push(av);
    if (!av) continue;
    const open = isMenuOpenAt(av, now, cutoff);
    const next = nextMenuChange([av], now, cutoff);
    const soon = next && next.getTime() - now.getTime() <= 24 * 3600_000 ? hhmm(next) : null;
    if (open) { if (av.windows.length > 0 && soon) hints[m.id] = `until ${soon}`; }
    else {
      asleepMenus.set(m.id, { menuId: m.id, menuName: String(m.name ?? ''), label: availabilityLabel(av) });
      if (opts.showAll) hints[m.id] = soon ? `from ${soon}` : 'not today';
      else if (opts.later) hints[m.id] = laterHint(av, soon);
    }
  }
  const nextChange = nextMenuChange(avs, now, cutoff);
  if (opts.showAll || asleepMenus.size === 0) {
    return { menus: ms.slice(), categories: cs.slice(), asleep: new Map(), hints, anyAsleep: asleepMenus.size > 0, later: new Set(), nextChange };
  }
  const asleep = new Map<string, AsleepMenu>();
  for (const c of cs) { const a = c?.menu_id ? asleepMenus.get(c.menu_id) : undefined; if (a) asleep.set(c.id, a); }
  if (opts.later) {
    // A580: every menu on the bar (the asleep ones greyed), every category in the panel — but the asleep map stays full:
    // nothing under a greyed menu is sold (hoursRefusal), and its items show only when that menu is opened (laterPeek).
    return { menus: ms.slice(), categories: cs.slice(), asleep, hints, anyAsleep: true, later: new Set(asleepMenus.keys()), nextChange };
  }
  return {
    menus: ms.filter((m) => !asleepMenus.has(m?.id)),
    categories: cs.filter((c) => !asleep.has(c?.id)),
    asleep, hints, anyAsleep: true, later: new Set(), nextChange,
  };
}

/** A580: a greyed (Later) tab's hint — "from 17:00 (Mon–Sat)", "from 06:00", "Sat, Sun" (opens more than a day away). */
function laterHint(av: MenuAvailability, soon: string | null): string {
  const days = av.days && av.days.length > 0 && av.days.length < 7 ? daysLabel(av.days) : null;
  if (soon) return days ? `from ${soon} (${days})` : `from ${soon}`;
  return days ?? 'not today';
}

/**
 * A580: with "Later" on, an item under a greyed menu shows (as a greyed tile, never sold) when the cashier opened THAT menu
 * or one of its categories — never on the All tab or in a search (A578's rule stays). False without Later.
 */
export function laterPeek(
  p: HoursProductLike | null | undefined, view: Pick<MenuHoursView<unknown, unknown>, 'asleep' | 'later'>,
  scope: { menu?: string | null; category?: string | null; search?: string | null },
): boolean {
  if (!view.later || view.later.size === 0 || (scope.search ?? '').trim() !== '') return false;
  const a = itemAsleep(p, view);
  if (!a || !view.later.has(a.menuId)) return false;
  const c = p?.category_id ?? p?.categories?.id ?? null;
  return scope.menu === a.menuId || (!!c && scope.category === c);
}

export interface HoursProductLike { name?: string; category_id?: string | null; categories?: { id?: string | null } | null; is_fuel?: boolean | number | null }
/** The asleep menu an item is under right now, or null (no category, a menu that is open or has no hours, fuel). */
export function itemAsleep(p: HoursProductLike | null | undefined, view: Pick<MenuHoursView<unknown, unknown>, 'asleep'>): AsleepMenu | null {
  if (!p || p.is_fuel === true || p.is_fuel === 1 || view.asleep.size === 0) return null;
  const c = p.category_id ?? p.categories?.id ?? null;
  return c ? view.asleep.get(c) ?? null : null;
}
/** Off the grid, the All tab and search right now. */
export function hiddenByHours(p: HoursProductLike | null | undefined, view: Pick<MenuHoursView<unknown, unknown>, 'asleep'>): boolean {
  return itemAsleep(p, view) !== null;
}
/** Why an item scanned or tapped is not sold now, in plain words — or null (it sells). */
export function hoursRefusal(p: HoursProductLike | null | undefined, view: Pick<MenuHoursView<unknown, unknown>, 'asleep'>): string | null {
  const a = itemAsleep(p, view);
  if (!a) return null;
  return `${String(p?.name ?? 'This item')} is not sold at this time — ${a.menuName} is ${a.label.replace(/^Every day/, 'every day')}.`;
}
