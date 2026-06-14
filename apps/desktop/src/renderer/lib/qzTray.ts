/**
 * qzTray.ts — desktop port of the dashboard's QZ Tray connection manager.
 *
 * QZ Tray is a small Java app installed on the POS computer. It exposes a
 * local WebSocket (wss://localhost:8181) that lets us send raw ESC/POS
 * commands straight to a thermal printer — no dialog, instant print.
 *
 * Download: https://qz.io/download/
 *
 * Differences from the dashboard version:
 *   - No auto-connect on import. The till is frequently OFFLINE; loading the
 *     QZ JS from CDN would fail and spam warnings. connectQZ() is called
 *     lazily on first print / when the printer settings modal opens, and the
 *     library is cached on window after the first successful load (QZ itself
 *     is local, so printing keeps working offline once the lib is cached).
 */

export type QZStatus = 'connecting' | 'connected' | 'disconnected' | 'unavailable';

export interface QZPrintConfig {
  paperWidth: 58 | 80;
  copies:     1 | 2;
  autoCut:    boolean;
}

// ESC/POS command bytes
const ESC  = '\x1b';
const GS   = '\x1d';
const INIT               = `${ESC}@`;
const ALIGN_LEFT         = `${ESC}a\x00`;
const ALIGN_CENTER       = `${ESC}a\x01`;
const BOLD_ON            = `${ESC}E\x01`;
const BOLD_OFF           = `${ESC}E\x00`;
const DOUBLE_HEIGHT_ON   = `${ESC}!\x10`;
const DOUBLE_HEIGHT_OFF  = `${ESC}!\x00`;
const CUT                = `${GS}V\x00`;
const LINE_FEED          = '\n';

// ─── Singleton state ──────────────────────────────────────────────────────────

let qz: any = null;
let status: QZStatus = 'disconnected';
let statusListeners: ((s: QZStatus) => void)[] = [];

function setStatus(s: QZStatus) {
  status = s;
  statusListeners.forEach(fn => fn(s));
}

export function getQZStatus(): QZStatus { return status; }

export function onQZStatusChange(fn: (s: QZStatus) => void): () => void {
  statusListeners.push(fn);
  fn(status);
  return () => { statusListeners = statusListeners.filter(l => l !== fn); };
}

// ─── Load QZ library ──────────────────────────────────────────────────────────

function loadQZScript(): Promise<any> {
  return new Promise((resolve, reject) => {
    if ((window as any).qz) { resolve((window as any).qz); return; }
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/qz-tray@2.2.4/qz-tray.js';
    script.onload = () => {
      if ((window as any).qz) resolve((window as any).qz);
      else reject(new Error('QZ Tray script loaded but qz not found on window'));
    };
    script.onerror = () => reject(new Error('Failed to load QZ Tray script (offline?)'));
    document.head.appendChild(script);
  });
}

// ─── Connect / disconnect ─────────────────────────────────────────────────────

export async function connectQZ(): Promise<boolean> {
  if (status === 'connected') return true;
  if (status === 'connecting') return false;

  setStatus('connecting');
  try {
    qz = await loadQZScript();

    // Unsigned mode — QZ prompts the user to allow this app once.
    qz.security.setCertificatePromise((_resolve: any, reject: any) => { reject('unsigned'); });
    qz.security.setSignatureAlgorithm('SHA512');
    qz.security.setSignaturePromise((_toSign: any, _resolve: any, reject: any) => { reject('unsigned'); });

    await qz.websocket.connect({ host: ['localhost', '127.0.0.1'], usingSecure: true });

    qz.websocket.setClosedCallbacks(() => {
      setStatus('disconnected');
      // Auto-reconnect after 5s (the lib is already loaded, so this works offline)
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

// ─── Printers ─────────────────────────────────────────────────────────────────

export async function getQZPrinters(): Promise<string[]> {
  if (status !== 'connected' || !qz) return [];
  try { return await qz.printers.find() as string[]; }
  catch { return []; }
}

// ─── HTML → ESC/POS ───────────────────────────────────────────────────────────

function htmlToEscPos(html: string, config: QZPrintConfig): string[] {
  const div = document.createElement('div');
  div.innerHTML = html;
  const text = div.innerText || div.textContent || '';
  const lines = text.split('\n').map(l => l.trimEnd());

  const cmds: string[] = [INIT];
  const lineWidth = config.paperWidth === 58 ? 32 : 48;

  for (const line of lines) {
    if (line.trim() === '') { cmds.push(LINE_FEED); continue; }

    const isHeading = line.length <= 24 && line === line.toUpperCase() && /[A-Z]/.test(line);
    const isDivider = /^[-=*─]{3,}$/.test(line.trim());
    const isTotal   = /^TOTAL/i.test(line.trim());

    if (isHeading && !isDivider) {
      cmds.push(ALIGN_CENTER, BOLD_ON, DOUBLE_HEIGHT_ON, line + LINE_FEED, DOUBLE_HEIGHT_OFF, BOLD_OFF, ALIGN_LEFT);
    } else if (isDivider) {
      cmds.push(ALIGN_LEFT, '-'.repeat(lineWidth) + LINE_FEED);
    } else if (isTotal) {
      cmds.push(BOLD_ON, line + LINE_FEED, BOLD_OFF);
    } else {
      cmds.push(ALIGN_LEFT, line + LINE_FEED);
    }
  }

  cmds.push(LINE_FEED, LINE_FEED, LINE_FEED);
  if (config.autoCut) cmds.push(CUT);
  return cmds;
}

// ─── Print ────────────────────────────────────────────────────────────────────

export async function printToQZ(printerName: string, html: string, config: QZPrintConfig): Promise<void> {
  if (status !== 'connected' || !qz) throw new Error('QZ Tray is not connected');

  const cfg = qz.configs.create(printerName, {
    copies: config.copies,
    density: 'default',
    orientation: 'portrait',
    size: { width: config.paperWidth, height: null, units: 'mm' },
  });

  const data = htmlToEscPos(html, config).map(cmd => ({ type: 'raw', format: 'plain', data: cmd }));
  await qz.print(cfg, data);
}

// Sends a short self-identifying ticket — used by the settings modal.
export async function testPrint(printerName: string, paperWidth: 58 | 80): Promise<void> {
  const html = `
    <div>
      <p>SWIFTPOS</p>
      <p>Printer test</p>
      <p>---------------</p>
      <p>Printer: ${printerName}</p>
      <p>Paper: ${paperWidth}mm</p>
      <p>${new Date().toLocaleString('en-KE')}</p>
      <p>---------------</p>
      <p>If you can read this, you're good.</p>
    </div>`;
  await printToQZ(printerName, html, { paperWidth, copies: 1, autoCut: true });
}
