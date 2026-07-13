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
 *  • EAN-13 weighed-item decoder (digit[0] === '2' → PLU + grams)
 *  • Weight confirmation modal with manual override
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
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type { CartItem } from '../../lib/cart';
import { cartSubtotal, extractVat } from '../../lib/cart';
import type { Product, Category } from '../../types';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ParkedOrder {
  key: string;
  label: string;
  itemCount: number;
}

interface WeighedItem {
  pluCode: string;
  weightKg: number;
  rawBarcode: string;
}

type ScanResult =
  | { type: 'product'; product: Product }
  | { type: 'weighed'; product: Product; weightKg: number }
  | { type: 'not_found'; barcode: string }
  | { type: 'error'; message: string };

interface Props {
  products: Product[];
  categories: Category[];
  cart: CartItem[];
  currency: string;
  onAddToCart: (product: Product, qty?: number) => void;
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

// ── EAN-13 decoder ────────────────────────────────────────────────────────────

/**
 * Returns a WeighedItem if this is a scale-printed EAN-13 (starts with '2'),
 * otherwise null (treat as regular barcode lookup).
 *
 * Scale EAN-13 format:
 *   digit[0]   = '2'                  → weighed item flag
 *   digits[1–5] = PLU code (5 digits)
 *   digits[6–10] = weight in grams    (e.g. "00750" → 750 g → 0.750 kg)
 *   digit[11]  = check digit
 */
function decodeEan13Weight(barcode: string): WeighedItem | null {
  if (barcode.length !== 13) return null;
  if (barcode[0] !== '2') return null;
  const pluCode = barcode.slice(1, 6);          // digits 1–5
  const grams   = parseInt(barcode.slice(6, 11), 10); // digits 6–10
  if (isNaN(grams)) return null;
  return { pluCode, weightKg: grams / 1000, rawBarcode: barcode };
}

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
  cart,
  currency,
  onAddToCart,
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

  // ── Scan bar ───────────────────────────────────────────────────────────────
  const scanInputRef  = useRef<HTMLInputElement>(null);
  const [scanValue, setScanValue]     = useState('');
  const [scanStatus, setScanStatus]   = useState<'idle' | 'scanning' | 'found' | 'error'>('idle');
  const [scanMessage, setScanMessage] = useState('');

  // ── Modals ─────────────────────────────────────────────────────────────────
  const [weightModal, setWeightModal]               = useState<WeighedItem & { product: Product } | null>(null);
  const [weightInput, setWeightInput]               = useState('');
  const [notFoundModal, setNotFoundModal]           = useState<{ barcode: string } | null>(null);
  const [notFoundSearch, setNotFoundSearch]         = useState('');
  const [notFoundResults, setNotFoundResults]       = useState<Product[]>([]);
  const [quickAddModal, setQuickAddModal]           = useState<{ barcode: string } | null>(null);
  const [quickAddName, setQuickAddName]             = useState('');
  const [quickAddPrice, setQuickAddPrice]           = useState('');
  const [quickAddSaving, setQuickAddSaving]         = useState(false);

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
      // 1. Check for weighed EAN-13
      const weighed = decodeEan13Weight(barcode);

      if (weighed) {
        // Look up by PLU code
        let product: Product | undefined;
        try {
          product = await posApi.get<Product>(`/api/products/plu/${weighed.pluCode}`);
        } catch {
          product = products.find(p => (p as { plu_code?: string }).plu_code === weighed.pluCode);
        }

        if (product) {
          setScanStatus('found');
          setScanMessage(`${product.name} — ${weighed.weightKg.toFixed(3)} kg`);
          setWeightModal({ ...weighed, product });
          setWeightInput(weighed.weightKg.toFixed(3));
        } else {
          setScanStatus('error');
          setScanMessage(`PLU ${weighed.pluCode} not found`);
          setNotFoundModal({ barcode });
          setNotFoundSearch('');
        }
        return;
      }

      // 2. Regular barcode lookup
      const product = products.find(
        p => (p as { barcode?: string }).barcode === barcode
      );

      if (product) {
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
  }, [products, posApi, onAddToCart]);

  // ── Scan bar submit ────────────────────────────────────────────────────────
  function onScanSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (scanValue.trim().length > 0) processScan(scanValue.trim());
  }

  // ── Weight modal confirm ───────────────────────────────────────────────────
  function confirmWeight() {
    if (!weightModal) return;
    const kg = parseFloat(weightInput);
    if (isNaN(kg) || kg <= 0) return;
    // Add to cart with qty = weight, unit price = price_per_kg (base_price)
    onAddToCart(weightModal.product, kg);
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

  // ── Cart totals ────────────────────────────────────────────────────────────
  const subtotal = cartSubtotal(cart);
  const vat      = extractVat(subtotal, VAT_RATE);
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
      <div style={s.body}>

        {/* ── Product catalogue (hidden by default) ──────────────────────── */}
        {showCatalogue && (
          <div style={s.catalogue}>
            {/* Category tabs */}
            <div style={s.catRow}>
              {[{ id: 'all', name: 'All' }, ...categories].map(cat => (
                <button
                  key={cat.id}
                  style={{
                    ...s.catBtn,
                    ...(activeCategory === cat.id ? s.catBtnActive : {}),
                  }}
                  onClick={() => setActiveCategory(cat.id)}
                >
                  {cat.name}
                </button>
              ))}
            </div>

            {/* Catalogue search */}
            <div style={s.catSearchWrap}>
              <input
                style={s.catSearchInput}
                placeholder="Filter by name, barcode or PLU…"
                value={catalogueSearch}
                onChange={e => setCatalogueSearch(e.target.value)}
              />
            </div>

            {/* Product grid */}
            <div style={s.productGrid}>
              {filteredProducts.length === 0 ? (
                <div style={s.emptyGrid}>No products match</div>
              ) : filteredProducts.map(product => {
                const inCart = cart.find(i => i.product.id === product.id);
                return (
                  <button
                    key={product.id}
                    style={{ ...s.productCard, ...(inCart ? s.productCardActive : {}) }}
                    onClick={() => onAddToCart(product)}
                  >
                    {inCart && <span style={s.cartBadge}>{inCart.quantity}</span>}
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
            </div>
          </div>
        )}

        {/* ── Cart / order panel ──────────────────────────────────────────── */}
        <div style={s.cartPanel}>

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
              cart.map((item) => {
                const isSoldByWeight = (item.product as { sold_by?: string }).sold_by === 'weight';
                return (
                  <div key={item.product.id} style={s.cartRow}>
                    <div style={s.cartRowInfo}>
                      <div style={s.cartItemName}>{item.product.name}</div>
                      <div style={s.cartItemMeta}>
                        {fmt(item.unitPrice, currency)}
                        {isSoldByWeight ? ' / kg' : ' each'}
                      </div>
                    </div>

                    <div style={s.cartRowControls}>
                      {/* Qty controls — show as label for weighed items */}
                      {isSoldByWeight ? (
                        <span style={s.weightDisplay}>{item.quantity.toFixed(3)} kg</span>
                      ) : (
                        <div style={s.qtyControl}>
                          <button
                            style={s.qtyBtn}
                            onClick={() => onUpdateQty(item.product.id, -1)}
                            aria-label="Decrease"
                          >−</button>
                          <span style={s.qtyNum}>{item.quantity}</span>
                          <button
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
                  <span style={s.totalLabel}>VAT ({VAT_RATE}%)</span>
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
        <div style={s.overlay} role="dialog" aria-modal aria-label="Confirm weight">
          <div style={s.modal}>
            <div style={s.modalIcon}>⚖️</div>
            <h2 style={s.modalTitle}>Confirm weight</h2>
            <p style={s.modalSub}>{weightModal.product.name}</p>
            <p style={s.modalSub}>
              PLU {weightModal.pluCode} &nbsp;·&nbsp;
              Scanned: {weightModal.weightKg.toFixed(3)} kg
            </p>

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
                Line total: {fmt(weightModal.product.base_price * parseFloat(weightInput), currency)}
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
        <div style={s.overlay} role="dialog" aria-modal aria-label="Product not found">
          <div style={{ ...s.modal, maxWidth: 480 }}>
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
                        onAddToCart(p);
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
        <div style={s.overlay} role="dialog" aria-modal aria-label="Quick-add product">
          <div style={s.modal}>
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
    background: '#1d4ed8',
    border: 'none',
    borderRadius: 7,
    color: '#fff',
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
    background: '#3b82f6',
    color: '#fff',
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
  catRow: {
    display: 'flex',
    gap: 6,
    padding: '10px 14px 8px',
    borderBottom: '1px solid #1e293b',
    overflowX: 'auto',
    flexShrink: 0,
  },
  catBtn: {
    padding: '5px 12px',
    background: '#1e293b',
    border: '1px solid #334155',
    borderRadius: 20,
    color: '#64748b',
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    flexShrink: 0,
    fontFamily: "'DM Sans','Segoe UI',sans-serif",
  },
  catBtnActive: {
    background: 'rgba(59,130,246,0.15)',
    borderColor: 'rgba(59,130,246,0.4)',
    color: '#60a5fa',
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
    border: '1.5px solid rgba(59,130,246,0.6)',
    background: 'rgba(59,130,246,0.06)',
  },
  cartBadge: {
    position: 'absolute',
    top: 6,
    right: 6,
    background: '#3b82f6',
    color: '#fff',
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
    background: 'linear-gradient(135deg, #1d4ed8 0%, #2563eb 100%)',
    border: 'none',
    borderRadius: 12,
    color: '#fff',
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
    background: '#1d4ed8',
    border: 'none',
    borderRadius: 8,
    color: '#fff',
    fontSize: 14,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: "'DM Sans','Segoe UI',sans-serif",
  },
  modalSecondary: {
    flex: 1,
    padding: '11px',
    background: 'rgba(59,130,246,0.1)',
    border: '1px solid rgba(59,130,246,0.3)',
    borderRadius: 8,
    color: '#60a5fa',
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
