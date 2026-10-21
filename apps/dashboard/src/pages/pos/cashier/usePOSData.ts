/**
 * usePOSData — data loading hook for the POS screen.
 *
 * Extracted from CashierScreen to isolate all API calls and loading state.
 * Fetches products, categories, variants, tables/bays/pumps, printers,
 * and order mode setting in parallel where possible.
 *
 * The hook returns stable references — only re-fetches when `session` changes.
 */

import { cleanOffer, type Offer } from '../../../lib/offers';   // A445
import { parseNotePicks } from '../../../lib/orderNotes';
import { parsePosFeatures, noPosFeatures, type PosFeatures } from '../../../lib/posFeatures';
import { rulesFromWire } from '../../../lib/reversalRules';
import { setWebDayCutoff } from '../../../lib/webDayCutoff';   // 0.6.34   // 0.6.33: the owner's free-delivery rule
import { monoRasterFromString, type MonoRaster } from '../../../lib/escposRenderer';
import { resolveBranchBranding, branchBrandingFromWire } from '../../../lib/branchBranding';   // A544
import { setPosBranchTheme, applyDashboardThemeVars, computeDashboardThemeVars, posBrandStrip } from '../../../lib/themeVars';   // A544, A547
import { useState, useEffect, useCallback, type Dispatch, type SetStateAction } from 'react';
import { api } from '../../../lib/api';
import { usePOSAuth } from '../../../context/POSAuthContext';
import { connectQZ } from '../../../lib/localPrintServer';
import type { BranchPrinter } from '../../../lib/printKOT';
import type { ComboComponent, Menu } from '../../../types';
import {
  deriveMode,
  type BusinessMode,
  type Table,
  type Pump,
  type Product,
  type Category,
  type VariantGroup,
  type POSInitResponse,
  DEFAULT_MAX_DISCOUNT_PCT,
} from './types';

export interface POSData {
  products:          Product[];
  categories:        Category[];
  /** A537: the business's menus (Food, Soft drinks …) — on, in order; [] = none (the plain category list). */
  menus:             Menu[];
  variantsByProduct: Record<string, VariantGroup[]>;
  comboItems:        Record<string, ComboComponent[]>;
  kitchenExclusions: string[];
  /** A367: the owner's quick picks for order notes. */
  notePicks:         string[];
  /** 0.6.27: the per-client POS switches (admin portal); all off until pos/init says. */
  posFeatures:       PosFeatures;
  /** 0.6.33: the owner allows free delivery — the shop pays the rider, the customer no fee (pos/init's reversalRules). */
  freeDeliveryAllowed: boolean;
  /** 0.6.33: a delivery whose bill reaches this amount is free automatically; null = off. */
  freeDeliveryOver: number | null;
  receiptHeader:     string;
  /** A313: the receipt logo to print, already gated on the client's toggle; null = none. */
  receiptLogo:       MonoRaster | null;
  receiptFooter:     string;
  receiptPay:        { label: string; number: string } | null;   // A450
  /** A547: the brand strip's colour (the till's A326 strip) — the branch's colour, else the business's; null with themes off. */
  brandStrip:        string | null;
  tables:            Table[];
  pumps:             Pump[];
  setPumps:          Dispatch<SetStateAction<Pump[]>>;
  branchPrinters:    BranchPrinter[];
  businessMode:      BusinessMode;
  currency:          string;
  loyaltyEnabled:    boolean;
  maxDiscountPct:    number;
  paymentMethods:    { code: string; name: string }[];
  /** A429: the payment methods this branch takes (null = not sent = the catalogue's defaults). */
  paymentMethodsEnabled: string[] | null;
  /** A445: the branch's offers, cleaned (shared/offers.ts). */
  offers: Offer[];
  orderMode:         'pay_first' | 'order_first';
  loading:           boolean;
  error:             string | null;
  reload:            () => void;
}

export function usePOSData(): POSData {
  const { session, posApi } = usePOSAuth();

  const [products,          setProducts]          = useState<Product[]>([]);
  const [categories,        setCategories]        = useState<Category[]>([]);
  const [menus,             setMenus]             = useState<Menu[]>([]);   // A537
  const [paymentMethods,    setPaymentMethods]    = useState<{ code: string; name: string }[]>([]);
  const [paymentMethodsEnabled, setPaymentMethodsEnabled] = useState<string[] | null>(null);   // A429
  const [offers, setOffers] = useState<Offer[]>([]);   // A445
  const [variantsByProduct, setVariantsByProduct] = useState<Record<string, VariantGroup[]>>({});
  const [comboItems,        setComboItems]        = useState<Record<string, ComboComponent[]>>({});
  const [kitchenExclusions, setKitchenExclusions] = useState<string[]>([]);
  const [notePicks, setNotePicks] = useState<string[]>([]);
  const [posFeatures, setPosFeatures] = useState<PosFeatures>(noPosFeatures());
  const [freeDeliveryAllowed, setFreeDeliveryAllowed] = useState(false);   // 0.6.33
  const [freeDeliveryOver, setFreeDeliveryOver] = useState<number | null>(null);   // 0.6.33
  const [receiptHeader,     setReceiptHeader]     = useState('');
  const [receiptLogo,       setReceiptLogo]       = useState<MonoRaster | null>(null);
  const [receiptFooter,     setReceiptFooter]     = useState('');
  const [branchThemeId,     setBranchThemeId]     = useState<string | null>(null);   // A544: the branch's own theme
  const [brandStrip,        setBrandStrip]        = useState<string | null>(null);   // A547: the till's brand strip, on the web POS
  const [receiptPay,        setReceiptPay]        = useState<{ label: string; number: string } | null>(null);   // A450
  const [tables,            setTables]            = useState<Table[]>([]);
  const [pumps,             setPumps]             = useState<Pump[]>([]);
  const [branchPrinters,    setBranchPrinters]    = useState<BranchPrinter[]>([]);
  const [businessMode,      setBusinessMode]      = useState<BusinessMode>('retail');
  const [currency,          setCurrency]          = useState('KES');
  const [loyaltyEnabled,    setLoyaltyEnabled]    = useState(false);
  const [maxDiscountPct,    setMaxDiscountPct]    = useState(DEFAULT_MAX_DISCOUNT_PCT);
  const [orderMode,         setOrderMode]         = useState<'pay_first' | 'order_first'>('pay_first');
  const [loading,           setLoading]           = useState(true);
  const [error,             setError]             = useState<string | null>(null);
  const [tick,              setTick]              = useState(0);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setError(null);

    try {
      // ── Core POS init ──────────────────────────────────────────────────────
      const init = await posApi.get<POSInitResponse>(
        `/api/pos/init?branch_id=${session.branchId}`
      );

      setProducts(init.products ?? []);
      setCategories(init.categories ?? []);
      setMenus(Array.isArray(init.menus) ? init.menus : []);   // A537 (an older cloud sends none)
      setPaymentMethods(init.paymentMethods ?? []);
      setPaymentMethodsEnabled(Array.isArray(init.paymentMethodsEnabled) ? init.paymentMethodsEnabled : null);   // A429
      setOffers((Array.isArray(init.offers) ? init.offers : []).flatMap((o) => { const c = cleanOffer(o); return c.ok ? [(c as { offer: Offer }).offer] : []; }));   // A445
      setVariantsByProduct(init.variantsByProduct ?? {});
      setComboItems(init.comboItems ?? {});
      setKitchenExclusions(init.kitchenExclusions ?? []);
      setNotePicks(parseNotePicks(init.noteQuickPicks ?? null));   // A367 (an older cloud sends none → the defaults)
      setPosFeatures(parsePosFeatures(init.posFeatures ?? null));   // 0.6.27 (an older cloud sends none → all off)
      setWebDayCutoff((init as any).businessDayCutoff);   // 0.6.34: History's "today" follows the business day
      setFreeDeliveryAllowed(rulesFromWire(init.reversalRules ?? null).freeDeliveryAllowed);   // 0.6.33 (none → not offered)
      setFreeDeliveryOver(rulesFromWire(init.reversalRules ?? null).freeDeliveryOver);         // 0.6.33 (none → off)
      setReceiptHeader(init.receiptHeader ?? '');
      // A313: resolve the receipt logo ONCE here, the same gate the till applies
      // (resolveReceiptLogo in ipcHandlers): toggle ON and a decodable raster.
      setReceiptLogo(init.branding?.receiptLogoEnabled && init.branding.logoReceipt
        ? monoRasterFromString(init.branding.logoReceipt) : null);
      // A544: this branch's look and footer — its override per field, else the business's, else the ZapTill default
      // (lib/branchBranding.ts, the till's own rule). Only while the business has themes (init.themeId not null).
      const look = resolveBranchBranding(
        { themeId: init.themeId ?? null, accentHex: init.branding?.accentHex ?? null, receiptFooter: init.receiptFooter ?? '' },
        branchBrandingFromWire(init.branchBranding));
      setReceiptFooter(look.receiptFooter);
      setBranchThemeId(look.fromBranch.theme ? look.themeId : null);
      // A547: the brand strip the till draws — the branch's colour, else the business's — only while themes are on.
      setBrandStrip(posBrandStrip(look.themeId, look.accentHex));
      setReceiptPay(init.receiptPayNumber ? { label: init.receiptPayLabel ?? '', number: init.receiptPayNumber } : null);   // A450
      setCurrency(init.currency ?? 'KES');
      setLoyaltyEnabled(init.loyaltyEnabled ?? false);
      // Clamp the web POS to the server's discount ceiling. Falls back to the
      // shared default if an older server does not advertise it.
      setMaxDiscountPct(init.maxDiscountPct ?? DEFAULT_MAX_DISCOUNT_PCT);

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

    } catch (err: any) {
      // Do NOT swallow this. A failed /api/pos/init (e.g. a licence 403) used to
      // be silently ignored, leaving businessMode at its 'retail' default — which
      // made a restaurant look like a retail shop. Surface the real error instead.
      const msg = err?.message || 'Failed to load POS data. Check your connection and try again.';
      console.error('[usePOSData] init failed:', msg);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [session, posApi]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  // A544: the web POS wears its branch's theme while it is open (ThemeLayer defers to it); leaving gives the business's back.
  // Applied here as well: a cashier's POS session may have no owner sign-in for ThemeLayer to read the business with.
  useEffect(() => {
    if (!branchThemeId) return;
    applyDashboardThemeVars(computeDashboardThemeVars({ themes_enabled: true, theme_id: branchThemeId }));
    setPosBranchTheme(branchThemeId);
    return () => { applyDashboardThemeVars(null); setPosBranchTheme(null); };
  }, [branchThemeId]);

  return {
    products, categories, menus, variantsByProduct, comboItems, kitchenExclusions, notePicks, posFeatures, freeDeliveryAllowed, freeDeliveryOver, receiptHeader, receiptLogo, receiptFooter, receiptPay,
    brandStrip,   // A547
    tables, pumps, setPumps, branchPrinters,
    businessMode, currency, loyaltyEnabled, maxDiscountPct, paymentMethods, paymentMethodsEnabled, offers, orderMode,
    loading, error,
    reload: () => setTick(t => t + 1),
  };
}
