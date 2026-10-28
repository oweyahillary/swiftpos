import { Router } from 'express';
import { cashierHistoryView } from '../lib/cashierHistory';   // 0.6.37 (A387)
import { getHistoryMethods } from '../lib/historyMethods';
import { cashierHistoryTotals, historyTotal } from '../lib/cashierShiftSales';   // A418
import { classifyOrderCreateError } from '../lib/orderErrors';
import { pickCashier, claimNeedsValidation } from '../lib/cashier';
import { sendError } from '../lib/sendError';
import { capDiscount } from '../lib/discountPolicy';
import { safeRouter } from '../middleware/asyncHandler';
import type { DbProduct, DbVariantGroup, DbModifierGroup, OrderItemInput, PaymentLegInput, DbOrder, DbPayment, DbCustomer } from '../lib/dbTypes';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { fireWebhook } from '../lib/webhooks';
import { requireAuth } from '../middleware/auth';
import { branchScope, requirePermission, assertBranchAccess, can, branchFilter, byBranch, oneBranchOnly } from '../middleware/rbac';

/** A490: the answer when someone without sales.discount gives a manual discount on a live web sale. */
const DISCOUNT_REFUSED = { error: 'You may not give a discount — ask a manager.', code: 'DISCOUNT_NOT_ALLOWED', detail: 'Missing permission: sales.discount' };
import { supabase } from '../lib/supabase';
import { resolveOrderId } from '../lib/resolveOrder';
import { terminalKey, terminalKeyFromRequest, deviceIdFromRequest } from '../lib/terminalKey';
import { checkDeviceBranch } from '../lib/deviceBinding';
import { getTier } from './loyalty';
import { verifyPin } from './auth';
import { findApprover, mayApprove, isOwnerRow, type ApproverRow, type ApproveAction } from '../lib/approver';
import { worksAtBranch } from '../lib/branchAccess';   // A552
import { checkLowStock, checkLowIngredients } from '../jobs/lowStockChecker';
import { applyStockEffects } from '../lib/stockEffects';
import { fiscaliseInvoice, fiscaliseCreditNote } from '../lib/etims';
import { sendReceiptWhatsApp } from '../lib/whatsapp';
import { cleanNote, ORDER_NOTE_MAX } from '../lib/orderNotes';
import { businessPosFeatures } from '../lib/posFeatureFlags';
import { callerMayConfirm, callerMayApprove, replayTime } from '../lib/shiftConfirm';
import { ownHistoryOnly, holds } from '../lib/historyScope';   // A490
import { cleanDeliveryFee, customerDeliveryFee, isFreeDelivery } from '../lib/delivery';
import { payRider, returnRiderPayout } from '../lib/riderPayout';
import { cleanVoidReason, cleanVoidNote, voidReasonLabel } from '../lib/kitchenLines';
import { confirmerByPin, confirmerRows, SELF_APPROVAL_BODY, NO_CONFIRMER_BODY } from '../lib/confirmerLookup';
import { businessReversalRules } from '../lib/reversalSettings';
import { voidWindowOpen, windowLabel } from '../lib/reversalRules';
import { frozenAtBranch } from '../lib/stockTakeAccess';
import { applyOffers, cleanOffer, type AppliedOffer, type OfferLine } from '../lib/offers';   // A445
import { promotionOffersByIds } from '../lib/promotionOffers';   // A518
import { chunkIn } from '../lib/pgQuery';
import { settleLateRows } from '../lib/lateRows';   // A522
import { withoutCosts } from '../lib/costAccess';   // A494
import { pinKey, pinLocked, notePinFailure, notePinSuccess, PIN_LOCKED_BODY } from '../lib/pinAttempts';   // A494
import { isTillOwnSalePush } from '../lib/tillScope';   // A545
import { webSaleStockRefusal } from '../lib/stockGateStore';   // A563
import { recordCreditSale } from '../lib/creditConfirm';   // A545
import { isSoldByWeight, weighedAmountAccepted } from '../lib/scaleBarcode';   // A577
import { loadCreditRule, onApproverList, type CreditApprovalRule } from '../lib/creditApprovers';   // A585
import { isMasked, seesCustomerContacts, maskPhone } from '../lib/personalData';   // A595
import { branchCreditEnabled, branchLimitOf, owedAtBranch, creditAvailable, CREDIT_OFF_HERE } from '../lib/branchCredit';   // A595 D4

const router = safeRouter();
router.use(requireAuth);

/** A494: selling (a sale, an open bill, paying it, firing a course) is orders.create — the till's own session included. */
const sells = requirePermission('orders.create');

/** A494: an approver of a void or refund is never the person asking (the owner self-authorises, as before). */
const SELF_APPROVAL = {
  error: 'Someone else must approve this - enter the PIN of another manager (or the owner).',
  code:  'SELF_APPROVAL',
} as const;

/**
 * A505 (pre-deployment audit, 2026-10-15): a sale a TILL already made and took the money for — it carries the till's own
 * time (created_at / client_created_at: the P0-2 till-sale shape) — sent by a person's PIN sign-in on that till. Every
 * till pushes its outbox with whoever is signed in (syncEngine pushAuthHeaders); a till on 1.0.15 or older never re-sends
 * a refused sale under its own session, it counts the 403 towards 'failed' and gives up after 5 tries: the sale — already
 * paid, printed and in the drawer — never reaches the cloud. Scenarios: a role without orders.create (no till build
 * checks that key before selling) rings a sale; a discount approved at the counter (or a key removed between the sale and
 * its push) under the cashier's session. Such a sale is recorded as the till's (as its own session would be): the
 * person's keys are not re-checked here. It opens nothing new: a desktop token's till sale is already stored at the
 * TILL's prices (tillPricing, P0-2) with any difference flagged for the owner. Logged.
 */
function tillMadeSale(req: any): boolean {
  return !req.isTill && req.surface === 'desktop' && req.pinSignIn === true
    && req.method === 'POST' && req.path === '/'   // the sale push only — never /open, /:id/pay (live, at the counter)
    && !!(req.body?.created_at || req.body?.client_created_at);
}
const a505Logged = new Map<string, number>();
function logTillMadeSale(req: any, what: string): void {
  const key = `${req.businessId}|${req.userId}|${what}`;
  const now = Date.now();
  if ((a505Logged.get(key) ?? 0) > now - 3_600_000) return;   // once an hour per person and reason
  if (a505Logged.size > 10_000) a505Logged.clear();
  a505Logged.set(key, now);
  console.warn(`[orders] A505: a till's sale accepted without ${what} under a person's till sign-in (business ${req.businessId}, user ${req.userId}, X-Device-Id ${String(req.headers?.['x-device-id'] ?? '').slice(0, 64) || '-'}, order ${String(req.body?.order_number ?? '').slice(0, 40)})`);
}

/** A494 + A505: POST / — orders.create, except a till's own sale sent under a person's till sign-in (tillMadeSale). */
const sellsOrTillSale = (req: any, res: any, next: any): void => {
  if (tillMadeSale(req) && !can(req, 'orders.create')) { logTillMadeSale(req, 'orders.create'); next(); return; }
  sells(req, res, next);
};

/**
 * A494: a manual discount (not an offer) without sales.discount is accepted only from a TILL's own session sending a sale
 * it made already (the till checked its person at the counter). Any person's session — the web POS, or a person's sign-in
 * on a till (a desktop token can be used from anywhere) — needs the key.
 * A505: except a sale the till already made (tillMadeSale) — refusing it lost the sale on a till before 1.0.16.
 */
async function discountRefused(req: any, manual: number, preset?: { discountId: unknown; base: number }): Promise<boolean> {
  if (!(manual > 0) || req.isTill || can(req, 'sales.discount')) return false;
  if (tillMadeSale(req)) { logTillMadeSale(req, 'sales.discount'); return false; }
  // A595 (docs/PERMISSIONS-AUDIT.md F16): a SET-UP discount is its own part of sales.discount (sales.discount_preset) — the
  // discount named (discount_id, this business's, active) and no more than it gives on this sale; a typed amount is not.
  if (preset && typeof preset.discountId === 'string' && preset.discountId && can(req, 'sales.discount_preset')) {
    const { data: d } = await supabase.from('discounts').select('type, value, status')
      .eq('id', preset.discountId).eq('business_id', req.businessId).maybeSingle();
    const row = d as { type?: string; value?: number | string; status?: string } | null;
    if (row && row.status === 'active') {
      const v = Number(row.value) || 0, base = Math.max(0, Number(preset.base) || 0);
      const most = row.type === 'percentage' ? round2((base * v) / 100) : Math.min(v, base);
      if (manual <= most + 0.01) return false;
    }
  }
  return true;
}

// Round to 2 dp (money) avoiding binary-float drift.
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// ── Payment integrity check (audit H1, detection only) ───────────────────────
//
// Nothing has ever verified that the payment legs on an order sum to the order
// total. A mismatch is money: the drawer and the books describe different sales,
// and it surfaces days later as an unexplained cash variance.
//
// This LOGS and does not reject. That is a deliberate choice for a pilot: an
// enforcement bug here refuses a real sale at the counter, mid-service, which is
// a worse failure than the one being prevented. Run detection for a week of live
// data first, confirm it is silent, then consider turning it into a 400.
//
// The log line is greppable: search the server log for [payment-mismatch].
function checkPaymentIntegrity(
  orderNumber: string,
  orderId: string,
  total: number,
  legs: Array<{ method?: string; amount?: unknown }>,
): void {
  const paid = legs.reduce((sum, l) => sum + (Number(l.amount) || 0), 0);
  const diff = Math.round((paid - total) * 100) / 100;
  if (Math.abs(diff) < 0.01) return;

  console.error(
    `[payment-mismatch] order ${orderNumber} (${orderId}): legs sum to ${paid.toFixed(2)} `
    + `but total is ${total.toFixed(2)} — difference ${diff > 0 ? '+' : ''}${diff.toFixed(2)}. `
    + `Legs: ${legs.map(l => `${l.method ?? '?'} ${Number(l.amount) || 0}`).join(', ') || '(none)'}`,
  );
}

// ── Discount ceiling (pilot stopgap for finding M4) ──────────────────────────
// Manual discounts were ungated (A490: a live web sale's manual discount is now sales.discount): no reason code, no
// supervisor authorisation, and the only limit was the order subtotal — so a
// cashier could zero out any sale. That is the most common POS fraud vector.
//
// The ceiling itself now lives in lib/discountPolicy so pos/init can advertise
// it to the till, which clamps to the same number before it prints anything.
// Enforcement here is unchanged and remains authoritative.

// A514 (owner, 2026-10-16: "Retire it completely"): the business-wide supervisor PIN (business_settings
// supervisor_pin_hash, or a plaintext supervisor_pin from before hashing) no longer approves anything — only a person's own
// PIN does (their sign-in PIN, or the approval PIN an owner or manager gives them in Staff). The stored hash is left in
// the database untouched; nothing reads it, and POST /api/business/settings refuses to write it (SUPERVISOR_PIN_RETIRED).

// Who approves a void or refund (A355, lib/approver.ts): an override PIN, or the approver's OWN sign-in PIN when their
// role may approve (owner, the owner's role, '*', or A490 sales.void / sales.refund — managers by default). If
// `authorizerId` is supplied (a supervisor picked from a list), only that person is checked. 'no_authorizers' = nobody
// at the branch can approve with a PIN — A514: the answer is NO_OVERRIDE_CONFIGURED (there is no business PIN to fall back on).
async function verifyOverrideAuthorizer(
  businessId:   string,
  authorizerId: string | undefined,
  pin:          string | undefined,
  action:       ApproveAction,   // A490: a void's approver holds sales.void, a refund's sales.refund
  scope:        { branchId?: string | null; actorId?: string | null; may?: (row: ApproverRow, ownerId: string | null | undefined) => boolean } = {},   // A494: the sale's branch; who asks; A585: who may (the owner's credit approvers)
): Promise<{ result: 'ok' | 'invalid' | 'no_authorizers' | 'self'; userId?: string }> {
  const [{ data: rows }, { data: biz }] = await Promise.all([
    supabase
      .from('users')
      .select('id, pin_hash, override_pin_hash, roles ( name, role_permissions ( permissions ( key ) ) ), user_permissions ( granted, permissions ( key ) ), user_branches ( branch_id )')
      .eq('business_id', businessId)
      .eq('status', 'active'),
    supabase.from('businesses').select('owner_id').eq('id', businessId).maybeSingle(),
  ]);
  // A494: the approver works at the sale's branch, and is never the person asking (lib/approver.ts; the owner may).
  const found = await findApprover((rows ?? []) as ApproverRow[], { pin, authorizerId, ownerId: (biz as any)?.owner_id ?? null,
    may: scope.may ?? ((row, ownerId) => mayApprove(row, ownerId, action)), branchId: scope.branchId ?? null, actorId: scope.actorId ?? null }, {
    loginPin:    async (p, h) => (await verifyPin(p, h, businessId)).valid,
    overridePin: (p, h) => bcrypt.compare(p, h),
  });
  if (found.result === 'ok') return { result: 'ok', userId: found.userId };
  if (found.result === 'self') return { result: 'self' };   // A505: the asker's own PIN
  return { result: found.result === 'none' ? 'no_authorizers' : 'invalid' };
}

/**
 * A451: the person recorded on a void / refund (voided_by, authorized_by, refunded_by, …) — always a users row of this
 * business, the column's foreign key. An owner whose sign-in carries no users row (auth.ts's last-resort token: the
 * auth.users id) is recorded as the business's owner row when there is one, else as nobody. Before, that owner's every
 * void and refund on the web failed with a 500 — the database refused the id (owner, 2026-10-12, order 8a523b99…).
 */
async function recordedPerson(businessId: string, userId: string | null | undefined, isOwner: boolean): Promise<string | null> {
  const ofBusiness = async (id: string) => {
    const { data } = await supabase.from('users').select('id').eq('id', id).eq('business_id', businessId).maybeSingle();
    return !!data;
  };
  if (userId && await ofBusiness(userId)) return userId;
  if (!isOwner) return null;
  const { data: biz } = await supabase.from('businesses').select('owner_id').eq('id', businessId).maybeSingle();
  const ownerId = (biz as { owner_id?: string | null } | null)?.owner_id ?? null;
  return ownerId && await ofBusiness(ownerId) ? ownerId : null;
}

/**
 * A494: the approver of a void or refund by PIN — the person's own (sign-in or approval/override) PIN. Every PIN is behind
 * the one PIN limiter (lib/pinAttempts.ts): a caller's wrong PINs lock their PIN entry for a while, the right one too. The
 * approver is never the person asking (a non-owner; the owner self-authorises before this is reached).
 * A514: the business-wide supervisor PIN is retired — it is a wrong PIN like any other (INVALID_APPROVER_PIN, counted); a
 * branch where nobody may approve with a PIN answers NO_OVERRIDE_CONFIGURED (give someone who may approve a PIN in Staff - A518: their sign-in PIN already approves).
 */
async function approverByPin(req: any, authorizerId: string | undefined, pin: string | undefined, action: ApproveAction, branchId: string | null,
  may?: (row: ApproverRow, ownerId: string | null | undefined) => boolean):   // A585: the owner's credit approvers, when on
  Promise<{ userId: string | null } | { status: number; body: Record<string, string> }> {
  const key = pinKey(req);
  if (pinLocked(key)) return { status: 429, body: { ...PIN_LOCKED_BODY } };
  const ov = await verifyOverrideAuthorizer(req.businessId, authorizerId, pin, action, { branchId, actorId: req.userId ?? null, may });
  if (ov.result === 'ok') {
    notePinSuccess(key);
    if (!req.isOwner && ov.userId && ov.userId === req.userId) return { status: 403, body: { ...SELF_APPROVAL } };
    return { userId: ov.userId ?? null };
  }
  // A505: the asker's OWN PIN — not a wrong guess: told someone else must approve, never a strike towards the PIN lock.
  if (ov.result === 'self') return { status: 403, body: { ...SELF_APPROVAL } };
  if (ov.result === 'no_authorizers') return { status: 400, body: may ? { ...NO_CHOSEN_APPROVER } : { ...NO_APPROVER } };
  if (String(pin ?? '').trim()) notePinFailure(key);
  return { status: 403, body: { ...APPROVER_PIN_REFUSED } };
}

// What the till/web is told when no approval matched (A355). One wording for void, refund and credit. A514: no business
// supervisor PIN is tried any more.
// ── A511: a sale on account (credit) ─────────────────────────────────────────
// Owner, 2026-10-16: "the manager has to approve credit gate that behind a managers pin its not a cashiers right". Who
// holds customers.credit (or the owner) sells on account as before; anyone else's credit leg needs the PIN of someone at
// the sale's branch who holds it (approverByPin 'credit': never their own, the PIN limiter; A514: no business supervisor PIN).
// The approver is written on the customer's ledger line. The web POS asks for the PIN on CREDIT_APPROVAL_REQUIRED.
const CREDIT_APPROVAL_REQUIRED = {
  error: "A sale on account needs a manager's approval — enter their PIN.",
  code:  'CREDIT_APPROVAL_REQUIRED',
} as const;
// A545 (owner, 2026-10-21: "for credit I think the manager has to know which sale is on credit and they have to confirm
// that it was done"): a credit sale a till ALREADY TOOK — pushed under the till's own sign-in (tillScope
// isTillOwnSalePush, the precise exemption) or a person's sign-in on that till (A505 tillMadeSale) — is RECORDED, never
// refused for a PIN the till cannot send; it waits for a manager's confirmation (lib/creditConfirm.ts). Whoever is
// signed in when the till pushes is not who approved it, so it is never born confirmed. Everything else is A511 as it was
// — the live web POS still needs the manager's PIN at the moment of sale, and that approval is the confirmation.
type CreditOk = { approvedBy: string | null; approvedAtSale: boolean; approverName: string | null; note: string; tillSale: boolean };
export async function creditApproval(req: any, body: any, branchId: string | null):   // exported for tests (A585)
  Promise<CreditOk | { status: number; body: Record<string, string> }> {
  // A585: the owner's choice of who approves (lib/creditApprovers.ts) — off: A511 / A552 exactly as before.
  const rule = await loadCreditRule(req.businessId);
  if (isTillOwnSalePush(req) || tillMadeSale(req)) {
    // A552: the till approved it AT THE SALE (the seller holding customers.credit, or a manager's PIN checked on the till)
    // and names who (`credit_approved_by`) — born confirmed by that person, as a web sale approved with a PIN is. The
    // person is checked here as the A545 replay checks `by`: customers.credit (or the owner), working at the sale's branch.
    // Anyone else named, or no one, is a till's sale awaiting a manager (A545). Never refused either way.
    const named = await tillCreditApprover(req.businessId, body?.credit_approved_by, branchId, rule);
    if (named) {
      return { approvedBy: named.id, approvedAtSale: true, approverName: named.name, note: ` — approved by ${named.name || 'a manager'} at the POS`, tillSale: true };
    }
    return { approvedBy: null, approvedAtSale: false, approverName: null, note: " — awaiting a manager's confirmation", tillSale: true };
  }
  // A585: ON — the seller approves it themselves only when they are the owner or on this branch's list; anyone else needs
  // the PIN of someone on it. OFF — customers.credit, as A511.
  const sellerApproves = rule.on
    ? onApproverList(rule, branchId, req.userId ? { id: String(req.userId) } : null, { isOwner: !!req.isOwner })
    : (req.isOwner || can(req, 'customers.credit'));
  if (sellerApproves) {
    // The seller may approve it themselves: born confirmed by them (an owner with no users row is named "Owner").
    const me = await recordedPerson(req.businessId, req.userId, !!req.isOwner);
    return { approvedBy: me, approvedAtSale: true, approverName: me ? null : (req.isOwner ? 'Owner' : null), note: '', tillSale: false };
  }
  const pin = typeof body?.credit_pin === 'string' ? body.credit_pin.trim() : '';
  if (!pin) return { status: 403, body: rule.on ? { ...CHOSEN_APPROVAL_REQUIRED } : { ...CREDIT_APPROVAL_REQUIRED } };
  const a = await approverByPin(req, typeof body?.credit_authorizer_id === 'string' ? body.credit_authorizer_id : undefined, pin, 'credit', branchId,
    rule.on ? (row, ownerId) => isOwnerRow(row, ownerId) || onApproverList(rule, branchId, row, { ownerId }) : undefined);
  if ('status' in a) return a;
  let who = 'a manager';
  if (a.userId) {
    const { data: u } = await supabase.from('users').select('name').eq('id', a.userId).eq('business_id', req.businessId).maybeSingle();
    who = (u as { name?: string | null } | null)?.name || who;
  }
  return { approvedBy: a.userId, approvedAtSale: true, approverName: who, note: ` — approved by ${who}`, tillSale: false };
}

/**
 * A552: the person a till names as having approved its sale on account at the moment of sale, if they may — they hold
 * customers.credit (or are the owner) and work at the sale's branch (the owner anywhere). null = not one (unknown, a
 * cashier, another branch's manager, not a user id): the sale is recorded awaiting a manager, as any till's sale.
 */
export async function tillCreditApprover(businessId: string | undefined, by: unknown, branchId: string | null, rule?: CreditApprovalRule):
  Promise<{ id: string; name: string | null } | null> {
  if (!businessId || typeof by !== 'string' || !/^[0-9a-f-]{36}$/i.test(by)) return null;
  try {
    const { rows, ownerId } = await confirmerRows(businessId);
    const row = rows.find((r) => r.id === by);
    if (!row) return null;
    // A585: ON — the owner, or someone on the sale's branch's list; OFF — customers.credit (A552).
    if (rule?.on) return isOwnerRow(row, ownerId) || onApproverList(rule, branchId, row, { ownerId }) ? { id: row.id, name: row.name ?? null } : null;
    if (!mayApprove(row, ownerId, 'credit')) return null;
    if (branchId && !isOwnerRow(row, ownerId) && !worksAtBranch(row.user_branches, branchId)) return null;
    return { id: row.id, name: row.name ?? null };
  } catch { return null; }
}

const APPROVER_PIN_REFUSED = {
  error: 'That PIN was not recognised. Enter the PIN of a manager (or the owner) on duty.',
  code:  'INVALID_APPROVER_PIN',
} as const;
// A585: the owner chose who approves sales on account.
const CHOSEN_APPROVAL_REQUIRED = {
  error: 'A sale on account needs the approval of someone the owner chose — enter their PIN.',
  code:  'CREDIT_APPROVAL_REQUIRED',
} as const;
const NO_CHOSEN_APPROVER = {
  error: 'Nobody at this branch may approve sales on account yet. The owner chooses who in Settings › Credit approvals.',
  code:  'NO_OVERRIDE_CONFIGURED',
} as const;
const NO_APPROVER = {
  error: 'Nobody at this branch can approve this yet. The owner or a manager gives someone who may approve a PIN in Staff.',
  code:  'NO_OVERRIDE_CONFIGURED',
} as const;

// ── Authoritative order pricing (shared by POST / and POST /open) ────────────
// Rebuilds every line from the catalogue so client-sent prices/totals can't be
// trusted. Mutates each line's selectedVariants[].priceAdjustment and
// selectedModifiers[].price to the authoritative DB values (so denormalised
// display rows stay truthful). Returns computed money or a structured error.
type RecomputeOk   = { ok: true; lines: { unitPrice: number; lineTotal: number }[]; subtotal: number; discount: number; total: number; vat: number; ctl: number;
  /** A445: the part of `discount` that offers took off, and which offers. */
  offerDiscount: number; offers: AppliedOffer[];
  /** P0-2 (a till's sale only): lines the catalogue could not price — valued at the till's price, and why. */
  fallbacks: TillLineFallback[] };
export interface TillLineFallback { index: number; reason: string; unknownProduct: boolean }
type RecomputeFail = { ok: false; status: number; error: string };
type RecomputeResult = RecomputeOk | RecomputeFail;

// tsconfig has strict:false, under which truthiness narrowing on a boolean
// discriminant is unreliable — `if (!r.ok)` did not narrow to RecomputeFail.
// An explicit type predicate narrows correctly regardless of strictness.
const recomputeFailed = (r: RecomputeResult): r is RecomputeFail => !r.ok;

// ── A445: offers a sale claims, checked on the cloud's own prices ─────────────
// The till (or the web POS) applies offers by its own clock and sends what they took off (offer_discount) and which
// (offers: [{offer_id, name, amount}]). The cloud recomputes those offers on the lines it priced itself — with the
// SAME engine (lib/offers.ts) — ignoring the timing (an offline sale arrives later, and the offer may have ended or
// been switched off since: the sale was made while it ran). A sale never gets more off than that gives, and offers of
// another business are ignored. The manual discount is the rest of discount_amount, capped as before on what is left.
export interface OfferClaim { amount: number; ids: string[] }
export function offerClaimFrom(body: any): OfferClaim {
  const amount = Math.max(0, round2(Number(body?.offer_discount) || 0));
  const ids = Array.isArray(body?.offers)
    ? [...new Set(body.offers.map((o: any) => String(o?.offer_id ?? '')).filter((x: string) => /^[0-9a-f-]{36}$/i.test(x)))] as string[]
    : [];
  return ids.length ? { amount, ids } : { amount: 0, ids: [] };
}
const OFFER_COLS = 'id, name, kind, value, spend_type, applies_to, product_ids, category_ids, buy_qty, get_qty, get_product_id, '
  + 'min_spend, meal_items, start_date, end_date, days, start_time, end_time, branch_ids';
export async function checkOfferClaim(businessId: string, branchId: string | null, lines: OfferLine[], claim: OfferClaim,
  subtotal: number): Promise<{ offerDiscount: number; offers: AppliedOffer[] }> {
  if (!(claim.amount > 0) || !claim.ids.length) return { offerDiscount: 0, offers: [] };
  const { data } = await supabase.from('offers').select(OFFER_COLS).eq('business_id', businessId).in('id', claim.ids);
  const offers = ((data ?? []) as any[]).map((r) => cleanOffer({ ...r, active: true })).flatMap((c) => (c.ok ? [c.offer] : []));
  // A518: a promotion is charged as an offer (lib/promotionOffers.ts) — the ids not found among the offers may be promotions.
  const found = new Set(offers.map((o) => o.id));
  offers.push(...await promotionOffersByIds(businessId, claim.ids.filter((id) => !found.has(id))));
  const r = applyOffers(lines, offers, { ignoreTiming: true, branchId });
  const offerDiscount = round2(Math.min(claim.amount, r.total, subtotal));
  if (!(offerDiscount > 0)) return { offerDiscount: 0, offers: [] };
  // Claimed less than the engine gives (an offer changed since the sale): the sale's own figure, shared out the same way.
  const k = r.total > 0 ? offerDiscount / r.total : 0;
  return { offerDiscount, offers: r.applied.map((a) => ({ ...a, amount: round2(a.amount * k) })) };
}

/** What the till charged for one line: its own line total, else (its unit price + its modifiers) × quantity; never below 0. */
export function tillLineTotal(item: OrderItemInput): number {
  const qty = Number(item.quantity) || 0;
  const lt = Number(item.lineTotal);
  if (item.lineTotal !== undefined && item.lineTotal !== null && item.lineTotal !== '' && Number.isFinite(lt)) return round2(Math.max(0, lt));
  const unit = Math.max(0, Number(item.unitPrice) || 0);
  const mods = (item.selectedModifiers ?? []).reduce((s: number, m: { price?: number | string }) => s + Math.max(0, Number(m.price) || 0), 0);
  return round2((unit + mods) * qty);
}

/**
 * P1-8a: a product the till created offline, whose create the cloud answered 'identical' / 'awaiting' with the cloud's own
 * id for the same thing (change_requests.canonical_id, A448) — the sale names the till's id, which is not a product here.
 * The line is moved to the cloud's id (in place). Ids still unknown afterwards are left as they are.
 */
export async function mapCanonicalProducts(businessId: string, items: OrderItemInput[]): Promise<void> {
  const ids = [...new Set(items.map((i) => i?.product?.id).filter((x): x is string => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x)))];
  if (!ids.length) return;
  const known = await chunkIn<{ id: string }>('products', 'id', ids, (q) => q.select('id').eq('business_id', businessId));
  const have = new Set(known.map((p) => p.id));
  const missing = ids.filter((id) => !have.has(id));
  if (!missing.length) return;
  const maps = await chunkIn<{ entity_id: string; canonical_id: string | null }>('change_requests', 'entity_id', missing,
    (q) => q.select('entity_id, canonical_id').eq('business_id', businessId).eq('entity', 'product').not('canonical_id', 'is', null));
  const to = new Map(maps.filter((m) => m.canonical_id).map((m) => [m.entity_id, m.canonical_id as string]));
  for (const item of items) {
    const pid = item?.product?.id;
    if (pid && to.has(pid)) item.product!.id = to.get(pid)!;
  }
}

async function recomputeOrderTotals(
  businessId: string,
  branchId: string,
  items: OrderItemInput[],
  discountAmount: number | string,
  claim: OfferClaim = { amount: 0, ids: [] },
  /** P0-2: a till's sale (made, printed and paid already) — a line the catalogue cannot price is valued at the till's
   *  price and reported in `fallbacks`, never refused. A web / live sale is refused as before (anti-tampering). */
  opts: { tillSale?: boolean } = {},
): Promise<RecomputeResult> {
  const fallbacks: TillLineFallback[] = [];
  const vKey = (pid: string, g: string, o: string) => `${pid}::${g}::${o}`;
  const lineProductIds: string[] = items
    .map(i => i?.product?.id ?? null)
    .filter((x): x is string => !!x);

  const basePriceMap = new Map<string, number>();
  const variantAdjMap = new Map<string, number>();
  const variantAdjById = new Map<string, number>();
  const modifierPriceMap = new Map<string, number>();
  const categoryMap = new Map<string, string | null>();   // A445
  const weighedIds = new Set<string>();   // A577: products sold by weight (their quantity is kg)

  if (lineProductIds.length) {
    const { data: bizProducts } = await supabase
      .from('products').select('id, base_price, category_id, sold_by')
      .eq('business_id', businessId).in('id', lineProductIds);
    (bizProducts ?? [] as Pick<DbProduct, 'id' | 'base_price'>[]).forEach(p => basePriceMap.set(p.id, Number(p.base_price)));
    (bizProducts ?? []).forEach((p: any) => categoryMap.set(p.id, p.category_id ?? null));   // A445: offers by category
    (bizProducts ?? []).forEach((p: any) => { if (isSoldByWeight(p)) weighedIds.add(p.id); });   // A577

    // Per-branch pricing: overlay this branch's price overrides on top of the
    // base prices. Still authoritative (server-resolved, not client-trusted) —
    // we just resolve the SAME effective price the till charged
    // (COALESCE(branch_price, base_price)) instead of always the default.
    // See BRANCH_AUTHORITY_AND_SYNC_DESIGN.md §6.
    if (branchId) {
      const { data: branchPrices } = await supabase
        .from('branch_prices').select('product_id, price')
        .eq('branch_id', branchId).in('product_id', lineProductIds);
      (branchPrices ?? []).forEach((bp: { product_id: string; price: string | number }) =>
        basePriceMap.set(bp.product_id, Number(bp.price)));
    }

    const { data: vgroups } = await supabase
      .from('variant_groups')
      .select('name, product_id, variant_options ( id, name, price_adjustment )')
      .in('product_id', lineProductIds);
    (vgroups ?? [] as Array<{ name: string; product_id: string; variant_options: Array<{ id: string; name: string; price_adjustment: string }> }>).forEach(g =>
      (g.variant_options ?? []).forEach((o: any) => {
        variantAdjMap.set(vKey(g.product_id, g.name, o.name), Number(o.price_adjustment));
        if (o.id) variantAdjById.set(String(o.id), Number(o.price_adjustment));
      }));

    const { data: mgroups } = await supabase
      .from('modifier_groups')
      .select('name, product_id, modifier_options ( name, price )')
      .in('product_id', lineProductIds);
    (mgroups ?? [] as Array<{ name: string; product_id: string; modifier_options: Array<{ name: string; price: string }> }>).forEach(g =>
      (g.modifier_options ?? []).forEach(o =>
        modifierPriceMap.set(vKey(g.product_id, g.name, o.name), Number(o.price))));
  }

  const lines: { unitPrice: number; lineTotal: number }[] = [];
  for (const [index, item] of items.entries()) {
    const pid: string | null = item?.product?.id ?? null;
    const qty = Number(item.quantity) || 0;
    const name = item?.product?.name || (item as any)?.product_name || 'an item';
    // P0-2: a till's line the catalogue cannot price — kept at what the till charged, with the reason.
    const atTillPrice = (reason: string, unknownProduct: boolean) => {
      fallbacks.push({ index, reason, unknownProduct });
      lines.push({ unitPrice: round2(Math.max(0, Number(item.unitPrice) || 0)), lineTotal: tillLineTotal(item) });
    };

    if (pid) {
      if (!basePriceMap.has(pid)) {
        if (opts.tillSale) { atTillPrice(`product not on the cloud: ${name}`, true); continue; }
        return { ok: false, status: 400, error: 'Order contains a product that does not belong to this business' };
      }
      let unit = Math.max(0, basePriceMap.get(pid)!);   // never let a negative product price reduce the bill
      let unknown: string | null = null;
      const adjs: number[] = [];
      for (const v of (item.selectedVariants ?? [])) {
        // Accept both the canonical shape ({groupName, optionName}) and the
        // raw-option shape ({id/optionId, name}) some clients send.
        const vv = v as any;
        let adj = variantAdjMap.get(vKey(pid, vv.groupName, vv.optionName));
        if (adj === undefined) adj = variantAdjById.get(String(vv.optionId ?? vv.id ?? ''));
        if (adj === undefined) {
          const label = vv.groupName || vv.optionName || vv.name || vv.id || 'unknown';
          if (!opts.tillSale) return { ok: false, status: 400, error: `Unknown variant: ${label}` };
          unknown = `variant renamed or removed: ${name} — ${[vv.groupName, vv.optionName].filter(Boolean).join(' / ') || label}`;
          break;
        }
        adjs.push(adj);
      }
      const mprices: number[] = [];
      if (!unknown) for (const m of (item.selectedModifiers ?? [])) {
        const price = modifierPriceMap.get(vKey(pid, m.groupName, m.optionName));
        if (price === undefined) {
          if (!opts.tillSale) return { ok: false, status: 400, error: `Unknown modifier: ${m.groupName} / ${m.optionName}` };
          unknown = `modifier renamed or removed: ${name} — ${m.groupName} / ${m.optionName}`;
          break;
        }
        mprices.push(price);
      }
      if (unknown) { atTillPrice(unknown, false); continue; }
      // Every option is known: the catalogue's values replace the client's (the display rows stay truthful).
      (item.selectedVariants ?? []).forEach((v, i) => { v.priceAdjustment = adjs[i]; unit += adjs[i]; });
      let modifierTotal = 0;
      (item.selectedModifiers ?? []).forEach((m, i) => { m.price = mprices[i]; modifierTotal += mprices[i]; });
      // A577: a weighed line keeps the amount the till charged when it is what the weight gives to within half a gram
      // (a scale's PRICE label: the label's price is the amount, the weight worked back to the gram). Anything further is
      // re-priced as before.
      const priced = round2((unit + modifierTotal) * qty);
      const asked = Number(item.lineTotal);
      const keep = weighedIds.has(pid) && modifierTotal === 0 && item.lineTotal !== undefined && item.lineTotal !== null
        && item.lineTotal !== '' && weighedAmountAccepted(unit, qty, asked);
      lines.push({ unitPrice: round2(unit), lineTotal: keep ? round2(asked) : priced });
    } else {
      // Non-catalogue charge (parking/fuel/quick-add) — trust client price, clamped >= 0.
      const unit = Math.max(0, Number(item.unitPrice) || 0);
      const modifierTotal = (item.selectedModifiers ?? [])
        .reduce((s: number, m: { price?: number | string }) => s + Math.max(0, Number(m.price) || 0), 0);
      lines.push({ unitPrice: round2(unit), lineTotal: round2((unit + modifierTotal) * qty) });
    }
  }

  const subtotal = round2(lines.reduce((s, l) => s + l.lineTotal, 0));
  // A445: offers first (checked on these prices), then the manual discount — capped as before, on what is left.
  const offerLines: OfferLine[] = items.map((item, i) => {
    const pid: string | null = item?.product?.id ?? null;
    const qty = Number(item.quantity) || 0;
    return { key: String(i), product_id: pid, category_id: pid ? (categoryMap.get(pid) ?? null) : null,
             unit_price: qty > 0 ? lines[i].lineTotal / qty : 0, quantity: qty };
  });
  const { offerDiscount, offers } = await checkOfferClaim(businessId, branchId || null, offerLines, claim, subtotal);
  const manualAsked = claim.ids.length ? Math.max(0, (Number(discountAmount) || 0) - claim.amount) : discountAmount;
  const discount = round2(offerDiscount + capDiscount(manualAsked, round2(subtotal - offerDiscount)));
  const total = round2(subtotal - discount);

  const { vat, ctl } = await taxSplit(businessId, total);

  return { ok: true, lines, subtotal, discount, total, vat, ctl, offerDiscount, offers, fallbacks };
}

// ── P0-2: an offline till sale priced differently from the cloud's catalogue ──
// Owner decision (2026-10-14): "let the sale go through but count it as a loss". A till's sale was priced by the till's
// catalogue when it was made, printed and PAID; the cloud re-prices it on sync. When the two differ (a price changed
// before the sale synced, an option renamed or removed, a product the cloud does not know), the sale is stored AT THE
// TILL'S PRICES — the money actually taken, so its payment legs reconcile and it is never lost — and the difference is
// recorded in order_price_variances (catalogue - till: positive = a loss) for Reports › Voids & Exceptions and the owner's
// daily email. A web / live sale keeps the anti-tampering re-price unchanged.
export interface TillPricing {
  lines: { unitPrice: number; lineTotal: number }[];
  subtotal: number; discount: number; total: number;
  catalogueTotal: number; tillTotal: number; difference: number; reason: string; suspicious: boolean;
}
/** A difference above this share of the catalogue total is accepted but flagged for the owner. */
export const SUSPICIOUS_SHARE = 0.5;

/** The till's own figures for a sale, when they differ from the catalogue's (or a line had no catalogue price); else null. */
export function tillPricing(items: OrderItemInput[], cat: RecomputeOk, body: { total?: unknown; discount_amount?: unknown }): TillPricing | null {
  const lines = items.map((item) => ({ unitPrice: round2(Math.max(0, Number(item.unitPrice) || 0)), lineTotal: tillLineTotal(item) }));
  const subtotal = round2(lines.reduce((s, l) => s + l.lineTotal, 0));
  const sent = Number(body?.total);
  const total = round2(Number.isFinite(sent) && body?.total !== null && body?.total !== '' && body?.total !== undefined
    ? Math.max(0, sent)
    : Math.max(0, subtotal - (Number(body?.discount_amount) || 0)));
  const difference = round2(cat.total - total);
  if (Math.abs(difference) < 0.01 && !cat.fallbacks.length) return null;
  const reasons = [...(Math.abs(difference) >= 0.01 && cat.fallbacks.length < items.length ? ['price changed before sync'] : []),
    ...cat.fallbacks.map((f) => f.reason)];
  return {
    lines, subtotal, discount: round2(Math.max(0, subtotal - total)), total,
    catalogueTotal: cat.total, tillTotal: total, difference,
    reason: [...new Set(reasons)].join('; ').slice(0, 500) || 'priced differently on the POS',
    suspicious: cat.total > 0 ? Math.abs(difference) > SUSPICIOUS_SHARE * cat.total : Math.abs(difference) >= 0.01,
  };
}

/**
 * Split a tax-INCLUSIVE total into its VAT and catering-levy components.
 *
 * Extracted so the two paths that write tax to an order cannot drift. It was
 * previously inline in recomputeOrderTotals only, which is precisely why
 * POST /:id/pay — the order-first (dine-in) path — never recomputed tax at all
 * and left VAT standing at the pre-discount figure (audit H2).
 *
 * Menu prices include BOTH taxes, so the net is backed out using the combined
 * rate and each tax is then charged on that net. VAT is on the net, not on
 * net-plus-CTL, matching how the levy is assessed (its base excludes VAT) and
 * how the incumbent system on site computes it:
 *
 *     750 / 1.18 = 635.59 net  ->  ctl 12.71, vat 101.69, total 750.00
 *
 * With ctlRate = 0 this collapses exactly to VAT-only behaviour, so businesses
 * outside the levy's scope are unaffected.
 */
async function taxSplit(businessId: string, total: number): Promise<{ vat: number; ctl: number }> {
  const { data: bizRow } = await supabase
    .from('businesses').select('vat_rate, ctl_rate').eq('id', businessId).single();
  const vatRate = Number(bizRow?.vat_rate ?? 16);
  const ctlRate = Number(bizRow?.ctl_rate ?? 0);

  const net = total / (1 + (vatRate + ctlRate) / 100);
  return {
    vat: round2(net * (vatRate / 100)),
    ctl: round2(net * (ctlRate / 100)),
  };
}

// ── Loyalty helpers ──────────────────────────────────────────

async function getLoyaltyEarnRate(businessId: string): Promise<number> {
  const { data } = await supabase
    .from('business_settings')
    .select('value')
    .eq('business_id', businessId)
    .eq('key', 'loyalty_earn_rate')
    .single();
  return (data?.value as number) ?? 1; // default 1 pt per KES 10
}

// Awards points after a completed order.
// pointsToEarn already accounts for tier multiplier (computed by caller).
async function awardLoyaltyPoints(
  customerId: string,
  businessId: string,
  orderId: string,
  pointsToEarn: number,
  orderNumber: string,
) {
  // Atomic increment — avoids race condition when concurrent orders for the same customer
  // are placed simultaneously (read-then-write can miscalculate points under concurrency).
  // p_points, NOT p_delta. PostgREST resolves an RPC by its NAMED ARGUMENT SET,
  // so calling (p_customer_id, p_delta) matched no function at all and returned
  // PGRST202 every single time. The fallback below tests for 'function' in the
  // message, PGRST202 reads "Could not find the function ... in the schema
  // cache", so it matched — and every award silently took the racy
  // read-modify-write path this RPC exists to replace. The atomic path had
  // never once executed. Signature: migrations/53_increment_loyalty_points.sql.
  const { error } = await supabase.rpc('increment_loyalty_points', {
    p_customer_id: customerId,
    p_points:      pointsToEarn,
  });

  // Fallback for pre-migration environments only. Narrowed to PGRST202 (the
  // function genuinely is not there) so it can no longer swallow a real error
  // — a permissions failure or a bad argument used to land here and look like
  // a successful award.
  if (error && (error.code === 'PGRST202' || /Could not find the function/i.test(error.message ?? ''))) {
    const { data: customer } = await supabase
      .from('customers')
      .select('loyalty_points, visit_count')
      .eq('id', customerId)
      .single();

    if (customer) {
      await supabase
        .from('customers')
        .update({
          loyalty_points: (customer.loyalty_points ?? 0) + pointsToEarn,
          visit_count:    (customer.visit_count ?? 0) + 1,
        })
        .eq('id', customerId);
    }
  }

  await supabase
    .from('loyalty_transactions')
    .insert({
      customer_id: customerId,
      business_id: businessId,
      order_id:    orderId,
      type:        'earn',
      points:      pointsToEarn,
      notes:       `Earned on order ${orderNumber}`,
    });
}

// POST /api/orders
// Creates order, order_items, order_item_variants, order_item_modifiers, payment,
// deducts stock, creates kitchen ticket, and handles loyalty earn/redeem.
router.post('/', sellsOrTillSale, async (req, res) => {   // A505: a till's own sale is never refused for its person's keys
  // Idempotency — the desktop sync engine (and any retrying client) sends
  // X-Idempotency-Key. If we've already created an order for this key, return
  // the existing one with 200 instead of creating a duplicate. This makes a
  // lost-response retry safe.
  const idempotencyKey = (req.header('X-Idempotency-Key') || req.body?.idempotency_key || '').trim();
  if (idempotencyKey) {
    const { data: existing } = await supabase
      .from('orders')
      .select('id, order_number')
      .eq('business_id', req.businessId)
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();
    if (existing) {
      res.status(200).json({ orderId: existing.id, orderNumber: existing.order_number, duplicate: true });
      return;
    }
  }

  const {
    branch_id,
    order_number,
    order_type = 'retail',
    subtotal,
    vat_amount,
    total,
    items,
    // Rider name for a delivery. Free text — see migrations/35_delivery_person.sql.
    delivery_person,
    payment,   // legacy single-payment (kept for backwards compat)
    payments,  // new: array of payment legs for split support
    // Loyalty (all optional)
    customer_id,
    customer_name,
    customer_phone,
    points_redeemed = 0,
    discount_amount = 0,
    discount_id = null,
    shift_id = null,
    tip_amount = 0,
    // A367: a note on the whole order ("deliver to gate B"). Free; trimmed and capped.
    notes: orderNoteRaw = null,
    // 0.6.27: the delivery fee paid on top of the bill (pass-through, like the tip). Only on a delivery.
    delivery_fee: deliveryFeeRaw = 0,
    // 0.6.33: a FREE delivery — the shop pays the rider the fee, the customer does not (migration 115).
    delivery_free: deliveryFreeRaw = false,
  } = req.body;
  const deliveryFee = order_type === 'delivery' ? cleanDeliveryFee(deliveryFeeRaw) : 0;
  const deliveryFree = isFreeDelivery(order_type, deliveryFee, deliveryFreeRaw);

  // Normalise to array — support both old single `payment` and new `payments` array
  const paymentLegs: PaymentLegInput[] = Array.isArray(payments) && payments.length > 0
    ? payments
    : payment
      ? [payment]
      : [];

  if (!branch_id || !order_number || !items?.length || !paymentLegs.length) {
    const missing = [
      !branch_id && 'branch_id',
      !order_number && 'order_number',
      !items?.length && 'items',
      !paymentLegs.length && 'payment',
    ].filter(Boolean).join(', ');
    res.status(400).json({ error: `Missing required fields: ${missing}` });
    return;
  }

  // Item 5: a staff member locked to one branch must not create orders (and
  // deduct stock) against another branch by passing a different branch_id.
  if (!assertBranchAccess(req, branch_id)) {
    res.status(403).json({ error: 'You do not have access to this branch' });
    return;
  }

  // Finding #16: the branch on this payload is the TILL's claim about itself
  // (it lives in the machine's local config and travels with it). A terminal
  // physically moved to another branch keeps booking to its old one until
  // someone notices. checkDeviceBranch validates the claim against the
  // server-side binding (migration 52). It fails OPEN for an unbound or unknown
  // device — existing tills bind on first sight and keep trading — and only
  // refuses a CHANGE, so a moved till is caught. Refusing leaves the order on
  // the till to re-push once the branch is corrected; nothing is lost.
  {
    // deviceIdFromRequest, not a raw header read: a duplicated header arrives
    // comma-joined and would never match a bound device. See terminalKey.ts.
    const deviceId = deviceIdFromRequest(req) || null;
    const binding = await checkDeviceBranch(req.businessId, deviceId, branch_id);
    if (!binding.ok) {
      res.status(409).json({ error: binding.error, code: binding.code });
      return;
    }
  }

  // ── A394: an item frozen by a stock count is not sold on the web POS until it has been counted ──
  // Only a live web sale: a till's sale (X-Device-Id, or made offline with its own time) already happened and is never
  // refused — the count takes it into account instead (lib/stockTakeRules.lateSales).
  if (!deviceIdFromRequest(req) && !(req.body?.created_at || req.body?.client_created_at)) {
    const frozen = await frozenAtBranch(req.businessId, branch_id);
    if (frozen?.productIds.length) {
      const held = new Set(frozen.productIds);
      const names = (items as OrderItemInput[]).filter((i) => held.has(String(i.product?.id ?? i.productId ?? '')))
        .map((i) => i.product?.name || 'an item');
      if (names.length) {
        res.status(409).json({
          error: `Being counted (${frozen.ref}): ${[...new Set(names)].slice(0, 5).join(', ')}. It can be sold again once it has been counted.`,
          code: 'STOCK_COUNT_FROZEN',
        });
        return;
      }
    }
  }

  // ── A563: the owner's "When an item's stock reaches zero" — "show as sold out" or "hide" refuses a LIVE web sale of a
  // tracked item the branch is known to be out of (409 SOLD_OUT). A till's pushed sale (X-Device-Id, or made with its own
  // time) already happened and is NEVER refused for stock; unknown stock always sells.
  if (!deviceIdFromRequest(req) && !(req.body?.created_at || req.body?.client_created_at)) {
    const soldOut = await webSaleStockRefusal(req.businessId, branch_id, items);
    if (soldOut) { res.status(409).json(soldOut); return; }
  }

  try {
    // Item 7: ensure any attached customer belongs to THIS business — prevents
    // reading/redeeming another tenant's loyalty balance via a known UUID.
    if (customer_id) {
      const { data: cust } = await supabase
        .from('customers').select('id').eq('id', customer_id).eq('business_id', req.businessId).maybeSingle();
      if (!cust) { res.status(400).json({ error: 'Invalid customer' }); return; }
    }

    // 1. Validate redeemed points if a customer is attached
    if (customer_id && points_redeemed > 0) {
      const { data: customer } = await supabase
        .from('customers')
        .select('loyalty_points')
        .eq('id', customer_id)
        .eq('business_id', req.businessId)
        .single();

      if (!customer || customer.loyalty_points < points_redeemed) {
        res.status(400).json({ error: 'Insufficient loyalty points' });
        return;
      }
    }

    // ── Item 4: authoritative price recomputation (anti-tampering) ───────────
    // P0-2: a TILL's sale (a desktop token, made with its own time — every till sale carries created_at) was made, printed
    // and paid already. It is re-priced to find any difference, on a copy (the till's option prices stay on its lines), and
    // a line the catalogue cannot price is valued at the till's price instead of refusing the sale.
    const tillSale = req.surface === 'desktop' && !!(req.body?.created_at || req.body?.client_created_at);
    let saleItems: OrderItemInput[] = items;
    if (tillSale) {
      await mapCanonicalProducts(req.businessId, items);   // P1-8a: a product the till created offline, known here by another id
      saleItems = JSON.parse(JSON.stringify(items));
    }
    const recomputed = await recomputeOrderTotals(req.businessId, branch_id, saleItems, discount_amount, offerClaimFrom(req.body), { tillSale });   // A445
    if (recomputeFailed(recomputed)) { res.status(recomputed.status).json({ error: recomputed.error }); return; }
    // A490: a manual discount on a LIVE web sale is sales.discount (offers are not a manual discount). A till's sale was
    // made already — never refused for it (the till checks its own person).
    if (await discountRefused(req, round2(recomputed.discount - recomputed.offerDiscount),
      { discountId: discount_id, base: round2(Number(recomputed.subtotal) - recomputed.offerDiscount) })) {   // A494, A595
      res.status(403).json(DISCOUNT_REFUSED); return;
    }
    let {
      lines: authLines,
      subtotal: authSubtotal,
      discount: authDiscount,
      total: authTotal,
      vat: authVat,
      ctl: authCtl,
    } = recomputed;
    let offerDiscount = recomputed.offerDiscount;
    let appliedOffers = recomputed.offers;
    const variance = tillSale ? tillPricing(items, recomputed, req.body) : null;
    if (variance) {
      // Stored at the till's prices (the money taken; its legs reconcile), the tax split from that total.
      authLines = variance.lines; authSubtotal = variance.subtotal; authDiscount = variance.discount; authTotal = variance.total;
      ({ vat: authVat, ctl: authCtl } = await taxSplit(req.businessId, authTotal));
      // The offers' share of the till's discount, at most what the catalogue's engine gave.
      const k = offerDiscount > 0 ? Math.min(1, authDiscount / offerDiscount) : 0;
      offerDiscount = round2(offerDiscount * k);
      appliedOffers = appliedOffers.map((a) => ({ ...a, amount: round2(a.amount * k) }));
      saleItems = items;   // the till's option prices on the stored lines
    }
    // A line whose product the cloud does not have is kept as a non-catalogue line (no product id: the foreign key).
    const unknownProductLines = new Set(recomputed.fallbacks.filter((f) => f.unknownProduct).map((f) => f.index));

    // ── Finding #19: offline re-pricing divergence ──────────────────────────
    // The server ALWAYS re-prices against the current catalogue for anti-tampering
    // — correct for a live web sale. But an OFFLINE desktop order was already
    // priced against the catalogue at sale time, PRINTED, and PAID. If a price
    // changed between that sale and this sync, the re-priced total silently
    // diverges from the receipt the customer holds. We cannot blindly trust the
    // client (that defeats anti-tampering) nor blindly overwrite (that contradicts
    // the receipt), so we DETECT and log the divergence for reconciliation. The
    // stored total remains the authoritative re-priced figure — but now the
    // discrepancy is visible instead of silent, and can be reviewed.
    const clientTotal = Number(total);
    if (Number.isFinite(clientTotal) && Math.abs(clientTotal - recomputed.total) > 0.01) {
      const isOffline = !!(req.body?.created_at || req.body?.client_created_at);
      console.warn(
        `[reprice-divergence]${isOffline ? ' OFFLINE' : ''} order ${order_number}: ` +
        `client total ${clientTotal.toFixed(2)} vs re-priced ${recomputed.total.toFixed(2)} ` +
        `(diff ${(clientTotal - recomputed.total).toFixed(2)}). ` +
        (variance ? 'A till\'s sale: stored at the till\'s figure, the difference recorded (order_price_variances).'
                  : 'Stored the re-priced figure (a web / live sale: anti-tampering).'),
      );
    }

    // ── L5: a client-supplied discount_id must belong to this business ───────
    // Prevents referencing (and incrementing usage on) another tenant's discount.
    // NOTE: the manual discount_amount is still trusted here, clamped to
    // [0, subtotal] by recomputeOrderTotals. Gating who may apply a manual
    // discount, or re-deriving the amount from the discount record, is a product
    // decision left to you (see PATCH_NOTES).
    if (discount_id) {
      const { data: disc } = await supabase
        .from('discounts')
        .select('id')
        .eq('id', discount_id)
        .eq('business_id', req.businessId)
        .maybeSingle();
      if (!disc) { res.status(400).json({ error: 'Invalid discount' }); return; }
    }

    // ── Credit sale pre-check (item 15) ──────────────────────────────────────
    // If any payment leg uses 'credit', a customer is required and their
    // available credit must cover the credit portion. Checked BEFORE the order
    // is created so we never commit a sale that breaches the limit.
    const creditLeg = paymentLegs.find(l => l.method === 'credit');
    let creditNote = '';   // A511: who approved it, on the ledger line
    let creditOk: CreditOk | null = null;   // A545: approved at the sale, or a till's sale awaiting a manager
    let creditOverLimit = false;            // A545: a till's sale past the limit is recorded, flagged
    let creditBranchLimit: number | null = null;   // A595 D4: the customer's limit at this branch, when one is set
    if (creditLeg) {
      if (!customer_id) {
        res.status(400).json({ error: 'A customer is required for a credit sale' });
        return;
      }
      const ca = await creditApproval(req, req.body, branch_id ?? null);   // A511
      if ('status' in ca) { res.status(ca.status).json(ca.body); return; }
      creditNote = ca.note;
      creditOk = ca;
      const creditAmount = Number(creditLeg.amount) || 0;
      const { data: cust } = await supabase
        .from('customers')
        .select('credit_limit, credit_balance')
        .eq('id', customer_id).eq('business_id', req.businessId).single();
      if (!cust) { res.status(400).json({ error: 'Invalid customer' }); return; }
      // A595 D4 (owner, 2026-10-27): a branch the owner (or its partner) closed to credit sells nothing on account — a sale
      // the POS already took there is recorded and flagged for the manager, never lost; and a customer's limit AT this
      // branch, when one is set, is checked against what they owe here (else the business-wide limit, as before).
      const creditHere = await branchCreditEnabled(req.businessId!, branch_id ?? null);
      if (!creditHere && !ca.tillSale) { res.status(403).json({ ...CREDIT_OFF_HERE }); return; }
      creditBranchLimit = await branchLimitOf(req.businessId!, customer_id, branch_id ?? null);
      const available = creditAvailable({ limit: Number(cust.credit_limit) || 0, owedTotal: Number(cust.credit_balance) || 0,
        branchLimit: creditBranchLimit, owedHere: creditBranchLimit !== null ? await owedAtBranch(req.businessId!, customer_id, branch_id ?? null) : 0 });
      if (!creditHere) creditOverLimit = true;
      // A545: a sale the till already took is never refused for the limit (the goods are gone) — recorded, flagged for
      // the manager who confirms it.
      if (creditAmount > available && ca.tillSale) creditOverLimit = true;
      else if (creditAmount > available) {
        res.status(400).json({
          error: `Credit limit exceeded. Available: ${available.toFixed(2)}, required: ${creditAmount.toFixed(2)}`,
        });
        return;
      }
    }

    // 2. Create order
    // Attach the order to THIS TERMINAL's open drawer session, not the cashier's.
    // A shift is the terminal's session (see migration 63): whoever is on this
    // terminal sells into its drawer. Resolving by cashier_id (the old behaviour)
    // meant a cashier who had opened a drawer on another terminal pulled that
    // shift onto this sale, so the money and the sale landed on different drawers.
    // The client's supplied shift_id wins when present (it already reflects the
    // terminal's session from /shifts/current); otherwise resolve by terminal.
    let resolvedShiftId: string | null = shift_id ?? null;
    // A522: a till's sale into a drawer already closed (on the web, while the till was off) — its figures are put right
    // after the sale is written (lib/lateRows.ts), never left frozen without it.
    let drawerClosedBeforeSale = false;
    // A338: a sale whose drawer has not reached the cloud yet is not a fault — the till pushes the drawer first and
    // will retry. Say so with a code the till understands (it keeps the sale pending instead of giving up after 5
    // tries), rather than letting the orders.shift_id foreign key fail as a 500.
    if (resolvedShiftId) {
      const { data: drawer } = await supabase
        .from('shifts').select('id, status, branch_id').eq('id', resolvedShiftId).eq('business_id', req.businessId).maybeSingle();
      if (!drawer) {
        res.status(424).json({ code: 'shift_not_synced', error: 'This sale\'s drawer has not reached the cloud yet — it will sync right after it.' });
        return;
      }
      // A494: the drawer must be the sale's branch's — a sale (and its money) is never booked into another branch's drawer.
      if ((drawer as { branch_id?: string | null }).branch_id && (drawer as { branch_id?: string | null }).branch_id !== branch_id) {
        res.status(403).json({ code: 'SHIFT_OTHER_BRANCH', error: 'That drawer belongs to another branch.' });
        return;
      }
      // A462: a web sale into a drawer that was closed elsewhere (force-closed, or counted by a manager / the owner) is
      // refused — the web POS then asks for a new shift. A till's sale is never refused for it: it may have been rung
      // offline before the till heard of the close, and a sale is never lost (it stays on the shift it was rung into).
      if ((drawer as { status?: string }).status !== 'open' && !req.isTill && req.surface !== 'desktop') {
        res.status(409).json({ code: 'SHIFT_CLOSED', error: 'This shift was closed — open a new shift to keep selling.' });
        return;
      }
      drawerClosedBeforeSale = (drawer as { status?: string }).status !== 'open';
    }
    if (!resolvedShiftId) {
      const tkey = terminalKeyFromRequest(req);
      const { data: openShifts } = await supabase
        .from('shifts')
        .select('id, device_id, terminal_code, branch_id')
        .eq('business_id', req.businessId)
        .eq('status', 'open')
        .order('opened_at', { ascending: false });
      const match = (openShifts ?? []).find(
        s => terminalKey(s.device_id ?? '', s.terminal_code ?? '', s.branch_id ?? '') === tkey,
      );
      if (match) resolvedShiftId = (match as { id: string }).id;
    }

    // ── Atomic core write ──────────────────────────────────────────────────
    // Order + items + variants + modifiers + payments go in ONE transaction via
    // create_order_atomic (migration 62). Previously these were ~5 sequential
    // PostgREST inserts with no transaction: a failure after the order row but
    // before payments left a completed order with no tender. The RPC also
    // validates that the legs reconcile to the total (finding #15) and aborts if
    // they do not, rather than logging a mismatch after the fact.
    //
    // Stock, loyalty, discount counters and the KDS ticket stay BELOW as
    // post-commit effects — they are consequences of the sale, not part of its
    // identity, and they now run only after a durable, complete order exists, so
    // a failure in any of them can no longer orphan the order.
    const itemsPayload = saleItems.map((item: OrderItemInput, idx: number) => ({
      item: {
        product_id: unknownProductLines.has(idx) ? null : (item.product?.id ?? null),
        product_name: item.product?.name ?? (item as any).product_name ?? 'Item',
        category_name: Array.isArray(item.product?.categories)
          ? (item.product.categories[0]?.name ?? null)
          : ((item.product as any)?.categories?.name ?? (item as any).category_name ?? null),
        unit_price: authLines[idx].unitPrice,
        quantity: item.quantity,
        subtotal: authLines[idx].lineTotal,
        notes: cleanNote(item.notes),   // A367: trimmed and capped, never refused
      },
      variants: (item.selectedVariants ?? []).map((v: { groupName: string; optionName: string; priceAdjustment?: number }) => ({
        variant_group_name: v.groupName,
        variant_option_name: v.optionName,
        price_adjustment: v.priceAdjustment ?? 0,
      })),
      modifiers: (item.selectedModifiers ?? []).map((m: { groupName: string; optionName: string; price?: number }) => ({
        modifier_group_name: m.groupName,
        modifier_option_name: m.optionName,
        price: m.price ?? 0,
      })),
    }));

    const paymentsPayload = paymentLegs.map((leg: PaymentLegInput) => ({
      method:          leg.method,
      amount:          leg.amount,
      amount_tendered: leg.amount_tendered ?? leg.amount,
      change_given:    leg.change_given ?? 0,
      reference:       leg.reference ?? null,
      // An M-Pesa leg defaults to 'pending' for the STK-push flow, which the
      // callback flips to 'completed'. But a manual tender (the desktop till,
      // where the cashier confirms the payment on their own phone) sends
      // status='completed' explicitly — honour it, or the leg sits 'pending'
      // forever with no callback ever coming, and the dashboard payment-method
      // breakdown (which counts only 'completed') shows it as "unaccounted"
      // (A93). All non-M-Pesa methods are immediate and 'completed'.
      status: leg.method === 'mpesa'
        ? (leg.status === 'completed' ? 'completed' : 'pending')
        : 'completed',
    }));

    // A169/A415 — credit the sale to the real cashier. Sales pushed under the till's own session (no person) name the
    // cashier as `cashier_id`; trust that claim only when it validates like verify-pin (active user in this business
    // with access to this branch). A person's PIN token stays authoritative.
    const claimedCashier = req.body?.cashier_id ? String(req.body.cashier_id) : null;
    const mayClaim = !!req.isTill || !!req.isOwner;
    let claimValid = false;
    if (claimNeedsValidation({ mayClaim, subject: req.userId ?? null, claimed: claimedCashier })) {
      const { data: claimRow, error: claimErr } = await supabase
        .from('users')
        .select('id, user_branches ( branch_id )')
        .eq('id', claimedCashier)
        .eq('business_id', req.businessId)
        .eq('status', 'active')
        .maybeSingle();
      if (!claimErr && claimRow) {
        const access = ((claimRow as any).user_branches ?? []) as Array<{ branch_id: string }>;
        // Empty access = all branches (same rule verify-pin applies).
        claimValid = access.length === 0 || access.some(b => b.branch_id === branch_id);
      }
      if (!claimValid) {
        console.warn(`[orders] rejected cashier claim ${claimedCashier} on branch ${branch_id} — not an active branch cashier; crediting ${req.userId ?? 'no one (the till\'s own session)'}`);
      }
    }
    const resolvedCashierId = pickCashier({
      mayClaim, subject: req.userId ?? null, claimed: claimedCashier, claimValid,
    });

    // A595: a POS shown a customer's MASKED number (the person may not see it, or the POS's own credit list) sends that back
    // with the sale — the order keeps the customer's real number instead, never the mask.
    let orderCustomerPhone: string | null = customer_phone ?? null;
    if (isMasked(orderCustomerPhone)) {
      orderCustomerPhone = null;
      if (customer_id) {
        const { data: cRow } = await supabase.from('customers').select('phone').eq('id', customer_id).eq('business_id', req.businessId).maybeSingle();
        orderCustomerPhone = (cRow as { phone?: string | null } | null)?.phone ?? null;
      }
    }

    const orderPayload = {
      business_id: req.businessId,
      branch_id,
      customer_id: customer_id ?? null,
      customer_name: customer_name ?? null,
      customer_phone: orderCustomerPhone,
      order_number,
      order_type,
      delivery_person: order_type === 'delivery'
        ? (String(delivery_person ?? '').trim().slice(0, 120) || null)
        : null,
      subtotal: authSubtotal,
      vat_amount: authVat,
      ctl_amount: authCtl,
      discount_amount: authDiscount,
      discount_id: discount_id ?? null,
      loyalty_points_used: points_redeemed,
      total: authTotal,
      tip_amount: Math.max(0, Number(tip_amount) || 0),
      delivery_fee: deliveryFee,   // 0.6.27: create_order_atomic (migration 111) reconciles legs to total + tip + fee
      delivery_free: deliveryFree, // 0.6.33: …without the fee when free (migration 115); the rider is still paid it
      shift_id: resolvedShiftId,
      seated_at: order_type === 'dine_in' ? new Date().toISOString() : null,
      idempotency_key: idempotencyKey || crypto.randomUUID(),
      cashier_id: resolvedCashierId,
      device_id: req.body?.device_id ?? null,
      pump_id:         req.body?.pump_id ? String(req.body.pump_id) : null,
      // Offline sales carry their original timestamp so they book on the day they
      // actually happened, not at sync time (finding #7). Accept either field
      // name; a live sale sends neither and the RPC defaults to now().
      created_at: (req.body?.created_at || req.body?.client_created_at || null),
    };

    const { data: created, error: createErr } = await supabase.rpc('create_order_atomic', {
      p_order:    orderPayload,
      p_items:    itemsPayload,
      p_payments: paymentsPayload,
    });

    if (createErr) {
      if (createErr.code === '23505') {
        // Two different unique constraints can raise 23505 here:
        //   (business_id, idempotency_key) — a concurrent retry of the SAME
        //     order. The row already exists; return it as a duplicate (200).
        //   (business_id, branch_id, order_number) — a DIFFERENT order that
        //     happened to draw the same number (finding #20). No row matches our
        //     idempotency key, so surface a 409 the client can retry with a fresh
        //     number, rather than a 500. The widened generator makes this rare;
        //     this handles the rare case correctly instead of failing the sale.
        const { data: dup } = await supabase
          .from('orders')
          .select('id, order_number')
          .eq('business_id', req.businessId)
          .eq('idempotency_key', orderPayload.idempotency_key)
          .maybeSingle();
        if (dup) {
          res.status(200).json({ orderId: dup.id, orderNumber: dup.order_number, duplicate: true });
          return;
        }
        // Not our order → an order-number collision.
        res.status(409).json({
          error: 'Order number already exists — please retry.',
          code: 'ORDER_NUMBER_CONFLICT',
        });
        return;
      }
      // Everything below used to be `throw createErr`, which sendError turned
      // into "Failed to create order (ref: …)" — the same sentence for a bad
      // foreign key, a malformed uuid and a dead database. Eight of Beryl's
      // sales died there on 2026-08-07. The mapping now lives in
      // lib/orderErrors.ts so a test can drive it directly.
      const verdict = classifyOrderCreateError(createErr);

      console.error(
        `[order-create] ${createErr.code ?? '(no code)'} — ${verdict.detail}`,
        { businessId: req.businessId, branchId: branch_id, orderNumber: order_number,
          cashierId: req.userId, shiftId: resolvedShiftId,
          customerId: orderPayload.customer_id, discountId: orderPayload.discount_id,
          pumpId: orderPayload.pump_id, createdAt: orderPayload.created_at },
      );

      // Unknown class: rethrow so sendError logs it with a ref, unchanged.
      if (verdict.rethrow) throw createErr;

      res.status(verdict.status).json({
        error: verdict.message,
        ...(verdict.code ? { code: verdict.code } : {}),
        ...(process.env.NODE_ENV === 'production' ? {} : { detail: verdict.detail }),
      });
      return;
    }

    const createdRow = Array.isArray(created) ? created[0] : created;
    // A367: the order's note. create_order_atomic (migration 69) does not carry orders.notes, so it is written right
    // after the order exists — a note is an instruction, not money, and a failure here is logged, never the sale's.
    // A445: which offers took what off (create_order_atomic does not carry them — written right after, like the note).
    if (offerDiscount > 0) {
      const { error: offErr } = await supabase.from('orders')
        .update({ offer_discount: offerDiscount, offers: appliedOffers })
        .eq('id', createdRow.order_id).eq('business_id', req.businessId);
      if (offErr) console.error('[order-create] the offers on the sale were not saved:', offErr.message);
    }
    // P0-2: the difference between the catalogue's price and what the till charged, counted as a loss (positive) for the
    // owner. Written after the sale exists; a failure is logged, never the sale's (the sale is already safe).
    if (variance) {
      const { error: varErr } = await supabase.from('order_price_variances').insert({
        business_id: req.businessId, branch_id, order_id: createdRow.order_id, order_number: createdRow.order_number,
        catalogue_total: variance.catalogueTotal, till_total: variance.tillTotal, difference: variance.difference,
        reason: variance.reason, suspicious: variance.suspicious, sold_at: orderPayload.created_at,
      });
      if (varErr) console.error(`[order-create] P0-2 price difference on ${createdRow.order_number} not recorded (is migration 133 applied?):`, varErr.message);
    }
    const orderNote = cleanNote(orderNoteRaw, ORDER_NOTE_MAX);
    if (orderNote) {
      const { error: noteErr } = await supabase.from('orders').update({ notes: orderNote })
        .eq('id', createdRow.order_id).eq('business_id', req.businessId);
      if (noteErr) console.error('[order-create] the order note was not saved:', noteErr.message);
    }
    const order = {
      id: createdRow.order_id,
      order_number: createdRow.order_number,
      pump_id: req.body?.pump_id ? String(req.body.pump_id) : null,
    } as { id: string; order_number: string; pump_id: string | null };

    // 0.6.27: a web sale's rider is paid the fee in cash from this shift's drawer. A till's sale is not — the till
    // recorded that pay-out itself when it sold (it reaches the cloud as an ordinary pay-out).
    if (deliveryFee > 0 && req.surface !== 'desktop') {
      await payRider({ orderId: order.id, orderNumber: order.order_number, shiftId: resolvedShiftId, branchId: branch_id,
                       cashierId: resolvedCashierId ?? req.userId ?? null, fee: deliveryFee, rider: orderPayload.delivery_person });
    }

    // orderItems is re-read for the post-commit steps that need item ids (stock,
    // recipe deduction). One extra read, off the critical write path.
    const { data: orderItems } = await supabase
      .from('order_items')
      .select('id, product_id, quantity')
      .eq('order_id', order.id);

    // 6. Stock deduction — shared with the dine-in path.
    // This was 410 lines inline. /pay had a four-line imitation that updated
    // stock_levels.quantity only: no track_stock check, no sold_by='piece', no
    // stock_movements row, and no recipe, variant, packaging or fuel deduction.
    // Restaurants use /pay, so the recipe system was bypassed on the one path
    // that needed it. Both paths now call the same function.
    await applyStockEffects({
      businessId:  req.businessId,
      branchId:    branch_id,
      userId:      req.userId,
      orderId:     order.id,
      orderNumber: order_number,
      orderType:   order_type,
      pumpId:      order.pump_id ?? null,
      lines: saleItems.map((i: OrderItemInput, idx: number) => ({
        productId: unknownProductLines.has(idx) ? null : (i.product?.id ?? null),
        quantity:  Number(i.quantity) || 0,
        variants:  i.selectedVariants ?? [],
      })),
      // A522: when the till rang it (an offline sale) — an item a stock count posted since then is not taken off again.
      soldAt: req.surface === 'desktop' ? (req.body?.created_at || req.body?.client_created_at || null) : null,
    });

    // A522: the sale landed in a drawer closed while the till was off — its expected cash and difference are recomputed.
    if (drawerClosedBeforeSale && resolvedShiftId) {
      await settleLateRows(req.businessId!, [resolvedShiftId], `sale #${order_number}`);
    }


    // 7. Kitchen ticket
    const { error: ktErr } = await supabase
      .from('kitchen_tickets')
      .insert({ order_id: order.id, branch_id, status: 'new' });
    if (ktErr) console.error('Failed to create kitchen ticket:', ktErr.message);

    // 7b. Low-stock alerts now fire inside applyStockEffects, so the dine-in
    //     path gets them too — it never did before.

    // 8. Loyalty — deduct redeemed points, then award earned points
    if (customer_id) {
      // 8a. Deduct redeemed points
      if (points_redeemed > 0) {
        const { data: customer } = await supabase
          .from('customers')
          .select('loyalty_points')
          .eq('id', customer_id)
          .single();

        await supabase
          .from('customers')
          .update({ loyalty_points: Math.max(0, (customer?.loyalty_points ?? 0) - points_redeemed) })
          .eq('id', customer_id)
          .eq('business_id', req.businessId);

        await supabase
          .from('loyalty_transactions')
          .insert({
            customer_id,
            business_id: req.businessId,
            order_id: order.id,
            type: 'redeem',
            points: -points_redeemed,
            notes: `Redeemed on order ${order_number}`,
          });
      }

      // 8b. Earn points on net total (after discount), using tier multiplier
      const earnRate = await getLoyaltyEarnRate(req.businessId);
      const { data: customerForTier } = await supabase
        .from('customers')
        .select('loyalty_points')
        .eq('id', customer_id)
        .single();

      const currentPoints = customerForTier?.loyalty_points ?? 0;
      const { multiplier } = getTier(currentPoints);
      const netTotal = authTotal; // total already has discount applied
      const basePoints = Math.floor(netTotal / 10) * earnRate;
      const pointsToEarn = Math.floor(basePoints * multiplier);

      if (pointsToEarn > 0) {
        await awardLoyaltyPoints(customer_id, req.businessId, order.id, pointsToEarn, order_number);
      }

      // 8c. Update total_spent on customer — ATOMIC (register A55).
      //
      // This was a SELECT then a write-back of `current + amount`. Two tills
      // serving the same customer at once both read the old value and both
      // wrote their own total, so one sale silently vanished from lifetime
      // spend and from every RFM / CRM segment built on it.
      //
      // It was also the odd one out: loyalty_points and visit_count on this
      // SAME row have been atomic since migration 53, and awardLoyaltyPoints
      // calls that RPC about twenty lines above. The old comment here read
      // "inline — no RPC dependency", which was true and was the problem.
      //
      // The numeric(12,2)-as-string hazard the previous comment described is
      // gone with the arithmetic: Postgres does the addition on a numeric
      // column, so there is no JS coercion left to get wrong.
      await supabase.rpc('increment_customer_spend', {
        p_customer_id: customer_id,
        p_amount:      authTotal,
      });
    }

    // 9. Increment discount usage count if a promo was applied
    if (discount_id) {
      await supabase.rpc('increment_discount_usage', { discount_uuid: discount_id });
    }

    // 10. Fire webhook — non-blocking
    fireWebhook(req.businessId, 'order.completed', {
      order_id: order.id, order_number: order.order_number,
      order_type, total: authTotal, branch_id, cashier_id: resolvedCashierId,
    }).catch(() => {});

    // Credit sale: post the charge to the customer's account ledger. Limit was
    // already checked above; enforce again in the RPC as a concurrency guard.
    if (creditLeg && customer_id) {
      const { error: credErr } = await supabase.rpc('apply_credit_transaction', {
        p_business_id:   req.businessId,
        p_customer_id:   customer_id,
        p_branch_id:     branch_id,
        p_order_id:      order.id,
        p_type:          'charge',
        p_amount:        Math.abs(Number(creditLeg.amount) || 0),
        p_method:        null,
        p_reference:     null,
        p_notes:         creditNote ? `Credit sale${creditNote}` : null,   // A511
        p_created_by:    req.userId,
        p_enforce_limit: !creditOverLimit && creditBranchLimit === null,   // A545; A595 D4: a branch limit was checked above
      });
      if (credErr) console.error('[credit] charge failed for order', order.id, credErr.message);
      // A545: every sale on account waits for (or, approved at the sale, already has) a manager's confirmation.
      await recordCreditSale({
        businessId: req.businessId, orderId: order.id, branchId: branch_id ?? null, customerId: customer_id,
        amount: Math.abs(Number(creditLeg.amount) || 0), source: creditOk?.tillSale ? 'till' : 'web',
        approvedAtSale: !!creditOk?.approvedAtSale, approvedBy: creditOk?.approvedBy ?? null, approverName: creditOk?.approverName ?? null,
        cashierId: resolvedCashierId ?? null, overLimit: creditOverLimit,
        soldAt: (req.body?.created_at || req.body?.client_created_at || null) as string | null,
      });
    }

    // 11. Fiscalise with KRA eTIMS — non-blocking; never fails the sale.
    fiscaliseInvoice(order.id).catch((e) => console.error('[etims] fiscaliseInvoice:', e?.message));

    res.status(201).json({ orderId: order.id, orderNumber: order.order_number });
  } catch (err) {
    sendError(res, err, { message: 'Failed to create order' });
  }
});

// GET /api/orders
router.get('/', async (req, res) => {
  const { status, date_from, date_to, search, limit = '50', offset = '0', order_type, method } = req.query;

  // Owner: may filter by any branch_id or get all. Staff: locked to their branch.
  const bf = branchFilter(req);   // A582: one branch, all, or a partner's set
  const scopedBranch = bf.kind === 'one' ? bf.id : bf.kind === 'set' ? null : branchScope(req);
  // 0.6.37 (A387): a cashier sees only the payment methods the manager chose ([] = every; a manager always every). The
  // filter is in the query, so the count and the pages are right; the split sales are trimmed below.
  const manager = callerMayConfirm(req);
  // A490: History's methods narrowing is the cashier's view — anyone who sees every cashier's sales sees every method.
  const historyMethods = manager ? [] : await getHistoryMethods(req.businessId, scopedBranch ?? (bf.kind === 'set' ? null : (req as any).branchId ?? null));
  const joinPm = !!method || historyMethods.length > 0;

  let query = supabase
    .from('orders')
    .select(`
      id, order_number, order_type, status, subtotal, vat_amount, discount_amount,
      loyalty_points_used, total, created_at, branch_id, customer_name, device_id,
      cashier_id, delivery_person, delivery_fee, delivery_free, tip_amount,
      payments ( method, amount, status )${joinPm ? ', pm:payments!inner ( method )' : ''}
    `, { count: 'exact' })
    .eq('business_id', req.businessId)
    .order('created_at', { ascending: false })
    .range(parseInt(offset as string), parseInt(offset as string) + parseInt(limit as string) - 1);

  // A490: sales.history_all — without it, only the sales they rang (lib/historyScope.ts; before migration 134 the admin
  // portal's 'cashier_own_history' switch still narrows anyone who cannot confirm a drawer, as in 0.6.27).
  const features = await businessPosFeatures(req.businessId);
  const ownOnly = ownHistoryOnly(req, features);
  // The filters, once — the page below and A418's total of every page use the same ones.
  const filtered = (q: any) => {
    q = byBranch(q, bf);
    if (status)       q = q.eq('status', status as string);
    if (date_from)    q = q.gte('created_at', date_from as string);
    if (date_to)      q = q.lte('created_at', date_to as string);
    if (search)       q = q.ilike('order_number', `%${search}%`);
    // 0.6.27: History narrowed by order type or payment method (the web POS's Orders filters).
    if (typeof order_type === 'string' && order_type) q = q.eq('order_type', order_type);
    if (typeof method === 'string' && method)         q = q.eq('pm.method', method.toLowerCase());
    if (historyMethods.length)                        q = q.in('pm.method', historyMethods);
    if (ownOnly) q = q.eq('cashier_id', req.userId ?? '00000000-0000-0000-0000-000000000000');
    return q;
  };
  query = filtered(query);

  const { data, error, count } = await query;
  if (error) { sendError(res, error); return; }
  let orders = (data ?? []).map(({ pm, ...o }: any) => o);
  // 0.6.37 (A387): a split sale shows a cashier only its allowed part (shared/cashierHistory.ts).
  if (historyMethods.length) orders = cashierHistoryView(orders, historyMethods);
  // A418: the total of EVERY page the filters show (not the page on screen) — asked for (with_totals=1, the web POS's
  // History), for a manager, or a cashier while the owner's two switches are on ("one should be on for the other").
  let totals: { orders: number; sales: number } | undefined;
  if (req.query.with_totals === '1'
      && (manager || await cashierHistoryTotals(req.businessId!, scopedBranch ?? (bf.kind === 'set' ? null : (req as any).branchId ?? null)))) {
    const rows: any[] = [];
    for (let at = 0; ; at += 500) {
      const { data: page, error: tErr } = await filtered(supabase.from('orders')
        .select(`id, status, total, refunded_amount, payments ( method, amount, status )${joinPm ? ', pm:payments!inner ( method )' : ''}`)
        .eq('business_id', req.businessId))
        .order('id', { ascending: true }).range(at, at + 499);
      if (tErr) { sendError(res, tErr); return; }
      rows.push(...(page ?? []).map(({ pm, ...o }: any) => o));
      if ((page ?? []).length < 500) break;
    }
    totals = historyTotal(historyMethods.length ? cashierHistoryView(rows, historyMethods) : rows);
  }
  // can_reprint: 0.6.37 (owner) — a cashier never reprints a receipt; a manager and the owner may. A490: sales.reprint.
  res.json({ orders, total: count ?? 0, own_only: ownOnly,
             history_methods: historyMethods, can_reprint: holds(req, 'sales.reprint'), ...(totals ? { totals } : {}) });
});

// GET /api/orders/:id
router.get('/:id', async (req, res, next) => {
  // Literal sibling routes (e.g. GET /turnover) are registered after this one.
  // Order ids are UUIDs, so for any non-UUID id defer to the next matching route
  // instead of treating it as an order lookup (which would 404).
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)) {
    next();
    return;
  }
  let query = supabase
    .from('orders')
    .select(`
      *,
      order_items (
        *,
        order_item_variants ( * ),
        order_item_modifiers ( * )
      ),
      payments ( * )
    `)
    .eq('id', req.params.id)
    .eq('business_id', req.businessId);

  // Non-owners can only fetch orders from their branch
  const bf = branchFilter(req);   // A582: a partner's set reads a sale of any of theirs, never another branch's
  const scopedBranch = bf.kind === 'one' ? bf.id : null;
  query = byBranch(query, bf);

  const { data, error } = await query.single();
  if (error) { res.status(404).json({ error: 'Order not found' }); return; }

  // For voided orders, resolve the cashier who voided and the supervisor who
  // authorized it (if any) to names, so the order detail can show attribution.
  if ((data as any).status === 'voided') {
    const ids = [ (data as any).voided_by, (data as any).authorized_by ].filter(Boolean) as string[];
    if (ids.length) {
      const { data: users } = await supabase
        .from('users').select('id, name').in('id', [...new Set(ids)]);
      const nameMap: Record<string, string> = {};
      (users ?? []).forEach((u: any) => { nameMap[u.id] = u.name; });
      (data as any).voided_by_name     = (data as any).voided_by     ? (nameMap[(data as any).voided_by]     ?? null) : null;
      (data as any).authorized_by_name = (data as any).authorized_by ? (nameMap[(data as any).authorized_by] ?? null) : null;
    }
  }

  // A494: the History's rules for one sale too — without sales.history_all only their own sales (the list's own-only
  // rule: lib/historyScope.ts), and a cashier's payment methods (A387) narrow it. It answered any sale of the branch by id.
  const features = await businessPosFeatures(req.businessId);
  if (ownHistoryOnly(req, features) && (data as any).cashier_id !== (req.userId ?? '__none__')) {
    res.status(404).json({ error: 'Order not found' }); return;
  }
  let shown: any = data;
  if (!callerMayConfirm(req)) {
    const methods = await getHistoryMethods(req.businessId, (data as any).branch_id ?? scopedBranch ?? null);
    if (methods.length) {
      const view = cashierHistoryView([data as any], methods);
      if (!view.length) { res.status(404).json({ error: 'Order not found' }); return; }
      shown = view[0];
    }
  }

  // A444: who sold it — the order panel on the till and the web names them.
  if (shown.cashier_id) {
    const { data: who } = await supabase.from('users').select('name')
      .eq('id', shown.cashier_id).eq('business_id', req.businessId).maybeSingle();
    shown.cashier_name = (who as any)?.name ?? null;
  }

  // A595 (docs/PERMISSIONS-AUDIT.md F2): the customer's number and the M-Pesa payer's number only to a person holding
  // customers.contacts — masked otherwise (the WhatsApp receipt is sent by the cloud to the order's own number). The POS's
  // own session (no person) syncs the sale as it is.
  if (!req.isTill && !seesCustomerContacts(req)) {
    shown = { ...shown, customer_phone: shown.customer_phone ? maskPhone(shown.customer_phone) : shown.customer_phone,
      payments: Array.isArray(shown.payments) ? shown.payments.map((p: any) => (p?.mpesa_phone ? { ...p, mpesa_phone: maskPhone(p.mpesa_phone) } : p)) : shown.payments };
  }
  // A494: an order line's cost (unit_cost, …) only to someone who may see costs (lib/costAccess.ts).
  res.json(withoutCosts(req, shown));
});

// POST /api/orders/:id/void
// 0.6.30: the void window is the owner's setting (void_window_minutes, default 30 — lib/reversalRules.ts).

// ── 0.6.30 (A336 stage 3): a till's replay of a void or refund it made while it could not reach the cloud ──────────
// The till verified the approving manager's PIN itself (as A365's shift confirmation does) and applied the owner's
// rules (the window, the methods allowed offline, its own sales). The cloud re-checks what it can: the request comes
// from a till (a desktop sign-in), from THE till that holds the sale (its own, or a web sale on its drawer), and the
// person named as approver may approve voids and refunds. It does not refuse a replay on the window — the money has
// already moved at the counter, and refusing would leave the till and the cloud disagreeing for good.
function isTillReplay(req: any): boolean {
  // A494: only the till's OWN session, naming itself by its token — a person's desktop sign-in (usable from anywhere) and
  // a device id in a header or the body prove nothing.
  return req.isTill === true && !!req.deviceId && claimsReplay(req);
}
const claimsReplay = (req: any): boolean => typeof req.body?.offline_approved_by === 'string' && !!req.body.offline_approved_by;

// The signed-in person at push time may be a cashier (the till sends with whoever is signed in) — the replay carries
// its own approver, so it does not need the key on the token. Everything else still does.
// A490: a void is sales.void, a refund sales.refund (orders.void covered both).
const voidKey = requirePermission('sales.void');
const refundKey = requirePermission('sales.refund');
const reversalGate = (action: ApproveAction) => (req: any, res: any, next: any) => {
  if (isTillReplay(req)) { next(); return; }
  // A494: a replay sent with a person's sign-in on the till (the till pushes with whoever is signed in) is not refused for
  // good — 409 tells the till to keep it and send it again; it goes through with the till's own session.
  if (claimsReplay(req) && !req.isTill) {
    res.status(409).json({ error: 'An offline void or refund is sent with the POS\'s own session — it is sent again.', code: 'REPLAY_NEEDS_TILL_SESSION' });
    return;
  }
  // A545: the till's own sign-in WITHOUT a replay — the till's live void / refund when no person's cloud sign-in is on it
  // (ipcHandlers order:void / order:refund fall back to the till's session; every replay carries offline_approved_by,
  // pending_reversals.approved_by is NOT NULL). Never the bare permission check (TILL_SCOPE_ENFORCE would refuse it): the
  // handler's own approval decides — the approver's PIN (approverByPin: sales.void / sales.refund at the sale's branch,
  // never the asker) for money, and for an unpaid void only the till that holds the sale.
  if (req.isTill === true && !!req.deviceId) { next(); return; }
  (action === 'void' ? voidKey : refundKey)(req, res, next);
};

type TillReplay = { approverId: string; actorId: string | null; at: string };

/** Does the till whose own sign-in this is hold the sale (its own, or a web sale on its drawer)? A494 / A545. */
async function tillHoldsOrder(req: any, order: any): Promise<boolean> {
  const dev: string = req.deviceId;   // A494: the till's token — never a header or the body
  let holds = !!dev && order.device_id === dev;
  if (!holds && dev && order.shift_id) {
    const { data: s } = await supabase.from('shifts').select('device_id')
      .eq('id', order.shift_id).eq('business_id', req.businessId).maybeSingle();
    holds = (s as { device_id?: string | null } | null)?.device_id === dev;
  }
  return holds;
}
const NOT_THIS_TILL = { error: 'Only the POS that holds this sale can send its offline void or refund.', code: 'NOT_THIS_TILL' } as const;

async function checkTillReplay(req: any, order: any, action: ApproveAction): Promise<TillReplay | { status: number; body: Record<string, string> }> {
  if (!(await tillHoldsOrder(req, order))) {
    return { status: 403, body: { ...NOT_THIS_TILL } };
  }
  const { rows, ownerId } = await confirmerRows(req.businessId);
  const approver = rows.find((r) => r.id === req.body.offline_approved_by);
  if (!approver || !mayApprove(approver, ownerId, action)) {
    return { status: 403, body: { error: 'The person who approved this may not approve voids or refunds.', code: 'NOT_AN_APPROVER' } };
  }
  const actor = typeof req.body?.offline_by === 'string' ? rows.find((r) => r.id === req.body.offline_by) : undefined;
  return { approverId: approver.id, actorId: actor?.id ?? null, at: replayTime(req.body?.approved_at) };
}

// A335: the till voids and refunds by ITS id (our idempotency_key); the web by ours.
const cloudOrderId = (ref: string, businessId: string) => resolveOrderId(ref, async (column, value) => {
  const { data } = await supabase.from('orders').select('id')
    .eq(column, value).eq('business_id', businessId).limit(1).maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
});

// ── POST /api/orders/:id/refund ──────────────────────────────────────────────
//
// Give money back on a sale that legitimately happened (audit finding M3).
//
// Distinct from a void, and deliberately so:
//
//   VOID    "this sale should not have happened" — within the owner's window (default 30 minutes), order
//           becomes 'voided', drops out of sales entirely.
//   REFUND  "the sale happened, the money is going back" — any time, order stays
//           'completed', reversal recorded against it.
//
// The distinction matters for tax and for reporting. A voided order was never a
// sale; a refunded one was, and the VAT and levy on it were charged and are a
// real position for the period in which they were taken.
//
// Full refunds only. A partial needs line-level selection to restore the right
// stock and to recompute the tax split, and half-right money handling is worse
// than none — staff can refund in full and re-ring what the customer keeps.
router.post('/:id/refund', reversalGate('refund'), async (req, res) => {
  const { reason, override_pin, supervisor_pin, authorizer_id } = req.body;
  const orderId = await cloudOrderId(req.params.id, req.businessId!);

  if (!reason || !String(reason).trim()) {
    res.status(400).json({ error: 'A reason is required to refund an order' });
    return;
  }

  const { data: order, error: oErr } = await supabase
    .from('orders')
    .select(`
      *,
      order_items ( product_id, quantity ),
      payments ( id, status, amount, method )
    `)
    .eq('id', orderId)
    .eq('business_id', req.businessId)
    .single();

  if (oErr || !order) { res.status(404).json({ error: 'Order not found' }); return; }
  if (!assertBranchAccess(req, order.branch_id)) { res.status(403).json({ error: 'You do not have access to this branch' }); return; }   // A494
  if (order.status === 'voided') {
    res.status(400).json({ error: 'That order was voided — there is nothing to refund' });
    return;
  }
  if (order.status !== 'completed') {
    res.status(400).json({ error: 'Only a completed sale can be refunded' });
    return;
  }
  if (order.refunded_at) {
    // 0.6.30: the code lets a till's replay whose answer was lost know it is done.
    res.status(400).json({ error: 'That order has already been refunded', code: 'ALREADY_REFUNDED' });
    return;
  }

  let replay: TillReplay | null = null;
  if (isTillReplay(req)) {
    const r = await checkTillReplay(req, order, 'refund');
    if ('status' in r) { res.status(r.status).json(r.body); return; }
    replay = r;
  }
  const me = await recordedPerson(req.businessId!, req.userId, !!req.isOwner);   // A451: a users row, or nobody

  // What was actually taken, per leg. Refunding is bounded by this rather than
  // by the order total: if a leg failed, that money never arrived and must not
  // be handed back.
  const completedPayments = (order.payments ?? []).filter(
    (p: { status: string; amount: string; method: string }) => p.status === 'completed',
  );
  const takenTotal = completedPayments.reduce(
    (sum: number, p: { amount: string }) => sum + (Number(p.amount) || 0), 0,
  );

  if (takenTotal <= 0) {
    res.status(400).json({ error: 'No completed payment on that order — nothing was taken' });
    return;
  }

  // Supervisor authorisation, exactly as for a void. Money leaving the drawer is
  // the event worth gating, and it is the same event in both cases.
  let authorizedBy: string | null = null;

  if (replay) {
    // 0.6.30: approved on the till with the manager's PIN while it was offline.
    authorizedBy = replay.approverId;
  } else if (req.isOwner) {
    // A187: an owner refunding from the dashboard self-authorises — no
    // second-signature PIN. The audit trail is preserved: refunded_by = req.userId
    // and refund_authorized_by = the same owner (set below).
    authorizedBy = me;
  } else {
    // A514: `supervisor_pin` is only the body field older tills send the approver's PIN in — a person's own PIN, never the
    // retired business PIN (approverByPin checks people only).
    const pin = (override_pin ?? supervisor_pin) as string | undefined;
    const a = await approverByPin(req, authorizer_id, pin, 'refund', order.branch_id ?? null);
    if ('status' in a) { res.status(a.status).json(a.body); return; }
    authorizedBy = a.userId;
  }

  try {
    // 1. CLAIM the refund first (P2-12): mark the order refunded only while it is not refunded yet, in one conditional
    //    update. Two overlapping requests (a till's retry, a double tap) used to both pass the check above and both write
    //    the negative payments — a double refund. Only the request whose update matched the row goes on.
    //    Status stays 'completed' on purpose — see migration 37.
    const { data: claimed, error: uErr } = await supabase
      .from('orders')
      .update({
        refunded_at:          replay?.at ?? new Date().toISOString(),
        refunded_amount:      round2(takenTotal),
        refund_reason:        String(reason).trim(),
        refunded_by:          replay ? (replay.actorId ?? me) : me,
        refund_authorized_by: authorizedBy,
      })
      .eq('id', orderId)
      .eq('business_id', req.businessId)
      .eq('status', 'completed')
      .is('refunded_at', null)
      .select('id');
    if (uErr) throw uErr;
    if (!(claimed ?? []).length) {
      res.status(400).json({ error: 'That order has already been refunded', code: 'ALREADY_REFUNDED' });
      return;
    }

    // 2. Reverse every completed leg, in the same tender it came in on, so the
    //    drawer reconciles per method. Cash back for cash; an M-Pesa leg is
    //    recorded here but must still be sent back through M-Pesa by hand.
    const { error: rErr } = await supabase
      .from('payments')
      .insert(completedPayments.map((leg: { method: string; amount: string }) => ({
        order_id: orderId,
        business_id: req.businessId,
        branch_id: order.branch_id,
        method: leg.method,
        amount: -Math.abs(Number(leg.amount) || 0),
        amount_tendered: 0,
        change_given: 0,
        reference: `REFUND-${order.order_number}`,
        status: 'refunded',
        sync_status: 'pending',
      })));
    if (rErr) {
      // The money did not go back on the books: release the claim so the refund can be tried again.
      const { error: undoErr } = await supabase.from('orders')
        .update({ refunded_at: null, refunded_amount: 0, refund_reason: null, refunded_by: null, refund_authorized_by: null })
        .eq('id', orderId).eq('business_id', req.businessId);
      if (undoErr) console.error(`[refund] ${orderId}: the claim could not be released after a failed payment write:`, undoErr.message);
      throw rErr;
    }

    // 3. Credit legs: clear the debt, same as a void.
    if (order.customer_id) {
      for (const leg of completedPayments.filter((l: { method: string }) => l.method === 'credit')) {
        const { error: crErr } = await supabase.rpc('apply_credit_transaction', {
          p_business_id:   req.businessId,
          p_customer_id:   order.customer_id,
          p_branch_id:     order.branch_id,
          p_order_id:      orderId,
          p_type:          'adjustment',
          p_amount:        -Math.abs(Number(leg.amount) || 0),
          p_method:        null,
          p_reference:     null,
          p_notes:         `Refund: ${order.order_number} — ${reason}`,
          p_created_by:    me,
          p_enforce_limit: false,
        });
        if (crErr) console.error('[credit] refund reversal failed for order', orderId, crErr.message);
      }
    }

    // 4. Put the stock back. Goods are assumed returned; a refund where the
    //    customer keeps the food is a write-off, which is a stock adjustment and
    //    a different conversation.
    const productIds = (order.order_items ?? []).map((i: any) => i.product_id).filter(Boolean);
    if (productIds.length > 0) {
      const { data: tracked } = await supabase
        .from('products').select('id').in('id', productIds).eq('track_stock', true);
      const trackedIds = new Set((tracked ?? []).map((p: any) => p.id));

      for (const item of order.order_items ?? []) {
        if (!trackedIds.has(item.product_id)) continue;
        // Atomic restore. The old line wrapped item.quantity in Number() but
        // NOT stock.quantity, so "10.00" + Number(2) was still the string
        // "10.002". The RPC removes the JS addition entirely.
        const { data: restored, error: restoreErr } = await supabase.rpc('adjust_product_stock', {
          p_product_id:  item.product_id,
          p_branch_id:   order.branch_id,
          p_qty_delta:   Number(item.quantity),
          p_piece_delta: 0,
        });
        if (restoreErr) throw restoreErr;
        const restoredRow = Array.isArray(restored) ? restored[0] : restored;
        const newQty = Number(restoredRow?.quantity ?? 0);
        await supabase.from('stock_movements').insert({
          product_id: item.product_id,
          branch_id: order.branch_id,
          movement_type: 'correction',
          quantity_change: Number(item.quantity),
          quantity_after: newQty,
          notes: `Refund of Order ${order.order_number}: ${reason}`,
          // stock_movements has created_by, NOT cashier_id. The column does not
          // exist, so this insert was silently rejected and voided stock was
          // never restored to the ledger — the level was corrected, the audit
          // trail explaining why was not.
          created_by: me,
        });
      }
    }

    // 5. Pull the kitchen ticket ONLY if the kitchen hasn't started it (A196).
    // A refund keeps the sale on the books (status stays 'completed'), so a dish
    // already being made — 'preparing'/'ready' — is left to finish and be
    // collected. But a refund on a not-yet-started ticket ('new') means don't
    // cook it, so that one is pulled. Best-effort + logged, not thrown: the
    // refund already succeeded and must not be reported as failed.
    const { error: ktErr } = await supabase
      .from('kitchen_tickets')
      .delete()
      .eq('order_id', orderId)
      .eq('status', 'new');
    if (ktErr) console.error(`Failed to pull unstarted kitchen ticket(s) for refunded order ${orderId}:`, ktErr.message);

    res.json({
      ok: true,
      orderNumber: order.order_number,
      refunded: round2(takenTotal),
      byMethod: completedPayments.map((l: any) => ({ method: l.method, amount: Number(l.amount) || 0 })),
      authorizedBy,
    });
  } catch (err) {
    sendError(res, err, { message: 'Failed to refund order' });
  }
});

router.post('/:id/void', reversalGate('void'), async (req, res) => {
  const { reason, supervisor_pin, override_pin, authorizer_id } = req.body;
  const orderId = await cloudOrderId(req.params.id, req.businessId!);

  if (!reason) {
    res.status(400).json({ error: 'A reason is required to void an order' });
    return;
  }

  const { data: order, error: oErr } = await supabase
    .from('orders')
    .select(`
      *,
      order_items ( product_id, quantity ),
      payments ( id, status, amount, method )
    `)
    .eq('id', orderId)
    .eq('business_id', req.businessId)
    .single();

  if (oErr || !order) { res.status(404).json({ error: 'Order not found' }); return; }
  if (!assertBranchAccess(req, order.branch_id)) { res.status(403).json({ error: 'You do not have access to this branch' }); return; }   // A494
  if (order.status === 'voided') { res.status(400).json({ error: 'Order is already voided', code: 'ALREADY_VOIDED' }); return; }

  let replay: TillReplay | null = null;
  if (isTillReplay(req)) {
    const r = await checkTillReplay(req, order, 'void');
    if ('status' in r) { res.status(r.status).json(r.body); return; }
    replay = r;
  }
  const me = await recordedPerson(req.businessId!, req.userId, !!req.isOwner);   // A451: a users row, or nobody

  const orderAge = (Date.now() - new Date(order.created_at).getTime()) / 60000;
  // Owners may void at any age — the books are theirs, a reason is still required and
  // recorded (voided_by + reason). Staff/supervisor voids stay window-limited: that
  // window is a shrinkage control against a cashier quietly erasing an old sale.
  // 0.6.30: the window is the owner's setting (default 30 minutes). A till's offline replay was checked on the till.
  const rules = await businessReversalRules(req.businessId);
  if (!replay && !voidWindowOpen(orderAge, rules, !!req.isOwner)) {
    res.status(403).json({
      error: `Orders can only be voided within ${windowLabel(rules.voidWindowMinutes)} of the sale — refund it instead`,
      code: 'VOID_WINDOW_EXPIRED',
      windowMinutes: rules.voidWindowMinutes,
    });
    return;
  }

  // EVERY completed leg, not the first one.
  //
  // This used to be `.find(...)` — singular. A split tender (600 cash + 400
  // M-Pesa) reversed only the leg that happened to come back first, so 400 was
  // recorded as taken for a sale that never happened, and the credit reversal
  // below fired only if the credit leg was the one picked. Audit finding H3.
  const completedPayments = (order.payments ?? []).filter(
    (p: { id: string; status: string; amount: string; method: string }) => p.status === 'completed',
  );
  const isPaid = completedPayments.length > 0;

  let authorizedBy: string | null = null;
  if (replay) {
    // 0.6.30: approved on the till with the manager's PIN while it was offline (paid or not — it names its approver).
    authorizedBy = replay.approverId;
  } else if (isPaid && req.isOwner) {
    // A187: an owner voiding from the dashboard self-authorises — no
    // second-signature PIN. Audit trail preserved: voided_by = req.userId
    // and authorized_by = the same owner (set below).
    authorizedBy = me;
  } else if (isPaid) {
    // A514: `supervisor_pin` is only the body field older tills send the approver's PIN in — a person's own PIN, never the
    // retired business PIN (approverByPin checks people only).
    const pin = (override_pin ?? supervisor_pin) as string | undefined;
    const a = await approverByPin(req, authorizer_id, pin, 'void', order.branch_id ?? null);
    if ('status' in a) { res.status(a.status).json(a.body); return; }
    authorizedBy = a.userId;
  } else if (req.isTill) {
    // A545: an unpaid sale voided from the till's own sign-in (no money moves) — only the till that holds it (the till
    // checked its person's sales.void at the counter); never another till's sale or a web sale it does not hold.
    if (!(await tillHoldsOrder(req, order))) { res.status(403).json({ ...NOT_THIS_TILL }); return; }
  }

  try {
    // 1. Mark order voided — a CLAIM (P2-12): only while it is not voided yet, so of two overlapping requests (a till's
    //    retry, a double tap) exactly one reverses the payments, the stock and the loyalty; the other is told it is done.
    const { data: claimed, error: vErr } = await supabase
      .from('orders')
      .update({ status: 'voided', void_reason: reason, voided_at: replay?.at ?? new Date().toISOString(),
                voided_by: replay ? (replay.actorId ?? me) : me, authorized_by: authorizedBy })
      .eq('id', orderId)
      .eq('business_id', req.businessId)
      .neq('status', 'voided')
      .select('id');
    if (vErr) throw vErr;
    if (!(claimed ?? []).length) {
      res.status(400).json({ error: 'Order is already voided', code: 'ALREADY_VOIDED' });
      return;
    }

    // 0.6.27: a voided web delivery's rider pay-out goes back in while its shift is open (a till's own sale: the till
    // puts its pay-out back itself when it hears of the void). Best-effort — the void has happened.
    if (Number((order as any).delivery_fee ?? 0) > 0) await returnRiderPayout(orderId);

    // 1b. Pull the order's kitchen ticket(s) off the KDS (A196). A voided order
    // is cancelled, so its ticket must not stay live on the board — otherwise the
    // kitchen keeps cooking food nobody is paying for. Deleted by order_id so a
    // multi-station order (>1 ticket) is fully cleared. Best-effort and logged,
    // not thrown: the void already succeeded (M7 — no surrounding txn), so a
    // ticket-cleanup failure must not tell the client the void failed.
    const { error: ktErr } = await supabase
      .from('kitchen_tickets')
      .delete()
      .eq('order_id', orderId);
    if (ktErr) console.error(`Failed to remove kitchen ticket(s) for voided order ${orderId}:`, ktErr.message);

    // 2. Refund EVERY completed leg — one reversal row per leg, same method and
    // amount, so a split tender comes back in the same shape it went out and the
    // drawer reconciles per tender type rather than only in aggregate.
    if (isPaid) {
      const { error: rErr } = await supabase
        .from('payments')
        .insert(completedPayments.map((leg: { method: string; amount: string }) => ({
          order_id: orderId,
          business_id: req.businessId,
          branch_id: order.branch_id,
          method: leg.method,
          // Negate defensively: `amount` arrives as a string from PostgREST and
          // a leg that was somehow already negative must not flip positive.
          amount: -Math.abs(Number(leg.amount) || 0),
          amount_tendered: 0,
          change_given: 0,
          reference: `VOID-${order.order_number}`,
          status: 'refunded',
          sync_status: 'pending',
        })));
      if (rErr) throw rErr;

      // 2b. Reverse the credit charge (audit C5) — a voided credit sale must
      // not leave the debt standing. Runs for EVERY credit leg; previously it
      // fired only when credit happened to be the single leg `.find()` returned,
      // so a part-credit sale left the balance of the debt on the customer.
      //
      // Order is already voided/refunded above with no surrounding transaction
      // (see M7), so a failure here is logged, not thrown — the void itself
      // already succeeded and the client shouldn't be told otherwise.
      if (order.customer_id) {
        for (const leg of completedPayments.filter((l: { method: string }) => l.method === 'credit')) {
          const { error: crErr } = await supabase.rpc('apply_credit_transaction', {
            p_business_id:   req.businessId,
            p_customer_id:   order.customer_id,
            p_branch_id:     order.branch_id,
            p_order_id:      orderId,
            p_type:          'adjustment',
            p_amount:        -Math.abs(Number(leg.amount) || 0),
            p_method:        null,
            p_reference:     null,
            p_notes:         `Void: ${order.order_number} — ${reason}`,
            p_created_by:    me,
            p_enforce_limit: false,
          });
          if (crErr) console.error('[credit] void reversal failed for order', orderId, crErr.message);
        }
      }
    }

    // 3. Reverse stock
    const productIds = (order.order_items ?? [] as { product_id: string | null; quantity: string }[]).map(i => i.product_id).filter((id): id is string => !!id);
    const { data: trackedProducts } = await supabase
      .from('products')
      .select('id, track_stock')
      .in('id', productIds)
      .eq('track_stock', true);

    const trackedIds = new Set((trackedProducts ?? [] as { id: string }[]).map(p => p.id));

    for (const item of order.order_items ?? []) {
      if (!trackedIds.has(item.product_id)) continue;

      // Atomic restore. The old code read quantity (a STRING) and added
      // item.quantity, producing "10.002.00" — an invalid numeric that made the
      // upsert fail silently, so a void NEVER put stock back. Deduction used
      // subtraction and coerced fine, which is why the shelf went down on a sale
      // and never came back up on a void.
      const { data: restored, error: restoreErr } = await supabase.rpc('adjust_product_stock', {
        p_product_id:  item.product_id,
        p_branch_id:   order.branch_id,
        p_qty_delta:   Number(item.quantity),
        p_piece_delta: 0,
      });
      if (restoreErr) throw restoreErr;
      const restoredRow = Array.isArray(restored) ? restored[0] : restored;
      const newQty = Number(restoredRow?.quantity ?? 0);

      await supabase
        .from('stock_movements')
        .insert({
          product_id: item.product_id,
          branch_id: order.branch_id,
          movement_type: 'correction',
          quantity_change: item.quantity,
          quantity_after: newQty,
          notes: `Void of Order ${order.order_number}: ${reason}`,
          created_by: me,
        });
    }

    // 4. Reverse loyalty if order had a customer
    if (order.customer_id) {
      const { data: loyaltyTxns } = await supabase
        .from('loyalty_transactions')
        .select('type, points')
        .eq('order_id', orderId)
        .eq('customer_id', order.customer_id);

      const { data: customer } = await supabase
        .from('customers')
        .select('loyalty_points, total_spent, visit_count')
        .eq('id', order.customer_id)
        .single();

      if (customer && loyaltyTxns) {
        let pointsDelta = 0;
        for (const txn of loyaltyTxns) {
          // earn txns: reverse (subtract); redeem txns (negative points): reverse (add back)
          pointsDelta -= txn.points;
        }

        // ATOMIC (register A55). This wrote all THREE columns as one
        // read-modify-write, so a void racing a sale for the same customer lost
        // whichever landed first. Each column now moves by a delta in the
        // database, and each floors at 0 there.
        //
        // Three calls rather than one because the three move independently:
        // migration 67 split adjust_loyalty_points from increment_loyalty_points
        // for exactly this reason, and a payment adds spend without a visit.
        //
        // NOTE: the previous statement also had no .eq('business_id', ...),
        // unlike the other two total_spent writers. It was safe because `order`
        // was fetched business-scoped above, but it was the odd one out. The
        // RPCs take the customer id alone, so the inconsistency goes with it.
        await supabase.rpc('adjust_loyalty_points', {
          p_customer_id: order.customer_id,
          p_points:      pointsDelta,
        });
        await supabase.rpc('increment_customer_spend', {
          p_customer_id: order.customer_id,
          p_amount:      -order.total,
        });
        await supabase.rpc('adjust_customer_visits', {
          p_customer_id: order.customer_id,
          p_delta:       -1,
        });

        await supabase
          .from('loyalty_transactions')
          .insert({
            customer_id: order.customer_id,
            business_id: req.businessId,
            order_id: orderId,
            type: 'adjust',
            points: pointsDelta,
            notes: `Void of order ${order.order_number}: ${reason}`,
          });
      }
    }

    // Fire webhook — non-blocking
    fireWebhook(req.businessId, 'order.voided', {
      order_id: orderId, order_number: order.order_number,
      total: order.total, branch_id: order.branch_id,
      void_reason: reason, voided_by: req.userId,
    }).catch(() => {});

    // eTIMS credit note for the voided sale — non-blocking.
    fiscaliseCreditNote(orderId).catch((e) => console.error('[etims] fiscaliseCreditNote:', e?.message));

    res.json({ success: true, orderId });
  } catch (err) {
    sendError(res, err, { message: 'Failed to void order' });
  }
});

// ── POST /api/orders/open ──────────────────────────────────────────────────────
// Order-first restaurant model: creates an open order + kitchen ticket with no
// payment. The order stays open until POST /api/orders/:id/pay closes it.

router.post('/open', sells, async (req, res) => {
  const {
    branch_id,
    order_number,
    order_type = 'dine_in',
    table_number,
    covers = 1,
    subtotal,
    vat_amount,
    total,
    items,
    customer_id = null,
    customer_name = null,
    shift_id = null,
    notes: orderNoteRaw = null,   // A367
  } = req.body;

  if (!branch_id || !order_number || !items?.length) {
    res.status(400).json({ error: 'branch_id, order_number and items are required' });
    return;
  }

  // Item 5: branch access guard
  if (!assertBranchAccess(req, branch_id)) {
    res.status(403).json({ error: 'You do not have access to this branch' });
    return;
  }

  try {
    // Item 7: customer must belong to this business
    if (customer_id) {
      const { data: cust } = await supabase
        .from('customers').select('id').eq('id', customer_id).eq('business_id', req.businessId).maybeSingle();
      if (!cust) { res.status(400).json({ error: 'Invalid customer' }); return; }
    }

    // A494: a drawer named must be this business's and this branch's.
    if (shift_id) {
      const { data: drawer, error: dErr } = await supabase.from('shifts').select('id, branch_id')
        .eq('id', shift_id).eq('business_id', req.businessId).maybeSingle();
      if (dErr) { sendError(res, dErr); return; }
      if (!drawer || ((drawer as { branch_id?: string | null }).branch_id && (drawer as { branch_id?: string | null }).branch_id !== branch_id)) {
        res.status(400).json({ code: 'INVALID_SHIFT', error: "That drawer is not one of this branch's." });
        return;
      }
    }

    // Item 4: authoritative totals (no discount applied at open time)
    const recomputed = await recomputeOrderTotals(req.businessId, branch_id, items, 0);
    if (recomputeFailed(recomputed)) { res.status(recomputed.status).json({ error: recomputed.error }); return; }
    const { lines: authLines, subtotal: authSubtotal, total: authTotal, vat: authVat, ctl: authCtl } = recomputed;

    // 1. Create the order in 'open' status — no payment yet
    const { data: order, error: oErr } = await supabase
      .from('orders')
      .insert({
        business_id:     req.businessId,
        branch_id,
        order_number,
        order_type,
        table_number,
        covers,
        subtotal:        authSubtotal,
        vat_amount:      authVat,
        ctl_amount:      authCtl,
        total:           authTotal,
        discount_amount: 0,
        status:          'open',
        cashier_id:      req.userId,
        customer_id,
        customer_name,
        shift_id,
        notes:           cleanNote(orderNoteRaw, ORDER_NOTE_MAX),   // A367
        seated_at:       order_type === 'dine_in' ? new Date().toISOString() : null,
        // This path set no idempotency_key whatsoever, so every dine-in order
        // carried NULL and duplicated on replay. See the note on POST / above.
        idempotency_key: crypto.randomUUID(),
        // 'synced', not 'pending' (audit H14). This row was created BY the cloud
        // and already lives in it — there is nothing left for it to sync to.
        // Writing 'pending' and never advancing it meant the tech panel reported
        // 100% of orders permanently pending and zero synced on every install,
        // and, worse, the LOCAL->CLOUD switch selects on sync_status='pending'
        // and so replayed the branch's ENTIRE order history on every switch.
        sync_status:     'synced',
      })
      .select()
      .single();

    if (oErr || !order) {
      sendError(res, oErr, { message: 'Failed to create order' });
      return;
    }

    // 2. Insert order items
    const orderItems = items.map((item: OrderItemInput, idx: number) => ({
      order_id:      order.id,
      product_id:    item.product?.id ?? null,
      product_name:  item.product.name,
      category_name: Array.isArray(item.product.categories)
        ? item.product.categories[0]?.name
        : item.product.categories?.name ?? null,
      unit_price: authLines[idx].unitPrice,
      quantity:   item.quantity,
      subtotal:   authLines[idx].lineTotal,
      notes:      cleanNote(item.notes),   // A367: trimmed and capped, never refused
      course:      item.course ?? null,
      fire_status: item.fire_status === 'held' ? 'held' : 'fired',
    }));

    const { data: insertedItems, error: itemErr } = await supabase
      .from('order_items')
      .insert(orderItems)
      .select();

    if (itemErr) {
      sendError(res, itemErr);
      return;
    }

    // 3. Create kitchen ticket immediately — kitchen starts cooking now
    const { error: ktErr } = await supabase
      .from('kitchen_tickets')
      .insert({ order_id: order.id, branch_id, status: 'new' });

    if (ktErr) console.error('Failed to create kitchen ticket:', ktErr.message);

    // 0.6.28: the item ids, in the order sent — a line taken back later (POST /:id/kitchen-void) names its item.
    res.status(201).json({
      orderId: order.id, orderNumber: order.order_number,
      items: (insertedItems ?? []).map((it: { id: string; product_id: string | null; quantity: number }) =>
        ({ id: it.id, product_id: it.product_id, quantity: Number(it.quantity) })),
    });
  } catch (err) {
    sendError(res, err, { message: 'Failed to open order' });
  }
});

// ── POST /api/orders/:id/kitchen-void ───────────────────────────────────────────
// 0.6.28 — owner, 2026-10-01: a sent order could be cancelled after the customer paid in cash ("the cashier pockets the
// money"). On the web an order sent to the kitchen is an OPEN order here; its items leave it only through this route:
// the item and how many, a reason (shared/kitchenLines.ts), whether the kitchen had already made it — and, with the
// client's 'kitchen_void_approval' switch, a manager (signed in as themselves, or their PIN; no grace period). The
// order's money is recomputed (no discount exists before payment), the void is recorded in kitchen_voids (migration
// 112), and an order with nothing left is voided. The web prints the VOID ticket (it holds the printers).
router.post('/:id/kitchen-void', async (req, res) => {
  const orderId = req.params.id;
  const reason = cleanVoidReason(req.body?.reason);
  if (!reason) { res.status(400).json({ error: 'Choose why these items are being taken back.' }); return; }
  if (typeof req.body?.cooked !== 'boolean') { res.status(400).json({ error: 'Say whether the kitchen had already made them.' }); return; }
  const cooked = req.body.cooked === true;
  const note = cleanVoidNote(req.body?.note);
  const wanted = new Map<string, number>();
  for (const l of Array.isArray(req.body?.lines) ? req.body.lines : []) {
    const id = String(l?.order_item_id ?? ''); const q = Number(l?.qty);
    if (id && q > 0) wanted.set(id, (wanted.get(id) ?? 0) + q);
  }
  if (!wanted.size) { res.status(400).json({ error: 'Nothing to void.' }); return; }

  try {
    const { data: order, error: oErr } = await supabase
      .from('orders')
      .select('id, business_id, branch_id, shift_id, order_number, status, subtotal, order_items ( id, product_id, product_name, unit_price, quantity, subtotal )')
      .eq('id', orderId).eq('business_id', req.businessId).maybeSingle();
    if (oErr) { sendError(res, oErr); return; }
    if (!order) { res.status(404).json({ error: 'Order not found' }); return; }
    if (!assertBranchAccess(req, order.branch_id)) { res.status(403).json({ error: 'You do not have access to this branch' }); return; }
    if (order.status !== 'open') {
      res.status(409).json({ error: `This order is ${order.status} — a paid sale is voided or refunded instead.`, code: 'ORDER_NOT_OPEN' });
      return;
    }

    let approver: { id: string; name: string | null } | null = null;
    if ((await businessPosFeatures(req.businessId!)).kitchen_void_approval) {
      if (req.body?.pin) {
        const key = pinKey(req);   // A494: the one PIN limiter
        if (pinLocked(key)) { res.status(429).json(PIN_LOCKED_BODY); return; }
        // A595: approving a kitchen removal is its own part of shifts.confirm (sales.approve_kitchen_void).
        const found = await confirmerByPin(req.businessId!, String(req.body.pin), req.body?.authorizer_id || undefined,
          { branchId: order.branch_id ?? null, actorId: req.userId ?? null, key: 'sales.approve_kitchen_void' });   // A494
        // A505: the asker's own PIN — someone else must approve; not a wrong guess (no strike towards the PIN lock).
        if (found === 'self') { res.status(403).json(SELF_APPROVAL_BODY); return; }
        if (found === 'none') { res.status(400).json(NO_CONFIRMER_BODY); return; }   // A518: nobody at the branch holds a PIN — no strike
        approver = found;
        if (!approver) {
          notePinFailure(key);
          res.status(403).json({ error: 'That PIN was not recognised. Enter the PIN of a manager (or the owner) on duty.', code: 'INVALID_CONFIRMER_PIN' });
          return;
        }
        notePinSuccess(key);
      } else if (callerMayApprove(req, 'sales.approve_kitchen_void')) {
        approver = { id: req.userId!, name: null };
      } else {
        res.status(403).json({ error: 'A manager must approve this — enter a manager’s PIN.', code: 'KITCHEN_VOID_APPROVAL_REQUIRED' });
        return;
      }
    }

    type Item = { id: string; product_id: string | null; product_name: string; unit_price: number; quantity: number; subtotal: number };
    const items = ((order as any).order_items ?? []) as Item[];
    const plan: Array<{ item: Item; qty: number; unit: number; amount: number; left: number }> = [];
    for (const [id, qty] of wanted) {
      const item = items.find((i) => i.id === id);
      if (!item) { res.status(400).json({ error: 'That item is not on this order.' }); return; }
      const have = Number(item.quantity) || 0;
      if (qty > have + 1e-9) { res.status(400).json({ error: `Only ${have} × ${item.product_name} on this order.` }); return; }
      const unit = have > 0 ? (Number(item.subtotal) || 0) / have : Number(item.unit_price) || 0;
      plan.push({ item, qty, unit, amount: round2(unit * qty), left: Math.round((have - qty) * 1000) / 1000 });
    }

    // The names are stored with the void (a report reads the same after a rename or a departure).
    const ids = [req.userId, approver?.id].filter(Boolean) as string[];
    const { data: people } = await supabase.from('users').select('id, name').in('id', ids);
    const nameOf = (id?: string | null) => (people ?? []).find((u: { id: string }) => u.id === id)?.name ?? null;

    for (const p of plan) {
      const q = p.left > 0
        ? supabase.from('order_items').update({ quantity: p.left, subtotal: round2(p.unit * p.left) }).eq('id', p.item.id)
        : supabase.from('order_items').delete().eq('id', p.item.id);
      const { error } = await q;
      if (error) { sendError(res, error); return; }
    }
    const voidedTotal = round2(plan.reduce((s, p) => s + p.amount, 0));
    const remainingItems = items.filter((i) => !plan.some((p) => p.item.id === i.id && p.left <= 0));
    const newSubtotal = Math.max(0, round2((Number(order.subtotal) || 0) - voidedTotal));
    const nothingLeft = remainingItems.length === 0;
    const { vat, ctl } = await taxSplit(req.businessId!, newSubtotal);
    const { error: uErr } = await supabase.from('orders').update({
      subtotal: newSubtotal, total: newSubtotal, vat_amount: vat, ctl_amount: ctl,
      ...(nothingLeft ? { status: 'voided', void_reason: `Kitchen void: ${voidReasonLabel(reason)}`,
                          voided_at: new Date().toISOString(), voided_by: req.userId, authorized_by: approver?.id ?? null } : {}),
    }).eq('id', orderId);
    if (uErr) { sendError(res, uErr); return; }

    const at = new Date().toISOString();
    const { error: kErr } = await supabase.from('kitchen_voids').insert(plan.map((p) => ({
      business_id: req.businessId, branch_id: order.branch_id, shift_id: order.shift_id ?? null,
      order_number: order.order_number, order_id: order.id, product_id: p.item.product_id ?? null,
      product_name: p.item.product_name, quantity: p.qty, unit_price: round2(p.unit), amount: p.amount,
      reason, note, cooked, cashier_id: req.userId ?? null, cashier_name: nameOf(req.userId),
      approved_by: approver?.id ?? null, approved_by_name: approver ? (approver.name ?? nameOf(approver.id)) : null,
      device_id: deviceIdFromRequest(req) ?? null, created_at: at,
    })));
    if (kErr) { sendError(res, kErr); return; }

    res.json({
      ok: true, total: voidedTotal, remaining: newSubtotal, orderVoided: nothingLeft,
      approvedBy: approver ? (approver.name ?? nameOf(approver.id)) : null,
    });
  } catch (err) {
    sendError(res, err, { message: 'Failed to void the items' });
  }
});

// ── POST /api/orders/:id/pay ───────────────────────────────────────────────────
// Order-first model: attaches payment to an existing open order, deducts stock,
// awards loyalty, and marks the order completed.

router.post('/:id/pay', sells, async (req, res) => {
  const orderId = req.params.id;
  const {
    payments,
    payment,
    customer_id,
    points_redeemed = 0,
    discount_amount = 0,
    discount_id = null,
    tip_amount = 0,
    delivery_fee: deliveryFeeRaw = 0,   // 0.6.27: on top of the bill on a delivery (pass-through, like the tip)
    delivery_free: deliveryFreeRaw = false,   // 0.6.33: the shop pays the rider; the customer pays no fee
  } = req.body;

  const paymentLegs: PaymentLegInput[] = Array.isArray(payments) && payments.length > 0
    ? payments
    : payment ? [payment] : [];

  if (!paymentLegs.length) {
    res.status(400).json({ error: 'At least one payment leg is required' });
    return;
  }

  try {
    // 1. Load the open order
    const { data: order, error: oErr } = await supabase
      .from('orders')
      // order_item_variants comes along because variant options carry stock
      // consequences — stock_factor scales the parent deduction, and
      // linked_product_id / linked_ingredient_id deduct something else entirely.
      // They are stored by NAME here, which applyStockEffects resolves via its
      // product|group|option key path.
      .select('*, order_items ( id, product_id, quantity, subtotal, product_name, category_name, unit_price, notes, order_item_variants ( variant_group_name, variant_option_name ) )')
      .eq('id', orderId)
      .eq('business_id', req.businessId)
      .single();

    if (oErr || !order) { res.status(404).json({ error: 'Order not found' }); return; }
    // A494: a person paying a bill of another branch is refused (the owner may).
    if (!assertBranchAccess(req, order.branch_id)) { res.status(403).json({ error: 'You do not have access to this branch' }); return; }
    if (order.status !== 'open') {
      res.status(400).json({ error: `Order is already ${order.status}` });
      return;
    }
    // A563: an open bill charged on the web — a line that has sold out since it was opened is refused now (only the lines
    // known to be out). Never a till's (a till charges on itself and pushes the finished sale).
    if (!deviceIdFromRequest(req) && !req.isTill && req.surface !== 'desktop') {
      const soldOut = await webSaleStockRefusal(req.businessId, order.branch_id, (order as any).order_items ?? []);
      if (soldOut) { res.status(409).json(soldOut); return; }
    }

    // A494: the customer named must be this business's (their points are deducted below by id), and a redemption is at
    // most what they hold — this path checked neither, so any customer's points (another business's too) could be spent.
    {
      const redeem = Math.max(0, Number(points_redeemed) || 0);
      if (customer_id) {
        const { data: cust, error: cErr } = await supabase.from('customers').select('id, loyalty_points')
          .eq('id', customer_id).eq('business_id', req.businessId).maybeSingle();
        if (cErr) { sendError(res, cErr); return; }
        if (!cust) { res.status(400).json({ error: 'Invalid customer' }); return; }
        if (redeem > (Number((cust as { loyalty_points?: number }).loyalty_points) || 0)) {
          res.status(400).json({ error: 'Insufficient loyalty points' }); return;
        }
      } else if (redeem > 0) {
        res.status(400).json({ error: 'Points can be redeemed only for a customer' }); return;
      }
    }

    // ── L5: a client-supplied discount_id must belong to this business ───────
    if (discount_id) {
      const { data: disc } = await supabase
        .from('discounts')
        .select('id')
        .eq('id', discount_id)
        .eq('business_id', req.businessId)
        .maybeSingle();
      if (!disc) { res.status(400).json({ error: 'Invalid discount' }); return; }
    }

    // ── Credit sale pre-check (audit C5) ──────────────────────────────────────
    // The order-first flow (dine-in) had no credit handling at all — a credit
    // leg here bypassed both the limit check and the balance write that
    // POST /orders already had (partially — see below). Mirrors that check.
    const creditLeg = paymentLegs.find(l => l.method === 'credit');
    let creditCustomerId: string | null = null;
    let payCreditNote = '';   // A511
    let payCreditOk: CreditOk | null = null;   // A545
    if (creditLeg) {
      creditCustomerId = customer_id ?? order.customer_id ?? null;
      if (!creditCustomerId) {
        res.status(400).json({ error: 'A customer is required for a credit sale' });
        return;
      }
      const ca = await creditApproval(req, req.body, order.branch_id ?? null);   // A511
      if ('status' in ca) { res.status(ca.status).json(ca.body); return; }
      payCreditNote = ca.note;
      payCreditOk = ca;
      const creditAmount = Number(creditLeg.amount) || 0;
      const { data: cust } = await supabase
        .from('customers')
        .select('credit_limit, credit_balance')
        .eq('id', creditCustomerId).eq('business_id', req.businessId).single();
      if (!cust) { res.status(400).json({ error: 'Invalid customer' }); return; }
      const available = Number(cust.credit_limit) - Number(cust.credit_balance);
      if (creditAmount > available) {
        res.status(400).json({
          error: `Credit limit exceeded. Available: ${available.toFixed(2)}, required: ${creditAmount.toFixed(2)}`,
        });
        return;
      }
    }

    // ── Recompute the money as a SET before anything is written (audit H2) ───
    // This path used to write discount_amount alone while total and vat_amount
    // kept the figures computed at /open. The books then did not foot: subtotal
    // minus discount did not equal total, and VAT was overstated because it had
    // been charged on the pre-discount figure. Every order-first (dine-in) sale
    // carrying a discount was affected, and the error is in the operator's
    // favour, which is the direction a tax authority notices.
    //
    // Line prices are deliberately NOT re-derived here. `order.subtotal` was
    // already computed authoritatively by recomputeOrderTotals at /open, from
    // the catalogue. Re-deriving it would mean rebuilding the lines from
    // order_items, which this handler does not load with their variants and
    // modifiers — so a rebuild would silently drop every variant and modifier
    // price adjustment and quietly LOWER the bill. Discount and tax are the only
    // things that change here, so they are the only things recomputed.
    const paySubtotal = Number(order.subtotal) || 0;
    // A445: offers on a sale paid after it was opened — checked on its stored lines (their prices were the cloud's at
    // /open), then the manual discount capped on what is left.
    const payClaim = offerClaimFrom(req.body);
    let payOffers: { offerDiscount: number; offers: AppliedOffer[] } = { offerDiscount: 0, offers: [] };
    if (payClaim.ids.length) {
      const its = ((order as any).order_items ?? []) as Array<{ product_id: string | null; quantity: number; subtotal: number }>;
      const pids = [...new Set(its.map((i) => i.product_id).filter(Boolean))] as string[];
      const { data: cats } = pids.length
        ? await supabase.from('products').select('id, category_id').eq('business_id', req.businessId).in('id', pids)
        : { data: [] as any[] };
      const catOf = new Map(((cats ?? []) as any[]).map((c) => [c.id, c.category_id ?? null]));
      payOffers = await checkOfferClaim(req.businessId!, (order as any).branch_id ?? null, its.map((i, n) => ({
        key: String(n), product_id: i.product_id, category_id: i.product_id ? (catOf.get(i.product_id) ?? null) : null,
        unit_price: Number(i.quantity) > 0 ? Number(i.subtotal) / Number(i.quantity) : 0, quantity: Number(i.quantity) || 0,
      })), payClaim, paySubtotal);
    }
    const payManualAsked = payClaim.ids.length ? Math.max(0, (Number(discount_amount) || 0) - payClaim.amount) : discount_amount;
    const payDiscount = round2(payOffers.offerDiscount + capDiscount(payManualAsked, round2(paySubtotal - payOffers.offerDiscount)));
    const payTotal    = round2(paySubtotal - payDiscount);
    // A490: a manual discount on a LIVE web sale is sales.discount (as POST /orders).
    if (await discountRefused(req, round2(payDiscount - payOffers.offerDiscount),
      { discountId: discount_id, base: round2(paySubtotal - payOffers.offerDiscount) })) {   // A494, A595
      res.status(403).json(DISCOUNT_REFUSED); return;
    }
    const { vat: payVat, ctl: payCtl } = await taxSplit(req.businessId, payTotal);

    // Validate the legs reconcile to the recomputed total BEFORE writing them.
    // POST /orders enforces this inside create_order_atomic and REJECTS a
    // mismatch; /pay only logged it (checkPaymentIntegrity), so the two order
    // paths disagreed on whether a wrong-amount order could be completed
    // (finding #14). They now agree: a mismatch here is a 400, nothing is
    // written, and the order stays open to be paid correctly. A one-cent
    // tolerance absorbs rounding. NOTE: if any client sends legs that include a
    // tip in the leg amount, fix it to send legs summing to total (tip is a
    // separate field) BEFORE deploying — see the deploy note for the atomic
    // order fix; the same caution applies here.
    // A tip is money on top of the bill: it belongs in the legs (it is what the
    // customer handed over) but NOT in orders.total (which is what the business
    // recognises, and the base the VAT split is taken from). Reconcile against
    // total + tip. This matches create_order_atomic as of migration 66 — the two
    // order paths must agree on what "paid in full" means, or a sale that is
    // accepted at the counter is refused on the dine-in path and vice versa.
    const payTip = Math.max(0, Number(tip_amount) || 0);
    // 0.6.27: the delivery fee rides on top like the tip (create_order_atomic agrees, migration 111).
    const payFee = order.order_type === 'delivery' ? cleanDeliveryFee(deliveryFeeRaw) : 0;
    const payFree = isFreeDelivery(order.order_type, payFee, deliveryFreeRaw);   // 0.6.33
    const amountDue = round2(payTotal + payTip + customerDeliveryFee(payFee, payFree));
    const legSum = paymentLegs.reduce((s, l) => s + (Number(l.amount) || 0), 0);
    if (Math.abs(legSum - amountDue) > 0.01) {
      res.status(400).json({
        error: `Payment legs sum to ${legSum.toFixed(2)} but the amount due is ${amountDue.toFixed(2)} `
             + `(total ${payTotal.toFixed(2)} + tip ${payTip.toFixed(2)}${payFee ? ` + delivery fee ${payFee.toFixed(2)}` : ''}).`,
        code: 'PAYMENT_MISMATCH',
      });
      return;
    }

    // 2. Insert payment legs
    const paymentRows = paymentLegs.map((leg: PaymentLegInput) => ({
      order_id:        order.id,
      business_id:     req.businessId,
      branch_id:       order.branch_id,
      method:          leg.method,
      amount:          leg.amount,
      amount_tendered: leg.amount_tendered ?? null,
      change_given:    leg.change_given ?? null,
      reference:       leg.reference ?? null,
      status:          'completed',
      sync_status:     'pending',
      mpesa_checkout_id: leg.mpesa_checkout_id ?? null,
    }));

    // ── 2. CLAIM THE ORDER BEFORE WRITING ANYTHING (audit B1) ────────────────
    //
    // The status check above is a READ. Between that read and the write below
    // there was nothing stopping a second request doing the same thing: a
    // double-tapped Charge button, or the till retrying after a timeout on a
    // request that had actually succeeded. Both requests passed the check, both
    // inserted payment legs, both ran applyStockEffects, both awarded loyalty.
    // Net effect: the drawer over-reports, stock under-reports, and the customer
    // earns points twice — none of it visible until close.
    //
    // POST /orders has been safe from this since migration 54: an idempotency
    // key with a partial unique index behind it. /pay has never had either.
    //
    // The fix is to make the STATUS TRANSITION the lock. `.eq('status','open')`
    // means exactly one request can move the row out of 'open'; PostgREST
    // applies that as a WHERE on the UPDATE, so the loser matches no rows and
    // changes nothing. `.select()` is what makes the outcome legible — without
    // it supabase-js returns no rows and a lost claim is indistinguishable from
    // a won one.
    //
    // The claim happens FIRST, before the payment legs, because the legs are the
    // thing we must not write twice. Losing the claim now costs nothing.
    const orderUpdate: Record<string, unknown> = {
      status:          'completed',
      discount_amount: payDiscount,
      offer_discount:  payOffers.offerDiscount,                                  // A445
      offers:          payOffers.offers.length ? payOffers.offers : null,        // A445
      total:           payTotal,
      vat_amount:      payVat,
      ctl_amount:      payCtl,
      discount_id,
      // The dine-in path never stored the tip at all — a tip taken at the table
      // was money in the drawer that the books had no record of, which reads as
      // an unexplained cash surplus at close.
      tip_amount:      payTip,
      delivery_fee:    payFee,   // 0.6.27
      delivery_free:   payFree,  // 0.6.33
      // Points redeemed on this order. The counter path has always written this
      // (it is read back by GET /orders); the dine-in path never did, so every
      // table order reported zero points redeemed however many were taken.
      loyalty_points_used: Math.max(0, Number(points_redeemed) || 0),
      sync_status:     'pending',
    };
    // Only touch customer_id if this request actually supplied one — don't
    // clobber whatever was set when the order was opened.
    if (customer_id) orderUpdate.customer_id = customer_id;

    const { data: claimed, error: uErr } = await supabase
      .from('orders')
      .update(orderUpdate)
      .eq('id', order.id)
      .eq('status', 'open')      // ← the lock
      .select('id, order_number, total, tip_amount');

    if (uErr) { sendError(res, uErr); return; }

    if (!claimed || claimed.length === 0) {
      // We lost the claim. Somebody else paid this order between our read and
      // our write.
      //
      // DELIBERATELY NOT AN ERROR. The order is paid and the drawer is shut.
      // Telling the cashier "that failed" when the money is in the till is the
      // worse outcome by a distance — they re-charge, and now there are two
      // sales. So we return exactly what the winning request returned and the
      // cashier never learns there was a race.
      //
      // The one thing we do NOT do is stay silent about a genuine discrepancy.
      // If the winner settled a different amount, this was not a duplicate of
      // our request — it was a different payment — and that belongs in front of
      // whoever reconciles the day, not in front of the cashier mid-service.
      const { data: settled } = await supabase
        .from('orders')
        .select('id, order_number, status, total, tip_amount, delivery_fee, delivery_free')
        .eq('id', order.id)
        .single();

      const settledDue = round2(Number(settled?.total ?? 0) + Number(settled?.tip_amount ?? 0)
        + customerDeliveryFee((settled as any)?.delivery_fee, (settled as any)?.delivery_free));   // 0.6.33
      if (settled && Math.abs(settledDue - amountDue) > 0.01) {
        await supabase.from('payment_exceptions').insert({
          business_id:     req.businessId,
          order_id:        order.id,
          expected_amount: amountDue,
          received_amount: settledDue,
          reason:
            'Concurrent /pay on the same order settled a different amount. The first '
            + 'request won and its figures stand. This request was not applied.',
        }).then(() => {}, e => console.error('[pay] exception log failed:', e));
        console.warn(`[pay] concurrent settle mismatch on ${order.order_number}: `
                   + `this request ${amountDue}, settled ${settledDue}`);
      }

      res.json({ orderId: order.id, orderNumber: order.order_number, duplicate: true });
      return;
    }

    // ── 2b. We own the order. Now it is safe to write the money. ─────────────
    const { error: pErr } = await supabase.from('payments').insert(paymentRows);
    if (pErr) { sendError(res, pErr); return; }

    // 0.6.27: a web tab's rider is paid the fee in cash from its shift's drawer (a till pays its own).
    if (payFee > 0 && req.surface !== 'desktop') {
      await payRider({ orderId: order.id, orderNumber: order.order_number, shiftId: (order as any).shift_id ?? null,
                       branchId: order.branch_id, cashierId: (order as any).cashier_id ?? req.userId ?? null, fee: payFee,
                       rider: (order as any).delivery_person ?? null });
    }

    checkPaymentIntegrity(order.order_number, order.id, payTotal, paymentRows);

    // 3b. Credit sale — record the debt (audit C5). Same RPC and same
    // log-and-continue pattern as POST /orders' equivalent block: the order
    // is already marked completed above with no surrounding transaction
    // (M7), so a failure here is logged, not thrown.
    if (creditLeg) {
      const { error: creditErr } = await supabase.rpc('apply_credit_transaction', {
        p_business_id:   req.businessId,
        p_customer_id:   creditCustomerId,
        p_branch_id:     order.branch_id,
        p_order_id:      order.id,
        p_type:          'charge',
        p_amount:        Math.abs(Number(creditLeg.amount) || 0),
        p_method:        null,
        p_reference:     null,
        p_notes:         `Credit sale ${order.order_number}${payCreditNote}`,   // A511: and who approved it
        p_created_by:    req.userId ?? null,
        p_enforce_limit: true,
      });
      if (creditErr) console.error('[credit] charge failed for order', order.id, creditErr.message);
      // A545: a live payment on account — approved at the counter (born confirmed) or awaiting a manager.
      await recordCreditSale({
        businessId: req.businessId!, orderId: order.id, branchId: order.branch_id ?? null, customerId: creditCustomerId,
        amount: Math.abs(Number(creditLeg.amount) || 0), source: req.surface === 'desktop' ? 'till' : 'web',
        approvedAtSale: !!payCreditOk?.approvedAtSale, approvedBy: payCreditOk?.approvedBy ?? null,
        approverName: payCreditOk?.approverName ?? null, cashierId: (order as any).cashier_id ?? req.userId ?? null,
      });
    }

    // 4. Stock — the SAME effects POST /orders applies.
    //
    // What was here before: a loop that read stock_levels and wrote back
    // quantity - item.quantity. That is all. It ignored track_stock, so it
    // decremented products explicitly marked as untracked. It ignored
    // sold_by='piece', so piece-sold products lost whole units instead of
    // pieces. It wrote no stock_movements row, so none of it was auditable.
    // And it did no recipe, variant-linked, packaging or fuel deduction at all.
    //
    // Restaurants are the businesses that use this path, and restaurants are
    // the businesses with recipes — so the recipe system was bypassed on the
    // one path built for it. Every dine-in service overstated ingredient stock
    // silently.
    await applyStockEffects({
      businessId:  req.businessId,
      branchId:    order.branch_id,
      userId:      req.userId,
      orderId:     order.id,
      orderNumber: order.order_number,
      orderType:   order.order_type,
      pumpId:      order.pump_id ?? null,
      lines: (order.order_items ?? []).map((it: any) => ({
        productId: it.product_id ?? null,
        quantity:  Number(it.quantity) || 0,
        // Rebuilt from the DB, so names only — no optionId. lineStockImpact
        // falls back to the product|group|option key, which is why that lookup
        // is keyed both ways.
        variants: (it.order_item_variants ?? []).map((v: any) => ({
          groupName:  v.variant_group_name,
          optionName: v.variant_option_name,
        })),
      })),
    });

    // ── 5. Loyalty — THE SAME loyalty POST /orders applies (audit B2) ────────
    //
    // BUG-07 fixed redemption here and left the award side alone, so the two
    // order paths drifted into disagreeing about almost everything:
    //
    //   earn formula      counter: floor(total/10) x earnRate   here: floor(total/100)
    //   tier multiplier   counter: applied                      here: ignored
    //   ledger row        counter: written                      here: none
    //   total_spent       counter: updated                      here: never
    //
    // With the default earn rate of 1 that is a TEN-FOLD difference: a KES 1,000
    // bill earned 100 points at the counter and 10 at the table. Same customer,
    // same spend, different answer depending on where they sat. And because no
    // loyalty_transactions row was written, the balance could not be reconciled
    // against the ledger to notice.
    //
    // total_spent matters beyond loyalty: it is what every RFM and CRM segment
    // is built on. Its string-concatenation bug was fixed on the counter path
    // and the column stayed dead here — for restaurants, which are the
    // businesses that use this path at all.
    if (customer_id) {
      // 5a. Deduct redeemed points.
      //
      // adjust_loyalty_points (migration 67) is deliberately NOT
      // increment_loyalty_points with a negative number — that one also does
      // visit_count + 1, which would count a redemption as another visit and
      // double-count any order that both redeems and earns.
      //
      // (What this replaced: .update({ loyalty_points: supabase.rpc('decrement') }).
      // supabase.rpc() returns a lazy query BUILDER, never awaited, serialised
      // into the update body as JSON, result not destructured. No such function
      // exists in any migration. Customers redeemed their points and kept them.)
      const redeemPts = Math.max(0, Number(points_redeemed) || 0);
      if (redeemPts > 0) {
        const { error: redeemErr } = await supabase.rpc('adjust_loyalty_points', {
          p_customer_id: customer_id,
          p_points:      -redeemPts,
        });
        if (redeemErr) {
          console.error('[orders/pay] loyalty redemption failed:', redeemErr.message);
        } else {
          // The ledger row the counter path has always written. Without it the
          // points balance is a number with no history behind it.
          await supabase
            .from('loyalty_transactions')
            .insert({
              customer_id,
              business_id: req.businessId,
              order_id:    order.id,
              type:        'redeem',
              points:      -redeemPts,
              notes:       `Redeemed on order ${order.order_number}`,
            });
        }
      }

      // 5b. Earn on the net total, at the business's configured rate, with the
      //     customer's tier multiplier. Identical arithmetic to POST /orders —
      //     if that formula ever changes it must change in one place, which is
      //     why both paths now read it from the same helpers.
      //
      //     payTotal, not order.total: order.total is the pre-discount figure
      //     this handler has just superseded, so awarding on it would earn the
      //     customer points for money nobody paid.
      const earnRate = await getLoyaltyEarnRate(req.businessId);
      const { data: customerForTier } = await supabase
        .from('customers')
        .select('loyalty_points')
        .eq('id', customer_id)
        .single();

      const { multiplier } = getTier(Number(customerForTier?.loyalty_points ?? 0));
      const basePoints   = Math.floor(payTotal / 10) * earnRate;
      const pointsToEarn = Math.floor(basePoints * multiplier);

      // awardLoyaltyPoints, not a bare rpc(): it carries the PGRST202 fallback
      // AND writes the loyalty_transactions row. Calling the RPC directly is
      // what left dine-in awards out of the ledger.
      if (pointsToEarn > 0) {
        await awardLoyaltyPoints(customer_id, req.businessId, order.id, pointsToEarn, order.order_number);
      }

      // 5c. total_spent. numeric(12,2) arrives from PostgREST as a STRING, so
      //     both operands are coerced before the addition — "1500.00" + 890
      //     concatenates to "1500.00890" rather than adding, which is how this
      //     column died on the counter path before it was fixed there.
      // ATOMIC (register A55) — see the note at the paid path above. A payment
      // recorded against an existing order adds spend but is NOT a second
      // visit, which is why visit_count is deliberately untouched here.
      await supabase.rpc('increment_customer_spend', {
        p_customer_id: customer_id,
        p_amount:      payTotal,
      });
    }

    // 6. Increment discount usage
    if (discount_id) {
      await supabase.rpc('increment_discount_usage', { discount_uuid: discount_id });
    }

    // 7. Fire webhook — non-blocking
    fireWebhook(req.businessId, 'order.completed', {
      order_id: order.id, order_number: order.order_number,
      order_type: order.order_type, total: payTotal,
      branch_id: order.branch_id, cashier_id: req.userId,
    }).catch(() => {});

    // 8. Fiscalise with KRA eTIMS — non-blocking; never fails the sale.
    fiscaliseInvoice(order.id).catch((e) => console.error('[etims] fiscaliseInvoice:', e?.message));

    res.json({ orderId: order.id, orderNumber: order.order_number });
  } catch (err) {
    sendError(res, err, { message: 'Failed to process payment' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Restaurant dine-in: course firing, split bill, turnover (items 11–13)
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/orders/:id/fire-course
// Body: { course } — fires all 'held' items of that course to the kitchen.
// Marks them fired and (re)issues a kitchen ticket so the line sees them.
router.post('/:id/fire-course', sells, async (req, res) => {
  const { id } = req.params;
  const { course } = req.body;
  if (!course) { res.status(400).json({ error: 'course is required' }); return; }

  // Order must belong to this business.
  const { data: order } = await supabase
    .from('orders').select('id, branch_id').eq('id', id).eq('business_id', req.businessId).single();
  if (!order) { res.status(404).json({ error: 'Order not found' }); return; }
  if (!assertBranchAccess(req, order.branch_id)) { res.status(403).json({ error: 'You do not have access to this branch' }); return; }   // A494

  const { data: fired, error } = await supabase
    .from('order_items')
    .update({ fire_status: 'fired', fired_at: new Date().toISOString() })
    .eq('order_id', id).eq('course', course).eq('fire_status', 'held')
    .select('id');
  if (error) { sendError(res, error); return; }

  // New kitchen ticket for the fired course so the KDS/printer picks it up.
  if ((fired?.length ?? 0) > 0) {
    await supabase.from('kitchen_tickets').insert({
      order_id: id, branch_id: order.branch_id, station: course, status: 'new',
    });
  }

  res.json({ fired: fired?.length ?? 0 });
});

// A8: PATCH /api/orders/:id/split was RETIRED. It wrote order_items.sub_bill for a
// by-item split, but sub_bill was read nowhere (dead column) and its only caller,
// SplitBillModal, was never mounted. Bill splitting is handled at payment time by
// PaymentModal's split modes (by method / evenly / by item), which collect N legs
// summing to the total against one order via POST /:id/pay. Do not re-add a
// sub_bill writer without a consumer. (sub_bill column left in place; drop via a
// migration if desired.)

// GET /api/orders/turnover?branch_id=  — live dwell time for open dine-in orders.
// Returns each open dine-in order with minutes seated and an `over` flag against
// the business's turnover_alert_minutes setting.
router.get('/turnover', requirePermission('orders.view_all'), async (req, res) => {   // A490
  if (oneBranchOnly(req, res)) return;   // A582: one branch's tables at a time
  const branchId = (req.query.branch_id as string) || branchScope(req);
  if (!branchId) { res.status(400).json({ error: 'branch_id is required' }); return; }
  if (!assertBranchAccess(req, branchId)) { res.status(403).json({ error: 'Forbidden' }); return; }

  const { data: setting } = await supabase
    .from('business_settings').select('value')
    .eq('business_id', req.businessId).eq('key', 'turnover_alert_minutes').maybeSingle();
  let threshold = 90;
  if (setting?.value !== undefined) {
    const v = typeof setting.value === 'string' ? JSON.parse(setting.value) : setting.value;
    threshold = Number(v) || 90;
  }

  const { data: orders } = await supabase
    .from('orders')
    .select('id, table_number, covers, seated_at, total')
    .eq('business_id', req.businessId).eq('branch_id', branchId)
    .eq('order_type', 'dine_in').eq('status', 'open');

  const now = Date.now();
  const rows = (orders ?? [] as Array<{ id: string; table_number: string | null; covers: number | null; seated_at: string | null; completed_at: string | null; total: string }>).map(o => {
    const seated = o.seated_at ? new Date(o.seated_at).getTime() : now;
    const minutes = Math.floor((now - seated) / 60000);
    return {
      order_id: o.id, table_number: o.table_number, covers: o.covers,
      seated_at: o.seated_at, minutes_seated: minutes, over: minutes >= threshold,
    };
  }).sort((a, b) => b.minutes_seated - a.minutes_seated);

  res.json({ threshold_minutes: threshold, tables: rows });
});

// GET /api/orders/turnover/report?branch_id=&from=&to=  — avg dwell per table.
router.get('/turnover/report', requirePermission('reports.sales'), async (req, res) => {
  if (oneBranchOnly(req, res)) return;   // A582: one branch's tables at a time
  const branchId = (req.query.branch_id as string) || branchScope(req);
  if (!branchId) { res.status(400).json({ error: 'branch_id is required' }); return; }
  if (!assertBranchAccess(req, branchId)) { res.status(403).json({ error: 'Forbidden' }); return; }

  let q = supabase
    .from('orders')
    .select('table_number, seated_at, updated_at')
    .eq('business_id', req.businessId).eq('branch_id', branchId)
    .eq('order_type', 'dine_in').eq('status', 'completed')
    .not('seated_at', 'is', null);
  if (req.query.from) q = q.gte('created_at', req.query.from as string);
  if (req.query.to)   q = q.lte('created_at', req.query.to as string);

  const { data, error } = await q;
  if (error) { sendError(res, error); return; }

  // Aggregate avg dwell minutes per table.
  const agg: Record<string, { total: number; count: number }> = {};
  (data ?? [] as Array<{ table_number: string | null; total: string; covers: number | null; seated_at: string | null; completed_at: string | null }>).forEach(o => {
    if (!o.table_number || !o.seated_at || !o.updated_at) return;
    const mins = (new Date(o.updated_at).getTime() - new Date(o.seated_at).getTime()) / 60000;
    if (mins < 0) return;
    const key = o.table_number;
    (agg[key] ??= { total: 0, count: 0 });
    agg[key].total += mins; agg[key].count += 1;
  });

  const rows = Object.entries(agg).map(([table, v]) => ({
    table_number: table, covers_served: v.count,
    avg_minutes: Math.round(v.total / v.count),
  })).sort((a, b) => b.avg_minutes - a.avg_minutes);

  res.json({ tables: rows });
});

// POST /api/orders/:id/whatsapp-receipt
// Body: { phone? } — sends the receipt to the customer's WhatsApp. Uses the
// order's customer_phone if no phone is supplied. Non-blocking-safe (logs the
// attempt; returns the delivery status).
// A494: the receipt of a sale they rang themselves (as the till: "print my receipt now" is the cashier's own), else
// sales.reprint; to the ORDER's phone — another number only for someone who may change customers' details
// (customers.edit). It was open to anyone, to any number, for any branch's order.
router.post('/:id/whatsapp-receipt', async (req, res) => {
  const { id } = req.params;
  const { data: order } = await supabase
    .from('orders')
    .select('id, business_id, branch_id, cashier_id, order_number, total, tip_amount, customer_phone, customer_name')
    .eq('id', id).eq('business_id', req.businessId).single();
  if (!order) { res.status(404).json({ error: 'Order not found' }); return; }
  if (!assertBranchAccess(req, (order as any).branch_id)) { res.status(403).json({ error: 'You do not have access to this branch' }); return; }
  const ownSale = !req.isTill && !!req.userId && (order as any).cashier_id === req.userId;
  if (!ownSale && !can(req, 'sales.reprint')) {
    res.status(403).json({ error: 'Sending another person’s receipt again needs the reprint permission.', detail: 'Missing permission: sales.reprint' });
    return;
  }

  // A595: a masked number (what the screen was shown) means the order's own number.
  const asked = typeof req.body?.phone === 'string' && !isMasked(req.body.phone) ? req.body.phone.trim() : '';
  if (asked && asked !== order.customer_phone && !can(req, 'customers.edit')) {
    res.status(403).json({ error: 'Only someone who may edit customers sends a receipt to another number.', detail: 'Missing permission: customers.edit' });
    return;
  }
  const phone = asked || order.customer_phone;
  if (!phone) { res.status(400).json({ error: 'No phone number for this customer' }); return; }

  const { data: biz } = await supabase
    .from('businesses').select('name, currency').eq('id', req.businessId).single();
  const currency = biz?.currency ?? 'KES';
  const grand = Number(order.total) + Number(order.tip_amount ?? 0);
  const totalStr = `${currency} ${grand.toLocaleString('en-KE', { minimumFractionDigits: 2 })}`;
  const receiptText =
    `${biz?.name ?? 'Receipt'}\nOrder ${order.order_number}\nTotal: ${totalStr}` +
    (Number(order.tip_amount) > 0 ? `\n(incl. tip ${currency} ${Number(order.tip_amount).toFixed(2)})` : '') +
    `\nThank you!`;

  await sendReceiptWhatsApp(supabase, {
    businessId: req.businessId, orderId: id, toPhone: phone,
    businessName: biz?.name ?? 'ZapTill', total: totalStr, receiptText,
  });

  // Return the latest delivery row's status.
  const { data: log } = await supabase
    .from('whatsapp_deliveries').select('status, error')
    .eq('order_id', id).order('created_at', { ascending: false }).limit(1).maybeSingle();
  res.json({ status: log?.status ?? 'unknown', error: log?.error ?? null });
});

export default router;
