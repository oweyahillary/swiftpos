/**
 * connection.ts — is the Shop POS online? Till stage 1 sells ONLY online (offline selling is Till stage 2), so without a
 * connection the screen says "No connection — can't sell" instead of letting a cashier ring up a sale that cannot be saved.
 *
 * Android's own "offline" is trusted at once; "online" is confirmed by asking the cloud (/api/health, every 20 s while
 * online, every 5 s while not) — a Wi-Fi with no internet behind it is not online.
 */
import { useEffect, useState } from 'react';
import { cloudGet } from '../cloud/client';

async function cloudAnswers(): Promise<boolean> {
  try { await cloudGet('/health'); return true; } catch { return false; }
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      const now = navigator.onLine && await cloudAnswers();
      if (!live) return;
      setOnline(now);
      timer = setTimeout(() => { void check(); }, now ? 20_000 : 5_000);
    };
    const offline = () => setOnline(false);
    const back = () => { clearTimeout(timer); void check(); };
    window.addEventListener('offline', offline);
    window.addEventListener('online', back);
    void check();
    return () => { live = false; clearTimeout(timer); window.removeEventListener('offline', offline); window.removeEventListener('online', back); };
  }, []);
  return online;
}
