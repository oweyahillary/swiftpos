import MethodDot from '../../components/MethodDot';
import type { AppliedOffer } from '@zaptill/core/offers';   // A445
import { enabledFromSetting, paymentButtons } from '@zaptill/core/paymentCatalogue';   // A429
import { methodColour, methodSolid, methodTint } from '@zaptill/core/paymentColours';
import type { MonoRaster } from '../../lib/escposRenderer';
import { useState, useRef, useEffect } from 'react';
import { api } from '../../lib/api';
import { generateOrderNumber, extractTaxes } from '../../lib/cart';
import type { CartItem } from '../../lib/cart';
import { capDiscountPct } from './cashier/types';
import type { Business, OrderType } from '../../types';
import type { LoyaltyState } from './LoyaltyPanel';
import type { DiscountState } from './DiscountPanel';
import ReceiptView from './ReceiptView';
import MpesaStkPanel from './MpesaStkPanel';
import SplitPaymentPanel, { type PaymentLeg } from './SplitPaymentPanel';
import EvenSplitPanel from './EvenSplitPanel';
import ByItemSplitPanel from './ByItemSplitPanel';
import { printReceipt } from '../../lib/printReceipt';
import { printBytesToServer, getQZStatus } from '../../lib/localPrintServer';
import { renderEscPos } from '../../lib/escposRenderer';
import { buildReceiptOrder, buildReceiptBusinessConfig } from '../../lib/buildReceiptOrder';
import { usePOSAuth } from '../../context/POSAuthContext';
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
  receiptHeader?: string;
  receiptLogo?: MonoRaster | null;   // A313
  receiptFooter?: string;
  receiptPay?: { label: string; number: string } | null;   // A450
  /** A530: the client's POS switches (pos/init) — the receipt's classic parts. */
  posFeatures?: Partial<Record<string, unknown>> | null;
  orderType?: OrderType;
  tableNumber?: string;
  loyaltyState: LoyaltyState | null;
  discountState: DiscountState | null;
  onClose: () => void;
  onSuccess: (orderNumber: string) => void;
  onPaid?: () => void;
  shiftId?: string | null;
  /** Discount ceiling (percent) advertised by the server. The web POS clamps to
   *  this so it charges what the server will store; without it an over-ceiling
   *  discount made the charged total and the stored total disagree, and now
   *  (with the atomic-order payment guard) would fail the sale outright. */
  maxDiscountPct?: number;
  /** A445: the offers on this cart (shared/offers.ts) — taken off first; loyalty and a promo code are capped on the rest. */
  offers?: AppliedOffer[];
  /** Custom tenders beyond the built-ins (A96), from /api/pos/init. Rendered as
   *  extra method buttons; all are non-cash and settle immediately like a card. */
  customMethods?: { code: string; name: string }[];
  /** A429: the payment methods the branch takes (catalogue codes); null / absent = the catalogue's defaults. */
  enabledMethods?: string[] | null;
  /** If set, the order already exists in DB (order-first model) — use /pay instead of POST /orders */
  existingOrderId?: string;
  /** Open directly in even-split mode (A151 — the restaurant "Split Bill" entry). */
  initialEvenSplit?: boolean;
  /**
   * Pump this sale was dispensed from, for a petrol station (audit B5).
   *
   * The DESKTOP till has sent pump_id end to end since the 3-Aug build; the web
   * POS never did, so every web fuel sale wrote pump_id = NULL. Two consequences,
   * both silent: the exact-tank deduction in stockEffects.ts falls back to
   * matching by fuel_product_id (wrong at any station with more than one tank
   * per grade), and every fuel report keyed on pump_id reads zero — the exact
   * symptom the desktop fix was written to close, still live on the other client.
   */
  pumpId?: string | null;
  /** A367: the note on the whole order (the lines' notes ride on the cart items). */
  orderNote?: string | null;
  /** 0.6.27: a delivery's rider, and the fee the customer pays on top of the bill (0 = none). */
  rider?: string | null;
  deliveryFee?: number;
  /** 0.6.33: a FREE delivery — `deliveryFee` is then 0 (the customer pays none); `riderFee` is what the rider is paid
   *  from this shift's drawer, sent as delivery_fee with delivery_free. */
  deliveryFree?: boolean;
  riderFee?: number;
  /** A607: the customer's details for this sale (SaleCustomerPanel): the name, the buyer's KRA PIN, a saved customer, and
   *  the number for the M-Pesa prompt (masked: shown masked to this person). */
  buyer?: { sale: { customer_name?: string; customer_phone?: string; buyer_kra_pin?: string; customer_id?: string }; stkPhone: string | null; masked?: boolean } | null;
}

function fmt(n: number) {
  return Number(n).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function PaymentModal({
  cart, total, subtotal, vatAmount, currency, business, branchId, branchName, receiptHeader, receiptLogo, receiptFooter, receiptPay,
  posFeatures,
  orderType = 'retail', tableNumber,
  loyaltyState, discountState, onClose, onSuccess, onPaid, shiftId,
  maxDiscountPct = 10, existingOrderId, offers = [],
  initialEvenSplit,
  pumpId,
  customMethods = [],
  enabledMethods = null,
  orderNote = null,
  rider = null,
  deliveryFee = 0,
  deliveryFree = false,
  riderFee = 0,
  buyer = null,
}: Props) {
  // 0.6.33: what the order records as the delivery fee — the rider's; on a free delivery the customer pays none of it.
  const free = deliveryFree && riderFee > 0;
  const recordedFee = free ? riderFee : deliveryFee;
  const feeFields = recordedFee > 0 ? { delivery_fee: recordedFee, ...(free ? { delivery_free: true } : {}) } : {};

  // ── Mode ──────────────────────────────────────────────────────────────────
  const [splitMode, setSplitMode]   = useState(false);
  const [evenSplitMode, setEvenSplitMode] = useState(!!initialEvenSplit);
  const [byItemMode, setByItemMode] = useState(false);
  // A429: the branch's methods — the four this screen knows by name (cash, M-Pesa, card, on account) where switched on,
  // then the catalogue's other switched-on methods (Glovo, Airtel Money …) and the business's own: those settle at once,
  // like a card.
  const branchButtons = paymentButtons(enabledFromSetting(enabledMethods), customMethods, 'web');
  const builtInMethods = (['cash', 'mpesa', 'card', 'credit'] as SingleMethod[]).filter(m => branchButtons.some(b => b.code === m));
  const extraMethods = branchButtons.filter(b => !(['cash', 'mpesa', 'card', 'credit'] as string[]).includes(b.code));
  const [method, setMethod]         = useState<string>(() => builtInMethods[0] ?? extraMethods[0]?.code ?? 'cash');
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
  // A266: the receipt needs the business record, but useBusiness() is null on the
  // POS surface for managers — which left the receipt preview a blank white box and
  // the printed receipt without a name. Fall back to fetching /api/business (works
  // via the POS token) so the receipt always has a business.
  const [resolvedBusiness, setResolvedBusiness] = useState<Business | null>(business ?? null);
  const autoPrintedRef = useRef(false);
  useEffect(() => {
    if (business) { setResolvedBusiness(business); return; }
    api.get<Business>('/api/business').then(b => setResolvedBusiness(b)).catch(() => {});
  }, [business]);

  // Free the table the moment payment succeeds, not when the receipt is dismissed.
  // Previously the table only cleared via the receipt's "New Sale" button, so
  // navigating away left it stuck "Occupied" with the already-paid order.
  useEffect(() => {
    if (completedOrder) onPaid?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completedOrder?.orderId]);
  const [receiptPhone, setReceiptPhone] = useState('');
  // A194: optional free-text customer name for a walk-in (call-ahead / named
  // collection). Falls back to an attached loyalty customer's name if left blank.
  const [customerName, setCustomerName] = useState('');
  // A607: the name from the customer's details for this sale, when the cashier took them (SaleCustomerPanel).
  useEffect(() => { const n = buyer?.sale.customer_name; if (n) setCustomerName((c) => c || n); }, [buyer?.sale.customer_name]);

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
  const { session, hasPermission } = usePOSAuth();
  // A490: giving a discount on a sale is sales.discount — without it no manual discount (a promo code) reaches the
  // sale; offers (automatic) are not a discount the cashier gives and still come off.
  // A595 (owner decision D6): a set-up discount or promo code is sales.discount_preset (typing an amount stays sales.discount;
  // this screen applies set-up ones only — the cloud checks the discount named and its amount).
  const mayDiscount = hasPermission('sales.discount') || hasPermission('sales.discount_preset');

  // Double-submit protection. chargingRef blocks a second call synchronously
  // (before React re-renders the button as disabled — a fast touchscreen
  // double-tap otherwise fires two orders). idempotencyKey is a stable id for
  // this sale sent in the order body; the server dedupes on it, so even if two
  // requests slip through, only one order is created.
  const chargingRef = useRef(false);
  // A511: a sale on account by someone without customers.credit needs a manager's PIN (the cloud answers
  // CREDIT_APPROVAL_REQUIRED); asked for here, then the same sale is sent again with it.
  const [creditPin, setCreditPin]       = useState('');
  const [needCreditPin, setNeedCreditPin] = useState(false);
  const creditPinField = () => (creditPin.trim() ? { credit_pin: creditPin.trim() } : {});
  const onCreditRefusal = (err: any): boolean => {
    const code = err?.code;
    if (code === 'CREDIT_APPROVAL_REQUIRED') { setNeedCreditPin(true); setError(''); return true; }
    if (needCreditPin && (code === 'INVALID_APPROVER_PIN' || code === 'SELF_APPROVAL' || code === 'PIN_LOCKED' || code === 'NO_OVERRIDE_CONFIGURED')) {
      setCreditPin(''); setError(err.message ?? 'That PIN cannot approve this sale.'); return true;
    }
    return false;
  };
  const idempotencyKeyRef = useRef<string>('');
  if (!idempotencyKeyRef.current) {
    idempotencyKeyRef.current = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  const rawLoyaltyDiscount = loyaltyState?.discountAmount ?? 0;
  const rawPromoDiscount   = mayDiscount ? (discountState?.discount_amount ?? 0) : 0;
  const rawDiscount        = rawLoyaltyDiscount + rawPromoDiscount;

  // Clamp the combined discount to the server's ceiling BEFORE charging. The
  // server recomputes the order with the same cap and stores the capped total;
  // if this client charged the uncapped total, the payment legs would not
  // reconcile to what the server stored — previously a silent mismatch, now
  // (with the atomic-order guard) a rejected sale. capDiscountPct mirrors the
  // server's capDiscount exactly.
  // A445: offers come off first and are not capped; the manual discount (loyalty + a promo code) is capped on what is
  // left — exactly as the cloud recomputes it (orders.ts) and the till does.
  const offerOff = Math.min(subtotal, Math.round(offers.reduce((s, o) => s + o.amount, 0) * 100) / 100);
  const cappedDiscount = capDiscountPct(rawDiscount, Math.round((subtotal - offerOff) * 100) / 100, maxDiscountPct);
  const discountWasCapped = cappedDiscount < rawDiscount - 0.005;
  /** The WHOLE discount: offers + the capped manual one (orders.discount_amount). */
  const allDiscount = Math.round((offerOff + cappedDiscount) * 100) / 100;
  const offerFields = offerOff > 0 ? { offer_discount: offerOff, offers } : {};

  // Split the capped amount back across loyalty and promo proportionally, so the
  // stored discount_amount and the receipt line items stay consistent. Loyalty
  // is honoured first (points were already reserved), promo takes the remainder.
  const loyaltyDiscount = Math.min(rawLoyaltyDiscount, cappedDiscount);
  const promoDiscount   = Math.max(0, cappedDiscount - loyaltyDiscount);

  // The total actually charged: subtotal minus the capped discount. `total` came
  // in reflecting the uncapped discount, so recompute rather than trust it.
  const chargedTotal  = Math.round((subtotal - allDiscount) * 100) / 100;
  // A349: VAT and the levy on what is actually CHARGED (after the capped discount), at the business's own rates — the
  // figures the receipt shows and the payload carries (the cloud recomputes and stores its own; they now agree).
  const taxes = extractTaxes(chargedTotal, Number(business?.vat_rate ?? 16), Number(business?.ctl_rate ?? 0) || 0);
  const chargedVat = taxes.vat, chargedCtl = taxes.ctl;

  // Tip is added on top of the order total — this is what the customer pays.
  // 0.6.27: and the delivery fee on top (pass-through to the rider — not in the bill or its taxes).
  const grandTotal    = Math.round((chargedTotal + tipAmount + deliveryFee) * 100) / 100;
  // A blank cash field means "pay exact". Without this the Confirm button stays
  // disabled with no feedback even though the field shows the total as a
  // placeholder — cashiers only type a value when the customer hands over more.
  const tenderedNum   = (method === 'cash' && tendered.trim() === '') ? grandTotal : (parseFloat(tendered) || 0);
  const change        = method === 'cash' ? Math.max(0, tenderedNum - grandTotal) : 0;
  const cashValid     = method !== 'cash' || tenderedNum >= grandTotal;
  const pointsRedeemed   = loyaltyState?.pointsToRedeem ?? 0;
  const multiplier       = loyaltyState?.tier.multiplier ?? 1;
  const estimatedPoints  = Math.floor(Math.floor(chargedTotal / 10) * multiplier);

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
  const creditValid = method !== 'credit' || (!!customerId && !!creditInfo && creditInfo.available_credit >= grandTotal);

  // Quick-tender presets: Exact, the nearest common notes above the total, and
  // a round-up to the next 100. These just fill the tendered field — the manual
  // input remains for odd tenders (mixed notes/coins).
  const quickTenders = (() => {
    const base = total + tipAmount + deliveryFee;
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
      ...creditPinField(),   // A511
      idempotency_key: idempotencyKeyRef.current,
      branch_id:       branchId,
      order_number:    generateOrderNumber(),
      order_type:      orderType,
      table_number:    tableNumber ?? null,
      // 0.6.27: the rider, and the fee on top (the cloud pays the rider it from this shift's drawer).
      delivery_person: orderType === 'delivery' ? rider : null,
      ...(orderType === 'delivery' ? feeFields : {}),   // 0.6.33: + delivery_free
      subtotal,
      vat_amount:      chargedVat,
      ctl_amount:      chargedCtl,
      discount_amount: allDiscount,
      ...offerFields,   // A445
      discount_id:     mayDiscount ? (discountState?.discount.id ?? null) : null,
      total:           chargedTotal,
      tip_amount:      tipAmount,
      customer_id:     loyaltyState?.customer.id ?? buyer?.sale.customer_id ?? null,
      customer_name:   (customerName.trim() || loyaltyState?.customer.name) ?? null,
      customer_phone:  loyaltyState?.customer.phone ?? buyer?.sale.customer_phone ?? null,
      ...(buyer?.sale.buyer_kra_pin ? { buyer_kra_pin: buyer.sale.buyer_kra_pin } : {}),   // A607: on the invoice and to KRA
      points_redeemed: pointsRedeemed,
      shift_id:        shiftId ?? null,
      // Petrol attribution (audit B5). The server reads req.body.pump_id and
      // hands it to applyStockEffects, which uses it to resolve the pump's
      // assigned tank. Absent, it guesses by grade.
      pump_id:         pumpId ?? null,
      items: cart.map(item => ({
        product:           { id: item.product.id, name: item.product.name, categories: item.product.categories ?? null },
        unitPrice:          item.unitPrice,
        quantity:           item.quantity,
        lineTotal:          item.lineTotal,
        selectedVariants:   item.selectedVariants,
        selectedModifiers:  item.selectedModifiers,
        notes:              item.notes ?? null,   // A367
      })),
      notes: orderNote?.trim() || null,   // A367
      payments,
    };
  }

  // ── Build /pay body (order already open, sent to kitchen first) ───────────
  // The server recomputes the amount due as subtotal − capDiscount(discount_amount)
  // + tip_amount (+ delivery_fee, 0.6.27) and refuses legs that don't match
  // (PAYMENT_MISMATCH). The legs carry grandTotal, so the discount, tip and fee
  // that produced it must travel too — the same money fields buildOrderPayload sends.
  function buildPayPayload(payments: object[]) {
    return {
      ...creditPinField(),   // A511
      payments,
      discount_amount: allDiscount,
      ...offerFields,   // A445
      discount_id:     mayDiscount ? (discountState?.discount.id ?? null) : null,
      tip_amount:      tipAmount,
      ...feeFields,   // 0.6.33: + delivery_free (the cloud then leaves the fee out of the amount due)
      ...(buyer?.sale.buyer_kra_pin ? { buyer_kra_pin: buyer.sale.buyer_kra_pin } : {}),   // A607
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
      setError('No branch is set for this session. Please lock the POS and sign in again.');
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
        endpoint, existingOrderId ? buildPayPayload(payments) : buildOrderPayload(payments)
      );
      setCompletedOrder(makeCompletedOrder(
        orderNumber,
        [{ method, amount: grandTotal, reference: '' }],
        method === 'cash' ? tenderedNum : grandTotal,
        method === 'cash' ? change : 0,
        orderId ?? existingOrderId,
      ));
    } catch (err: any) {
      if (!onCreditRefusal(err)) setError(err.message ?? 'Failed to process payment');   // A511
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
        endpoint, existingOrderId ? buildPayPayload(payments) : buildOrderPayload(payments)
      );
      setCompletedOrder(makeCompletedOrder(
        orderNumber,
        legs.map(l => ({ method: l.method, amount: l.amount, reference: l.reference ?? '' })),
        total, 0,
        orderId ?? existingOrderId,
      ));
    } catch (err: any) {
      if (!onCreditRefusal(err)) setError(err.message ?? 'Failed to process split payment');   // A511
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

  // Silent thermal via the bridge when connected + a receipt printer is paired.
  // Returns true if it printed, false if the bridge path isn't available/failed.
  const printViaBridge = async (): Promise<boolean> => {
    const printerName = printerSettings.receiptPrinterName;
    if (!(completedOrder && printerName && resolvedBusiness && getQZStatus() === 'connected')) return false;
    try {
      const order = buildReceiptOrder({
        orderNumber: completedOrder.orderNumber,
        orderType, cashierName: session?.staffName ?? 'Cashier',
        // A349: the BILL (after discount, before tip) with the discount and tip beside it — grandTotal (bill + tip)
        // could never reconcile with the lines, so the thermal receipt threw and fell back to the browser dialog.
        cart, total: chargedTotal, discount: allDiscount, offers: offerOff > 0 ? offers : undefined, tip: tipAmount, deliveryFee, deliveryFree: free, change: completedOrder.change,
        payments: completedOrder.payments.map(p => ({ method: p.method, amount: p.amount })),
        tableNumber,
        orderNote,   // A367
        buyerPin: buyer?.sale.buyer_kra_pin,   // A607
      });
      const biz = buildReceiptBusinessConfig(resolvedBusiness, printerSettings.footerMessage, 0,
        { branchName, header: receiptHeader, footerText: receiptFooter, logoRaster: receiptLogo, pay: receiptPay, posFeatures });   // A530
      const bytes = renderEscPos(order, biz, printerSettings.paperWidth);
      const copies = printerSettings.copies ?? 1;
      for (let i = 0; i < copies; i++) {
        await printBytesToServer(`printer:${printerName}`, bytes);
      }
      return true;
    } catch (e: any) {
      console.warn('[receipt] bridge print failed:', e?.message);
      return false;
    }
  };

  const handlePrint = async () => {
    if (await printViaBridge()) return;
    // Fallback: the browser print dialog (never blocks the cashier).
    const content = receiptRef.current;
    if (content) printReceipt(content.innerHTML, printerSettings, resolvedBusiness?.name ?? 'Receipt');
  };

  // A266: auto-print the receipt once on payment success (silent bridge path only —
  // no browser dialog), matching the desktop. Waits for resolvedBusiness so the
  // receipt carries the business name. The Print button remains for a reprint.
  useEffect(() => {
    if (completedOrder && resolvedBusiness && !autoPrintedRef.current) {
      autoPrintedRef.current = true;
      void printViaBridge();
    }
  }, [completedOrder?.orderId, resolvedBusiness]);

  // ── Receipt screen ────────────────────────────────────────────────────────
  if (completedOrder) {
    return (
      <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 px-4">
        <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-sm overflow-hidden animate-pop-in">
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
              business={resolvedBusiness as Business}
              branchName={branchName}
              orderNumber={completedOrder.orderNumber}
              etims={completedOrder.etims}
              tip={tipAmount}
              deliveryFee={deliveryFee}
              deliveryFree={free}
              cart={cart}
              total={chargedTotal}
              subtotal={subtotal}
              vatAmount={chargedVat}
              ctlAmount={chargedCtl}
              ctlRate={Number(business?.ctl_rate ?? 0) || 0}
              currency={currency}
              payments={completedOrder.payments}
              tendered={completedOrder.tendered}
              change={completedOrder.change}
              loyaltyDiscount={loyaltyDiscount}
              promoDiscount={promoDiscount}
              promoName={discountState?.discount.name}
              customerName={customerName.trim() || loyaltyState?.customer.name}
              buyerPin={buyer?.sale.buyer_kra_pin}   // A607
              footerMessage={printerSettings.footerMessage}
              compact={posFeatures?.receipt_compact_layout === true}   // A538: compact only when the client opted in (A534 had classic)
              pay={receiptPay}   // A547: "Payment Details: Buy Goods - <number>" heads the payment block, as on the thermal receipt
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
                  className="flex-shrink-0 text-xs bg-[rgb(var(--act-strong,37_99_235))] hover:bg-[rgb(var(--act-strong,59_130_246))] text-[rgb(var(--act-on,255_255_255))] px-3 py-1 rounded-lg font-medium transition-colors">
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
              className="flex-1 bg-action-500 hover:bg-action-400 text-gray-950 font-bold rounded-xl py-2.5 text-sm transition-colors">
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
        <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-sm p-6 space-y-4 animate-pop-in">
          <div className="flex items-center justify-between">
            <h2 className="text-white font-semibold text-lg">M-Pesa payment</h2>
            <span className="text-gray-500 text-sm">{mpesaPending.orderNumber}</span>
          </div>
          <MpesaStkPanel
            total={grandTotal}
            currency={currency}
            orderId={mpesaPending.orderId}
            phone={buyer?.stkPhone} masked={buyer?.masked}   // A607
            onSuccess={handleMpesaSuccess}
            onCancel={handleMpesaCancel}
          />
        </div>
      </div>
    );
  }

  // ── Payment entry screen ──────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 px-4 py-6 animate-fade-in">
      <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-sm flex flex-col max-h-full overflow-hidden animate-pop-in">
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
            <p className="text-white text-3xl font-bold mt-1">{currency} {fmt(grandTotal)}</p>
            {offerOff > 0 && offers.map((o) => (
              <p key={o.offer_id} data-testid="payment-offer" className="text-amber-300 text-xs mt-1">Includes offer {o.name}: {currency} {fmt(o.amount)}</p>
            ))}
            {loyaltyDiscount > 0 && <p className="text-green-400 text-xs mt-1">⭐ Includes {currency} {fmt(loyaltyDiscount)} loyalty discount</p>}
            {promoDiscount  > 0 && <p className="text-yellow-400 text-xs mt-0.5">🏷️ Includes {currency} {fmt(promoDiscount)} promo discount</p>}
            {discountWasCapped && (
              <p className="text-orange-400 text-xs mt-0.5">
                ⚠️ Discount capped at {maxDiscountPct}% — {currency} {fmt(rawDiscount - cappedDiscount)} above the limit was not applied.
              </p>
            )}
            {loyaltyState && estimatedPoints > 0 && <p className="text-yellow-500 text-xs mt-0.5">Customer earns ~{estimatedPoints} pts</p>}
          </div>

          {/* A194: optional customer name — for a call-ahead / named collection ticket.
              Hidden when a loyalty customer is attached (their name is used instead). */}
          {!loyaltyState?.customer.name && (
            <div className="flex items-center gap-2 bg-gray-800/50 border border-gray-700 rounded-xl px-3 py-2">
              <span className="text-sm flex-shrink-0">🧾</span>
              <input
                type="text"
                value={customerName}
                onChange={e => setCustomerName(e.target.value)}
                placeholder="Customer name (optional)"
                maxLength={60}
                className="flex-1 bg-transparent text-white text-sm focus:outline-none placeholder-gray-600"
              />
            </div>
          )}

          {/* Split toggles */}
          <div className="flex items-center justify-between">
            <p className="text-gray-400 text-sm">Split payment (by method)</p>
            <button
              onClick={() => { setSplitMode(s => !s); setEvenSplitMode(false); setByItemMode(false); }}
              className={`relative w-10 h-5 rounded-full transition-colors ${splitMode ? 'bg-action-500' : 'bg-gray-700'}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${splitMode ? 'translate-x-5' : ''}`} />
            </button>
          </div>
          <div className="flex items-center justify-between">
            <p className="text-gray-400 text-sm">Split evenly (per person)</p>
            <button
              onClick={() => { setEvenSplitMode(s => !s); setSplitMode(false); setByItemMode(false); }}
              className={`relative w-10 h-5 rounded-full transition-colors ${evenSplitMode ? 'bg-action-500' : 'bg-gray-700'}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${evenSplitMode ? 'translate-x-5' : ''}`} />
            </button>
          </div>

          {/* ── EVEN SPLIT (per person) ── */}
          {evenSplitMode && (
            <EvenSplitPanel
              total={grandTotal}
              currency={currency}
              onConfirm={handleSplitCharge}
              onCancel={() => setEvenSplitMode(false)}
            />
          )}
          <div className="flex items-center justify-between">
            <p className="text-gray-400 text-sm">Split by item (per guest)</p>
            <button
              onClick={() => { setByItemMode(s => !s); setSplitMode(false); setEvenSplitMode(false); }}
              className={`relative w-10 h-5 rounded-full transition-colors ${byItemMode ? 'bg-action-500' : 'bg-gray-700'}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${byItemMode ? 'translate-x-5' : ''}`} />
            </button>
          </div>

          {/* ── BY-ITEM SPLIT (per guest) ── */}
          {byItemMode && (
            <ByItemSplitPanel
              items={cart.map(c => ({ name: c.product.name, qty: c.quantity, amount: c.lineTotal }))}
              total={grandTotal}
              currency={currency}
              onConfirm={handleSplitCharge}
              onCancel={() => setByItemMode(false)}
            />
          )}

          {/* ── SPLIT PAYMENT (by method) ── */}
          {splitMode && !evenSplitMode && !byItemMode && (
            <SplitPaymentPanel
              enabledMethods={builtInMethods}
              total={grandTotal}
              currency={currency}
              onConfirm={handleSplitCharge}
              onCancel={() => setSplitMode(false)}
            />
          )}

          {/* ── SINGLE PAYMENT ── */}
          {!splitMode && !evenSplitMode && !byItemMode && (
            <>
              {/* Method tabs */}
              <div className="grid grid-cols-4 gap-2">
                {builtInMethods.map(m => (
                  <button key={m} onClick={() => setMethod(m)} aria-pressed={method === m}
                    className={`py-3 rounded-xl text-sm border transition-colors ${
                      method === m
                        ? 'font-bold'
                        : 'font-medium bg-gray-800 border-gray-700 text-gray-300 hover:border-gray-600'
                    }`}
                    // A344: each method in its own colour. A430: the SELECTED one solid in it, white text, a halo and a ✓.
                    style={method === m ? { backgroundColor: methodSolid(m), borderColor: methodSolid(m), color: '#ffffff', boxShadow: `0 0 0 3px ${methodTint(m, 0.45)}` } : { backgroundColor: methodTint(m), borderColor: methodColour(m).dot }}>
                    {method === m ? <span aria-hidden className="mr-1">✓</span> : <MethodDot method={m} />}{m === 'cash' ? '💵' : m === 'mpesa' ? '📱' : m === 'card' ? '💳' : '🧾'}<br />
                    <span className="capitalize">{m === 'mpesa' ? 'M-Pesa' : m === 'credit' ? 'On Account' : m}</span>
                  </button>
                ))}
                {/* A429: the branch's other methods, then the business's own (A96) — settle immediately like a card. */}
                {extraMethods.map(cm => (
                  <button key={cm.code} onClick={() => setMethod(cm.code)} aria-pressed={method === cm.code}
                    className={`py-3 rounded-xl text-sm border transition-colors ${
                      method === cm.code
                        ? 'font-bold'
                        : 'font-medium bg-gray-800 border-gray-700 text-gray-300 hover:border-gray-600'
                    }`}
                    style={method === cm.code ? { backgroundColor: methodSolid(cm.code), borderColor: methodSolid(cm.code), color: '#ffffff', boxShadow: `0 0 0 3px ${methodTint(cm.code, 0.45)}` } : { backgroundColor: methodTint(cm.code), borderColor: methodColour(cm.code).dot }}>
                    {method === cm.code ? <span aria-hidden className="mr-1">✓</span> : <MethodDot method={cm.code} />}{cm.icon}<br />
                    <span>{cm.name}</span>
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
                            active ? 'bg-action-500/10 border-action-500 text-action-400'
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
                  {(tipAmount > 0 || deliveryFee > 0) && (
                    <div className="bg-gray-800 rounded-lg px-4 py-2 flex justify-between text-sm" data-testid="collect-total">
                      <span className="text-gray-400">Total to collect (incl. {[tipAmount > 0 ? 'tip' : '', deliveryFee > 0 ? `delivery fee ${fmt(deliveryFee)}${rider ? ` — ${rider}` : ''}` : ''].filter(Boolean).join(' and ')})</span>
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
                              ? 'bg-action-500/10 border-action-500 text-action-400'
                              : 'bg-gray-800 border-gray-700 text-gray-300 hover:border-gray-600'
                          }`}>
                          {v === Math.ceil(total + tipAmount) ? 'Exact' : fmt(v)}
                        </button>
                      ))}
                    </div>
                    <input
                      type="number" value={tendered}
                      onChange={e => setTendered(e.target.value)}
                      placeholder={fmt(grandTotal)} min={grandTotal} autoFocus
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-600 focus:outline-none focus:border-action-500 transition-colors text-lg font-semibold"
                    />
                  </div>
                  {tenderedNum >= grandTotal && (
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
                  <p className="text-white font-semibold">M-Pesa — {currency} {fmt(grandTotal)}</p>
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
                  <p className="text-white font-semibold">Card — {currency} {fmt(grandTotal)}</p>
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
                    <p className="text-gray-400 text-sm text-center"><span className="spin-dot" aria-hidden />Loading credit account…</p>
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
                        <span className={creditInfo.available_credit >= grandTotal ? 'text-green-400 font-semibold' : 'text-red-400 font-semibold'}>
                          {currency} {fmt(creditInfo.available_credit)}
                        </span>
                      </div>
                      {creditInfo.available_credit < total && (
                        <p className="text-red-400 text-xs text-center pt-1">
                          This sale ({currency} {fmt(grandTotal)}) exceeds available credit.
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

          {/* A511: a manager approves a sale on account. */}
          {needCreditPin && (
            <div className="bg-gray-800 rounded-xl p-4 space-y-2" data-testid="credit-approval">
              <p className="text-sm text-gray-200">A manager approves this sale on account — enter their PIN, then charge again.</p>
              <input type="password" inputMode="numeric" autoComplete="off" maxLength={6} value={creditPin}
                onChange={(e) => setCreditPin(e.target.value.replace(/\D/g, ''))} placeholder="Manager PIN"
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white tracking-widest text-center" />
            </div>
          )}

          {error && (
            <p className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {error}
            </p>
          )}
        </div>

        {/* Fixed footer — charge button */}
        {!splitMode && !evenSplitMode && !byItemMode && (
          <div className="px-6 pb-6 pt-4 border-t border-gray-800 flex-shrink-0">
            {method === 'mpesa' ? (
              <button
                onClick={handleInitiateMpesa}
                disabled={placing}
                className="w-full bg-action-500 hover:bg-action-400 disabled:opacity-40 disabled:cursor-not-allowed text-gray-950 font-bold rounded-xl py-3 transition-colors"
              >
                {placing && <span className="spin-dot" aria-hidden />}
                {placing ? 'Creating order…' : '📱 Initiate M-Pesa payment'}
              </button>
            ) : (
              <button
                data-testid="payment-confirm"
                onClick={handleCharge}
                disabled={placing || !cashValid || !creditValid}
                className="w-full bg-action-500 hover:bg-action-400 disabled:opacity-40 disabled:cursor-not-allowed text-gray-950 font-bold rounded-xl py-3 transition-colors"
              >
                {placing && <span className="spin-dot" aria-hidden />}
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
