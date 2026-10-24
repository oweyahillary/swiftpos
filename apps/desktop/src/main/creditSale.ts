/**
 * creditSale.ts — A552: sales on account (credit) at the desktop till.
 *
 * Owner, 2026-10-21: "for credit sales we need them on desktop app since its the one used by most clients". The web POS
 * has sold "On account" since A511 (a cashier without customers.credit needs a manager's PIN; the limit is enforced on a
 * live sale) and the cloud records a till's pushed credit sale (A545: awaiting a manager, flagged over_limit). The till
 * now sells on account itself — offline too:
 *
 *   OFFERED  only when the branch takes "On account" (payment_methods_enabled — on by default, A429) AND this till holds
 *            at least one customer with a credit account (a limit or a balance). Credit accounts are opened on the web
 *            (Customers › Credit); a business with none never sees the button.
 *   CUSTOMER required: one of the customers pulled from GET /api/pos/credit-customers (a till behind a branch server asks
 *            the server's copy, GET /node/credit-customers — the A535 pattern; the cloud only if the server is older).
 *            What is owed = the cloud's balance + this till's own sales on account the cloud had not taken when the list
 *            was read (customer_credit_transactions.synced_at after pulled_at, or not synced yet) — so a second sale sees
 *            the first one offline. The cloud stays the authority: the next pull corrects it.
 *   LIMIT    as the web POS: a sale past what is left is refused (no override — the web has none). The cloud still records
 *            a sale it receives past the limit (A545 over_limit: the till's figure can be behind another till's sale).
 *   APPROVAL A511 at the till: the person signed in holding customers.credit (the owner too) approves it themselves — no
 *            PIN; anyone else needs the PIN of someone at THIS branch who holds customers.credit, never their own — the
 *            chain the till's voids and refunds use offline (the branch server, else its roster, else this till's saved
 *            sign-ins: all of them this branch's only), behind the till's PIN limiter. Who approved is sent with the sale
 *            (`credit_approved_by`): the cloud checks that person (customers.credit at the sale's branch) and the sale is
 *            BORN CONFIRMED by them (A545: approved at the sale); anyone else named → awaiting a manager, as before.
 *   SPLIT    a sale may be part on account and part cash / M-Pesa / card (the web POS's split allows it) — ONE leg on
 *            account, one customer. The cloud charges only the credit leg; the drawer counts only cash (method = 'cash').
 *
 * A585 (owner, 2026-10-23: "they can assign to branch manager for approval but they set the limit"): the owner may choose
 * who approves sales on account at each branch (Settings › Credit approvals). The cloud sends this branch's list with the
 * customers (approval: { on, approvers, owner_id }); it is kept in maintenance_state, so it holds offline. ON: the seller
 * approves it themselves only when they are on the list (or the owner); anyone else needs the PIN of someone on it — a
 * PIN of anyone else, a manager included, does not approve. OFF (the default, and before the cloud sends it): A552.
 * The limit is the same either way.
 *
 * The screen's word is never taken: order:create calls prepareCreditSale, which re-reads the customer, the limit and the
 * approver here and strips anything the screen sent about them (credit_pin never leaves this process).
 */
import type Database from 'better-sqlite3';
import { getLocalDb } from './localDb';
import { getDeviceConfig, getPaymentMethodsEnabled, isNodeRole } from './deviceConfig';
import { logLine } from './logFile';
import { personCan, isOwnerRole } from './personAccess';
import { assertPinAllowed, recordPinFailure } from './pinAttempts';
import { verifyPinOffline } from './pinCache';
import { verifyPinAtNode } from './branchStaff';
import { verifyPinAtNodeClient, nodeUrl, nodeHeaders } from './nodeClient';
import { lanFetch } from './lanTls';
import { liveCloudGet } from './syncEngine';

export const ON_ACCOUNT = 'credit';
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export const CREDIT_PIN_NEEDED = "A sale on account needs a manager's approval — enter their PIN.";
export const NOT_A_CREDIT_APPROVER = 'That PIN was not recognised. Enter the PIN of a manager (or the owner) on duty.';
export const SELF_APPROVAL = 'Someone else must approve this — enter the PIN of another manager (or the owner).';
// A585: the owner chose who approves.
export const CHOSEN_PIN_NEEDED = 'A sale on account needs the approval of someone the owner chose — enter their PIN.';
export const NOT_A_CHOSEN_APPROVER = 'That PIN was not recognised. Enter the PIN of someone the owner chose to approve sales on account.';
export const NO_CHOSEN_APPROVER = 'Nobody at this branch may approve sales on account yet — the owner chooses who in Settings › Credit approvals.';
export const NO_ON_ACCOUNT = 'This POS does not take sales on account.';
export const CUSTOMER_NEEDED = 'Choose the customer this sale goes on account to.';
export const ONE_ACCOUNT_LEG = 'Put the account part of this sale in one payment.';
/** A559: the person signed in may not look up the customers (neither customers.view nor customers.credit). */
export const NO_CUSTOMER_ACCESS = 'You need permission to sell on account — ask a manager.';

// ── the customers (pulled) ──────────────────────────────────────────────────────────────────────────────────────────
export interface CloudCreditCustomer { id: string; name: string; phone?: string | null; status?: string | null; credit_limit: number; credit_balance: number }
export interface CreditCustomer {
  id: string; name: string; phone: string | null; status: string;
  credit_limit: number;
  /** What the cloud said was owed when the list was read. */
  cloud_balance: number;
  /** This till's sales on account the cloud had not taken then. */
  pending: number;
  /** What is owed now, as this till knows it: cloud_balance + pending. */
  owed: number;
  /** What is left to sell on account: the limit less what is owed (negative = past the limit). */
  available: number;
}

/** Replace the list with the cloud's (or the branch server's copy). `pulledAt` = when the cloud read it, on THIS till's
 *  clock (a sale the cloud took before then is in its balance). Unusable rows are dropped. Returns how many were kept. */
export function writeCreditCustomers(db: Database.Database, list: unknown, pulledAt: Date): number {
  const rows = (Array.isArray(list) ? list : []).filter((c: any) => c && typeof c.id === 'string' && c.id && typeof c.name === 'string');
  const at = pulledAt.toISOString();
  const put = db.prepare(`INSERT INTO credit_customers (id, name, phone, status, credit_limit, credit_balance, pulled_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    db.prepare(`DELETE FROM credit_customers`).run();
    for (const c of rows as CloudCreditCustomer[]) {
      put.run(c.id, String(c.name).slice(0, 200), c.phone ? String(c.phone).slice(0, 40) : null, String(c.status ?? 'active'),
        Number(c.credit_limit) || 0, Number(c.credit_balance) || 0, at);
    }
  })();
  return rows.length;
}

/** When the list was read (this till's clock), or null — never pulled. */
export function creditListAt(db: Database.Database = getLocalDb()): string | null {
  const r = db.prepare(`SELECT MAX(pulled_at) AS at FROM credit_customers`).get() as { at: string | null } | undefined;
  return r?.at ?? null;
}

function view(db: Database.Database, r: any): CreditCustomer {
  // A charge is in the cloud's figure when its order reached the cloud before the list was read; any other — not synced
  // yet, or synced after — is added. A voided sale's charge is not owed.
  const p = db.prepare(`
    SELECT COALESCE(SUM(t.amount), 0) AS n FROM customer_credit_transactions t
      -- branch-wide: by the charge's own order id (a charge is written only by the till that made the sale)
      LEFT JOIN orders o ON o.id = t.order_id
     WHERE t.customer_id = ? AND t.type = 'charge' AND COALESCE(o.status, '') <> 'voided'
       AND (t.synced_at IS NULL OR t.synced_at > ?)`).get(r.id, r.pulled_at) as { n: number };
  const pending = round2(Number(p?.n) || 0);
  const owed = round2((Number(r.credit_balance) || 0) + pending);
  return {
    id: r.id, name: r.name, phone: r.phone ?? null, status: r.status ?? 'active',
    credit_limit: round2(Number(r.credit_limit) || 0), cloud_balance: round2(Number(r.credit_balance) || 0),
    pending, owed, available: round2((Number(r.credit_limit) || 0) - owed),
  };
}

/** The customers matching a name or phone (any part), active first, by name. */
export function readCreditCustomers(db: Database.Database = getLocalDb(), search = '', limit = 30): CreditCustomer[] {
  const q = String(search ?? '').trim().toLowerCase();
  const like = `%${q.replace(/[%_]/g, '')}%`;
  const rows = db.prepare(`
    SELECT * FROM credit_customers
     WHERE (? = '' OR LOWER(name) LIKE ? OR REPLACE(COALESCE(phone, ''), ' ', '') LIKE ?)
     ORDER BY (status = 'active') DESC, name COLLATE NOCASE ASC LIMIT ?`).all(q, like, like.replace(/\s+/g, ''), Math.min(Math.max(limit, 1), 200));
  return rows.map((r) => view(db, r));
}

export function creditCustomerById(db: Database.Database, id: unknown): CreditCustomer | null {
  if (typeof id !== 'string' || !id) return null;
  const r = db.prepare(`SELECT * FROM credit_customers WHERE id = ?`).get(id);
  return r ? view(db, r) : null;
}

/** Does the branch take "On account" (A429: on unless the manager switched it off)? */
export function branchTakesOnAccount(enabled: string[] | null = getPaymentMethodsEnabled()): boolean {
  return enabled === null || enabled.map((c) => String(c).toLowerCase()).includes(ON_ACCOUNT);
}

/** Is "On account" offered on this till: the branch takes it and this till holds a customer with a credit account. */
export function onAccountOffered(db: Database.Database = getLocalDb(), enabled: string[] | null = getPaymentMethodsEnabled()): boolean {
  if (!branchTakesOnAccount(enabled)) return false;
  const r = db.prepare(`SELECT COUNT(*) AS n FROM credit_customers WHERE COALESCE(status, 'active') = 'active'`).get() as { n: number };
  return (Number(r?.n) || 0) > 0;
}

// ── A585: who approves (the owner's choice for this branch, kept offline) ─────────────────────────────────────────────
export interface CreditApprovalRule { on: boolean; approvers: string[]; owner_id: string | null }
export const APPROVAL_KEY = 'credit_approval';
const OFF: CreditApprovalRule = { on: false, approvers: [], owner_id: null };

/** What the cloud (or the branch server) sent → the rule. Anything unreadable is OFF. */
export function cleanApproval(raw: unknown): CreditApprovalRule {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...OFF };
  const o = raw as { on?: unknown; approvers?: unknown; owner_id?: unknown };
  return {
    on: o.on === true,
    approvers: Array.isArray(o.approvers) ? [...new Set(o.approvers.filter((x): x is string => typeof x === 'string' && !!x))].slice(0, 50) : [],
    owner_id: typeof o.owner_id === 'string' && o.owner_id ? o.owner_id : null,
  };
}
/** Keep the rule — only when one was sent (an older cloud or server sends none: the last one stands, OFF if never). */
export function writeCreditApproval(db: Database.Database, raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  db.prepare(`INSERT OR REPLACE INTO maintenance_state (key, value, updated_at) VALUES (?, ?, ?)`)
    .run(APPROVAL_KEY, JSON.stringify(cleanApproval(raw)), new Date().toISOString());
}
export function readCreditApproval(db: Database.Database = getLocalDb()): CreditApprovalRule {
  try {
    const r = db.prepare(`SELECT value FROM maintenance_state WHERE key = ?`).get(APPROVAL_KEY) as { value?: string } | undefined;
    return r?.value ? cleanApproval(JSON.parse(r.value)) : { ...OFF };
  } catch { return { ...OFF }; }
}
/** ON: the owner (their role, or the account the business names) or someone on this branch's list. */
export function onApproverList(p: LocalPerson | null | undefined, rule: CreditApprovalRule): boolean {
  if (!p?.id) return false;
  return isOwnerRole(p.roleName) || (!!rule.owner_id && p.id === rule.owner_id) || rule.approvers.includes(p.id);
}

// ── the rules ──────────────────────────────────────────────────────────────────────────────────────────────────────
export interface LocalPerson { id: string; name: string | null; roleName?: string | null; permissions?: unknown }
/** A PIN's person at THIS branch, or null (no match). Throws (with its words) when it cannot be checked at all. */
export type PinCheck = (pin: string, branchId: string) => Promise<LocalPerson | null>;

/** Holds customers.credit (the owner always): approves a sale on account without anyone's PIN. A585: when the owner chose
 *  the approvers, only someone on the list (or the owner). */
export function selfApproves(p: LocalPerson | null | undefined, rule?: CreditApprovalRule | null): boolean {
  if (rule?.on) return onApproverList(p, rule);
  return !!p?.id && personCan(p, 'customers.credit');
}

/**
 * A559 (owner, 2026-10-22, after testing 1.0.20: "yes they need the permission"): who may look up the credit customers
 * — and so sell on account — at the till: customers.view or customers.credit (the owner always). The web POS's rule
 * exactly: its credit account reads (GET /api/credit/customers, /api/credit/customer/:id) are requireAnyPermission(
 * 'customers.view', 'customers.credit'). Without either the till offers no "On account" (credit:customers answers
 * not offered, no list) and order:create refuses a sale on account (prepareCreditSale).
 */
export function mayFindCreditCustomers(p: LocalPerson | null | undefined): boolean {
  return !!p?.id && personCan(p, 'customers.view', 'customers.credit');
}

/** What stops this amount going on this customer's account, or null. The web POS's rule: never past what is left. */
export function limitProblem(c: CreditCustomer, amount: number, currency = 'KES'): string | null {
  if (c.status !== 'active') return `${c.name}'s account is not active.`;
  const f = (n: number) => `${currency} ${n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (round2(amount) > round2(c.available) + 0.004) {
    return c.credit_limit <= 0
      ? `${c.name} has no credit limit — the owner or a manager sets one (Customers › Credit on the web).`
      : `Over ${c.name}'s credit limit: ${f(Math.max(0, c.available))} left, this sale ${f(amount)}.`;
  }
  return null;
}

/**
 * Who approves this sale on account (A511 at the till). The person signed in with customers.credit: themselves, no PIN.
 * Anyone else: the PIN of someone at this branch holding customers.credit — never their own; a PIN that does not approve
 * counts towards the till's PIN lock (their own does not: it is not a guess).
 */
export async function creditApprover(asker: LocalPerson | null, pin: string | null | undefined, branchId: string,
  verify: PinCheck = identifyByPin, rule: CreditApprovalRule | null = null): Promise<LocalPerson> {
  if (!asker?.id) throw new Error('Not signed in');
  const chosen = !!rule?.on;   // A585: the owner chose who approves
  if (selfApproves(asker, rule)) return asker;
  const p = String(pin ?? '').trim();
  if (!p) throw new Error(chosen ? CHOSEN_PIN_NEEDED : CREDIT_PIN_NEEDED);
  assertPinAllowed();
  const refused = chosen ? NOT_A_CHOSEN_APPROVER : NOT_A_CREDIT_APPROVER;
  const who = await verify(p, branchId);
  if (!who) { recordPinFailure(); throw new Error(refused); }
  if (who.id === asker.id) throw new Error(SELF_APPROVAL);
  if (!selfApproves(who, rule)) { recordPinFailure(); throw new Error(refused); }
  return who;
}

/** The till's offline PIN chain (as its voids and refunds): the branch server, else this server's roster, else this
 *  till's saved sign-ins — each of THIS branch only. */
export const identifyByPin: PinCheck = async (pin, branchId) => {
  const cfg = getDeviceConfig();
  const as = (s: { staffId: string; name: string; roleName: string | null; permissions: unknown }): LocalPerson =>
    ({ id: s.staffId, name: s.name ?? null, roleName: s.roleName, permissions: s.permissions });
  if (cfg?.node_url && !isNodeRole(cfg?.device_role)) {
    const r = await verifyPinAtNodeClient(pin, branchId);
    if (r.status === 'ok') return as(r.staff);
    if (r.status === 'rejected') return null;
  }
  if (isNodeRole(cfg?.device_role)) {
    const v = verifyPinAtNode(pin, branchId);
    if (v.ok) return as(v.staff);
    if (v.reason !== 'no_roster' && v.reason !== 'unavailable') { if (v.reason === 'no_match') return null; throw new Error(v.message); }
  }
  const v = verifyPinOffline(pin, branchId);
  if (v.ok) return as(v.staff);
  if (v.reason === 'no_match') return null;
  throw new Error(v.message);
};

export interface PreparedCredit { customer: CreditCustomer; amount: number; approver: LocalPerson; balanceAfter: number }

/**
 * order:create's check of a sale on account, before it is saved. No leg on account: nothing (the screen's credit fields
 * are dropped). Otherwise the till's rules above; on success the payload carries the customer (from this till's list),
 * who approved it (`credit_approved_by`, for the cloud) and what the receipt prints (`on_account`). Throws the words the
 * cashier sees.
 */
export async function prepareCreditSale(payload: any, o: { asker: LocalPerson | null; db?: Database.Database; verify?: PinCheck;
  enabled?: string[] | null; branchId?: string | null; currency?: string }): Promise<PreparedCredit | null> {
  const db = o.db ?? getLocalDb();
  const pin = payload?.credit_pin;
  if (payload && typeof payload === 'object') { delete payload.credit_pin; delete payload.credit_approved_by; delete payload.on_account; }
  const legs: any[] = Array.isArray(payload?.payments) && payload.payments.length ? payload.payments : payload?.payment ? [payload.payment] : [];
  const onAccount = legs.filter((l) => String(l?.method ?? '').trim().toLowerCase() === ON_ACCOUNT);
  if (!onAccount.length) return null;
  if (onAccount.length > 1) throw new Error(ONE_ACCOUNT_LEG);
  if (!onAccountOffered(db, o.enabled === undefined ? getPaymentMethodsEnabled() : o.enabled)) throw new Error(NO_ON_ACCOUNT);
  if (!mayFindCreditCustomers(o.asker)) throw new Error(o.asker?.id ? NO_CUSTOMER_ACCESS : 'Not signed in');   // A559
  const amount = round2(Math.abs(Number(onAccount[0].amount) || 0));
  if (!(amount > 0)) throw new Error('The amount on account must be more than nothing.');
  const customer = creditCustomerById(db, payload.customer_id);
  if (!customer) throw new Error(CUSTOMER_NEEDED);
  const limit = limitProblem(customer, amount, o.currency);
  if (limit) throw new Error(limit);
  const branchId = o.branchId ?? getDeviceConfig()?.branch_id ?? '';
  const approver = await creditApprover(o.asker, pin, branchId, o.verify ?? identifyByPin, readCreditApproval(db));   // A585
  const balanceAfter = round2(customer.owed + amount);
  payload.customer_id = customer.id;
  payload.customer_name = customer.name;
  payload.customer_phone = customer.phone;
  payload.credit_approved_by = approver.id;   // the cloud checks this person and the sale is born confirmed by them (A552)
  payload.on_account = { customer: customer.name, balance_owed: balanceAfter };   // the receipt only (peerRelay drops it)
  logLine('sale', `A552: on account ${amount} to customer ${customer.id} approved by ${approver.id === o.asker?.id ? 'the seller' : (approver.name ?? approver.id)}`);
  return { customer, amount, approver, balanceAfter };
}

// ── the pull: the cloud, or a till's branch server (A535 pattern) ──────────────────────────────────────────────────────
const FRESH_MS = 60_000;
const UNSUPPORTED_WAIT_MS = 60 * 60_000;
let pulling: Promise<boolean> | null = null;
let serverUnsupportedUntil = 0;
let cloudUnsupportedUntil = 0;
let lastTriedAt = 0;

const isServer = (): boolean => isNodeRole(getDeviceConfig()?.device_role ?? null);

/** A till behind a branch server asks the server's copy (shop network); null = ask the cloud (no server, an older one). */
async function askServer(): Promise<{ customers: unknown; ageMs: number; approval?: unknown } | null> {
  const base = nodeUrl();
  const now = Date.now();
  if (!base || isServer() || now < serverUnsupportedUntil) return null;
  try {
    const res = await lanFetch(`${base}/node/credit-customers`, { headers: nodeHeaders(), signal: AbortSignal.timeout(6_000) } as any);
    if (res.status === 404) {
      serverUnsupportedUntil = now + UNSUPPORTED_WAIT_MS;
      logLine('sync', 'A552: the branch server does not hand out credit customers (an older server) — this till asks the cloud through it');
      return null;
    }
    if (!res.ok) return null;
    const b = await res.json() as { customers?: unknown; age_ms?: unknown; approval?: unknown };
    if (!Array.isArray(b?.customers)) return null;
    return { customers: b.customers, ageMs: Math.max(0, Number(b.age_ms) || 0), approval: b.approval };
  } catch { return null; }
}

/** Read the list now (the branch server's copy, else the cloud). Never throws; false = not read. Single-flight. */
export function pullCreditCustomers(db: Database.Database = getLocalDb()): Promise<boolean> {
  if (pulling) return pulling;
  lastTriedAt = Date.now();
  pulling = (async () => {
    try {
      const fromServer = await askServer();
      if (fromServer) {
        // The server's copy is ageMs old; 2 s more of margin counts a sale synced just then as not yet in it (safe side).
        const n = writeCreditCustomers(db, fromServer.customers, new Date(Date.now() - fromServer.ageMs - 2_000));
        writeCreditApproval(db, fromServer.approval);   // A585
        logLine('sync', `A552: ${n} credit customer(s) from the branch server`);
        return true;
      }
      if (Date.now() < cloudUnsupportedUntil) return false;
      const sent = new Date();
      const res = await liveCloudGet('/api/pos/credit-customers');
      if (res.status === 404) { cloudUnsupportedUntil = Date.now() + UNSUPPORTED_WAIT_MS; return false; }   // an older cloud
      if (!res.ok) return false;
      const b = await res.json() as { customers?: unknown; approval?: unknown };
      if (!Array.isArray(b?.customers)) return false;
      writeCreditCustomers(db, b.customers, sent);
      writeCreditApproval(db, b.approval);   // A585
      return true;
    } catch (e: any) {
      logLine('sync', `A552: credit customers not read: ${e?.message ?? e}`);
      return false;
    } finally { pulling = null; }
  })();
  return pulling;
}

/** Read again when the list is older than `maxAgeMs` (and not tried in that time); waits at most `waitMs`. */
export async function ensureCreditCustomers(maxAgeMs = FRESH_MS, waitMs = 4_000, db: Database.Database = getLocalDb()): Promise<void> {
  const at = creditListAt(db);
  const age = at ? Date.now() - Date.parse(at) : Infinity;
  if (age < maxAgeMs || Date.now() - lastTriedAt < Math.min(maxAgeMs, 30_000)) return;
  const p = pullCreditCustomers(db);
  await Promise.race([p, new Promise((r) => setTimeout(r, waitMs).unref?.())]);
}

/** GET /node/credit-customers (the branch server): its copy, as the cloud gave it, and how old it is. */
export async function answerCreditCustomers(db: Database.Database = getLocalDb()): Promise<{ status: number; body: unknown }> {
  await ensureCreditCustomers(FRESH_MS, 5_000, db);
  const at = creditListAt(db);
  if (!at) return { status: 503, body: { error: 'The branch server has no credit customers yet - ask again shortly.' } };
  const rows = db.prepare(`SELECT id, name, phone, status, credit_limit, credit_balance FROM credit_customers`).all();
  return { status: 200, body: { age_ms: Math.max(0, Date.now() - Date.parse(at)), customers: rows, approval: readCreditApproval(db) } };   // A585
}

/** Tests only. */
export function _resetCreditPull(): void { pulling = null; serverUnsupportedUntil = 0; cloudUnsupportedUntil = 0; lastTriedAt = 0; }
