/**
 * qzTray.ts
 *
 * QZ Tray connection manager.
 * QZ Tray is a small Java app installed on the POS computer.
 * It exposes a local WebSocket that lets the browser send raw
 * print commands directly to any printer — no dialog, instant print.
 *
 * Download: https://qz.io/download/
 *
 * This module:
 *   - Loads the QZ Tray JS library dynamically from CDN
 *   - Connects to the local WebSocket (wss://localhost:8181)
 *   - Exposes printToQZ(printerName, data, config)
 *   - Falls back gracefully if QZ is not installed
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type QZStatus = 'connecting' | 'connected' | 'disconnected' | 'unavailable';

interface QZConfig {
  paperWidth: 58 | 80;
  copies:     1 | 2;
  autoCut:    boolean;
}

// ESC/POS command bytes
const ESC  = '\x1b';
const GS   = '\x1d';
const INIT       = `${ESC}@`;                // initialize printer
const ALIGN_LEFT = `${ESC}a\x00`;
const ALIGN_CENTER = `${ESC}a\x01`;
const BOLD_ON    = `${ESC}E\x01`;
const BOLD_OFF   = `${ESC}E\x00`;
const DOUBLE_HEIGHT_ON  = `${ESC}!\x10`;
const DOUBLE_HEIGHT_OFF = `${ESC}!\x00`;
const CUT        = `${GS}V\x00`;            // full cut
const LINE_FEED  = '\n';

// ─── QZ singleton state ───────────────────────────────────────────────────────

let qz: any = null;             // the QZ library object
let status: QZStatus = 'disconnected';
let statusListeners: ((s: QZStatus) => void)[] = [];

function setStatus(s: QZStatus) {
  status = s;
  statusListeners.forEach(fn => fn(s));
}

export function getQZStatus(): QZStatus { return status; }

export function onQZStatusChange(fn: (s: QZStatus) => void): () => void {
  statusListeners.push(fn);
  fn(status); // immediately emit current status
  return () => { statusListeners = statusListeners.filter(l => l !== fn); };
}

// ─── Load QZ library ─────────────────────────────────────────────────────────

function loadQZScript(): Promise<any> {
  return new Promise((resolve, reject) => {
    if ((window as any).qz) { resolve((window as any).qz); return; }

    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/qz-tray@2.2.4/qz-tray.js';
    script.onload = () => {
      if ((window as any).qz) resolve((window as any).qz);
      else reject(new Error('QZ Tray script loaded but qz not found on window'));
    };
    script.onerror = () => reject(new Error('Failed to load QZ Tray script'));
    document.head.appendChild(script);
  });
}

// ─── Connect ──────────────────────────────────────────────────────────────────

export async function connectQZ(): Promise<boolean> {
  if (status === 'connected') return true;
  if (status === 'connecting') return false;

  setStatus('connecting');

  try {
    qz = await loadQZScript();

    // QZ Tray requires a security certificate or unsigned mode
    // For development / self-signed we use the promise-based unsigned approach
    qz.security.setCertificatePromise((_resolve: any, reject: any) => {
      // Return null to use the default unsigned certificate (prompts user once)
      reject('unsigned');
    });

    qz.security.setSignatureAlgorithm('SHA512');
    qz.security.setSignaturePromise((_toSign: any, _resolve: any, reject: any) => {
      reject('unsigned');
    });

    await qz.websocket.connect({
      host:    ['localhost', '127.0.0.1'],
      usingSecure: true,
    });

    qz.websocket.setClosedCallbacks(() => {
      setStatus('disconnected');
      // Auto-reconnect after 5 seconds
      setTimeout(() => { if (status === 'disconnected') connectQZ(); }, 5000);
    });

    setStatus('connected');
    return true;
  } catch (err: any) {
    console.warn('[QZ Tray] Connection failed:', err?.message ?? err);
    setStatus('unavailable');
    return false;
  }
}

export async function disconnectQZ(): Promise<void> {
  if (qz && status === 'connected') {
    try { await qz.websocket.disconnect(); } catch { /* silent */ }
  }
  setStatus('disconnected');
}

// ─── Get available printers ───────────────────────────────────────────────────

export async function getQZPrinters(): Promise<string[]> {
  if (status !== 'connected' || !qz) return [];
  try {
    return await qz.printers.find() as string[];
  } catch {
    return [];
  }
}

// ─── Build ESC/POS data from HTML content ────────────────────────────────────

/**
 * Converts a receipt/KOT text content string into ESC/POS command array.
 * We use a simple line-based approach — strip HTML tags, preserve structure.
 */
function htmlToEscPos(html: string, config: QZConfig): string[] {
  // Strip HTML tags but preserve line breaks and content
  const div = document.createElement('div');
  div.innerHTML = html;
  const text = div.innerText || div.textContent || '';
  const lines = text.split('\n').map(l => l.trimEnd());

  const cmds: string[] = [INIT];

  // Set character width based on paper size
  // 58mm: 32 chars/line, 80mm: 48 chars/line
  const lineWidth = config.paperWidth === 58 ? 32 : 48;

  for (const line of lines) {
    if (line.trim() === '') {
      cmds.push(LINE_FEED);
      continue;
    }

    // Detect heading lines (all caps, short) → center + bold + double height
    const isHeading = line.length <= 24 && line === line.toUpperCase() && /[A-Z]/.test(line);
    // Detect divider lines
    const isDivider = /^[-=*─]{3,}$/.test(line.trim());
    // Detect total lines
    const isTotal = /^TOTAL/i.test(line.trim());

    if (isHeading && !isDivider) {
      cmds.push(ALIGN_CENTER, BOLD_ON, DOUBLE_HEIGHT_ON);
      cmds.push(line + LINE_FEED);
      cmds.push(DOUBLE_HEIGHT_OFF, BOLD_OFF, ALIGN_LEFT);
    } else if (isDivider) {
      cmds.push(ALIGN_LEFT);
      cmds.push('-'.repeat(lineWidth) + LINE_FEED);
    } else if (isTotal) {
      cmds.push(BOLD_ON);
      cmds.push(line + LINE_FEED);
      cmds.push(BOLD_OFF);
    } else {
      cmds.push(ALIGN_LEFT);
      cmds.push(line + LINE_FEED);
    }
  }

  // Extra feed before cut
  cmds.push(LINE_FEED, LINE_FEED, LINE_FEED);

  if (config.autoCut) {
    cmds.push(CUT);
  }

  return cmds;
}

// ─── Print via QZ ─────────────────────────────────────────────────────────────

export async function printToQZ(
  printerName: string,
  html: string,
  config: QZConfig,
): Promise<void> {
  if (status !== 'connected' || !qz) {
    throw new Error('QZ Tray is not connected');
  }

  const cfg = qz.configs.create(printerName, {
    copies:    config.copies,
    density:   'default',
    orientation: 'portrait',
    size: {
      width:  config.paperWidth,
      height: null, // auto
      units:  'mm',
    },
  });

  const data = htmlToEscPos(html, config).map(cmd => ({
    type: 'raw',
    format: 'plain',
    data: cmd,
  }));

  await qz.print(cfg, data);
}

// ─── Auto-connect on import ───────────────────────────────────────────────────
// Try to connect when this module is first imported.
// This means the POS screen will attempt QZ on load.
setTimeout(() => connectQZ(), 1000);
