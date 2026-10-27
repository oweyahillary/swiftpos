import { useEffect, useState } from 'react';
import { NO_STOCK_VIEW, type OutOfStockMode, type StockView } from '@zaptill/core/stockGate';

/**
 * useStockView — A563: the owner's "When an item's stock reaches zero" choice and this branch's known levels of tracked
 * items (GET /api/pos/stock-view), for the web POS: an item that is out is greyed "Sold out" or hidden (lib/stockGate.ts).
 * Checked every 30 s and after each sale (`refresh`). Any error = "sell" with nothing known (never block a sale by
 * accident) — the cloud refuses a sold-out sale itself (POST /orders, 409 SOLD_OUT).
 */
export type WebStockView = StockView & { mode: OutOfStockMode };

const SELL: WebStockView = { mode: 'sell', ...NO_STOCK_VIEW };

export function useStockView(get: <T>(path: string) => Promise<T>, branchId: string | null | undefined): { view: WebStockView; refresh: () => void } {
  const [view, setView] = useState<WebStockView>(SELL);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!branchId) { setView(SELL); return; }
    let alive = true;
    const check = () => {
      get<WebStockView>(`/api/pos/stock-view?branch_id=${encodeURIComponent(branchId)}`)
        .then((v) => { if (alive && v && typeof v === 'object' && v.levels) setView(v); })
        .catch(() => { if (alive) setView(SELL); });
    };
    check();
    const t = setInterval(check, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, [branchId, tick]);   // eslint-disable-line react-hooks/exhaustive-deps — `get` is a new function every render (POSAuthContext)
  return { view, refresh: () => setTick((n) => n + 1) };
}
