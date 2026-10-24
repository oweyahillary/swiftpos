// IPC: sync, device settings (config:*), branding, updates, terminal codes, bill numbers, and resetting the
// device. Registered from ipcHandlers.ts (D10).
import { app, ipcMain, net } from 'electron';
import { isNodeRole } from '../deviceConfig';
import { assertPayload } from '../ipcValidate';
import { getLocalDb, getDbPath, closeLocalDb, getBranding, setBranding } from '../localDb';
import { getUpdateDiagnostics, getUpdateStatus, installUpdateNow } from '../autoUpdate';
import { noteRendererPing } from '../activityTracker';
import { logLine } from '../logFile';
import fs from 'fs';
import { syncAll, retryFailedOrders, getSyncStatus, queueBrandingPush } from '../syncEngine';
import { signedIn as sessionPerson, signedInCan, backOffice as personBackOffice } from '../tillAccess';
import { getDeviceConfig, saveDeviceConfig, isConfigured, clearDeviceConfig } from '../deviceConfig';
import { openShift } from '../shiftService';
import { nextBillNumber } from '../billNumber';   // A500
import { sellRefusal } from '../sellGate';
import { terminalCodeVerdict, normaliseCode, type CodeVerdict } from '../terminalCodes';   // A519: no duplicate terminal codes
import { getActiveSession, logTechAction, flushTechAudit, closeTechReadonlyDb, getRawTechToken } from '../techService';
import { configSaveRefusal } from '../tillGates';   // audit 2026-10-14
import { hasNode, relayBrandingToNode } from '../nodeClient';
import { startNodeServer, stopNodeServer } from '../nodeServer';
import { openBills, joinCodesInUse, type IpcShared } from './shared';

/** Sync, device settings, branding, updates, and resetting the device. */
export function registerDeviceHandlers(ctx: IpcShared) {
  const { handle, tillFetch } = ctx;

  // ── Sync ────────────────────────────────────────────────

  handle('sync:trigger', async () => {
    return await syncAll();
  });

  handle('sync:retryFailed', async () => {
    return await retryFailedOrders();
  });

  // Renderer-side `window` online/offline events are the only reliable network
  // signal Electron gives us — main forwards them into an immediate flush.
  handle('net:changed', async (_event, online: boolean) => {
    if (online) {
      console.log('[sync] Renderer reports online — flushing queue');
      syncAll().catch(console.error);
    }
    return getSyncStatus();
  });

  handle('sync:status', async () => {
    return getSyncStatus();
  });

  // ── Device config (first-run install + runtime server URL) ──

  // A490: the branch access code (node_secret) only to a technician (or the install flow, before the till is set up) —
  // the screens never need it, and it opens the branch server to anyone holding it.
  handle('config:get', async () => {
    const cfg = getDeviceConfig();
    if (!cfg || !isConfigured() || getActiveSession()) return cfg;
    return { ...cfg, node_secret: null };
  });

  // A295: client branding (accent + logo) for the lock screen. Null until the
  // branding sync fills the local table → PinPage renders the SwiftPOS default.
  handle('branding:get', async () => getBranding());

  // A301: desktop-local WRITE path. Validates + upserts the branding row; the accent/logo
  // then flows through PinPage's existing read seam. Throws on invalid input, surfaced to
  // the caller verbatim (rule 7). SVG is rejected in the guard here too — defence in depth,
  // never trust the renderer (the persist-time check the SVG-upload research calls for).
  handle('branding:set', async (
    _event,
    { businessId, accentHex, logoPng, logoRgba, receiptLogoEnabled }:
      { businessId: string; accentHex?: string | null; logoPng?: string | null;
        logoRgba?: { width: number; height: number; data: ArrayLike<number> } | null;
        receiptLogoEnabled?: boolean },
  ) => {
    // A490: the logo and colours are the receipt's and the business's look — receipt.manage or settings.business, or a
    // technician (who sets a till up before anyone signs in).
    if (!getActiveSession() && !signedInCan('receipt.manage', 'settings.business')) throw new Error('Only someone who manages the receipt or the business settings can change the branding.');
    const saved = setBranding(businessId, { accentHex, logoPng, logoRgba, receiptLogoEnabled });
    // A381: and to the branch server at once — the branch's other tills take it from there, with no internet too.
    if (hasNode() && !isNodeRole(getDeviceConfig()?.device_role ?? null)) {
      const b = getBranding();
      if (b) void relayBrandingToNode({ accentHex: b.accentHex, logoPng: b.logoPng, logoReceipt: b.logoReceipt, receiptLogoEnabled: b.receiptLogoEnabled });
    }
    // 0.6.25: and to the cloud (owner's decision), so the next pull does not put the old logo back. Never fails the save.
    const cloud = await queueBrandingPush().catch((e: any) => ({ state: 'pending' as const, message: String(e?.message ?? e) }));
    return { ...saved, cloud };
  });

  // A306: auto-update status for the renderer banner. Push is via update:status
  // (webContents.send from autoUpdate.ts); this is the poll the renderer runs on mount.
  handle('update:getStatus', async () => getUpdateStatus());
  // A496: why this till has (or has not) got its update — the status with its reason and the last 40 update log lines.
  handle('update:getDiagnostics', async () => getUpdateDiagnostics());
  // Apply a downloaded update now, NSIS progress visible + relaunch (A509's updater task where present); a no-op unless
  // an update is actually downloaded, so it can never half-restart a trading till.
  // A519 (owner, 2026-10-16, a manager asked for a PIN on the update bar: "its either we make it possible to restart
  // without the pin or we remove the ability totally … not needed pin confirmation and you are the manager"): ONE tap for
  // the person signed in when they are back office (manager, supervisor, owner — the A499 rule, isBackOffice of their
  // keys), or with a technician console open. Nobody else, and nobody signed in: refused here — their bar has no button
  // (it installs on close, and by itself when the till is idle, A508). The PIN path (the PIN restart channel and its
  // shifts.close_day rule, A490) is gone; the session is never switched. A restart closes no shift and no day (the
  // local database keeps them).
  handle('update:installNow', async () => {
    const me = sessionPerson();
    if (!getActiveSession() && !(me && personBackOffice(me.roleName, me.permissions))) {
      logLine('update', `A519: refused "Restart & update now" — ${me ? `${me.staffId} is not back office` : 'nobody signed in'}`);
      return { ok: false, reason: 'manager_required' };
    }
    logLine('update', `restart for the update by ${me ? (me.name ?? me.staffId) : 'the technician'}`);
    return installUpdateNow();
  });

  /**
   * A519: may this till take this terminal code at its branch? The cloud first (the branch's approved tills, this
   * machine's own earlier installs left out); else what the branch server's join answer said; else nothing refuses it.
   */
  async function checkTerminalCode(code: string, branchId: string): Promise<CodeVerdict> {
    let cloud: { in_use: string[]; suggestion?: string } | null = null;
    if (branchId) {
      try {
        const res = await tillFetch(`/api/support/terminal-codes?branch_id=${encodeURIComponent(branchId)}&code=${encodeURIComponent(normaliseCode(code))}`, {}, 8_000);
        if (res.ok) {
          const d: any = await res.json().catch(() => null);
          if (d && Array.isArray(d.in_use)) cloud = { in_use: d.in_use.map((c: unknown) => normaliseCode(c)), suggestion: typeof d.suggestion === 'string' ? d.suggestion : undefined };
        }
      } catch { /* offline / not signed in yet — the branch server's answer, or nothing */ }
    }
    return terminalCodeVerdict({ code, current: getDeviceConfig()?.terminal_code ?? null, cloud, server: joinCodesInUse });
  }
  // A519: the setup screen asks before it saves (and for the first free code to offer). Before the till is set up, or
  // with a technician console open — the same people who may write the till's identity (tillGates).
  handle('install:checkTerminalCode', async (_e, payload) => {
    const { code, branch_id } = assertPayload<{ code: string; branch_id?: string }>(
      { code: { t: 'string', min: 1 }, branch_id: { t: 'string', optional: true } }, payload);
    if (isConfigured() && !getActiveSession()) throw new Error('This POS’s set-up changes only from the technician console.');
    return checkTerminalCode(code, branch_id || getDeviceConfig()?.branch_id || '');
  });

  handle('config:isConfigured', async () => {
    return isConfigured();
  });

  handle('config:save', async (_event, patch: any) => {
    // Audit 2026-10-14: the install flow writes the till's identity before anyone can sign in; once configured, that is
    // the technician console's, and each setting its own key's holder's (A490, tillGates.ts CONFIG_SETTING_KEY).
    const refusal = configSaveRefusal(patch ?? {}, {
      configured: isConfigured(),
      techSession: !!getActiveSession(),
      holds: (key) => signedInCan(key),   // A490: each setting by its own fine key
    });
    if (refusal) {
      logLine('config', `refused ${Object.keys(patch ?? {}).join(',') || '(empty)'}`);
      throw new Error(refusal);
    }
    // A519: a terminal code that CHANGES (setup's bind step, a technician) is checked against the branch's other tills;
    // a code that stays as it is is never refused — a till already trading keeps its code whatever a sibling uses.
    if (patch && patch.terminal_code !== undefined && patch.terminal_code !== null) {
      const v = await checkTerminalCode(String(patch.terminal_code), String(patch.branch_id ?? getDeviceConfig()?.branch_id ?? ''));
      if (!v.ok) {
        logLine('config', `A519: refused terminal code ${normaliseCode(patch.terminal_code)} — ${v.message}`);
        throw new Error(v.message ?? 'That terminal code cannot be used.');
      }
    }
    // A502: a till's branch server address and access code come only from Find my server (install:joinStatus saves
    // them before this) — never typed. A different address in a patch is dropped and logged; clearing it (null) stays.
    const cur = getDeviceConfig();
    const p = { ...(patch ?? {}) } as Record<string, unknown>;
    const roleAfter = String(p.device_role ?? cur?.device_role ?? 'till');
    if (!isNodeRole(roleAfter) && p.node_url != null && p.node_url !== (cur?.node_url ?? null)) {
      logLine('config', `A502: refused a typed branch server address (${String(p.node_url).slice(0, 60)}) — Find my server sets it`);
      delete p.node_url; delete p.node_secret;
    }
    const saved = saveDeviceConfig(p as any);
    try {
      if (isNodeRole(saved.device_role)) startNodeServer();
      else stopNodeServer();
    } catch (e) {
      console.error('[config:save] node server transition failed:', e);
    }
    // A299: log WHICH keys changed, never their values — device_config holds the
    // node secret and cloud url. Keys are enough for "what was changed, when".
    logLine('config', `saved ${Object.keys(patch ?? {}).join(',') || '(empty)'}`);
    return saved;
  });

  // Synchronous so preload can expose it as a plain string at bridge-build
  // time. process.env.npm_package_version is only set when Electron is launched
  // through an npm script, so every packaged build reported '0.0.1'.
  // ── Bill numbering ──────────────────────────────────────────────────────
  // Every bill is prefixed with this till's terminal code, so three machines in
  // one branch can mint numbers offline and independently without ever
  // colliding — which the previous ORD-<timestamp>-<random> scheme could not
  // guarantee, and which told you nothing about where a sale came from.
  //
  // The counter is per-device and monotonic. Gaps are expected and harmless:
  // one number is held in reserve by the till, so a restart can skip one.
  // A wiped local database restarts the sequence — deliberate, since a wipe is
  // an explicit act, and the terminal prefix still separates the tills.
  handle('orders:nextBillNumber', async () => {
    // A500: never a number this machine already holds — a wiped / reinstalled till (its old code restored, its counter at
    // 0) carries on past the branch's copies of its earlier sales instead of minting T3--1 again (billNumber.ts).
    // No terminal code yet → the old unprefixed scheme, as before.
    // A519: a new bill number is a new sale — "Sell" (orders.create) on the person's own map; the number is then open.
    const refused = sellRefusal('number', sessionPerson(), false);
    if (refused) throw new Error(refused);
    const n = nextBillNumber(getLocalDb(), getDeviceConfig()?.terminal_code);
    openBills.note(n);
    return n;
  });

  ipcMain.on('app:version', (event) => { event.returnValue = app.getVersion(); });

  // A299: renderer-side errors (window.onerror, unhandledrejection, and its
  // console.error/warn — e.g. the "[Overview] salesSummary failed" that only a
  // DevTools screenshot caught on 2026-09-18) forward here so they land in
  // swiftpos.log too. Fire-and-forget send/on: no invoke, so no schema/parity
  // concern. Bounded so a chatty renderer can't flood the file.
  ipcMain.on('log:renderer', (_event, msg: unknown) => {
    logLine('renderer', String(msg ?? '').replace(/\s+/g, ' ').slice(0, 2000));
  });
  // A508: the screen is in use (a key, a click, a touch — the renderer sends at most one every 30 s, main takes at most
  // one every 30 s) and the sale screen's busy state (a cart, the payment screen). Fire-and-forget send/on like
  // log:renderer: no invoke, so no schema/parity entry; anything that is not that shape is ignored (activityTracker.ts).
  ipcMain.on('activity:ping', (_event, payload: unknown) => { try { noteRendererPing(payload); } catch { /* never */ } });

  // Gated + audited (audit: clearDeviceConfig was ungated). Clearing config is
  // how a till sheds its branch binding and re-registers as a new device —
  // with device-branch binding and per-seat licensing live, an anonymous
  // one-click version of that is a control bypass. The reveal-code + signed
  // token is the same bar as every other tech action, and the audit row means
  // the new device appearing in the fleet has a name attached to its birth.
  handle('config:clear', async () => {
    if (!getActiveSession()) {
      throw new Error('Clearing the device configuration requires an active tech session.');
    }
    logTechAction('device.config_clear', {
      terminal: getDeviceConfig()?.terminal_code ?? null,
      device_id: getDeviceConfig()?.device_id ?? null,
    });
    clearDeviceConfig();
    return true;
  });

  /**
   * What a full device reset would destroy. Called before offering one.
   *
   * The count that matters is unsynced orders. Wiping a till holding sales the
   * cloud has never seen deletes real takings, silently — no warning, no total,
   * nothing to reconcile against later. On install day the instinct when a till
   * misbehaves is to wipe and start over, which is exactly when this bites.
   */
  handle('device:resetPreview', async () => {
    const db = getLocalDb();
    const cfg = getDeviceConfig();
    const ownDevice = cfg?.device_id ?? null;
    const unsynced = (db.prepare(
      // own: this warns what THIS wipe destroys. Counting peers' rows would
      // overstate the loss and scare someone out of a legitimate reset.
      `SELECT COUNT(*) n FROM orders WHERE (sync_status IS NULL OR sync_status != 'synced')
         AND COALESCE(device_id,'') = COALESCE(?,'')`,
    ).get(ownDevice) as any)?.n ?? 0;
    const value = (db.prepare(
      `SELECT COALESCE(SUM(total),0) v FROM orders WHERE (sync_status IS NULL OR sync_status != 'synced')
         AND COALESCE(device_id,'') = COALESCE(?,'')`,
    ).get(ownDevice) as any)?.v ?? 0;
    const openShift = (db.prepare(`SELECT COUNT(*) n FROM shifts WHERE status='open' AND COALESCE(device_id,'') = COALESCE(?,'')`).get(ownDevice) as any)?.n ?? 0;

    return {
      terminalCode: cfg?.terminal_code ?? null,
      deviceRole:   cfg?.device_role ?? null,
      unsyncedOrders: Number(unsynced),
      unsyncedValue:  Number(value),
      openShifts:     Number(openShift),
      safe: Number(unsynced) === 0 && Number(openShift) === 0,
    };
  });

  /**
   * Wipes this device back to a fresh install.
   *
   * REFUSES while orders are unsynced, unless explicitly forced. A reset button
   * that quietly discards takings is worse than no reset button — someone would
   * press it in good faith on a till showing "7 pending" and nobody would find
   * out until the day's totals failed to add up.
   */
  handle('device:reset', async (_e, { force }: { force?: boolean } = {}) => {
    // Same bar as config:clear, for a bigger action: this deletes the database.
    // TechPage already sits behind a session — this closes every other route.
    if (!getActiveSession()) {
      throw new Error('Resetting this device requires an active tech session.');
    }
    const db = getLocalDb();
    const ownDevice = getDeviceConfig()?.device_id ?? null;
    const unsynced = (db.prepare(
      `SELECT COUNT(*) n FROM orders WHERE (sync_status IS NULL OR sync_status != 'synced')
         AND COALESCE(device_id,'') = COALESCE(?,'')`,
    ).get(ownDevice) as any)?.n ?? 0;

    if (Number(unsynced) > 0 && !force) {
      throw new Error(
        `${unsynced} order${unsynced === 1 ? '' : 's'} on this POS have not reached the server. ` +
        'Get it back online and let them sync before resetting, or they are lost.',
      );
    }

    // Logged BEFORE the file is dropped — afterwards there is no queue to log
    // into. The flush happens on the next session from any till at this branch.
    logTechAction('device.reset', {
      terminal: getDeviceConfig()?.terminal_code ?? null,
      device_id: ownDevice, unsynced: Number(unsynced), forced: !!force,
    });
    // The entry above lives in the database about to be deleted. Flush it now,
    // best-effort with a hard 3s cap — a reset must not hang on a dead network,
    // and if the flush loses the race the wipe is still visible server-side as
    // this device vanishing from the fleet and a new one registering.
    const rawToken = getRawTechToken();
    if (rawToken) {
      await Promise.race([
        flushTechAudit(rawToken).catch(() => {}),
        new Promise(res => setTimeout(res, 3_000)),
      ]);
    }

    // Drop the file rather than the tables: a reset should leave nothing behind,
    // including schema drift from an older build.
    const dbPath = getDbPath();
    try { db.close(); } catch { /* already closed */ }
    closeTechReadonlyDb();   // the readonly console handle also pins the file
    closeLocalDb?.();
    try { fs.rmSync(dbPath, { force: true }); } catch { /* fall through */ }
    for (const suffix of ['-wal', '-shm']) {
      try { fs.rmSync(dbPath + suffix, { force: true }); } catch { /* ignore */ }
    }

    // Relaunch so the wizard runs against a clean database.
    app.relaunch();
    app.exit(0);
    return true;
  });

  // Advisory reachability check used by the install screen. Runs in the main
  // process (no browser CORS), hits GET /health with a short timeout. Any HTTP
  // response — even 404 — counts as "reachable"; only a network/timeout error
  // is a failure. The local server PC may not be up yet at install time, so a
  // failure is informational, never a hard block.
  handle('config:testConnection', async (_event, url: string) => {
    const base = (url ?? '').replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(base)) {
      return { ok: false, reachable: false, error: 'URL must start with http:// or https://' };
    }
    if (!net.isOnline()) {
      return { ok: false, reachable: false, error: 'This device appears to be offline' };
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(`${base}/health`, { signal: controller.signal });
      clearTimeout(timer);
      // ok is 2xx ONLY. A 404 means something answered but it is not our
      // /health endpoint — almost always a URL with an extra path on it, which
      // the install screen used to report as a green "Server reachable".
      return { ok: res.ok, reachable: true, status: res.status };
    } catch (err: any) {
      return { ok: false, reachable: false, error: err?.message ?? 'Could not reach server' };
    }
  });
}
