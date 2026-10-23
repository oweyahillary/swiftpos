/**
 * MenuHoursEditor — A578: a menu's hours on Menu › Menus (Catalogue › Departments at a shop, Groups elsewhere — A573).
 *
 * Owner, 2026-10-23 (approved): each menu may carry optional availability — days of the week and one or more time
 * windows (Breakfast Mon–Fri 06:00–11:00; Lunch 11:00–16:00; an alcohol department only in licensed hours). No hours =
 * always available (the default for everyone). Outside its hours the POS (till and web) hides the menu's tab and its
 * items, and refuses an item scanned anyway; a manager can show all for the session.
 *
 * The editor: Always / Only at set times; the days (Every day, Mon–Fri, Weekends, or each day); the times (from – to,
 * up to six; none = all day on those days; a "to" before the "from" runs past midnight). What it saves is checked by the
 * same lib/menuHours.ts checkAvailability the cloud runs, so the words of a refusal show before saving.
 */
import { useState } from 'react';
import { MAX_MENU_WINDOWS, WEEK_MON_FIRST, HOURS_DAY_SHORT, availabilityLabel, checkAvailability, type MenuAvailability, type MenuWindow } from '../../lib/menuHours';

interface Props {
  /** The menu's name ("Breakfast", "Alcohol"). */
  name: string;
  /** What the business calls one ("menu", "department", "group"). */
  one: string;
  /** A food business (restaurant, café) — the examples follow the type. */
  food: boolean;
  initial: MenuAvailability | null | undefined;
  busy?: boolean;
  onSave: (value: MenuAvailability | null) => void;
  onCancel: () => void;
}

const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [0, 6];
const sameSet = (a: number[], b: number[]) => a.length === b.length && a.every((x) => b.includes(x));
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

export default function MenuHoursEditor({ name, one, food, initial, busy, onSave, onCancel }: Props) {
  const [timed, setTimed] = useState<boolean>(!!initial);
  const [days, setDays] = useState<number[]>(initial?.days ?? [0, 1, 2, 3, 4, 5, 6]);
  const [windows, setWindows] = useState<MenuWindow[]>(initial?.windows?.length ? initial.windows : [{ start: food ? '06:00' : '08:00', end: food ? '11:00' : '17:00' }]);

  const draft = timed ? { days: days.length === 7 ? null : days, windows } : null;
  const check = checkAvailability(draft);
  const overnight = timed && windows.some((w) => /^\d\d:\d\d$/.test(w.start) && /^\d\d:\d\d$/.test(w.end) && toMin(w.end) < toMin(w.start));
  const toggleDay = (d: number) => setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort((a, b) => a - b)));
  const setWin = (i: number, k: keyof MenuWindow, v: string) => setWindows((cur) => cur.map((w, j) => (j === i ? { ...w, [k]: v } : w)));
  const chip = (on: boolean) => `px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${on
    ? 'bg-swift/15 border-swift text-swift-text' : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-white'}`;
  const example = food ? 'Breakfast Mon–Fri 06:00–11:00, Lunch 11:00–16:00, Happy hour 17:00–19:00'
    : 'Bakery 06:00–10:00, Alcohol only in licensed hours';

  return (
    <div data-testid="menu-hours-editor" className="w-full mt-2 rounded-xl border border-gray-700 bg-gray-950/60 p-4 space-y-4">
      <div>
        <p className="text-sm font-semibold text-white">When is the {name} {one} available?</p>
        <p className="text-xs text-gray-500 mt-0.5">
          Outside these hours the POS hides this {one} and its items, and refuses an item scanned anyway. e.g. {example}.
        </p>
      </div>

      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Availability">
        <button type="button" role="radio" aria-checked={!timed} onClick={() => setTimed(false)} className={chip(!timed)}>Always available</button>
        <button type="button" role="radio" aria-checked={timed} onClick={() => setTimed(true)} className={chip(timed)}>Only at set times</button>
      </div>

      {timed && (
        <>
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Days</p>
            <div className="flex flex-wrap gap-1.5 mb-2">
              <button type="button" onClick={() => setDays([0, 1, 2, 3, 4, 5, 6])} className={chip(days.length === 7)}>Every day</button>
              <button type="button" onClick={() => setDays(WEEKDAYS)} className={chip(sameSet(days, WEEKDAYS))}>Mon–Fri</button>
              <button type="button" onClick={() => setDays(WEEKEND)} className={chip(sameSet(days, WEEKEND))}>Weekends</button>
            </div>
            <div className="flex flex-wrap gap-1.5" data-testid="menu-hours-days">
              {WEEK_MON_FIRST.map((d) => (
                <button key={d} type="button" aria-pressed={days.includes(d)} onClick={() => toggleDay(d)}
                  className={`w-12 ${chip(days.includes(d))}`}>{HOURS_DAY_SHORT[d]}</button>
              ))}
            </div>
          </div>

          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Times</p>
            {windows.length === 0 && <p className="text-sm text-gray-400 mb-2">All day on the chosen days.</p>}
            <div className="space-y-2">
              {windows.map((w, i) => (
                <div key={i} className="flex items-center gap-2" data-testid="menu-hours-window">
                  <label className="text-xs text-gray-500 w-10">From</label>
                  <input type="time" value={w.start} onChange={(e) => setWin(i, 'start', e.target.value)} aria-label={`From, time ${i + 1}`}
                    className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none focus:border-swift" />
                  <label className="text-xs text-gray-500">to</label>
                  <input type="time" value={w.end} onChange={(e) => setWin(i, 'end', e.target.value)} aria-label={`To, time ${i + 1}`}
                    className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none focus:border-swift" />
                  <button type="button" onClick={() => setWindows((cur) => cur.filter((_, j) => j !== i))} aria-label={`Remove time ${i + 1}`}
                    className="text-gray-500 hover:text-red-400 px-2 py-1 text-sm">✕</button>
                </div>
              ))}
            </div>
            {windows.length < MAX_MENU_WINDOWS && (
              <button type="button" onClick={() => setWindows((cur) => [...cur, { start: '11:00', end: '16:00' }])}
                className="mt-2 text-sm text-swift-text hover:underline">+ Add a time</button>
            )}
            {overnight && (
              <p className="text-xs text-gray-500 mt-2">
                A time that ends before it starts runs past midnight (22:00 to 02:00 is one night) and counts as the day it started.
              </p>
            )}
          </div>
        </>
      )}

      <div className="flex flex-wrap items-center gap-3 pt-1 border-t border-gray-800">
        <p className="flex-1 min-w-[12rem] text-sm pt-3" data-testid="menu-hours-preview">
          {check.ok
            ? <span className="text-gray-300">{availabilityLabel(check.value)}</span>
            : <span className="text-red-400">{check.error}</span>}
        </p>
        <div className="flex gap-2 pt-3">
          <button type="button" onClick={onCancel} className="text-sm text-gray-400 hover:text-white px-3 py-1.5">Cancel</button>
          <button type="button" disabled={busy || !check.ok} onClick={() => onSave(check.value)}
            className="text-sm bg-swift hover:bg-swift-light disabled:opacity-40 text-gray-950 font-semibold px-4 py-1.5 rounded-lg">Save hours</button>
        </div>
      </div>
    </div>
  );
}
