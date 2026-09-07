/**
 * printRouted — B-engine (A252). Fan a web order to every configured printer with
 * REAL component-level routing, using the SAME shared engine the desktop uses
 * (toUnits + stationsForCategory, A249), fed from the web's existing
 * `branch_printers` config. No DB migration, no Printers-UI change.
 *
 * Each branch_printer is treated as a station:
 *   receipt          -> receipt kind  (all items, prices)
 *   kitchen | bar    -> kitchen kind  (routed: only units whose category routes here)
 *   kot | expeditor  -> dispatch kind (all items, no prices — full-order copies)
 *
 * A combo's components each route on their OWN category, so a combo's drink lands
 * on the bar/packer and its food on the grill — the thing line-level filtering
 * could not do. Owner kitchen-exclusions are stripped from kitchen-kind stations.
 */
import {
  renderStationEscPos, toUnits, stationsForCategory, idsByKind, isExcludedFromKitchen,
  type StationIds, type CategoryRouting,
} from './escposRenderer';
import { buildReceiptBusinessConfig } from './buildReceiptOrder';
import { getQZStatus, printBytesToServer } from './localPrintServer';
import type { BranchPrinter } from './printKOT';
import type { CartItem } from './cart';
import type { Business, Category, ComboComponent } from '../types';

const toCents = (n: number) => Math.round((Number(n) || 0) * 100);

type Kind = 'receipt' | 'kitchen' | 'dispatch';
const kindOf = (t: BranchPrinter['type']): Kind =>
  t === 'receipt' ? 'receipt' : (t === 'kitchen' || t === 'bar') ? 'kitchen' : 'dispatch';

const ORDER_TYPES: Record<string, string> = {
  takeaway: 'takeaway', dine_in: 'dine_in', delivery: 'delivery',
  counter: 'counter', retail: 'counter',
};

export interface PrintRoutedArgs {
  cart: CartItem[];
  branchPrinters: BranchPrinter[];
  business: Business;
  orderNumber: string;
  orderType: string;
  cashierName: string;
  total: number;
  change?: number;
  payments?: { method: string; amount: number }[];
  tableNumber?: string;
  comboItems?: Record<string, ComboComponent[]>;
  categories?: Category[];
  kitchenExclusions?: string[];
  ctlRate?: number;
  footerMessage?: string;
  /** Restrict to these station kinds (e.g. Send-to-Kitchen = kitchen+dispatch). */
  kinds?: Kind[];
}

export interface PrintRoutedResult { printed: number; failed: number; configured: number }

export async function printRoutedStations(a: PrintRoutedArgs): Promise<PrintRoutedResult> {
  const wanted = a.kinds ?? ['receipt', 'kitchen', 'dispatch'];
  const ORDER: Record<Kind, number> = { kitchen: 0, receipt: 1, dispatch: 2 };  // A247 sequence
  const printers = a.branchPrinters
    .filter(p => p.enabled && !!p.printer_name && wanted.includes(kindOf(p.type)))
    .sort((x, y) => ORDER[kindOf(x.type)] - ORDER[kindOf(y.type)]);
  if (printers.length === 0) return { printed: 0, failed: 0, configured: 0 };

  // Engine station ids: routed (kitchen/bar) vs all-items (kot/expeditor). Routing
  // is computed against ALL printers so a unit's stationIds mean the same thing on
  // every ticket, even if we only print a subset now.
  const all = a.branchPrinters.filter(p => p.enabled && !!p.printer_name);
  const ids: StationIds = {
    kitchen:  all.filter(p => kindOf(p.type) === 'kitchen').map(p => p.id),
    dispatch: all.filter(p => kindOf(p.type) === 'dispatch').map(p => p.id),
  };
  const byCategory: Record<string, string[]> = {};
  for (const p of all) {
    if (kindOf(p.type) !== 'kitchen') continue;          // only routed stations carry a category filter
    for (const c of p.category_ids) (byCategory[c] ??= []).push(p.id);
  }
  const routing: CategoryRouting = {
    byCategory,
    kitchenCategories: new Set((a.categories ?? []).filter(c => c.is_kitchen).map(c => c.id)),
  };

  const lines = a.cart.map(item => {
    const cat = item.product?.category_id ?? null;
    const lineStationIds = stationsForCategory(cat, ids, routing);
    const routable = {
      product: {
        id: item.product?.id ?? '',
        name: item.product?.name ?? 'Item',
        category_id: cat,
        description: (item.product as any)?.description ?? null,
      },
      selectedVariants: item.selectedVariants,
      selectedModifiers: item.selectedModifiers,
      comboComponents: a.comboItems?.[item.product?.id ?? ''],
    };
    let units = toUnits(routable, ids, lineStationIds, routing);
    // Owner exclusions: drop kitchen station ids from an excluded unit, exactly as
    // the desktop's stripKitchen does (dispatch/receipt keep it).
    const exc = a.kitchenExclusions ?? [];
    if (exc.length) {
      units = units.map(u => isExcludedFromKitchen(u.name, exc)
        ? { ...u, stationIds: u.stationIds.filter((id: string) => !ids.kitchen.includes(id)) }
        : u);
    }
    return {
      name: item.product?.name ?? 'Item',
      quantity: item.quantity,
      unitPrice: toCents(item.unitPrice),
      lineTotal: toCents(item.lineTotal),
      stationIds: lineStationIds,
      units,
    };
  });

  const order = {
    billNumber: a.orderNumber,
    orderType: (ORDER_TYPES[a.orderType] ?? 'counter') as any,
    cashierName: a.cashierName || 'Cashier',
    soldAt: new Date().toISOString(),
    tableNumber: a.tableNumber,
    lines,
    payments: (a.payments ?? []).map(p => ({ label: p.method, amount: toCents(p.amount) })),
    changeGiven: toCents(a.change ?? 0),
    total: toCents(a.total),
    kotCount: 0,
  } as any;
  const biz = buildReceiptBusinessConfig(a.business, a.footerMessage, a.ctlRate ?? 0);

  let printed = 0, failed = 0;
  for (const p of printers) {
    try {
      if (getQZStatus() === 'connected') {
        const bytes = renderStationEscPos(order, biz as any, { id: p.id, kind: kindOf(p.type), paperWidthMm: p.paper_width });
        await printBytesToServer(`printer:${p.printer_name}`, bytes);
        printed++;
      } else { failed++; }
    } catch (err: any) {
      console.error(`[printRouted] ${p.type} → ${p.printer_name} failed:`, err?.message);
      failed++;
    }
  }
  return { printed, failed, configured: printers.length };
}
