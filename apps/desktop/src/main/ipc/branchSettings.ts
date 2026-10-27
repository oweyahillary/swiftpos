// IPC: branch settings set from the till — receipt text, continuous operation, reversal rules, offers, payment
// methods, M-Pesa, cashier history. Registered from ipcHandlers.ts (D10).
import { offeredVersion, shareDir, shareProgress, tillVersions } from '../updateShare';   // A443, A496
import { cleanOffer, type Offer } from '../offers';   // A445
import { app } from 'electron';
import { assertPayload } from '../ipcValidate';
import { historyMethodsSettingValue, CASHIER_HISTORY_METHODS_KEY } from '@zaptill/core/cashierHistory';
import { getLocalDb } from '../localDb';
import { setReceiptPay } from '../receiptPay';
import { syncAll } from '../syncEngine';
import { tillBranchId } from '../deviceConfig';   // A446
import { signedIn as sessionPerson, personKeys, hasMarker, isOwnerRole } from '../tillAccess';
import { maySetMpesa } from '../permissions';   // A492
import { cleanMpesaReceive, mpesaLabel, mpesaReceiptNumber, type MpesaReceive } from '@zaptill/core/mpesaReceive';   // A492
import { getDeviceConfig, saveDeviceConfig, getReversalRules, setReversalRules, getCashierHistoryMethods, setCashierHistoryMethods, getPaymentMethodsEnabled, setPaymentMethodsEnabled } from '../deviceConfig';
import { isReversalSettingKey, reversalSettingValue } from '@zaptill/core/reversalRules';
import { type IpcShared } from './shared';

/** Branch settings from the till: receipt text, continuous operation, reversal rules, offers, payment methods, M-Pesa, cashier history. */
export function registerBranchSettingsHandlers(ctx: IpcShared) {
  const { handle, requireKey, manageFetch, refreshCatalogue, PAYMENTS_REFUSED, requireOnlineLicence } = ctx;

  handle('manage:getReceiptText', async () => {
    const cfg = getDeviceConfig();
    return { header: cfg?.receipt_header ?? '', footer: cfg?.receipt_footer ?? '' };
  });
  handle('manage:setReceiptText', async (_e, { header, footer }: { header: string; footer: string }) => {
    requireKey(['receipt.manage'], 'Your role does not change the receipt text.');   // A490
    // The endpoint upserts ONE key/value pair per call — posting an object of
    // keys returns "key and value are required". Two sequential calls.
    await manageFetch('/api/business/settings', 'POST', { key: 'receipt_header', value: header });
    const out = await manageFetch('/api/business/settings', 'POST', { key: 'receipt_footer', value: footer });
    // Cache immediately so the next receipt is right even before a full sync.
    saveDeviceConfig({ receipt_header: header, receipt_footer: footer });
    await refreshCatalogue();
    return out;
  });

  // 24-hour / continuous operation (A104), per business. Read from the cached
  // config; written to business_settings so it reaches every till, and cached
  // locally at once so the day gate honours it before the next sync.
  handle('manage:getContinuousOperation', async () => {
    return { enabled: getDeviceConfig()?.continuous_operation === true };
  });
  handle('manage:setContinuousOperation', async (_e, enabled: boolean) => {
    requireKey(['settings.business'], 'Only someone who manages the business settings can change that.');   // A490
    const out = await manageFetch('/api/business/settings', 'POST', {
      key: 'continuous_operation', value: enabled ? 'true' : 'false',
    });
    saveDeviceConfig({ continuous_operation: !!enabled });
    return out;
  });

  // 0.6.30 (A336 stage 3): the owner's void window and offline void/refund rules, from Manager → Settings. The cloud
  // stores only what the owner sends (routes/business.ts refuses anyone else); this till uses the new value at once.
  handle('manage:setReversalRule', async (_e, payload) => {
    const { key, value } = assertPayload<{ key: string; value: unknown }>({ key: { t: 'string', min: 1 }, value: { t: 'any' } }, payload);
    if (!isReversalSettingKey(key)) throw new Error('Not one of the owner\'s rules.');
    // The owner's own rules (void window, offline refunds, free delivery) — the owner only, as the cloud (A490: '*').
    if (!personKeys(sessionPerson()?.roleName, sessionPerson()?.permissions).has('*')) throw new Error('Only the owner sets these rules.');
    const clean = reversalSettingValue(key, value);
    if (clean === null) throw new Error('That value is not allowed.');
    const out = await manageFetch('/api/business/settings', 'POST', { key, value: JSON.parse(clean) });
    const now = getReversalRules();
    setReversalRules({
      voidWindowMinutes: key === 'void_window_minutes' ? JSON.parse(clean) : now.voidWindowMinutes,
      offlineRefundMethods: key === 'offline_refund_methods' ? JSON.parse(clean) : now.offlineRefundMethods,
      offlineReverseWebSales: key === 'offline_reverse_web_sales' ? JSON.parse(clean) : now.offlineReverseWebSales,
      freeDeliveryAllowed: key === 'delivery_free_allowed' ? JSON.parse(clean) : now.freeDeliveryAllowed,   // 0.6.33
      freeDeliveryOver: key === 'delivery_free_over' ? (JSON.parse(clean) || null) : now.freeDeliveryOver,  // 0.6.33
    });
    return out;
  });

  // 0.6.37 (A387): the payment methods a cashier's History shows, from Manager → Settings. The cloud stores it for the
  // business (settings.manage); this till uses the new list at once, the others on their next pull.
  // A429: the payment methods this branch takes — the payment screen reads them (null = not told yet = the catalogue's
  // defaults); a manager switches them for the branch (the cloud checks settings.manage and the codes), and this till uses
  // the new list at once, the branch's other tills on their next pull.
  handle('pos:paymentMethodsEnabled', async () => ({ enabled: getPaymentMethodsEnabled() }));
  // A443: on the branch server — the version it holds for its tills, and which version each till said it runs.
  handle('node:tillVersions', async () => {
    // A496: the version the server offers its tills is the approved one it holds (never a copy left from before a
    // roll-back), with how its own fetch of that version is going (fetching / failed, why, bytes).
    const ready = offeredVersion(shareDir());
    return { serverVersion: app.getVersion(), ready, share: shareProgress(), tills: tillVersions(ready ?? app.getVersion()) };
  });
  // A445: the branch's offers, as the till holds them (pulled with the menu) — the cart applies them by this clock.
  handle('pos:offers', async () => {
    const rows = getLocalDb().prepare(`SELECT data FROM offers`).all() as Array<{ data: string }>;
    const offers = rows.flatMap((r) => { try { const c = cleanOffer(JSON.parse(r.data)); return c.ok ? [(c as { offer: Offer }).offer] : []; } catch { return []; } });
    return { offers, branchId: tillBranchId() };
  });
  // A445: Manager › Offers — read and change the cloud's (online only; the till learns of a change on its next pull,
  // which is asked for at once).
  // A490: discounts, promotions and offers — menu.offers.
  const OFFERS_REFUSED = 'Your role does not set up offers.';
  handle('manage:offers', async () => { requireKey(['menu.offers'], OFFERS_REFUSED); return manageFetch('/api/offers', 'GET'); });
  handle('manage:saveOffer', async (_e, raw) => {
    requireOnlineLicence();   // A460
    requireKey(['menu.offers'], OFFERS_REFUSED);   // A490
    const c = cleanOffer(raw);
    if (!c.ok) throw new Error((c as { error: string }).error);
    const id = String((raw as any)?.id ?? '');
    const out = await manageFetch(id ? `/api/offers/${encodeURIComponent(id)}` : '/api/offers', id ? 'PATCH' : 'POST', (c as { offer: Offer }).offer);
    syncAll().catch(console.error);
    return out;
  });
  handle('manage:deleteOffer', async (_e, id: string) => {
    requireOnlineLicence();   // A460
    requireKey(['menu.offers'], OFFERS_REFUSED);   // A490
    const out = await manageFetch(`/api/offers/${encodeURIComponent(String(id))}`, 'DELETE');
    syncAll().catch(console.error);
    return out;
  });
  handle('manage:setPaymentMethodsEnabled', async (_e, codes) => {
    requireKey(['settings.payments'], PAYMENTS_REFUSED);   // A490
    const list = (Array.isArray(codes) ? codes : []).map((c) => String(c).trim().toLowerCase());
    const branchId = tillBranchId();   // A446: the signed-in person's branch when the till never recorded one
    if (!branchId) throw new Error('This POS does not know its branch yet — sign in once with a staff PIN, then try again.');
    const out = await manageFetch(`/api/branches/${encodeURIComponent(branchId)}/settings`, 'POST', { key: 'payment_methods_enabled', value: list });
    setPaymentMethodsEnabled(list);
    return out;
  });
  // A492: the branch's M-Pesa number (Buy Goods till number, or Paybill + account) — set HERE, on the till, by its manager
  // (owner, 2026-10-15). settings.mpesa (or, on a map from before the catalogue, receipt.manage — who set the receipt's
  // payment line before). The cloud checks again, keeps it per branch and tells the owner of every change.
  const MPESA_REFUSED = 'Your role may not change the branch\'s M-Pesa number.';
  const mayMpesa = (): boolean => {
    const me = sessionPerson();
    if (!me) return false;
    return isOwnerRole(me.roleName) || maySetMpesa(personKeys(me.roleName, me.permissions), !hasMarker(me.permissions));
  };
  handle('manage:getMpesa', async () => {
    if (!sessionPerson()) throw new Error('Not signed in');
    const branchId = tillBranchId();
    if (!branchId) throw new Error('This POS does not know its branch yet — sign in once with a staff PIN, then try again.');
    const out = await manageFetch(`/api/branches/${encodeURIComponent(branchId)}/mpesa`, 'GET') as
      { own: MpesaReceive | null; inherited: MpesaReceive | null; canEdit?: boolean };
    return { own: out?.own ?? null, inherited: out?.inherited ?? null, canEdit: mayMpesa() && out?.canEdit !== false };
  });
  handle('manage:setMpesa', async (_e, raw) => {
    if (!sessionPerson()) throw new Error('Not signed in');
    if (!mayMpesa()) throw new Error(MPESA_REFUSED);
    const branchId = tillBranchId();
    if (!branchId) throw new Error('This POS does not know its branch yet — sign in once with a staff PIN, then try again.');
    const clear = (raw as any)?.clear === true;
    const c = clear ? null : cleanMpesaReceive(raw as any);
    if (c && 'error' in c) throw new Error(c.error);
    const value = c && 'value' in c ? c.value : null;
    const out = await manageFetch(`/api/branches/${encodeURIComponent(branchId)}/mpesa`, 'PUT', value ?? { clear: true });
    // This till prints the new line at once (the branch's other tills take it within 20 s — the cloud's version moves).
    setReceiptPay(value ? { label: mpesaLabel(value.kind), number: mpesaReceiptNumber(value) } : null);
    syncAll().catch(console.error);
    return out;
  });
  handle('manage:getCashierHistoryMethods', async () => ({ methods: getCashierHistoryMethods() }));
  handle('manage:setCashierHistoryMethods', async (_e, methods) => {
    requireKey(['settings.business'], 'Only someone who manages the business settings can change that.');   // A490
    const clean = historyMethodsSettingValue(methods);
    if (clean === null) throw new Error('Choose payment methods from the list.');
    const out = await manageFetch('/api/business/settings', 'POST', { key: CASHIER_HISTORY_METHODS_KEY, value: JSON.parse(clean) });
    setCashierHistoryMethods(clean);
    return out;
  });
}
