/**
 * localPrintServer.ts
 *
 * Client for the SwiftPOS local print server.
 * The print server is a small .exe that runs on the POS computer and
 * accepts HTTP print jobs — works on Chrome, Firefox, Edge, Safari.
 *
 * API surface is identical to the old qzTray.ts so no other files need changing.
 *
 * Detection:
 *   On load, pings http://localhost:3001/health.
 *   Connected  → silent one-click printing via HTTP POST.
 *   Not found  → falls back to window.print() browser dialog.
 *
 * Download print server: provided as SwiftPOS-PrintServer.exe
 */

// The local print bridge must NOT share the API's port. It defaulted to
// localhost:3001 (the dev API port), so print-server detection was polling the
// backend's /health (a Supabase ping that 503s) — hammering it and always
// reporting the printer as down. Configure VITE_PRINT_SERVER_URL to your bridge's
// address (e.g. http://localhost:9100); leave it unset to disable the feature.
// The bridge listens on 127.0.0.1:9911 (distinct from the dev API port). We default
// to that so no build-time env is needed; VITE_PRINT_SERVER_URL can override it.
const SERVER_URL  = (import.meta.env.VITE_PRINT_SERVER_URL as string | undefined) || 'http://127.0.0.1:9911';
const HEALTH_PATH = `${SERVER_URL}/health`;
const PRINT_PATH  = `${SERVER_URL}/print`;
const TEST_PATH   = `${SERVER_URL}/print/test`;
const RECEIPT_PATH = `${SERVER_URL}/print/receipt`;

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

interface PrintConfig {
  paperWidth: 58 | 80;
  copies:     1 | 2;
  autoCut:    boolean;
}

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
    const res = await fetch(`${SERVER_URL}/printers`, { signal: AbortSignal.timeout(3000) });
    const data = await res.json();
    availablePrinters = data.printers ?? [];
    return availablePrinters;
  } catch {
    return availablePrinters;
  }
}

// ─── Print ────────────────────────────────────────────────────────────────────

export async function printToQZ(
  printerName: string,
  html: string,
  config: PrintConfig,
): Promise<void> {
  if (status !== 'connected') {
    throw new Error('Print server is not connected');
  }

  const res = await fetch(PRINT_PATH, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', ...tokenHeaders() },
    body:    JSON.stringify({
      printer:    printerName,
      content:    html,
      paperWidth: config.paperWidth,
      copies:     config.copies,
      autoCut:    config.autoCut,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error ?? `Print failed: HTTP ${res.status}`);
  }
}

// ─── Test print ───────────────────────────────────────────────────────────────

export async function testPrint(printerName: string, paperWidth: 58 | 80): Promise<void> {
  const res = await fetch(TEST_PATH, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', ...tokenHeaders() },
    body:    JSON.stringify({ printer: printerName, target: printerName, paperWidth }),
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

// ─── Silent receipt via the bridge (server renders ESC/POS from the Order) ─────
// A235: the correct web path. We send the Order + business JSON to /print/receipt;
// the bridge renders it with shared/printing (identical to desktop) and prints.
// Throws on any failure so the caller can fall back to the browser dialog.
export async function printReceiptViaServer(
  target: string,
  order: unknown,
  business: unknown,
  paperWidth: 58 | 80,
): Promise<void> {
  if (!SERVER_URL) throw new Error('Print server not configured');
  const res = await fetch(RECEIPT_PATH, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', ...tokenHeaders() },
    body:    JSON.stringify({ target, order, business, paperWidth }),
    signal:  AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error ?? `Receipt print failed: HTTP ${res.status}`);
  }
}

// ─── Auto-connect on import ───────────────────────────────────────────────────

setTimeout(() => connectQZ(), 1500);
