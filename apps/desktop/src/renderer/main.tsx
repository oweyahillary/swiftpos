import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

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
  <React.StrictMode><App /></React.StrictMode>
);
