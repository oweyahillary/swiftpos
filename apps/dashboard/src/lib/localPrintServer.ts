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

const SERVER_URL  = 'http://localhost:3001';
const HEALTH_PATH = `${SERVER_URL}/health`;
const PRINT_PATH  = `${SERVER_URL}/print`;
const TEST_PATH   = `${SERVER_URL}/print/test`;

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

export function getAvailablePrinters(): string[] { return availablePrinters; }

export function onQZStatusChange(fn: (s: QZStatus) => void): () => void {
  statusListeners.push(fn);
  fn(status); // emit immediately
  return () => { statusListeners = statusListeners.filter(l => l !== fn); };
}

// ─── Connect / health check ───────────────────────────────────────────────────

export async function connectQZ(): Promise<boolean> {
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

export async function disconnectQZ(): Promise<void> {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  setStatus('disconnected');
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
    headers: { 'Content-Type': 'application/json' },
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
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ printer: printerName, paperWidth }),
    signal:  AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error ?? `Test print failed: HTTP ${res.status}`);
  }
}

// ─── Auto-connect on import ───────────────────────────────────────────────────

setTimeout(() => connectQZ(), 1500);
