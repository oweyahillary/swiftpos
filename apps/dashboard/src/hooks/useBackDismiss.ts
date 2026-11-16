/**
 * useBackDismiss — close the TOPMOST open POS overlay when the Android app's hardware BACK button is pressed.
 *
 * The ZapTill Android Shop POS (apps/android/src/App.tsx) dispatches a cancelable CustomEvent('zaptill:back') on window
 * when the device back button is pressed. Each open overlay (the payment / receipt screen, the covers / parking / pump
 * modals, …) registers its close() here while it is open. A LIFO stack means one back press closes exactly ONE overlay —
 * the most recently opened — and preventDefault() tells the Android shell the press was consumed, so it does not then
 * navigate the router back. With nothing registered, the event is left un-prevented and the shell handles it (router
 * back, else stay on the PIN pad).
 *
 * It is INERT on the web and the desktop: nothing there dispatches 'zaptill:back', and this hook listens for nothing else
 * (no Escape) — so existing behaviour on those POS is unchanged. The one listener is installed once, lazily.
 *
 * Usage (while the overlay is open):
 *   useBackDismiss(completedOrder ? () => onSuccess(completedOrder.orderNumber) : closeModal, true);
 */
import { useEffect, useRef } from 'react';

export const BACK_EVENT = 'zaptill:back';

interface Entry { close: () => void }
const stack: Entry[] = [];
let installed = false;

function onBack(e: Event): void {
  const top = stack[stack.length - 1];
  if (!top) return;          // nothing registered open — let the Android shell fall through to router-back
  e.preventDefault();        // consumed: the shell must NOT also navigate
  stack.pop();
  top.close();
}

function ensureInstalled(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener(BACK_EVENT, onBack);
}

export function useBackDismiss(close: () => void, active: boolean): void {
  // The latest close() is kept in a ref, so a back press always runs the current closure (fresh props/state).
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!active) return;
    ensureInstalled();
    const entry: Entry = { close: () => closeRef.current() };
    stack.push(entry);
    return () => { const i = stack.indexOf(entry); if (i >= 0) stack.splice(i, 1); };
  }, [active]);
}
