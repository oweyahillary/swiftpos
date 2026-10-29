/**
 * customerDisplayWire.ts — A606: the customer screen's Electron parts (the window, the screens, the number flashes, the
 * per-PC choice) and the slideshow's cache on this PC, made once. The rules are customerDisplay.ts / customerSlides.ts /
 * customerScreen.ts (tested with fakes); this file only connects them to Electron, the local database and the network.
 */
import { app, BrowserWindow, screen } from 'electron';
import path from 'path';
import { getLocalDb, getBranding } from './localDb';
import { getDeviceConfig } from './deviceConfig';
import { getReceiptPay } from './receiptPay';
import { logLine } from './logFile';
import { createCustomerDisplay, CHOICE_KEY, type CustomerDisplay, type DisplayWindow } from './customerDisplay';
import { createSlideCache, SLIDES_KEY, type SlideCache } from './customerSlides';
import { gateDisplayContent, mpesaFromReceiptLine, type DisplayContent, type NumberedScreen } from './customerScreen';

const isDev = (): boolean => { try { return !app.isPackaged; } catch { return false; } };

function stateRead(key: string): string | null {
  try {
    const row = getLocalDb().prepare(`SELECT value FROM maintenance_state WHERE key = ?`).get(key) as { value?: string } | undefined;
    return typeof row?.value === 'string' ? row.value : null;
  } catch { return null; }
}
function stateWrite(key: string, value: string | null): void {
  try {
    const db = getLocalDb();
    if (value === null) db.prepare(`DELETE FROM maintenance_state WHERE key = ?`).run(key);
    else db.prepare(`INSERT OR REPLACE INTO maintenance_state (key, value, updated_at) VALUES (?, ?, ?)`).run(key, value, new Date().toISOString());
  } catch { /* the next change */ }
}

/** The renderer page, on a BrowserWindow (the same build as the POS: index.html, route #/customer-display). */
function loadPage(win: BrowserWindow, hash: string): void {
  if (isDev()) void win.loadURL(`http://localhost:5174/#/${hash}`);
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: `/${hash}` });
}

/** A607: the customer screen's window, so its own page alone may answer a request and the cashier's windows are the rest. */
let customerWin: BrowserWindow | null = null;

function openWindow(s: NumberedScreen): DisplayWindow {
  const win = new BrowserWindow({
    x: s.x, y: s.y, width: s.width, height: s.height,
    frame: false, show: false, focusable: false, skipTaskbar: true, autoHideMenuBar: true, resizable: false,
    backgroundColor: '#f6f7f9', title: 'Customer screen',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, spellcheck: false,
      backgroundThrottling: false,   // the customer screen is never "hidden" — it is on its own monitor
    },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('page-title-updated', (e) => e.preventDefault());
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    win.setBounds({ x: s.x, y: s.y, width: s.width, height: s.height });
    win.showInactive();
    win.setFullScreen(true);
  });
  loadPage(win, 'customer-display');
  customerWin = win;
  win.on('closed', () => { if (customerWin === win) customerWin = null; });
  return {
    send: (channel, payload) => { if (!win.isDestroyed()) win.webContents.send(channel, payload); },
    moveTo: (t) => {
      if (win.isDestroyed()) return;
      win.setFullScreen(false);
      win.setBounds({ x: t.x, y: t.y, width: t.width, height: t.height });
      win.setFullScreen(true);
    },
    close: () => { if (!win.isDestroyed()) win.destroy(); },
    isDestroyed: () => win.isDestroyed(),
    onClosed: (cb) => win.on('closed', cb),
    isSender: (sender) => !win.isDestroyed() && sender === win.webContents,   // A607
  };
}

/** "Identify displays": a big number in the middle of each screen for a few seconds (a page of its own, no preload). */
function showNumber(s: NumberedScreen, ms: number): void {
  const w = 260, h = 260;
  const win = new BrowserWindow({
    x: Math.round(s.x + (s.width - w) / 2), y: Math.round(s.y + (s.height - h) / 2), width: w, height: h,
    frame: false, transparent: false, alwaysOnTop: true, focusable: false, skipTaskbar: true, resizable: false, show: false,
    backgroundColor: '#14202b', webPreferences: { contextIsolation: true, nodeIntegration: false, javascript: false, spellcheck: false },
  });
  const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#14202b;color:#fff;font-family:'Segoe UI',system-ui,sans-serif">`
    + `<div style="font-size:150px;font-weight:700;line-height:1">${s.n}</div><div style="font-size:18px;opacity:.75">${s.primary ? 'Cashier screen' : 'Screen'} ${s.n}</div></body>`;
  win.once('ready-to-show', () => { if (!win.isDestroyed()) win.showInactive(); });
  void win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  setTimeout(() => { if (!win.isDestroyed()) win.destroy(); }, ms);
}

let display: CustomerDisplay | null = null;
export function customerDisplay(): CustomerDisplay {
  if (display) return display;
  display = createCustomerDisplay({
    screens: () => {
      const primary = screen.getPrimaryDisplay().id;
      return screen.getAllDisplays().map((d) => ({ id: d.id, x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height, primary: d.id === primary }));
    },
    openWindow, showNumber,
    readChoice: () => { const v = stateRead(CHOICE_KEY); try { return v ? JSON.parse(v) : null; } catch { return null; } },
    writeChoice: (c) => stateWrite(CHOICE_KEY, JSON.stringify(c)),
    now: () => Date.now(),
    log: (l) => logLine('display', l),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as NodeJS.Timeout),
    // A607: the cashier's windows — every window but the customer screen's.
    toCashier: (channel, payload) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (w !== customerWin && !w.isDestroyed()) w.webContents.send(channel, payload);
      }
    },
  });
  return display;
}

let started = false;
/** At start, after the main window: open the customer screen if it is on and its screen is there; follow screen changes. */
export function startCustomerDisplay(): void {
  const d = customerDisplay();
  if (started) { try { d.apply(); } catch { /* the next screen change */ } return; }   // the main window made again
  started = true;
  try {
    d.apply();
    const again = () => { try { d.apply(); } catch (e) { console.warn('[display] screens changed:', (e as Error)?.message ?? e); } };
    screen.on('display-added', again);
    screen.on('display-removed', again);
    screen.on('display-metrics-changed', again);
  } catch (e) { console.warn('[display] start:', (e as Error)?.message ?? e); }
  void syncCustomerSlides();
}

/** The cashier's window closed (the app is going): the customer screen goes with it. */
export function stopCustomerDisplay(): void { try { display?.close(); } catch { /* gone */ } }

// ── The slideshow on this PC ─────────────────────────────────────────────────────────────────────────────────────────

let slides: SlideCache | null = null;
export function slideCache(): SlideCache {
  if (slides) return slides;
  slides = createSlideCache({
    dir: path.join(app.getPath('userData'), 'customer-screen'),
    store: { read: () => stateRead(SLIDES_KEY), write: (v) => stateWrite(SLIDES_KEY, v) },
    fetch: async (url) => {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 30_000);
      try {
        const r = await fetch(url, { signal: ctl.signal });
        const len = Number(r.headers.get('content-length'));
        return { ok: r.ok, status: r.status, type: r.headers.get('content-type') ?? '', length: Number.isFinite(len) && len > 0 ? len : null,
          body: async () => Buffer.from(await r.arrayBuffer()) };
      } finally { clearTimeout(t); }
    },
    now: () => Date.now(),
    log: (l) => logLine('display', l),
  });
  return slides;
}

export const licensed = (): boolean => { try { return getDeviceConfig()?.web_pos_enabled === true; } catch { return false; } };

/** A607: "The customer screen is a touch screen" — per PC (maintenance_state, no schema change). Off until set. */
export const TOUCH_KEY = 'customer_display_touch';
export function customerScreenTouch(): boolean { return stateRead(TOUCH_KEY) === '1'; }
export function setCustomerScreenTouch(on: boolean): void { stateWrite(TOUCH_KEY, on ? '1' : '0'); }

/** A pull said what the slideshow is (undefined = not said → keep). */
export function setCustomerScreenList(v: unknown): void {
  try { slideCache().setList(v); } catch (e) { console.warn('[display] slideshow list:', (e as Error)?.message ?? e); }
}

/** Fetch what is missing (each image once), drop what left the list. Cheap when nothing changed (no request at all). */
export async function syncCustomerSlides(): Promise<void> {
  try { await slideCache().sync(licensed()); } catch (e) { console.warn('[display] slideshow:', (e as Error)?.message ?? e); }
}

/** What the customer screen wears now — the premium gate (customerScreen.ts gateDisplayContent) decides each part. */
export function customerDisplayContent(): DisplayContent & { slideKeys: string[]; mode: string; currency: string } {
  const b = getBranding();
  let name: string | null = null, currency = 'KES';
  try {
    const s = getLocalDb().prepare(`SELECT business_name, currency FROM session WHERE id = 1`).get() as { business_name?: string; currency?: string } | undefined;
    name = s?.business_name ?? null;
    if (typeof s?.currency === 'string' && /^[A-Z]{3}$/.test(s.currency)) currency = s.currency;
  } catch { /* not signed in yet */ }
  const pay = getReceiptPay();
  const shown = licensed() ? slideCache().shown() : null;
  const c = gateDisplayContent({
    businessName: name,
    themeId: b?.effective?.themeId ?? b?.themeId ?? null,
    logo: b?.logoPng ?? null,
    primaryHex: b?.effective?.primaryHex ?? null, secondaryHex: b?.effective?.secondaryHex ?? null,
    accentHex: b?.effective ? b.effective.accentHex : (b?.accentHex ?? null),
    licensed: licensed(),
    slides: null,
    mpesa: pay ? mpesaFromReceiptLine(pay.label, pay.number) : null,
  });
  let mode = 'other';
  try { mode = String(getDeviceConfig()?.business_type ?? 'other').toLowerCase().replace(/\s+/g, '_'); } catch { /* */ }
  return { ...c, seconds: shown?.seconds ?? c.seconds, slideKeys: shown?.keys ?? [], mode, currency };
}
