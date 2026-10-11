/**
 * osk.ts — A417 part 2 (owner, 2026-10-09: "when a cashier taps on a text box can we find a way to make the keypad appear
 * something like the image attached without covering the text box where a value is being keyed in?"; 2026-10-09: "all
 * tills"). The rules of ZapTill's own on-screen keyboard, kept apart from React so the test runs them as they are.
 *
 *   · which fields it serves, and with which layout (numbers for an amount, letters otherwise);
 *   · where it docks so it never covers the field being typed in — the bottom of the screen, or the top when the field
 *     is low (works inside fixed pop-ups too, where scrolling the page cannot move the field);
 *   · what a key does to the field's text and caret.
 */

export type OskLayout = 'numeric' | 'text';

/** The fields the keyboard serves. Not: hidden ones, read-only or disabled, ones that ask for no keyboard
 *  (inputMode "none" — the lock screen's PIN input), checkboxes and the like, or ones marked data-osk="off". */
export function oskServes(el: { tagName: string; type?: string; readOnly?: boolean; disabled?: boolean;
  getAttribute(name: string): string | null }): boolean {
  const tag = el.tagName.toUpperCase();
  if (tag === 'TEXTAREA') return !el.readOnly && !el.disabled && el.getAttribute('data-osk') !== 'off';
  if (tag !== 'INPUT') return false;
  if (el.readOnly || el.disabled || el.getAttribute('data-osk') === 'off') return false;
  if ((el.getAttribute('data-osk-mode') ?? el.getAttribute('inputmode')) === 'none') return false;
  const type = String(el.type || 'text').toLowerCase();
  return ['text', 'search', 'email', 'tel', 'number', 'password', 'url'].includes(type);
}

/** Numbers for an amount, a quantity, a phone number or a PIN; letters for everything else. */
export function oskLayout(el: { type?: string; getAttribute(name: string): string | null }): OskLayout {
  const type = String(el.type || 'text').toLowerCase();
  const mode = (el.getAttribute('data-osk-mode') ?? el.getAttribute('inputmode') ?? '').toLowerCase();
  if (type === 'number' || type === 'tel' || mode === 'numeric' || mode === 'decimal' || mode === 'tel') return 'numeric';
  return 'text';
}

/**
 * Where the keyboard docks: under the field when it fits below it, else above it. The field is never covered — the
 * keyboard takes the side the field is not on. `gap` keeps a little air between them.
 */
export function oskDock(field: { top: number; bottom: number }, viewportH: number, keyboardH: number, gap = 12): 'bottom' | 'top' {
  if (field.bottom + gap <= viewportH - keyboardH) return 'bottom';
  if (field.top - gap >= keyboardH) return 'top';
  // A field taller than what is left either way (a big notes box): the side with more of it showing.
  return field.top + (field.bottom - field.top) / 2 < viewportH / 2 ? 'bottom' : 'top';
}

/** The keyboard's height: about two fifths of the screen, never more than 320 px, never less than 220. */
export function oskHeight(viewportH: number): number {
  return Math.round(Math.max(220, Math.min(320, viewportH * 0.42)));
}

export type OskKey = { kind: 'char'; ch: string } | { kind: 'backspace' } | { kind: 'clear' };

/**
 * A key applied to a field's text. `start`/`end` is the selection (null where the field has none — a number input):
 * then a character goes on the end and backspace takes the last one. Returns the new text and caret.
 */
export function oskApply(value: string, start: number | null, end: number | null, key: OskKey): { value: string; caret: number } {
  const s = start ?? value.length;
  const e = end ?? value.length;
  if (key.kind === 'clear') return { value: '', caret: 0 };
  if (key.kind === 'backspace') {
    if (s !== e) return { value: value.slice(0, s) + value.slice(e), caret: s };
    if (s === 0) return { value, caret: 0 };
    return { value: value.slice(0, s - 1) + value.slice(s), caret: s - 1 };
  }
  return { value: value.slice(0, s) + key.ch + value.slice(e), caret: s + key.ch.length };
}

/** The rows of keys, like the Windows touch keyboard the owner showed — letters, or numbers for an amount. */
export const TEXT_ROWS: string[][] = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', "'"],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '?'],
];
export const SYMBOL_ROW: string[] = ['@', '-', '_', '/', '&', '(', ')', ':', '#', '+'];
export const NUMERIC_ROWS: string[][] = [['7', '8', '9'], ['4', '5', '6'], ['1', '2', '3'], ['.', '0', '00']];
