import { useEffect, useState, useRef } from 'react';
import { posApi } from '../lib/posApi';
import { cartSubtotal, extractTaxes, computeUnitPrice, computeLineTotal, generateOrderNumber, effectivePrice } from '../lib/cart';
import type { CartItem } from '../lib/cart';
import { modeFlags } from '../lib/posMode';
import type { ModeFlags } from '../lib/posMode';
import { listHeldOrders, holdOrder, recallHeldOrder, deleteHeldOrder, importLegacyHeldOrders } from '../lib/heldOrders';
import type { HeldOrder } from '../lib/heldOrders';
import TablesView from '../components/TablesView';
import PumpsView from '../components/PumpsView';
import type { DiningTable, Pump } from '../lib/posApi';
import { buildTicketLines, kitchenOnly, linesForStation, routingIsConfigured, ROUTING_UNCONFIGURED } from '../lib/ticketLines';
import type { StationRouting } from '../lib/ticketLines';
import type { ComboMap } from '../lib/ticketLines';
import { printReceipt } from '../lib/printReceipt';
import { usePrinterSettings } from '../hooks/usePrinterSettings';
import VariantModal from '../components/VariantModal';
import ReceiptView from '../components/ReceiptView';
import PaymentModal from '../components/PaymentModal';
import type { PaymentResult } from '../components/PaymentModal';
import PrinterSettingsModal from '../components/PrinterSettingsModal';
import OpenDrawerModal from '../components/OpenDrawerModal';
import HeldOrdersModal from '../components/HeldOrdersModal';
import VoidModal from '../components/VoidModal';
import ShiftPanel from './ShiftPanel';
import type { ZReport } from '../lib/posApi';

interface Props {
  business: { id: string; name: string; currency: string };
  onLogout: () => void;
  // Present only when the signed-in staff member has manager rights. The POS
  // screen was previously a one-way trip: an owner who opened it to check a
  // change had to sign out and re-enter a PIN to get back to the Menu tab,
  // which on a setup day is that loop every few minutes.
  onOpenManager?: () => void;
  /**
   * May this person change printer configuration? Same test as onOpenManager,
   * but passed explicitly rather than inferred from it — inferring a permission
   * from the presence of a navigation callback is the kind of coupling that
   * quietly grants access the day someone adds a second reason to show the
   * button.
   */
  canManagePrinters?: boolean;
}

export default function POSPage({ business, onLogout, onOpenManager, canManagePrinters = false }: Props) {
  const [products, setProducts] = useState<any[]>([]);
  const [categories, setCategories] = useState<any[]>([]);
  const [branchId, setBranchId] = useState<string | null>(null);
  // Real business rate from /api/pos/init, persisted locally by each catalogue
  // pull. Null only before the first sync completes.
  const [vatRateFromServer, setVatRateFromServer] = useState<number | null>(null);
  const [ctlRateFromServer, setCtlRateFromServer] = useState<number>(0);
  // Discount ceiling the server will enforce on write. Null until the first
  // sync, when the shared default (the server's own) applies instead.
  const [maxDiscountPct, setMaxDiscountPct] = useState<number | null>(null);
  // Combo definitions and kitchen routing, refreshed by each catalogue pull.
  const [comboItems, setComboItems] = useState<ComboMap>({});
  const [kitchenCategoryIds, setKitchenCategoryIds] = useState<string[]>([]);
  const [branchName, setBranchName] = useState<string | null>(null);
  // Station routing, pulled with the catalogue. Empty stations means unconfigured,
  // and every path below falls back to the old kitchen/dispatcher behaviour.
  const [routing, setRouting] = useState<StationRouting>(ROUTING_UNCONFIGURED);
  // Printed on the dispatcher ticket so a packing station serving three tills
  // can tell which one sent the order.
  const [deviceName, setDeviceName] = useState<string | null>(null);
  // Cashier on the receipt — attribution matters when three tills share a branch.
  const [cashierName, setCashierName] = useState<string | null>(null);
  // A59: the signed-in staff may force-close a drawer if they hold the dedicated
  // shifts.force_close key or the broad settings.manage — same rule the server
  // route now enforces (requireAnyPermission). Owner carries '*'.
  const [canForceClose, setCanForceClose] = useState(false);
  // One bill number held in reserve so ensureOrderNumber() can stay synchronous —
  // it is called from non-async paths like autoHold, which several table
  // handlers invoke and then immediately depend on having cleared the cart.
  //
  // Drawn LAZILY: when the cart goes from empty to non-empty, not when this
  // screen mounts. Reserving at mount meant every visit to the POS screen
  // consumed a number whether or not anything was sold, so the bill sequence
  // acquired gaps just from navigating — and the Manager button added today
  // makes that round trip far easier to make. A bill sequence with unexplained
  // holes is an awkward thing to hand a tax inspector.
  //
  // A number can still be burned by closing the app mid-order. That is a real
  // sale that was abandoned, which is the kind of gap a sequence is allowed to
  // have.
  const [reservedBill, setReservedBill] = useState<string | null>(null);
  // How many times this order was sent to the kitchen. Printed on the receipt
  // the way the incumbent does it, so a manager reconciling a bill against the
  // kitchen's tickets can see whether it was fired once or amended twice.
  const [kotCount, setKotCount] = useState(0);
  const [receiptHeader, setReceiptHeader] = useState('');
  const [receiptFooter, setReceiptFooter] = useState('');
  const [cart, setCart] = useState<CartItem[]>([]);
  const [activeCategory, setActiveCategory] = useState('all');
  const [search, setSearch] = useState('');
  const [variantProduct, setVariantProduct] = useState<any | null>(null);

  // Business mode — from device config (written at install). Defaults to the
  // retail grid until the config loads; restaurant/café unlock tabs + KOT.
  const [flags, setFlags] = useState<ModeFlags>(modeFlags('retail'));
  const [orderType, setOrderType] = useState<'dine_in' | 'takeaway' | 'retail' | 'delivery'>('retail');
  // Rider name, only meaningful on a delivery. Cleared whenever the type changes
  // so a name can never leak onto a counter sale.
  const [deliveryPerson, setDeliveryPerson] = useState('');
  const [tableNumber, setTableNumber] = useState('');
  // Diners on this bill, for Average Per Cover. Dine-in only: a takeaway bag is
  // one transaction, not one diner, and a forced headcount there would fill APC
  // with numbers that mean nothing.
  const [covers, setCovers] = useState('');
  // Pre-assigned at first kitchen send / hold so the KOT and the final receipt
  // carry the same number; null until the ticket needs to exist.
  const [orderNumber, setOrderNumber] = useState<string | null>(null);
  const [heldOrders, setHeldOrders] = useState<HeldOrder[]>([]);
  const [showHeld, setShowHeld] = useState(false);
  const [kitchenMsg, setKitchenMsg] = useState('');
  // A shift somebody forgot to close. Checked on mount and hourly: a till left
  // running overnight would otherwise never re-check, and the whole point is
  // catching it before the next day's sales land on yesterday's reconciliation.
  // Trading-day gate. Polled because the block can begin without the cashier
  // doing anything: at midnight, an unclosed day becomes yesterday's.
  const [dayGate, setDayGate] = useState<{ canTrade: boolean; reason?: string;
    needsManager?: boolean; needsShift?: boolean } | null>(null);
  const [staleShift, setStaleShift] = useState<null | {
    id: string; opened_at: string; hoursOpen: number; cashier_name: string; expectedCash: number; orders: number;
  }>(null);

  // Table map — synced reference data. Restaurants with tables configured
  // open on the map (like the web cashier); without tables, the product
  // grid + manual table number remains the flow.
  const [tables, setTables] = useState<DiningTable[]>([]);
  const [pumps, setPumps] = useState<Pump[]>([]);
  const [view, setView] = useState<'tables' | 'pumps' | 'products'>('products');

  // Printing
  const { settings: printerSettings } = usePrinterSettings();
  const [showPrinters, setShowPrinters] = useState(false);

  // Payment state
  const [showPayment, setShowPayment] = useState(false);
  const [placing, setPlacing] = useState(false);
  // Synchronous double-charge guard. setPlacing(true) only disables the Pay
  // button on the NEXT render, leaving a one-frame window where a fast double-tap
  // fires handleCharge twice — two order numbers, two orders. A ref flips now, in
  // this tick, so the second tap returns immediately.
  const placingRef = useRef(false);
  const [payError, setPayError] = useState('');
  // Surfaced on the receipt screen when a ticket did not reach paper.
  const [printMsg, setPrintMsg] = useState('');
  const [reprintNote, setReprintNote] = useState('');
  // Custom tenders (A96), cached locally so they work offline. Refreshed on mount.
  const [customMethods, setCustomMethods] = useState<{ code: string; name: string }[]>([]);

  // Receipt state
  const [completedOrder, setCompletedOrder] = useState<any | null>(null);
  const receiptRef = useRef<HTMLDivElement>(null);

  // Sync status
  const [syncStatus, setSyncStatus] = useState<{
    online: boolean; pendingCount: number; failedCount: number;
    failedReason?: string; failedSince?: string;
  }>({ online: true, pendingCount: 0, failedCount: 0 });
  // Shown after a retry, so the cashier learns whether it worked instead of
  // watching the same number sit there.
  const [retryMsg, setRetryMsg] = useState('');

  // Shift state
  const [showShift, setShowShift] = useState(false);
  const [shift, setShift] = useState<ZReport | null>(null);

  // Order history + void
  const [showHistory, setShowHistory] = useState(false);
  const [recentOrders, setRecentOrders] = useState<any[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [voidTarget, setVoidTarget] = useState<any | null>(null);

  // Server enforces orders.void permission — show UI for all, server returns
  // 403 with a clear message if the role lacks the permission.
  const canVoid = true;

  const currency = business.currency ?? 'KES';

  useEffect(() => {
    posApi.pos.init().then(({ products, categories, branchId, branchName: bn, vatRate, ctlRate, maxDiscountPct: mdp, comboItems: ci, kitchenCategories, stationRouting, receiptHeader: rh, receiptFooter: rf }: any) => {
      setProducts(products);
      setCategories(categories);
      setBranchId(branchId);
      if (typeof vatRate === 'number') setVatRateFromServer(vatRate);
      if (typeof ctlRate === 'number') setCtlRateFromServer(ctlRate);
      if (typeof mdp === 'number') setMaxDiscountPct(mdp);
      if (ci) setComboItems(ci as ComboMap);
      if (Array.isArray(kitchenCategories)) setKitchenCategoryIds(kitchenCategories);
      setBranchName((bn as string) ?? null);
      if (stationRouting && Array.isArray(stationRouting.stations)) setRouting(stationRouting);
      if (typeof rh === 'string') setReceiptHeader(rh);
      if (typeof rf === 'string') setReceiptFooter(rf);
    });

    // Business mode from the device config written at install time.
    posApi.auth.getStaffSession().then(ss => {
      setCashierName(ss?.staff?.name ?? null);
      const perms = ((ss?.staff as any)?.permissions ?? {}) as Record<string, boolean>;
      const has = (k: string) => perms['*'] === true || perms[k] === true;
      setCanForceClose(has('shifts.force_close') || has('settings.manage'));
    }).catch(() => {});
    posApi.pos.paymentMethods().then(setCustomMethods).catch(() => {});
    // NOT reserving a bill number here. See the reservedBill declaration.

    posApi.config.get().then(async cfg => {
      setDeviceName(cfg?.device_name ?? null);
      const f = modeFlags(cfg?.business_type);
      setFlags(f);
      setOrderType(f.defaultOrderType);
      if (f.isRestaurant) {
        setView('tables');                        // restaurants open on the map, not the grid
        let tbls = await posApi.pos.getTables().catch(() => [] as DiningTable[]);
        // First-login rescue: if the map is empty but we're online, pull once so
        // tables appear without the cashier having to press Sync.
        if (tbls.length === 0) {
          const st = await posApi.sync.status().catch(() => ({ online: false } as any));
          if (st.online) {
            await posApi.sync.trigger().catch(() => {});
            tbls = await posApi.pos.getTables().catch(() => [] as DiningTable[]);
          }
        }
        setTables(tbls);
      }

      if (f.isPetrol) {
        setView('pumps');                         // petrol opens on the pump grid
        let pmps = await posApi.pos.getPumps().catch(() => [] as Pump[]);
        // First-login rescue: pull once if empty and online, same as tables.
        if (pmps.length === 0) {
          const st = await posApi.sync.status().catch(() => ({ online: false } as any));
          if (st.online) {
            await posApi.sync.trigger().catch(() => {});
            pmps = await posApi.pos.getPumps().catch(() => [] as Pump[]);
          }
        }
        setPumps(pmps);
      }
    }).catch(() => { /* keep retail defaults */ });

    // Legacy tabs first: held orders moved from localStorage to SQLite (D2),
    // and a till upgraded mid-service must not lose its open tables. Idempotent,
    // so this is a no-op on every launch after the first.
    void importLegacyHeldOrders().then(() => listHeldOrders()).then(setHeldOrders);

    // Load current shift (if any) for the top-bar pill.
    posApi.shift.current().then(setShift).catch(() => setShift(null));

    // Poll sync status every 30s
    const poll = () => posApi.sync.status().then(setSyncStatus);
    poll();
    const interval = setInterval(poll, 30_000);

    // Real connectivity signal — the renderer is the only place Electron
    // reliably reports it. Coming back online triggers an immediate flush of
    // any queued offline orders (main runs syncAll and returns fresh status).
    const onOnline  = () => posApi.sync.notifyNetworkChange(true).then(setSyncStatus);
    const onOffline = () => posApi.sync.notifyNetworkChange(false).then(setSyncStatus);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    return () => {
      clearInterval(interval);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  // ── Barcode / hardware scanner listener ────────────────────────────────────
  // Keyboard-wedge scanners fire characters at ~1ms intervals then send Enter.
  // Human typing is far slower — we reset the buffer after 80ms of silence.
  // Matches on product.barcode; falls back to PLU code search on the name.
  // Only active when the product grid is visible (not tables or pumps view)
  // and no modal is open that might consume keystrokes.
  useEffect(() => {
    if (flags.isRestaurant || flags.isPetrol) return; // these verticals use tap UI
    let buffer = '';
    let timer: ReturnType<typeof setTimeout>;

    const onKey = (e: KeyboardEvent) => {
      // Ignore if focus is inside an input/textarea (user is typing in search etc.)
      const tag = (document.activeElement as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (e.key === 'Enter' && buffer.length > 2) {
        const scanned = buffer.trim();
        buffer = '';
        clearTimeout(timer);
        // Match by barcode field first, then by PLU prefix in name
        const found = products.find(p =>
          (p as any).barcode === scanned ||
          (p as any).plu === scanned
        );
        if (found && found.status === 'active') {
          addSimple(found);
          // Clear the search box so the scanned item is visible in the grid
          setSearch('');
        } else {
          // Populate search so cashier can see "no match" and act
          setSearch(scanned);
        }
        return;
      }
      if (e.key.length === 1) {
        buffer += e.key;
        clearTimeout(timer);
        timer = setTimeout(() => { buffer = ''; }, 80);
      }
    };

    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); clearTimeout(timer); };
  }, [products, flags.isRestaurant, flags.isPetrol]);

  const addSimple = (product: any) => {
    setCart(prev => {
      const existing = prev.find(i => i.product.id === product.id && i.selectedVariants.length === 0);
      if (existing) {
        return prev.map(i => i === existing
          ? { ...i, quantity: i.quantity + 1, lineTotal: i.unitPrice * (i.quantity + 1), kotSent: false }
          : i
        );
      }
      return [...prev, { product, quantity: 1, selectedVariants: [], selectedModifiers: [], unitPrice: effectivePrice(product), lineTotal: effectivePrice(product), kotSent: false }];
    });
  };

  const addConfigured = (product: any, selectedVariants: any[], selectedModifiers: any[], unitPrice: number, lineTotal: number) => {
    setCart(prev => [...prev, { product, quantity: 1, selectedVariants, selectedModifiers, unitPrice, lineTotal, kotSent: false }]);
    setVariantProduct(null);
  };

  // Petrol: add a fuel line from a pump. quantity = litres at full precision so
  // the server (which recomputes price/litre × litres for the catalogue fuel
  // product) reconciles to exactly the amount entered. The fuel product is the
  // real catalogue product the pump points at, so product_id is valid.
  const addFuelLine = (pump: Pump, litres: number, amount: number) => {
    if (!pump.fuel_product_id) return;
    const product = {
      id: pump.fuel_product_id,
      name: pump.fuel_product_name ?? 'Fuel',
      base_price: pump.price_per_litre ?? 0,
      categories: null,
    };
    setCart(prev => [...prev, {
      product,
      quantity: litres,
      selectedVariants: [],
      selectedModifiers: [],
      unitPrice: pump.price_per_litre ?? 0,
      lineTotal: amount,
      isFuel: true,
      pumpId: pump.id,   // survives to the order header — fuel reports key on it
    }]);
  };

  const handleTap = (product: any) => {
    if (product.has_variants || product.has_modifiers) {
      setVariantProduct(product);
    } else {
      addSimple(product);
    }
  };

  const updateQty = (index: number, delta: number) => {
    setCart(prev => prev
      .map((item, i) => {
        if (i !== index) return item;
        if (item.isFuel) return item;   // fuel qty is litres — re-enter via pump, not stepper
        const newQty = item.quantity + delta;
        const modTotal = item.selectedModifiers.reduce((s: number, m: any) => s + m.price, 0);
        // Qty changed after a kitchen send → clear the flag so the delta
        // appears on the next KOT.
        return { ...item, quantity: newQty, lineTotal: (item.unitPrice + modTotal) * newQty, kotSent: false };
      })
      .filter(i => i.quantity > 0)
    );
  };

  const removeItem = (index: number) => setCart(prev => prev.filter((_, i) => i !== index));
  const clearCart = () => { setCart([]); setOrderNumber(null); setTableNumber(''); setCovers(''); setKitchenMsg(''); setKotCount(0); setDeliveryPerson(''); };

  // ── Restaurant: kitchen / tabs ─────────────────────────

  // The KOT and the receipt must show the same number, so it's assigned the
  // first time either the kitchen or a hold needs it and reused at charge.
  // Draw the reserve as soon as there is something to sell, and only then. By
  // the time any consumer fires, the cashier has added an item and reached for
  // another button — the reserve is a local SQLite round trip, so it has landed.
  useEffect(() => {
    if (cart.length > 0 && !reservedBill && !orderNumber) {
      posApi.orders.nextBillNumber().then(setReservedBill).catch(e => {
        // Best-effort — charge falls back to reserving at pay time — but a
        // silent swallow hid that the reservation never landed. Surface it; the
        // double-charge guard now lives on placingRef, not on this succeeding.
        console.warn('[pos] bill-number reservation failed:', e?.message ?? e);
      });
    }
  }, [cart.length, reservedBill, orderNumber]);

  /**
   * Async form, for callers that can await one. Guarantees a terminal-prefixed
   * number even if the reserve has not landed — the sync fallback returns the old
   * unprefixed ORD- form, which is precisely the A7 gap fixed earlier today, and
   * the charge path must never reintroduce it.
   */
  const ensureOrderNumberAsync = async (): Promise<string> => {
    if (orderNumber) return orderNumber;
    if (reservedBill) return ensureOrderNumber();
    try {
      const n = await posApi.orders.nextBillNumber();
      if (n) { setOrderNumber(n); return n; }
    } catch { /* fall through to the sync path */ }
    return ensureOrderNumber();
  };

  useEffect(() => {
    const check = () => posApi.shift.stale().then(setStaleShift).catch(() => {});
    check();
    const t = setInterval(check, 60 * 60 * 1000);
    return () => clearInterval(t);
  }, [shift]);

  // Checked every minute, not hourly: an unclosed day starts blocking the moment
  // the date rolls over, and a cashier who has just been locked out needs to know
  // now rather than when they next try to take payment.
  useEffect(() => {
    const check = () => posApi.day.gate().then(setDayGate).catch(() => {});
    check();
    const t = setInterval(check, 60 * 1000);
    return () => clearInterval(t);
  }, [shift, showShift]);

  const blocked = dayGate ? !dayGate.canTrade : false;
  // Two obstructions with different remedies. Conflating them was the first
  // release's mistake: a cashier with no drawer open saw nothing, rang a basket,
  // and met the refusal at payment.
  const needsShift = !!dayGate?.needsShift;
  const needsManager = !!dayGate?.needsManager;

  const ensureOrderNumber = (): string => {
    if (orderNumber) return orderNumber;
    // Terminal-prefixed number from the reserve; generateOrderNumber() is only
    // a fallback for the window before the first reserve lands.
    const n = reservedBill ?? generateOrderNumber();
    setOrderNumber(n);
    // Consumed. Deliberately NOT replaced here — the next order draws its own
    // when its first item is added. Pre-fetching a replacement is what made an
    // abandoned cart, or a visit to the manager screen, cost a number.
    setReservedBill(null);
    return n;
  };

  const unsentCount = cart.filter(i => !i.kotSent).length;

  const handleSendToKitchen = async () => {
    const unsent = cart.filter(i => !i.kotSent);
    if (unsent.length === 0) return;
    const num = await ensureOrderNumberAsync();
    setKitchenMsg('');

    // ── Only ONE printing system may run ────────────────────────────────────
    // When thermal printing is switched on for this terminal, main queues the
    // kitchen and dispatch tickets through the ESC/POS spool as part of
    // order:create. If this HTML path also ran, the kitchen would get the same
    // ticket twice and cook it twice — a worse failure than either system on
    // its own, and one that only shows up during a real service.
    //
    // The old path is NOT deleted. It is the fallback, and it stays until a
    // real service has gone through the thermal one on this hardware. Untick
    // the box on the Printers screen and this runs again exactly as before.
    try {
      // 0.5.27 — the HTML sale path is gone, so there is no longer a fallback
      // to guard against. This used to test canPrint('kitchen') and fall through
      // to HTML when nothing was bound (register D8: kitchen bound but dispatch
      // not meant a dispatch slip printed on NEITHER system, silently).
      //
      // With one path, an unbound station has to REPORT rather than be routed
      // around — printProduction returns the stations it skipped and those are
      // surfaced below, which is the behaviour D8 was missing.
      {
        // Queue the kitchen and dispatch tickets NOW.
        //
        // This used to do nothing but mark the lines sent, because main queued
        // every ticket at order:create — which happens at PAYMENT. The kitchen
        // therefore learned about an order only after the customer had settled
        // the bill, so nothing was cooking while they paid. The whole point of
        // a kitchen ticket is that it goes first.
        //
        // Only the UNSENT lines are sent, so a second course added later does
        // not reprint the first.
        const result = await window.swiftpos.escpos.printProduction({
          order_number: num,
          order_type:   flags.isRestaurant ? orderType : 'retail',
          table_number: orderType === 'dine_in' ? tableNumber : undefined,
          items: unsent.map(item => ({
            product: {
              id: item.product.id,
              name: item.product.name,
              category_id: item.product.category_id ?? item.product.categories?.id ?? null,
              categories: item.product.categories ?? null,
              description: item.product.description ?? null,
            },
            unitPrice: item.unitPrice,
            quantity: item.quantity,
            lineTotal: item.lineTotal,
            selectedVariants: item.selectedVariants,
            selectedModifiers: item.selectedModifiers,
            comboComponents: comboItems[item.product.id] ?? undefined,
          })),
        });

        setCart(prev => prev.map(i => ({ ...i, kotSent: true })));
        setKotCount(n => n + 1);

        // D8, closed. A station with no printer bound is NAMED, not skipped in
        // silence. "Sent to kitchen" while a dispatch slip went nowhere is how a
        // bag leaves with items missing.
        const skipped = Array.isArray(result?.skipped) ? result.skipped : [];
        setKitchenMsg(skipped.length
          ? `Sent ${unsent.length} item${unsent.length === 1 ? '' : 's'}, but nothing printed for: ${skipped.join(', ')}`
          : `Sent ${unsent.length} item${unsent.length === 1 ? '' : 's'} to kitchen`);
        return;
      }
    } catch (err: any) {
      // There is no fallback to fall back TO. Report it rather than swallow it —
      // the cashier needs to know the kitchen did not hear about this order.
      setKitchenMsg(`Kitchen print failed: ${err?.message ?? 'unknown error'}`);
      return;
    }

  };

  const handleHold = async () => {
    if (cart.length === 0) return;
    await autoHold();
    if (flags.isRestaurant) setView('tables');
  };

  // Parks the current cart as a tab (label from table/takeaway context) and
  // resets the order surface. Shared by Hold, back-to-tables, and table switch.
  const autoHold = async () => {
    if (cart.length === 0) return;
    const num = ensureOrderNumber();
    const label = orderType === 'dine_in'
      ? `Table ${tableNumber || '?'}`
      : orderType === 'delivery'
        ? `Delivery ${deliveryPerson.trim() || num.slice(-4)}`
        : `Takeaway ${num.slice(-4)}`;
    await holdOrder({ orderNumber: num, label, orderType, tableNumber, cart, deliveryPerson: deliveryPerson.trim() || undefined });
    setHeldOrders(await listHeldOrders());
    clearCart();
    setOrderType(flags.defaultOrderType);
  };

  // ── Table map ──────────────────────────────────────────

  // Free table → fresh dine-in order bound to it. Occupied → recall its tab.
  // Any in-progress cart is auto-held first, so switching tables mid-order
  // behaves like parking one tab and opening another — nothing is lost.
  const handleTableTap = async (table: DiningTable, tab: HeldOrder | null) => {
    await autoHold();
    if (tab) {
      const held = await recallHeldOrder(tab.id);
      if (held) {
        setCart(held.cart);
        setOrderType(held.orderType);
        setDeliveryPerson(held.deliveryPerson ?? '');
        setTableNumber(held.tableNumber);
        setOrderNumber(held.orderNumber);
        setHeldOrders(await listHeldOrders());
      }
    } else {
      setOrderType('dine_in');
      setTableNumber(table.name);
      setOrderNumber(null);
    }
    setView('products');
  };

  const handleTakeaway = async () => {
    await autoHold();
    setOrderType('takeaway');
    setTableNumber('');
    setOrderNumber(null);
    setView('products');
  };

  // The in-order Dine in / Takeaway toggle (right-hand panel, visible even while
  // the table map is up). Takeaway has no table, so picking it releases any table
  // binding and drops to the product grid to ring the order up — otherwise the
  // cashier is left looking at the table map with nothing happening. Switching to
  // Dine in with no table chosen and an empty cart opens the map to pick one;
  // mid-order it leaves the view alone.
  const chooseOrderType = (val: 'dine_in' | 'takeaway' | 'delivery') => {
    setOrderType(val);
    if (val !== 'delivery') setDeliveryPerson('');
    if (val === 'delivery') {
      setTableNumber('');
      setView('products');
    } else if (val === 'takeaway') {
      setTableNumber('');
      setView('products');
    } else if (flags.isRestaurant && tables.length > 0 && !tableNumber && cart.length === 0) {
      setView('tables');
    }
  };

  // One automatic rescue sync per session if the map opens empty — covers
  // "configured tables on the web after the till booted" without any manual
  // Sync press. (PIN login and the 10-min cycle also pull automatically.)
  const tablesRescueSyncRef = useRef(false);

  const handleBackToTables = async () => {
    await autoHold();    // never lose an in-progress order
    // Cheap local read — picks up tables that a background sync pulled in
    // since the app booted, without requiring a manual Sync press.
    posApi.pos.getTables().then(tbls => {
      setTables(tbls);
      if (tbls.length === 0 && syncStatus.online && !tablesRescueSyncRef.current) {
        tablesRescueSyncRef.current = true;
        posApi.sync.trigger()
          .then(() => posApi.pos.getTables().then(setTables))
          .catch(() => {});
      }
    }).catch(() => {});
    setView('tables');
  };

  const handleRecall = async (id: string) => {
    if (cart.length > 0) return; // guarded in the modal too
    const held = await recallHeldOrder(id);
    if (!held) return;
    setCart(held.cart);
    setOrderType(held.orderType);
    setDeliveryPerson(held.deliveryPerson ?? '');
    setTableNumber(held.tableNumber);
    setOrderNumber(held.orderNumber);
    setHeldOrders(await listHeldOrders());
    setShowHeld(false);
    setView('products');
  };

  const handleDeleteHeld = async (id: string) => {
    await deleteHeldOrder(id);
    setHeldOrders(await listHeldOrders());
  };

  // Was hardcoded to 16, which computed the wrong tax for any business on a
  // different rate — in the payment modal, the on-screen total AND the printed
  // receipt — while the server recomputed correctly on push, so the paper and
  // the database silently disagreed. Falls back to 16 only until the first sync.
  const vatRate = vatRateFromServer ?? 16;
  // Defaults to 0 — a business not registered for the levy must never be charged
  // it, so the safe fallback is 'no levy', unlike VAT where 16 is the norm.
  const ctlRate = ctlRateFromServer;
  const subtotal = cartSubtotal(cart);
  const { vat: vatAmount, ctl: ctlAmount } = extractTaxes(subtotal, vatRate, ctlRate);

  // ── Payment ────────────────────────────────────────────

  const handleCharge = async (payment: PaymentResult) => {
    if (!branchId) return;
    // Return before any await — this is the whole point of the ref (see decl).
    if (placingRef.current) return;
    placingRef.current = true;
    setPlacing(true);
    setPayError('');

    try {
      // Reuse the KOT's number if one was assigned; otherwise take the terminal-
      // prefixed reserve now.
      //
      // This used to fall straight through to generateOrderNumber(), which mints
      // the old unprefixed ORD-<ts>-<rand> form. ensureOrderNumber() is only
      // reached from Send to kitchen and from hold, so an order that was rung and
      // charged directly — every counter sale on the pay-first path this pilot is
      // configured for — got an unprefixed number. That is A7 not applying to the
      // common case, and it removes exactly the cross-till collision protection
      // the terminal prefix exists to provide.
      //
      // Inside the try so a failure here also resets placing in finally, instead
      // of leaving the till wedged with the Pay button disabled forever.
      const num = await ensureOrderNumberAsync();

      await posApi.order.create({
        branch_id: branchId,
        order_number: num,
        // Production tickets already queued by Send to kitchen, so order:create
        // prints the RECEIPT only. Without this the kitchen gets a second copy
        // of everything at payment.
        kot_sent: cart.some(i => i.kotSent),
        order_type: flags.isPetrol ? 'fuel_sale' : flags.isRestaurant ? orderType : 'retail',
        delivery_person: orderType === 'delivery' ? (deliveryPerson.trim() || null) : null,
        subtotal,
        discount_amount: payment.discountAmount,
        // The BILL, excluding tip. The tip rides in tip_amount and shows up in
        // the payment legs, which reconcile to total + tip (migration 66).
        tip_amount: payment.tipAmount,
        vat_amount: payment.vatAmount,
        ctl_amount: payment.ctlAmount,
        total: payment.total,
        covers: orderType === 'dine_in' ? Math.max(1, Number(covers) || 1) : 1,
        // Pump attribution: first fuel line's pump. Dropped here previously —
        // the column existed in both databases and nothing ever wrote it,
        // which is why fuel reports read zero (audit backlog, rode along with
        // this rebuild as planned).
        pump_id: cart.find(i => i.isFuel && i.pumpId)?.pumpId ?? null,
        items: cart.map(item => ({
          product: {
            id: item.product.id,
            name: item.product.name,
            // category_id is the field a desktop product actually carries;
            // `categories` is the nested shape the WEB catalogue returns and is
            // undefined here. Sending only the latter meant every line arrived
            // at the ticket router with no category, so nothing could be routed
            // to the kitchen and the kitchen ticket printed "0 items to cook".
            category_id: item.product.category_id ?? item.product.categories?.id ?? null,
            categories: item.product.categories ?? null,
            // Last-resort composition for a menu that was typed as flat products
            // with a line of prose — see escposBridge.describeFromText.
            description: item.product.description ?? null,
          },
          unitPrice: item.unitPrice,
          quantity: item.quantity,
          lineTotal: item.lineTotal,
          selectedVariants: item.selectedVariants,
          selectedModifiers: item.selectedModifiers,
          // What a combo is actually made of. Without these a combo reaches the
          // kitchen as one opaque line and the cooks cannot see the 3PC Chicken
          // inside it.
          comboComponents: comboItems[item.product.id] ?? undefined,
        })),
        payments: payment.legs,
      });

      setCompletedOrder({ orderNumber: num, payment, tableNumber, orderType, deliveryPerson: deliveryPerson.trim() });
      setShowPayment(false);

      // Refresh sync status
      posApi.sync.status().then(setSyncStatus);
    } catch (err: any) {
      setPayError(err.message ?? 'Failed to process payment');
    } finally {
      setPlacing(false);
      placingRef.current = false;
    }
  };

  const handlePrint = async () => {
    const content = receiptRef.current;
    if (!content) return;
    setPrintMsg('');

    // With thermal on, the receipt was already queued to the till station when
    // the order was created — see main/escposBridge.ts. Printing the HTML copy
    // as well would hand the customer two receipts, and the second one laid out
    // by a different renderer.
    try {
      // canPrint('receipt'), NOT enabled(). The first real install had thermal
      // switched on with only Kitchen and dispatcher configured — no receipt
      // station at all. Gating on the flag alone made this report "Receipt sent
      // to the printer" and print nothing, which is the worst possible failure
      // here: a cashier who believes the receipt printed hands over goods.
      if (await window.swiftpos.escpos.canPrint('receipt')) {
        // A REAL second copy, marked "Duplicate Print" on the paper.
        //
        // This used to return a success message and print nothing, which made
        // the button worse than useless: a cashier pressing it for a customer
        // who wanted their receipt got told it had gone, and it had not.
        const r = await window.swiftpos.escpos.reprintReceipt();
        if (!r.ok) setPrintMsg(r.error ?? 'Could not reprint the receipt.');
        return;
      }
    } catch { /* fall through to the path that has always worked */ }

    // Native silent print, falling back to the OS default printer and finally
    // to an on-screen preview. It CANNOT be allowed to fail quietly: a cashier
    // who believes the receipt printed will hand over goods without one.
    const res = await printReceipt(content.innerHTML, printerSettings, `${business.name} — Receipt`);
    if (!res.ok) setPrintMsg(res.error ?? 'Receipt did not print.');
  };

  const handleNewOrder = () => {
    clearCart();
    setCompletedOrder(null);
    setPayError('');
    setPrintMsg('');
    setOrderType(flags.defaultOrderType);
    if (flags.isRestaurant) setView('tables');
    if (flags.isPetrol) setView('pumps');
  };

  const filtered = products.filter(p => {
    const matchCat    = activeCategory === 'all' || p.category_id === activeCategory;
    const matchSearch = p.name.toLowerCase().includes(search.toLowerCase());
    // Petrol: only show fuel grades on the product grid (shop items are still
    // reachable via PumpsView → "Shop items →" which clears the fuel filter).
    // All other verticals: exclude fuel-flagged products.
    const matchFuel   = flags.isPetrol
      ? (p as any).is_fuel === true
      : !(p as any).is_fuel;
    return p.status === 'active' && matchCat && matchSearch && matchFuel;
  });

  // ── Receipt screen ─────────────────────────────────────
  if (completedOrder) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
        <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-sm overflow-hidden">
          <div className="px-6 pt-6 pb-4 border-b border-gray-800 flex items-center justify-between">
            <div>
              <p className="text-green-400 font-semibold">Payment successful</p>
              <p className="text-gray-300 text-xs mt-0.5">{completedOrder.orderNumber}</p>
            </div>
            <span className="text-2xl">✓</span>
          </div>
          <div className="px-6 py-4 max-h-96 overflow-y-auto">
            <ReceiptView
              ref={receiptRef}
              businessName={business.name}
              branchName={branchName ?? undefined}
              orderNumber={completedOrder.orderNumber}
              cart={cart}
              subtotal={subtotal}
              discountAmount={completedOrder.payment.discountAmount}
              tipAmount={completedOrder.payment.tipAmount}
              total={completedOrder.payment.amountDue}
              vatAmount={completedOrder.payment.vatAmount}
              vatRate={vatRate}
              ctlAmount={completedOrder.payment.ctlAmount}
              ctlRate={ctlRate}
              billNumber={completedOrder.orderNumber}
              kots={kotCount}
              deliveryPerson={completedOrder.deliveryPerson}
              headerText={receiptHeader}
              footerText={receiptFooter}
              tillNumber={deviceName ?? undefined}
              cashierName={cashierName ?? undefined}
              currency={currency}
              payments={completedOrder.payment.legs}
              orderType={flags.isRestaurant ? completedOrder.orderType : undefined}
              tableNumber={completedOrder.orderType === 'dine_in' ? completedOrder.tableNumber : undefined}
              footerMessage={printerSettings.footerMessage}
            />
          </div>
          {/* Only ever set when something FAILED. A successful print says
              nothing — the paper is the confirmation. */}
          {printMsg && (
            <div className="px-6 pb-1">
              <p className="text-amber-400 text-xs leading-snug">⚠ {printMsg}</p>
            </div>
          )}
          <div className="px-6 pb-6 flex gap-3">
            <button onClick={handlePrint} className="flex-1 bg-gray-800 hover:bg-gray-700 text-white rounded-xl py-2.5 text-sm font-medium transition-colors">
              🖨 Print receipt
            </button>
            <button onClick={handleNewOrder} className="flex-1 bg-green-500 hover:bg-green-400 text-gray-950 font-bold rounded-xl py-2.5 text-sm transition-colors">
              New order
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Main POS screen ────────────────────────────────────
  return (
    <div className="h-screen flex flex-col bg-gray-950">

      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-800 bg-gray-900">
        <span className="text-green-400 font-bold text-sm">
          SwiftPOS <span className="text-gray-500 font-normal text-[10px] align-middle">v{posApi.version}</span>
        </span>
        <span className="text-gray-200 text-sm">{business.name}</span>
        <div className="flex items-center gap-3">
          {/* Sync indicator */}
          <button
            onClick={() => posApi.sync.trigger().then(() => {
              posApi.sync.status().then(setSyncStatus);
              if (flags.isRestaurant) {
                posApi.pos.getTables().then(tbls => {
                  // Auto-open the map the first time tables arrive (don't
                  // yank the cashier off a half-built order, though).
                  const firstArrival = tables.length === 0 && tbls.length > 0;
                  setTables(tbls);
                  if (firstArrival && cart.length === 0 && view === 'products') setView('tables');
                }).catch(() => {});
              }
            })}
            className="flex items-center gap-1.5 text-xs text-gray-300 hover:text-white transition-colors"
            title="Sync now"
          >
            <span className={`w-2 h-2 rounded-full ${syncStatus.online ? 'bg-green-400' : 'bg-red-400'}`} />
            {syncStatus.pendingCount > 0 && (
              <span className="text-amber-400">{syncStatus.pendingCount} pending</span>
            )}
            {syncStatus.pendingCount === 0 && syncStatus.failedCount === 0 && syncStatus.online && <span>Synced</span>}
            {!syncStatus.online && <span className="text-red-400">Offline</span>}
          </button>
          {/* Failed orders — re-arm exhausted retries (idempotent on the server) */}
          {syncStatus.failedCount > 0 && (
            <button
              onClick={async () => {
                setRetryMsg('Retrying…');
                try {
                  const r = await posApi.sync.retryFailed();
                  const after = await posApi.sync.status();
                  setSyncStatus(after);
                  // Say what happened. Re-arming rows that fail again for the same
                  // reason leaves the count unchanged, which reads as a dead button
                  // — this is how "9 failed" sat in the header for over a week.
                  setRetryMsg(
                    after.failedCount === 0
                      ? `All ${r.requeued} sent.`
                      : after.failedReason
                        ? `Still failing: ${after.failedReason}`
                        : `${after.failedCount} still failing.`,
                  );
                } catch (err: any) {
                  setRetryMsg(err?.message ?? 'Retry failed');
                }
                setTimeout(() => setRetryMsg(''), 8000);
              }}
              className="text-xs text-red-400 hover:text-red-300 transition-colors font-medium"
              // The reason, on hover, without needing a click that changes nothing.
              title={
                syncStatus.failedReason
                  ? `${syncStatus.failedReason}${syncStatus.failedSince ? ` — since ${new Date(syncStatus.failedSince).toLocaleString('en-KE')}` : ''}\n\nClick to retry.`
                  : 'Retry failed orders'
              }
            >
              ⟳ {syncStatus.failedCount} failed
            </button>
          )}
          {retryMsg && (
            <span className="text-xs text-gray-300 max-w-[22rem] truncate" title={retryMsg}>
              {retryMsg}
            </span>
          )}

          {/* Shift pill — open the cash-up panel */}
          <button
            onClick={() => setShowShift(true)}
            className="flex items-center gap-1.5 text-xs transition-colors hover:opacity-80"
            title="Shift / cash-up"
          >
            <span className={`w-2 h-2 rounded-full ${shift ? 'bg-green-400' : 'bg-gray-600'}`} />
            <span className={shift ? 'text-green-400' : 'text-amber-400'}>
              {shift ? 'Shift open' : 'No shift'}
            </span>
          </button>
          {/* Held orders (tabs) — restaurant/café */}
          {flags.isRestaurant && (
            <button
              onClick={() => setShowHeld(true)}
              className="flex items-center gap-1.5 text-xs text-gray-300 hover:text-white transition-colors"
              title="Held orders"
            >
              📋 {heldOrders.length > 0 && <span className="text-amber-400 font-medium">{heldOrders.length}</span>}
              <span className={heldOrders.length > 0 ? 'text-amber-400' : ''}>held</span>
            </button>
          )}
          {/* Order history + void */}
          {canVoid && (
            <button
              onClick={async () => {
                setShowHistory(true);
                setLoadingHistory(true);
                try {
                  const orders = await posApi.manager.recentOrders();
                  setRecentOrders(orders);
                } catch { setRecentOrders([]); }
                finally { setLoadingHistory(false); }
              }}
              className="text-xs text-gray-300 hover:text-white transition-colors"
              title="Order history / void"
            >
              History
            </button>
          )}
          {/* Printer settings */}
          <button
            onClick={() => setShowPrinters(true)}
            className="text-xs text-gray-300 hover:text-white transition-colors"
            title="Printer settings"
          >
            🖨
          </button>
          {/* Deliberately not styled like its neighbours. This is the only way
              back to the manager screen, and as plain grey text among five other
              plain grey links it was easy to miss entirely. */}
          {onOpenManager && (
            <button
              onClick={onOpenManager}
              className="text-xs text-green-400 hover:text-green-300 border border-green-900 hover:border-green-700 rounded-md px-2 py-1 transition-colors"
              title="Back to manager tools"
            >
              ← Manager
            </button>
          )}
          <button onClick={onLogout} className="text-xs text-gray-300 hover:text-red-400 transition-colors">
            Sign out
          </button>
        </div>
      </div>

      {/* A shift nobody closed.
          A banner rather than a modal, deliberately: this must be impossible to
          miss and equally impossible for it to stop someone serving a customer.

          It stays ADVISORY on purpose, and that is not in tension with the hard
          block above: they answer different questions. This fires when a drawer
          has been open a long time but the trading day is still TODAY — mid-
          service, with a customer waiting, where stopping the till would achieve
          nothing except teaching staff to route around the control. The block
          above fires only once the DATE has rolled over, when continuing would
          post today's takings against yesterday's drawer. */}
      {/* HARD BLOCK. Unlike the stale-shift notice below, this is not advisory and
          cannot be dismissed: a till whose previous trading day was never closed
          must not sell, because those sales would post against yesterday's
          drawer — the precise harm the day close exists to prevent. Only a
          manager can clear it, from Manager → Close Day. */}
      {/* Yesterday was never closed. Manager only — so no button here would help
          the person standing at the till, and pretending otherwise wastes their
          time. Red, because trading really is stopped. */}
      {needsManager && (
        <div className="bg-red-500/15 border-b border-red-500/40 px-4 py-3 flex items-center gap-3">
          <span className="text-red-400 text-base">⛔</span>
          <div className="flex-1">
            <p className="text-sm text-red-200 font-medium">This till cannot sell yet</p>
            <p className="text-xs text-red-300/80 mt-0.5">{dayGate?.reason}</p>
          </div>
          <span className="text-xs text-red-300/70 whitespace-nowrap">
            Manager → Close Day
          </span>
        </div>
      )}

      {staleShift && (
        <div className="bg-amber-500/10 border-b border-amber-500/30 px-4 py-2 flex items-center gap-3">
          <span className="text-amber-400 text-sm">⚠</span>
          <p className="text-xs text-amber-200 flex-1">
            <span className="font-semibold">{staleShift.cashier_name}</span>'s shift has been open{' '}
            <span className="font-semibold">{staleShift.hoursOpen} hours</span> —{' '}
            {staleShift.orders} sales, {currency} {staleShift.expectedCash.toLocaleString('en-KE', { minimumFractionDigits: 2 })} expected in the drawer.
            Today's sales are being counted against it.
          </p>
          <button
            onClick={() => setShowShift(true)}
            className="text-xs px-3 py-1 rounded-md bg-amber-600 hover:bg-amber-500 text-white transition-colors whitespace-nowrap"
          >
            Close it now
          </button>
        </div>
      )}

      {/* Shift / cash-up panel */}
      {showShift && (
        <ShiftPanel
          business={business}
          canForceClose={canForceClose}
          onClose={() => setShowShift(false)}
          onShiftChange={setShift}
        />
      )}

      {/* POS body */}
      <div className="flex flex-1 overflow-hidden">

        {/* Left — Table map (restaurant home) or Products */}
        {flags.isRestaurant && view === 'tables' ? (
          <div className="flex-1 flex flex-col overflow-hidden border-r border-gray-800">
            <TablesView
              tables={tables}
              heldOrders={heldOrders}
              currency={currency}
              onTableTap={handleTableTap}
              onTakeaway={handleTakeaway}
            />
          </div>
        ) : flags.isPetrol && view === 'pumps' ? (
          <div className="flex-1 flex flex-col overflow-hidden border-r border-gray-800">
            <PumpsView
              pumps={pumps}
              currency={currency}
              onAddFuel={addFuelLine}
              onShowProducts={() => setView('products')}
            />
          </div>
        ) : (
        <div className="flex-1 flex flex-col overflow-hidden border-r border-gray-800">
          <div className="px-4 pt-4 pb-3 border-b border-gray-800 flex gap-2">
            {flags.isRestaurant && (
              <button
                onClick={handleBackToTables}
                className="flex-shrink-0 bg-gray-800 border border-gray-700 hover:border-gray-600 text-gray-300 text-sm rounded-lg px-3 transition-colors"
                title="Table map (holds the current order)"
              >
                ← Tables
              </button>
            )}
            {flags.isPetrol && (
              <button
                onClick={() => setView('pumps')}
                className="flex-shrink-0 bg-gray-800 border border-gray-700 hover:border-gray-600 text-gray-300 text-sm rounded-lg px-3 transition-colors"
                title="Back to the pump grid"
              >
                ← Pumps
              </button>
            )}
            <input
              type="text"
              placeholder="Search products…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white placeholder-gray-400 text-sm focus:outline-none focus:border-green-500 transition-colors"
            />
          </div>

          <div className="flex gap-2 px-4 py-3 border-b border-gray-800 overflow-x-auto">
            <button
              onClick={() => setActiveCategory('all')}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap flex-shrink-0 transition-colors ${activeCategory === 'all' ? 'bg-green-500 text-gray-950' : 'bg-gray-800 text-gray-200 hover:text-white'}`}
            >All</button>
            {categories.map((cat: any) => (
              <button
                key={cat.id}
                onClick={() => setActiveCategory(cat.id)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap flex-shrink-0 transition-colors ${activeCategory === cat.id ? 'text-gray-950 font-semibold' : 'bg-gray-800 text-gray-200 hover:text-white'}`}
                style={activeCategory === cat.id ? { backgroundColor: cat.color ?? '#22c55e' } : {}}
              >
                {cat.icon && <span className="mr-1">{cat.icon}</span>}{cat.name}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            {filtered.length === 0 ? (
              <div className="text-center py-20 text-gray-400 text-sm">No products found</div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                {filtered.map((product: any) => {
                  const inCart = cart.some(i => i.product.id === product.id);
                  const cartCount = cart.filter(i => i.product.id === product.id).reduce((s, i) => s + i.quantity, 0);
                  return (
                    <button
                      key={product.id}
                      onClick={() => handleTap(product)}
                      className={`relative bg-gray-900 border rounded-xl p-3 text-left transition-all hover:scale-[1.02] active:scale-[0.98] ${inCart ? 'border-green-500/60 bg-green-500/5' : 'border-gray-800 hover:border-gray-700'}`}
                    >
                      {inCart && (
                        <span className="absolute top-2 right-2 bg-green-500 text-gray-950 text-xs font-bold w-5 h-5 rounded-full flex items-center justify-center">
                          {cartCount}
                        </span>
                      )}
                      {(product.has_variants || product.has_modifiers) && (
                        <span className="absolute top-2 left-2 text-xs bg-gray-800/80 text-gray-400 px-1.5 py-0.5 rounded">⚙</span>
                      )}
                      {product.image_url ? (
                        <img src={product.image_url} alt={product.name} className="w-full h-20 object-cover rounded-lg mb-2" />
                      ) : (
                        <div className="w-full h-20 bg-gray-800 rounded-lg mb-2 flex items-center justify-center text-2xl">
                          {product.categories ? '🍽️' : '📦'}
                        </div>
                      )}
                      <p className="text-white text-sm font-medium leading-tight truncate">{product.name}</p>
                      <p className="text-green-400 text-sm font-semibold mt-1">
                        {product.has_variants ? 'from ' : ''}{currency} {Number(effectivePrice(product)).toLocaleString()}
                      </p>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        )}

        {/* Right — Cart */}
        <div className="w-80 flex-shrink-0 flex flex-col bg-gray-900">
          <div className="px-4 py-4 border-b border-gray-800 flex items-center justify-between">
            <h2 className="text-white font-semibold">
              Current order
              {orderNumber && <span className="text-gray-300 text-xs font-normal ml-2">{orderNumber}</span>}
            </h2>
            {cart.length > 0 && <button onClick={clearCart} className="text-xs text-gray-300 hover:text-red-400 transition-colors">Clear</button>}
          </div>

          {/* Restaurant / café — order type, table, kitchen, hold */}
          {flags.isRestaurant && (
            <div className="px-4 py-3 border-b border-gray-800 space-y-2">
              {/* Order type gets the full width on its own row.
                  It previously shared one flex line with Pax and the table pill —
                  five controls in a narrow panel — which squeezed the buttons
                  until "Dine in" wrapped onto two lines and "Takeaway" and
                  "Delivery" ran together with no gap. The labels are fixed-length
                  and the panel is not, so anything sharing the row breaks them. */}
              <div className="flex rounded-lg overflow-hidden border border-gray-700">
                {([['dine_in', 'Dine in'], ['takeaway', 'Takeaway'], ['delivery', 'Delivery']] as const).map(([val, label]) => (
                  <button
                    key={val}
                    onClick={() => chooseOrderType(val)}
                    className={`flex-1 py-2 text-xs font-medium whitespace-nowrap transition-colors ${orderType === val ? 'bg-green-500/10 text-green-400' : 'bg-gray-800 text-gray-200 hover:text-white'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {/* Everything that depends on the chosen type goes on its own row,
                  so adding another field later cannot break the toggle again. */}
              <div className="flex gap-2">
                {orderType === 'delivery' && (
                  <input
                    type="text"
                    value={deliveryPerson}
                    onChange={e => setDeliveryPerson(e.target.value)}
                    placeholder="Rider name"
                    className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-xs placeholder-gray-400 focus:outline-none focus:border-green-500 transition-colors"
                  />
                )}
                {orderType === 'dine_in' && (
                  <input
                    type="number" min={1} max={99} inputMode="numeric"
                    value={covers}
                    onChange={e => setCovers(e.target.value)}
                    placeholder="Pax"
                    title="Number of diners — used for Average Per Cover"
                    className="w-20 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-xs text-center placeholder-gray-400 focus:outline-none focus:border-green-500 transition-colors"
                  />
                )}
                {orderType === 'dine_in' && (
                  tables.length > 0 ? (
                    <span className="flex-1 flex items-center justify-center bg-green-500/10 border border-green-500/40 rounded-lg text-green-400 text-xs font-semibold truncate px-2 py-1.5" title="Selected from the table map">
                      {tableNumber ? `T: ${tableNumber}` : 'No table'}
                    </span>
                  ) : (
                    <input
                      type="text"
                      value={tableNumber}
                      onChange={e => setTableNumber(e.target.value)}
                      placeholder="Table #"
                      className="w-20 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-xs text-center placeholder-gray-400 focus:outline-none focus:border-green-500 transition-colors"
                    />
                  )
                )}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleSendToKitchen}
                  disabled={unsentCount === 0 || !printerSettings.kitchenEnabled}
                  className="flex-1 bg-amber-500/10 border border-amber-500/40 hover:border-amber-400 disabled:opacity-40 disabled:cursor-not-allowed text-amber-400 text-xs font-medium rounded-lg py-2 transition-colors"
                  title={printerSettings.kitchenEnabled ? 'Print a kitchen ticket for unsent items' : 'Kitchen printing disabled in printer settings'}
                >
                  🍳 Send to kitchen{unsentCount > 0 ? ` (${unsentCount})` : ''}
                </button>
                <button
                  onClick={handleHold}
                  disabled={cart.length === 0}
                  className="flex-1 bg-gray-800 border border-gray-700 hover:border-gray-600 disabled:opacity-40 disabled:cursor-not-allowed text-gray-300 text-xs font-medium rounded-lg py-2 transition-colors"
                  title="Park this order and start a new one"
                >
                  ⏸ Hold order
                </button>
              </div>
              {kitchenMsg && <p className="text-xs text-gray-300">{kitchenMsg}</p>}
            </div>
          )}

          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {cart.length === 0 ? (
              <div className="text-center py-16 text-gray-400 text-sm">Add products to get started</div>
            ) : cart.map((item, index) => (
              <div key={index} className="space-y-1">
                <div className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-white text-sm truncate">
                      {item.product.name}
                      {flags.isRestaurant && item.kotSent && (
                        <span className="ml-1.5 text-[10px] text-amber-500/80" title="Already sent to kitchen">🍳</span>
                      )}
                    </p>
                    <p className="text-gray-300 text-xs">
                      {item.isFuel
                        ? `${currency} ${item.unitPrice.toLocaleString()}/L`
                        : `${currency} ${item.unitPrice.toLocaleString()} each`}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {item.isFuel ? (
                      <span className="text-white text-sm tabular-nums">{item.quantity.toFixed(2)} L</span>
                    ) : (
                      <>
                        <button onClick={() => updateQty(index, -1)} className="w-6 h-6 bg-gray-800 hover:bg-gray-700 text-white rounded-md text-sm flex items-center justify-center transition-colors">−</button>
                        <span className="text-white text-sm w-5 text-center">{item.quantity}</span>
                        <button onClick={() => updateQty(index, 1)} className="w-6 h-6 bg-gray-800 hover:bg-gray-700 text-white rounded-md text-sm flex items-center justify-center transition-colors">+</button>
                      </>
                    )}
                    <button onClick={() => removeItem(index)} className="w-6 h-6 text-gray-400 hover:text-red-400 flex items-center justify-center transition-colors">✕</button>
                  </div>
                </div>
                {(item.selectedVariants.length > 0 || item.selectedModifiers.length > 0) && (
                  <div className="flex flex-wrap gap-1">
                    {item.selectedVariants.map((v: any) => (
                      <span key={v.optionId} className="text-xs bg-gray-800 text-gray-400 px-1.5 py-0.5 rounded">{v.groupName}: {v.optionName}</span>
                    ))}
                    {item.selectedModifiers.map((m: any) => (
                      <span key={m.optionId} className="text-xs bg-gray-800 text-purple-400 px-1.5 py-0.5 rounded">+{m.optionName}</span>
                    ))}
                  </div>
                )}
                <p className="text-right text-sm text-gray-200 font-medium">{currency} {item.lineTotal.toLocaleString()}</p>
              </div>
            ))}
          </div>

          <div className="px-4 py-4 border-t border-gray-800 space-y-2">
            <div className="flex justify-between text-sm text-gray-200">
              <span>{vatRate > 0 ? 'Subtotal (incl. VAT)' : 'Subtotal'}</span><span>{currency} {subtotal.toLocaleString()}</span>
            </div>
            {ctlRate > 0 && (
              <div className="flex justify-between text-sm text-gray-300">
                <span>CTL ({ctlRate}%)</span><span>{currency} {ctlAmount.toFixed(2)}</span>
              </div>
            )}
            {vatRate > 0 && (
              <div className="flex justify-between text-sm text-gray-300">
                <span>VAT ({vatRate}%)</span><span>{currency} {vatAmount.toFixed(2)}</span>
              </div>
            )}
            <div className="flex justify-between text-white font-bold text-lg pt-1 border-t border-gray-800">
              <span>Total</span><span>{currency} {subtotal.toLocaleString()}</span>
            </div>
            <button
              onClick={() => setShowPayment(true)}
              // Stopped here as well as in the main process. assertCanSell is the
              // real enforcement, but letting a cashier ring a full basket and
              // then fail at payment wastes their time and the customer's.
              disabled={cart.length === 0 || blocked}
              className="w-full bg-green-500 hover:bg-green-400 disabled:opacity-40 disabled:cursor-not-allowed text-gray-950 font-bold rounded-xl py-3 transition-colors mt-1"
            >
              Charge {currency} {subtotal.toLocaleString()}
            </button>
          </div>
        </div>
      </div>

      {/* Variant modal */}
      {variantProduct && (
        <VariantModal
          product={variantProduct}
          currency={currency}
          onConfirm={(variants, modifiers, unitPrice, lineTotal) =>
            addConfigured(variantProduct, variants, modifiers, unitPrice, lineTotal)
          }
          onClose={() => setVariantProduct(null)}
        />
      )}

      {/* Payment modal */}
      {showPayment && (
        <PaymentModal
          subtotal={subtotal}
          vatRate={vatRate}
          ctlRate={ctlRate}
          maxDiscountPct={maxDiscountPct ?? undefined}
          currency={currency}
          placing={placing}
          error={payError}
          customMethods={customMethods}
          onConfirm={handleCharge}
          onClose={() => { setShowPayment(false); setPayError(''); }}
        />
      )}

      {/* Printer settings */}
      {showPrinters && (
        <PrinterSettingsModal
          isRestaurant={flags.isRestaurant}
          canEdit={canManagePrinters}
          onClose={() => setShowPrinters(false)}
        />
      )}

      {/* No drawer open, and nothing a manager needs to clear first.
          Blocking rather than a banner: Pay is disabled anyway and there is
          nothing else on this screen worth doing, so a banner would only ask the
          cashier to notice a message and go and find a button.
          Suppressed while needsManager, so we never ask for a counted float that
          cannot be used until yesterday's day is closed. */}
      {needsShift && !needsManager && (
        <OpenDrawerModal
          cashierName={cashierName ?? undefined}
          currency={currency}
          onLogout={onLogout}
          onOpened={() => {
            // Refresh both: the shift pill in the top bar, and the gate that is
            // rendering this modal — otherwise it stays up until the next poll.
            posApi.shift.current().then(setShift).catch(() => setShift(null));
            posApi.day.gate().then(setDayGate).catch(() => {});
          }}
        />
      )}

      {/* Held orders */}
      {showHeld && (
        <HeldOrdersModal
          orders={heldOrders}
          currency={currency}
          cartHasItems={cart.length > 0}
          onRecall={handleRecall}
          onDelete={handleDeleteHeld}
          onClose={() => setShowHeld(false)}
        />
      )}

      {/* ── Order History + Void panel ────────────────────────────── */}
      {showHistory && (
        <div className="fixed inset-0 bg-black/70 flex items-end sm:items-center justify-center z-40 p-4"
          onClick={e => e.target === e.currentTarget && setShowHistory(false)}>
          <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-2xl max-h-[80vh] flex flex-col shadow-2xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800 flex-shrink-0">
              <div>
                <h2 className="text-white font-semibold">Order History</h2>
                <p className="text-gray-300 text-xs mt-0.5">Last 30 orders · tap a completed order to void</p>
                {reprintNote && <p className="text-emerald-400 text-xs mt-1">{reprintNote}</p>}
              </div>
              <button onClick={() => { setReprintNote(''); setShowHistory(false); }}
                className="text-gray-300 hover:text-white transition-colors text-lg">✕</button>
            </div>

            <div className="flex-1 overflow-y-auto">
              {loadingHistory ? (
                <div className="flex items-center justify-center py-12 text-gray-300 text-sm">Loading…</div>
              ) : recentOrders.length === 0 ? (
                <div className="py-12 text-center text-gray-300 text-sm">No orders in local storage yet.</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-gray-900">
                    <tr className="border-b border-gray-800">
                      {['Order #', 'Time', 'Type', 'Payment', 'Total', 'Status', ''].map(h => (
                        <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-300">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800/50">
                    {recentOrders.map(o => {
                      const method   = o.payments?.[0]?.method ?? '—';
                      const ageMin   = Math.floor((Date.now() - new Date(o.created_at).getTime()) / 60000);
                      const canVoidThis = o.status === 'completed' && ageMin <= 30;
                      const fmtMoney = (n: number) =>
                        `${currency} ${Number(n).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                      return (
                        <tr key={o.id} className="hover:bg-gray-800/30 transition-colors">
                          <td className="px-4 py-2.5 font-mono text-xs text-gray-300">{o.order_number}</td>
                          <td className="px-4 py-2.5 text-gray-400 text-xs whitespace-nowrap">
                            {ageMin < 60 ? `${ageMin}m ago` : `${Math.floor(ageMin / 60)}h ago`}
                          </td>
                          <td className="px-4 py-2.5 text-gray-300 capitalize text-xs">
                            {(o.order_type ?? 'retail').replace(/_/g, ' ')}
                          </td>
                          <td className="px-4 py-2.5 text-gray-300 capitalize text-xs">
                            {method.replace(/_/g, ' ')}
                          </td>
                          <td className="px-4 py-2.5 font-semibold text-white tabular-nums">
                            {fmtMoney(Number(o.total))}
                          </td>
                          <td className="px-4 py-2.5">
                            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                              o.status === 'completed' ? 'bg-green-500/15 text-green-400' :
                              o.status === 'voided'    ? 'bg-red-500/15 text-red-400' :
                                                         'bg-gray-700 text-gray-400'
                            }`}>{o.status}</span>
                            {o.sync_status === 'pending' && (
                              <span className="ml-1.5 text-[10px] text-amber-400" title="Not yet synced to server">●</span>
                            )}
                          </td>
                          <td className="px-4 py-2.5">
                            <div className="flex items-center gap-2 justify-end">
                              {o.status === 'completed' && (
                                <button
                                  onClick={async () => {
                                    const r = await window.swiftpos.escpos.reprintReceiptForOrder(o.id);
                                    setReprintNote(r.ok ? `Receipt ${o.order_number} sent to the printer` : (r.error ?? 'Could not reprint'));
                                  }}
                                  className="text-xs text-gray-300 hover:text-white border border-gray-600 hover:border-gray-400 rounded-lg px-2.5 py-1 transition-colors"
                                  title="Print a duplicate of this receipt"
                                >
                                  Reprint
                                </button>
                              )}
                              {canVoidThis && (
                                <button
                                  onClick={() => { setVoidTarget(o); setShowHistory(false); }}
                                  className="text-xs text-red-400 hover:text-red-300 border border-red-500/30 hover:border-red-500/60 rounded-lg px-2.5 py-1 transition-colors"
                                >
                                  Void
                                </button>
                              )}
                              {o.status === 'completed' && ageMin > 30 && (
                                <span className="text-xs text-gray-400">expired</span>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Void confirmation modal ────────────────────────────────── */}
      {voidTarget && (
        <VoidModal
          order={voidTarget}
          currency={currency}
          onSuccess={() => {
            setVoidTarget(null);
            // Refresh local order list so the voided status shows immediately
            posApi.manager.recentOrders().then(setRecentOrders).catch(() => {});
          }}
          onClose={() => setVoidTarget(null)}
        />
      )}
    </div>
  );
}
