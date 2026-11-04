/**
 * mpesaC2b.ts — A621: M-Pesa payment notifications on the DESKTOP POS — the payments customers made to the branch's Till
 * number or Paybill, listed on the payment screen for the cashier to tap.
 *
 * Owner, 2026-11-02: "Some customers do not like giving out their number, they prefer paying to the till or paybill
 * directly; what the cashier gets is a notification of the payments done, then they match it to the bill." The cloud
 * keeps the payments Safaricom reports (routes/c2b.ts); this POS asks for them with its own session, through the branch
 * server on a POS that has one, as every other cloud call (syncEngine liveCloudGet / liveCloudPost → cloudGateway):
 *   - list   GET /api/payments/c2b/recent — while the payment screen shows an M-Pesa leg (every RECEIVED_POLL_MS, and at
 *            once when the cloud rings — liveSync 'mpesa_payment'). The cloud's stamp is sent back: "unchanged" costs it
 *            no database read, and the last list is shown again.
 *   - claim  POST /api/payments/c2b/claim — the cashier tapped a payment: it is this bill's; another POS tapping it is told.
 *   - release POST /api/payments/c2b/release — the cashier took it off the bill, or closed the payment screen without a sale.
 * Offered only with the online licence (premium, web_pos_enabled) and a connection; the cloud says whether the branch has
 * notifications switched on. Offline, not licensed or not switched on: nothing shows — the cashier types the M-Pesa code
 * by hand, as before.
 *
 * Pure apart from its deps, so test/mpesa-c2b-a621.test.mjs runs it with a fake cloud.
 */

/** A payment as the payment screen shows it — the shape of shared/mpesaPayments.ts ReceivedPayment (main cannot import
 *  the renderer's shared folder). */
export interface ReceivedPayment {
  trans_id:   string;
  amount:     number;
  first_name: string | null;
  bill_ref:   string | null;
  paid_at:    string;
}

export interface CloudAnswer { status: number; json(): Promise<any> }
export interface C2bDeps {
  online(): boolean;
  licensed(): boolean;
  get(path: string): Promise<CloudAnswer>;
  post(path: string, body: unknown): Promise<CloudAnswer>;
  log(line: string): void;
}

export interface C2bList { offered: boolean; payments: ReceivedPayment[] }
export type ClaimAnswer = { ok: true; payment: ReceivedPayment } | { ok: false; code?: string; error: string };

const NOTHING: C2bList = { offered: false, payments: [] };

/** A payment from the cloud's answer, or null when it is not one (never trusted blindly into the payment screen). */
export function cleanPayment(p: any): ReceivedPayment | null {
  if (!p || typeof p.trans_id !== 'string' || !/^[A-Z0-9]{8,20}$/.test(p.trans_id)) return null;
  const amount = Number(p.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return {
    trans_id: p.trans_id,
    amount,
    first_name: typeof p.first_name === 'string' ? p.first_name.slice(0, 40) : null,
    bill_ref: typeof p.bill_ref === 'string' ? p.bill_ref.slice(0, 40) : null,
    paid_at: typeof p.paid_at === 'string' ? p.paid_at : '',
  };
}

function listQuery(amount: unknown, ref: unknown, since: number | null): string {
  const q = new URLSearchParams();
  if (Number(amount) > 0) q.set('amount', String(Number(amount)));
  if (typeof ref === 'string' && ref.trim()) q.set('ref', ref.trim().slice(0, 40));
  if (since !== null) q.set('since', String(since));
  return q.toString();
}

export function createC2bClient(deps: C2bDeps) {
  // The cloud's last answer and its stamp: "unchanged" shows the last answer again.
  let last: C2bList = NOTHING;
  let stamp: number | null = null;
  let lastBill = '';

  const available = (): boolean => deps.licensed() && deps.online();

  /** The branch's untaken payments, the best fit for `amount` (and the bill's number) first. */
  const list = async (p: { amount?: unknown; ref?: unknown } = {}): Promise<C2bList> => {
    if (!available()) return NOTHING;
    // Another bill (or amount) on screen: the cloud sorts for it afresh, so the stamp does not apply.
    const bill = listQuery(p.amount, p.ref, null);
    if (bill !== lastBill) { stamp = null; lastBill = bill; }
    try {
      const r = await deps.get(`/api/payments/c2b/recent?${listQuery(p.amount, p.ref, stamp)}`);
      if (r.status !== 200) return last;
      const j = await r.json();
      if (j?.unchanged === true) return last;
      const payments = Array.isArray(j?.payments) ? j.payments.map(cleanPayment).filter(Boolean) as ReceivedPayment[] : [];
      last = { offered: j?.offered === true, payments: j?.offered === true ? payments : [] };
      stamp = Number.isSafeInteger(j?.stamp) ? j.stamp : null;
      return last;
    } catch {
      return last;   // a dropped ask: the last list stands until the next one
    }
  };

  /** The cashier tapped a payment for this sale. */
  const claim = async (p: { trans_id: unknown; sale_ref: unknown }): Promise<ClaimAnswer> => {
    if (!available()) return { ok: false, error: 'This POS is offline — type the M-Pesa code instead.' };
    try {
      const r = await deps.post('/api/payments/c2b/claim', { trans_id: p.trans_id, sale_ref: p.sale_ref });
      const j = await r.json().catch(() => ({}));
      const payment = r.status === 200 ? cleanPayment(j?.payment) : null;
      stamp = null;   // the list changed: the next ask reads it again
      if (payment) { deps.log(`c2b: took ${payment.trans_id}`); return { ok: true, payment }; }
      deps.log(`c2b: tap refused (${r.status}${j?.code ? ` ${j.code}` : ''})`);
      return { ok: false, code: typeof j?.code === 'string' ? j.code : undefined, error: typeof j?.error === 'string' ? j.error.slice(0, 160) : 'The payment could not be taken.' };
    } catch (e) {
      deps.log(`c2b: tap failed (${(e as Error)?.message ?? e})`);
      return { ok: false, error: 'No connection to the cloud — type the M-Pesa code instead.' };
    }
  };

  /** Gives a payment back to the list. Best effort: a release that does not arrive leaves it held — the owner sees it. */
  const release = async (p: { trans_id: unknown; sale_ref: unknown }): Promise<{ released: boolean }> => {
    if (!deps.online()) return { released: false };
    try {
      const r = await deps.post('/api/payments/c2b/release', { trans_id: p.trans_id, sale_ref: p.sale_ref });
      const j = await r.json().catch(() => ({}));
      stamp = null;
      return { released: j?.released === true };
    } catch {
      return { released: false };
    }
  };

  return { list, claim, release };
}

export type C2bClient = ReturnType<typeof createC2bClient>;

/** A ring from the cloud ('mpesa_payment') → the notice the POS shows, or null when it is not one. */
export function arrivedFromRing(m: any): Pick<ReceivedPayment, 'trans_id' | 'amount' | 'first_name'> | null {
  const p = cleanPayment({ ...m, paid_at: '' });
  return p ? { trans_id: p.trans_id, amount: p.amount, first_name: p.first_name } : null;
}
