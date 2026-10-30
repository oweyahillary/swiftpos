// IPC: what more than one ipc/*.ts module uses — the helpers and state that were the closure of the one
// registerIpcHandlers() before D10 split it. createIpcShared() builds them once per registerIpcHandlers() call, so
// the state below (the last manage failure, the offline sign-in upgrade timer) stays a single instance.
import { app } from 'electron';
import { isNodeRole } from '../deviceConfig';
import { printSale, escposEnabled } from '../escposBridge';
import { kitchenPreset, dispatchPreset, receiptPreset, monoRasterFromString, type MonoRaster } from '@swiftpos/printing';
import { assignments } from '../print/printWorker';
import { getLocalDb, getBranding, effectiveReceiptFooter } from '../localDb';
import { logLine } from '../logFile';
import { readSessionTokens, readStaffTokens, writeStaffTokens } from '../tokenStore';
import { getReceiptPay } from '../receiptPay';
import { cloudFetch } from '../cloudGateway';
import { cacheStaffCredential, verifyPinOffline } from '../pinCache';
import { assertPinAllowed, recordPinFailure } from '../pinAttempts';
import path from 'path';   // A516
import { configureStaffSession, syncAll, syncPush, refreshAccessToken, refreshStaffToken, pullWebSales } from '../syncEngine';
import { receiptClassicFrom, kitchenFontBFrom } from '@zaptill/core/posFeatures';
import { signedIn as sessionPerson, signedInCan, personCan, roleCeilingRefusal, mayActOn, type PersonLike } from '../tillAccess';
import { getCloudUrl, getDeviceConfig, getPosFeatures } from '../deviceConfig';
import { localShiftIds, type ForeignCash } from '../shiftService';
import { type RangePreset } from '../managerReports';
import { createOpenBills } from '../sellGate';
import { normaliseCode } from '../terminalCodes';
import { localOrderDetail } from '../managerReports';   // A444
import { detailFromCloud, type OrderDetail } from '@zaptill/core/orderDetail';
import { verifyPinAtNodeClient } from '../nodeClient';
import { isUnreachableStatus, ForeignPageError } from '../authTransport';   // A529: ForeignPageError
import { heldOfflinePin, upgradeOfflineSession, OFFLINE_SESSION_MESSAGE, NO_CONNECTION_MESSAGE, type ManageOfflineReason } from '../offlineSession';
import { verifyPinAtNode } from '../branchStaff';
import type { installValidatedHandle } from '../ipcGuard';


/** A312: the receipt logo the print path should use right now, or undefined. Reads the
 *  local branding row (synced remote-wins from the cloud, or tech-set); the toggle gates it. */
export function resolveReceiptLogo(): MonoRaster | undefined {
  const b = getBranding();
  if (!b || !b.receiptLogoEnabled || !b.logoReceipt) return undefined;
  return monoRasterFromString(b.logoReceipt) ?? undefined;
}

/** Range selection sent from the manager report screens. */
export type RangeArg = { preset?: RangePreset; from?: string; to?: string; limit?: number };
/** A521: what the manager is told when something is sent to a till that is off — it waits for it (no expiry). */
export const TILL_OFF_NOTE = 'The POS is not connected — this applies when it reconnects.';

// Wipes all catalogue data — called on login (before pulling fresh data)
// and on logout (so the next user never sees stale data on boot).
// Orders and sync_queue are intentionally kept so pending offline orders
// can still be pushed after re-login.
/** A580: a restaurant or café — or a type not known yet (shared/businessTerms.ts isFoodService) — has kitchen tickets, so its
 *  receipt keeps the "Kots" line; a shop, a petrol station, a car park or "other" does not. */
export function kitchenBusiness(type: string | null | undefined): boolean {
  const t = String(type ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return t === '' || t === 'restaurant' || t === 'cafe';
}

export function clearCatalogue(db: ReturnType<typeof getLocalDb>) {
  db.exec(`
    DELETE FROM products;
    DELETE FROM categories;
    DELETE FROM menus;
    DELETE FROM variant_groups;
    DELETE FROM variant_options;
    DELETE FROM modifier_groups;
    DELETE FROM modifier_options;
    DELETE FROM branches;
    DELETE FROM users;
    DELETE FROM tables;
  `);
}

// A519: the bills this run numbered while their person could sell, and those recalled from hold (sellGate.ts) — an
// open bill can still be held, sent and paid when its person's permissions change mid-shift.
export const openBills = createOpenBills();
// A519: the terminal codes the branch server said its tills use, from this run's join answer (terminalCodes.ts) — the
// fallback when the cloud cannot be asked.
export let joinCodesInUse: string[] | null = null;
export function noteJoinCodes(grant: { terminal_codes?: unknown }): void {
  if (Array.isArray(grant?.terminal_codes)) joinCodesInUse = grant.terminal_codes.map((c: unknown) => normaliseCode(c)).filter(Boolean);
}

/** The validating `handle` (installValidatedHandle, ipcGuard.ts) every module registers its channels through. */
export type IpcHandle = ReturnType<typeof installValidatedHandle>;

/** The helpers every module shares, built once per registerIpcHandlers() — their text is unchanged from before D10. */
export function createIpcShared(handle: IpcHandle) {

  // A490: does the person signed in on this till hold ANY of these fine keys (staff_session, cached at PIN sign-in so it
  // works offline)? No one signed in → no. The rule itself is tillAccess.ts — the till's ONE rule (the owner's role holds
  // everything; an older cloud's broad keys are expanded). Back-office actions only: selling never asks.
  const requireKey = (keys: string[], refusal: string): void => {
    if (!sessionPerson()) throw new Error('Not signed in');
    if (!signedInCan(...keys)) throw new Error(refusal);
  };
  const NOT_ALLOWED = 'Your role does not allow this.';

  // ── Staff PIN login (layered on the till session) ──────
  // verify-pin requires the owner bearer token (requireAuth) + a branch_id.
  // The till token lives in the session row; the renderer never sees it.

  /**
   * Calls the server with the OWNER access token, refreshing and retrying once
   * on a 401.
   *
   * Every caller used to read session.token straight out of SQLite and give up
   * if the server rejected it. Access tokens are short-lived, so the first
   * launch after a shop has been closed overnight always failed: the PIN screen
   * showed "Invalid or expired token" with an empty branch list, and staff had
   * to close the app and open it again. That worked purely by accident — the
   * failed launch had started the sync engine, which refreshed the token and
   * persisted it, so the SECOND launch read a valid one.
   *
   * Refreshing here makes the first launch work, which is the one that happens
   * in front of the customer at opening time.
   */
  // A446 (session audit): every call has a time limit — it had none, so a slow cloud (a cold start, a lossy line) or a
  // branch server that answered nothing left the PIN pad or the lock screen spinning for minutes. A timeout throws like
  // no connection, so the PIN check falls back to this till's own staff list.
  async function tillFetch(path: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<Response> {
    const db = getLocalDb();
    const readToken = () =>
      readSessionTokens().token || undefined;

    let token = readToken();
    if (!token) throw new Error('Not signed in');

    const call = (t: string) => cloudFetch(`${getCloudUrl()}${path}`, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
      headers: {
        ...(init.headers ?? {}),
        // Rate limiting keys on this: per-DEVICE buckets instead of the
        // branch's one shared NAT IP, so two tills never starve each other.
        'x-device-id': getDeviceConfig()?.device_id ?? '',
        Authorization: `Bearer ${t}`,
        'X-App-Version': app.getVersion(),
      },
    });

    let res = await call(token);
    if (res.status !== 401) return res;

    // Expired, not wrong. Refresh persists the new token to SQLite, so read it
    // back rather than assuming what it is.
    const refreshed = await refreshAccessToken();
    if (!refreshed) return res;          // let the caller surface the 401 body

    token = readToken();
    if (!token) return res;
    res = await call(token);
    return res;
  }

  // ── A334 (2026-09-26): drawers shared with the web POS ─────────────────────
  // Both are best-effort and bounded: a slow or absent cloud never blocks a sign-in
  // or a close — the till falls back to what it holds, and says so (foreign = null).
  const withinMs = <T,>(p: Promise<T>, ms: number) =>
    Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('slow')), ms))]);

  /** The cash on this drawer rung on another surface (the web POS). null = not known (offline / no answer). */
  async function fetchForeignCash(shiftId: string | null | undefined): Promise<ForeignCash | null> {
    if (!shiftId) return null;
    try {
      const res = await withinMs(tillFetch(`/api/shifts/${encodeURIComponent(shiftId)}/foreign-cash`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(localShiftIds(shiftId)),
      }), 4_000);
      if (!res.ok) return null;
      const f = await res.json();
      return f && typeof f.cash_sales === 'number' ? f as ForeignCash : null;
    } catch { return null; }
  }

  /** The staff's own cloud tokens and cached credential, from a verify-pin answer — shared by the online sign-in and the
   *  A345 upgrade of an offline sign-in. Returns the branch row (for the display name). */
  function persistCloudSignIn(data: any, branch_id: string): { name?: string | null } | undefined {
    const db = getLocalDb();
    // Online sign-in succeeded, so the server has just confirmed this PIN and
    // that it is unique across the business. Only now is it safe to cache.
    cacheStaffCredential(
      { staffId: data.staff?.id, name: data.staff?.name ?? 'Staff',
        roleName: data.staff?.role ?? null, permissions: data.permissions ?? {} },
      data.offlineAuth?.pinHash,
      branch_id,
    );

    // Resolve branch name for display (from the local branches table if present).
    const branchRow = db.prepare(`SELECT name FROM branches WHERE id=?`).get(branch_id) as any;

    db.prepare(`
      INSERT INTO staff_session
        (id, staff_id, staff_name, role_name, branch_id, branch_name, permissions, token, refresh_token, logged_in_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        staff_id=excluded.staff_id, staff_name=excluded.staff_name, role_name=excluded.role_name,
        branch_id=excluded.branch_id, branch_name=excluded.branch_name, permissions=excluded.permissions,
        token=excluded.token, refresh_token=excluded.refresh_token, logged_in_at=excluded.logged_in_at
    `).run(
      data.staff?.id ?? null,
      data.staff?.name ?? 'Staff',
      data.staff?.role ?? null,
      branch_id,
      branchRow?.name ?? null,
      JSON.stringify(data.permissions ?? {}),
      data.accessToken ?? data.token,
      data.refreshToken ?? null,
      new Date().toISOString(),
    );

    // D5 - wrap at rest, same as the till session.
    writeStaffTokens({ token: data.accessToken ?? data.token ?? '', refreshToken: data.refreshToken ?? '' });

    // Make the staff token the active credential for order pushes.
    configureStaffSession(data.accessToken ?? data.token, data.refreshToken ?? '');
    return branchRow;
  }

  /** POST /api/auth/verify-pin's body — the same on a sign-in and on the A345 background upgrade. */
  function verifyPinBody(pin: string, branch_id: string): string {
    return JSON.stringify({
      pin, branch_id,
      // The running build, reported on the one call every till makes every day.
      // Three tills are updated by hand and drift; without this a bug report
      // cannot be tied to a version, so a fixed bug and an un-updated till look
      // identical from the outside.
      app_version: app.getVersion(),
      device_id: getDeviceConfig()?.device_id ?? undefined,
      // A273 follow-up: sent on every sign-in so the cloud label follows the till's
      // setup name (the setup name always wins — owner, 2026-09-26).
      terminal_code: getDeviceConfig()?.terminal_code ?? undefined,
      device_name:   getDeviceConfig()?.device_name ?? undefined,
    });
  }

  function queueThermal(
    payload: any,
    kinds: Array<'kitchen' | 'dispatch' | 'receipt'>,
    reprint?: { at: Date; count: number },
    // 0.5.27 — returns the stations that produced NOTHING. printSale has always
    // computed this and every caller threw it away, so a station with no printer
    // bound on this terminal was skipped in silence. That is register D8, and
    // with the HTML fallback gone there is no second system to catch it: the
    // cashier must be told, or a bag leaves with items missing.
  ): { skipped: string[]; failed: string[] } {
    try {
      if (!escposEnabled()) return { skipped: [], failed: [] };

      const db = getLocalDb();
      const cfg = getDeviceConfig();
      const stations = db.prepare(
        `SELECT id, name, kind FROM print_stations WHERE active = 1 ORDER BY sort_order, name`
      ).all() as Array<{ id: string; name: string; kind: 'kitchen' | 'dispatch' | 'receipt' }>;

      // A business with no stations configured is not an error — it is one that
      // has not set them up. Falling back to the three built-ins keeps a
      // freshly-upgraded till printing.
      const effective = stations.length ? [...stations] : [
        { id: 'kitchen',  name: 'Kitchen',  kind: 'kitchen'  as const },
        { id: 'dispatch', name: 'Dispatch', kind: 'dispatch' as const },
        { id: 'receipt',  name: 'POS',     kind: 'receipt'  as const },
      ];

      // The receipt station is added when the business has not defined one.
      // Kitchen and dispatch are genuinely optional — a retail shop has neither
      // — but somewhere to print the bill is not.
      if (!effective.some(st => st.kind === 'receipt')) {
        effective.push({ id: 'receipt', name: 'POS receipt', kind: 'receipt' as const });
      }

      // Which stations have a printer bound on THIS terminal. Drives the Kots
      // count, so it reflects paper that will exist rather than stations that
      // merely exist.
      const assignedIds = new Set(assignments().map(a => a.stationId));

      const staff = db.prepare(
        `SELECT staff_name, branch_name FROM staff_session WHERE id = 1`
      ).get() as { staff_name?: string; branch_name?: string } | undefined;

      // business_name and currency live on `session`, branch_name on
      // `staff_session`. NOT on device_config — that holds the machine's own
      // settings, not the tenant's identity. Getting this wrong prints a receipt
      // with a blank shop name at the top.
      const sess = db.prepare(
        `SELECT business_name, currency FROM session WHERE id = 1`
      ).get() as { business_name?: string; currency?: string } | undefined;

      const saleResult = printSale(
        {
          billNumber:     String(payload.order_number ?? ''),
          orderType:      String(payload.order_type ?? 'retail'),
          // A444: a reprint rebuilt from the order names who sold it; a live sale (and a stored payload) the person signed in.
          cashierName:    String(payload.cashier_name ?? staff?.staff_name ?? ''),
          soldAt:         new Date(),
          tableNumber:    payload.table_number ?? undefined,
          deliveryPerson: payload.delivery_person ?? undefined,
          note:           payload.notes ?? null,   // A367: the order's note, on the kitchen ticket and the receipt
          cart:           payload.items ?? [],
          payments:       payload.payments ?? [],
          // A552: a sale on account — the customer and what they owe after it (prepareCreditSale set it).
          account:        payload.on_account && typeof payload.on_account === 'object'
            ? { customer: String(payload.on_account.customer ?? ''), balanceOwed: Number(payload.on_account.balance_owed) }
            : undefined,
          changeGiven:    Number(payload.change_given ?? 0),
          total:          Number(payload.total ?? 0),
          // A349: the BILL is after the discount and excludes the tip; the receipt needs both to reconcile and print.
          discount:       Number(payload.discount_amount ?? 0),
          // A445: the offers on the sale, by name (part of the discount above).
          offers:         Array.isArray(payload.offers) ? payload.offers : undefined,
          tip:            Number(payload.tip_amount ?? 0),
          deliveryFee:    Number(payload.delivery_fee ?? 0),   // 0.6.27: after the total with the tip; PAY includes it
          deliveryFree:   payload.delivery_free === true,       // 0.6.33: "Delivery: FREE" — the fee is not the customer's
          // "How many kitchen tickets did this order produce" — the number the
          // expeditor counts against what arrives at the pass. Counted from
          // stations that will ACTUALLY print here; a station with no printer
          // on this terminal produces no ticket. Receipts are not KOTs.
          // 0.6.28: a kitchen void reprints the taken-back items under a VOID banner (kitchen and dispatch only).
          voided:         payload.kitchen_void
            ? { at: new Date(), by: String(payload.kitchen_void.by ?? ''), reason: String(payload.kitchen_void.reason ?? '') }
            : undefined,
          kotCount:       effective.filter(
            st => st.kind !== 'receipt' && assignedIds.has(st.id)).length,
          reprint,
        },
        {
          name:            sess?.business_name ?? '',
          branchName:      staff?.branch_name ?? undefined,
          header:          (cfg as any)?.receipt_header || undefined,
          currencyCode:    sess?.currency ?? 'KES',
          // Cached from /api/pos/init on every catalogue pull, so an offline
          // till still prints the business's real rates rather than a hardcoded
          // 16 — which printed the wrong tax for anyone on a different rate.
          vatRate:         Number((cfg as any)?.vat_rate ?? 16),
          ctlRate:         Number((cfg as any)?.ctl_rate ?? 0),
          // A544: the owner's footer box — this branch's own footer when it has one (and the business has themes); the
          // closing block, TAX RECEIPT and the credit below are printed by shared/printing whatever the box says.
          thankYouMessage: effectiveReceiptFooter((cfg as any)?.receipt_footer) || undefined,
          // A450: "Buy Goods: 123456" under the payments — set on the web; none when no number is set.
          tillLabel:       getReceiptPay()?.label,
          tillNumber:      getReceiptPay()?.number,
          footerCredit:    'Powered by ZapTill',
          // A312: the client logo on customer receipts — ONLY when the client's toggle is on
          // and a raster exists. Decoded by shared/printing; a malformed stored value decodes
          // to null and prints no logo. The renderer prints it on receipts only (A310).
          logoRaster:      resolveReceiptLogo(),
          // A530: the admin portal's receipt switches for this client (pos/init, cached) — all off = the standard
          // (A538: the classic layout at ~3.75 mm, small logo, 1-line feed; receipt_compact_layout opts in to compact).
          receiptClassic:  receiptClassicFrom(getPosFeatures()),
          // A551 (owner, 2026-10-21: "kitchen receipt use the same font as the despatcher"): kitchen tickets in Font A
          // unless the admin portal's 'kitchen_font_b' is on for this client (A543's Font B). Dispatch and receipts: Font A.
          kitchenFontB:    kitchenFontBFrom(getPosFeatures()),
          // A580 (owner, 2026-10-23): a shop has no kitchen — no "Kots: 0" on its receipt. A restaurant or café (or a
          // type not known yet) prints the Kots line as before.
          kitchenTickets:  kitchenBusiness(cfg?.business_type),
        },
        // The presets shared/printing exports, NOT a hand-rolled config here.
        // They are what the verified sample output was rendered from, so a
        // ticket printed on the counter is laid out identically to the one in
        // SAMPLE-OUTPUT.
        //
        // Paper width comes from the terminal's assignment (what is physically
        // loaded), applied inside queueTickets — an 80mm layout on a 58mm roll
        // wraps its whole right-hand column.
        effective.map(s =>
          s.kind === 'kitchen'  ? kitchenPreset(s.id, s.name)
        : s.kind === 'dispatch' ? dispatchPreset(s.id, s.name)
        :                         receiptPreset(s.id, s.name)),
        kinds,
      );

      return { skipped: saleResult?.skipped ?? [], failed: saleResult?.failed ?? [] };
    } catch (e) {
      console.error('[escpos] queueing tickets failed (non-blocking):', e);
      // NEVER THROWS — it runs after the money is taken. A349: the failure is also returned so the cashier is told.
      return { skipped: [], failed: ['all tickets'] };
    }
  }

  /**
   * Set this terminal's local override. Available on any till — a cloud till may
   * still override the business default for its own printer, and the override
   * survives every catalogue pull. See escposBridge.setKitchenExclusions.
   */
  // A490: what the kitchen leaves off is the print set-up's — stations.manage (it was open to anyone at the till).
  const STATIONS_REFUSED = 'Only someone who sets up printers and print stations can change that.';

  // A444: an order's detail — this till's records, else the cloud (GET /api/orders/:id, the branch's other tills).
  async function readOrderDetail(orderId: string): Promise<{ detail: OrderDetail; cashierId: string | null }> {
    const local = localOrderDetail(orderId);
    if (local) {
      const row = getLocalDb().prepare(`SELECT cashier_id FROM orders WHERE id = ?`).get(orderId) as { cashier_id?: string } | undefined;
      return { detail: local, cashierId: row?.cashier_id ?? null };
    }
    const cfg = getDeviceConfig();
    const token = readStaffTokens().token ?? readSessionTokens().token;
    if (!token) throw new Error('This order is not on this POS, and the POS is not signed in to the cloud.');
    let res: Response;
    try {
      res = await Promise.race([
        cloudFetch(`${getCloudUrl()}/api/orders/${encodeURIComponent(orderId)}`, {
          headers: { Authorization: `Bearer ${token}`, 'x-device-id': cfg?.device_id ?? '' },
        }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('The cloud took too long to answer.')), 8_000)),
      ]);
    } catch (e: any) {
      throw new Error(/took too long/.test(e?.message ?? '') ? e.message : 'This order is not on this POS and the cloud cannot be reached.');
    }
    if (res.status === 404) throw new Error('Order not found.');
    if (!res.ok) throw new Error(`The cloud did not answer (HTTP ${res.status}).`);
    const body = await res.json() as any;
    return { detail: detailFromCloud(body), cashierId: body?.cashier_id ?? null };
  }

  // A334 follow-up (owner, 2026-09-27: "can it be instant"): a shift change reaches the cloud NOW, the way a sale
  // already does (order:create), not on the next timer tick — so the web POS sees a till's drawer open / close within
  // seconds. Fire-and-forget: the push self-guards on offline / in-flight, and the 30 s timer is the backstop.
  const pushNow = () => { syncPush().catch(() => { /* the timer retries */ }); };

  // ── A365: a manager confirms a closed shift (blind recount of every payment method) ──────────────────────────
  // Who may confirm: A490 — shifts.confirm (tillAccess; the owner's role always; an older map's orders.void / shifts.manage /
  // settings.manage expand to it) — the cloud's mayConfirm. The PIN goes to an AUTHORITY first (the branch node, then the cloud); only when none can be
  // reached does the till's own saved sign-in answer. A "no" from an authority is final (same chain as sign-in, A17).
  const mayConfirmLocal = (staff: PersonLike) => personCan(staff, 'shifts.confirm');
  const NOT_A_CONFIRMER = 'That PIN was not recognised. Enter the PIN of a manager (or the owner) on duty.';
  // 0.6.37 (A388): a cash-out or an expense with no manager signed in and no PIN.
  const PAYOUT_APPROVAL_NEEDED = 'A manager must approve this — enter a manager’s PIN.';
  // A494: every manager-PIN prompt (shift confirmation, cash out, expenses, kitchen voids) asks the till's PIN limiter
  // first, and a PIN that does not approve counts toward its lockout — whoever said no (the server, the cloud, the till).
  async function identifyConfirmer(pin: string): Promise<{ id: string; name: string | null }> {
    assertPinAllowed();
    try { return await identifyConfirmerChecked(pin); }
    catch (e: any) { if (e?.message === NOT_A_CONFIRMER) recordPinFailure(); throw e; }
  }
  async function identifyConfirmerChecked(pin: string): Promise<{ id: string; name: string | null }> {
    const cfg = getDeviceConfig();
    const branchId = cfg?.branch_id ?? '';
    const local = (staff: { staffId: string; name: string; roleName: string | null; permissions: unknown }) => {
      if (!mayConfirmLocal(staff)) throw new Error(NOT_A_CONFIRMER);
      return { id: staff.staffId, name: staff.name };
    };
    if (cfg?.node_url && !isNodeRole(cfg?.device_role)) {
      const r = await verifyPinAtNodeClient(pin, branchId);
      if (r.status === 'ok') return local(r.staff);
      if (r.status === 'rejected') throw new Error(NOT_A_CONFIRMER);
    }
    let res: Response | null = null;
    try {
      res = await tillFetch('/api/shifts/confirmer', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }),
      });
    } catch { res = null; }
    if (res && !isUnreachableStatus(res.status)) {
      if (res.ok) { const b = await res.json() as { id: string; name: string | null }; return { id: b.id, name: b.name ?? null }; }
      if (res.status === 403) throw new Error(NOT_A_CONFIRMER);
      const b = await res.json().catch(() => ({} as any));
      throw new Error(b?.error ?? `Could not check the PIN (HTTP ${res.status}).`);
    }
    // No authority could be reached: the node's own roster, or this till's saved sign-ins.
    if (isNodeRole(cfg?.device_role)) {
      const n = verifyPinAtNode(pin, branchId);
      if (n.ok) return local(n.staff);
      // A415: no roster yet → this till's saved sign-ins, as on any till.
      if (n.reason !== 'no_roster' && n.reason !== 'unavailable') throw new Error(n.reason === 'no_match' ? NOT_A_CONFIRMER : n.message);
    }
    const v = verifyPinOffline(pin, branchId);
    if (!v.ok) throw new Error(v.reason === 'no_match' ? NOT_A_CONFIRMER : v.message);
    return local(v.staff);
  }   // 0.6.27: blind

  // 0.6.23 (owner: "since its the manager who is logged in do they need to key in their password?"): a manager already
  // signed in on this till confirms as themselves — no PIN. Anyone else still needs a manager's PIN.
  const signedInConfirmer = (): { id: string; name: string | null } | null => {
    const st = getLocalDb().prepare(`SELECT staff_id, staff_name, role_name, permissions FROM staff_session WHERE id=1`).get() as
      { staff_id: string; staff_name: string; role_name: string | null; permissions: string | null } | undefined;
    if (!st?.staff_id) return null;
    let permissions: unknown = {};
    try { permissions = JSON.parse(st.permissions || '{}'); } catch { /* none */ }
    return mayConfirmLocal({ roleName: st.role_name, permissions }) ? { id: st.staff_id, name: st.staff_name } : null;
  };

  // 0.6.37 (A388) — owner, 2026-10-03: "Manager approve cashout and expense" — "Manager PIN on the spot". A manager
  // signed in on this till approves as themselves; anyone else enters a manager's PIN, checked like a shift
  // confirmation (the branch node, the cloud, else this till's saved sign-ins — so it works offline). The approver is
  // stored on the row, pushed, and printed on the Z-report.
  async function payoutApprover(pin?: string): Promise<{ id: string; name: string | null }> {
    const p = String(pin ?? '').trim();
    if (p) return identifyConfirmer(p);
    const me = signedInConfirmer();
    if (me) return me;
    throw new Error(PAYOUT_APPROVAL_NEEDED);
  }

  // A490: the branch's shifts and their reports — reports.shifts, or someone who confirms drawers.
  const SHIFTS_REFUSED = 'Your role does not see shift reports.';
  // A545: credit:list / credit:decide fall back to the saved list only for an offline reason. Here, not in credit.ts:
  // it reads lastManageFailure, which must stay the one live variable (handing out a `let` hands out a snapshot).
  const creditOffline = (): boolean => lastManageFailure === 'no_connection' || offlineSessionNow();

  // ── A345: offline sign-ins ─────────────────────────────────────────────────
  // Why the last cloud-owned list could not be read: an offline sign-in, or no connection. null = the last call reached the
  // cloud. Only these two reasons let the Menu / Staff pages fall back to what this till has saved — a refusal (403) or any
  // other answer never does.
  let lastManageFailure: ManageOfflineReason | null = null;

  /** One attempt to turn an offline sign-in into a cloud sign-in (offlineSession.ts). Never throws; bounded to 8 s. */
  async function tryUpgradeOfflineSession() {
    if (!heldOfflinePin()) return 'nothing' as const;
    const outcome = await upgradeOfflineSession({
      currentSession: () => {
        const r = getLocalDb().prepare(`SELECT staff_id FROM staff_session WHERE id=1`).get() as { staff_id: string } | undefined;
        return r ? { staffId: r.staff_id, hasToken: !!readStaffTokens().token } : null;
      },
      verifyAtCloud: async (pin, branchId) => {
        const res = await withinMs(tillFetch('/api/auth/verify-pin', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: verifyPinBody(pin, branchId),
        }), 8_000);
        return { status: res.status, body: await res.json().catch(() => ({})) };
      },
      adopt: (data, branchId) => { persistCloudSignIn(data, branchId); },
      isUnreachableStatus,
      log: (line) => logLine('pin', line),
    }).catch(() => 'unreachable' as const);
    if (outcome === 'upgraded') {
      lastManageFailure = null;
      pullWebSales().catch(() => { /* the 20-s poll retries */ });
    }
    return outcome;
  }
  // The network coming back is not an event the till is told about, so look every 30 s while an offline sign-in is held.
  // Nothing is sent while none is (heldOfflinePin() is checked first). unref: never keeps the app (or a test) alive.
  const offlineUpgradeTimer = setInterval(() => { if (heldOfflinePin()) void tryUpgradeOfflineSession(); }, 30_000);
  (offlineUpgradeTimer as any).unref?.();

  /** Signed in, but offline (no cloud token for the person at the till). */
  function offlineSessionNow(): boolean {
    return !!getLocalDb().prepare(`SELECT 1 FROM staff_session WHERE id=1`).get() && !readStaffTokens().token;
  }

  /** Is the back office's cloud-owned data unreachable for an OFFLINE reason? (The only case the saved lists are shown.) */
  function manageOfflineReason(): { reason: ManageOfflineReason; message: string } | null {
    if (offlineSessionNow()) return { reason: 'offline_session', message: OFFLINE_SESSION_MESSAGE };
    if (lastManageFailure === 'no_connection') return { reason: 'no_connection', message: NO_CONNECTION_MESSAGE };
    return null;
  }

  /**
   * The manager-screen fetch: Menu, Staff, Prices, Combos, Receipt, Printers.
   * 35 handlers route through it.
   *
   * ── WHY THE 401 BRANCH EXISTS ──────────────────────────────────────────────
   * The staff ACCESS token lives 15 minutes; its refresh token lives 30 days.
   * This function used to read the access token once and throw on any non-2xx,
   * so the first manager action after fifteen idle minutes produced a 401,
   * humaniseError matched /unauthor/i, and the screen said
   *
   *     "This till was signed out. Ask a manager to sign in again."
   *
   * The till was NOT signed out. The sync engine was refreshing on its own
   * schedule the whole time and selling was unaffected — only the manager
   * screens were, and only because this one function never refreshed. Reported
   * from the field on 0.5.27 (Beryl), on the Menu screen, after idling.
   *
   * tillFetch has had exactly this branch since it was written. The two
   * builders disagreed about token expiry and nothing compared them — the same
   * seam as A38's two header spellings.
   *
   * refreshStaffToken() is single-flight, so overlapping manager actions await
   * one request rather than presenting the same rotating token twice. That
   * matters: a doubled refresh is what the server's replay detection treats as
   * a stolen token, and it revokes EVERY session for that user.
   *
   * ONE retry, and only on 401. A second 401 after a successful refresh is a
   * real rejection (revoked, deactivated, permissions changed) and must reach
   * the user rather than looping.
   */
  async function manageFetch(path: string, method: string, body?: any, opts?: { binary?: boolean }) {
    const db = getLocalDb();
    const readToken = () => readStaffTokens().token;

    let token = readToken();
    if (!token) {
      // A345: an OFFLINE sign-in has no cloud token. Try to make it a cloud sign-in now (the network may be back), and if it
      // cannot be, say so — it is NOT "not signed in" (owner's screenshots, v0.6.14 checklist).
      const signedIn = !!db.prepare(`SELECT 1 FROM staff_session WHERE id=1`).get();
      if (!signedIn) throw new Error('Not signed in');
      await tryUpgradeOfflineSession();
      token = readToken();
      if (!token) { lastManageFailure = 'offline_session'; throw new Error(OFFLINE_SESSION_MESSAGE); }
    }

    const call = (t: string) => cloudFetch(`${getCloudUrl()}${path}`, {
      signal: AbortSignal.timeout(20_000),   // A446: a time limit — a manager's change never hangs
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    let res: Response;
    try {
      res = await call(token);

      if (res.status === 401) {
        // Expired, not wrong. refreshStaffToken persists the new pair to
        // SQLite, so read it back rather than assuming what it is — the
        // in-memory copy can lag the disk.
        const refreshed = await refreshStaffToken();
        if (refreshed) {
          const fresh = readToken();
          if (fresh) res = await call(fresh);
        }
      }
    } catch (e: any) {
      // A529: including another server's page (no X-ZapTill-Server) — the no-connection message, not its status.
      if (e instanceof ForeignPageError) logLine('manage', `${method} ${path}: HTTP ${e.status} was not the cloud's page - no connection`);
      lastManageFailure = 'no_connection';
      throw new Error(NO_CONNECTION_MESSAGE);
    }
    lastManageFailure = null;

    // A466: a file from the cloud (the monthly pack's Excel) — its bytes and the name the cloud gave it.
    if (opts?.binary && res.ok) {
      return { bytes: Buffer.from(await res.arrayBuffer()), disposition: res.headers.get('content-disposition') };
    }

    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }

    if (!res.ok) {
      // A197: the cloud's code travels with the message (a screen offers the right next step — e.g. same_user_receipt).
      const err: Error & { code?: string | null; status?: number } = new Error(res.status === 403 && !data?.code
        ? 'Your role does not allow this change.' : (data?.error ?? `Request failed (${res.status})`));
      err.code = data?.code ?? null; err.status = res.status;
      throw err;
    }
    return data;
  }

  // A catalogue write is pointless until the till re-reads it, so pull straight
  // after. Failure here is non-fatal — the edit landed on the server and the
  // next scheduled sync will collect it.
  async function refreshCatalogue() {
    try { await syncAll(); } catch (e: any) { console.warn('[manage] post-edit sync failed:', e?.message); }
  }
  /** A list from the cloud (or this till), with this till's changes that still wait laid over it — so the screen shows
   *  what the till sells: a change made here, a new item made here, each marked (waiting / with the owner / refused). */
  function overlayOnList(entity: 'product' | 'category' | 'staff', rows: any[]): any[] {
    const list = Array.isArray(rows) ? rows.map((r) => ({ ...r })) : [];
    const open = getLocalDb().prepare(`SELECT entity_id, op, data, state, message FROM local_changes WHERE entity = ? AND state IN ('pending', 'awaiting') ORDER BY made_at`)
      .all(entity) as Array<{ entity_id: string; op: string; data: string; state: string; message: string | null }>;
    for (const c of open) {
      const data = JSON.parse(c.data);
      delete data.pin; delete data.pin_hash_enc; delete data.permissions;
      const i = list.findIndex((r) => r.id === c.entity_id);
      if (c.op === 'delete') { if (i >= 0) { if (entity === 'product') list[i].status = 'inactive'; else list.splice(i, 1); } continue; }
      if (i >= 0) Object.assign(list[i], data, { change_state: c.state, change_message: c.message });
      else list.push({ id: c.entity_id, status: 'active', ...data, change_state: c.state, change_message: c.message });
    }
    return list;
  }

  // A448: the menu is saved on this till first (it sells the new way at once, offline too) and reaches the cloud after
  // (changeQueue.ts). What the till cannot hold yet — a picture, sizes, extras, fuel, sold by the piece — still goes to
  // the cloud first, as before.
  // A490: the menu's screens — reading it is products.view (or any menu key); cost prices only to menu.costs / reports.costs
  // (taken out, not merely hidden). Each write asks its own key (changeQueue changeKeys) — here first, so a cashier gets
  // a clear refusal without a cloud round trip, and on the till-first path inside recordTillChange.
  const MENU_READ = ['products.view', 'menu.edit', 'menu.prices', 'menu.offers', 'menu.costs'];
  const MENU_REFUSED = 'Your role does not allow this menu change.';
  const COST_FIELDS = ['cost_price', 'cost', 'unit_cost', 'margin', 'margin_pct', 'food_cost', 'food_cost_pct'];
  const withoutCosts = (rows: any): any => {
    if (signedInCan('menu.costs', 'reports.costs') || !Array.isArray(rows)) return rows;
    return rows.map((r) => { if (!r || typeof r !== 'object') return r; const o = { ...r }; for (const k of COST_FIELDS) delete o[k]; return o; });
  };
  // A494: a cost price set on a new product is menu.costs (tillChanges.changeKeys asks it of an update only).
  const hasCost = (p: any) => !!p && typeof p === 'object' && p.cost_price !== undefined && p.cost_price !== null && p.cost_price !== '';
  // A490: the business's own payment methods — settings.payments.
  const PAYMENTS_REFUSED = 'Only someone who manages payment methods can change them.';

  // A490: the staff list is staff.view; adding and changing staff staff.edit — never with more rights than the person
  // making the change holds (the A340 ceiling, by permission: keysBeyond), never the owner's role.
  const STAFF_REFUSED = 'Your role does not add or change staff.';
  const savedRoles = (): any[] => { try { const v = JSON.parse((getLocalDb().prepare(`SELECT value FROM maintenance_state WHERE key = 'roles_cache'`).get() as any)?.value ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
  /** The person this till holds under that id (its staff list, else its saved sign-ins), for "never someone more powerful". */
  const heldPerson = (id: string): PersonLike | null => {
    const db = getLocalDb();
    const r = (db.prepare(`SELECT role_name, permissions FROM branch_staff WHERE staff_id = ?`).get(id)
      ?? db.prepare(`SELECT role_name, permissions FROM staff_pin_cache WHERE staff_id = ?`).get(id)) as { role_name?: string | null; permissions?: string | null } | undefined;
    return r ? { roleName: r.role_name ?? null, permissions: r.permissions ?? '{}' } : null;
  };
  const requireStaffChange = (opts: { roleId?: unknown; targetId?: string | null }) => {
    const me = sessionPerson();
    if (!me || !personCan(me, 'staff.edit')) throw new Error(STAFF_REFUSED);
    if (opts.roleId !== undefined && opts.roleId !== null && opts.roleId !== '') {
      const role = savedRoles().find((r) => r?.id === opts.roleId);
      if (role) { const why = roleCeilingRefusal(me, role); if (why) throw new Error(why); }
      // A role this till has not saved: the cloud decides (it checks the same ceiling).
    }
    if (opts.targetId && !mayActOn(me, heldPerson(String(opts.targetId)))) throw new Error('That person holds more rights than you — only the owner (or someone who holds as much) can change them.');
  };
  // A197: the branch a transfer is from — the signed-in person's, else this till's.
  const transferBranch = (): string | null => {
    const st = getLocalDb().prepare(`SELECT branch_id FROM staff_session WHERE id=1`).get() as { branch_id?: string } | undefined;
    return st?.branch_id || getDeviceConfig()?.branch_id || null;
  };

  // A460: premium writes (combos, variants, modifiers, offers, wastage) refuse without the online licence — the screens
  // are hidden then, and a screen hidden is not a door locked.
  const requireOnlineLicence = (): void => {
    if (getDeviceConfig()?.web_pos_enabled !== true) throw new Error('This is part of the online licence — ask ZapTill to turn it on for your business.');
  };

  // A490: every report read names its key (the Overview reads several — reports.overview opens those too). A refusal
  // throws: the screen shows its own "not available" line, and the figures are never sent.
  const REPORT_REFUSED = 'Your role does not see this report.';

  // What the modules use. Not returned: lastManageFailure (a `let` — a module would get a snapshot; creditOffline and
  // manageOfflineReason read it here), the offline-upgrade timer, and the helpers only the ones above call.
  return {
    handle,
    requireKey, NOT_ALLOWED, tillFetch, withinMs, fetchForeignCash, persistCloudSignIn, verifyPinBody, queueThermal,
    STATIONS_REFUSED, readOrderDetail, pushNow, identifyConfirmer, signedInConfirmer, payoutApprover, SHIFTS_REFUSED,
    creditOffline, tryUpgradeOfflineSession, offlineSessionNow, manageOfflineReason, manageFetch, refreshCatalogue,
    overlayOnList, MENU_READ, MENU_REFUSED, withoutCosts, hasCost, PAYMENTS_REFUSED, savedRoles, requireStaffChange,
    transferBranch, requireOnlineLicence, REPORT_REFUSED,
  };
}

/** What every ipc/*.ts register function is handed: `handle` and the helpers above, one instance per registerIpcHandlers(). */
export type IpcShared = ReturnType<typeof createIpcShared>;
