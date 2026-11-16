/**
 * useLongPress — a press-and-hold gesture, the Shop POS's hidden technician door to "This device" (/pos/device).
 *
 * The desktop hides its tech/device page the same way: no visible link, reached by a long-press on the logo on the PIN
 * screen (apps/desktop PinPage.tsx, 800 ms) behind a token gate. The Android app keeps the long-press but NOT a server
 * token: /pos/device (printer setup, Reset app, Join again) must open with NO connection — exactly when a technician needs
 * it — so a server round-trip would risk locking the technician out. The page's own destructive actions stay guarded
 * (Reset app has its confirm step).
 *
 * Spread the returned handlers on the element to hold (the PIN screen's brand header; the offline cover's card).
 */
import { useEffect, useRef } from 'react';

const HOLD_MS = 800;   // match the desktop so the two apps feel the same

export function useLongPress(onLongPress: () => void, ms: number = HOLD_MS) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  const start = () => { clear(); timer.current = setTimeout(() => { timer.current = null; onLongPress(); }, ms); };
  useEffect(() => clear, []);   // never leave a timer running past unmount
  return { onPointerDown: start, onPointerUp: clear, onPointerLeave: clear, onPointerCancel: clear };
}
