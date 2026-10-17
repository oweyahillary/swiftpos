/**
 * sellGate.ts — A519: the till checks "Sell" (orders.create) itself.
 *
 * A514 found the till sold for anyone signed in: there was no local orders.create check, so a Kitchen, Storekeeper or
 * Accountant person could ring a sale on a till — and the cloud accepts every sale a till made, on purpose (A505: a sale
 * is never lost once the money is in the drawer). The cloud cannot be the control here, so the till is.
 *
 * The rule (one place; the renderer's lib/access.ts maySell is the same rule for the screens):
 *   - the owner's role sells;
 *   - a permission map from BEFORE the catalogue (no MAP_MARKER — a till's saved sign-in, an older branch server's
 *     roster) keeps selling as before: nobody was ever refused a sale before A490, and A510 showed what refusing a
 *     cashier whose role was set up without the label costs;
 *   - anyone else needs orders.create.
 *
 * What it guards — STARTING a new sale: a new bill number (orders:nextBillNumber), a hold or a kitchen send of a bill
 * that is not already open, a payment of a bill that is not already open. An OPEN bill is never stranded by a change of
 * permissions mid-shift (the roster refresh, a token renewal): a bill this till numbered while the person could sell, a
 * held bill, one recalled from hold, and one with lines on a kitchen ticket can still be held, sent and paid — the cart
 * is never lost and the money already promised is taken. The next NEW sale is refused.
 *
 * Offline: the map is the till's own (staff_session, written at PIN sign-in from the cloud, the branch server or the
 * saved sign-ins) — nothing here asks the network.
 *
 * Pure apart from the two small reads of the till's own tables (held_orders, kitchen_lines), so the tests run it.
 */
import { hasMarker, isOwnerRole, personCan, type PersonLike } from './personAccess';

export const SELL_KEY = 'orders.create';

/** The words a person without "Sell" reads — on the till's plain screen, the POS and any refused call. */
export const SELL_REFUSAL = 'Your role can’t sell on this till — ask a manager to add ‘Sell’ to your role in Settings › Roles.';

/** May this person START a sale on this till? Nobody signed in → no. */
export function maySell(p: PersonLike | null | undefined): boolean {
  if (!p) return false;
  if (isOwnerRole(p.roleName)) return true;
  if (!hasMarker(p.permissions)) return true;   // a map from before A490: selling was never refused
  return personCan(p, SELL_KEY);
}

/**
 * The bills this run of the till opened while their person could sell, and the bills recalled from hold. In memory:
 * a restart signs everyone out (App boot clears the staff session), and the held / kitchen tables cover what outlives it.
 */
export interface OpenBills { note(orderNumber: string | null | undefined): void; has(orderNumber: string | null | undefined): boolean; size(): number }

export function createOpenBills(cap = 500): OpenBills {
  const set = new Set<string>();
  return {
    note(n) {
      const k = String(n ?? '').trim();
      if (!k) return;
      set.delete(k); set.add(k);
      while (set.size > cap) { const first = set.values().next().value; if (first === undefined) break; set.delete(first); }
    },
    has(n) { const k = String(n ?? '').trim(); return !!k && set.has(k); },
    size() { return set.size; },
  };
}

/** Minimal database shape (better-sqlite3's prepare/get) — so a test can hand in an in-memory one. */
export interface DbLike { prepare(sql: string): { get(...a: unknown[]): unknown } }

/** Is this bill already open on this till — numbered here while allowed, held, recalled, or on a kitchen ticket? */
export function isOpenBill(db: DbLike | null, orderNumber: string | null | undefined, memo: OpenBills): boolean {
  const n = String(orderNumber ?? '').trim();
  if (!n) return false;
  if (memo.has(n)) return true;
  if (!db) return false;
  try { if (db.prepare(`SELECT 1 FROM held_orders WHERE order_number = ? LIMIT 1`).get(n)) return true; } catch { /* an older table */ }
  try { if (db.prepare(`SELECT 1 FROM kitchen_lines WHERE order_number = ? AND status = 'open' LIMIT 1`).get(n)) return true; } catch { /* an older table */ }
  return false;
}

export type SellStep = 'number' | 'hold' | 'kitchen' | 'pay';

/**
 * Why this step is refused, or null when it may go ahead. `number` (a new bill number) is a new sale by definition; the
 * other steps go ahead for a bill already open (see the header) whoever is signed in now.
 */
export function sellRefusal(step: SellStep, p: PersonLike | null | undefined, open: boolean): string | null {
  if (maySell(p)) return null;
  if (step !== 'number' && open) return null;
  return SELL_REFUSAL;
}
