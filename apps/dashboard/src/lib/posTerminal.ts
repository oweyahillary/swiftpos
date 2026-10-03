/**
 * posTerminal — the till a web POS is COVERING (A273, Option B).
 *
 * The web POS has no device_id of its own, so by default every web sale in a
 * branch collapses to one shared `web:<branchId>` drawer (terminalKey.ts). When
 * a cashier opens a shift on the web backup they pick which till they are
 * covering; the web then adopts that till's device_id and sends it as
 * `x-device-id` on every request, so its shift and sales fold into THAT till's
 * drawer and trading day instead of the shared web session.
 *
 * Lifecycle: set when a shift is opened (or an existing one adopted), cleared
 * when it is closed. It is intentionally NOT cleared on logout — while a drawer
 * is open on this web POS, GET /api/shifts/current must keep resolving to the
 * same till across reloads and cashier changes. Stored per browser tab
 * (sessionStorage), read synchronously on every POS request.
 */
export interface CoveredTerminal {
  device_id: string;
  terminal_code: string | null;
  device_label: string | null;
  /** A273 follow-up: the till's open drawer, if any (GET /api/shifts/terminals; absent from an older cloud). */
  open_shift?: TillOpenShift | null;
}

export interface TillOpenShift { id: string; opened_at: string; opened_by: string | null; opened_by_name: string | null }

const KEY = 'swiftpos_pos_terminal';

export function getCoveredTerminal(): CoveredTerminal | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const t = JSON.parse(raw) as CoveredTerminal;
    return t && t.device_id ? t : null;
  } catch {
    return null;
  }
}

export function setCoveredTerminal(t: CoveredTerminal | null): void {
  try {
    if (t && t.device_id) sessionStorage.setItem(KEY, JSON.stringify(t));
    else sessionStorage.removeItem(KEY);
  } catch {
    /* storage unavailable — the x-device-id header simply won't be sent, and the
       web falls back to the shared web:<branch> drawer rather than crashing. */
  }
}

/**
 * The labels the cloud invents for a till that reported no name — keep in step with
 * GENERIC_TERMINAL_LABELS in apps/server/src/lib/terminalLabel.ts (tests/till-name.test.mjs
 * compares the two). Never shown as a till's name: they are the same for every till.
 */
export const GENERIC_TERMINAL_LABELS: readonly string[] = [
  'ZapTill till',
  'ZapTill till (branch server)',
  'ZapTill office server (view only)',
  // 0.6.37: the names given before the rename — tills already stored under them are still recognised (and hidden).
  'SwiftPOS till',
  'SwiftPOS till (branch server)',
  'SwiftPOS office server (view only)',
];

/** 0.6.37: a stored label as Settings › Devices shows it — a till named before the rename ("SwiftPOS till") reads
 *  "ZapTill till". Anything else unchanged. */
export function deviceLabelShown(label: string | null | undefined): string | null {
  if (label == null) return null;
  return label.startsWith('SwiftPOS ') && GENERIC_TERMINAL_LABELS.includes(label) ? 'ZapTill ' + label.slice('SwiftPOS '.length) : label;
}

/**
 * A till's name as a cashier sees it: "T1 — Front Counter" (code + the name typed at the
 * till's setup), "T1" when it has no real name yet, the name alone when it has no code,
 * and — only if it has neither — "Till" + the end of its id, so two tills never look alike.
 */
export function tillName(t: { device_id: string; terminal_code: string | null; device_label: string | null }): string {
  const code  = (t.terminal_code ?? '').trim();
  const raw   = (t.device_label ?? '').trim();
  const label = raw && !GENERIC_TERMINAL_LABELS.includes(raw) ? raw : '';
  if (code && label) return `${code} — ${label}`;
  if (code)  return code;
  if (label) return label;
  return `Till ${t.device_id.slice(-4)}`;
}

/**
 * The till whose drawer THIS cashier opened — on the desktop or on another web tab — so the
 * web joins it silently: no picker, no float (owner, 2026-09-26). Only when exactly ONE till
 * matches; with two, the cashier picks (never a guess about cash custody).
 */
export function ownOpenTill<T extends CoveredTerminal>(tills: T[], userId: string | null | undefined): T | null {
  if (!userId) return null;
  const mine = tills.filter((t) => t.open_shift && t.open_shift.opened_by === userId);
  return mine.length === 1 ? mine[0] : null;
}

/** "open — Jane, since 09:02" for a till with an open drawer; '' when closed. */
export function openShiftLine(t: CoveredTerminal): string {
  const o = t.open_shift;
  if (!o) return '';
  const at = new Date(o.opened_at);
  const hhmm = isNaN(at.getTime()) ? '' : `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  return `open — ${o.opened_by_name ?? 'another cashier'}${hhmm ? `, since ${hhmm}` : ''}`;
}

/** Merge GET /api/shifts/terminals/open into the till list by device_id (a till not listed is closed). */
export function withOpenShifts<T extends CoveredTerminal>(tills: T[], open: Array<{ device_id: string; open_shift: TillOpenShift }> | null | undefined): T[] {
  const byId = new Map((open ?? []).map((o) => [o.device_id, o.open_shift]));
  return tills.map((t) => ({ ...t, open_shift: byId.get(t.device_id) ?? null }));
}

/** The branch's open drawers (GET /api/shifts/terminals/open). An older cloud has no such route → [] (all closed, as before). */
export async function loadOpenDrawers(
  get: <R>(path: string) => Promise<R>, branchId: string,
): Promise<Array<{ device_id: string; open_shift: TillOpenShift }>> {
  try {
    return (await get<Array<{ device_id: string; open_shift: TillOpenShift }>>(`/api/shifts/terminals/open?branch_id=${encodeURIComponent(branchId)}`)) ?? [];
  } catch {
    return [];
  }
}

/** The branch's tills with their open drawers. */
export async function loadTills(
  get: <R>(path: string) => Promise<R>, branchId: string,
): Promise<CoveredTerminal[]> {
  const [tills, open] = await Promise.all([
    get<CoveredTerminal[]>(`/api/shifts/terminals?branch_id=${encodeURIComponent(branchId)}`),
    loadOpenDrawers(get, branchId),
  ]);
  return withOpenShifts(tills ?? [], open);
}

// ── A343 (2026-09-27): the branch's WEB till, and who goes straight in ──────────────────────────────────────────────────
// Owner: on the web, a cashier who did not open the running shift "are asked to join cashier A shift or proceed to create a
// shift" — their own, on the branch's web till ("branchname_web_till"). The opener, and a cashier who already chose, go
// straight in next time. On the desktop nothing changes: whoever signs in on a till sells into its running shift.

/** The branch's web till: its name and whether its drawer (web:<branch>) is open. */
export interface WebTill { name: string; open_shift: TillOpenShift | null }

/** GET /api/shifts/web-till. An older cloud has no such route → null (the picker simply shows no web till). */
export async function loadWebTill(get: <R>(path: string) => Promise<R>, branchId: string): Promise<WebTill | null> {
  try {
    return (await get<WebTill>(`/api/shifts/web-till?branch_id=${encodeURIComponent(branchId)}`)) ?? null;
  } catch {
    return null;
  }
}

/** The picker's value for the web till (tills are keyed by device_id, which the web till has none of). */
export const WEB_TILL_VALUE = '__web_till__';

/**
 * Where this cashier should go without being asked: the ONE open drawer they opened — a till's or the web till's.
 * Two of theirs, or none → null (the picker decides).
 */
export function ownOpenDrawer<T extends CoveredTerminal>(
  tills: T[], webTill: WebTill | null, userId: string | null | undefined,
): { kind: 'till'; till: T } | { kind: 'web' } | null {
  if (!userId) return null;
  const tillsMine = tills.filter((t) => t.open_shift && t.open_shift.opened_by === userId);
  const webMine = webTill?.open_shift?.opened_by === userId ? 1 : 0;
  if (tillsMine.length + webMine !== 1) return null;
  return webMine ? { kind: 'web' } : { kind: 'till', till: tillsMine[0] };
}

// Who has already CHOSEN to sell into a shift on this browser (joined it from the picker) — they go straight in next time.
// Per browser tab, like the covered till: a shared tab at the counter is the case this is for.
const JOINED_KEY = 'swiftpos_pos_joined';
function readJoined(): Record<string, string[]> {
  try { return JSON.parse(sessionStorage.getItem(JOINED_KEY) || '{}') ?? {}; } catch { return {}; }
}
export function markJoined(shiftId: string | null | undefined, userId: string | null | undefined): void {
  if (!shiftId || !userId) return;
  try {
    const j = readJoined();
    j[shiftId] = [...new Set([...(j[shiftId] ?? []), userId])];
    sessionStorage.setItem(JOINED_KEY, JSON.stringify(j));
  } catch { /* storage unavailable — they will simply be asked again */ }
}

/**
 * May this cashier sell into `shift` without being asked? Yes if they opened it (opened_by / cashier_id) or already joined it
 * on this browser. Anyone else is asked to join it or start their own shift on the web till.
 */
export function mayEnterSilently(
  shift: { id: string; opened_by?: string | null; cashier_id?: string | null } | null | undefined,
  userId: string | null | undefined,
): boolean {
  if (!shift || !userId) return false;
  if (shift.opened_by === userId || shift.cashier_id === userId) return true;
  return (readJoined()[shift.id] ?? []).includes(userId);
}
