/**
 * creditLimit — A567: giving an existing customer a credit limit (Credit Accounts › "+ Give credit", the customer's
 * profile, and New Customer). Owner, 2026-10-22: "yes they should be existing customers added in the system with an
 * account and approved credit limit".
 *
 * The rules the three screens share, kept apart from React so tests run them as they are. The cloud decides: setting a
 * limit is PATCH /api/credit/customer/:id/limit under customers.credit, and it records who approved it and when.
 */

/** The key that sets (approves) a credit limit — the same one the cloud's route requires. */
export const CREDIT_LIMIT_KEY = 'customers.credit';

/** What was typed in a "Credit limit" box → a limit (2 decimals), or why it cannot be one. Empty is "not given". */
export function limitFromInput(text: string): { ok: true; value: number } | { ok: false; error: string } {
  const t = String(text ?? '').replace(/[,\s]/g, '');
  if (!t) return { ok: false, error: 'Enter a credit limit.' };
  const n = Number(t);
  if (!Number.isFinite(n)) return { ok: false, error: 'The credit limit must be a number.' };
  if (n < 0) return { ok: false, error: 'The credit limit cannot be below 0.' };
  return { ok: true, value: Math.round(n * 100) / 100 };
}

/** The request that sets a customer's limit. */
export function limitRequest(customerId: string, value: number): { path: string; body: { credit_limit: number } } {
  return { path: `/api/credit/customer/${encodeURIComponent(customerId)}/limit`, body: { credit_limit: value } };
}

/** The picker's search: existing customers by name or phone (customers.credit). */
export function candidatesPath(search: string): string {
  const s = String(search ?? '').trim();
  return `/api/credit/candidates${s ? `?search=${encodeURIComponent(s)}` : ''}`;
}

/** A customer in the picker: whether they already buy on account. */
export function candidateNote(c: { credit_limit: number; credit_balance: number }, fmt: (n: number) => string): string {
  if (Number(c.credit_limit) > 0) return `Limit ${fmt(Number(c.credit_limit))} already — this changes it`;
  if (Number(c.credit_balance) > 0) return `No limit, owes ${fmt(Number(c.credit_balance))}`;
  return 'No credit yet';
}

/** New Customer: send a limit only when one above 0 was typed AND the person may set limits. */
export function limitOnCreate(text: string, mayCredit: boolean): number | null {
  if (!mayCredit || !String(text ?? '').trim()) return null;
  const r = limitFromInput(text);
  return r.ok && r.value > 0 ? r.value : null;
}
