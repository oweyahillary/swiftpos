/**
 * expenseTypes.ts — A341 (2026-09-28): a manager adds an expense type from the till.
 *
 * Owner 2026-09-27: "a manager should be able to add type we can do this in a future build" → 2026-09-28: "yes A341
 * are expense types". The till's Shift → Expenses picker read the types from the cloud and only the back office could
 * add one. Now a person with `expenses.manage` (managers and the owner by default — never cashiers) adds one from the
 * picker; it is saved on the cloud (POST /api/expenses/categories, the dashboard's own route and permission) and
 * selected straight away. Online only, like the list itself.
 *
 * Pure, so the test runs it.
 */
/**
 * Who sees "+ Add type": `expenses.manage`, the owner ('*'), or a manager-level role. A358 (0.6.19): the manager role
 * is included because a business whose manager role was never granted `expenses.manage` would otherwise see no button
 * at all and no reason — shown, the cloud still decides, and a refusal reads "Your role does not allow this change."
 * Never a cashier.
 */
const MANAGER_ROLES = ['manager', 'supervisor', 'admin', 'branch_manager', 'owner'];
export function mayAddExpenseType(
  staff: { permissions?: Record<string, unknown> | null; role?: string | null } | null | undefined,
): boolean {
  const p = (staff?.permissions ?? {}) as Record<string, unknown>;
  return p['*'] === true || p['expenses.manage'] === true
    || MANAGER_ROLES.includes(String(staff?.role ?? '').toLowerCase().replace(/\s+/g, '_'));
}

export type TypeNameCheck =
  | { ok: true; name: string }
  | { ok: false; error: string }
  /** The type already exists (any capitalisation): select it instead of creating a duplicate. */
  | { ok: 'exists'; id: string; name: string };

/** Tidy and check a new type's name against the ones already listed. */
export function checkTypeName(raw: string, existing: Array<{ id: string; name: string }>): TypeNameCheck {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!name) return { ok: false, error: 'Type a name for the expense type.' };
  if (name.length > 60) return { ok: false, error: 'Keep the name under 60 characters.' };
  const same = existing.find((c) => c.name.trim().toLowerCase() === name.toLowerCase());
  return same ? { ok: 'exists', id: same.id, name: same.name } : { ok: true, name };
}
