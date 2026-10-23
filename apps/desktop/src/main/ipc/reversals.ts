// IPC: voids and refunds (0.6.30: also while the cloud cannot be reached), frozen sales, reversal rules, help.
// Registered from ipcHandlers.ts (D10).
import { app } from 'electron';
import { isNodeRole } from '../deviceConfig';
import { assertPayload } from '../ipcValidate';
import { getLocalDb } from '../localDb';
import { logLine } from '../logFile';
import { readSessionTokens, readStaffTokens } from '../tokenStore';
import { cloudFetch } from '../cloudGateway';
import { verifyPinOffline } from '../pinCache';
import { assertPinAllowed, recordPinFailure } from '../pinAttempts';
import { signedIn as sessionPerson, personCan, isOwnerRole, type PersonLike } from '../tillAccess';
import { getDeviceConfig, getReversalRules, getSupportContact, getStockCountFreeze } from '../deviceConfig';
import { reverseOffline, mayReverseLocal, type LocalPerson } from '../offlineReversal';
import { mirrorTillRefund, reverseRiderPayout } from '../webSales';
import { emitEvent } from '../nodeIngest';
import { verifyPinAtNodeClient } from '../nodeClient';
import { ForeignPageError } from '../authTransport';
import { verifyPinAtNode } from '../branchStaff';
import { type IpcShared } from './shared';

/** Voids and refunds (online, or while the cloud cannot be reached), frozen sales, reversal rules, help. */
export function registerReversalHandlers(ctx: IpcShared) {
  const { handle, requireKey, pushNow, tryUpgradeOfflineSession, offlineSessionNow } = ctx;

  // ── 0.6.30 (A336 stage 3): void / refund while the cloud cannot be reached ─────────────────────────────────────
  // The online path below is tried first; only "could not reach the cloud" (no network, a gateway error, an offline
  // sign-in that cannot become a cloud one) falls through to here. The approver's PIN goes to the branch node first,
  // else this till's saved sign-ins (the A365 chain); the owner's rules decide the rest (offlineReversal.ts).
  const signedInPerson = (): LocalPerson | null => {
    const st = sessionPerson();
    return st ? { id: st.staffId, name: st.name, roleName: st.roleName, permissions: st.permissions } : null;
  };
  const NOT_AN_APPROVER = 'That PIN was not recognised. Enter the PIN of a manager (or the owner) on duty.';
  async function identifyApproverOffline(pin: string, kind: 'void' | 'refund' | 'frozen'): Promise<LocalPerson> {
    assertPinAllowed();   // A494: the till's PIN limiter, and a PIN that does not approve counts
    try { return await identifyApproverOfflineChecked(pin, kind); }
    catch (e: any) { if (e?.message === NOT_AN_APPROVER) recordPinFailure(); throw e; }
  }
  async function identifyApproverOfflineChecked(pin: string, kind: 'void' | 'refund' | 'frozen'): Promise<LocalPerson> {
    const cfg = getDeviceConfig();
    const branchId = cfg?.branch_id ?? '';
    const asPerson = (staff: { staffId: string; name: string; roleName: string | null; permissions: unknown }): LocalPerson => {
      const p = { id: staff.staffId, name: staff.name ?? null, roleName: staff.roleName, permissions: staff.permissions };
      if (!(kind === 'frozen' ? mayReleaseFrozen(p) : mayReverseLocal(p, kind))) throw new Error(NOT_AN_APPROVER);   // A490: sales.void / sales.refund, or the owner
      return p;
    };
    if (cfg?.node_url && !isNodeRole(cfg?.device_role)) {
      const r = await verifyPinAtNodeClient(pin, branchId);
      if (r.status === 'ok') return asPerson(r.staff);
      if (r.status === 'rejected') throw new Error(NOT_AN_APPROVER);
    }
    if (isNodeRole(cfg?.device_role)) {
      const v = verifyPinAtNode(pin, branchId);
      if (!v.ok) throw new Error(v.reason === 'no_match' ? NOT_AN_APPROVER : v.message);
      return asPerson(v.staff);
    }
    const v = verifyPinOffline(pin, branchId);
    if (!v.ok) throw new Error(v.reason === 'no_match' ? NOT_AN_APPROVER : v.message);
    return asPerson(v.staff);
  }
  async function reverseWhileOffline(kind: 'void' | 'refund', orderId: string, reason: string, pin: string | undefined) {
    const actor = signedInPerson();
    const approver = String(pin ?? '').trim()
      ? await identifyApproverOffline(String(pin).trim(), kind)
      : (mayReverseLocal(actor, kind) ? actor : null);
    if (!approver) throw new Error('Enter the PIN of a manager (or the owner) on duty.');
    const r = reverseOffline({
      kind, orderId: String(orderId), reason: String(reason ?? ''), actor, approver,
      rules: getReversalRules(), deviceId: getDeviceConfig()?.device_id ?? null,
    });
    if (kind === 'void') emitEvent('order_voided', String(orderId), { status: 'voided', voided_at: r.at });
    logLine('sale', `offline ${kind} ${orderId}${kind === 'refund' ? ` ${r.refunded}` : ''} approved by ${approver.name ?? approver.id}`
      + ` — ${String(reason ?? '').slice(0, 120)}`);
    pushNow();
    return { ok: true, offline: true, refunded: r.refunded, approvedBy: approver.name ?? null };
  }
  /** A gateway answer is "the cloud is not there", not the cloud's answer (a 500 may have half-applied — not retried). */
  const cloudUnreachable = (status: number) => status === 502 || status === 503 || status === 504;
  const REVERSE_TIMEOUT_MS = 15_000;

  // A521 (#7): a manager may sell an item a stock count freezes — the till's offline list can be hours behind the count
  // (and the cloud accepts a till's sale of a frozen item, counting it into the count: orders.ts A394). Who: the owner, or
  // a person who adjusts stock or confirms shifts (a manager). Checked on this till (its server, its saved sign-ins).
  function mayReleaseFrozen(p: PersonLike | null | undefined): boolean {
    return !!p && (isOwnerRole(p.roleName ?? null) || personCan(p, 'inventory.adjust', 'shifts.confirm'));
  }
  handle('pos:approveFrozenSale', async (_e, payload) => {
    const { pin, product_id } = assertPayload<{ pin: string; product_id: string }>({ pin: { t: 'string', min: 1 }, product_id: { t: 'string', min: 1 } }, payload);
    if (!getStockCountFreeze().productIds.includes(product_id)) return { ok: true, approvedBy: null };   // not frozen (any more)
    try {
      const me = signedInPerson();
      const approver = await identifyApproverOffline(String(pin).trim(), 'frozen');
      logLine('sale', `A521 frozen item ${product_id} (count ${getStockCountFreeze().ref ?? '?'}) released for sale by ${approver.name ?? approver.id}${me?.name ? ` for ${me.name}` : ''}`);
      return { ok: true, approvedBy: approver.name ?? null };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? NOT_AN_APPROVER };
    }
  });

  // ── 0.6.30: the owner's rules, for History's labels and the void/refund window ──
  handle('pos:reversalRules', async () => getReversalRules());

  // ── 0.6.35 (A384): the Help screen — who to call (the shop's tech, or SwiftPOS support) and which till this is ──
  // Offline, before anyone signs in (the PIN pad has Help: a locked-out cashier needs it most).
  handle('pos:help', async () => {
    const cfg = getDeviceConfig();
    return {
      contact: getSupportContact(),
      till: cfg?.terminal_code || cfg?.device_name || null,
      version: app.getVersion(),
    };
  });

  // ── Order void (manager/supervisor only — server enforces permission) ──────
  handle('order:void', async (_event, payload) => {
    // D7: the void identifier and reason must be present and well-typed before we
    // build a request from them; the approval PINs are optional.
    const { orderId, reason, supervisor_pin, override_pin, authorizer_id } =
      assertPayload<{ orderId: string; reason: string; supervisor_pin?: string; override_pin?: string; authorizer_id?: string }>(
        {
          orderId:        { t: 'string', min: 1 },
          reason:         { t: 'string' },
          supervisor_pin: { t: 'string', optional: true },
          override_pin:   { t: 'string', optional: true },
          authorizer_id:  { t: 'string', optional: true },
        }, payload);
    const db = getLocalDb();
    // A490: sales.void — checked here first (the cloud checks again online; offline this till is the authority).
    requireKey(['sales.void'], 'Your role does not void sales.');
    // Get server URL + best available auth token
    const cfg = getDeviceConfig();
    if (!cfg?.server_url) throw new Error('Device not configured');
    // A345: an offline sign-in has no cloud token yet — make it a cloud sign-in first if the network is back.
    if (!readStaffTokens().token) await tryUpgradeOfflineSession();
    const staffRow = { token: readStaffTokens().token };
    const ownerRow = { token: readSessionTokens().token };
    const token = staffRow?.token ?? ownerRow?.token;
    const approvalPin = override_pin ?? supervisor_pin;
    // 0.6.30: an offline sign-in that cannot become a cloud one yet — void here, by the owner's offline rules.
    if (!token) {
      if (offlineSessionNow()) return reverseWhileOffline('void', String(orderId), reason, approvalPin);
      throw new Error('Not signed in');
    }

    let res: Response;
    try {
      res = await cloudFetch(`${cfg.server_url}/api/orders/${orderId}/void`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        // The server accepts an authorizer_id + that person's override PIN, which
        // records WHO approved the void rather than just that someone knew a PIN.
        body: JSON.stringify({
          reason,
          ...(supervisor_pin ? { supervisor_pin } : {}),
          ...(override_pin   ? { override_pin }   : {}),
          ...(authorizer_id  ? { authorizer_id }  : {}),
        }),
        signal: AbortSignal.timeout(REVERSE_TIMEOUT_MS),
      });
    } catch (e: any) {
      // A529: another server's page (no X-ZapTill-Server) is the cloud not being there too — never its refusal.
      if (e instanceof ForeignPageError) logLine('sale', `void ${orderId}: HTTP ${e.status} was not the cloud's page - voiding on this till's offline rules`);
      return reverseWhileOffline('void', String(orderId), reason, approvalPin);   // 0.6.30: the cloud is not there
    }
    if (cloudUnreachable(res.status)) return reverseWhileOffline('void', String(orderId), reason, approvalPin);
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok) {
      // requirePermission answers a bare "Forbidden" and puts the useful part in
      // `detail` ("Missing permission: orders.void"). Dropping it left the
      // cashier — and whoever they phoned — with a one-word error and no way to
      // tell a permission problem from a wrong PIN or an expired void window.
      const detail = typeof data?.detail === 'string' ? data.detail : '';
      if (res.status === 403 && /missing permission/i.test(detail)) {
        throw new Error(
          'This role cannot void sales. The owner needs to give it "Void sales" (Roles and permissions).',
        );
      }
      throw new Error(detail ? `${data.error ?? 'Void failed'} — ${detail}` : (data.error ?? 'Void failed'));
    }

    // Mark local order voided so order history reflects it immediately.
    // voided_at is written too — the column existed and nothing ever set it.
    const voidedAt = new Date().toISOString();
    db.prepare(`UPDATE orders SET status='voided', voided_at=? WHERE id=?`).run(voidedAt, orderId);
    reverseRiderPayout(String(orderId), db);   // 0.6.27: a voided delivery's rider pay-out goes back in
    // Phase 2b: without the event, every replica of this order stays
    // 'completed' and the branch revenue on other tills counts a voided sale.
    emitEvent('order_voided', String(orderId), { status: 'voided', voided_at: voidedAt });
    logLine('sale', `void ${orderId}${reason ? ` — ${String(reason).slice(0, 120)}` : ''}`);
    return { ok: true };
  });

  // Refund a completed sale (audit M3). Money leaving the drawer needs a manager's authorisation. 0.6.30: offline too
  // now — the till checks the approver's PIN (node, else its saved sign-ins) and the owner's offline rules
  // (reverseWhileOffline above); online, the cloud decides as before.
  handle('order:refund', async (_event, { orderId, reason, override_pin, authorizer_id }:
    { orderId: string; reason: string; override_pin?: string; authorizer_id?: string }) => {
    requireKey(['sales.refund'], 'Your role does not refund sales.');   // A490
    const cfg = getDeviceConfig();
    if (!cfg?.server_url) throw new Error('Device not configured');
    // A345: an offline sign-in has no cloud token yet — make it a cloud sign-in first if the network is back.
    if (!readStaffTokens().token) await tryUpgradeOfflineSession();
    const staffRow = { token: readStaffTokens().token };
    const ownerRow = { token: readSessionTokens().token };
    const token = staffRow?.token ?? ownerRow?.token;
    // 0.6.30: an offline sign-in that cannot become a cloud one yet — refund here, by the owner's offline rules.
    if (!token) {
      if (offlineSessionNow()) return reverseWhileOffline('refund', String(orderId), reason, override_pin);
      throw new Error('Not signed in');
    }

    let res: Response;
    try {
      res = await cloudFetch(`${cfg.server_url}/api/orders/${orderId}/refund`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          reason,
          ...(override_pin  ? { override_pin }  : {}),
          ...(authorizer_id ? { authorizer_id } : {}),
        }),
        signal: AbortSignal.timeout(REVERSE_TIMEOUT_MS),
      });
    } catch (e: any) {
      // A529: another server's page (no X-ZapTill-Server) is the cloud not being there too — never its refusal.
      if (e instanceof ForeignPageError) logLine('sale', `refund ${orderId}: HTTP ${e.status} was not the cloud's page - refunding on this till's offline rules`);
      return reverseWhileOffline('refund', String(orderId), reason, override_pin);   // 0.6.30: the cloud is not there
    }
    if (cloudUnreachable(res.status)) return reverseWhileOffline('refund', String(orderId), reason, override_pin);
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok) {
      const detail = typeof data?.detail === 'string' ? data.detail : '';
      if (res.status === 403 && /missing permission/i.test(detail)) {
        throw new Error('This role cannot refund sales. The owner needs to give it "Refund sales" (Roles and permissions).');
      }
      throw new Error(detail ? `${data.error ?? 'Refund failed'} — ${detail}` : (data.error ?? 'Refund failed'));
    }

    // Mirror it locally so the Z-report on THIS till is right immediately, and
    // stays right if the network drops before the next catalogue pull. The
    // negative rows are what make expected cash come out correct: the till's
    // shift query sums every payment row for a non-voided order, so the money
    // out cancels the money in. Without them the drawer would read short by the
    // refunded amount — audit M8.
    // 0.6.26: skipped when the web-sales pull already stored the cloud's copy of this refund (mirrorTillRefund).
    const legs: Array<{ method: string; amount: number }> = Array.isArray(data?.byMethod) ? data.byMethod : [];
    mirrorTillRefund(String(orderId), legs, Number(data?.refunded) || 0, String(reason ?? ''));

    logLine('sale', `refund ${orderId} ${Number(data?.refunded) || 0}`
      + `${reason ? ` — ${String(reason).slice(0, 120)}` : ''}`);
    return { ok: true, refunded: Number(data?.refunded) || 0 };
  });
}
