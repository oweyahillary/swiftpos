/**
 * creditConfirm.ts — A545: credit sales a manager confirms on the till (Manager › Sales › Credit sales).
 *
 * Owner, 2026-10-21: "for credit I think the manager has to know which sale is on credit and they have to confirm that it
 * was done."
 *
 * The list lives on the cloud (credit_confirmations, migration 157): every sale on account, awaiting → confirmed (by whom,
 * when) or disputed (by whom, when, why). A manager signed in on this till confirms or disputes AS THEMSELVES (A433: no
 * PIN) — online straight to the cloud with their own sign-in; offline the decision is kept here (maintenance_state
 * `credit_confirm_pending`) and sent at the next sync with the till's own sign-in naming who decided and when
 * (POST /api/credit/sales/:id/replay — the cloud checks that person holds customers.credit at the sale's branch).
 * The last list read from the cloud is kept (`credit_confirm_cache`) so the screen and the Close Day notice work offline.
 *
 * Day close is NEVER blocked on it (the owner: no deadlocks) — Close Day / Close Branch only say how many wait.
 */
import type Database from 'better-sqlite3';

export const CACHE_KEY = 'credit_confirm_cache';
export const PENDING_KEY = 'credit_confirm_pending';
export const REFUSED_KEY = 'credit_confirm_refused';

export type CreditState = 'awaiting' | 'confirmed' | 'disputed';
export type CreditDecision = 'confirm' | 'dispute';

export interface CreditSaleView {
  order_id: string; order_number: string | null; branch_id: string | null; branch_name: string | null;
  customer_id?: string | null; customer_name: string | null; amount: number; state: CreditState; source: string;
  over_limit: boolean; cashier_name: string | null; approved_by_name: string | null; decided_by_name: string | null;
  decided_at: string | null; dispute_reason: string | null; sold_at: string;
  /** A decision made on this till that has not reached the cloud yet. */
  pending?: boolean;
}
export interface CreditDecisionRec {
  order_id: string; decision: CreditDecision; reason: string; by: string; by_name: string | null; at: string;
}
export interface RefusedDecision extends CreditDecisionRec { refused_at: string; message: string }

function readJson<T>(db: Database.Database, key: string, fallback: T): T {
  try {
    const row = db.prepare(`SELECT value FROM maintenance_state WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value ? JSON.parse(row.value) as T : fallback;
  } catch { return fallback; }
}
function writeJson(db: Database.Database, key: string, value: unknown, empty: boolean): void {
  if (empty) { db.prepare(`DELETE FROM maintenance_state WHERE key = ?`).run(key); return; }
  db.prepare(`INSERT OR REPLACE INTO maintenance_state (key, value, updated_at) VALUES (?, ?, ?)`)
    .run(key, JSON.stringify(value), new Date().toISOString());
}

export const readCache = (db: Database.Database): { at: string; rows: CreditSaleView[] } | null =>
  readJson<{ at: string; rows: CreditSaleView[] } | null>(db, CACHE_KEY, null);
export const readPending = (db: Database.Database): CreditDecisionRec[] => readJson<CreditDecisionRec[]>(db, PENDING_KEY, []);
export const readRefused = (db: Database.Database): RefusedDecision[] => readJson<RefusedDecision[]>(db, REFUSED_KEY, []);

/** Keep the list the cloud answered (open sales: awaiting + disputed), for offline. */
export function writeCache(db: Database.Database, rows: CreditSaleView[], now = new Date().toISOString()): void {
  writeJson(db, CACHE_KEY, { at: now, rows: Array.isArray(rows) ? rows.slice(0, 500) : [] }, false);
}

const target = (d: CreditDecision): CreditState => (d === 'confirm' ? 'confirmed' : 'disputed');

/** What is wrong with a decision before it is sent or kept, or null. The cloud checks again. */
export function decisionProblem(d: { decision: unknown; reason?: unknown }): string | null {
  if (d.decision !== 'confirm' && d.decision !== 'dispute') return 'Confirm or dispute.';
  if (d.decision === 'dispute' && !String(d.reason ?? '').trim()) return 'Say why it is disputed.';
  return null;
}

/** Keep a decision made while the cloud could not be reached (one per sale — a later decision replaces it). */
export function queueDecision(db: Database.Database, d: CreditDecisionRec): void {
  db.transaction(() => {
    const list = readPending(db).filter((x) => x.order_id !== d.order_id);
    list.push({ ...d, reason: String(d.reason ?? '').trim().slice(0, 300) });
    writeJson(db, PENDING_KEY, list, false);
  })();
}

/** The list as this till shows it: a decision still waiting to be sent shows as made (marked pending). */
export function overlay(rows: CreditSaleView[], pending: CreditDecisionRec[]): CreditSaleView[] {
  const by = new Map(pending.map((p) => [p.order_id, p]));
  return rows.map((r) => {
    const p = by.get(r.order_id);
    return p ? { ...r, state: target(p.decision), decided_by_name: p.by_name, decided_at: p.at,
      dispute_reason: p.decision === 'dispute' ? p.reason : null, pending: true } : r;
  });
}

/** How many still wait for a manager, as this till knows (the saved list, less what was decided here). */
export function awaitingCount(rows: CreditSaleView[], pending: CreditDecisionRec[]): number {
  return overlay(rows, pending).filter((r) => r.state === 'awaiting').length;
}

/** "N credit sales await a manager's confirmation" — '' when none (the cloud's words: lib/creditConfirm.ts). */
export function awaitingSentence(n: number): string {
  if (!(n > 0)) return '';
  return `${n} credit sale${n === 1 ? '' : 's'} await${n === 1 ? 's' : ''} a manager's confirmation`;
}

/** A decision the cloud took: the saved list follows it (so the offline view and the count are right at once). */
export function applyToCache(db: Database.Database, orderId: string, patch: Partial<CreditSaleView>): void {
  const c = readCache(db);
  if (!c) return;
  writeJson(db, CACHE_KEY, { at: c.at, rows: c.rows.map((r) => (r.order_id === orderId ? { ...r, ...patch, pending: false } : r)) }, false);
}

export type DecisionOutcome =
  | { state: 'saved' }
  | { state: 'pending'; message: string }
  | { state: 'refused'; message: string };

/**
 * Send what is waiting, oldest first. `post` makes the cloud call (the till's own sign-in, renewed on a 401); it returns
 * the status and body, or throws when there is no connection — then everything stays and nothing after it is tried.
 */
export async function pushPendingDecisions(
  db: Database.Database,
  post: (d: CreditDecisionRec) => Promise<{ status: number; body: any }>,
  describe: (body: any, status: number) => string = (b, s) => String(b?.error ?? `HTTP ${s}`),
): Promise<Record<string, DecisionOutcome>> {
  const out: Record<string, DecisionOutcome> = {};
  for (const d of readPending(db)) {
    let res: { status: number; body: any };
    try { res = await post(d); }
    catch (e: any) {
      for (const left of readPending(db)) if (!out[left.order_id]) out[left.order_id] = { state: 'pending', message: `Saved on this till — it goes to the cloud when the connection is back (${e?.message ?? e}).` };
      break;
    }
    const drop = () => { const left = readPending(db).filter((x) => x.order_id !== d.order_id); writeJson(db, PENDING_KEY, left, left.length === 0); };
    if (res.status >= 200 && res.status < 300) {
      db.transaction(() => {
        drop();
        applyToCache(db, d.order_id, { state: target(d.decision), decided_by_name: d.by_name, decided_at: d.at,
          dispute_reason: d.decision === 'dispute' ? d.reason : null });
      })();
      out[d.order_id] = { state: 'saved' };
      continue;
    }
    if (res.status >= 500 || res.status === 401 || res.status === 408 || res.status === 429) {
      out[d.order_id] = { state: 'pending', message: `Saved on this till — the cloud did not take it yet (HTTP ${res.status}); it retries at the next sync.` };
      continue;
    }
    // A real refusal (decided by someone else already, not a credit approver): stop waiting, show why.
    const message = describe(res.body, res.status);
    db.transaction(() => {
      drop();
      writeJson(db, REFUSED_KEY, [{ ...d, refused_at: new Date().toISOString(), message }, ...readRefused(db)].slice(0, 20), false);
    })();
    out[d.order_id] = { state: 'refused', message };
  }
  return out;
}

/** The manager has read a refusal: take it off the screen. */
export function dismissRefused(db: Database.Database, orderId: string): void {
  const left = readRefused(db).filter((x) => x.order_id !== orderId);
  writeJson(db, REFUSED_KEY, left, left.length === 0);
}
