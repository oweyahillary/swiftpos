import { useEffect, useState } from 'react';

/**
 * useStockCountFreeze — A394: the items a running stock count freezes at this branch (the owner's choice). The web POS
 * refuses them at the counter; the cloud refuses them at payment too (POST /orders, STOCK_COUNT_FROZEN). Checked every
 * 30 s, so an item is released soon after it has been counted. Any error = nothing frozen (never block a sale by
 * accident).
 */
export interface StockCountFreeze { ref: string | null; frozen: Set<string> }

const NONE: StockCountFreeze = { ref: null, frozen: new Set() };

export function useStockCountFreeze(get: <T>(path: string) => Promise<T>, branchId: string | null | undefined): StockCountFreeze {
  const [state, setState] = useState<StockCountFreeze>(NONE);
  useEffect(() => {
    if (!branchId) { setState(NONE); return; }
    let alive = true;
    const check = () => {
      get<{ ref: string; freeze: boolean; frozen_product_ids?: string[] } | null>(`/api/stock-takes/active?branch_id=${branchId}`)
        .then((a) => {
          if (!alive) return;
          const ids = a?.freeze ? (a.frozen_product_ids ?? []) : [];
          setState(ids.length ? { ref: a!.ref, frozen: new Set(ids) } : NONE);
        })
        .catch(() => { if (alive) setState(NONE); });
    };
    check();
    const t = setInterval(check, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, [branchId]);   // eslint-disable-line react-hooks/exhaustive-deps — `get` is a new function every render (POSAuthContext)
  return state;
}

export function frozenMessage(ref: string | null, name: string): string {
  return `${name} is being counted${ref ? ` (${ref})` : ''} — it can be sold again once it has been counted.`;
}
