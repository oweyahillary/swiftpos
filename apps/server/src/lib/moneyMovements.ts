/**
 * moneyMovements.ts — A455: what a manager records for the money books (migration 130), checked before it is stored.
 */
import { MOVEMENT_KINDS, type MovementKind } from './monthlyPack';

export interface MovementInput {
  branch_id: string; movement_date: string; method: string; kind: MovementKind; amount: number; note: string | null;
}

/** A movement as it may be stored, or why not. Pure. */
export function cleanMovement(body: any): { ok: true; value: MovementInput } | { ok: false; error: string } {
  const branch_id = typeof body?.branch_id === 'string' ? body.branch_id.trim() : '';
  const movement_date = typeof body?.movement_date === 'string' ? body.movement_date.trim() : '';
  const method = typeof body?.method === 'string' ? body.method.trim().toLowerCase() : '';
  const kind = body?.kind as MovementKind;
  const amount = Math.round(Number(body?.amount) * 100) / 100;
  const note = typeof body?.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 200) : null;
  if (!branch_id) return { ok: false, error: 'Pick the branch.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(movement_date) || Number.isNaN(Date.parse(`${movement_date}T00:00:00Z`))) return { ok: false, error: 'Pick the date (YYYY-MM-DD).' };
  if (!/^[a-z0-9_]{1,40}$/.test(method)) return { ok: false, error: 'Pick the book (cash, M-Pesa …).' };
  if (!(MOVEMENT_KINDS as readonly string[]).includes(kind)) return { ok: false, error: 'Pick what it is: opening balance, other income, personal, bank deposit or charges.' };
  if (!Number.isFinite(amount) || amount < 0 || (amount === 0 && kind !== 'opening')) return { ok: false, error: 'Enter an amount greater than zero.' };
  if (amount > 100_000_000) return { ok: false, error: 'That amount is too large.' };
  if ((kind === 'other_income' || kind === 'drawing') && !note) return { ok: false, error: 'Say what it was (a note) — e.g. "used cooking oil sold".' };
  return { ok: true, value: { branch_id, movement_date, method, kind, amount, note } };
}
