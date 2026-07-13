/**
 * usePOSData — data loading hook for the POS screen.
 *
 * Extracted from CashierScreen to isolate all API calls and loading state.
 * Fetches products, categories, variants, tables/bays/pumps, printers,
 * and order mode setting in parallel where possible.
 *
 * The hook returns stable references — only re-fetches when `session` changes.
 */

import { useState, useEffect, useCallback, type Dispatch, type SetStateAction } from 'react';
import { api } from '../../../lib/api';
import { usePOSAuth } from '../../../context/POSAuthContext';
import { connectQZ } from '../../../lib/localPrintServer';
import type { BranchPrinter } from '../../../lib/printKOT';
import {
  deriveMode,
  type BusinessMode,
  type Table,
  type Pump,
  type Product,
  type Category,
  type VariantGroup,
  type POSInitResponse,
} from './types';

export interface POSData {
  products:          Product[];
  categories:        Category[];
  variantsByProduct: Record<string, VariantGroup[]>;
  tables:            Table[];
  pumps:             Pump[];
  setPumps:          Dispatch<SetStateAction<Pump[]>>;
  branchPrinters:    BranchPrinter[];
  businessMode:      BusinessMode;
  currency:          string;
  loyaltyEnabled:    boolean;
  orderMode:         'pay_first' | 'order_first';
  loading:           boolean;
  reload:            () => void;
}

export function usePOSData(): POSData {
  const { session, posApi } = usePOSAuth();

  const [products,          setProducts]          = useState<Product[]>([]);
  const [categories,        setCategories]        = useState<Category[]>([]);
  const [variantsByProduct, setVariantsByProduct] = useState<Record<string, VariantGroup[]>>({});
  const [tables,            setTables]            = useState<Table[]>([]);
  const [pumps,             setPumps]             = useState<Pump[]>([]);
  const [branchPrinters,    setBranchPrinters]    = useState<BranchPrinter[]>([]);
  const [businessMode,      setBusinessMode]      = useState<BusinessMode>('retail');
  const [currency,          setCurrency]          = useState('KES');
  const [loyaltyEnabled,    setLoyaltyEnabled]    = useState(false);
  const [orderMode,         setOrderMode]         = useState<'pay_first' | 'order_first'>('pay_first');
  const [loading,           setLoading]           = useState(true);
  const [tick,              setTick]              = useState(0);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);

    try {
      // ── Core POS init ──────────────────────────────────────────────────────
      const init = await posApi.get<POSInitResponse>(
        `/api/pos/init?branch_id=${session.branchId}`
      );

      setProducts(init.products ?? []);
      setCategories(init.categories ?? []);
      setVariantsByProduct(init.variantsByProduct ?? {});
      setCurrency(init.currency ?? 'KES');
      setLoyaltyEnabled(init.loyaltyEnabled ?? false);

      const mode = deriveMode(init.businessType ?? 'retail');
      setBusinessMode(mode);

      const isRest = mode === 'restaurant' || mode === 'cafe';
      const isPark = mode === 'parking';
      const isPet  = mode === 'petrol_station';

      // ── Parallel: tables/bays/pumps + printers + order mode ───────────────
      const [tableData, pumpData, printerData, settingsData] = await Promise.allSettled([
        // Tables (restaurant) or bays (parking)
        isRest
          ? posApi.get<Table[]>(`/api/tables?branch_id=${session.branchId}`)
          : isPark
          ? posApi.get<Table[]>(`/api/tables?branch_id=${session.branchId}&slot_type=parking_bay`)
          : Promise.resolve([] as Table[]),

        // Pumps (petrol)
        isPet
          ? posApi.get<Pump[]>(`/api/pumps?branch_id=${session.branchId}`)
          : Promise.resolve([] as Pump[]),

        // Branch printers for KOT routing
        api.get<BranchPrinter[]>(`/api/printers?branch_id=${session.branchId}`),

        // Restaurant order mode setting
        isRest
          ? api.get<{ key: string; value: string }[]>('/api/business/settings')
          : Promise.resolve([] as { key: string; value: string }[]),
      ]);

      if (tableData.status === 'fulfilled') {
        const rows = tableData.value ?? [];
        setTables(isRest ? rows.filter(t => !t.slot_type || t.slot_type === 'dining') : rows);
      }
      if (pumpData.status === 'fulfilled')    setPumps(pumpData.value ?? []);
      if (printerData.status === 'fulfilled') setBranchPrinters((printerData.value ?? []).filter(p => p.enabled));
      if (settingsData.status === 'fulfilled') {
        const modeSetting = (settingsData.value ?? []).find(s => s.key === 'restaurant_order_mode');
        if (modeSetting?.value === 'order_first') setOrderMode('order_first');
      }

      // Connect to print server (non-blocking)
      connectQZ().catch(() => {});

    } catch {
      // Silent — session guard at the top prevents auth errors here
    } finally {
      setLoading(false);
    }
  }, [session, posApi]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    products, categories, variantsByProduct,
    tables, pumps, setPumps, branchPrinters,
    businessMode, currency, loyaltyEnabled, orderMode,
    loading,
    reload: () => setTick(t => t + 1),
  };
}
