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
}

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
