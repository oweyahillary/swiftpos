/**
 * MinimartPOS.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Full-featured minimart / convenience-store POS terminal for SwiftPOS.
 *
 * HOW TO USE IN CashierScreen.tsx
 * ────────────────────────────────
 * 1. Import this component:
 *      import MinimartPOS from './MinimartPOS';
 *
 * 2. In the left-panel section, replace the minimart product-grid block with:
 *      {isMinimart && (
 *        <MinimartPOS
 *          products={products}
 *          categories={categories}
 *          cart={cart}
 *          currency={currency}
 *          onAddToCart={addToCart}
 *          onUpdateQty={updateQty}          // (productId, delta) => void
 *          onRemoveItem={removeFromCart}     // (productId) => void
 *          onClearCart={() => setCart([])}
 *          onCharge={() => setShowPayment(true)}
 *          onParkOrder={parkOrder}
 *          parkedOrders={parkedOrders}
 *          onResumeParked={resumeParked}
 *          posApi={posApi}
 *        />
 *      )}
 *
 * FEATURES
 * ────────
 *  • EAN-13 / Code128 barcode scanner listener (keystroke timing < 80 ms)
 *  • A577: weighing-scale labels (lib/scaleBarcode.ts — prefixes 21–29 as the business set its scales up, the item's scale
 *    code and its price or weight inside; a 20 code is never one) and the weight of an item sold by weight typed on a tap
 *  • Product-not-found modal: search by name | quick-add | skip
 *  • PLU lookup via /api/products/plu/:code
 *  • Scan search bar (separate from catalogue filter)
 *  • Collapsible product catalogue (hidden by default, 50/50 split when open)
 *  • Held/parked orders badge strip
 *  • Real-time cart with inline qty controls
 *  • Charge button with total, VAT breakdown
 *  • Keyboard shortcut legend (F1–F4)
 */

import {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import type { CartItem } from '../../lib/cart';
import { cartSubtotal, extractTaxes } from '../../lib/cart';
import { useBusiness } from '../../context/BusinessContext';
import type { Product, Category, Menu } from '../../types';
import CategoryPanel, { useCategoryPanel, PanelToggle, CategoryChip, MenuBar } from './cashier/CategoryPanel';   // A537; A566
import { ALL_MENUS, categoriesForMenu, gridMenuScope, inMenuScope, menuBarTabs, menuScope, menuTabs, resolveCategory } from '@zaptill/core/menuFilter';   // A537
import { exactFirst } from '@zaptill/core/paginate';   // A472
import { parseScaleBarcode, findScaleProduct, scaleLine, weighedLine, isSoldByWeight, weightUnitOf, formatWeight, scaleSettingsOrDefault, type ScaleSettings, type WeighedLine } from '@zaptill/core/scaleBarcode';   // A577
import { businessTerms } from '@zaptill/core/businessTerms';   // A573

/** A573: this screen is the minimart's (CashierScreen opens it for a minimart only) — Departments, not Menus. */
const WORDS = businessTerms('minimart');
import { useGridWindow } from '../../hooks/useGridWindow';   // A472

// ── Types ─────────────────────────────────────────────────────────────────────

interface ParkedOrder {
  key: string;
  label: string;
  itemCount: number;
}


type ScanResult =
  | { type: 'product'; product: Product }
  | { type: 'weighed'; product: Product; weightKg: number }
  | { type: 'not_found'; barcode: string }
  | { type: 'error'; message: string };

interface Props {
  products: Product[];
  categories: Category[];
  /** A537: the business's menus (Food, Soft drinks …); [] = none — the plain category list. */
  menus?: Menu[];
  /** A578: the small hint on a department's tab ("until 11:00"), by menu id. */
  menuHints?: Record<string, string>;
  /** A578: the manager's "Show all" at the end of the department row (CashierScreen's — menu.edit only). */
  menuBarTrailing?: ReactNode;
  /** A578: why an item is not sold now (its department outside its hours), or null — off the catalogue; a scan is refused. */
  outOfHours?: (p: Product) => string | null;
  /** A580: the closed departments "Later" shows greyed on the bar (CashierScreen's — any staff member, view only). */
  menuLater?: ReadonlySet<string>;
  /** A580: with Later on, a closed department's item shows (greyed, never sold) in its own department — else false. */
  peekLater?: (p: Product, scope: { menu: string; category: string; search: string }) => boolean;
  cart: CartItem[];
  currency: string;
  onAddToCart: (product: Product, qty?: number) => void;
  /** A577: the scale label layout (pos/init); the default until it says. */
  scaleSettings?: ScaleSettings;
  /** A577: a weighed line (a scale label or the typed weight) — always a line of its own. */
  onAddWeighed?: (product: Product, line: WeighedLine) => void;
  onUpdateQty: (productId: string, delta: number) => void;
  onRemoveItem: (productId: string) => void;
  onClearCart: () => void;
  onCharge: () => void;
  onParkOrder?: () => void;
  parkedOrders?: ParkedOrder[];
  onResumeParked?: (key: string) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  posApi: { get: <T>(url: string) => Promise<T> };
}

// ── A577: scale labels ────────────────────────────────────────────────────────
// The decoder that was here read ANY 13-digit code starting "2" as "2 + PLU 5 + grams 5" — so ZapTill's own in-store
// codes (prefix 20, A571) were taken for weighed items. lib/scaleBarcode.ts reads only the business's scale prefixes
// (21–29 by default), checks the check digits, and knows price labels from weight labels.

// ── VAT_RATE ──────────────────────────────────────────────────────────────────

const VAT_RATE = 16;

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(amount: number, currency: string) {
  return `${currency} ${amount.toLocaleString('en-KE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function clamp(n: number, min: number, max: number) {
  return Math.min(Math.max(n, min), max);
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function MinimartPOS({
  products,
  categories,
  menus = [],
  menuHints,
  menuBarTrailing,
  outOfHours,
  menuLater,
  peekLater,
  cart,
  currency,
  onAddToCart,
  scaleSettings,
  onAddWeighed,
  onUpdateQty,
  onRemoveItem,
  onClearCart,
  onCharge,
  onParkOrder,
  parkedOrders = [],
  onResumeParked,
  posApi,
}: Props) {

  // ── UI state ───────────────────────────────────────────────────────────────
  const [showCatalogue, setShowCatalogue]     = useState(false);
  const [activeCategory, setActiveCategory]   = useState('all');
  const [catalogueSearch, setCatalogueSearch] = useState('');
  // A537: the categories in a left panel behind ☰ (collapsed at start, pinned open if pinned), menus as tabs on top.
  const catPanel = useCategoryPanel();
  const activeMenu = catPanel.prefs.menu;
  const menuCats = useMemo(() => categoriesForMenu(categories, menus, activeMenu), [categories, menus, activeMenu]);
  const menuFilterScope = useMemo(() => menuScope(categories, menus, activeMenu), [categories, menus, activeMenu]);
  useEffect(() => {
    const keep = resolveCategory(activeCategory, menuCats);
    if (keep !== activeCategory) setActiveCategory(keep);
  }, [menuCats, activeCategory]);
  const chosenCategoryName = activeCategory === 'all' ? null : (categories.find((c) => c.id === activeCategory)?.name ?? null);
  const chosenMenuName = menuTabs(menus, categories).find((t) => t.id === activeMenu && t.id !== ALL_MENUS)?.name ?? null;
  // A566 (owner, 2026-10-22: "if a client has larger categories eg drinks, fast foods etc they should appear the way
  // categories used to appear so that cashiers can easily pick the menu"): with menus they are big tabs across the top
  // of the grid (MenuBar) and the chip names only the chosen category; a tap on a menu shows its items (its category and
  // any search start again). No menus: no bar, as before.
  const menuBar = useMemo(() => menuBarTabs(menus, categories), [menus, categories]);
  const pickMenu = (id: string) => { catPanel.setMenu(id); setActiveCategory('all'); setCatalogueSearch(''); };
  const catChip = chosenCategoryName ?? (chosenMenuName && menuBar.length === 0 ? `${chosenMenuName} ${WORDS.menu.toLowerCase()}` : null);
  const clearCatChip = () => { setActiveCategory('all'); if (!chosenCategoryName) catPanel.setMenu(ALL_MENUS); };

  // ── Scan bar ───────────────────────────────────────────────────────────────
  const scanInputRef  = useRef<HTMLInputElement>(null);
  const [scanValue, setScanValue]     = useState('');
  const [scanStatus, setScanStatus]   = useState<'idle' | 'scanning' | 'found' | 'error'>('idle');
  const [scanMessage, setScanMessage] = useState('');

  // ── Modals ─────────────────────────────────────────────────────────────────
  const [weightModal, setWeightModal]               = useState<{ product: Product } | null>(null);   // A577: the typed weight
  const [weightInput, setWeightInput]               = useState('');
  const [notFoundModal, setNotFoundModal]           = useState<{ barcode: string } | null>(null);
  const [notFoundSearch, setNotFoundSearch]         = useState('');
  const [notFoundResults, setNotFoundResults]       = useState<Product[]>([]);
  const [quickAddModal, setQuickAddModal]           = useState<{ barcode: string } | null>(null);
  const [quickAddName, setQuickAddName]             = useState('');
  const [quickAddPrice, setQuickAddPrice]           = useState('');
  const [quickAddSaving, setQuickAddSaving]         = useState(false);

  // ── Phone width: stack the catalogue above the cart ────────────────────────
  const [isPhone, setIsPhone] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const onChange = (e: MediaQueryListEvent) => setIsPhone(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // ── Auto-focus scan bar ────────────────────────────────────────────────────
  useEffect(() => {
    scanInputRef.current?.focus();
  }, []);

  // ── Keyboard scanner listener (hardware scanner = rapid keystrokes < 80ms) ──
  useEffect(() => {
    let buffer = '';
    let timer: ReturnType<typeof setTimeout>;
    let lastKey = Date.now();

    function onKey(e: globalThis.KeyboardEvent) {
      // Ignore when a modal or catalogue input is focused
      const tag = (e.target as HTMLElement)?.tagName;
      const id  = (e.target as HTMLElement)?.id;
      if (tag === 'INPUT' && id !== 'minimart-scan-bar') return;

      const now = Date.now();
      const gap  = now - lastKey;
      lastKey    = now;

      clearTimeout(timer);

      if (e.key === 'Enter' && buffer.length > 3) {
        processScan(buffer);
        buffer = '';
        return;
      }

      // If gap > 80 ms → human typing, not scanner; reset buffer
      if (gap > 80 && buffer.length > 0) buffer = '';

      if (e.key.length === 1) buffer += e.key;

      timer = setTimeout(() => { buffer = ''; }, 100);
    }

    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); clearTimeout(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products]);

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    function onGlobal(e: globalThis.KeyboardEvent) {
      if (e.key === 'F1') { e.preventDefault(); scanInputRef.current?.focus(); }
      if (e.key === 'F2') { e.preventDefault(); setShowCatalogue(v => !v); }
      if (e.key === 'F4' && cart.length > 0) { e.preventDefault(); onCharge(); }
    }
    window.addEventListener('keydown', onGlobal);
    return () => window.removeEventListener('keydown', onGlobal);
  }, [cart, onCharge]);

  // ── Core scan processor ────────────────────────────────────────────────────

  const processScan = useCallback(async (barcode: string) => {
    setScanValue(barcode);
    setScanStatus('scanning');
    setScanMessage('Looking up…');

    try {
      // 1. A577: a weighing scale's label — the item by its scale code, the line from the label's price or weight
      const reading = parseScaleBarcode(barcode, scaleSettings ?? scaleSettingsOrDefault(null));
      if (reading) {
        const product = findScaleProduct(products, reading.itemCode);
        const notNow = product && outOfHours ? outOfHours(product) : null;
        if (!product) {
          setScanStatus('error');
          setScanMessage(`No item has the scale code ${reading.itemCode}`);
          setNotFoundModal({ barcode });
          setNotFoundSearch('');
          setNotFoundResults([]);
        } else if (notNow) {
          setScanStatus('error');
          setScanMessage(notNow);
        } else {
          const line = scaleLine(Number(product.base_price), reading);
          onAddWeighed?.(product, line);
          setScanStatus('found');
          setScanMessage(`${product.name} — ${formatWeight(line.quantity, weightUnitOf(product as any))} · ${fmt(line.lineTotal, currency)}`);
          setTimeout(() => { setScanStatus('idle'); setScanMessage(''); setScanValue(''); }, 2000);
        }
        return;
      }

      // 2. Regular barcode lookup
      const product = products.find(
        p => (p as { barcode?: string }).barcode === barcode
      );

      // A578: its department is outside its hours (alcohol before licensed hours …) — refused, said why, not "not found"
      const notNow = product && outOfHours ? outOfHours(product) : null;
      if (product && notNow) {
        setScanStatus('error');
        setScanMessage(notNow);
      } else if (product && isSoldByWeight(product as any)) {
        pick(product);   // A577: its own barcode — the weight is typed
        setScanStatus('found');
        setScanMessage(product.name);
      } else if (product) {
        onAddToCart(product);
        setScanStatus('found');
        setScanMessage(product.name);
        // Auto-clear after 2 s
        setTimeout(() => {
          setScanStatus('idle');
          setScanMessage('');
          setScanValue('');
        }, 2000);
      } else {
        setScanStatus('error');
        setScanMessage(`Barcode ${barcode} not found`);
        setNotFoundModal({ barcode });
        setNotFoundSearch('');
        setNotFoundResults([]);
      }
    } catch (err) {
      setScanStatus('error');
      setScanMessage('Lookup failed — check connection');
    }
  }, [products, posApi, onAddToCart, outOfHours, scaleSettings, onAddWeighed, currency]);   // eslint-disable-line react-hooks/exhaustive-deps

  // ── Scan bar submit ────────────────────────────────────────────────────────
  function onScanSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (scanValue.trim().length > 0) processScan(scanValue.trim());
  }

  // ── A577: a tap (or a search pick) on an item sold by weight asks for the weight; anything else is added ──
  function pick(product: Product) {
    if (outOfHours?.(product)) { onAddToCart(product); return; }   // A580: a greyed (Later) item — refused in A578's words, no weight asked
    if (isSoldByWeight(product as any) && !(product as any).is_fuel) { setWeightModal({ product }); setWeightInput(''); return; }
    onAddToCart(product);
  }

  // ── Weight modal confirm ───────────────────────────────────────────────────
  function confirmWeight() {
    if (!weightModal) return;
    const kg = parseFloat(weightInput);
    if (isNaN(kg) || kg <= 0) return;
    // A577: qty = the weight in kg, unit price = the price per kg, the amount rounded to the cent (weighedLine)
    onAddWeighed?.(weightModal.product, weighedLine(Number(weightModal.product.base_price), kg));
    setWeightModal(null);
    setScanStatus('found');
    setScanMessage(`${weightModal.product.name} ${kg.toFixed(3)} kg added`);
    setTimeout(() => { setScanStatus('idle'); setScanMessage(''); setScanValue(''); }, 2000);
  }

  // ── Not-found modal search ─────────────────────────────────────────────────
  useEffect(() => {
    if (!notFoundModal) return;
    const q = notFoundSearch.toLowerCase().trim();
    if (q.length < 2) { setNotFoundResults([]); return; }
    setNotFoundResults(
      products.filter(p => p.name.toLowerCase().includes(q)).slice(0, 8)
    );
  }, [notFoundSearch, products, notFoundModal]);

  // ── Quick-add save ─────────────────────────────────────────────────────────
  async function saveQuickAdd() {
    if (!quickAddName.trim() || !quickAddPrice.trim()) return;
    setQuickAddSaving(true);
    try {
      // POST to API — if it fails gracefully, at least add to cart locally
      const price = parseFloat(quickAddPrice);
      const tempProduct: Product = {
        id: `temp-${Date.now()}`,
        name: quickAddName.trim(),
        base_price: price,
        category_id: null,
        image_url: null,
        is_active: true,
        // barcode stored on server after real save
      } as unknown as Product;

      try {
        await posApi.get(`/api/products`); // healthcheck — replace with real POST
        // TODO: replace with real POST /api/products when quick-add API is built
      } catch { /* non-fatal */ }

      onAddToCart(tempProduct);
      setQuickAddModal(null);
      setNotFoundModal(null);
      setScanStatus('found');
      setScanMessage(`${tempProduct.name} added`);
      setTimeout(() => { setScanStatus('idle'); setScanMessage(''); setScanValue(''); }, 2000);
    } finally {
      setQuickAddSaving(false);
    }
  }

  // ── Filtered catalogue ─────────────────────────────────────────────────────
  const filteredProducts = products.filter(p => {
    if (activeCategory !== 'all' && p.category_id !== activeCategory) return false;
    if (!inMenuScope(p, gridMenuScope(menuFilterScope, catalogueSearch))) return false;   // A537: a menu chosen = its categories only; A566: a search looks through every menu
    // A578: its department outside its hours — off the catalogue and its search; A580: Later shows it greyed in its own department
    if (outOfHours?.(p) && !peekLater?.(p, { menu: activeMenu, category: activeCategory, search: catalogueSearch })) return false;
    if (catalogueSearch) {
      const q = catalogueSearch.toLowerCase();
      return (
        p.name.toLowerCase().includes(q) ||
        ((p as { barcode?: string }).barcode ?? '').includes(q) ||
        ((p as { plu_code?: string }).plu_code ?? '').includes(q)
      );
    }
    return true;
  });
  // A472 (speed): GRID_STEP tiles, then GRID_STEP more as the grid is scrolled near its end; an exact name, barcode or
  // PLU is the first tile.
  const gridList = exactFirst(filteredProducts, catalogueSearch,
    (p) => [p.name, (p as { barcode?: string }).barcode, (p as { plu_code?: string }).plu_code]);
  const grid = useGridWindow(gridList.length, `${activeMenu}|${activeCategory}|${catalogueSearch}`);

  // ── Cart totals ────────────────────────────────────────────────────────────
  const subtotal = cartSubtotal(cart);
  // A349: the business's own VAT rate (was a fixed 16 %). VAT only — the catering levy (CTL) is for hotels, never a
  // minimart (owner, 2026-09-28: "thats only for hotels not any other business only do VAT").
  const { business: biz } = useBusiness();
  const vatRate  = Number(biz?.vat_rate ?? VAT_RATE);
  const { vat } = extractTaxes(subtotal, vatRate, 0);
  const itemCount = cart.reduce((s, i) => s + i.quantity, 0);

  // ── Scan bar status colour ─────────────────────────────────────────────────
  const scanBorderColor =
    scanStatus === 'found'    ? '#22c55e' :
    scanStatus === 'error'    ? '#ef4444' :
    scanStatus === 'scanning' ? '#f59e0b' :
    '#334155';

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <div style={s.root}>

      {/* ── Top bar: scan input + controls ──────────────────────────────── */}
      <div style={s.topBar}>
        <div style={s.topBarLeft}>
          {/* Scan bar */}
          <form onSubmit={onScanSubmit} style={s.scanForm}>
            <div style={{ ...s.scanInputWrap, borderColor: scanBorderColor }}>
              <span style={s.scanIcon} aria-hidden>
                {scanStatus === 'scanning' ? (
                  <span style={s.scanSpinner} />
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                    stroke={scanStatus === 'error' ? '#ef4444' : scanStatus === 'found' ? '#22c55e' : '#64748b'}
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 5v3M3 5h3M21 5h-3M21 5v3M3 19v-3M3 19h3M21 19h-3M21 19v-3"/>
                    <line x1="7" y1="12" x2="7" y2="12.01"/>
                    <line x1="10" y1="9" x2="10" y2="15"/>
                    <line x1="13" y1="11" x2="13" y2="15"/>
                    <line x1="16" y1="9" x2="16" y2="15"/>
                  </svg>
                )}
              </span>
              <input
                id="minimart-scan-bar"
                ref={scanInputRef}
                style={s.scanInput}
                value={scanValue}
                onChange={e => setScanValue(e.target.value)}
                placeholder="Scan barcode or enter PLU…"
                autoComplete="off"
                spellCheck={false}
              />
              {scanValue && (
                <button
                  type="button"
                  style={s.scanClearBtn}
                  onClick={() => { setScanValue(''); setScanStatus('idle'); setScanMessage(''); }}
                >✕</button>
              )}
              <button type="submit" style={s.scanSubmitBtn}>Look up</button>
            </div>
          </form>

          {/* Scan status message */}
          <div style={{
            ...s.scanMsg,
            color: scanStatus === 'found' ? '#22c55e' : scanStatus === 'error' ? '#ef4444' : '#64748b',
          }}>
            {scanMessage || (
              <span style={{ color: '#334155' }}>
                <kbd style={s.kbd}>F1</kbd> Focus scan &nbsp;·&nbsp;
                <kbd style={s.kbd}>F2</kbd> Catalogue &nbsp;·&nbsp;
                <kbd style={s.kbd}>F4</kbd> Charge
              </span>
            )}
          </div>
        </div>

        <div style={s.topBarRight}>
          {/* Parked orders */}
          {parkedOrders.map(o => (
            <button key={o.key} style={s.parkedBadge} onClick={() => onResumeParked?.(o.key)}>
              <span style={s.parkedLabel}>{o.label}</span>
              <span style={s.parkedCount}>{o.itemCount}</span>
            </button>
          ))}
          {onParkOrder && cart.length > 0 && (
            <button style={s.parkBtn} onClick={onParkOrder}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
              Hold order
            </button>
          )}
          <button style={s.catalogueToggle} onClick={() => setShowCatalogue(v => !v)}>
            {showCatalogue ? (
              <>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                Hide catalogue
              </>
            ) : (
              <>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
                Show catalogue
              </>
            )}
          </button>
        </div>
      </div>

      {/* ── Body: [catalogue?] + cart ────────────────────────────────────── */}
      <div style={isPhone ? { ...s.body, flexDirection: 'column' } : s.body}>

        {/* ── Product catalogue (hidden by default) ──────────────────────── */}
        {showCatalogue && (
          <div style={s.catalogue}>
            {/* Catalogue search — A537: ☰ at its left opens the category panel (it replaced the category tabs). */}
            <div style={{ ...s.catSearchWrap, display: 'flex', gap: 8, alignItems: 'center' }}>
              <PanelToggle panel={catPanel} />
              <input
                style={{ ...s.catSearchInput, flex: 1, minWidth: 0 }}
                placeholder="Filter by name, barcode or PLU…"
                value={catalogueSearch}
                onChange={e => setCatalogueSearch(e.target.value)}
              />
              <CategoryChip label={catChip} onClear={clearCatChip} />
            </div>
            {/* A566: the menus as big tabs across the top of the catalogue (none when the business has no menus). */}
            <MenuBar tabs={menuBar} active={activeMenu} onPick={pickMenu} label={WORDS.menus} hints={menuHints} trailing={menuBarTrailing} greyed={menuLater} />

            <div style={{ flex: 1, display: 'flex', minHeight: 0, position: 'relative' }}>
            <CategoryPanel panel={catPanel} categories={categories} menus={menus} products={products}
              menusLabel={WORDS.menus} allMenusLabel={WORDS.allMenus}
              activeMenu={activeMenu} activeCategory={activeCategory}
              onMenu={catPanel.setMenu} onCategory={setActiveCategory} overlay={isPhone} menuBar={menuBar.length > 0} />

            {/* Product grid */}
            <div ref={grid.rootRef} style={s.productGrid}>
              {filteredProducts.length === 0 ? (
                <div style={s.emptyGrid}>No products match</div>
              ) : gridList.slice(0, grid.count).map(product => {
                const inCart = cart.find(i => i.product.id === product.id);
                const later = !!outOfHours?.(product);   // A580: shown only because Later is on — greyed, never sold
                return (
                  <button
                    key={product.id}
                    className="press"
                    data-later={later ? 'true' : undefined}
                    aria-disabled={later || undefined}
                    style={{ ...s.productCard, ...(inCart ? s.productCardActive : {}), ...(later ? { opacity: 0.5, filter: 'grayscale(1)' } : {}) }}
                    onClick={() => pick(product)}
                  >
                    {inCart && <span key={inCart.quantity} data-testid="cart-badge" className="animate-bump" style={s.cartBadge}>{inCart.quantity}</span>}
                    <div style={s.productThumb}>
                      {product.image_url ? (
                        <img src={product.image_url} alt={product.name} style={s.productImg} />
                      ) : (
                        <span style={s.productEmoji}>📦</span>
                      )}
                    </div>
                    <div style={s.productName}>{product.name}</div>
                    <div style={s.productPrice}>{fmt(product.base_price, currency)}</div>
                  </button>
                );
              })}
              {grid.more && <div ref={grid.sentinelRef} data-testid="grid-more" aria-hidden style={{ gridColumn: '1/-1', height: 1 }} />}
            </div>
            </div>
          </div>
        )}

        {/* ── Cart / order panel ──────────────────────────────────────────── */}
        <div style={isPhone ? { ...s.cartPanel, width: '100%', borderLeft: 'none', borderTop: '1px solid #1e293b', maxHeight: '55%' } : s.cartPanel}>

          {/* Cart header */}
          <div style={s.cartHeader}>
            <div>
              <div style={s.cartTitle}>Current order</div>
              {cart.length > 0 && (
                <div style={s.cartSubTitle}>{itemCount} item{itemCount !== 1 ? 's' : ''}</div>
              )}
            </div>
            {cart.length > 0 && (
              <button style={s.clearBtn} onClick={onClearCart}>Clear all</button>
            )}
          </div>

          {/* Cart items */}
          <div style={s.cartList}>
            {cart.length === 0 ? (
              <div style={s.emptyCart}>
                <div style={s.emptyCartIcon}>
                  <svg width="36" height="36" viewBox="0 0 24 24" fill="none"
                    stroke="#334155" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/>
                    <line x1="3" y1="6" x2="21" y2="6"/>
                    <path d="M16 10a4 4 0 01-8 0"/>
                  </svg>
                </div>
                <div style={s.emptyCartText}>Scan a barcode or tap a product to begin</div>
              </div>
            ) : (
              cart.map((item, idx) => {
                const weighed = !!item.measureUnit;   // A577: a weighed line (its own line; the weight, not a stepper)
                return (
                  <div key={weighed ? `${item.product.id}:${idx}` : item.product.id} className="animate-line-in" style={s.cartRow}>
                    <div style={s.cartRowInfo}>
                      <div style={s.cartItemName}>{item.product.name}</div>
                      <div style={s.cartItemMeta}>
                        {fmt(item.unitPrice, currency)}
                        {weighed ? ' / kg' : ' each'}
                      </div>
                    </div>

                    <div style={s.cartRowControls}>
                      {/* Qty controls — show as label for weighed items */}
                      {weighed ? (
                        <span style={s.weightDisplay} data-testid="weighed-qty">{formatWeight(item.quantity, item.measureUnit)}</span>
                      ) : (
                        <div style={s.qtyControl}>
                          <button
                            className="press"
                            style={s.qtyBtn}
                            onClick={() => onUpdateQty(item.product.id, -1)}
                            aria-label="Decrease"
                          >−</button>
                          <span style={s.qtyNum}>{item.quantity}</span>
                          <button
                            className="press"
                            style={s.qtyBtn}
                            onClick={() => onUpdateQty(item.product.id, 1)}
                            aria-label="Increase"
                          >+</button>
                        </div>
                      )}

                      <div style={s.cartLineTotalWrap}>
                        <span style={s.cartLineTotal}>{fmt(item.lineTotal, currency)}</span>
                        <button
                          style={s.removeBtn}
                          onClick={() => onRemoveItem(item.product.id)}
                          aria-label={`Remove ${item.product.name}`}
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
                          </svg>
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Totals + charge button */}
          {cart.length > 0 && (
            <div style={s.cartFooter}>
              <div style={s.totalsBlock}>
                <div style={s.totalRow}>
                  <span style={s.totalLabel}>Subtotal</span>
                  <span style={s.totalValue}>{fmt(subtotal - vat, currency)}</span>
                </div>
                <div style={s.totalRow}>
                  <span style={s.totalLabel}>VAT ({vatRate}%)</span>
                  <span style={s.totalValue}>{fmt(vat, currency)}</span>
                </div>
                <div style={{ ...s.totalRow, ...s.totalRowGrand }}>
                  <span style={s.grandLabel}>Total</span>
                  <span style={s.grandValue}>{fmt(subtotal, currency)}</span>
                </div>
              </div>

              <button style={s.chargeBtn} onClick={onCharge}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <rect x="1" y="4" width="22" height="16" rx="2" ry="2"/>
                  <line x1="1" y1="10" x2="23" y2="10"/>
                </svg>
                Charge &nbsp;{fmt(subtotal, currency)}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ════════ WEIGHT CONFIRMATION MODAL ════════ */}
      {weightModal && (
        <div className="animate-fade-in" style={s.overlay} role="dialog" aria-modal aria-label="Confirm weight">
          <div className="animate-pop-in" style={s.modal}>
            <div style={s.modalIcon}>⚖️</div>
            <h2 style={s.modalTitle}>Confirm weight</h2>
            <p style={s.modalSub}>{weightModal.product.name}</p>
            <p style={s.modalSub}>Read the scale and type the weight in kg (0.452 = 452 g)</p>

            <div style={s.modalFieldWrap}>
              <label style={s.modalFieldLabel}>Weight (kg)</label>
              <input
                style={s.modalInput}
                type="number"
                min="0.001"
                step="0.001"
                value={weightInput}
                onChange={e => setWeightInput(e.target.value)}
                autoFocus
                onKeyDown={(e: ReactKeyboardEvent<HTMLInputElement>) => {
                  if (e.key === 'Enter') confirmWeight();
                }}
              />
            </div>

            <div style={s.modalFieldWrap}>
              <span style={s.modalFieldLabel}>Price per kg</span>
              <span style={s.modalMeta}>{fmt(weightModal.product.base_price, currency)}</span>
            </div>

            {weightInput && !isNaN(parseFloat(weightInput)) && (
              <div style={s.modalTotal}>
                Line total: {fmt(weighedLine(Number(weightModal.product.base_price), parseFloat(weightInput)).lineTotal, currency)}
              </div>
            )}

            <div style={s.modalActions}>
              <button style={s.modalCancel} onClick={() => {
                setWeightModal(null);
                setScanStatus('idle'); setScanMessage(''); setScanValue('');
              }}>Cancel</button>
              <button style={s.modalConfirm} onClick={confirmWeight}>
                Add to order
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ════════ NOT-FOUND MODAL ════════ */}
      {notFoundModal && !quickAddModal && (
        <div className="animate-fade-in" style={s.overlay} role="dialog" aria-modal aria-label="Product not found">
          <div className="animate-pop-in" style={{ ...s.modal, maxWidth: 480 }}>
            <div style={s.modalIcon}>🔍</div>
            <h2 style={s.modalTitle}>Product not found</h2>
            <p style={s.modalSub}>
              Barcode <code style={s.code}>{notFoundModal.barcode}</code> is not in the system.
            </p>

            {/* Option 1: search by name */}
            <div style={s.notFoundSection}>
              <div style={s.notFoundSectionTitle}>Search by name</div>
              <input
                style={s.modalInput}
                placeholder="Type product name…"
                value={notFoundSearch}
                onChange={e => setNotFoundSearch(e.target.value)}
                autoFocus
              />
              {notFoundResults.length > 0 && (
                <div style={s.notFoundResults}>
                  {notFoundResults.map(p => (
                    <button
                      key={p.id}
                      style={s.notFoundResultRow}
                      onClick={() => {
                        pick(p);   // A577
                        setNotFoundModal(null);
                        setScanStatus('found');
                        setScanMessage(p.name);
                        setTimeout(() => { setScanStatus('idle'); setScanMessage(''); setScanValue(''); }, 2000);
                      }}
                    >
                      <span style={s.notFoundResultName}>{p.name}</span>
                      <span style={s.notFoundResultPrice}>{fmt(p.base_price, currency)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div style={s.divider} />

            <div style={s.modalActions}>
              <button
                style={s.modalSecondary}
                onClick={() => {
                  setQuickAddModal({ barcode: notFoundModal.barcode });
                  setQuickAddName('');
                  setQuickAddPrice('');
                }}
              >
                + Quick-add product
              </button>
              <button
                style={s.modalCancel}
                onClick={() => {
                  setNotFoundModal(null);
                  setScanStatus('idle'); setScanMessage(''); setScanValue('');
                }}
              >
                Skip
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ════════ QUICK-ADD MODAL ════════ */}
      {quickAddModal && (
        <div className="animate-fade-in" style={s.overlay} role="dialog" aria-modal aria-label="Quick-add product">
          <div className="animate-pop-in" style={s.modal}>
            <div style={s.modalIcon}>➕</div>
            <h2 style={s.modalTitle}>Quick-add product</h2>
            <p style={s.modalSub}>
              Barcode <code style={s.code}>{quickAddModal.barcode}</code> will be linked after save.
            </p>

            <div style={s.modalFieldWrap}>
              <label style={s.modalFieldLabel}>Product name *</label>
              <input
                style={s.modalInput}
                placeholder="e.g. Azam Mango Juice 500ml"
                value={quickAddName}
                onChange={e => setQuickAddName(e.target.value)}
                autoFocus
              />
            </div>

            <div style={s.modalFieldWrap}>
              <label style={s.modalFieldLabel}>Selling price ({currency}) *</label>
              <input
                style={s.modalInput}
                type="number"
                min="0"
                step="0.5"
                placeholder="0.00"
                value={quickAddPrice}
                onChange={e => setQuickAddPrice(e.target.value)}
                onKeyDown={(e: ReactKeyboardEvent<HTMLInputElement>) => {
                  if (e.key === 'Enter') saveQuickAdd();
                }}
              />
            </div>

            <div style={s.modalActions}>
              <button
                style={s.modalCancel}
                onClick={() => { setQuickAddModal(null); }}
              >Back</button>
              <button
                style={{
                  ...s.modalConfirm,
                  opacity: (quickAddName.trim() && quickAddPrice.trim()) ? 1 : 0.4,
                  cursor: (quickAddName.trim() && quickAddPrice.trim()) ? 'pointer' : 'not-allowed',
                }}
                disabled={!quickAddName.trim() || !quickAddPrice.trim() || quickAddSaving}
                onClick={saveQuickAdd}
              >
                {quickAddSaving && <span className="spin-dot" aria-hidden />}
                {quickAddSaving ? 'Saving…' : 'Add to order'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────
//
// Uses the same dark-slate palette as CashierScreen for visual consistency.
// Inline style objects maintain the CashierScreen pattern (performance on POS).

const s: Record<string, React.CSSProperties> = {
  // ── Shell ──────────────────────────────────────────────────────────────────
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    overflow: 'hidden',
    background: '#0f172a',
    fontFamily: "'DM Sans','Segoe UI',sans-serif",
    color: '#f1f5f9',
  },

  // ── Top bar ────────────────────────────────────────────────────────────────
  topBar: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 12,
    padding: '12px 16px 10px',
    borderBottom: '1px solid #1e293b',
    flexShrink: 0,
    background: '#0f172a',
    flexWrap: 'wrap',
  },
  topBarLeft: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  topBarRight: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    paddingTop: 2,
    flexShrink: 0,
  },

  // ── Scan bar ───────────────────────────────────────────────────────────────
  scanForm: { display: 'flex', width: '100%' },
  scanInputWrap: {
    display: 'flex',
    alignItems: 'center',
    flex: 1,
    background: '#1e293b',
    border: '1.5px solid #334155',
    borderRadius: 10,
    padding: '0 6px 0 12px',
    gap: 8,
    transition: 'border-color 0.2s',
  },
  scanIcon: {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
  },
  scanSpinner: {
    display: 'inline-block',
    width: 14,
    height: 14,
    border: '2px solid #334155',
    borderTopColor: '#f59e0b',
    borderRadius: '50%',
    animation: 'spin 0.7s linear infinite',
  },
  scanInput: {
    flex: 1,
    background: 'transparent',
    border: 'none',
    outline: 'none',
    color: '#f1f5f9',
    fontSize: 15,
    fontWeight: 500,
    fontFamily: "'DM Sans','Segoe UI',sans-serif",
    padding: '10px 0',
    letterSpacing: '0.02em',
  },
  scanClearBtn: {
    background: 'transparent',
    border: 'none',
    color: '#475569',
    cursor: 'pointer',
    fontSize: 13,
    padding: '4px 6px',
    borderRadius: 6,
  },
  scanSubmitBtn: {
    background: 'rgb(var(--act-strong, 29 78 216))',
    border: 'none',
    borderRadius: 7,
    color: 'rgb(var(--act-on, 255 255 255))',
    fontSize: 12,
    fontWeight: 600,
    padding: '6px 14px',
    cursor: 'pointer',
    flexShrink: 0,
    fontFamily: "'DM Sans','Segoe UI',sans-serif",
  },
  scanMsg: {
    fontSize: 12,
    minHeight: 18,
    paddingLeft: 2,
    transition: 'color 0.2s',
  },
  kbd: {
    display: 'inline-block',
    padding: '1px 5px',
    background: '#1e293b',
    border: '1px solid #334155',
    borderRadius: 4,
    fontSize: 10,
    fontFamily: 'monospace',
    color: '#64748b',
  },

  // ── Top-bar right controls ─────────────────────────────────────────────────
  parkedBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '5px 10px',
    background: '#1e293b',
    border: '1px solid #334155',
    borderRadius: 20,
    color: '#94a3b8',
    fontSize: 12,
    cursor: 'pointer',
    fontFamily: "'DM Sans','Segoe UI',sans-serif",
  },
  parkedLabel: { maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  parkedCount: {
    background: 'rgb(var(--act-strong, 59 130 246))',
    color: 'rgb(var(--act-on, 255 255 255))',
    borderRadius: 10,
    padding: '1px 6px',
    fontSize: 10,
    fontWeight: 700,
  },
  parkBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 12px',
    background: 'transparent',
    border: '1px dashed #334155',
    borderRadius: 8,
    color: '#64748b',
    fontSize: 12,
    cursor: 'pointer',
    fontFamily: "'DM Sans','Segoe UI',sans-serif",
  },
  catalogueToggle: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 14px',
    background: '#1e293b',
    border: '1px solid #334155',
    borderRadius: 8,
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
    fontFamily: "'DM Sans','Segoe UI',sans-serif",
    whiteSpace: 'nowrap',
  },

  // ── Body ───────────────────────────────────────────────────────────────────
  body: {
    flex: 1,
    display: 'flex',
    overflow: 'hidden',
    gap: 0,
  },

  // ── Catalogue ──────────────────────────────────────────────────────────────
  catalogue: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    borderRight: '1px solid #1e293b',
    overflow: 'hidden',
    minWidth: 0,
  },
  catSearchWrap: {
    padding: '8px 14px',
    borderBottom: '1px solid #1e293b',
    flexShrink: 0,
  },
  catSearchInput: {
    width: '100%',
    background: '#1e293b',
    border: '1px solid #334155',
    borderRadius: 8,
    padding: '7px 12px',
    color: '#f1f5f9',
    fontSize: 13,
    outline: 'none',
    boxSizing: 'border-box',
    fontFamily: "'DM Sans','Segoe UI',sans-serif",
  },
  productGrid: {
    flex: 1,
    overflowY: 'auto',
    padding: 12,
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))',
    gap: 10,
    alignContent: 'start',
  },
  productCard: {
    position: 'relative',
    background: '#1e293b',
    border: '1px solid #334155',
    borderRadius: 12,
    padding: '10px 8px',
    cursor: 'pointer',
    textAlign: 'center',
    transition: 'all 0.12s ease',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 5,
    fontFamily: "'DM Sans','Segoe UI',sans-serif",
  },
  productCardActive: {
    border: '1.5px solid rgb(var(--act-fill, 59 130 246) / 0.6)',
    background: 'rgb(var(--act-fill, 59 130 246) / 0.06)',
  },
  cartBadge: {
    position: 'absolute',
    top: 6,
    right: 6,
    background: 'rgb(var(--act-strong, 59 130 246))',
    color: 'rgb(var(--act-on, 255 255 255))',
    fontSize: 10,
    fontWeight: 700,
    width: 18,
    height: 18,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  productThumb: {
    width: 56,
    height: 56,
    borderRadius: 8,
    background: '#0f172a',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  productImg: { width: '100%', height: '100%', objectFit: 'cover' },
  productEmoji: { fontSize: 24 },
  productName: { fontSize: 11, fontWeight: 600, color: '#e2e8f0', lineHeight: 1.3, textAlign: 'center' },
  productPrice: { fontSize: 11, color: '#22c55e', fontWeight: 600 },
  emptyGrid: { gridColumn: '1/-1', color: '#475569', fontSize: 13, textAlign: 'center', padding: '40px 0' },

  // ── Cart panel ─────────────────────────────────────────────────────────────
  cartPanel: {
    width: 360,
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    background: '#0f172a',
    borderLeft: '1px solid #1e293b',
  },
  cartHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    padding: '14px 16px 12px',
    borderBottom: '1px solid #1e293b',
    flexShrink: 0,
  },
  cartTitle: { fontSize: 13, fontWeight: 700, color: '#f1f5f9', textTransform: 'uppercase', letterSpacing: '0.06em' },
  cartSubTitle: { fontSize: 11, color: '#64748b', marginTop: 2 },
  clearBtn: {
    background: 'transparent',
    border: 'none',
    color: '#475569',
    fontSize: 12,
    cursor: 'pointer',
    padding: '4px 8px',
    borderRadius: 6,
    fontFamily: "'DM Sans','Segoe UI',sans-serif",
  },
  cartList: {
    flex: 1,
    overflowY: 'auto',
    padding: '4px 0',
  },
  emptyCart: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '48px 24px',
    gap: 12,
  },
  emptyCartIcon: { opacity: 0.35 },
  emptyCartText: { fontSize: 13, color: '#475569', textAlign: 'center', lineHeight: 1.5 },

  // ── Cart rows ──────────────────────────────────────────────────────────────
  cartRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 16px',
    borderBottom: '1px solid #0f172a',
    background: '#1e293b',
    gap: 12,
  },
  cartRowInfo: { flex: 1, minWidth: 0 },
  cartItemName: { fontSize: 13, fontWeight: 500, color: '#e2e8f0', lineHeight: 1.3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  cartItemMeta: { fontSize: 11, color: '#64748b', marginTop: 2 },
  cartRowControls: { display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 },

  // Qty controls
  qtyControl: {
    display: 'flex',
    alignItems: 'center',
    gap: 0,
    background: '#0f172a',
    border: '1px solid #334155',
    borderRadius: 8,
    overflow: 'hidden',
  },
  qtyBtn: {
    width: 28,
    height: 28,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    border: 'none',
    color: '#94a3b8',
    fontSize: 16,
    cursor: 'pointer',
    fontFamily: "'DM Sans','Segoe UI',sans-serif",
  },
  qtyNum: {
    minWidth: 28,
    textAlign: 'center',
    fontSize: 13,
    fontWeight: 700,
    color: '#f1f5f9',
    fontVariantNumeric: 'tabular-nums',
  },
  weightDisplay: {
    fontSize: 12,
    color: '#f59e0b',
    fontWeight: 600,
    fontVariantNumeric: 'tabular-nums',
    padding: '4px 8px',
    background: 'rgba(245,158,11,0.08)',
    border: '1px solid rgba(245,158,11,0.2)',
    borderRadius: 6,
  },

  // Line total + remove
  cartLineTotalWrap: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: 4,
  },
  cartLineTotal: {
    fontSize: 13,
    fontWeight: 700,
    color: '#f1f5f9',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  },
  removeBtn: {
    background: 'transparent',
    border: 'none',
    color: '#475569',
    cursor: 'pointer',
    padding: 0,
    display: 'flex',
    alignItems: 'center',
  },

  // ── Cart footer / totals ───────────────────────────────────────────────────
  cartFooter: {
    padding: '12px 16px 16px',
    borderTop: '1px solid #1e293b',
    flexShrink: 0,
    background: '#0f172a',
  },
  totalsBlock: { marginBottom: 14 },
  totalRow: { display: 'flex', justifyContent: 'space-between', padding: '3px 0' },
  totalLabel: { fontSize: 12, color: '#64748b' },
  totalValue: { fontSize: 12, color: '#94a3b8', fontVariantNumeric: 'tabular-nums' },
  totalRowGrand: { borderTop: '1px solid #1e293b', paddingTop: 8, marginTop: 6 },
  grandLabel: { fontSize: 15, fontWeight: 700, color: '#f1f5f9' },
  grandValue: { fontSize: 17, fontWeight: 700, color: '#f1f5f9', fontVariantNumeric: 'tabular-nums' },
  chargeBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    width: '100%',
    padding: '14px 20px',
    background: 'linear-gradient(135deg, rgb(var(--act-strong, 29 78 216)) 0%, rgb(var(--act-strong, 37 99 235)) 100%)',
    border: 'none',
    borderRadius: 12,
    color: 'rgb(var(--act-on, 255 255 255))',
    fontSize: 15,
    fontWeight: 700,
    cursor: 'pointer',
    letterSpacing: '0.01em',
    fontFamily: "'DM Sans','Segoe UI',sans-serif",
  },

  // ── Modals ─────────────────────────────────────────────────────────────────
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.7)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    backdropFilter: 'blur(2px)',
    padding: 12,
  },
  modal: {
    background: '#1e293b',
    border: '1px solid #334155',
    borderRadius: 16,
    padding: '28px 28px 24px',
    width: '100%',
    maxWidth: 400,
    display: 'flex',
    flexDirection: 'column',
    gap: 0,
    boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
  },
  modalIcon: { fontSize: 28, marginBottom: 10, textAlign: 'center' },
  modalTitle: { fontSize: 18, fontWeight: 700, color: '#f1f5f9', marginBottom: 6, textAlign: 'center' },
  modalSub: { fontSize: 13, color: '#64748b', marginBottom: 4, textAlign: 'center', lineHeight: 1.5 },
  modalFieldWrap: { marginTop: 16 },
  modalFieldLabel: { display: 'block', fontSize: 12, color: '#64748b', marginBottom: 6, fontWeight: 500 },
  modalInput: {
    width: '100%',
    background: '#0f172a',
    border: '1px solid #334155',
    borderRadius: 8,
    padding: '10px 12px',
    color: '#f1f5f9',
    fontSize: 15,
    outline: 'none',
    boxSizing: 'border-box',
    fontFamily: "'DM Sans','Segoe UI',sans-serif",
  },
  modalMeta: { fontSize: 14, color: '#94a3b8', fontWeight: 600 },
  modalTotal: {
    marginTop: 10,
    fontSize: 13,
    color: '#22c55e',
    fontWeight: 600,
    background: 'rgba(34,197,94,0.06)',
    border: '1px solid rgba(34,197,94,0.15)',
    borderRadius: 8,
    padding: '8px 12px',
    textAlign: 'center',
  },
  modalActions: { display: 'flex', gap: 10, marginTop: 20 },
  modalCancel: {
    flex: 1,
    padding: '11px',
    background: 'transparent',
    border: '1px solid #334155',
    borderRadius: 8,
    color: '#94a3b8',
    fontSize: 14,
    cursor: 'pointer',
    fontFamily: "'DM Sans','Segoe UI',sans-serif",
  },
  modalConfirm: {
    flex: 2,
    padding: '11px',
    background: 'rgb(var(--act-strong, 29 78 216))',
    border: 'none',
    borderRadius: 8,
    color: 'rgb(var(--act-on, 255 255 255))',
    fontSize: 14,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: "'DM Sans','Segoe UI',sans-serif",
  },
  modalSecondary: {
    flex: 1,
    padding: '11px',
    background: 'rgb(var(--act-fill, 59 130 246) / 0.1)',
    border: '1px solid rgb(var(--act-fill, 59 130 246) / 0.3)',
    borderRadius: 8,
    color: 'rgb(var(--act-text, 96 165 250))',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: "'DM Sans','Segoe UI',sans-serif",
  },

  // ── Not-found ──────────────────────────────────────────────────────────────
  notFoundSection: { marginTop: 16 },
  notFoundSectionTitle: { fontSize: 11, color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 },
  notFoundResults: {
    marginTop: 8,
    background: '#0f172a',
    border: '1px solid #334155',
    borderRadius: 8,
    overflow: 'hidden',
  },
  notFoundResultRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    padding: '10px 14px',
    background: 'transparent',
    border: 'none',
    borderBottom: '1px solid #1e293b',
    color: '#f1f5f9',
    cursor: 'pointer',
    fontFamily: "'DM Sans','Segoe UI',sans-serif",
    textAlign: 'left',
  },
  notFoundResultName: { fontSize: 13, fontWeight: 500 },
  notFoundResultPrice: { fontSize: 12, color: '#22c55e', fontWeight: 600 },
  divider: { height: 1, background: '#334155', margin: '16px 0 0' },

  // ── Misc ───────────────────────────────────────────────────────────────────
  code: {
    fontFamily: 'monospace',
    background: '#0f172a',
    border: '1px solid #334155',
    borderRadius: 4,
    padding: '1px 6px',
    fontSize: 12,
    color: '#94a3b8',
  },
};
