import { useEffect, useState, useRef } from 'react';
import { posApi } from '../lib/posApi';
import { cartSubtotal, extractVat, computeUnitPrice, computeLineTotal, generateOrderNumber, effectivePrice } from '../lib/cart';
import type { CartItem } from '../lib/cart';
import { modeFlags } from '../lib/posMode';
import type { ModeFlags } from '../lib/posMode';
import { listHeldOrders, holdOrder, recallHeldOrder, deleteHeldOrder } from '../lib/heldOrders';
import type { HeldOrder } from '../lib/heldOrders';
import TablesView from '../components/TablesView';
import PumpsView from '../components/PumpsView';
import type { DiningTable, Pump } from '../lib/posApi';
import { printKOT } from '../lib/printKOT';
import { printReceipt } from '../lib/printReceipt';
import { usePrinterSettings } from '../hooks/usePrinterSettings';
import VariantModal from '../components/VariantModal';
import ReceiptView from '../components/ReceiptView';
import PaymentModal from '../components/PaymentModal';
import type { PaymentResult } from '../components/PaymentModal';
import PrinterSettingsModal from '../components/PrinterSettingsModal';
import HeldOrdersModal from '../components/HeldOrdersModal';
import VoidModal from '../components/VoidModal';
import ShiftPanel from './ShiftPanel';
import type { ZReport } from '../lib/posApi';

interface Props {
  business: { id: string; name: string; currency: string };
  onLogout: () => void;
}

export default function POSPage({ business, onLogout }: Props) {
  const [products, setProducts] = useState<any[]>([]);
  const [categories, setCategories] = useState<any[]>([]);
  const [branchId, setBranchId] = useState<string | null>(null);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [activeCategory, setActiveCategory] = useState('all');
  const [search, setSearch] = useState('');
  const [variantProduct, setVariantProduct] = useState<any | null>(null);

  // Business mode — from device config (written at install). Defaults to the
  // retail grid until the config loads; restaurant/café unlock tabs + KOT.
  const [flags, setFlags] = useState<ModeFlags>(modeFlags('retail'));
  const [orderType, setOrderType] = useState<'dine_in' | 'takeaway' | 'retail'>('retail');
  const [tableNumber, setTableNumber] = useState('');
  // Pre-assigned at first kitchen send / hold so the KOT and the final receipt
  // carry the same number; null until the ticket needs to exist.
  const [orderNumber, setOrderNumber] = useState<string | null>(null);
  const [heldOrders, setHeldOrders] = useState<HeldOrder[]>([]);
  const [showHeld, setShowHeld] = useState(false);
  const [kitchenMsg, setKitchenMsg] = useState('');

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
  const [payError, setPayError] = useState('');

  // Receipt state
  const [completedOrder, setCompletedOrder] = useState<any | null>(null);
  const receiptRef = useRef<HTMLDivElement>(null);

  // Sync status
  const [syncStatus, setSyncStatus] = useState<{ online: boolean; pendingCount: number; failedCount: number }>({ online: true, pendingCount: 0, failedCount: 0 });

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
    posApi.pos.init().then(({ products, categories, branchId }) => {
      setProducts(products);
      setCategories(categories);
      setBranchId(branchId);
    });

    // Business mode from the device config written at install time.
    posApi.config.get().then(async cfg => {
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

    setHeldOrders(listHeldOrders());

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
  const clearCart = () => { setCart([]); setOrderNumber(null); setTableNumber(''); setKitchenMsg(''); };

  // ── Restaurant: kitchen / tabs ─────────────────────────

  // The KOT and the receipt must show the same number, so it's assigned the
  // first time either the kitchen or a hold needs it and reused at charge.
  const ensureOrderNumber = (): string => {
    if (orderNumber) return orderNumber;
    const n = generateOrderNumber();
    setOrderNumber(n);
    return n;
  };

  const unsentCount = cart.filter(i => !i.kotSent).length;

  const handleSendToKitchen = async () => {
    const unsent = cart.filter(i => !i.kotSent);
    if (unsent.length === 0) return;
    const num = ensureOrderNumber();
    setKitchenMsg('');
    try {
      await printKOT(unsent, {
        orderNumber: num,
        tableNumber: orderType === 'dine_in' ? tableNumber || undefined : undefined,
        orderType,
      }, printerSettings);
      setCart(prev => prev.map(i => ({ ...i, kotSent: true })));
      setKitchenMsg(`Sent ${unsent.length} item${unsent.length === 1 ? '' : 's'} to kitchen`);
    } catch (err: any) {
      setKitchenMsg(`Kitchen print failed: ${err?.message ?? 'unknown'}`);
    }
  };

  const handleHold = () => {
    if (cart.length === 0) return;
    autoHold();
    if (flags.isRestaurant) setView('tables');
  };

  // Parks the current cart as a tab (label from table/takeaway context) and
  // resets the order surface. Shared by Hold, back-to-tables, and table switch.
  const autoHold = () => {
    if (cart.length === 0) return;
    const num = ensureOrderNumber();
    const label = orderType === 'dine_in'
      ? `Table ${tableNumber || '?'}`
      : `Takeaway ${num.slice(-4)}`;
    holdOrder({ orderNumber: num, label, orderType, tableNumber, cart });
    setHeldOrders(listHeldOrders());
    clearCart();
    setOrderType(flags.defaultOrderType);
  };

  // ── Table map ──────────────────────────────────────────

  // Free table → fresh dine-in order bound to it. Occupied → recall its tab.
  // Any in-progress cart is auto-held first, so switching tables mid-order
  // behaves like parking one tab and opening another — nothing is lost.
  const handleTableTap = (table: DiningTable, tab: HeldOrder | null) => {
    autoHold();
    if (tab) {
      const held = recallHeldOrder(tab.id);
      if (held) {
        setCart(held.cart);
        setOrderType(held.orderType);
        setTableNumber(held.tableNumber);
        setOrderNumber(held.orderNumber);
        setHeldOrders(listHeldOrders());
      }
    } else {
      setOrderType('dine_in');
      setTableNumber(table.name);
      setOrderNumber(null);
    }
    setView('products');
  };

  const handleTakeaway = () => {
    autoHold();
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
  const chooseOrderType = (val: 'dine_in' | 'takeaway') => {
    setOrderType(val);
    if (val === 'takeaway') {
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

  const handleBackToTables = () => {
    autoHold();          // never lose an in-progress order
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

  const handleRecall = (id: string) => {
    if (cart.length > 0) return; // guarded in the modal too
    const held = recallHeldOrder(id);
    if (!held) return;
    setCart(held.cart);
    setOrderType(held.orderType);
    setTableNumber(held.tableNumber);
    setOrderNumber(held.orderNumber);
    setHeldOrders(listHeldOrders());
    setShowHeld(false);
    setView('products');
  };

  const handleDeleteHeld = (id: string) => {
    deleteHeldOrder(id);
    setHeldOrders(listHeldOrders());
  };

  const vatRate = 16;
  const subtotal = cartSubtotal(cart);
  const vatAmount = extractVat(subtotal, vatRate);

  // ── Payment ────────────────────────────────────────────

  const handleCharge = async (payment: PaymentResult) => {
    if (!branchId) return;
    setPlacing(true);
    setPayError('');

    // Reuse the KOT's number if one was assigned; otherwise generate now.
    const num = orderNumber ?? generateOrderNumber();

    try {
      await posApi.order.create({
        branch_id: branchId,
        order_number: num,
        order_type: flags.isPetrol ? 'fuel_sale' : flags.isRestaurant ? orderType : 'retail',
        subtotal,
        discount_amount: payment.discountAmount,
        tip_amount: payment.tipAmount,
        vat_amount: payment.vatAmount,
        total: payment.total,
        items: cart.map(item => ({
          product: { id: item.product.id, name: item.product.name, categories: item.product.categories ?? null },
          unitPrice: item.unitPrice,
          quantity: item.quantity,
          lineTotal: item.lineTotal,
          selectedVariants: item.selectedVariants,
          selectedModifiers: item.selectedModifiers,
        })),
        payments: payment.legs,
      });

      setCompletedOrder({ orderNumber: num, payment, tableNumber, orderType });
      setShowPayment(false);
      setPlacing(false);

      // Refresh sync status
      posApi.sync.status().then(setSyncStatus);
    } catch (err: any) {
      setPayError(err.message ?? 'Failed to process payment');
      setPlacing(false);
    }
  };

  const handlePrint = async () => {
    const content = receiptRef.current;
    if (!content) return;
    // QZ silent print when a receipt printer is configured; print dialog otherwise.
    await printReceipt(content.innerHTML, printerSettings, `${business.name} — Receipt`);
  };

  const handleNewOrder = () => {
    clearCart();
    setCompletedOrder(null);
    setPayError('');
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
              <p className="text-gray-500 text-xs mt-0.5">{completedOrder.orderNumber}</p>
            </div>
            <span className="text-2xl">✓</span>
          </div>
          <div className="px-6 py-4 max-h-96 overflow-y-auto">
            <ReceiptView
              ref={receiptRef}
              businessName={business.name}
              orderNumber={completedOrder.orderNumber}
              cart={cart}
              subtotal={subtotal}
              discountAmount={completedOrder.payment.discountAmount}
              tipAmount={completedOrder.payment.tipAmount}
              total={completedOrder.payment.total}
              vatAmount={completedOrder.payment.vatAmount}
              currency={currency}
              payments={completedOrder.payment.legs}
              orderType={flags.isRestaurant ? completedOrder.orderType : undefined}
              tableNumber={completedOrder.orderType === 'dine_in' ? completedOrder.tableNumber : undefined}
              footerMessage={printerSettings.footerMessage}
            />
          </div>
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
        <span className="text-green-400 font-bold text-sm">SwiftPOS</span>
        <span className="text-gray-400 text-sm">{business.name}</span>
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
            className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-white transition-colors"
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
              onClick={() => posApi.sync.retryFailed().then(() => posApi.sync.status().then(setSyncStatus))}
              className="text-xs text-red-400 hover:text-red-300 transition-colors font-medium"
              title="Retry failed orders"
            >
              ⟳ {syncStatus.failedCount} failed
            </button>
          )}
          {/* Shift pill — open the cash-up panel */}
          <button
            onClick={() => setShowShift(true)}
            className="flex items-center gap-1.5 text-xs transition-colors hover:opacity-80"
            title="Shift / cash-up"
          >
            <span className={`w-2 h-2 rounded-full ${shift ? 'bg-green-400' : 'bg-gray-600'}`} />
            <span className={shift ? 'text-green-400' : 'text-gray-500'}>
              {shift ? 'Shift open' : 'No shift'}
            </span>
          </button>
          {/* Held orders (tabs) — restaurant/café */}
          {flags.isRestaurant && (
            <button
              onClick={() => setShowHeld(true)}
              className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-white transition-colors"
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
              className="text-xs text-gray-500 hover:text-white transition-colors"
              title="Order history / void"
            >
              History
            </button>
          )}
          {/* Printer settings */}
          <button
            onClick={() => setShowPrinters(true)}
            className="text-xs text-gray-500 hover:text-white transition-colors"
            title="Printer settings"
          >
            🖨
          </button>
          <button onClick={onLogout} className="text-xs text-gray-500 hover:text-red-400 transition-colors">
            Sign out
          </button>
        </div>
      </div>

      {/* Shift / cash-up panel */}
      {showShift && (
        <ShiftPanel
          business={business}
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
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white placeholder-gray-600 text-sm focus:outline-none focus:border-green-500 transition-colors"
            />
          </div>

          <div className="flex gap-2 px-4 py-3 border-b border-gray-800 overflow-x-auto">
            <button
              onClick={() => setActiveCategory('all')}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap flex-shrink-0 transition-colors ${activeCategory === 'all' ? 'bg-green-500 text-gray-950' : 'bg-gray-800 text-gray-400 hover:text-white'}`}
            >All</button>
            {categories.map((cat: any) => (
              <button
                key={cat.id}
                onClick={() => setActiveCategory(cat.id)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap flex-shrink-0 transition-colors ${activeCategory === cat.id ? 'text-gray-950 font-semibold' : 'bg-gray-800 text-gray-400 hover:text-white'}`}
                style={activeCategory === cat.id ? { backgroundColor: cat.color ?? '#22c55e' } : {}}
              >
                {cat.icon && <span className="mr-1">{cat.icon}</span>}{cat.name}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            {filtered.length === 0 ? (
              <div className="text-center py-20 text-gray-600 text-sm">No products found</div>
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
              {orderNumber && <span className="text-gray-600 text-xs font-normal ml-2">{orderNumber}</span>}
            </h2>
            {cart.length > 0 && <button onClick={clearCart} className="text-xs text-gray-500 hover:text-red-400 transition-colors">Clear</button>}
          </div>

          {/* Restaurant / café — order type, table, kitchen, hold */}
          {flags.isRestaurant && (
            <div className="px-4 py-3 border-b border-gray-800 space-y-2">
              <div className="flex gap-2">
                <div className="flex flex-1 rounded-lg overflow-hidden border border-gray-700">
                  {([['dine_in', 'Dine in'], ['takeaway', 'Takeaway']] as const).map(([val, label]) => (
                    <button
                      key={val}
                      onClick={() => chooseOrderType(val)}
                      className={`flex-1 py-1.5 text-xs font-medium transition-colors ${orderType === val ? 'bg-green-500/10 text-green-400' : 'bg-gray-800 text-gray-400 hover:text-white'}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {orderType === 'dine_in' && (
                  tables.length > 0 ? (
                    <span className="w-20 flex items-center justify-center bg-green-500/10 border border-green-500/40 rounded-lg text-green-400 text-xs font-semibold truncate px-1" title="Selected from the table map">
                      {tableNumber ? `T: ${tableNumber}` : 'No table'}
                    </span>
                  ) : (
                    <input
                      type="text"
                      value={tableNumber}
                      onChange={e => setTableNumber(e.target.value)}
                      placeholder="Table #"
                      className="w-20 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-xs text-center placeholder-gray-600 focus:outline-none focus:border-green-500 transition-colors"
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
              {kitchenMsg && <p className="text-xs text-gray-500">{kitchenMsg}</p>}
            </div>
          )}

          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {cart.length === 0 ? (
              <div className="text-center py-16 text-gray-600 text-sm">Add products to get started</div>
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
                    <p className="text-gray-400 text-xs">
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
                    <button onClick={() => removeItem(index)} className="w-6 h-6 text-gray-600 hover:text-red-400 flex items-center justify-center transition-colors">✕</button>
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
                <p className="text-right text-xs text-gray-400">{currency} {item.lineTotal.toLocaleString()}</p>
              </div>
            ))}
          </div>

          <div className="px-4 py-4 border-t border-gray-800 space-y-2">
            <div className="flex justify-between text-sm text-gray-400">
              <span>Subtotal (incl. VAT)</span><span>{currency} {subtotal.toLocaleString()}</span>
            </div>
            <div className="flex justify-between text-sm text-gray-500">
              <span>VAT ({vatRate}%)</span><span>{currency} {vatAmount.toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-white font-bold text-lg pt-1 border-t border-gray-800">
              <span>Total</span><span>{currency} {subtotal.toLocaleString()}</span>
            </div>
            <button
              onClick={() => setShowPayment(true)}
              disabled={cart.length === 0}
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
          currency={currency}
          placing={placing}
          error={payError}
          onConfirm={handleCharge}
          onClose={() => { setShowPayment(false); setPayError(''); }}
        />
      )}

      {/* Printer settings */}
      {showPrinters && (
        <PrinterSettingsModal
          isRestaurant={flags.isRestaurant}
          onClose={() => setShowPrinters(false)}
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
                <p className="text-gray-500 text-xs mt-0.5">Last 30 orders · tap a completed order to void</p>
              </div>
              <button onClick={() => setShowHistory(false)}
                className="text-gray-500 hover:text-white transition-colors text-lg">✕</button>
            </div>

            <div className="flex-1 overflow-y-auto">
              {loadingHistory ? (
                <div className="flex items-center justify-center py-12 text-gray-500 text-sm">Loading…</div>
              ) : recentOrders.length === 0 ? (
                <div className="py-12 text-center text-gray-500 text-sm">No orders in local storage yet.</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-gray-900">
                    <tr className="border-b border-gray-800">
                      {['Order #', 'Time', 'Type', 'Payment', 'Total', 'Status', ''].map(h => (
                        <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500">{h}</th>
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
                            {canVoidThis && (
                              <button
                                onClick={() => { setVoidTarget(o); setShowHistory(false); }}
                                className="text-xs text-red-400 hover:text-red-300 border border-red-500/30 hover:border-red-500/60 rounded-lg px-2.5 py-1 transition-colors"
                              >
                                Void
                              </button>
                            )}
                            {o.status === 'completed' && ageMin > 30 && (
                              <span className="text-xs text-gray-600">expired</span>
                            )}
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
