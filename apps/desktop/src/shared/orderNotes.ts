/**
 * orderNotes.ts — 0.6.24: a note on an item and on the whole order (A367).
 *
 * Owner, 2026-09-30: "can we add notes in the order maybe if a customer wants a mixture of 3 normal and 2 spicy chicken
 * pieces or they want exta cheese if it pizza or no salt etc". Decided: free text plus quick picks the owner sets; a note
 * on each line and one on the order; notes are free (anything priced stays a modifier in Menu).
 *
 * ONE file: shared/orderNotes.ts, copied to the till, the web and the cloud (scripts/check-shared-sync.mjs).
 */

/** Longest note kept on a line / on the order. Past this it is cut, never refused — a sale must not fail on a note. */
export const ITEM_NOTE_MAX = 200;
export const ORDER_NOTE_MAX = 300;
export const PICKS_MAX = 24;
export const PICK_MAX = 40;

/** Used until the owner saves their own list (an empty saved list means "no quick picks"). */
export const DEFAULT_NOTE_PICKS: readonly string[] = [
  'No salt', 'Spicy', 'Mild', 'Extra cheese', 'No onions', 'No sauce', 'Well done', 'Takeaway pack',
];

/** A note as stored: trimmed, inner whitespace squeezed (new lines kept), cut to `max`. Empty → null. */
export function cleanNote(raw: unknown, max: number = ITEM_NOTE_MAX): string | null {
  if (raw == null) return null;
  const s = String(raw)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  if (!s) return null;
  return s.length > max ? s.slice(0, max).trimEnd() : s;
}

/**
 * The owner's quick picks, from the stored setting (a JSON array, or text one per line / comma separated).
 * Unset (null/undefined/'') → the defaults; a saved empty list → none. Trimmed, de-duplicated (any case), capped.
 */
export function parseNotePicks(raw: unknown): string[] {
  if (raw == null || raw === '') return [...DEFAULT_NOTE_PICKS];
  let list: unknown = raw;
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw); } catch { list = raw.split(/[\r\n,]+/); }
  }
  if (!Array.isArray(list)) return [...DEFAULT_NOTE_PICKS];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of list) {
    const p = cleanNote(v, PICK_MAX)?.replace(/\n/g, ' ');
    if (!p || seen.has(p.toLowerCase())) continue;
    seen.add(p.toLowerCase());
    out.push(p);
    if (out.length >= PICKS_MAX) break;
  }
  return out;
}

/** Tap a quick pick: add it to the note (on its own line), or take it off if the note already has it as a line. */
export function togglePick(note: string | null | undefined, pick: string): string {
  const lines = (note ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const i = lines.findIndex((l) => l.toLowerCase() === pick.toLowerCase());
  if (i >= 0) lines.splice(i, 1); else lines.push(pick);
  return lines.join('\n');
}

/** Is this pick one of the note's lines? (the chip shows as selected) */
export function hasPick(note: string | null | undefined, pick: string): boolean {
  return (note ?? '').split('\n').some((l) => l.trim().toLowerCase() === pick.toLowerCase());
}

/** The note's lines as printed under an item or the order on a ticket / receipt ("» No salt"). */
export function noteLines(note: string | null | undefined): string[] {
  const n = cleanNote(note, ORDER_NOTE_MAX);
  return n ? n.split('\n').map((l) => `» ${l}`) : [];
}

/** Two cart lines of the same product merge only when their notes match — "3 normal" and "2 spicy" stay apart. */
export function sameNote(a: string | null | undefined, b: string | null | undefined): boolean {
  return (cleanNote(a) ?? '') === (cleanNote(b) ?? '');
}
