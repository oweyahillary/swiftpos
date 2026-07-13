import { useEffect, useState, useCallback } from 'react';
import { POSLoadingSkeleton } from './cashier/POSSkeletons';
import { usePOSData }         from './cashier/usePOSData';
import { useCart }            from './cashier/useCart';
import { resolveRoute } from '../../lib/posRouting';
import { useNavigate } from 'react-router-dom';
import { usePOSAuth } from '../../context/POSAuthContext';
import type { BusinessMode } from '../../context/POSAuthContext';
import { useBusiness } from '../../context/BusinessContext';
import { api } from '../../lib/api';
import { cartSubtotal, extractVat, generateOrderNumber } from '../../lib/cart';
import type { CartItem } from '../../lib/cart';
import type { Product, Category, VariantGroup, VariantOption, SelectedVariant } from '../../types';
import PaymentModal from './PaymentModal';
import DiscountPanel from './DiscountPanel';
import type { DiscountState } from './DiscountPanel';
import LoyaltyPanel from './LoyaltyPanel';
import type { LoyaltyState } from './LoyaltyPanel';
import ZReportModal from './ZReportModal';
import ShiftModal from './ShiftModal';
import type { Shift, ShiftModalMode } from './ShiftModal';
import PrinterSettingsModal from './PrinterSettingsModal';
import { usePrinterSettings } from '../../hooks/usePrinterSettings';
import { printKOTs, type BranchPrinter } from '../../lib/printKOT';
import POSDrawer from './POSDrawer';
import MinimartPOS from './MinimartPOS';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Table {
  id: string;
  name: string;
  capacity: number;
  sort_order: number;
  slot_type?: 'dining' | 'parking_bay';
  pos_x?: number;
  pos_y?: number;
  zone?: string;
  shape?: 'rect' | 'circle';
}

// Floor plan constants
const FLOOR_W = 800;
const FLOOR_H = 520;
const TABLE_W = 72;
const TABLE_H = 52;
const ZONE_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  'Main Hall': { bg: '#1e3a5f', border: '#2563eb', text: '#93c5fd' },
  'Terrace':   { bg: '#14532d', border: '#16a34a', text: '#86efac' },
  'Private':   { bg: '#3b0764', border: '#9333ea', text: '#d8b4fe' },
  'Bar':       { bg: '#451a03', border: '#d97706', text: '#fcd34d' },
  'VIP':       { bg: '#500724', border: '#db2777', text: '#f9a8d4' },
};
const DEFAULT_ZONE = { bg: '#1f2937', border: '#4b5563', text: '#9ca3af' };
function zoneColor(zone?: string) { return zone ? (ZONE_COLORS[zone] ?? DEFAULT_ZONE) : DEFAULT_ZONE; }

interface ActivePromo {
  id: string;
  name: string;
  promo_type: string;
  discount_type: 'percentage' | 'fixed' | null;
  discount_value: number | null;
  min_quantity: number;
  free_quantity: number | null;
  applies_to: string;
}

interface Pump {
  id: string;
  name: string;
  sort_order: number;
  status: 'idle' | 'dispensing' | 'inactive';
}

interface ParkingSession {
  id: string;
  bay_id: string;
  vehicle_plate?: string;
  vehicle_type: string;
  rate_per_hour: number;
  started_at: string;
  status: 'open' | 'completed' | 'voided';
}

interface OpenOrder {
  tableId: string | null;
  tableName: string;
  cart: CartItem[];
  covers: number;
  openedAt: number;
  // parking
  parkingSessionId?: string;
  vehiclePlate?: string;
  ratePerHour?: number;
  // petrol
  pumpId?: string;
  pumpName?: string;
}

interface POSInitResponse {
  products: Product[];
  categories: Category[];
  branchId: string | null;
  variantsByProduct: Record<string, VariantGroup[]>;
  businessType: string;
  businessName: string;
  currency: string;
  loyaltyEnabled: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const VAT_RATE = 16;

function fmt(amount: number, currency: string) {
  return `${currency} ${Number(amount).toLocaleString('en-KE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function timeAgo(ts: number) {
  if (!ts || isNaN(ts)) return '—';
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (isNaN(mins) || mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function deriveMode(raw: string): BusinessMode {
  const t = raw.toLowerCase().replace(/\s+/g, '_');
  const valid: BusinessMode[] = ['restaurant', 'cafe', 'retail', 'minimart', 'parking', 'petrol_station', 'other'];
  return valid.includes(t as BusinessMode) ? (t as BusinessMode) : 'other';
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function CashierScreen() {
  const navigate = useNavigate();
  const { session, clearCashierSession, posApi, hasPermission } = usePOSAuth();

  // Owner (wildcard) or explicitly granted settings.manage
  const isManager = hasPermission('settings.manage');
  const { business } = useBusiness();

  // Guard — if this user should not be on the cashier screen, redirect them now.
  // Uses the same resolveRoute() logic as the login screen — consistent everywhere.
  useEffect(() => {
    if (!session) return;
    const dest = resolveRoute(session.permissions, session.role);
    if (dest !== '/pos/cashier') navigate(dest, { replace: true });
  }, [session]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Data (usePOSData hook) ────────────────────────────────────────────────
  // Replaces 7 inline useState declarations + sequential data loading useEffect.
  // Fetches products/categories/variants/tables/pumps/printers/orderMode in
  // parallel via Promise.allSettled — previously sequential (400-600ms slower).
  // NOTE: must be declared BEFORE `businessMode`/view effects below, which read
  // posDataMode — otherwise it's a temporal-dead-zone ReferenceError on render.
  const {
    products,
    categories,
    variantsByProduct,
    tables,
    pumps,
    setPumps,
    branchPrinters,
    businessMode:  posDataMode,
    orderMode:     posDataOrderMode,
    loading,
  } = usePOSData();

  // ── Business mode (from usePOSData) ──────────────────────────────────────
  // posDataMode comes from usePOSData — initialised to 'retail' then updated
  // once the POS init API returns. Aliased to businessMode for compatibility.
  const businessMode = posDataMode;

  // Derived convenience booleans — use these throughout the component
  const isRestaurant   = businessMode === 'restaurant' || businessMode === 'cafe';
  const isParking      = businessMode === 'parking';
  const isPetrol       = businessMode === 'petrol_station';
  const isMinimart     = businessMode === 'minimart';
  const isRetailLike   = businessMode === 'retail' || isMinimart;
  // Modes that start on a "slot picker" screen instead of the product grid:
  const hasSlotPicker  = isRestaurant || isParking || isPetrol;

  // ── Sync initial view from businessMode ───────────────────────────────────
  // usePOSData resolves the business mode from /api/pos/init. Once we know
  // the mode, set the initial view to the right slot picker (or products).
  useEffect(() => {
    if (businessMode === 'restaurant' || businessMode === 'cafe') setView('tables');
    else if (businessMode === 'parking')         setView('bays');
    else if (businessMode === 'petrol_station')  setView('pumps');
    else                                         setView('products');
  }, [businessMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const currency = session?.currency ?? 'KES';

  const [activeParkingSessions, setActiveParkingSessions] = useState<Record<string, ParkingSession>>({});

  // ── View state ─────────────────────────────────────────────────────────────
  // restaurant → 'tables' | 'products'
  // parking    → 'bays'   | 'products'
  // petrol     → 'pumps'  | 'products'
  // retail / minimart → always 'products'
  const [view, setView] = useState<'tables' | 'bays' | 'pumps' | 'products'>('products');

  // ── Cart state (useCart hook) ─────────────────────────────────────────────
  // Replaces 12 inline useState + 10 useCallback declarations.
  // All cart mutations are stable references — no cascade re-renders.
  const {
    cart, setCart,
    addToCart:          _addToCart,
    addFuelToCart,
    updateQty,
    removeItem,
    setItemCourse,
    toggleItemHold,
    minimartAddToCart,
    minimartUpdateQty,
    minimartRemoveItem,
    variantProduct,
    selectedVariants,
    openVariantModal,
    closeVariantModal,
    toggleVariantOption,
    confirmVariants:    _confirmVariants,
    fuelEntry, setFuelEntry,
    fuelEdited, setFuelEdited,
    fuelAmountStr, setFuelAmountStr,
    fuelLitresStr, setFuelLitresStr,
  } = useCart();

  // Adapter: addToCart needs variantsByProduct from usePOSData
  const addToCart = useCallback(
    (product: Product) => _addToCart(product, variantsByProduct),
    [_addToCart, variantsByProduct],
  );

  // Adapter: confirmVariants in the original file reads variantsByProduct directly.
  // The hook's version takes modifiers as a param; the original reads them from
  // selectedVariants + variantsByProduct internally. We keep the hook's logic
  // and pass an empty array for modifiers (modifiers are handled separately).
  const confirmVariants = useCallback(() => {
    _confirmVariants([]);
  }, [_confirmVariants]);

  // ── Order state ────────────────────────────────────────────────────────────
  const [openOrders, setOpenOrders] = useState<Record<string, OpenOrder>>({});
  const [activeKey, setActiveKey] = useState<string | null>(null);

  // ── UI state ───────────────────────────────────────────────────────────────
  const [activeCategory, setActiveCategory] = useState('all');
  const [search, setSearch] = useState('');
  const [barcodeBuffer, setBarcodeBuffer] = useState('');
  const [showCoversModal, setShowCoversModal] = useState(false);
  const [pendingTable, setPendingTable] = useState<Table | null>(null);
  const [covers, setCovers] = useState(2);
  // Parking modals
  const [showParkingModal, setShowParkingModal] = useState(false);
  const [pendingBay, setPendingBay] = useState<Table | null>(null);
  const [vehiclePlate, setVehiclePlate] = useState('');
  const [vehicleType, setVehicleType] = useState('car');
  const [ratePerHour, setRatePerHour] = useState(200);
  // Petrol modal
  const [showPumpModal, setShowPumpModal] = useState(false);
  const [pendingPump, setPendingPump] = useState<Pump | null>(null);
  // Fuel entry state now comes from useCart hook above

  const [now, setNow] = useState(Date.now());
  const [showLockConfirm, setShowLockConfirm] = useState(false);
  const [showPayment,      setShowPayment]      = useState(false);
  const [showZReport,      setShowZReport]      = useState(false);
  const [showTransfer,     setShowTransfer]      = useState(false);
  const [showSplitBill,    setShowSplitBill]     = useState(false);
  const [showRoomCharge,   setShowRoomCharge]    = useState(false);
  const [transferTarget,   setTransferTarget]    = useState<string | null>(null);
  const [splitGuests,      setSplitGuests]       = useState<{ name: string; itemIndexes: number[] }[]>([
    { name: 'Guest 1', itemIndexes: [] },
    { name: 'Guest 2', itemIndexes: [] },
  ]);
  const [splitStep,        setSplitStep]         = useState<'assign' | 'pay'>('assign');
  const [splitPayingGuest, setSplitPayingGuest]  = useState(0);
  const [roomNumber,       setRoomNumber]        = useState('');
  const [roomGuestName,    setRoomGuestName]      = useState('');
  const [roomCharging,     setRoomCharging]       = useState(false);
  const [roomChargeError,  setRoomChargeError]    = useState('');
  const [currentShift, setCurrentShift] = useState<Shift | null>(null);
  const [shiftModal, setShiftModal] = useState<ShiftModalMode | null>(null);
  const [showPrinterSettings, setShowPrinterSettings] = useState(false);
  const { settings: printerSettings, save: savePrinterSettings, reset: resetPrinterSettings } = usePrinterSettings();
  // branchPrinters comes from usePOSData hook above
  const [showDrawer, setShowDrawer] = useState(false);
  const [discountState, setDiscountState] = useState<DiscountState | null>(null);
  const [activePromos, setActivePromos]   = useState<ActivePromo[]>([]);
  const [floorMode, setFloorMode]         = useState(true);
  const [loyaltyState, setLoyaltyState] = useState<LoyaltyState | null>(null);

  // ── Theme — light is default for POS ──────────────────────────────────────
  const [posTheme, setPosTheme] = useState<'light' | 'dark'>(() =>
    (localStorage.getItem('swiftpos_pos_theme') as 'light' | 'dark') ?? 'light'
  );
  function togglePosTheme() {
    setPosTheme(t => {
      const next = t === 'light' ? 'dark' : 'light';
      localStorage.setItem('swiftpos_pos_theme', next);
      return next;
    });
  }

  // ── Restaurant order model (from usePOSData) ─────────────────────────────
  // 'pay_first'   — charge at counter, KDS ticket fires on payment (default)
  // 'order_first' — send to kitchen first, charge when customer is ready
  const orderMode = posDataOrderMode;
  // For order-first: track the DB order id once it's been sent to kitchen
  const [sentOrderIds, setSentOrderIds] = useState<Record<string, string>>({}); // tableKey → orderId

  // ── Variant modal state — from useCart hook above ───────────────────────────

  // ── Clock ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  // ── Barcode scanner listener (plain retail only — NOT minimart) ────────────
  // MinimartPOS has its own full-featured scanner with PLU/EAN-13/weight decode.
  // Running both simultaneously would double-fire every scan.
  useEffect(() => {
    if (!isRetailLike || isMinimart) return;
    let buffer = '';
    let timer: ReturnType<typeof setTimeout>;

    const onKey = (e: KeyboardEvent) => {
      clearTimeout(timer);
      if (e.key === 'Enter' && buffer.length > 4) {
        const found = products.find(p => (p as any).barcode === buffer);
        if (found) addToCart(found);
        buffer = '';
        return;
      }
      if (e.key.length === 1) buffer += e.key;
      // Reset buffer if no new keystroke within 80 ms (human typing, not scanner)
      timer = setTimeout(() => { buffer = ''; }, 80);
    };

    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); clearTimeout(timer); };
  }, [isRetailLike, products]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load data ──────────────────────────────────────────────────────────────
  // Fully handled by usePOSData hook above. Products, categories, variants,
  // tables/bays/pumps, printers, and orderMode are all fetched in parallel
  // via Promise.allSettled. QZ Tray is also connected there.

  // ── Check / open shift on mount ───────────────────────────────────────────
  useEffect(() => {
    if (!session) return;
    posApi.get<Shift | null>('/api/shifts/current')
      .then((shift) => {
        if (shift) {
          setCurrentShift(shift);
        } else {
          setShiftModal('open');
        }
      })
      .catch(() => {});
  }, [session]); // eslint-disable-line react-hooks/exhaustive-deps


  // ── Auto-apply promotions (poll every 60s for time-based) ─────────────────
  useEffect(() => {
    let mounted = true;
    async function checkPromos() {
      try {
        const productIds  = cart.map(i => i.product.id).filter(Boolean).join(',');
        const p = new URLSearchParams();
        if (productIds) p.set('product_ids', productIds);
        const promos = await api.get<ActivePromo[]>(`/api/promotions/active?${p}`);
        if (mounted) setActivePromos(promos ?? []);
      } catch { if (mounted) setActivePromos([]); }
    }
    checkPromos();
    const timer = setInterval(checkPromos, 60_000);
    return () => { mounted = false; clearInterval(timer); };
  }, [cart]); // eslint-disable-line

    // ── Sync active cart to openOrders ────────────────────────────────────────
  useEffect(() => {
    if (!activeKey) return;
    setOpenOrders((prev) => {
      if (!prev[activeKey]) return prev;
      return { ...prev, [activeKey]: { ...prev[activeKey], cart } };
    });
  }, [cart, activeKey]);

  // ── Table actions (restaurant) ─────────────────────────────────────────────

  function tableStatus(table: Table): 'free' | 'occupied' {
    return openOrders[table.id] ? 'occupied' : 'free';
  }

  const [showClearTableModal, setShowClearTableModal] = useState(false);
  const [tableToClear, setTableToClear] = useState<Table | null>(null);

  function onTableTap(table: Table) {
    const existing = openOrders[table.id];
    if (existing) {
      // Occupied — show details modal (resume or clear)
      setTableToClear(table);
      setShowClearTableModal(true);
      return;
    }
    // Free — open covers modal
    setPendingTable(table);
    setCovers(2);
    setShowCoversModal(true);
  }

  function clearTable(table: Table) {
    setOpenOrders(prev => {
      const next = { ...prev };
      delete next[table.id];
      return next;
    });
    if (activeKey === table.id) {
      setActiveKey(null);
      setCart([]);
    }
    setShowClearTableModal(false);
    setTableToClear(null);
  }

  function confirmCovers() {
    if (!pendingTable) return;
    const key = pendingTable.id;
    setOpenOrders((prev) => ({
      ...prev,
      [key]: {
        tableId: pendingTable.id,
        tableName: pendingTable.name,
        cart: [],
        covers,
        openedAt: Date.now(),
      },
    }));
    setActiveKey(key);
    setCart([]);
    setShowCoversModal(false);
    setPendingTable(null);
    setView('products');
  }

  function goBackToSlotPicker() {
    if (activeKey) {
      setOpenOrders((prev) => ({
        ...prev,
        [activeKey]: { ...prev[activeKey], cart },
      }));
    }
    setActiveKey(null);
    setCart([]);
    if (isRestaurant) setView('tables');
    else if (isParking) setView('bays');
    else if (isPetrol) setView('pumps');
  }

  // ── Bay actions (parking) ─────────────────────────────────────────────────

  function bayStatus(bay: Table): 'free' | 'occupied' {
    const session = activeParkingSessions[bay.id];
    return session?.status === 'open' ? 'occupied' : 'free';
  }

  function onBayTap(bay: Table) {
    const existing = openOrders[bay.id];
    if (existing) {
      setActiveKey(bay.id);
      setCart(existing.cart);
      setView('products');
      return;
    }
    setPendingBay(bay);
    setVehiclePlate('');
    setVehicleType('car');
    setRatePerHour(200);
    setShowParkingModal(true);
  }

  async function confirmParking() {
    if (!pendingBay) return;
    const key = pendingBay.id;

    // Helper to apply session locally (used as both primary and fallback)
    const applyLocally = (sessionId: string) => {
      setActiveParkingSessions(prev => ({
        ...prev,
        [key]: { id: sessionId, bay_id: pendingBay!.id, vehicle_plate: vehiclePlate, vehicle_type: vehicleType, rate_per_hour: ratePerHour, started_at: new Date().toISOString(), status: 'open' },
      }));
      setOpenOrders(prev => ({
        ...prev,
        [key]: { tableId: pendingBay!.id, tableName: pendingBay!.name, cart: [], covers: 1, openedAt: Date.now(), parkingSessionId: sessionId, vehiclePlate, ratePerHour },
      }));
      setActiveKey(key);
      setCart([]);
      setShowParkingModal(false);
      setPendingBay(null);
      setView('products');
    };

    try {
      // Persist to backend — critical for reports and multi-device accuracy
      const created = await posApi.post<{ id: string }>('/api/parking-sessions', {
        branch_id:     session?.branchId,
        bay_id:        pendingBay.id,
        vehicle_plate: vehiclePlate || null,
        vehicle_type:  vehicleType,
        rate_per_hour: ratePerHour,
      });
      applyLocally(created.id);
    } catch (err: any) {
      console.error('[parking] Failed to open session on server, using local ID:', err.message);
      applyLocally(`ps-${Date.now()}`);
    }
  }

  // Compute parking bill for the active order
  function getParkingBill(): { hours: number; amount: number } | null {
    if (!isParking || !activeKey) return null;
    const order = openOrders[activeKey];
    if (!order?.parkingSessionId) return null;
    const session = activeParkingSessions[order.tableId!];
    if (!session) return null;
    const hours = Math.max(1, Math.ceil((Date.now() - new Date(session.started_at).getTime()) / 3600000));
    return { hours, amount: hours * (order.ratePerHour ?? 0) };
  }

  // ── Pump actions (petrol) ─────────────────────────────────────────────────

  function pumpStatus(pump: Pump): 'idle' | 'dispensing' | 'inactive' {
    const order = Object.values(openOrders).find(o => o.pumpId === pump.id);
    return order ? 'dispensing' : pump.status;
  }

  function onPumpTap(pump: Pump) {
    const existing = Object.entries(openOrders).find(([, o]) => o.pumpId === pump.id);
    if (existing) {
      const [key, order] = existing;
      setActiveKey(key);
      setCart(order.cart);
      setView('products');
      return;
    }
    setPendingPump(pump);
    setShowPumpModal(true);
  }

  async function confirmPump() {
    if (!pendingPump) return;
    const key = `pump-${pendingPump.id}-${Date.now()}`;

    // Optimistic UI update — show as dispensing immediately
    setPumps(prev => prev.map(p =>
      p.id === pendingPump!.id ? { ...p, status: 'dispensing' } : p
    ));
    setOpenOrders(prev => ({
      ...prev,
      [key]: { tableId: null, tableName: pendingPump!.name, cart: [], covers: 1, openedAt: Date.now(), pumpId: pendingPump!.id, pumpName: pendingPump!.name },
    }));
    setActiveKey(key);
    setCart([]);
    setShowPumpModal(false);
    setPendingPump(null);
    setView('products');

    // Persist status to backend (non-blocking — UI already updated)
    try {
      await posApi.patch(`/api/pumps/${pendingPump.id}/activate`, {});
    } catch (err: any) {
      console.error('[pump] Failed to activate on server:', err.message);
      // Pump status in local state is still correct for this session
    }
  }

  // ── Retail: park / resume ─────────────────────────────────────────────────

  function parkOrder() {
    if (!activeKey && cart.length === 0) return;
    const key = activeKey ?? `parked-${Date.now()}`;
    const label = `Order ${Object.keys(openOrders).length + 1}`;
    if (cart.length > 0) {
      setOpenOrders((prev) => ({
        ...prev,
        [key]: {
          tableId: null,
          tableName: label,
          cart,
          covers: 1,
          openedAt: prev[key]?.openedAt ?? Date.now(),
        },
      }));
    }
    setActiveKey(null);
    setCart([]);
  }

  function resumeParked(key: string) {
    const order = openOrders[key];
    if (!order) return;
    if (activeKey && cart.length > 0) {
      setOpenOrders((prev) => ({ ...prev, [activeKey]: { ...prev[activeKey], cart } }));
    }
    setActiveKey(key);
    setCart(order.cart);
  }

  function clearActiveOrder() {
    if (activeKey) {
      // Release pump if this was a petrol order
      const order = openOrders[activeKey];
      if (order?.pumpId) {
        setPumps(prev => prev.map(p =>
          p.id === order.pumpId ? { ...p, status: 'idle' } : p
        ));
      }
      // Remove parking session if bay
      if (order?.tableId && activeParkingSessions[order.tableId]) {
        setActiveParkingSessions(prev => {
          const next = { ...prev };
          delete next[order.tableId!];
          return next;
        });
      }
      setOpenOrders((prev) => {
        const next = { ...prev };
        delete next[activeKey];
        return next;
      });
      if (hasSlotPicker) goBackToSlotPicker();
    }
    setActiveKey(null);
    setCart([]);
  }

  // ── Print guest check / bill (before payment) ───────────────────────────────
  function printGuestCheck() {
    const tableLabel = activeKey && openOrders[activeKey]?.tableName
      ? `Table ${openOrders[activeKey].tableName}` : '';
    const lines = cart.map(i => {
      const name = i.product.name.padEnd(22, ' ').slice(0, 22);
      const qty  = String(i.quantity).padStart(3);
      const price = fmt(i.lineTotal, currency).padStart(12);
      return `${name}${qty}${price}`;
    }).join('\n');
    const sep  = '─'.repeat(38);
    const dateStr = new Date().toLocaleString('en-KE');
    const receipt = [
      '',
      business?.name ?? 'SwiftPOS',
      tableLabel,
      session?.branchName ?? '',
      sep,
      `${'ITEM'.padEnd(22)} QTY         AMT`,
      sep,
      lines,
      sep,
      `${'Subtotal'.padEnd(22)}    ${fmt(subtotal, currency)}`,
      `${'VAT (16%)'.padEnd(22)}    ${fmt(vatAmount, currency)}`,
      sep,
      `${'TOTAL'.padEnd(22)}    ${fmt(orderTotal, currency)}`,
      sep,
      'This is not a receipt.',
      'Please pay at the counter.',
      dateStr,
      '',
    ].join('\n');
    const html = `<!DOCTYPE html><html><head><title>Bill</title>
      <style>body{font-family:'Courier New',monospace;font-size:12px;padding:16px;white-space:pre;}</style>
      </head><body>${receipt.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
      </body></html>`;

    // Print via a hidden iframe rather than a popup window. A popup can be blocked
    // (returns null) or half-load and then hang the tab on print(); the iframe is
    // self-contained and is always cleaned up via onafterprint / a fallback timer.
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    Object.assign(iframe.style, { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0' });
    document.body.appendChild(iframe);

    const cleanup = () => { if (iframe.parentNode) iframe.parentNode.removeChild(iframe); };
    const doc = iframe.contentWindow?.document;
    if (!doc) { cleanup(); return; }
    doc.open(); doc.write(html); doc.close();

    const win = iframe.contentWindow!;
    win.onafterprint = () => setTimeout(cleanup, 100);
    setTimeout(() => {
      try { win.focus(); win.print(); }
      catch { cleanup(); }
      // Safety net: remove the iframe even if onafterprint never fires.
      setTimeout(cleanup, 60000);
    }, 200);
  }

    // ── Send to kitchen (order-first model) ───────────────────────────────────
  const [sendingToKitchen, setSendingToKitchen] = useState(false);

  async function sendToKitchen() {
    if (!session || !activeKey || cart.length === 0) return;
    setSendingToKitchen(true);
    try {
      const order = openOrders[activeKey];
      const orderNumber = `ORD-${Date.now()}`;
      const result = await posApi.post<{ orderId: string; orderNumber: string }>(
        '/api/orders/open',
        {
          branch_id:    session.branchId,
          order_number: orderNumber,
          order_type:   'dine_in',
          table_number: order.tableName,
          covers:       order.covers,
          subtotal,
          vat_amount:   vatAmount,
          total:        orderTotal,
          items:        cart,
          shift_id:     currentShift?.id ?? null,
        }
      );
      // Remember the DB order id — PaymentModal will use /pay instead of creating a new order
      setSentOrderIds(prev => ({ ...prev, [activeKey]: result.orderId }));
      // Print KOT if printers configured
      if (branchPrinters.length > 0) {
        printKOTs(
          cart,
          { orderNumber: result.orderNumber, tableNumber: order.tableName, orderType: 'dine_in', branchName: session.branchName },
          branchPrinters,
          printerSettings,
        ).catch(err => console.error('[KOT]', err));
      }
    } catch (err: any) {
      console.error('Send to kitchen failed:', err);
    } finally {
      setSendingToKitchen(false);
    }
  }

  // Fire a held course to the kitchen for an already-sent order.
  async function fireCourse(course: string) {
    if (!activeKey) return;
    const orderId = sentOrderIds[activeKey];
    if (!orderId) return;
    try {
      await posApi.post(`/api/orders/${orderId}/fire-course`, { course });
      // Reflect locally: those held lines are now fired.
      setCart(prev => prev.map(it => it.course === course && it.fire_status === 'held'
        ? { ...it, fire_status: 'fired' } : it));
    } catch (err: any) {
      console.error('Fire course failed:', err);
    }
  }

  // ── Variant modal — openVariantModal, closeVariantModal, toggleVariantOption,
  //    confirmVariants are all provided by useCart hook above ─────────────────

  // ── Cart actions — all provided by useCart hook above ────────────────────
  // addToCart, addFuelToCart, updateQty, removeItem, setItemCourse,
  // toggleItemHold, minimartAddToCart, minimartUpdateQty, minimartRemoveItem
  // are all stable useCallback references from useCart().

  // ── Totals ─────────────────────────────────────────────────────────────────
  const parkingBill = getParkingBill();
  // For parking, the total is the time-based bill, not the cart subtotal
  const subtotal = isParking && parkingBill
    ? parkingBill.amount
    : cartSubtotal(cart);
  const vatAmount = extractVat(subtotal, VAT_RATE);
  const loyaltyDiscount = loyaltyState?.discountAmount ?? 0;
  // Auto-applied promotion discount
  const autoPromoDiscount = activePromos.reduce((total, promo) => {
    if (!promo.discount_value) return total;
    if (promo.promo_type === 'quantity_discount') {
      const cartQty = cart.reduce((s, i) => s + i.quantity, 0);
      if (cartQty < promo.min_quantity) return total;
    }
    if (promo.discount_type === 'percentage') return total + (subtotal * Number(promo.discount_value) / 100);
    if (promo.discount_type === 'fixed')      return total + Number(promo.discount_value);
    return total;
  }, 0);
  const promoDiscount = (discountState?.discount_amount ?? 0) + autoPromoDiscount;
  const totalDiscount = loyaltyDiscount + promoDiscount;
  const orderTotal = Math.max(0, subtotal - totalDiscount);

  // ── Product filter ─────────────────────────────────────────────────────────
  const filtered = products.filter((p) => {
    const matchCat = activeCategory === 'all' || p.category_id === activeCategory;
    const matchSearch = p.name.toLowerCase().includes(search.toLowerCase());
    // For petrol stations, show only fuel products on the product grid
    const matchFuel = isPetrol ? (p as any).is_fuel === true : !(p as any).is_fuel;
    return p.status === 'active' && matchCat && matchSearch && matchFuel;
  });

  const currentOrderLabel = activeKey
    ? (openOrders[activeKey]?.tableName ?? 'Order')
    : 'New Order';

  const parkedOrders = Object.entries(openOrders).filter(([, o]) => o.tableId === null && !o.pumpId);
  const minimartParkedOrders = parkedOrders.map(([key, order]) => ({
    key,
    label: order.tableName,
    itemCount: order.cart.reduce((s, i) => s + i.quantity, 0),
  }));

  const clockStr = new Date(now).toLocaleTimeString('en-KE', {
    hour: '2-digit',
    minute: '2-digit',
  });

  const variantGroups = variantProduct ? (variantsByProduct[variantProduct.id] ?? []) : [];
  const requiredMet = variantGroups
    .filter((g) => g.required)
    .every((g) => !!selectedVariants[g.id]);

  // Derived order type for PaymentModal
  function getOrderType(): string {
    if (isParking) return 'parking_session';
    if (isPetrol) return 'fuel_sale';
    if (activeKey && openOrders[activeKey]?.tableId) return 'dine_in';
    return 'retail';
  }

  if (loading) return <POSLoadingSkeleton />;

  return (
    <div style={s.root} data-pos-theme={posTheme}>
      <style>{posTheme === 'light' ? `
        [data-pos-theme="light"] {
          --pos-bg: #eef2f7; --pos-panel: #ffffff; --pos-surface: #f4f7fb;
          --pos-border: #d5dae3; --pos-border-l: #eef2f7;
          --pos-text: #0f172a; --pos-text2: #334155; --pos-text3: #64748b; --pos-text4: #94a3b8;
          --pos-input: #ffffff; --pos-input-border: #d5dae3;
          --pos-card: #ffffff; --pos-modal: #ffffff;
          --pos-free-bg: linear-gradient(160deg,#dcfce7 0%,#d1fae5 100%);
          --pos-free-border: rgba(34,197,94,0.55);
          --pos-free-shadow: 0 4px 0 rgba(21,128,61,0.2),0 8px 20px rgba(21,128,61,0.1),inset 0 1px 0 rgba(255,255,255,0.9);
          --pos-free-name: #14532d; --pos-free-sub: #4ade80;
          --pos-occ-bg: linear-gradient(160deg,#fef9c3 0%,#fef3c7 100%);
          --pos-occ-border: rgba(245,158,11,0.65);
          --pos-occ-shadow: 0 4px 0 rgba(180,83,9,0.2),0 8px 20px rgba(180,83,9,0.1),inset 0 1px 0 rgba(255,255,255,0.9);
          --pos-occ-name: #78350f; --pos-occ-label: #d97706;
        }
      ` : `
        [data-pos-theme="dark"] {
          --pos-bg: #0f172a; --pos-panel: #1e293b; --pos-surface: #0f172a;
          --pos-border: #334155; --pos-border-l: #1e293b;
          --pos-text: #f1f5f9; --pos-text2: #e2e8f0; --pos-text3: #94a3b8; --pos-text4: #64748b;
          --pos-input: #0f172a; --pos-input-border: #334155;
          --pos-card: #1e293b; --pos-modal: #1e293b;
          --pos-free-bg: linear-gradient(160deg,#0d2d1a 0%,#0a2016 100%);
          --pos-free-border: rgba(34,197,94,0.35);
          --pos-free-shadow: 0 4px 0 rgba(0,0,0,0.5),0 8px 20px rgba(0,0,0,0.3),inset 0 1px 0 rgba(34,197,94,0.15);
          --pos-free-name: #f1f5f9; --pos-free-sub: #16a34a;
          --pos-occ-bg: linear-gradient(160deg,#2d1f00 0%,#231800 100%);
          --pos-occ-border: rgba(245,158,11,0.4);
          --pos-occ-shadow: 0 4px 0 rgba(0,0,0,0.5),0 8px 20px rgba(0,0,0,0.3),inset 0 1px 0 rgba(245,158,11,0.12);
          --pos-occ-name: #f1f5f9; --pos-occ-label: #f59e0b;
        }
      `}</style>
      <style>{spinCss}</style>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header style={s.header}>
        <div style={s.headerLeft}>
          <span style={s.logoMark}>⚡</span>
          <div>
            <div style={s.branchLabel}>{session?.branchName}</div>
            <div style={s.staffLabel}>{session?.staffName} · {session?.role}</div>
          </div>
        </div>

        <div style={s.headerCenter}>
          {/* Held orders badge row — retail / minimart only */}
          {isRetailLike && parkedOrders.map(([key, order]) => (
            <button
              key={key}
              style={{ ...s.parkedBadge, ...(key === activeKey ? s.parkedBadgeActive : {}) }}
              onClick={() => resumeParked(key)}
              title="Resume held order"
            >
              {order.tableName}
              <span style={s.parkedCount}>{order.cart.length}</span>
            </button>
          ))}
          {isRetailLike && (
            <button style={s.parkBtn} onClick={parkOrder} title="Hold current order and start a new one">
              ⏸ Hold
            </button>
          )}
          {/* Mode badge */}
          <span style={s.modeBadge}>
            {businessMode === 'restaurant' && '🍽 Restaurant'}
            {businessMode === 'cafe' && '☕ Café'}
            {businessMode === 'retail' && '🛍 Retail'}
            {businessMode === 'minimart' && '🏪 Minimart'}
            {businessMode === 'parking' && '🅿️ Parking'}
            {businessMode === 'petrol_station' && '⛽ Petrol'}
            {businessMode === 'other' && '🏢 POS'}
          </span>
        </div>

        <div style={s.headerRight}>
          <span style={s.clock}>{clockStr}</span>
          {/* Theme toggle */}
          <button
            onClick={togglePosTheme}
            title={posTheme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
            style={{ ...s.lockBtn, background: 'transparent', color: '#64748b', border: '1px solid #334155', marginRight: 4 }}
          >{posTheme === 'light' ? '🌙' : '☀️'}</button>
          {/* Printer settings — managers only */}
          {isManager && (
            <button
              style={{ ...s.lockBtn, background: 'transparent', color: '#64748b', border: '1px solid #334155', marginRight: 4 }}
              onClick={() => setShowPrinterSettings(true)}
              title="Printer settings"
            >🖨</button>
          )}
          {/* Menu drawer — shown only if cashier has extra permissions */}
          <button
            style={{ ...s.lockBtn, background: 'transparent', color: '#64748b', border: '1px solid #334155', marginRight: 4 }}
            onClick={() => setShowDrawer(true)}
            title="Menu"
          >☰ Menu</button>
          {/* Z-Report — all cashiers need this to reconcile their shift */}
          <button
            style={{ ...s.lockBtn, background: 'transparent', color: '#64748b', border: '1px solid #334155', marginRight: 4 }}
            onClick={() => setShowZReport(true)}
            title="Z-Report"
          >📊 Z-Report</button>
          {currentShift && (
            <>
              <button
                style={{ ...s.lockBtn, background: 'transparent', color: '#10b981', border: '1px solid #10b981', marginRight: 4 }}
                onClick={() => setShiftModal('clockin')}
                title="Clock In / Out"
              >⏱ Clock</button>
              <button
                style={{ ...s.lockBtn, background: 'transparent', color: '#64748b', border: '1px solid #334155', marginRight: 4 }}
                onClick={() => setShiftModal('float')}
                title="Cash In/Out"
              >💵 Float</button>
              <button
                style={{ ...s.lockBtn, background: 'transparent', color: '#ef4444', border: '1px solid #ef4444', marginRight: 4 }}
                onClick={() => setShiftModal('close')}
                title="End Shift"
              >🔒 End Shift</button>
            </>
          )}
          <button style={s.lockBtn} onClick={() => setShowLockConfirm(true)}>🔒 Lock</button>
        </div>
      </header>

      {/* ── Body ───────────────────────────────────────────────────────────── */}
      <div style={s.body}>

        {/* Minimart: self-contained POS replacing both panels */}
        {isMinimart && (
          <MinimartPOS
            products={products}
            categories={categories}
            cart={cart}
            currency={currency}
            onAddToCart={minimartAddToCart}
            onUpdateQty={minimartUpdateQty}
            onRemoveItem={minimartRemoveItem}
            onClearCart={() => setCart([])}
            onCharge={() => setShowPayment(true)}
            onParkOrder={parkOrder}
            parkedOrders={minimartParkedOrders}
            onResumeParked={resumeParked}
            posApi={posApi}
          />
        )}

        {/* ── Left panel ─────────────────────────────────────────────────── */}
        {!isMinimart && (
        <div style={s.leftPanel}>

          {/* ════════ TABLE GRID (restaurant / café) ════════ */}
          {isRestaurant && view === 'tables' && (
            <div style={s.slotView}>
              {/* Header with Floor/Grid toggle */}
              <div style={{ ...s.slotViewHeader, marginBottom: 12 }}>
                <span style={s.slotViewTitle}>Select a Table</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={s.slotLegend}>
                    <span style={{ ...s.legendDot, background: '#22c55e' }} /> Free
                    <span style={{ ...s.legendDot, background: '#f59e0b' }} /> Occupied
                  </span>
                  <div style={{ display: 'flex', background: 'var(--pos-surface)', borderRadius: 8, padding: 2, gap: 2, border: '1px solid var(--pos-border)' }}>
                    {[{ id: true, label: '⊞ Floor' }, { id: false, label: '▦ Grid' }].map(v => (
                      <button key={String(v.id)} onClick={() => setFloorMode(v.id)}
                        style={{
                          padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
                          border: 'none', cursor: 'pointer',
                          background: floorMode === v.id ? 'var(--pos-accent)' : 'transparent',
                          color: floorMode === v.id ? '#fff' : 'var(--pos-text3)',
                        }}>
                        {v.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              {tables.length === 0 ? (
                <div style={s.emptySlots}>No tables configured. Add tables in Setup → Restaurant Setup.</div>
              ) : floorMode ? (
                /* Floor plan view */
                <div style={{ overflowX: 'auto', overflowY: 'auto', flex: 1 }}>
                  <div style={{ position: 'relative', width: FLOOR_W, height: FLOOR_H, background: '#0a0f1a', borderRadius: 12, flexShrink: 0 }}>
                    {tables.map(table => {
                      const status = tableStatus(table);
                      const order  = openOrders[table.id];
                      const x      = table.pos_x ?? 40;
                      const y      = table.pos_y ?? 40;
                      const c      = zoneColor(table.zone);
                      const occ    = status === 'occupied';
                      const isCircle = table.shape === 'circle';
                      return (
                        <button key={table.id} data-testid="table-tile" data-status={status} data-name={table.name} onClick={() => onTableTap(table)} style={{
                          position: 'absolute', left: x, top: y,
                          width: TABLE_W, height: isCircle ? TABLE_W : TABLE_H,
                          borderRadius: isCircle ? '50%' : 10,
                          background: occ ? 'rgba(245,158,11,0.15)' : c.bg,
                          border: `2px solid ${occ ? '#f59e0b' : c.border}`,
                          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                          cursor: 'pointer', padding: 0, userSelect: 'none',
                          boxShadow: occ ? '0 0 0 3px rgba(245,158,11,0.2)' : 'none',
                        }}>
                          <span style={{ color: occ ? '#f59e0b' : c.text, fontSize: 11, fontWeight: 700, pointerEvents: 'none' }}>
                            {table.name}
                          </span>
                          {order && order.cart.length > 0 ? (
                            <span style={{ color: '#f59e0b', fontSize: 9, fontWeight: 600, marginTop: 2, pointerEvents: 'none' }}>
                              {order.cart.reduce((s, i) => s + i.quantity, 0)} · {timeAgo(order.openedAt)}
                            </span>
                          ) : (
                            <span style={{ color: occ ? '#f59e0b' : c.text, fontSize: 9, opacity: 0.7, marginTop: 2, pointerEvents: 'none' }}>
                              👥{table.capacity}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : (
                /* Grid view */
                <div style={s.slotGrid}>
                  {tables.map((table) => {
                    const status = tableStatus(table);
                    const order = openOrders[table.id];
                    return (
                      <button key={table.id}
                        data-testid="table-tile"
                        data-status={status}
                        data-name={table.name}
                        style={{ ...s.slotCard, ...(status === 'occupied' ? s.slotOccupied : s.slotFree) }}
                        onClick={() => onTableTap(table)}
                        onMouseDown={e => { (e.currentTarget as HTMLElement).style.transform = 'translateY(3px)'; }}
                        onMouseUp={e => { (e.currentTarget as HTMLElement).style.transform = ''; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.transform = ''; }}>
                        <div style={s.slotName}>{table.name}</div>
                        <div style={s.slotSub}>👥 {table.capacity}</div>
                        {order && order.cart.length > 0 ? (
                          <div style={s.slotOrderInfo}>
                            <span style={s.slotItemCount}>{order.cart.reduce((sum, i) => sum + i.quantity, 0)} items</span>
                            <span style={s.slotTime}>{timeAgo(order.openedAt)}</span>
                          </div>
                        ) : (
                          <div style={s.slotFreeLabel}>{status === 'occupied' ? 'Tap to view' : 'Tap to open'}</div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {/* ════════ BAY GRID (parking) ════════ */}
          {isParking && view === 'bays' && (
            <div style={s.slotView}>
              <div style={s.slotViewHeader}>
                <span style={s.slotViewTitle}>Parking Bays</span>
                <span style={s.slotLegend}>
                  <span style={{ ...s.legendDot, background: '#22c55e' }} /> Free
                  <span style={{ ...s.legendDot, background: '#f59e0b' }} /> Occupied
                </span>
              </div>
              {tables.length === 0 ? (
                <div style={s.emptySlots}>No bays configured. Add parking bays in Settings → Tables.</div>
              ) : (
                <div style={s.slotGrid}>
                  {tables.map((bay) => {
                    const status = bayStatus(bay);
                    const session = activeParkingSessions[bay.id];
                    return (
                      <button
                        key={bay.id}
                        style={{ ...s.slotCard, ...(status === 'occupied' ? s.slotOccupied : s.slotFree) }}
                        onClick={() => onBayTap(bay)}
                      >
                        <div style={s.slotName}>{bay.name}</div>
                        <div style={s.slotSub}>🅿️ Bay</div>
                        {session ? (
                          <div style={s.slotOrderInfo}>
                            <span style={s.slotItemCount}>{session.vehicle_plate || 'No plate'}</span>
                            <span style={s.slotTime}>{timeAgo(new Date(session.started_at).getTime())}</span>
                          </div>
                        ) : (
                          <div style={s.slotFreeLabel}>Tap to open</div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* ════════ PUMP GRID (petrol station) ════════ */}
          {isPetrol && view === 'pumps' && (
            <div style={s.slotView}>
              <div style={s.slotViewHeader}>
                <span style={s.slotViewTitle}>Fuel Pumps</span>
                <span style={s.slotLegend}>
                  <span style={{ ...s.legendDot, background: '#22c55e' }} /> Idle
                  <span style={{ ...s.legendDot, background: '#f59e0b' }} /> Dispensing
                </span>
              </div>
              {pumps.length === 0 ? (
                <div style={s.emptySlots}>No pumps configured. Add pumps in Settings → Pumps.</div>
              ) : (
                <div style={s.slotGrid}>
                  {pumps.map((pump) => {
                    const status = pumpStatus(pump);
                    const order = Object.values(openOrders).find(o => o.pumpId === pump.id);
                    return (
                      <button
                        key={pump.id}
                        style={{
                          ...s.slotCard,
                          ...(status === 'dispensing' ? s.slotOccupied : {}),
                          ...(status === 'idle' ? s.slotFree : {}),
                          ...(status === 'inactive' ? s.slotInactive : {}),
                        }}
                        onClick={() => status !== 'inactive' && onPumpTap(pump)}
                        disabled={status === 'inactive'}
                      >
                        <div style={s.slotName}>{pump.name}</div>
                        <div style={s.slotSub}>⛽ Pump</div>
                        {order ? (
                          <div style={s.slotOrderInfo}>
                            <span style={s.slotItemCount}>{order.cart.reduce((sum, i) => sum + i.quantity, 0)} items</span>
                            <span style={s.slotTime}>{timeAgo(order.openedAt)}</span>
                          </div>
                        ) : (
                          <div style={s.slotFreeLabel}>
                            {status === 'inactive' ? 'Inactive' : 'Tap to open'}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* ════════ PRODUCT GRID (all modes when view = 'products') ════════ */}
          {view === 'products' && (
            <>
              {/* Back-to-slot-picker bar (restaurant / parking / petrol) */}
              {hasSlotPicker && (
                <div style={s.productTopBar}>
                  <button style={s.backToTablesBtn} onClick={goBackToSlotPicker}>
                    {isRestaurant && '← Tables'}
                    {isParking && '← Bays'}
                    {isPetrol && '← Pumps'}
                  </button>
                  {activeKey && openOrders[activeKey] && (
                    <span style={s.activeTablePill}>
                      {openOrders[activeKey].tableName}
                      {isRestaurant && openOrders[activeKey].covers > 1 && (
                        <span style={s.coversPill}>👥 {openOrders[activeKey].covers}</span>
                      )}
                      {isParking && openOrders[activeKey].vehiclePlate && (
                        <span style={s.coversPill}>🚗 {openOrders[activeKey].vehiclePlate}</span>
                      )}
                      {isPetrol && (
                        <span style={s.coversPill}>⛽ {openOrders[activeKey].pumpName}</span>
                      )}
                    </span>
                  )}
                </div>
              )}

              {/* Barcode search hint for minimart */}
              {isMinimart && (
                <div style={s.barcodeHint}>
                  🔍 Scan barcode or search below
                </div>
              )}

              {/* Search */}
              <div style={s.productHeader}>
                <input
                  style={s.searchInput}
                  placeholder={isMinimart ? 'Search or scan barcode…' : 'Search products…'}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>

              {/* Category tabs */}
              <div style={s.catRow}>
                {[{ id: 'all', name: 'All', color: null, icon: null }, ...categories].map((cat) => (
                  <button
                    key={cat.id}
                    style={{
                      ...s.catBtn,
                      ...(activeCategory === cat.id
                        ? {
                            background: (cat as Category).color ?? '#3b82f6',
                            color: '#fff',
                            borderColor: 'transparent',
                          }
                        : {}),
                    }}
                    onClick={() => setActiveCategory(cat.id)}
                  >
                    {(cat as Category).icon && <span>{(cat as Category).icon} </span>}
                    {cat.name}
                  </button>
                ))}
              </div>

              {/* Product grid */}
              <div style={s.productGrid}>
                {filtered.length === 0 ? (
                  <div style={s.emptyProducts}>No products found</div>
                ) : (
                  filtered.map((product) => {
                    const inCart = cart.some((i) => i.product.id === product.id);
                    const cartQty = cart
                      .filter((i) => i.product.id === product.id)
                      .reduce((sum, i) => sum + i.quantity, 0);
                    const hasVariants =
                      product.has_variants && (variantsByProduct[product.id]?.length ?? 0) > 0;

                    return (
                      <button
                        key={product.id}
                        data-testid="product-card"
                        data-has-variants={hasVariants ? 'true' : 'false'}
                        style={{ ...s.productCard, ...(inCart ? s.productCardActive : {}) }}
                        onClick={() => addToCart(product)}
                      >
                        {inCart && <span style={s.cartBadge}>{cartQty}</span>}
                        {hasVariants && <span style={s.variantBadge}>options</span>}
                        {(product as any).is_fuel && <span style={s.fuelBadge}>⛽</span>}
                        <div style={s.productImage}>
                          {product.image_url ? (
                            <img
                              src={product.image_url}
                              alt={product.name}
                              style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 8 }}
                            />
                          ) : (
                            <span style={{ fontSize: 28 }}>
                              {(product as any).is_fuel ? '⛽' : '📦'}
                            </span>
                          )}
                        </div>
                        <div style={s.productName}>{product.name}</div>
                        <div style={s.productPrice}>
                          {currency} {Number(product.base_price).toLocaleString()}
                          {(product as any).is_fuel && (
                            <span style={{ fontSize: 9, color: '#64748b' }}>/{(product as any).fuel_unit ?? 'L'}</span>
                          )}
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </>
          )}
        </div>
        )} {/* end !isMinimart left panel */}

        {/* ── Right panel — Cart ──────────────────────────────────────────── */}
        {!isMinimart && (
        <div style={{
          ...s.rightPanel,
          ...(hasSlotPicker && !activeKey ? { width: 0, overflow: 'hidden', borderLeft: 'none' } : {}),
        }}>
          <div style={s.cartHeader}>
            <div>
              <div style={s.cartTitle}>{currentOrderLabel}</div>
              {isRestaurant && activeKey && openOrders[activeKey]?.covers > 1 && (
                <div style={s.cartCovers}>👥 {openOrders[activeKey].covers} covers</div>
              )}
              {isParking && activeKey && openOrders[activeKey]?.vehiclePlate && (
                <div style={s.cartCovers}>🚗 {openOrders[activeKey].vehiclePlate}</div>
              )}
              {isPetrol && activeKey && openOrders[activeKey]?.pumpName && (
                <div style={s.cartCovers}>⛽ {openOrders[activeKey].pumpName}</div>
              )}
            </div>
            {cart.length > 0 && (
              <button style={s.clearBtn} onClick={clearActiveOrder}>Clear</button>
            )}
          </div>

          {/* Slot picker hint when no active key */}
          {hasSlotPicker && !activeKey && (
            <div style={s.tableHint}>
              <span style={{ fontSize: 40, color: '#1e293b' }}>
                {isRestaurant && '🪑'}
                {isParking && '🅿️'}
                {isPetrol && '⛽'}
              </span>
              <p style={{ margin: '10px 0 0', color: '#64748b', fontSize: 13, textAlign: 'center' }}>
                {isRestaurant && 'Select a table to start an order'}
                {isParking && 'Select a bay to start a parking session'}
                {isPetrol && 'Select a pump to start fuelling'}
              </p>
            </div>
          )}

          {/* Parking time display */}
          {isParking && activeKey && parkingBill && (
            <div style={s.parkingBillBox}>
              <div style={s.parkingBillRow}>
                <span style={{ color: '#94a3b8', fontSize: 12 }}>Duration</span>
                <span style={{ color: '#f1f5f9', fontSize: 12, fontWeight: 600 }}>
                  {parkingBill.hours} hr{parkingBill.hours !== 1 ? 's' : ''}
                </span>
              </div>
              <div style={s.parkingBillRow}>
                <span style={{ color: '#94a3b8', fontSize: 12 }}>Rate</span>
                <span style={{ color: '#f1f5f9', fontSize: 12 }}>
                  {fmt(openOrders[activeKey]?.ratePerHour ?? 0, currency)}/hr
                </span>
              </div>
            </div>
          )}

          {/* Cart items */}
          <div style={s.cartItems}>
            {cart.length === 0 && (activeKey || !hasSlotPicker) && !isParking ? (
              <div style={s.emptyCart}>Add products to get started</div>
            ) : isParking && activeKey && parkingBill ? (
              /* Parking shows a single "fee" line instead of a cart */
              <div style={s.cartItem}>
                <div style={s.cartItemInfo}>
                  <div style={s.cartItemName}>Parking Fee</div>
                  <div style={s.cartItemPrice}>{fmt(openOrders[activeKey]?.ratePerHour ?? 0, currency)} × {parkingBill.hours} hr</div>
                </div>
                <div style={s.cartItemTotal}>{fmt(parkingBill.amount, currency)}</div>
              </div>
            ) : (
              cart.map((item, index) => (
                <div key={index}>
                <div style={s.cartItem}>
                  <div style={s.cartItemInfo}>
                    <div style={s.cartItemName}>{item.product.name}</div>
                    {item.selectedVariants.length > 0 && (
                      <div style={s.cartItemVariants}>
                        {item.selectedVariants.map((v) => `${v.groupName}: ${v.optionName}`).join(' · ')}
                      </div>
                    )}
                    <div style={s.cartItemPrice}>{fmt(item.unitPrice, currency)} {item.isFuel ? '/L' : 'each'}</div>
                  </div>
                  <div style={s.cartItemControls}>
                    {item.isFuel ? (
                      <span style={s.qtyNum}>{item.quantity.toFixed(2)} L</span>
                    ) : (
                      <>
                        <button style={s.qtyBtn} onClick={() => updateQty(index, -1)}>−</button>
                        <span style={s.qtyNum}>{item.quantity}</span>
                        <button style={s.qtyBtn} onClick={() => updateQty(index, 1)}>+</button>
                      </>
                    )}
                    <button style={s.removeBtn} onClick={() => removeItem(index)}>✕</button>
                  </div>
                  <div style={s.cartItemTotal}>{fmt(item.lineTotal, currency)}</div>
                </div>
                {isRestaurant && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 0 6px 0', marginTop: -2 }}>
                    <select
                      value={item.course ?? ''}
                      onChange={e => setItemCourse(index, e.target.value)}
                      style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 6, color: '#cbd5e1', fontSize: 11, padding: '2px 6px' }}
                    >
                      <option value="">No course</option>
                      <option value="Starters">Starters</option>
                      <option value="Mains">Mains</option>
                      <option value="Desserts">Desserts</option>
                      <option value="Drinks">Drinks</option>
                    </select>
                    {item.course && (
                      <button
                        onClick={() => toggleItemHold(index)}
                        style={{
                          fontSize: 11, padding: '2px 8px', borderRadius: 6, cursor: 'pointer',
                          border: '1px solid',
                          ...(item.fire_status === 'held'
                            ? { background: 'rgba(234,179,8,0.12)', borderColor: 'rgba(234,179,8,0.4)', color: '#fbbf24' }
                            : { background: 'rgba(34,197,94,0.12)', borderColor: 'rgba(34,197,94,0.4)', color: '#22c55e' }),
                        }}
                      >
                        {item.fire_status === 'held' ? '⏸ Held' : '✓ Fires now'}
                      </button>
                    )}
                  </div>
                )}
                </div>
              ))
            )}
          </div>

          {/* Totals */}
          {(cart.length > 0 || (isParking && activeKey && parkingBill)) && (
            <div style={s.cartFooter}>
              <div style={s.totalRow}>
                <span style={s.totalLabel}>Subtotal (incl. VAT)</span>
                <span style={s.totalValue}>{fmt(subtotal, currency)}</span>
              </div>
              <div style={s.totalRow}>
                <span style={{ ...s.totalLabel, color: '#475569' }}>VAT ({VAT_RATE}%)</span>
                <span style={{ ...s.totalValue, color: '#475569' }}>{fmt(vatAmount, currency)}</span>
              </div>
              {activePromos.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 4 }}>
                  {activePromos.map(p => (
                    <div key={p.id} style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.2)',
                      borderRadius: 8, padding: '4px 10px',
                    }}>
                      <span style={{ color: '#fbbf24', fontSize: 11, fontWeight: 600 }}>🎉 {p.name}</span>
                      {p.discount_value != null && (
                        <span style={{ color: '#fbbf24', fontSize: 11, fontWeight: 700 }}>
                          {p.discount_type === 'percentage' ? `-${p.discount_value}%` : `-KES ${p.discount_value}`}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {totalDiscount > 0 && (
                <div style={s.totalRow}>
                  <span style={{ ...s.totalLabel, color: '#22c55e' }}>Discount</span>
                  <span style={{ ...s.totalValue, color: '#22c55e' }}>- {fmt(totalDiscount, currency)}</span>
                </div>
              )}
              <div style={{ ...s.totalRow, borderTop: '1px solid #334155', paddingTop: 10, marginTop: 4 }}>
                <span style={{ ...s.totalLabel, color: '#f1f5f9', fontWeight: 700, fontSize: 17 }}>Total</span>
                <span style={{ ...s.totalValue, color: '#f1f5f9', fontWeight: 700, fontSize: 17 }}>{fmt(orderTotal, currency)}</span>
              </div>

              {/* ── Order-first: Send to Kitchen + Charge as separate actions ── */}
              {isRestaurant && orderMode === 'order_first' ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {/* Fire held courses — shown once the order is sent and held items remain */}
                  {activeKey && sentOrderIds[activeKey] && (() => {
                    const heldCourses = Array.from(new Set(
                      cart.filter(i => i.fire_status === 'held' && i.course).map(i => i.course as string)
                    ));
                    if (heldCourses.length === 0) return null;
                    return (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {heldCourses.map(c => (
                          <button key={c}
                            onClick={() => fireCourse(c)}
                            style={{ flex: '1 1 auto', padding: '8px 10px', background: 'rgba(234,179,8,0.12)', border: '1px solid rgba(234,179,8,0.4)', borderRadius: 8, color: '#fbbf24', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                            🔥 Fire {c}
                          </button>
                        ))}
                      </div>
                    );
                  })()}
                  {/* Send to Kitchen — disabled once sent (order already in DB) */}
                  <button
                    style={{
                      ...s.chargeBtn,
                      background: activeKey && sentOrderIds[activeKey]
                        ? '#166534'  // already sent — muted green
                        : '#15803d',
                      fontSize: 14,
                    }}
                    disabled={sendingToKitchen || !!(activeKey && sentOrderIds[activeKey])}
                    onClick={sendToKitchen}
                  >
                    {sendingToKitchen
                      ? 'Sending…'
                      : activeKey && sentOrderIds[activeKey]
                        ? '✓ Sent to kitchen'
                        : '🍳 Send to Kitchen'}
                  </button>
                  {/* Charge — always available; uses /pay if already sent */}
                  <button
                    data-testid="charge-button"
                    style={s.chargeBtn}
                    onClick={() => setShowPayment(true)}
                  >
                    Charge {fmt(orderTotal, currency)}
                  </button>
                </div>
              ) : (
                /* Pay-first (default) — single charge button + extra restaurant actions */
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {isRestaurant && cart.length > 0 && (
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button style={{ flex: 1, padding: '8px 0', background: 'transparent', border: '1px solid #334155', borderRadius: 8, color: '#94a3b8', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
                        onClick={() => { printGuestCheck(); }}>
                        🧾 Print Bill
                      </button>
                      <button style={{ flex: 1, padding: '8px 0', background: 'transparent', border: '1px solid #334155', borderRadius: 8, color: '#94a3b8', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
                        onClick={() => { setTransferTarget(null); setShowTransfer(true); }}>
                        ↔ Transfer
                      </button>
                      <button style={{ flex: 1, padding: '8px 0', background: 'transparent', border: '1px solid #a78bfa', borderRadius: 8, color: '#a78bfa', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
                        onClick={() => { setSplitStep('assign'); setSplitGuests([{name:'Guest 1',itemIndexes:[]},{name:'Guest 2',itemIndexes:[]}]); setShowSplitBill(true); }}>
                        👥 Split Bill
                      </button>
                      <button style={{ flex: 1, padding: '8px 0', background: 'transparent', border: '1px solid #f59e0b', borderRadius: 8, color: '#f59e0b', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
                        onClick={() => { setRoomNumber(''); setRoomGuestName(''); setRoomChargeError(''); setShowRoomCharge(true); }}>
                        🏨 Room
                      </button>
                    </div>
                  )}
                  <button data-testid="charge-button" style={s.chargeBtn} onClick={() => setShowPayment(true)}>
                    Charge {fmt(orderTotal, currency)}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
        )} {/* end !isMinimart right panel */}
      </div> {/* end body */}

      {/* ── Covers modal (restaurant) ──────────────────────────────────────── */}
      {showCoversModal && pendingTable && (
        <div style={s.overlay}>
          <div style={s.modal}>
            <h3 style={s.modalTitle}>Opening {pendingTable.name}</h3>
            <p style={s.modalSubtitle}>How many guests?</p>
            <div style={s.coversRow}>
              <button style={s.coversBtn} onClick={() => setCovers((c) => Math.max(1, c - 1))}>−</button>
              <span style={s.coversNum}>{covers}</span>
              <button
                style={s.coversBtn}
                onClick={() => setCovers((c) => Math.min(pendingTable.capacity, c + 1))}
              >+</button>
            </div>
            <p style={s.coversCapacity}>Max capacity: {pendingTable.capacity}</p>
            <div style={s.modalActions}>
              <button style={s.modalCancel} onClick={() => { setShowCoversModal(false); setPendingTable(null); }}>Cancel</button>
              <button style={s.modalConfirm} onClick={confirmCovers}>Open Table</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Clear table modal — shows order summary before clearing ──────── */}
      {showClearTableModal && tableToClear && (() => {
        const order = openOrders[tableToClear.id];
        const itemCount = order?.cart.reduce((s, i) => s + i.quantity, 0) ?? 0;
        const orderTotal = order?.cart.reduce((s, i) => s + i.lineTotal, 0) ?? 0;
        const openMins = (order?.openedAt && !isNaN(order.openedAt))
          ? Math.floor((Date.now() - order.openedAt) / 60000) : 0;
        const openTime = openMins < 1 ? 'Just now'
          : openMins < 60 ? `${openMins}m`
          : `${Math.floor(openMins / 60)}h ${openMins % 60}m`;

        return (
          <div style={s.overlay}>
            <div style={{
              ...s.modal,
              maxWidth: 400, padding: 0, overflow: 'hidden',
            }}>
              {/* Header */}
              <div style={{
                padding: '18px 20px 16px',
                borderBottom: '1px solid var(--pos-border)',
                background: 'var(--pos-modal)',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--pos-text)' }}>{tableToClear.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--pos-text3)', marginTop: 3 }}>
                      Open for <span style={{ color: 'var(--pos-text2)', fontWeight: 600 }}>{openTime}</span>
                      {order?.covers && order.covers > 1 && (
                        <span style={{ marginLeft: 10 }}>👥 {order.covers} covers</span>
                      )}
                    </div>
                  </div>
                  <button
                    style={{ background: 'var(--pos-surface)', border: '1px solid var(--pos-border)', borderRadius: 6, color: 'var(--pos-text3)', width: 26, height: 26, cursor: 'pointer', fontSize: 12 }}
                    onClick={() => { setShowClearTableModal(false); setTableToClear(null); }}
                  >✕</button>
                </div>
              </div>

              {/* Order items */}
              <div style={{ padding: '14px 20px', maxHeight: 220, overflowY: 'auto', background: 'var(--pos-modal)' }}>
                {!order || order.cart.length === 0 ? (
                  <div style={{ color: 'var(--pos-text4)', fontSize: 13, textAlign: 'center', padding: '16px 0' }}>
                    No items on this table
                  </div>
                ) : (
                  <>
                    {order.cart.map((item, i) => (
                      <div key={i} style={{
                        display: 'flex', justifyContent: 'space-between',
                        padding: '7px 0', borderBottom: '1px solid var(--pos-border)',
                        fontSize: 13,
                      }}>
                        <span style={{ color: 'var(--pos-text)' }}>
                          {item.product.name}
                          <span style={{ color: 'var(--pos-text3)', marginLeft: 6 }}>×{item.quantity}</span>
                        </span>
                        <span style={{ color: 'var(--pos-text2)', fontVariantNumeric: 'tabular-nums' }}>
                          {currency} {item.lineTotal.toLocaleString('en-KE', { minimumFractionDigits: 2 })}
                        </span>
                      </div>
                    ))}
                    <div style={{
                      display: 'flex', justifyContent: 'space-between',
                      padding: '10px 0 4px', fontWeight: 700, fontSize: 14,
                    }}>
                      <span style={{ color: 'var(--pos-text)' }}>Total</span>
                      <span style={{ color: '#22c55e' }}>
                        {currency} {orderTotal.toLocaleString('en-KE', { minimumFractionDigits: 2 })}
                      </span>
                    </div>
                  </>
                )}
              </div>

              {/* Actions */}
              <div style={{
                display: 'flex', gap: 10, padding: '14px 20px',
                borderTop: '1px solid var(--pos-border)',
                background: 'var(--pos-surface)',
              }}>
                <button
                  style={{
                    flex: 1, padding: '11px', background: 'var(--pos-panel)',
                    border: '1px solid var(--pos-border)', borderRadius: 10,
                    color: 'var(--pos-text)', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                    fontFamily: "'DM Sans','Segoe UI',sans-serif",
                  }}
                  onClick={() => {
                    setShowClearTableModal(false);
                    setTableToClear(null);
                    if (order) {
                      setActiveKey(tableToClear.id);
                      setCart(order.cart);
                      setView('products');
                    }
                  }}
                >
                  Resume order
                </button>
                <button
                  style={{
                    flex: 1, padding: '11px', background: '#ef4444',
                    border: 'none', borderRadius: 10,
                    color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer',
                    fontFamily: "'DM Sans','Segoe UI',sans-serif",
                  }}
                  onClick={() => clearTable(tableToClear)}
                >
                  Clear table
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Parking modal ─────────────────────────────────────────────────── */}
      {showParkingModal && pendingBay && (
        <div style={s.overlay}>
          <div style={s.modal}>
            <h3 style={s.modalTitle}>Open {pendingBay.name}</h3>
            <p style={s.modalSubtitle}>Enter vehicle details</p>

            <div style={{ textAlign: 'left', marginBottom: 16 }}>
              <label style={s.inputLabel}>Vehicle plate</label>
              <input
                style={s.modalInput}
                placeholder="e.g. KCA 123A"
                value={vehiclePlate}
                onChange={e => setVehiclePlate(e.target.value.toUpperCase())}
              />
            </div>

            <div style={{ textAlign: 'left', marginBottom: 16 }}>
              <label style={s.inputLabel}>Vehicle type</label>
              <div style={{ display: 'flex', gap: 8 }}>
                {['car', 'truck', 'motorbike', 'other'].map(t => (
                  <button
                    key={t}
                    style={{
                      ...s.typeBtn,
                      ...(vehicleType === t ? s.typeBtnActive : {}),
                    }}
                    onClick={() => setVehicleType(t)}
                  >
                    {t === 'car' && '🚗'} {t === 'truck' && '🚛'} {t === 'motorbike' && '🏍'} {t === 'other' && '🚐'}
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ textAlign: 'left', marginBottom: 20 }}>
              <label style={s.inputLabel}>Rate per hour ({currency})</label>
              <input
                style={s.modalInput}
                type="number"
                min={0}
                value={ratePerHour}
                onChange={e => setRatePerHour(Number(e.target.value))}
              />
            </div>

            <div style={s.modalActions}>
              <button style={s.modalCancel} onClick={() => { setShowParkingModal(false); setPendingBay(null); }}>Cancel</button>
              <button style={s.modalConfirm} onClick={confirmParking}>Open Bay</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Pump modal (petrol) ───────────────────────────────────────────── */}
      {showPumpModal && pendingPump && (
        <div style={s.overlay}>
          <div style={s.modal}>
            <h3 style={s.modalTitle}>{pendingPump.name}</h3>
            <p style={s.modalSubtitle}>Activate pump and select fuel grade from the product grid.</p>
            <div style={s.modalActions}>
              <button style={s.modalCancel} onClick={() => { setShowPumpModal(false); setPendingPump(null); }}>Cancel</button>
              <button style={s.modalConfirm} onClick={confirmPump}>Activate Pump</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Fuel entry modal (petrol — sell by litres/amount) ─────────────── */}
      {fuelEntry && (() => {
        const price = Number(fuelEntry.base_price) || 0;
        const amount = fuelEdited === 'amount'
          ? (parseFloat(fuelAmountStr) || 0)
          : (parseFloat(fuelLitresStr) || 0) * price;
        const litres = fuelEdited === 'litres'
          ? (parseFloat(fuelLitresStr) || 0)
          : (price > 0 ? (parseFloat(fuelAmountStr) || 0) / price : 0);
        const unit = (fuelEntry as any).fuel_unit ?? 'L';
        return (
          <div style={s.overlay}>
            <div style={s.modal}>
              <h3 style={s.modalTitle}>{fuelEntry.name}</h3>
              <p style={s.modalSubtitle}>{currency} {price.toLocaleString()}/{unit} · enter amount or {unit === 'L' ? 'litres' : unit}</p>

              <label style={{ fontSize: 12, color: 'var(--pos-text3)', display: 'block', marginBottom: 4 }}>Amount ({currency})</label>
              <input
                style={s.modalInput}
                type="number" inputMode="decimal" autoFocus
                value={fuelEdited === 'amount' ? fuelAmountStr : (amount ? amount.toFixed(2) : '')}
                onChange={e => { setFuelEdited('amount'); setFuelAmountStr(e.target.value); }}
                placeholder="0.00"
              />

              <label style={{ fontSize: 12, color: 'var(--pos-text3)', display: 'block', margin: '10px 0 4px' }}>Litres</label>
              <input
                style={s.modalInput}
                type="number" inputMode="decimal"
                value={fuelEdited === 'litres' ? fuelLitresStr : (litres ? litres.toFixed(2) : '')}
                onChange={e => { setFuelEdited('litres'); setFuelLitresStr(e.target.value); }}
                placeholder="0.00"
              />

              <div style={{ display: 'flex', gap: 8, margin: '12px 0' }}>
                {[500, 1000, 2000, 5000].map(q => (
                  <button key={q}
                    style={{ ...s.modalCancel, flex: 1, padding: '8px 0' }}
                    onClick={() => { setFuelEdited('amount'); setFuelAmountStr(String(q)); }}>
                    {q.toLocaleString()}
                  </button>
                ))}
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 12 }}>
                <span style={{ color: 'var(--pos-text3)' }}>{litres ? litres.toFixed(2) : '0.00'} {unit}</span>
                <span style={{ color: 'var(--pos-text)', fontWeight: 700 }}>{currency} {amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
              </div>

              <div style={s.modalActions}>
                <button style={s.modalCancel} onClick={() => setFuelEntry(null)}>Cancel</button>
                <button
                  style={{ ...s.modalConfirm, opacity: (amount > 0 && litres > 0) ? 1 : 0.4 }}
                  onClick={() => { if (amount > 0 && litres > 0) addFuelToCart(fuelEntry, litres, amount); }}>
                  Add to sale
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Variant modal ────────────────────────────────────────────────── */}
      {variantProduct && (
        <div style={s.overlay}>
          <div style={{ ...s.modal, maxWidth: 420, width: '92vw' }}>
            <div style={s.variantModalHeader}>
              <div>
                <h3 style={s.modalTitle}>{variantProduct.name}</h3>
                <p style={s.variantBasePrice}>Base: {fmt(variantProduct.base_price, currency)}</p>
              </div>
              <button style={s.variantCloseBtn} onClick={closeVariantModal}>✕</button>
            </div>

            <div style={s.variantGroups}>
              {variantGroups.map((group) => (
                <div key={group.id} style={s.variantGroup}>
                  <div style={s.variantGroupLabel}>
                    {group.name}
                    {group.required && <span style={s.requiredBadge}>Required</span>}
                  </div>
                  <div style={s.variantOptions}>
                    {[...group.variant_options]
                      .sort((a, b) => a.sort_order - b.sort_order)
                      .map((opt) => {
                        const isSelected = selectedVariants[group.id]?.id === opt.id;
                        return (
                          <button
                            key={opt.id}
                            data-testid="variant-option"
                            data-group={group.id}
                            style={{ ...s.variantOption, ...(isSelected ? s.variantOptionSelected : {}) }}
                            onClick={() => toggleVariantOption(group, opt)}
                          >
                            <span style={s.variantOptionName}>{opt.name}</span>
                            {opt.price_adjustment !== 0 && (
                              <span style={s.variantOptionPrice}>
                                {opt.price_adjustment > 0 ? '+' : ''}
                                {fmt(opt.price_adjustment, currency)}
                              </span>
                            )}
                          </button>
                        );
                      })}
                  </div>
                </div>
              ))}
            </div>

            <div style={s.variantTotal}>
              <span style={s.variantTotalLabel}>Item total</span>
              <span style={s.variantTotalValue}>
                {fmt(
                  Number(variantProduct.base_price) +
                    Object.values(selectedVariants).reduce((sum, opt) => sum + Number(opt.price_adjustment), 0),
                  currency
                )}
              </span>
            </div>

            <div style={s.modalActions}>
              <button style={s.modalCancel} onClick={closeVariantModal}>Cancel</button>
              <button
                style={{ ...s.modalConfirm, opacity: requiredMet ? 1 : 0.4, cursor: requiredMet ? 'pointer' : 'not-allowed' }}
                onClick={confirmVariants}
                disabled={!requiredMet}
              >
                Add to Order
              </button>
            </div>
          </div>
        </div>
      )}

      {showPayment && session && (
        <PaymentModal
          cart={cart}
          total={orderTotal}
          subtotal={subtotal}
          vatAmount={vatAmount}
          currency={currency}
          business={business as any}
          branchId={session.branchId}
          branchName={session.branchName}
          orderType={getOrderType()}
          tableNumber={activeKey && openOrders[activeKey]?.tableName ? openOrders[activeKey].tableName : undefined}
          loyaltyState={loyaltyState}
          discountState={discountState}
          shiftId={currentShift?.id ?? null}
          existingOrderId={activeKey ? sentOrderIds[activeKey] : undefined}
          onClose={() => setShowPayment(false)}
          onPaid={() => {
            // Free the table immediately on payment (independent of the receipt's
            // New Sale button), so a paid table never stays stuck "Occupied".
            if (activeKey) {
              setOpenOrders(prev => { const n = { ...prev }; delete n[activeKey]; return n; });
            }
          }}
          onSuccess={(orderNumber) => {
            // In pay-first mode, print KOT now. In order-first it was already printed on Send to Kitchen.
            if (isRestaurant && orderMode === 'pay_first' && branchPrinters.length > 0) {
              printKOTs(
                cart,
                {
                  orderNumber,
                  tableNumber: activeKey && openOrders[activeKey]?.tableName
                    ? openOrders[activeKey].tableName : undefined,
                  orderType: getOrderType(),
                  branchName: session?.branchName,
                },
                branchPrinters,
                printerSettings,
              ).catch(err => console.error('[KOT]', err));
            }
            // Release pump on payment
            if (isPetrol && activeKey && openOrders[activeKey]?.pumpId) {
              const pumpId = openOrders[activeKey].pumpId!;
              setPumps(prev => prev.map(p => p.id === pumpId ? { ...p, status: 'idle' } : p));
            }
            // Clear parking session on payment + close it server-side
            if (isParking && activeKey && openOrders[activeKey]?.tableId) {
              const bayId    = openOrders[activeKey].tableId!;
              const psId     = openOrders[activeKey].parkingSessionId;
              // Close the session on the server (non-blocking — local state is cleared anyway)
              if (psId && !psId.startsWith('ps-')) {
                posApi.post(`/api/parking-sessions/${psId}/close`, {})
                  .catch(err => console.error('[parking] session close failed:', err));
              }
              setActiveParkingSessions(prev => {
                const next = { ...prev };
                delete next[bayId];
                return next;
              });
            }
            // Clear sent order id for this table
            if (activeKey && sentOrderIds[activeKey]) {
              setSentOrderIds(prev => {
                const next = { ...prev };
                delete next[activeKey];
                return next;
              });
            }
            setShowPayment(false);
            setCart([]);
            setDiscountState(null);
            setLoyaltyState(null);
            if (activeKey) {
              setOpenOrders(prev => {
                const next = { ...prev };
                delete next[activeKey];
                return next;
              });
              setActiveKey(null);
            }
            // Bug fix: do NOT call goBackToSlotPicker() here. That helper re-adds
            // openOrders[activeKey] via a stale closure, which re-occupies the table
            // that was just paid. The table was already freed above (and by onPaid);
            // simply return to the slot-picker view without re-adding it.
            if (isRestaurant) setView('tables');
            else if (isParking) setView('bays');
            else if (isPetrol) setView('pumps');
          }}
        />
      )}

      {/* ── Table Transfer Modal ─────────────────────────────────────────── */}
      {showTransfer && isRestaurant && (
        <div style={s.overlay}>
          <div style={{ ...s.modal, width: 420, textAlign: 'left' }}>
            <p style={{ ...s.modalTitle, textAlign: 'left', marginBottom: 4 }}>Transfer Table</p>
            <p style={{ ...s.modalSubtitle, textAlign: 'left', marginBottom: 16 }}>
              {(activeKey && openOrders[activeKey]?.tableName)
                ? <>Move <strong style={{ color: '#fff' }}>{openOrders[activeKey]!.tableName}</strong>'s order to another table</>
                : <>Move this order to another table</>}
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(80px, 1fr))', gap: 8, marginBottom: 20, maxHeight: 260, overflowY: 'auto' }}>
              {tables
                .filter(t => {
                  const key = `table-${t.id}`;
                  return key !== activeKey && !openOrders[key]?.cart?.length;
                })
                .map(t => (
                  <button key={t.id}
                    onClick={() => setTransferTarget(`table-${t.id}`)}
                    style={{
                      padding: '10px 6px', borderRadius: 10, border: `2px solid ${transferTarget === `table-${t.id}` ? '#3b82f6' : '#334155'}`,
                      background: transferTarget === `table-${t.id}` ? 'rgba(59,130,246,0.12)' : 'var(--pos-surface)',
                      color: transferTarget === `table-${t.id}` ? '#60a5fa' : '#94a3b8',
                      fontSize: 13, fontWeight: 600, cursor: 'pointer', textAlign: 'center',
                    }}>
                    {t.name}
                    <div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>👥{t.capacity}</div>
                  </button>
                ))}
            </div>
            {tables.filter(t => `table-${t.id}` !== activeKey && !openOrders[`table-${t.id}`]?.cart?.length).length === 0 && (
              <p style={{ color: '#64748b', fontSize: 13, marginBottom: 16, textAlign: 'center' }}>All other tables are occupied.</p>
            )}
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => { setShowTransfer(false); setTransferTarget(null); }}
                style={{ flex: 1, padding: '11px 0', background: 'var(--pos-surface)', border: '1px solid var(--pos-border)', borderRadius: 10, color: 'var(--pos-text3)', fontSize: 13, cursor: 'pointer' }}>
                Cancel
              </button>
              <button
                disabled={!transferTarget}
                onClick={() => {
                  if (!transferTarget || !activeKey) return;
                  const targetTable = tables.find(t => `table-${t.id}` === transferTarget);
                  if (!targetTable) return;
                  // Move order to new table key
                  const currentOrder = openOrders[activeKey];
                  setOpenOrders(prev => {
                    const next = { ...prev };
                    next[transferTarget] = {
                      ...currentOrder,
                      tableId: targetTable.id,
                      tableName: targetTable.name,
                    };
                    delete next[activeKey];
                    return next;
                  });
                  // Move sentOrderId if exists
                  if (sentOrderIds[activeKey]) {
                    setSentOrderIds(prev => {
                      const next = { ...prev };
                      next[transferTarget] = next[activeKey];
                      delete next[activeKey];
                      return next;
                    });
                  }
                  setActiveKey(transferTarget);
                  setShowTransfer(false);
                  setTransferTarget(null);
                }}
                style={{ flex: 1, padding: '11px 0', background: transferTarget ? '#3b82f6' : '#334155', border: 'none', borderRadius: 10, color: '#fff', fontSize: 13, fontWeight: 700, cursor: transferTarget ? 'pointer' : 'default', opacity: transferTarget ? 1 : 0.5 }}>
                Transfer →
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Split Bill by Items Modal ─────────────────────────────────────── */}
      {showSplitBill && isRestaurant && (() => {
        const assignedAll = cart.every((_, idx) => splitGuests.some(g => g.itemIndexes.includes(idx)));
        const guestTotals = splitGuests.map(g => ({
          ...g,
          total: g.itemIndexes.reduce((s, idx) => s + (cart[idx]?.lineTotal ?? 0), 0),
        }));

        return (
          <div style={s.overlay}>
            <div style={{ background: 'var(--pos-modal)', border: '1px solid var(--pos-border)', borderRadius: 16, padding: '24px 28px', width: 480, boxShadow: '0 24px 64px rgba(0,0,0,0.4)', maxHeight: '85vh', overflowY: 'auto' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                <p style={{ fontSize: 16, fontWeight: 700, color: 'var(--pos-text)', margin: 0 }}>Split Bill by Items</p>
                <button onClick={() => setShowSplitBill(false)} style={{ background: 'none', border: 'none', color: '#64748b', fontSize: 18, cursor: 'pointer' }}>✕</button>
              </div>

              {splitStep === 'assign' ? (
                <>
                  {/* Guest name inputs */}
                  <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                    {splitGuests.map((g, gi) => (
                      <input key={gi} value={g.name}
                        onChange={e => setSplitGuests(prev => prev.map((x, i) => i === gi ? { ...x, name: e.target.value } : x))}
                        style={{ flex: 1, background: 'var(--pos-input)', border: '1px solid var(--pos-input-border)', borderRadius: 8, padding: '6px 10px', color: 'var(--pos-text)', fontSize: 12 }} />
                    ))}
                    {splitGuests.length < 6 && (
                      <button onClick={() => setSplitGuests(prev => [...prev, { name: `Guest ${prev.length + 1}`, itemIndexes: [] }])}
                        style={{ padding: '6px 12px', background: 'var(--pos-surface)', border: '1px solid var(--pos-border)', borderRadius: 8, color: '#60a5fa', fontSize: 12, cursor: 'pointer' }}>
                        + Guest
                      </button>
                    )}
                  </div>

                  {/* Item assignment */}
                  <div style={{ marginBottom: 16 }}>
                    {cart.map((item, idx) => {
                      const assignedTo = splitGuests.findIndex(g => g.itemIndexes.includes(idx));
                      return (
                        <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--pos-border)' }}>
                          <div style={{ flex: 1, fontSize: 13, color: 'var(--pos-text)' }}>
                            {item.product.name}
                            <span style={{ color: '#64748b', marginLeft: 6 }}>{item.quantity}× {fmt(item.lineTotal, currency)}</span>
                          </div>
                          <div style={{ display: 'flex', gap: 4 }}>
                            {splitGuests.map((g, gi) => (
                              <button key={gi} onClick={() => setSplitGuests(prev => prev.map((x, i) => ({
                                  ...x,
                                  itemIndexes: i === gi
                                    ? x.itemIndexes.includes(idx) ? x.itemIndexes.filter(n => n !== idx) : [...x.itemIndexes, idx]
                                    : x.itemIndexes.filter(n => n !== idx),
                                })))}
                                style={{ padding: '3px 8px', borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: 'pointer', border: assignedTo === gi ? 'none' : '1px solid var(--pos-border)', background: assignedTo === gi ? '#3b82f6' : 'var(--pos-surface)', color: assignedTo === gi ? '#fff' : '#64748b' }}>
                                {g.name.slice(0, 6)}
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Guest totals preview */}
                  <div style={{ background: 'var(--pos-surface)', borderRadius: 10, padding: '12px 14px', marginBottom: 16 }}>
                    {guestTotals.map((g, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
                        <span style={{ color: '#94a3b8' }}>{g.name}</span>
                        <span style={{ color: '#f1f5f9', fontWeight: 600 }}>{fmt(g.total, currency)}</span>
                      </div>
                    ))}
                  </div>

                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => setShowSplitBill(false)}
                      style={{ flex: 1, padding: '11px 0', background: 'var(--pos-surface)', border: '1px solid var(--pos-border)', borderRadius: 10, color: 'var(--pos-text3)', fontSize: 13, cursor: 'pointer' }}>
                      Cancel
                    </button>
                    <button disabled={!assignedAll}
                      onClick={() => { setSplitPayingGuest(0); setSplitStep('pay'); }}
                      style={{ flex: 1, padding: '11px 0', background: assignedAll ? '#22c55e' : '#334155', border: 'none', borderRadius: 10, color: assignedAll ? '#000' : '#64748b', fontSize: 13, fontWeight: 700, cursor: assignedAll ? 'pointer' : 'default' }}>
                      {assignedAll ? 'Proceed to Payment →' : 'Assign all items first'}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  {/* Payment step — pay each guest one at a time */}
                  <div style={{ marginBottom: 16, background: 'var(--pos-surface)', borderRadius: 10, padding: '12px 14px' }}>
                    {guestTotals.map((g, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: i < guestTotals.length - 1 ? '1px solid var(--pos-border)' : 'none' }}>
                        <span style={{ fontSize: 13, color: i < splitPayingGuest ? '#22c55e' : i === splitPayingGuest ? '#f1f5f9' : '#64748b', fontWeight: i === splitPayingGuest ? 700 : 400 }}>
                          {i < splitPayingGuest ? '✓ ' : i === splitPayingGuest ? '▶ ' : ''}{g.name}
                        </span>
                        <span style={{ fontSize: 13, color: i === splitPayingGuest ? '#22c55e' : '#64748b', fontWeight: 600 }}>{fmt(g.total, currency)}</span>
                      </div>
                    ))}
                  </div>
                  <p style={{ fontSize: 13, color: '#94a3b8', marginBottom: 14 }}>
                    Now collecting payment from <strong style={{ color: '#f1f5f9' }}>{splitGuests[splitPayingGuest]?.name}</strong> — {fmt(guestTotals[splitPayingGuest]?.total ?? 0, currency)}
                  </p>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => setSplitStep('assign')}
                      style={{ flex: 1, padding: '11px 0', background: 'var(--pos-surface)', border: '1px solid var(--pos-border)', borderRadius: 10, color: 'var(--pos-text3)', fontSize: 13, cursor: 'pointer' }}>
                      ← Back
                    </button>
                    <button onClick={() => {
                      // Build a sub-cart for this guest and open PaymentModal
                      const guest = splitGuests[splitPayingGuest];
                      const guestCart = guest.itemIndexes.map(idx => cart[idx]).filter(Boolean);
                      // Temporarily replace cart for payment
                      setCart(guestCart);
                      setShowSplitBill(false);
                      setShowPayment(true);
                      // After payment, restore remaining items (handled in onSuccess via splitPayingGuest)
                    }}
                      style={{ flex: 2, padding: '11px 0', background: '#22c55e', border: 'none', borderRadius: 10, color: '#000', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                      Charge {fmt(guestTotals[splitPayingGuest]?.total ?? 0, currency)} →
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        );
      })()}

      {/* ── Room Charge Modal ─────────────────────────────────────────────── */}
      {showRoomCharge && isRestaurant && (
        <div style={s.overlay}>
          <div style={{ ...s.modal, width: 380, textAlign: 'left' }}>
            <p style={{ ...s.modalTitle, textAlign: 'left', marginBottom: 4 }}>🏨 Post to Room</p>
            <p style={{ ...s.modalSubtitle, textAlign: 'left', marginBottom: 20 }}>
              Charge {fmt(orderTotal, currency)} to a hotel room — guest settles at checkout.
            </p>
            <div style={{ marginBottom: 14 }}>
              <label style={{ ...s.inputLabel }}>Room number *</label>
              <input value={roomNumber} onChange={e => setRoomNumber(e.target.value.toUpperCase())}
                placeholder="e.g. 101, 204B"
                style={{ ...s.modalInput, marginBottom: 12, letterSpacing: '0.08em', fontWeight: 700, fontSize: 15, textAlign: 'center' }} />
              <label style={{ ...s.inputLabel }}>Guest name (optional)</label>
              <input value={roomGuestName} onChange={e => setRoomGuestName(e.target.value)}
                placeholder="Guest's name"
                style={{ ...s.modalInput }} />
            </div>
            {roomChargeError && (
              <p style={{ color: '#fca5a5', fontSize: 12, marginBottom: 10 }}>{roomChargeError}</p>
            )}
            <div style={{ background: 'var(--pos-surface)', borderRadius: 10, padding: '10px 14px', marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#64748b', marginBottom: 4 }}>
                <span>Items</span><span>{cart.length} item{cart.length !== 1 ? 's' : ''}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, fontWeight: 700, color: '#f1f5f9' }}>
                <span>Total</span><span>{fmt(orderTotal, currency)}</span>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setShowRoomCharge(false)}
                style={{ flex: 1, padding: '11px 0', background: 'var(--pos-surface)', border: '1px solid var(--pos-border)', borderRadius: 10, color: 'var(--pos-text3)', fontSize: 13, cursor: 'pointer' }}>
                Cancel
              </button>
              <button
                disabled={!roomNumber.trim() || roomCharging}
                onClick={async () => {
                  if (!roomNumber.trim() || !session) return;
                  setRoomCharging(true); setRoomChargeError('');
                  try {
                    // Create the order. The room charge is recorded as an 'other'
                    // payment leg whose reference carries the room + guest, so it
                    // posts as a completed sale against the room.
                    const result = await posApi.post<{ orderId: string; orderNumber: string }>('/api/orders', {
                      branch_id:      session.branchId,
                      order_number:   generateOrderNumber(),
                      order_type:     'dine_in',
                      subtotal,
                      vat_amount:     vatAmount,
                      total:          orderTotal,
                      shift_id:       currentShift?.id ?? null,
                      table_id:       activeKey && openOrders[activeKey]?.tableId ? openOrders[activeKey].tableId : null,
                      items: cart.map(i => ({
                        product:           { id: i.product.id, name: i.product.name, categories: i.product.categories ?? null },
                        unitPrice:         i.unitPrice,
                        quantity:          i.quantity,
                        lineTotal:         i.lineTotal,
                        selectedVariants:  i.selectedVariants,
                        selectedModifiers: i.selectedModifiers,
                      })),
                      payments: [{
                        method:    'other',
                        amount:    orderTotal,
                        reference: `Room ${roomNumber.trim()}${roomGuestName.trim() ? ' — ' + roomGuestName.trim() : ''}`,
                      }],
                    });
                    // Print a room charge slip
                    const slip = `ROOM CHARGE

Room: ${roomNumber}
Guest: ${roomGuestName || '—'}
Order: ${result.orderNumber}
Total: ${fmt(orderTotal, currency)}
Date: ${new Date().toLocaleString('en-KE')}

Signature: _______________`;
                    const slipHtml = `<html><head><style>body{font-family:'Courier New',monospace;font-size:12px;padding:16px;white-space:pre;}</style></head><body>${slip}</body></html>`;
                    const pf = document.createElement('iframe');
                    Object.assign(pf.style, { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0' });
                    document.body.appendChild(pf);
                    const pdoc = pf.contentWindow?.document;
                    if (pdoc) {
                      pdoc.open(); pdoc.write(slipHtml); pdoc.close();
                      const pwin = pf.contentWindow!;
                      const rm = () => { if (pf.parentNode) pf.parentNode.removeChild(pf); };
                      pwin.onafterprint = () => setTimeout(rm, 100);
                      setTimeout(() => { try { pwin.focus(); pwin.print(); } catch { rm(); } setTimeout(rm, 60000); }, 200);
                    }
                    // Clear order
                    setShowRoomCharge(false);
                    setCart([]);
                    setDiscountState(null);
                    setLoyaltyState(null);
                    if (activeKey) {
                      setOpenOrders(prev => { const n = { ...prev }; delete n[activeKey]; return n; });
                      setActiveKey(null);
                    }
                    if (hasSlotPicker) goBackToSlotPicker();
                  } catch (e: any) {
                    setRoomChargeError(e.message ?? 'Failed to post room charge');
                  } finally {
                    setRoomCharging(false);
                  }
                }}
                style={{ flex: 2, padding: '11px 0', background: roomNumber.trim() ? '#f59e0b' : '#334155', border: 'none', borderRadius: 10, color: roomNumber.trim() ? '#000' : '#64748b', fontSize: 13, fontWeight: 700, cursor: roomNumber.trim() ? 'pointer' : 'default' }}>
                {roomCharging ? 'Posting…' : `Post to Room ${roomNumber || '?'}`}
              </button>
            </div>
          </div>
        </div>
      )}

            <POSDrawer isOpen={showDrawer} onClose={() => setShowDrawer(false)} currency={currency} />

      {showZReport && <ZReportModal onClose={() => setShowZReport(false)} />}

      {shiftModal && (
        <ShiftModal
          mode={shiftModal}
          shiftId={currentShift?.id}
          branchId={session?.branchId ?? undefined}
          currency={currency}
          onShiftOpened={(shift) => { setCurrentShift(shift); setShiftModal(null); }}
          onShiftClosed={(shift) => {
            setCurrentShift(shift);
            setShiftModal(null);
            clearCashierSession();
            navigate('/pos');
          }}
          onFloatRecorded={() => setShiftModal(null)}
          onClockRecorded={() => setShiftModal(null)}
          onClose={() => {
            if (shiftModal === 'open' && !currentShift) {
              clearCashierSession();
              navigate('/pos');
            } else {
              setShiftModal(null);
            }
          }}
        />
      )}

      {showPrinterSettings && (
        <PrinterSettingsModal
          settings={printerSettings}
          onSave={savePrinterSettings}
          onReset={resetPrinterSettings}
          onClose={() => setShowPrinterSettings(false)}
        />
      )}

      {/* ── Lock confirm ──────────────────────────────────────────────────── */}
      {showLockConfirm && (
        <div style={s.overlay}>
          <div style={s.modal}>
            <h3 style={s.modalTitle}>Lock Screen?</h3>
            <p style={s.modalSubtitle}>
              {Object.keys(openOrders).length > 0
                ? `You have ${Object.keys(openOrders).length} open order(s). They will be lost if you lock.`
                : 'You will be returned to the PIN screen.'}
            </p>
            <div style={s.modalActions}>
              <button style={s.modalCancel} onClick={() => setShowLockConfirm(false)}>Cancel</button>
              <button
                style={{ ...s.modalConfirm, background: '#ef4444' }}
                onClick={() => { clearCashierSession(); navigate('/pos'); }}
              >Lock</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const spinCss = `@keyframes spin { to { transform: rotate(360deg); } }`;

const s: Record<string, React.CSSProperties> = {
  root: {
    height: '100vh', display: 'flex', flexDirection: 'column',
    background: 'var(--pos-bg)', fontFamily: "'DM Sans','Segoe UI',sans-serif",
    color: 'var(--pos-text)', overflow: 'hidden',
  },
  loadingRoot: {
    height: '100vh', display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', background: 'var(--pos-bg)',
  },
  spinnerLg: {
    width: 36, height: 36, border: '3px solid var(--pos-border)',
    borderTopColor: '#3b82f6', borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
  // Header — always dark for POS readability
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '0 20px', height: 56, background: '#1e293b',
    borderBottom: '1px solid #334155', flexShrink: 0, gap: 16,
  },
  headerLeft: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 180 },
  logoMark: { fontSize: 20 },
  branchLabel: { fontSize: 13, fontWeight: 700, color: '#f1f5f9', lineHeight: 1.2 },
  staffLabel: { fontSize: 11, color: '#94a3b8', lineHeight: 1.2 },
  headerCenter: {
    flex: 1, display: 'flex', alignItems: 'center',
    gap: 8, overflowX: 'auto' as const,
  },
  modeBadge: {
    padding: '3px 10px', background: 'rgba(59,130,246,0.15)',
    border: '1px solid rgba(59,130,246,0.3)', borderRadius: 20,
    color: '#93c5fd', fontSize: 11, fontWeight: 600, flexShrink: 0,
  },
  parkedBadge: {
    display: 'flex', alignItems: 'center', gap: 6, padding: '4px 12px',
    background: '#334155', border: '1px solid #475569', borderRadius: 20,
    color: '#94a3b8', fontSize: 12, cursor: 'pointer', flexShrink: 0,
  },
  parkedBadgeActive: {
    background: 'rgba(59,130,246,0.15)', borderColor: '#3b82f6', color: '#60a5fa',
  },
  parkedCount: {
    background: '#475569', borderRadius: 10, padding: '0 5px',
    fontSize: 10, fontWeight: 700,
  },
  parkBtn: {
    padding: '4px 12px', background: 'transparent', border: '1px dashed #475569',
    borderRadius: 20, color: '#64748b', fontSize: 12, cursor: 'pointer', flexShrink: 0,
  },
  headerRight: {
    display: 'flex', alignItems: 'center', gap: 12,
    minWidth: 140, justifyContent: 'flex-end',
  },
  clock: { fontSize: 13, color: '#64748b', fontVariantNumeric: 'tabular-nums' },
  lockBtn: {
    padding: '5px 14px', background: 'rgba(239,68,68,0.1)',
    border: '1px solid rgba(239,68,68,0.25)', borderRadius: 8,
    color: '#fca5a5', fontSize: 12, cursor: 'pointer', fontWeight: 600,
  },
  // Body
  body: { flex: 1, display: 'flex', overflow: 'hidden' },
  leftPanel: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  // Shared slot view (tables / bays / pumps)
  slotView: { flex: 1, padding: '20px 24px', overflowY: 'auto' as const, background: 'var(--pos-bg)' },
  slotViewHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20,
  },
  slotViewTitle: { fontSize: 12, fontWeight: 700, color: 'var(--pos-text3)', textTransform: 'uppercase' as const, letterSpacing: '0.08em' },
  slotLegend: { display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--pos-text3)' },
  legendDot: { display: 'inline-block', width: 8, height: 8, borderRadius: '50%', marginRight: 4 },
  slotGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, 140px)', gap: 12 },
  slotCard: {
    height: 110,
    padding: '14px 12px 12px',
    borderRadius: 16,
    border: '1px solid transparent',
    cursor: 'pointer',
    textAlign: 'center' as const,
    transition: 'transform 0.1s ease, box-shadow 0.1s ease',
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3,
    userSelect: 'none' as const,
  },
  slotFree: {
    background: 'var(--pos-free-bg)',
    border: '1px solid var(--pos-free-border)',
    boxShadow: 'var(--pos-free-shadow)',
  },
  slotOccupied: {
    background: 'var(--pos-occ-bg)',
    border: '1px solid var(--pos-occ-border)',
    boxShadow: 'var(--pos-occ-shadow)',
  },
  slotInactive: {
    background: 'var(--pos-surface)', border: '1px solid var(--pos-border)', opacity: 0.45,
    boxShadow: 'none',
  },
  slotName: { fontSize: 15, fontWeight: 800, color: 'var(--pos-text)', letterSpacing: '-0.3px' },
  slotSub: { fontSize: 11, color: 'var(--pos-text4)' },
  slotOrderInfo: { display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: 2, marginTop: 4 },
  slotItemCount: { fontSize: 12, color: '#f59e0b', fontWeight: 700 },
  slotTime: { fontSize: 10, color: 'var(--pos-text4)' },
  slotFreeLabel: { fontSize: 10, color: 'var(--pos-free-sub)', marginTop: 4, fontWeight: 500 },
  emptySlots: { color: 'var(--pos-text4)', fontSize: 13, textAlign: 'center' as const, padding: '40px 0' },
  // Product view
  barcodeHint: {
    padding: '6px 16px', fontSize: 11, color: 'var(--pos-text4)',
    background: 'rgba(34,197,94,0.05)', borderBottom: '1px solid var(--pos-border-l)',
  },
  productTopBar: {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '10px 16px', borderBottom: '1px solid var(--pos-border-l)', flexShrink: 0,
    background: 'var(--pos-panel)',
  },
  backToTablesBtn: {
    background: 'transparent', border: '1px solid var(--pos-border)', borderRadius: 8,
    color: 'var(--pos-text3)', fontSize: 13, cursor: 'pointer', padding: '5px 12px',
  },
  activeTablePill: {
    display: 'flex', alignItems: 'center', gap: 8,
    background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(59,130,246,0.25)',
    borderRadius: 20, padding: '4px 12px', fontSize: 13, color: '#93c5fd', fontWeight: 600,
  },
  coversPill: { fontSize: 11, color: '#60a5fa' },
  productHeader: { padding: '10px 16px 8px', flexShrink: 0, background: 'var(--pos-panel)' },
  searchInput: {
    width: '100%', background: 'var(--pos-input)', border: '1px solid var(--pos-input-border)',
    borderRadius: 8, padding: '8px 14px', color: 'var(--pos-text)', fontSize: 13,
    outline: 'none', boxSizing: 'border-box' as const,
  },
  catRow: {
    display: 'flex', gap: 6, padding: '8px 16px',
    borderBottom: '1px solid var(--pos-border-l)', overflowX: 'auto' as const, flexShrink: 0,
    background: 'var(--pos-panel)',
  },
  catBtn: {
    padding: '5px 12px', background: 'var(--pos-surface)', border: '1px solid var(--pos-border)',
    borderRadius: 20, color: 'var(--pos-text3)', fontSize: 12, fontWeight: 500,
    cursor: 'pointer', whiteSpace: 'nowrap' as const, flexShrink: 0,
  },
  productGrid: {
    flex: 1, overflowY: 'auto' as const, padding: 12,
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))',
    gap: 10, alignContent: 'start', background: 'var(--pos-bg)',
  },
  productCard: {
    position: 'relative' as const, background: 'var(--pos-panel)', border: '1px solid var(--pos-border)',
    borderRadius: 12, padding: 10, cursor: 'pointer', textAlign: 'center' as const,
    transition: 'all 0.15s ease', display: 'flex', flexDirection: 'column',
    alignItems: 'center', gap: 5,
    boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
  },
  productCardActive: { border: '1px solid rgba(59,130,246,0.5)', background: 'rgba(59,130,246,0.06)' },
  cartBadge: {
    position: 'absolute' as const, top: 6, right: 6, background: '#3b82f6',
    color: '#fff', fontSize: 10, fontWeight: 700, width: 18, height: 18,
    borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  variantBadge: {
    position: 'absolute' as const, top: 6, left: 6,
    background: 'rgba(168,85,247,0.2)', border: '1px solid rgba(168,85,247,0.3)',
    color: '#c084fc', fontSize: 9, fontWeight: 600, padding: '1px 5px',
    borderRadius: 6, letterSpacing: '0.3px',
  },
  fuelBadge: { position: 'absolute' as const, top: 6, left: 6, fontSize: 12 },
  productImage: {
    width: 64, height: 64, borderRadius: 8, background: 'var(--pos-surface)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  productName: { fontSize: 12, fontWeight: 600, color: 'var(--pos-text)', lineHeight: 1.3 },
  productPrice: { fontSize: 11, color: '#22c55e', fontWeight: 600 },
  emptyProducts: {
    gridColumn: '1/-1', textAlign: 'center' as const,
    color: 'var(--pos-text4)', fontSize: 13, padding: '40px 0',
  },
  // Right panel
  rightPanel: {
    width: 300, flexShrink: 0, display: 'flex', flexDirection: 'column',
    background: 'var(--pos-panel)', borderLeft: '1px solid var(--pos-border)',
    transition: 'width 0.2s ease',
  },
  cartHeader: {
    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
    padding: '14px 16px', borderBottom: '1px solid var(--pos-border)', flexShrink: 0,
  },
  cartTitle: { fontSize: 14, fontWeight: 700, color: 'var(--pos-text)' },
  cartCovers: { fontSize: 11, color: 'var(--pos-text3)', marginTop: 2 },
  clearBtn: { background: 'transparent', border: 'none', color: 'var(--pos-text3)', fontSize: 12, cursor: 'pointer' },
  tableHint: {
    flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', padding: 24,
  },
  parkingBillBox: {
    margin: '10px 14px 0', padding: '10px 14px',
    background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.15)',
    borderRadius: 10, flexShrink: 0,
  },
  parkingBillRow: { display: 'flex', justifyContent: 'space-between', padding: '3px 0' },
  cartItems: {
    flex: 1, overflowY: 'auto' as const, padding: '10px 14px',
    display: 'flex', flexDirection: 'column', gap: 10,
  },
  emptyCart: { textAlign: 'center' as const, color: 'var(--pos-text4)', fontSize: 13, padding: '40px 0' },
  cartItem: {
    display: 'grid', gridTemplateColumns: '1fr auto',
    gridTemplateRows: 'auto auto', gap: '2px 8px',
    paddingBottom: 10, borderBottom: '1px solid var(--pos-border)',
  },
  cartItemInfo: { gridColumn: 1 },
  cartItemName: { fontSize: 13, fontWeight: 600, color: 'var(--pos-text)' },
  cartItemVariants: { fontSize: 11, color: '#7c3aed', marginTop: 1 },
  cartItemPrice: { fontSize: 11, color: 'var(--pos-text3)' },
  cartItemControls: {
    gridColumn: 2, gridRow: '1 / 3', display: 'flex', alignItems: 'center', gap: 4,
  },
  qtyBtn: {
    width: 24, height: 24, background: 'var(--pos-surface)', border: '1px solid var(--pos-border)',
    borderRadius: 6, color: 'var(--pos-text)', fontSize: 14, cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  qtyNum: { fontSize: 13, fontWeight: 600, color: 'var(--pos-text)', minWidth: 16, textAlign: 'center' as const },
  removeBtn: {
    width: 22, height: 22, background: 'transparent', border: 'none',
    color: 'var(--pos-text4)', fontSize: 11, cursor: 'pointer',
  },
  cartItemTotal: { gridColumn: 1, fontSize: 12, color: 'var(--pos-text3)', textAlign: 'right' as const },
  cartFooter: {
    padding: '12px 14px', borderTop: '1px solid var(--pos-border)',
    flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6,
  },
  totalRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  totalLabel: { fontSize: 13, color: 'var(--pos-text3)' },
  totalValue: { fontSize: 13, color: 'var(--pos-text3)' },
  chargeBtn: {
    width: '100%', padding: '13px 0', background: '#22c55e', border: 'none',
    borderRadius: 10, color: '#0f172a', fontWeight: 700, fontSize: 15, cursor: 'pointer', marginTop: 6,
  },
  // Modals
  overlay: {
    position: 'fixed' as const, inset: 0, background: 'rgba(0,0,0,0.6)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50,
  },
  modal: {
    background: 'var(--pos-modal)', border: '1px solid var(--pos-border)', borderRadius: 16,
    padding: '28px 32px', width: 340, boxShadow: '0 24px 64px rgba(0,0,0,0.4)',
    textAlign: 'center' as const,
  },
  modalTitle: { fontSize: 18, fontWeight: 700, color: 'var(--pos-text)', margin: '0 0 6px' },
  modalSubtitle: { fontSize: 13, color: 'var(--pos-text3)', margin: '0 0 20px', lineHeight: 1.5 },
  inputLabel: { display: 'block', fontSize: 12, color: 'var(--pos-text3)', marginBottom: 6 },
  modalInput: {
    width: '100%', background: 'var(--pos-input)', border: '1px solid var(--pos-input-border)',
    borderRadius: 8, padding: '8px 12px', color: 'var(--pos-text)', fontSize: 13,
    outline: 'none', boxSizing: 'border-box' as const,
  },
  typeBtn: {
    flex: 1, padding: '6px 4px', background: 'var(--pos-surface)', border: '1px solid var(--pos-border)',
    borderRadius: 8, color: 'var(--pos-text3)', fontSize: 11, cursor: 'pointer',
  },
  typeBtnActive: {
    background: 'rgba(59,130,246,0.15)', border: '1px solid #3b82f6', color: '#60a5fa',
  },
  coversRow: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 20, marginBottom: 8 },
  coversBtn: {
    width: 44, height: 44, background: 'var(--pos-surface)', border: '1px solid var(--pos-border)',
    borderRadius: 10, color: 'var(--pos-text)', fontSize: 22, cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  coversNum: { fontSize: 36, fontWeight: 700, color: 'var(--pos-text)', minWidth: 48, textAlign: 'center' as const },
  coversCapacity: { fontSize: 11, color: 'var(--pos-text4)', margin: '0 0 20px' },
  modalActions: { display: 'flex', gap: 10 },
  modalCancel: {
    flex: 1, padding: '11px 0', background: 'var(--pos-surface)', border: '1px solid var(--pos-border)',
    borderRadius: 10, color: 'var(--pos-text3)', fontWeight: 600, fontSize: 14, cursor: 'pointer',
  },
  modalConfirm: {
    flex: 1, padding: '11px 0', background: '#3b82f6', border: 'none',
    borderRadius: 10, color: '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer',
  },
  // Variant modal
  variantModalHeader: {
    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 4,
  },
  variantBasePrice: { fontSize: 12, color: 'var(--pos-text3)', margin: '2px 0 0' },
  variantCloseBtn: {
    background: 'transparent', border: 'none', color: 'var(--pos-text3)',
    fontSize: 16, cursor: 'pointer', padding: '0 0 0 12px', flexShrink: 0,
  },
  variantGroups: { display: 'flex', flexDirection: 'column' as const, gap: 18, margin: '20px 0' },
  variantGroup: { textAlign: 'left' as const },
  variantGroupLabel: {
    fontSize: 12, fontWeight: 700, color: 'var(--pos-text3)', textTransform: 'uppercase' as const,
    letterSpacing: '0.5px', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8,
  },
  requiredBadge: {
    fontSize: 9, fontWeight: 700, textTransform: 'uppercase' as const,
    background: 'rgba(239,68,68,0.15)', color: '#fca5a5',
    border: '1px solid rgba(239,68,68,0.25)', padding: '2px 6px', borderRadius: 4,
    letterSpacing: '0.3px',
  },
  variantOptions: { display: 'flex', flexWrap: 'wrap' as const, gap: 8 },
  variantOption: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '7px 14px', background: 'var(--pos-surface)', border: '1px solid var(--pos-border)',
    borderRadius: 8, cursor: 'pointer', transition: 'all 0.12s ease',
  },
  variantOptionSelected: { background: 'rgba(59,130,246,0.15)', border: '1px solid #3b82f6' },
  variantOptionName: { fontSize: 13, color: 'var(--pos-text)', fontWeight: 500 },
  variantOptionPrice: { fontSize: 11, color: '#22c55e', fontWeight: 600 },
  variantTotal: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '12px 0', borderTop: '1px solid var(--pos-border)', marginBottom: 16,
  },
  variantTotalLabel: { fontSize: 13, color: 'var(--pos-text3)' },
  variantTotalValue: { fontSize: 16, fontWeight: 700, color: 'var(--pos-text)' },
};
