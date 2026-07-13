import { useState, useRef, useEffect } from 'react';
import { api } from '../../lib/api';
import { generateOrderNumber } from '../../lib/cart';
import type { CartItem } from '../../lib/cart';
import type { Business, OrderType } from '../../types';
import type { LoyaltyState } from './LoyaltyPanel';
import type { DiscountState } from './DiscountPanel';
import ReceiptView from './ReceiptView';
import MpesaStkPanel from './MpesaStkPanel';
import SplitPaymentPanel, { type PaymentLeg } from './SplitPaymentPanel';
import { printReceipt } from '../../lib/printReceipt';
import { usePrinterSettings } from '../../hooks/usePrinterSettings';

type SingleMethod = 'cash' | 'mpesa' | 'card' | 'credit';

interface CompletedOrder {
  orderNumber: string;
  orderId?: string;
  payments: { method: string; amount: number; reference: string }[];
  tendered: number;
  change: number;
  pointsEarned: number;
  etims?: {
    receiptNo?: string | null;
    internalData?: string | null;
    signature?: string | null;
    qrPayload?: string | null;
  } | null;
}

interface Props {
  cart: CartItem[];
  total: number;
  subtotal: number;
  vatAmount: number;
  currency: string;
  business: Business;
  branchId: string;
  branchName?: string;
  orderType?: OrderType;
  tableNumber?: string;
  loyaltyState: LoyaltyState | null;
  discountState: DiscountState | null;
  onClose: () => void;
  onSuccess: (orderNumber: string) => void;
  onPaid?: () => void;
  shiftId?: string | null;
  /** If set, the order already exists in DB (order-first model) — use /pay instead of POST /orders */
  existingOrderId?: string;
}

function fmt(n: number) {
  return Number(n).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function PaymentModal({
  cart, total, subtotal, vatAmount, currency, business, branchId, branchName,
  orderType = 'retail', tableNumber,
  loyaltyState, discountState, onClose, onSuccess, onPaid, shiftId, existingOrderId,
}: Props) {

  // ── Mode ──────────────────────────────────────────────────────────────────
  const [splitMode, setSplitMode]   = useState(false);
  const [method, setMethod]         = useState<SingleMethod>('cash');
  // Credit account for the attached customer (fetched when 'credit' is chosen).
  const [creditInfo, setCreditInfo] = useState<{ credit_limit: number; credit_balance: number; available_credit: number } | null>(null);
  const [creditLoading, setCreditLoading] = useState(false);
  // Tips / gratuity — added on top of the order total at payment.
  const [tipAmount, setTipAmount] = useState(0);

  // Cash
  const [tendered, setTendered]     = useState('');

  // M-Pesa STK — pre-created order waiting for payment confirmation
  const [mpesaPending, setMpesaPending] = useState<{
    orderId: string;
    orderNumber: string;
  } | null>(null);

  // Shared UI state
  const [placing, setPlacing]       = useState(false);
  const [error, setError]           = useState('');
  const [completedOrder, setCompletedOrder] = useState<CompletedOrder | null>(null);

  // Free the table the moment payment succeeds, not when the receipt is dismissed.
  // Previously the table only cleared via the receipt's "New Sale" button, so
  // navigating away left it stuck "Occupied" with the already-paid order.
  useEffect(() => {
    if (completedOrder) onPaid?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completedOrder?.orderId]);
  const [receiptPhone, setReceiptPhone] = useState('');

  // After a sale completes, fiscalisation runs async server-side. Poll a few
  // times for the signed KRA record and patch it onto the receipt if it arrives.
  // Entirely best-effort: if eTIMS is off or not yet signed, the receipt simply
  // shows no fiscal block. Never blocks or delays the cashier.
  useEffect(() => {
    const oid = completedOrder?.orderId;
    if (!oid || completedOrder?.etims) return;
    let cancelled = false;
    let attempts = 0;
    const tick = async () => {
      attempts++;
      try {
        const data = await api.get<CompletedOrder['etims']>(`/api/etims/order/${oid}`);
        if (!cancelled && data) {
          setCompletedOrder(prev => (prev && prev.orderId === oid ? { ...prev, etims: data } : prev));
          return; // got it — stop polling
        }
      } catch { /* 204/again */ }
      if (!cancelled && attempts < 4) setTimeout(tick, 1500);
    };
    const t = setTimeout(tick, 1200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [completedOrder?.orderId, completedOrder?.etims]);

  const receiptRef = useRef<HTMLDivElement>(null);
  const { settings: printerSettings } = usePrinterSettings();

  // Double-submit protection. chargingRef blocks a second call synchronously
  // (before React re-renders the button as disabled — a fast touchscreen
  // double-tap otherwise fires two orders). idempotencyKey is a stable id for
  // this sale sent in the order body; the server dedupes on it, so even if two
  // requests slip through, only one order is created.
  const chargingRef = useRef(false);
  const idempotencyKeyRef = useRef<string>('');
  if (!idempotencyKeyRef.current) {
    idempotencyKeyRef.current = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  // Tip is added on top of the order total — this is what the customer pays.
  const grandTotal    = total + tipAmount;
  // A blank cash field means "pay exact". Without this the Confirm button stays
  // disabled with no feedback even though the field shows the total as a
  // placeholder — cashiers only type a value when the customer hands over more.
  const tenderedNum   = (method === 'cash' && tendered.trim() === '') ? grandTotal : (parseFloat(tendered) || 0);
  const change        = method === 'cash' ? Math.max(0, tenderedNum - grandTotal) : 0;
  const cashValid     = method !== 'cash' || tenderedNum >= grandTotal;
  const loyaltyDiscount  = loyaltyState?.discountAmount ?? 0;
  const promoDiscount    = discountState?.discount_amount ?? 0;
  const pointsRedeemed   = loyaltyState?.pointsToRedeem ?? 0;
  const multiplier       = loyaltyState?.tier.multiplier ?? 1;
  const estimatedPoints  = Math.floor(Math.floor(total / 10) * multiplier);

  // Fetch the attached customer's credit account when 'credit' is selected.
  const customerId = loyaltyState?.customer.id ?? null;
  useEffect(() => {
    if (method !== 'credit' || !customerId) { setCreditInfo(null); return; }
    let cancelled = false;
    setCreditLoading(true);
    (async () => {
      try {
        const { customer } = await api.get<{ customer: { credit_limit: number; credit_balance: number; available_credit: number } }>(
          `/api/credit/customer/${customerId}`,
        );
        if (!cancelled) setCreditInfo({
          credit_limit: Number(customer.credit_limit),
          credit_balance: Number(customer.credit_balance),
          available_credit: Number(customer.available_credit),
        });
      } catch {
        if (!cancelled) setCreditInfo(null);
      } finally {
        if (!cancelled) setCreditLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [method, customerId]);

  // Credit is valid only when a customer is attached and available credit covers the total.
  const creditValid = method !== 'credit' || (!!customerId && !!creditInfo && creditInfo.available_credit >= total);

  // Quick-tender presets: Exact, the nearest common notes above the total, and
  // a round-up to the next 100. These just fill the tendered field — the manual
  // input remains for odd tenders (mixed notes/coins).
  const quickTenders = (() => {
    const base = total + tipAmount;
    const notes = [50, 100, 200, 500, 1000];
    const set = new Set<number>();
    set.add(Math.ceil(base));                        // exact
    notes.filter(n => n >= base).slice(0, 2).forEach(n => set.add(n));
    set.add(Math.ceil(base / 100) * 100);            // round up to next 100
    if (base > 1000) set.add(Math.ceil(base / 1000) * 1000);
    return Array.from(set).filter(v => v >= base).sort((a, b) => a - b).slice(0, 4);
  })();

  // ── Build order payload ───────────────────────────────────────────────────
  function buildOrderPayload(payments: object[]) {
    return {
      idempotency_key: idempotencyKeyRef.current,
      branch_id:       branchId,
      order_number:    generateOrderNumber(),
      order_type:      orderType,
      table_number:    tableNumber ?? null,
      subtotal,
      vat_amount:      vatAmount,
      discount_amount: loyaltyDiscount + promoDiscount,
      discount_id:     discountState?.discount.id ?? null,
      total,
      tip_amount:      tipAmount,
      customer_id:     loyaltyState?.customer.id ?? null,
      customer_name:   loyaltyState?.customer.name ?? null,
      customer_phone:  loyaltyState?.customer.phone ?? null,
      points_redeemed: pointsRedeemed,
      shift_id:        shiftId ?? null,
      items: cart.map(item => ({
        product:           { id: item.product.id, name: item.product.name, categories: item.product.categories ?? null },
        unitPrice:          item.unitPrice,
        quantity:           item.quantity,
        lineTotal:          item.lineTotal,
        selectedVariants:   item.selectedVariants,
        selectedModifiers:  item.selectedModifiers,
      })),
      payments,
    };
  }

  function makeCompletedOrder(
    orderNumber: string,
    payments: { method: string; amount: number; reference: string }[],
    tenderedAmt = total,
    changeAmt = 0,
    orderId?: string,
  ): CompletedOrder {
    return {
      orderNumber,
      orderId,
      payments,
      tendered: tenderedAmt,
      change:   changeAmt,
      pointsEarned: loyaltyState ? estimatedPoints : 0,
    };
  }

  // ── Cash / Card / Credit charge ───────────────────────────────────────────
  async function handleCharge() {
    if (!cashValid || !creditValid) return;
    if (chargingRef.current) return;   // synchronous double-tap guard
    if (!existingOrderId && !branchId) {
      setError('No branch is set for this session. Please lock the till and sign in again.');
      return;
    }
    chargingRef.current = true;
    setPlacing(true); setError('');
    try {
      const payments = [{
        method,
        amount:          grandTotal,
        amount_tendered: method === 'cash' ? tenderedNum : (method === 'credit' ? 0 : grandTotal),
        change_given:    method === 'cash' ? change : 0,
        reference:       null,
      }];
      const endpoint = existingOrderId
        ? `/api/orders/${existingOrderId}/pay`
        : '/api/orders';
      const { orderId, orderNumber } = await api.post<{ orderId: string; orderNumber: string }>(
        endpoint, existingOrderId ? { payments } : buildOrderPayload(payments)
      );
      setCompletedOrder(makeCompletedOrder(
        orderNumber,
        [{ method, amount: grandTotal, reference: '' }],
        method === 'cash' ? tenderedNum : grandTotal,
        method === 'cash' ? change : 0,
        orderId ?? existingOrderId,
      ));
    } catch (err: any) {
      setError(err.message ?? 'Failed to process payment');
      setPlacing(false);
      chargingRef.current = false;   // allow retry after a failed charge
    }
  }

  // ── M-Pesa: create order first, then hand off to STK panel ───────────────
  async function handleInitiateMpesa() {
    setPlacing(true); setError('');
    try {
      const payments = [{ method: 'mpesa', amount: grandTotal, amount_tendered: grandTotal, change_given: 0, reference: null }];
      const { orderId, orderNumber } = await api.post<{ orderId: string; orderNumber: string }>(
        '/api/orders', buildOrderPayload(payments)
      );
      setMpesaPending({ orderId, orderNumber });
    } catch (err: any) {
      setError(err.message ?? 'Failed to create order');
    } finally {
      setPlacing(false);
    }
  }

  function handleMpesaSuccess(mpesaRef: string) {
    if (!mpesaPending) return;
    setCompletedOrder(makeCompletedOrder(
      mpesaPending.orderNumber,
      [{ method: 'mpesa', amount: grandTotal, reference: mpesaRef }],
      total, 0,
      mpesaPending.orderId,
    ));
    setMpesaPending(null);
  }

  function handleMpesaCancel() {
    // Order was created but payment not confirmed.
    // Cashier can void it from Order History if needed.
    setMpesaPending(null);
    setError('M-Pesa payment cancelled. The open order can be voided from Order History.');
  }

  // ── Split charge ──────────────────────────────────────────────────────────
  async function handleSplitCharge(legs: PaymentLeg[]) {
    if (chargingRef.current) return;   // synchronous double-tap guard
    chargingRef.current = true;
    setPlacing(true); setError('');
    try {
      const payments = legs.map(l => ({
        method:          l.method,
        amount:          l.amount,
        amount_tendered: l.amount,
        change_given:    0,
        reference:       l.reference ?? null,
      }));
      const endpoint = existingOrderId
        ? `/api/orders/${existingOrderId}/pay`
        : '/api/orders';
      const { orderId, orderNumber } = await api.post<{ orderId: string; orderNumber: string }>(
        endpoint, existingOrderId ? { payments } : buildOrderPayload(payments)
      );
      setCompletedOrder(makeCompletedOrder(
        orderNumber,
        legs.map(l => ({ method: l.method, amount: l.amount, reference: l.reference ?? '' })),
        total, 0,
        orderId ?? existingOrderId,
      ));
    } catch (err: any) {
      setError(err.message ?? 'Failed to process split payment');
      setPlacing(false);
      chargingRef.current = false;   // allow retry after a failed charge
    }
  }

  const [waSending, setWaSending] = useState(false);
  const [waMsg, setWaMsg] = useState<string | null>(null);
  const handleSendWhatsApp = async () => {
    if (!completedOrder?.orderId) return;
    const phone = loyaltyState?.customer.phone;
    setWaSending(true); setWaMsg(null);
    try {
      const r = await api.post<{ status: string; error?: string }>(
        `/api/orders/${completedOrder.orderId}/whatsapp-receipt`,
        phone ? { phone } : {},
      );
      setWaMsg(r.status === 'sent' ? 'Receipt sent ✓'
        : r.status === 'skipped' ? 'WhatsApp not enabled'
        : `Failed: ${r.error ?? r.status}`);
    } catch (e: any) {
      setWaMsg(e?.message ?? 'Failed to send');
    } finally { setWaSending(false); }
  };

  const handlePrint = () => {
    const content = receiptRef.current;
    if (!content) return;
    printReceipt(content.innerHTML, printerSettings, business.name);
  };

  // ── Receipt screen ────────────────────────────────────────────────────────
  if (completedOrder) {
    return (
      <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 px-4">
        <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-sm overflow-hidden">
          <div className="px-6 pt-6 pb-4 border-b border-gray-800 flex items-center justify-between">
            <div>
              <p className="text-green-400 font-semibold">Payment successful</p>
              <p className="text-gray-500 text-xs mt-0.5">{completedOrder.orderNumber}</p>
            </div>
            <span className="text-2xl">✓</span>
          </div>

          {loyaltyState && (
            <div className="px-6 pt-4 space-y-1">
              {pointsRedeemed > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Points redeemed</span>
                  <span className="text-green-400">− {pointsRedeemed.toLocaleString()} pts</span>
                </div>
              )}
              {completedOrder.pointsEarned > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Points earned</span>
                  <span className="text-yellow-400">+ {completedOrder.pointsEarned.toLocaleString()} pts</span>
                </div>
              )}
              <div className="flex justify-between text-sm pb-2 border-b border-gray-800">
                <span className="text-gray-400">New balance (est.)</span>
                <span className="text-white font-semibold">
                  {((loyaltyState.customer.loyalty_points - pointsRedeemed) + completedOrder.pointsEarned).toLocaleString()} pts
                </span>
              </div>
            </div>
          )}

          <div className="px-6 py-4 max-h-80 overflow-y-auto bg-white rounded-xl mx-2 mb-2">
            <ReceiptView
              ref={receiptRef}
              business={business}
              branchName={branchName}
              orderNumber={completedOrder.orderNumber}
              etims={completedOrder.etims}
              tip={tipAmount}
              cart={cart}
              total={total}
              subtotal={subtotal}
              vatAmount={vatAmount}
              currency={currency}
              payments={completedOrder.payments}
              tendered={completedOrder.tendered}
              change={completedOrder.change}
              loyaltyDiscount={loyaltyDiscount}
              promoDiscount={promoDiscount}
              promoName={discountState?.discount.name}
              customerName={loyaltyState?.customer.name}
              footerMessage={printerSettings.footerMessage}
            />
          </div>

          {/* Receipt phone — optional, send after checkout */}
          <div className="px-6 pb-2">
            <div className="flex items-center gap-2 bg-gray-800/50 border border-gray-700 rounded-xl px-3 py-2">
              <span className="text-sm flex-shrink-0">📱</span>
              <input
                type="tel"
                value={receiptPhone}
                onChange={e => setReceiptPhone(e.target.value)}
                placeholder="Customer phone for receipt (optional)"
                className="flex-1 bg-transparent text-white text-sm focus:outline-none placeholder-gray-600"
              />
              {receiptPhone && (
                <button
                  onClick={() => {
                    // Future: call /api/orders/:id/send-receipt with phone
                    // For now — show inline info message (no blocking alert)
                    setWaMsg('WhatsApp receipt: set WHATSAPP_PROVIDER in server .env to enable.');
                  }}
                  className="flex-shrink-0 text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1 rounded-lg font-medium transition-colors">
                  Send
                </button>
              )}
            </div>
          </div>
          {waMsg && <div className="px-6 pb-2 text-center text-xs text-gray-400">{waMsg}</div>}
          <div className="px-6 pb-6 flex gap-3">
            <button onClick={handlePrint}
              className="flex-1 bg-gray-800 hover:bg-gray-700 text-white rounded-xl py-2.5 text-sm font-medium transition-colors">
              🖨 Print
            </button>
            <button onClick={handleSendWhatsApp} disabled={waSending}
              className="flex-1 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-white rounded-xl py-2.5 text-sm font-medium transition-colors">
              {waSending ? 'Sending…' : '💬 WhatsApp'}
            </button>
            <button onClick={() => onSuccess(completedOrder.orderNumber)}
              className="flex-1 bg-green-500 hover:bg-green-400 text-gray-950 font-bold rounded-xl py-2.5 text-sm transition-colors">
              New order
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── M-Pesa STK waiting screen ─────────────────────────────────────────────
  if (mpesaPending) {
    return (
      <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 px-4">
        <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-sm p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-white font-semibold text-lg">M-Pesa payment</h2>
            <span className="text-gray-500 text-sm">{mpesaPending.orderNumber}</span>
          </div>
          <MpesaStkPanel
            total={total}
            currency={currency}
            orderId={mpesaPending.orderId}
            onSuccess={handleMpesaSuccess}
            onCancel={handleMpesaCancel}
          />
        </div>
      </div>
    );
  }

  // ── Payment entry screen ──────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 px-4 py-6">
      <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-sm flex flex-col max-h-full overflow-hidden">
        {/* Fixed header */}
        <div className="px-6 pt-6 pb-4 border-b border-gray-800 flex items-center justify-between flex-shrink-0">
          <h2 className="text-white font-semibold text-lg">Payment</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors text-xl">✕</button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">

          {/* Total due */}
          <div className="text-center py-2">
            <p className="text-gray-400 text-sm">Total due</p>
            <p className="text-white text-3xl font-bold mt-1">{currency} {fmt(total)}</p>
            {loyaltyDiscount > 0 && <p className="text-green-400 text-xs mt-1">⭐ Includes {currency} {fmt(loyaltyDiscount)} loyalty discount</p>}
            {promoDiscount  > 0 && <p className="text-yellow-400 text-xs mt-0.5">🏷️ Includes {currency} {fmt(promoDiscount)} promo discount</p>}
            {loyaltyState && estimatedPoints > 0 && <p className="text-yellow-500 text-xs mt-0.5">Customer earns ~{estimatedPoints} pts</p>}
          </div>

          {/* Split toggle */}
          <div className="flex items-center justify-between">
            <p className="text-gray-400 text-sm">Split payment</p>
            <button
              onClick={() => setSplitMode(s => !s)}
              className={`relative w-10 h-5 rounded-full transition-colors ${splitMode ? 'bg-green-500' : 'bg-gray-700'}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${splitMode ? 'translate-x-5' : ''}`} />
            </button>
          </div>

          {/* ── SPLIT PAYMENT ── */}
          {splitMode && (
            <SplitPaymentPanel
              total={total}
              currency={currency}
              onConfirm={handleSplitCharge}
              onCancel={() => setSplitMode(false)}
            />
          )}

          {/* ── SINGLE PAYMENT ── */}
          {!splitMode && (
            <>
              {/* Method tabs */}
              <div className="grid grid-cols-4 gap-2">
                {(['cash', 'mpesa', 'card', 'credit'] as SingleMethod[]).map(m => (
                  <button key={m} onClick={() => setMethod(m)}
                    className={`py-3 rounded-xl text-sm font-medium border transition-colors ${
                      method === m
                        ? 'bg-green-500/10 border-green-500 text-green-400'
                        : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600'
                    }`}>
                    {m === 'cash' ? '💵' : m === 'mpesa' ? '📱' : m === 'card' ? '💳' : '🧾'}<br />
                    <span className="capitalize">{m === 'mpesa' ? 'M-Pesa' : m === 'credit' ? 'On Account' : m}</span>
                  </button>
                ))}
              </div>

              {/* Tip / gratuity — adds on top of the total */}
              {method !== 'credit' && (
                <div className="bg-gray-800/40 rounded-xl p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm text-gray-400">Add tip</span>
                    {tipAmount > 0 && (
                      <span className="text-green-400 text-sm font-medium">+ {currency} {fmt(tipAmount)}</span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {[5, 10, 15].map(pct => {
                      const amt = Math.round((total * pct) / 100 * 100) / 100;
                      const active = Math.abs(tipAmount - amt) < 0.005 && tipAmount > 0;
                      return (
                        <button key={pct} type="button"
                          onClick={() => setTipAmount(active ? 0 : amt)}
                          className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                            active ? 'bg-green-500/10 border-green-500 text-green-400'
                                   : 'bg-gray-800 border-gray-700 text-gray-300 hover:border-gray-600'
                          }`}>
                          {pct}%
                        </button>
                      );
                    })}
                    <input
                      type="number" min={0} placeholder="Custom"
                      value={tipAmount > 0 && ![5,10,15].some(p => Math.abs(tipAmount - total*p/100) < 0.005) ? tipAmount : ''}
                      onChange={e => setTipAmount(Math.max(0, parseFloat(e.target.value) || 0))}
                      className="w-24 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-white text-sm placeholder-gray-600"
                    />
                    {tipAmount > 0 && (
                      <button type="button" onClick={() => setTipAmount(0)}
                        className="px-3 py-1.5 rounded-lg text-sm text-gray-500 hover:text-gray-300">clear</button>
                    )}
                  </div>
                </div>
              )}

              {/* Cash */}
              {method === 'cash' && (
                <div className="space-y-3">
                  {tipAmount > 0 && (
                    <div className="bg-gray-800 rounded-lg px-4 py-2 flex justify-between text-sm">
                      <span className="text-gray-400">Total to collect (incl. tip)</span>
                      <span className="text-white font-semibold">{currency} {fmt(grandTotal)}</span>
                    </div>
                  )}
                  <div>
                    <label className="block text-sm text-gray-400 mb-1.5">Amount tendered ({currency})</label>
                    <div className="flex flex-wrap gap-2 mb-2">
                      {quickTenders.map(v => (
                        <button key={v} type="button" onClick={() => setTendered(String(v))}
                          className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                            tenderedNum === v
                              ? 'bg-green-500/10 border-green-500 text-green-400'
                              : 'bg-gray-800 border-gray-700 text-gray-300 hover:border-gray-600'
                          }`}>
                          {v === Math.ceil(total + tipAmount) ? 'Exact' : fmt(v)}
                        </button>
                      ))}
                    </div>
                    <input
                      type="number" value={tendered}
                      onChange={e => setTendered(e.target.value)}
                      placeholder={fmt(total)} min={total} autoFocus
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-600 focus:outline-none focus:border-green-500 transition-colors text-lg font-semibold"
                    />
                  </div>
                  {tenderedNum >= total && (
                    <div className="bg-gray-800 rounded-lg px-4 py-3 flex justify-between">
                      <span className="text-gray-400 text-sm">Change</span>
                      <span className="text-white font-semibold">{currency} {fmt(change)}</span>
                    </div>
                  )}
                </div>
              )}

              {/* M-Pesa */}
              {method === 'mpesa' && (
                <div className="bg-gray-800 rounded-xl p-4 text-center space-y-3">
                  <div className="text-3xl">📱</div>
                  <p className="text-white font-semibold">M-Pesa — {currency} {fmt(total)}</p>
                  <p className="text-gray-400 text-sm">
                    Click below to send an STK push to the customer's phone,
                    or enter a reference code manually after they pay.
                  </p>
                </div>
              )}

              {/* Card */}
              {method === 'card' && (
                <div className="bg-gray-800 rounded-xl p-4 text-center space-y-2">
                  <div className="text-3xl">💳</div>
                  <p className="text-white font-semibold">Card — {currency} {fmt(total)}</p>
                  <p className="text-gray-400 text-sm">Process the card on your terminal, then confirm below.</p>
                </div>
              )}

              {/* Credit / On Account */}
              {method === 'credit' && (
                <div className="bg-gray-800 rounded-xl p-4 space-y-3">
                  {!customerId ? (
                    <div className="text-center space-y-1">
                      <div className="text-3xl">🧾</div>
                      <p className="text-yellow-400 text-sm font-medium">Attach a customer to sell on account</p>
                      <p className="text-gray-500 text-xs">Use the Customer / Loyalty panel to select who is buying on credit.</p>
                    </div>
                  ) : creditLoading ? (
                    <p className="text-gray-400 text-sm text-center">Loading credit account…</p>
                  ) : !creditInfo ? (
                    <p className="text-red-400 text-sm text-center">Could not load this customer's credit account.</p>
                  ) : (
                    <>
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-400">Credit limit</span>
                        <span className="text-white">{currency} {fmt(creditInfo.credit_limit)}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-400">Current balance owed</span>
                        <span className="text-white">{currency} {fmt(creditInfo.credit_balance)}</span>
                      </div>
                      <div className="flex justify-between text-sm border-t border-gray-700 pt-2">
                        <span className="text-gray-400">Available credit</span>
                        <span className={creditInfo.available_credit >= total ? 'text-green-400 font-semibold' : 'text-red-400 font-semibold'}>
                          {currency} {fmt(creditInfo.available_credit)}
                        </span>
                      </div>
                      {creditInfo.available_credit < total && (
                        <p className="text-red-400 text-xs text-center pt-1">
                          This sale ({currency} {fmt(total)}) exceeds available credit.
                        </p>
                      )}
                      {creditInfo.credit_limit === 0 && (
                        <p className="text-yellow-400 text-xs text-center pt-1">
                          This customer has no credit limit set. Set one in Credit Accounts first.
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}
            </>
          )}

          {error && (
            <p className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {error}
            </p>
          )}
        </div>

        {/* Fixed footer — charge button */}
        {!splitMode && (
          <div className="px-6 pb-6 pt-4 border-t border-gray-800 flex-shrink-0">
            {method === 'mpesa' ? (
              <button
                onClick={handleInitiateMpesa}
                disabled={placing}
                className="w-full bg-green-500 hover:bg-green-400 disabled:opacity-40 disabled:cursor-not-allowed text-gray-950 font-bold rounded-xl py-3 transition-colors"
              >
                {placing ? 'Creating order…' : '📱 Initiate M-Pesa payment'}
              </button>
            ) : (
              <button
                data-testid="payment-confirm"
                onClick={handleCharge}
                disabled={placing || !cashValid || !creditValid}
                className="w-full bg-green-500 hover:bg-green-400 disabled:opacity-40 disabled:cursor-not-allowed text-gray-950 font-bold rounded-xl py-3 transition-colors"
              >
                {placing
                  ? 'Processing…'
                  : method === 'credit'
                    ? `Charge to account — ${currency} ${fmt(grandTotal)}`
                    : `Confirm ${method === 'card' ? 'card' : 'cash'} payment — ${currency} ${fmt(grandTotal)}`}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
