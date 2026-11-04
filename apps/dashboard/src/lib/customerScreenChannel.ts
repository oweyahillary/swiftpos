/**
 * customerScreenChannel.ts — A606: the web POS's customer screen. "Open customer screen" opens a second browser window
 * (/customer-display) that the cashier drags to the second monitor and makes full screen (F11) — a browser cannot place a
 * window on a monitor by itself. The two windows talk over a BroadcastChannel (same browser, same site, no network): the
 * POS posts the cleaned state (customerScreen.ts sanitiseDisplayState) and the content the premium gate let through; a
 * customer screen that opens (or reloads) says 'hello' and the POS answers with the latest.
 *
 * A607: the same channel carries the customer's details form — the POS sends the cleaned request ('ask', customerDetails.ts
 * sanitiseAsk: no customer, staff or sale detail), the customer screen sends back what was typed ('answer') and the POS
 * CHECKS it against the open request (cleanAnswer — only the typed fields) before the cashier sees it to accept or correct.
 * And the M-Pesa prompt's progress ('stk', sanitiseStk — no phone). The customer screen says 'here' every few seconds so
 * the POS knows it is showing. Typing on the customer screen is offered only when this POS's browser is set as "The
 * customer screen is a touch screen" (TOUCH_KEY, this browser only).
 */
import { useEffect, useRef } from 'react';
import { sanitiseDisplayState, type DisplayContent, type DisplayState } from '@zaptill/core/customerScreen';
import { sanitiseAsk, cleanAnswer, sanitiseStk, type AskRequest, type CustomerAnswer, type StkView } from '@zaptill/core/customerDetails';

export const CUSTOMER_SCREEN_CHANNEL = 'zaptill-customer-screen';
export type ChannelMessage =
  | { type: 'hello' }
  | { type: 'state'; state: DisplayState }
  | { type: 'content'; content: DisplayContent }
  | { type: 'ask'; ask: AskRequest | null }                 // A607: POS → customer screen
  | { type: 'answer'; answer: Record<string, unknown> }     // A607: customer screen → POS (checked there)
  | { type: 'stk'; stk: StkView }                          // A607: POS → customer screen
  | { type: 'here' };                                       // A607: customer screen → POS, every few seconds

/** A607: "The customer screen is a touch screen" — this browser only. */
export const TOUCH_KEY = 'zaptill.customerScreenTouch';
export function customerScreenTouch(): boolean { try { return localStorage.getItem(TOUCH_KEY) === '1'; } catch { return false; } }
export function setCustomerScreenTouch(on: boolean): void { try { localStorage.setItem(TOUCH_KEY, on ? '1' : '0'); } catch { /* private window */ } }
/** The customer screen counts as showing when it said 'here' within this long. */
export const HERE_MS = 12_000;
export type AnswerEvent = { id: string; answer?: CustomerAnswer; skipped?: boolean };

export interface ChannelLike { postMessage(m: ChannelMessage): void; close(): void; onmessage: ((e: MessageEvent<ChannelMessage>) => void) | null }

export function openChannel(): ChannelLike | null {
  try { return typeof BroadcastChannel === 'function' ? new BroadcastChannel(CUSTOMER_SCREEN_CHANNEL) as unknown as ChannelLike : null; } catch { return null; }
}

/** Opens (or brings back) the customer screen window. */
export function openCustomerScreenWindow(): Window | null {
  try { return window.open('/customer-display', 'zaptill-customer-screen', 'popup=yes,width=1280,height=800'); } catch { return null; }
}

/** The POS side, without React: every state is CLEANED and stamped with when its stage began; 'hello' gets the latest. */
export function createPublisher(ch: ChannelLike | null, now: () => number = Date.now) {
  let state: DisplayState | null = null;
  let content: DisplayContent | null = null;
  let ask: AskRequest | null = null;   // A607
  let stk: StkView = sanitiseStk(null);
  let seen = 0;
  const listeners = new Set<(a: AnswerEvent) => void>();
  if (ch) {
    ch.onmessage = (e) => {
      const m = e?.data;
      if (m?.type === 'here' || m?.type === 'hello') seen = now();
      if (m?.type === 'answer') {
        // A607: only an answer to the open request, only the typed fields, checked here (cleanAnswer).
        const raw = (m.answer && typeof m.answer === 'object' ? m.answer : {}) as Record<string, unknown>;
        if (!ask || raw.id !== ask.id) return;
        if (raw.skip === true) { const id = ask.id; ask = null; ch.postMessage({ type: 'ask', ask: null }); listeners.forEach((l) => l({ id, skipped: true })); return; }
        const c = cleanAnswer(raw, ask);
        if ('errors' in c) { ch.postMessage({ type: 'ask', ask: { ...ask } }); return; }
        ask = null;
        ch.postMessage({ type: 'ask', ask: null });
        listeners.forEach((l) => l({ id: c.value.id, answer: c.value }));
        return;
      }
      if (m?.type !== 'hello') return;
      if (content) ch.postMessage({ type: 'content', content });
      if (state) ch.postMessage({ type: 'state', state });
      if (ask) ch.postMessage({ type: 'ask', ask });   // A607: a form or a prompt under way, to a window that opened late
      if (stk.stage !== 'idle') ch.postMessage({ type: 'stk', stk });
    };
  }
  return {
    /** A607: is the customer screen showing (it said 'here' lately)? */
    showing(): boolean { return seen > 0 && now() - seen < HERE_MS; },
    /** A607: show the form on the customer screen (the request cleaned — sanitiseAsk). */
    ask(raw: unknown): AskRequest | null {
      ask = sanitiseAsk(raw);
      ch?.postMessage({ type: 'ask', ask });
      return ask;
    },
    cancelAsk(id?: string): void {
      if (!ask || (id && id !== ask.id)) return;
      ask = null;
      ch?.postMessage({ type: 'ask', ask: null });
    },
    onAnswer(cb: (a: AnswerEvent) => void): () => void { listeners.add(cb); return () => { listeners.delete(cb); }; },
    /** A607: the M-Pesa prompt's progress for the customer screen (no phone). */
    stk(raw: unknown): StkView { stk = sanitiseStk(raw); ch?.postMessage({ type: 'stk', stk }); return stk; },
    state(raw: unknown): DisplayState {
      const next = sanitiseDisplayState(raw);
      next.since = state && state.stage === next.stage && state.since ? state.since : now();
      state = next;
      ch?.postMessage({ type: 'state', state: next });
      return next;
    },
    content(c: DisplayContent | null): void {
      content = c;
      if (c) ch?.postMessage({ type: 'content', content: c });
    },
    close(): void { try { ch?.close(); } catch { /* closed */ } },
  };
}

export type Publisher = ReturnType<typeof createPublisher>;
let current: Publisher | null = null;
/** A607: the POS's publisher while the POS is open — the details panel and the M-Pesa prompt use it. */
export function customerScreenPublisher(): Publisher | null { return current; }

/** The hook the web POS uses: one channel while the POS is open; a change is posted only when it changed. */
export function useCustomerScreenPublisher(raw: Record<string, unknown>, content: DisplayContent | null) {
  const pub = useRef<ReturnType<typeof createPublisher> | null>(null);
  const json = JSON.stringify(raw);
  const cjson = JSON.stringify(content);
  useEffect(() => {
    const p = createPublisher(openChannel());
    pub.current = p;
    current = p;
    return () => { p.close(); pub.current = null; if (current === p) current = null; };
  }, []);
  useEffect(() => { pub.current?.content(content); }, [cjson]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { pub.current?.state(raw); }, [json]);   // eslint-disable-line react-hooks/exhaustive-deps
}
