/**
 * localPrintServer.ts
 *
 * Client for the SwiftPOS Print Bridge — a tiny (~1.6 MB) native helper
 * (SwiftPOS-PrintServer.exe) that runs on the till and forwards ESC/POS bytes to
 * the printer. The browser renders the receipt/KOT to ESC/POS; this client
 * base64s the bytes and POSTs them to the bridge. Works on Chrome, Firefox,
 * Edge, Safari.
 *
 * Detection:
 *   On load, pings the bridge's /health (127.0.0.1:9911).
 *   Connected  → silent one-click printing via HTTP POST.
 *   Not found  → callers fall back to the window.print() browser dialog.
 *
 * Security: the bridge is loopback-only, Host-locked (DNS-rebinding safe), and
 * requires a pairing token (X-Print-Token) on every print/enumerate call.
 */

// The bridge URL is HARD-CODED to its fixed loopback address. It is deliberately
// NOT read from a Vite/Vercel build env: a stale env override once pointed a
// deployed dashboard at the dev API port and silently broke printing (A241). The
// bridge's own port is configurable on the bridge side (PRINT_BRIDGE_PORT env on
// the .exe); the dashboard always talks to the default 9911.
const SERVER_URL  = 'http://127.0.0.1:9911';
const HEALTH_PATH = `${SERVER_URL}/health`;
const PRINT_PATH  = `${SERVER_URL}/print`;
const TEST_PATH   = `${SERVER_URL}/print/test`;

// The bridge requires a pairing token (X-Print-Token) on every print. It prints
// the token to its console on first run; the cashier pastes it into the Printers
// page once. Stored per-device (a till), like the printer selection.
const TOKEN_KEY = 'swiftpos.print.token';
export function getPrintToken(): string {
  try { return localStorage.getItem(TOKEN_KEY) ?? ''; } catch { return ''; }
}
export function setPrintToken(t: string): void {
  try { localStorage.setItem(TOKEN_KEY, t.trim()); } catch { /* private mode */ }
}
const tokenHeaders = (): Record<string, string> => {
  const t = getPrintToken();
  return t ? { 'X-Print-Token': t } : {};
};

// ─── Types (same as before so imports don't break) ────────────────────────────

export type QZStatus = 'connecting' | 'connected' | 'disconnected' | 'unavailable';

// ─── State ────────────────────────────────────────────────────────────────────

let status: QZStatus = 'disconnected';
let availablePrinters: string[] = [];
let statusListeners: ((s: QZStatus) => void)[] = [];
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function setStatus(s: QZStatus) {
  status = s;
  statusListeners.forEach(fn => fn(s));
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function getQZStatus(): QZStatus { return status; }

export function onQZStatusChange(fn: (s: QZStatus) => void): () => void {
  statusListeners.push(fn);
  fn(status); // emit immediately
  return () => { statusListeners = statusListeners.filter(l => l !== fn); };
}

// ─── Connect / health check ───────────────────────────────────────────────────

export async function connectQZ(): Promise<boolean> {
  if (!SERVER_URL) { setStatus('unavailable'); return false; }  // feature off — don't poll the API port
  if (status === 'connecting') return false;
  setStatus('connecting');

  try {
    const res = await fetch(HEALTH_PATH, {
      method:  'GET',
      signal:  AbortSignal.timeout(2000), // 2 second timeout
    });

    if (res.ok) {
      const data = await res.json();
      availablePrinters = data.printers ?? [];
      setStatus('connected');
      scheduleHealthCheck();
      return true;
    } else {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch {
    availablePrinters = [];
    setStatus('unavailable');
    scheduleReconnect();
    return false;
  }
}

// ─── Periodic health check (keep status accurate) ─────────────────────────────

function scheduleHealthCheck() {
  setTimeout(async () => {
    if (status !== 'connected') return;
    try {
      const res = await fetch(HEALTH_PATH, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const data = await res.json();
        availablePrinters = data.printers ?? [];
        scheduleHealthCheck(); // keep checking
      } else {
        setStatus('disconnected');
        scheduleReconnect();
      }
    } catch {
      setStatus('disconnected');
      scheduleReconnect();
    }
  }, 15_000); // check every 15 seconds
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectQZ();
  }, 5_000); // retry after 5 seconds
}

// ─── Get printers (mimics QZ API) ─────────────────────────────────────────────

export async function getQZPrinters(): Promise<string[]> {
  if (status !== 'connected') return [];
  try {
    const res = await fetch(`${SERVER_URL}/printers`, {
      headers: { ...tokenHeaders() },   // /printers is token-gated (A240)
      signal: AbortSignal.timeout(3000),
    });
    const data = await res.json();
    availablePrinters = data.printers ?? [];
    return availablePrinters;
  } catch {
    return availablePrinters;
  }
}

// ─── Test print ───────────────────────────────────────────────────────────────

export async function testPrint(printerName: string, paperWidth: 58 | 80): Promise<void> {
  const res = await fetch(TEST_PATH, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', ...tokenHeaders() },
    // Explicit spooler target. Sending a BARE name here (the old bug) made the
    // bridge treat "XP-80" as a network host and dial XP-80:9100 → "no such host".
    // Prefix printer: so it goes to the Windows spooler, matching the receipt/KOT
    // byte path (A244).
    body:    JSON.stringify({ target: 'printer:' + printerName, paperWidth }),
    signal:  AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error ?? `Test print failed: HTTP ${res.status}`);
  }
}

// ─── Silent receipt via the tiny bridge (browser renders ESC/POS, bridge forwards) ─
// The browser renders the receipt to ESC/POS bytes; we base64 them and POST to
// /print. This is what lets the bridge stay ~1.6 MB (no embedded renderer).
function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
export async function printBytesToServer(target: string, bytes: Uint8Array): Promise<void> {
  if (!SERVER_URL) throw new Error('Print server not configured');
  const res = await fetch(PRINT_PATH, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', ...tokenHeaders() },
    body:    JSON.stringify({ target, data: bytesToBase64(bytes) }),
    signal:  AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error ?? `Print failed: HTTP ${res.status}`);
  }
}

// ─── Auto-connect on import ───────────────────────────────────────────────────

setTimeout(() => connectQZ(), 1500);
