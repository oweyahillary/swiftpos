/**
 * onscreenKeyboard.ts — whether a branch's desktop POS shows ZapTill's own on-screen keyboard (A417) when a field is
 * tapped. ONE file for the key, its values, the reader, the cloud's check and the words the manager sees — modelled on
 * categoryLayout.ts (8n).
 *
 * Owner, 2026-11-09: "the in app keyboard can we have it as the menu category it can be turned on or off" — the same
 * branch-setting pattern as the category layout: set once in Manager › Settings, every desktop POS in the branch follows
 * (branch-wide chosen over per-terminal on 2026-11-09). The on-screen keyboard itself is desktop-only (the web and
 * Android POS use the device's native keyboard), so only the desktop POS reads this; the value still rides the same
 * branch_settings rails so a POS behind a branch server gets it offline.
 *
 *   Stored in branch_settings (a key/value row), set by a manager with settings.pos_layout (a Manager's by default —
 *   migration 190, shared with the category layout) or settings.branches for their own branch (the owner any branch) —
 *   POST /api/branches/:id/settings. Absent = 'on' (today's behaviour), so nothing changes until a manager turns it off.
 *   Not premium: it works without the online licence.
 *
 * Pure: no imports. Used by the cloud (routes/branches.ts check, routes/pos.ts init) and the desktop POS (main caches it,
 * Manager › Settings changes it, OnScreenKeyboard.tsx reads it).
 */

/** The branch_settings key. */
export const ONSCREEN_KEYBOARD_KEY = 'pos_onscreen_keyboard';

/** 'on' — the on-screen keyboard opens when a field is tapped (A417, the standard); 'off' — it never opens. */
export const ONSCREEN_KEYBOARD_VALUES = ['on', 'off'] as const;
export type OnscreenKeyboard = (typeof ONSCREEN_KEYBOARD_VALUES)[number];

/**
 * Who may change it (any one of these): settings.pos_layout — a plain Manager's by default (migration 190, the same key
 * the category layout uses) — or settings.branches (the branch's own settings), so the owner and a General Manager are
 * unaffected. Shared with the category layout so "POS layout" stays one permission.
 */
export const ONSCREEN_KEYBOARD_PERMISSIONS = ['settings.pos_layout', 'settings.branches'] as const;

/** No choice made: the on-screen keyboard is on, as it has always been. */
export const DEFAULT_ONSCREEN_KEYBOARD: OnscreenKeyboard = 'on';

/** The cloud's check: the stored value, or null when it is not one of the two (refused, never stored). */
export function onscreenKeyboardSettingValue(raw: unknown): OnscreenKeyboard | null {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return (ONSCREEN_KEYBOARD_VALUES as readonly string[]).includes(v) ? (v as OnscreenKeyboard) : null;
}

/** The reader the desktop POS uses: anything that is not a known value (absent, an older build's, garbled) is 'on'. */
export function onscreenKeyboardOf(raw: unknown): OnscreenKeyboard {
  return onscreenKeyboardSettingValue(raw) ?? DEFAULT_ONSCREEN_KEYBOARD;
}

/** The words the manager sees on the desktop's Manager › Settings. */
export const ONSCREEN_KEYBOARD_WORDS = {
  title: 'On-screen keyboard',
  explain: 'ZapTill\'s own keyboard that opens when a cashier taps a text box on a touch POS. Turn it off on POS that have a physical keyboard.',
  on: { label: 'On', hint: 'Opens when a field is tapped with a finger (the standard)' },
  off: { label: 'Off', hint: 'Never opens — for a POS with a physical keyboard' },
  saved: 'Saved for this branch',
} as const;
