/**
 * mpesaStk.ts — A607: the M-Pesa prompt (STK push) from the DESKTOP POS.
 *
 * Owner, 2026-10-28: "if mpesa integration is available the client can key in their mpesa". The cloud already sends the
 * prompt for the web POS (routes/mpesa.ts). A desktop sale is made on the POS first and reaches the cloud later, so this
 * calls the cloud's POS route (POST /api/mpesa/stk-push-pos: the amount, the customer's number, the POS's own reference)
 * with this POS's own session — through the branch server on a POS that has one, exactly as every other cloud call
 * (syncEngine liveCloudPost / liveCloudGet → cloudGateway) — then asks GET /api/mpesa/status/:checkoutId every 3 seconds
 * until the customer paid, declined, or the prompt timed out (the cloud says so after ~70 s; this stops at 90 s).
 *
 *   - Offered only when the business's M-Pesa integration is set up (GET /api/mpesa/config — remembered 5 minutes) and the
 *     POS is online (customerDetails.ts stkOffered). Offline or not set up: the option is not shown, and the cashier takes
 *     M-Pesa as before (the till number / Paybill and the reference typed by hand).
 *   - The progress goes to BOTH screens (onState): the cashier's ("Waiting for M-Pesa…", "Paid ✓" with the M-Pesa
 *     receipt, "Not completed — try again / pay by till number") and the customer screen's (sanitiseStk — never the phone).
 *   - Nothing here pays the sale: the cashier still presses Charge, with the M-Pesa receipt as the leg's reference.
 *
 * Pure apart from its deps (the cloud calls, the clock, the timers), so test/customer-details-a607.test.mjs runs it with
 * a fake cloud.
 */
import { normaliseKenyanPhone, stkAmount, stkStageFromStatus, stkOffered, type StkStage } from './customerDetails';

export interface CloudAnswer { status: number; json(): Promise<any> }
export interface StkDeps {
  online(): boolean;
  get(path: string): Promise<CloudAnswer>;
  post(path: string, body: unknown): Promise<CloudAnswer>;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
  onState(s: StkState): void;
  log(line: string): void;
}

export interface StkState {
  stage: StkStage;
  amount: number;
  currency: string;
  reason: string | null;
  /** The M-Pesa receipt once paid (the leg's reference) — the cashier's screen only. */
  mpesaRef: string | null;
}

export const POLL_MS = 3_000;
export const GIVE_UP_MS = 90_000;
export const CONFIG_MS = 5 * 60_000;

const IDLE: StkState = { stage: 'idle', amount: 0, currency: 'KES', reason: null, mpesaRef: null };

export function createStkPrompt(deps: StkDeps) {
  let state: StkState = { ...IDLE };
  let checkout: string | null = null;
  let timer: unknown = null;
  let startedAt = 0;
  let run = 0;   // a newer prompt (or a cancel) makes an older poll's answer stale
  let cfg: { at: number; configured: boolean } | null = null;

  const set = (s: Partial<StkState>) => { state = { ...state, ...s }; try { deps.onState({ ...state }); } catch { /* a window gone */ } };
  const stop = () => { if (timer !== null) { deps.clearTimer(timer); timer = null; } };

  /** Is the prompt offered now? The integration set up (asked once per 5 minutes) and online. */
  const offered = async (): Promise<boolean> => {
    if (!deps.online()) return false;
    if (!cfg || deps.now() - cfg.at > CONFIG_MS) {
      let configured = false;
      try {
        const r = await deps.get('/api/mpesa/config');
        if (r.status === 200) configured = (await r.json())?.configured === true;
      } catch { configured = false; }
      cfg = { at: deps.now(), configured };
    }
    return stkOffered({ configured: cfg.configured, online: deps.online() });
  };

  const poll = (mine: number) => {
    timer = deps.setTimer(async () => {
      timer = null;
      if (mine !== run || !checkout) return;
      if (deps.now() - startedAt > GIVE_UP_MS) { set({ stage: 'failed', reason: 'The customer did not answer the prompt in time.' }); return; }
      try {
        const r = await deps.get(`/api/mpesa/status/${encodeURIComponent(checkout)}`);
        if (mine !== run) return;
        const j = r.status === 200 || r.status === 404 ? await r.json().catch(() => ({})) : null;
        if (j) {
          const stage = stkStageFromStatus(j.status);
          if (stage === 'paid') { set({ stage: 'paid', reason: null, mpesaRef: typeof j.mpesaRef === 'string' && /^[A-Z0-9]{6,20}$/.test(j.mpesaRef) ? j.mpesaRef : null }); return; }
          if (stage === 'failed') { set({ stage: 'failed', reason: typeof j.error === 'string' ? j.error.slice(0, 120) : 'The payment was not completed.' }); return; }
        }
      } catch { /* a dropped poll — the next one */ }
      if (mine === run) poll(mine);
    }, POLL_MS);
  };

  /** Send the prompt to the customer's phone for `amount` (rounded up to whole shillings). */
  const start = async (p: { phone: unknown; amount: unknown; ref: unknown; currency?: unknown }): Promise<StkState> => {
    const phone = normaliseKenyanPhone(p.phone);
    const amount = stkAmount(p.amount);
    const ref = typeof p.ref === 'string' && /^[A-Za-z0-9-]{1,40}$/.test(p.ref) ? p.ref : null;
    const currency = typeof p.currency === 'string' && /^[A-Z]{3}$/.test(p.currency) ? p.currency : 'KES';
    stop(); run++; checkout = null;
    const mine = run;
    if (!phone) { set({ ...IDLE, stage: 'failed', currency, reason: 'Enter a Kenyan mobile number — 07XX or 01XX.' }); return { ...state }; }
    if (amount === null) { set({ ...IDLE, stage: 'failed', currency, reason: 'The amount must be 1 to 250,000 shillings.' }); return { ...state }; }
    if (!ref) { set({ ...IDLE, stage: 'failed', currency, reason: 'The payment has no reference.' }); return { ...state }; }
    if (!deps.online()) { set({ ...IDLE, stage: 'failed', amount, currency, reason: 'This POS is offline — pay to the M-Pesa Till number.' }); return { ...state }; }
    set({ ...IDLE, stage: 'sending', amount, currency });
    try {
      const r = await deps.post('/api/mpesa/stk-push-pos', { phone, amount, client_ref: ref });
      if (mine !== run) return { ...state };
      const j = await r.json().catch(() => ({}));
      if (r.status !== 200 || typeof j?.checkoutRequestId !== 'string' || !j.checkoutRequestId) {
        const why = r.status === 422 ? 'M-Pesa is not set up for this business.'
          : typeof j?.details === 'string' ? j.details.slice(0, 120) : typeof j?.error === 'string' ? j.error.slice(0, 120) : 'The prompt could not be sent.';
        deps.log(`stk: refused (${r.status})`);
        set({ stage: 'failed', reason: why });
        return { ...state };
      }
      checkout = j.checkoutRequestId;
      startedAt = deps.now();
      deps.log(`stk: sent (${amount})`);
      set({ stage: 'waiting' });
      poll(mine);
    } catch (e) {
      if (mine === run) { deps.log(`stk: no connection (${(e as Error)?.message ?? e})`); set({ stage: 'failed', reason: 'No connection to the cloud — pay to the M-Pesa Till number.' }); }
    }
    return { ...state };
  };

  /** The cashier closes the panel, or the sale is done: both screens go back (a late answer is ignored). */
  const reset = (): StkState => { stop(); run++; checkout = null; set({ ...IDLE }); return { ...state }; };

  return { offered, start, reset, current: (): StkState => ({ ...state }) };
}

export type StkPrompt = ReturnType<typeof createStkPrompt>;
