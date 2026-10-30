import React, { lazy, Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { stopWheelOnNumberInputs } from '../shared/numberInputs';
import { startActivityPings } from './lib/activity';   // A508

stopWheelOnNumberInputs(document);
// A606: the customer screen's window (the second monitor) loads this same page at #/customer-display — its own chunk,
// and never the POS. A customer touching it is not the cashier using the PC: no activity pings from it.
const customerScreen = window.location.hash.startsWith('#/customer-display');
const CustomerDisplayPage = lazy(() => import('./pages/CustomerDisplayPage'));
// A508: the screen in use (a key, a click, a touch; at most one ping every 30 s) — an update installs on its own only
// when nobody is there. Once, here at the root.
if (!customerScreen) startActivityPings();

// A299: forward renderer-side errors to the main-process log (swiftpos.log).
// This is the piece that would have caught "[Overview] salesSummary failed" in
// the file instead of only in a DevTools screenshot. Guarded so it can never
// break rendering, and it echoes to the real console first.
(() => {
  const fwd = (window as any).swiftpos?.logError as ((m: string) => void) | undefined;
  if (!fwd) return;
  const fmt = (a: unknown) =>
    a instanceof Error ? (a.stack || a.message)
    : typeof a === 'object' ? (() => { try { return JSON.stringify(a); } catch { return String(a); } })()
    : String(a);
  window.addEventListener('error', (e) => {
    try { fwd(`window.onerror: ${e.message}${e.filename ? ` @ ${e.filename}:${e.lineno}` : ''}`); } catch { /* ignore */ }
  });
  window.addEventListener('unhandledrejection', (e) => {
    try { fwd(`unhandledrejection: ${fmt((e as PromiseRejectionEvent).reason)}`); } catch { /* ignore */ }
  });
  for (const level of ['error', 'warn'] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      orig(...args);
      try { fwd(`console.${level}: ${args.map(fmt).join(' ')}`); } catch { /* ignore */ }
    };
  }
})();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{customerScreen ? <Suspense fallback={null}><CustomerDisplayPage /></Suspense> : <App />}</React.StrictMode>
);
