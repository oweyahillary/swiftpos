/**
 * customerDisplay.ts — A606: the customer-facing second screen on a dual-screen POS.
 *
 * Owner, 2026-10-28: "Yesterday I saw a POS with two screens, one facing the client and the other for the cashier." A
 * dual-screen POS shows up in Windows as a second monitor. This module owns the second window:
 *
 *   - WHERE: the screen chosen on the Tech page (remembered on this PC, maintenance_state 'customer_display' — no local
 *     schema change), never the cashier's own (primary) screen. Screens plugged in or out are followed: the chosen one
 *     gone → the window closes quietly and the Tech page says why; back → it opens again. Nothing throws.
 *   - WHAT: one small state (customerScreen.ts DisplayState), sent by the cashier's POS page through main on every cart or
 *     payment change and CLEANED here (sanitiseDisplayState: a whitelist — never a cost price, a staff name, a PIN or
 *     another customer), then pushed to the window. Offline by construction: nothing here touches the network.
 *   - The window is frameless and fullscreen on that screen, takes no focus (the cashier's keyboard and scanner stay on the
 *     POS) and loads the renderer's own `#/customer-display` page (a lazy chunk, renderer/pages/CustomerDisplayPage.tsx).
 *
 * The decisions are pure (customerScreen.ts pickScreen / numberScreens) and the controller takes its Electron parts as
 * deps, so test/customer-display-a606.test.mjs runs it with fakes.
 */
import {
  sanitiseDisplayState, idleState, pickScreen, numberScreens, cleanDisplayChoice,
  type DisplayState, type DisplayChoice, type ScreenInfo, type NumberedScreen,
} from './customerScreen';
import {
  sanitiseAsk, cleanAnswer, sanitiseStk, secondScreenAsk, type AskRequest, type CustomerAnswer, type StkView,
} from './customerDetails';   // A607

export const CHOICE_KEY = 'customer_display';

/** The parts of a BrowserWindow the controller uses. */
export interface DisplayWindow {
  send(channel: string, payload: unknown): void;
  moveTo(s: NumberedScreen): void;
  close(): void;
  isDestroyed(): boolean;
  onClosed(cb: () => void): void;
  /** A607: is this IPC sender the customer screen's own page? (Only it may answer a request.) */
  isSender?(sender: unknown): boolean;
}

export interface DisplayDeps {
  screens(): ScreenInfo[];
  openWindow(s: NumberedScreen): DisplayWindow;
  /** A big number on each screen for a few seconds ("Identify displays"). */
  showNumber(s: NumberedScreen, ms: number): void;
  readChoice(): unknown;
  writeChoice(c: DisplayChoice): void;
  now(): number;
  log(line: string): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
  /** A607: tell the cashier's window (the customer's answer, a request that closed). */
  toCashier?(channel: string, payload: unknown): void;
}

export interface DisplayStatus {
  choice: DisplayChoice;
  screens: Array<{ id: number; n: number; width: number; height: number; primary: boolean }>;
  open: boolean;
  /** Which screen it is on (1-based), or null. */
  on: number | null;
  note: string | null;
}

/** A sale to show on "Show test screen" — sample items, so the technician can read it from the customer's side. */
export function testState(now: number, mode: DisplayState['mode'] = 'retail', currency = 'KES'): DisplayState {
  const fuel = mode === 'petrol_station';
  return sanitiseDisplayState({
    stage: 'sale', mode, currency, since: now,
    lines: fuel
      ? [{ name: 'Super Petrol', qty: 10.84, unit: 'L', unitPrice: 184.5, lineTotal: 2000 }, { name: 'Water 1L', qty: 2, unitPrice: 70, lineTotal: 140 }]
      : [{ name: 'Test item', qty: 2, unitPrice: 150, lineTotal: 300 }, { name: 'Another test item', qty: 1, unitPrice: 85.5, lineTotal: 85.5, discount: 10 }],
    subtotal: fuel ? 2140 : 385.5, discount: fuel ? 0 : 10, total: fuel ? 2140 : 375.5, amountDue: fuel ? 2140 : 375.5,
  });
}

export const TEST_MS = 12_000;
export const IDENTIFY_MS = 4_000;

export function createCustomerDisplay(deps: DisplayDeps) {
  let win: DisplayWindow | null = null;
  let onScreen: NumberedScreen | null = null;
  let note: string | null = null;
  let state: DisplayState = idleState('other', 'KES', deps.now());
  let testing: { until: number; timer: unknown; state: DisplayState } | null = null;
  // A607: the customer's details form on the customer screen (premium, a touch screen) and the M-Pesa prompt's progress.
  let ask: AskRequest | null = null;
  let stk: StkView = sanitiseStk(null);
  const push = (channel: string, payload: unknown) => {
    if (win && !win.isDestroyed()) { try { win.send(channel, payload); } catch { /* closed meanwhile */ } }
  };
  const tellCashier = (channel: string, payload: unknown) => { try { deps.toCashier?.(channel, payload); } catch { /* window gone */ } };

  const choice = (): DisplayChoice => {
    try { return cleanDisplayChoice(deps.readChoice()); } catch { return { enabled: false, displayId: null }; }
  };
  const screens = (): ScreenInfo[] => { try { return deps.screens() ?? []; } catch { return []; } };
  const shown = (): DisplayState => testing?.state ?? state;

  const close = () => {
    const w = win; win = null; onScreen = null;
    try { if (w && !w.isDestroyed()) w.close(); } catch { /* already gone */ }
  };

  const open = (s: NumberedScreen) => {
    if (win && !win.isDestroyed()) {
      if (onScreen && (onScreen.id !== s.id || onScreen.width !== s.width || onScreen.height !== s.height || onScreen.x !== s.x || onScreen.y !== s.y)) {
        try { win.moveTo(s); } catch { /* the next change */ }
      }
      onScreen = s;
      return;
    }
    try {
      const w = deps.openWindow(s);
      win = w; onScreen = s;
      w.onClosed(() => {
        if (win === w) { win = null; onScreen = null; }
        // A607: a form open on a screen that went away — the cashier is told, and types it instead.
        if (ask) { tellCashier('customerDisplay:answered', { id: ask.id, cancelled: true }); ask = null; }
      });
      deps.log(`customer screen open on screen ${s.n} (${s.width}×${s.height})`);
    } catch (e) {
      win = null; onScreen = null;
      note = 'The customer screen could not open — see the log.';
      deps.log(`customer screen could not open: ${(e as Error)?.message ?? e}`);
    }
  };

  /** Look again at the screens and the choice: open, move or close. Called at start, on a change and on any screen change. */
  const apply = (): void => {
    const all = screens();
    let pick = pickScreen(all, choice());
    // "Show test screen" with the screen off: the chosen screen, else the first that is not the cashier's.
    if (testing && !pick.screen) {
      const c = choice();
      const n = numberScreens(all).filter((s) => !s.primary);
      const s = n.find((x) => x.id === c.displayId) ?? n[0] ?? null;
      pick = { screen: s, note: s ? null : 'Only one screen is connected — plug in the customer screen to test it.' };
    }
    const wasOpen = !!win;
    note = pick.note;
    if (pick.screen) open(pick.screen); else close();
    if (wasOpen && !win && pick.note) deps.log(`customer screen closed: ${pick.note}`);
    // A607: a form or a prompt under way reaches a window that (re)opened — before the sale; nothing is sent when neither is.
    if (win && ask) push('customerDisplay:ask', ask);
    if (win && stk.stage !== 'idle') push('customerDisplay:stk', stk);
    if (win) { try { win.send('customerDisplay:state', shown()); } catch { /* the next update */ } }
  };

  /** The POS's state → cleaned, stamped with when its stage began, pushed to the window. */
  const update = (raw: unknown): DisplayState => {
    const next = sanitiseDisplayState(raw);
    next.since = next.stage === state.stage && state.since > 0 ? state.since : deps.now();
    state = next;
    if (!testing && win && !win.isDestroyed()) { try { win.send('customerDisplay:state', state); } catch { /* closed meanwhile */ } }
    return state;
  };

  const status = (): DisplayStatus => {
    const n = numberScreens(screens());
    return {
      choice: choice(),
      screens: n.map((s) => ({ id: s.id, n: s.n, width: s.width, height: s.height, primary: s.primary })),
      open: !!win, on: onScreen?.n ?? null, note,
    };
  };

  const setChoice = (raw: unknown): DisplayStatus => {
    const c = cleanDisplayChoice(raw);
    // On with no screen named: the first screen that is not the cashier's.
    if (c.enabled && c.displayId === null) c.displayId = numberScreens(screens()).find((s) => !s.primary)?.id ?? null;
    deps.writeChoice(c);
    deps.log(`customer screen set ${c.enabled ? `on (screen id ${c.displayId})` : 'off'}`);
    apply();
    return status();
  };

  const test = (mode?: DisplayState['mode'], currency?: string): DisplayStatus => {
    if (testing) deps.clearTimer(testing.timer);
    const now = deps.now();
    testing = { until: now + TEST_MS, state: testState(now, mode, currency), timer: deps.setTimer(() => { testing = null; apply(); }, TEST_MS) };
    apply();
    return status();
  };

  const identify = (): number => {
    const n = numberScreens(screens());
    for (const s of n) { try { deps.showNumber(s, IDENTIFY_MS); } catch { /* one screen refused */ } }
    return n.length;
  };

  // ── A607: the customer's details, typed on the customer screen ───────────────────────────────────────────────────
  /**
   * The cashier presses "Ask the customer": the customer screen shows the form — only when the gate allows it (the online
   * licence, the PC's "touch screen" setting, the screen showing). What goes to the customer screen is the cleaned request
   * (customerDetails.ts sanitiseAsk): an id, what to ask, the bill total — no customer, staff or sale detail.
   */
  const askCustomer = (raw: unknown, gate: { touch: boolean; licensed: boolean }): { ok: true; ask: AskRequest } | { ok: false; why: string } => {
    const a = sanitiseAsk(raw);
    if (!a) return { ok: false, why: 'The request is not readable.' };
    const g = secondScreenAsk({ touch: gate.touch, licensed: gate.licensed, open: !!win && !win.isDestroyed() });
    if (!g.allowed) return { ok: false, why: g.why ?? 'The customer screen cannot ask now.' };
    ask = a;
    push('customerDisplay:ask', ask);
    deps.log(`customer screen: asking the customer (${a.purpose})`);
    return { ok: true, ask: a };
  };
  /** The cashier cancels (or accepted / typed it instead): the form leaves the customer screen. */
  const cancelAsk = (id?: unknown): void => {
    if (!ask || (typeof id === 'string' && id !== ask.id)) return;
    ask = null;
    push('customerDisplay:ask', null);
  };
  /**
   * The customer pressed Done (or Skip). Only the customer screen's own page may answer, only the request that is open, and
   * only the customer's own typed fields come back (customerDetails.ts cleanAnswer, checked HERE in main). A good answer
   * closes the form and goes to the cashier, who accepts or corrects it — nothing is attached to the sale here.
   */
  const answer = (raw: unknown, sender?: unknown): { ok: true } | { ok: false; errors: Record<string, string> } => {
    if (!win || win.isDestroyed() || (win.isSender && !win.isSender(sender))) return { ok: false, errors: { form: 'Not the customer screen.' } };
    const r = (raw && typeof raw === 'object' ? raw : {}) as { skip?: unknown; id?: unknown };
    if (ask && r.skip === true && r.id === ask.id) {
      tellCashier('customerDisplay:answered', { id: ask.id, skipped: true });
      ask = null; push('customerDisplay:ask', null);
      return { ok: true };
    }
    const c = cleanAnswer(raw, ask);
    if (!c.ok) return c;
    const value: CustomerAnswer = c.value;
    ask = null;
    push('customerDisplay:ask', null);
    tellCashier('customerDisplay:answered', { id: value.id, answer: value });
    return { ok: true };
  };
  /** The M-Pesa prompt's progress, as the customer may see it (no phone number). */
  const setStk = (raw: unknown): StkView => { stk = sanitiseStk(raw); push('customerDisplay:stk', stk); return stk; };

  return { apply, update, current: shown, status, setChoice, test, identify, close, isOpen: () => !!win,
    askCustomer, cancelAsk, answer, setStk, currentAsk: () => ask, currentStk: () => stk };
}

export type CustomerDisplay = ReturnType<typeof createCustomerDisplay>;
