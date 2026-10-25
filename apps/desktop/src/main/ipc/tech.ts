// IPC: tech access — the session, promote to branch server, backups, GPU mode, the console, status and logs.
// Registered from ipcHandlers.ts (D10).
import { app, dialog, BrowserWindow } from 'electron';
import { isNodeRole, ensureNodeSecret } from '../deviceConfig';
import { assertPayload } from '../ipcValidate';
import { getBuildInfo } from '../buildInfo';
import { getLocalDb } from '../localDb';
import { logLine, getLogPath, getAuthLogPath, KEEP_FILES, AUTH_KEEP_FILES } from '../logFile';
import { buildSupportText, packSupportText, readLogFiles, rolledPaths, sendVerdict, syncSummary, type SupportHeader } from '../supportLogs';   // A519
import { lastStartupLine } from '../lowImpactStart';
import fs from 'fs';
import path from 'path';   // A516
import { getSyncStatus, testConnection } from '../syncEngine';
import { liveStatus } from '../liveSync';   // A531
import { getDeviceConfig, saveDeviceConfig } from '../deviceConfig';
import { takeSnapshot, setBackupDir, maintenanceStatus } from '../maintenance';
import { channelHealth } from '../nodeHealth';
import { setTillPin } from '../lanTls';
import { checkRevealCode, openTechSession, getActiveSession, closeTechSession, logTechAction, flushTechAudit, runTechQuery, getRawTechToken } from '../techService';
import { broadcastTechToken, fetchNodeTechToken, probeNode, fetchRosterFromNode } from '../nodeClient';
import { storeBranchStaff } from '../branchStaff';
import { unpackRosterSnapshot } from '../rosterSnapshot';
import { startNodeServer } from '../nodeServer';
import os from 'os';
import { type IpcShared } from './shared';

/** Tech access: the session, promote to server, backups, GPU mode, the console, status and logs. */
export function registerTechHandlers(ctx: IpcShared) {
  const { handle, tillFetch } = ctx;

  // ── Tech access ────────────────────────────────────────────────────────────
  // Reveal code check (doorknock) — opens the token prompt. Grants nothing.
  // A494: when the reveal code was last entered at THIS till — a peer adopts the branch's technician session only after it.
  let revealPassedAt = 0;
  const REVEAL_FRESH_MS = 5 * 60_000;
  handle('tech:checkReveal', async (_event, code: string) => {
    const ok = checkRevealCode(code);
    if (ok) revealPassedAt = Date.now();
    return { ok };
  });

  // Verify the Ed25519 token OFFLINE and open a 4-hour active session.
  handle('tech:openSession', async (_event, token: string) => {
    const result = openTechSession(String(token ?? '').trim());
    if (!result.ok) return { ok: false, error: result.reason };
    // Best-effort: flush queued audit + mark token used server-side if reachable.
    flushTechAudit(String(token).trim()).catch(() => {});
    // Share the token with branch peers (via the node) so all tills reflect the
    // same active session. Each peer re-verifies it locally; no shared clock.
    broadcastTechToken(String(token).trim()).catch(() => {});
    return { ok: true, session: result.session };
  });

  // A peer till adopts an active tech session broadcast to the branch node.
  handle('tech:adoptFromNode', async () => {
    const existing = getActiveSession();
    if (existing) return { ok: true, session: existing };
    // A494: never a bare call — the technician's code is entered at this till first (tech:checkReveal).
    if (!revealPassedAt || Date.now() - revealPassedAt > REVEAL_FRESH_MS) return { ok: false, error: 'Enter the technician code on this POS first.' };
    const token = await fetchNodeTechToken().catch(() => null);
    if (!token) return { ok: false };
    const result = openTechSession(token);
    return result.ok ? { ok: true, session: result.session } : { ok: false };
  });

  handle('tech:getSession', async () => getActiveSession());

  // A494: closing ends it at the branch too — the token the branch server holds for its tills to adopt is cleared (a till
  // that already adopted it keeps its own session until it is closed there or it expires).
  handle('tech:closeSession', async () => {
    closeTechSession();
    revealPassedAt = 0;
    broadcastTechToken('').catch(() => {});
    return { ok: true };
  });

  handle('tech:logAction', async (_event, { action, detail }: { action: string; detail?: any }) => {
    if (!getActiveSession()) return { ok: false, error: 'No active tech session.' };   // A494
    // A490: kept for the screens' audit lines, but bounded — the audit is a queue the cloud receives.
    const act = String(action ?? '').slice(0, 80);
    let d: any = detail;
    try { const t = JSON.stringify(detail ?? null); if (t && t.length > 2000) d = { truncated: t.slice(0, 2000) }; } catch { d = null; }
    logTechAction(act, d);
    return { ok: true };
  });

  // Read-only DB console. Gated in MAIN on an active tech session — the
  // renderer's gating is a courtesy; this check is the door. The query is
  // audited verbatim BEFORE it runs, so a query that errors is still on record.
  // Manual snapshot from the tech panel — same job as the nightly one, on
  // demand, session-gated like every tech action.
  // Phase 3 — the promotion lever. "Failover is a role flag" was a claim
  // until this existed. Promotion is safe because the promoted till already
  // holds the branch (2a distribution) and already carries the branch secret
  // it was authenticating with as a peer — the listener is the only thing
  // that was not running.
  handle('tech:promoteToNode', async () => {
    if (!getActiveSession()) return { ok: false, error: 'No active tech session.' };
    const before = getDeviceConfig()?.device_role ?? 'till';
    // A22 — split-brain guard. Promoting clears node_url and starts serving; if the
    // CURRENT branch server is still reachable, promoting now would put two nodes on
    // one branch (the classic case: an old node merely unplugged, then reconnected).
    // There is no legitimate reason to promote while the old node still answers, so
    // refuse loudly and tell the tech to demote/disconnect it first. (A reconnect
    // AFTER promotion is caught server-side: confirmServingRole records the conflict
    // and the fleet view flags it.)
    const currentNodeUrl = getDeviceConfig()?.node_url ?? null;
    if (currentNodeUrl) {
      const probe = await probeNode(currentNodeUrl);
      if (probe.ok) {
        return {
          ok: false,
          code: 'node_reachable',
          error: `The current branch server at ${currentNodeUrl} is still reachable. ` +
                 `Promoting now would put TWO servers on this branch (split-brain). ` +
                 `Demote or disconnect it first, then promote.`,
        };
      }
    }
    // A20 backstop: pull a fresh roster from the CURRENT node before we stop being
    // a peer, so the promoted node can authenticate cashiers the instant it serves.
    // Best-effort and guarded (unpackRosterSnapshot refuses an empty/pinless pull,
    // so this can only ever ADD a current roster, never wipe one). Must run BEFORE
    // the role flip — a node has no node_url to pull from. A peer that was
    // replicating already holds the roster via sync; this guarantees it's current.
    try {
      const snapshot = await fetchRosterFromNode();
      if (snapshot) {
        const d = unpackRosterSnapshot(snapshot);
        if (d.apply) storeBranchStaff(d.branchId, d.roster);
      }
    } catch { /* promotion proceeds; the node refreshes the roster on its own cloud sync */ }
    logTechAction('role.promote', { from: before, to: 'node' });
    saveDeviceConfig({ device_role: 'node', node_url: null });
    setTillPin(null);   // A489: a server pins no server
    startNodeServer();
    const secret = ensureNodeSecret();
    return { ok: true, role: 'node', secret,
             note: 'Now repoint each remaining POS at this machine (Tech → branch server address).' };
  });

  // Repoint this till at a (new) branch server. Probe BEFORE save — a wrong
  // address written blind is a till that silently stops replicating. Also the
  // demotion path: a former node repointed at the new one becomes a till again.
  // Repoint this till at a (new) branch server. Probe BEFORE save — a wrong
  // address written blind is a till that silently stops replicating. Also the
  // demotion path: a former node repointed at the new one becomes a till again.
  //
  // A21 — WHY THE OUTBOX CURSORS ARE RESET WHEN THE ADDRESS CHANGES.
  // `outbox_cursors` is keyed by table_name ALONE and carries no node identity,
  // while `peer_cursors` on the node side is keyed (device_id, table_name).
  // That asymmetry only shows on failover, and then it loses rows: a peer that
  // offered orders to seq 500 to the OLD node, which distributed only to 430
  // before dying, will never re-offer 431-500 to its replacement. Those sales
  // sit on this till and on a dead machine's disk, absent from the new source of
  // truth, the day close and the cloud, with nothing reporting a gap.
  //
  // Re-offering is free: ingest is INSERT OR IGNORE on stable client UUIDs with
  // origin device_id and seq preserved end to end, so anything the new node
  // already holds is recognised and ignored rather than duplicated.
  //
  // Only on an ACTUAL change — re-entering the same address must not trigger a
  // full re-offer.
  // A502: 'tech:setNodeUrl' (a branch server address typed on the Tech page) is gone — owner, 2026-10-15: "we remove the
  // address totally and use find my server". A till is pointed at its server only by finding it and being allowed there
  // (install:requestJoin with rejoin — TechFindServer), which keeps everything on the till, as the typed address did.

  handle('tech:backupNow', async () => {
    if (!getActiveSession()) return { ok: false, error: 'No active tech session.' };
    logTechAction('backup.manual', {});
    return await takeSnapshot();
  });

  // A516: the graphics mode a technician sets on the Tech page (low-memory mode, A513) — the same gpu-mode.json the
  // start gate reads before ZapTill loads (startGate.ts readGpuMode); it takes effect at the next start.
  const GPU_FILE = () => path.join(app.getPath('userData'), 'gpu-mode.json');
  handle('tech:getGpuMode', async () => {
    if (!getActiveSession()) throw new Error('Tech session required');
    try { const m = JSON.parse(fs.readFileSync(GPU_FILE(), 'utf8'))?.mode; return { mode: m === 'on' || m === 'off' ? m : 'auto' }; }
    catch { return { mode: 'auto' }; }
  });
  handle('tech:setGpuMode', async (_e, payload) => {
    const { mode } = assertPayload<{ mode: string }>({ mode: { t: 'string', min: 2 } }, payload);
    if (!getActiveSession()) throw new Error('Tech session required');
    if (mode !== 'auto' && mode !== 'on' && mode !== 'off') throw new Error('Graphics mode is auto, on or off.');
    fs.writeFileSync(GPU_FILE(), JSON.stringify({ mode }));
    logTechAction('graphics.mode', { mode });
    logLine('startup', `graphics mode set to "${mode}" by a technician — takes effect when ZapTill next starts`);
    return { ok: true, mode };
  });

  handle('tech:maintenance', async () => {
    if (!getActiveSession()) throw new Error('Tech session required');   // A494
    return maintenanceStatus();
  });
  // A380: the technician chooses where the branch server's backups go — proven by writing one there at once.
  handle('tech:chooseBackupDir', async () => {
    if (!getActiveSession()) throw new Error('Tech session required');
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const res = await dialog.showOpenDialog(win!, { title: 'Choose the backup folder (a USB drive or a second disk)',
      properties: ['openDirectory', 'createDirectory'] });
    return res.canceled || !res.filePaths?.[0] ? null : res.filePaths[0];
  });
  handle('tech:setBackupDir', async (_e, payload) => {
    const { dir } = assertPayload<{ dir: string | null }>({ dir: { t: 'any' } }, payload ?? {});
    if (!getActiveSession()) throw new Error('Tech session required');
    const clean = typeof dir === 'string' && dir.trim() ? dir.trim() : null;
    logTechAction('backup.dir', { dir: clean ?? '(default)' });
    return setBackupDir(clean);
  });

  handle('tech:query', async (_event, { sql }: { sql: string }) => {
    if (!getActiveSession()) return { ok: false, error: 'No active tech session.' };
    logTechAction('db_query', { sql: String(sql ?? '').slice(0, 2000) });
    return runTechQuery(sql);
  });

  // Local, offline-safe diagnostics for the tech screen.
  handle('tech:status', async () => {
    if (!getActiveSession()) throw new Error('Tech session required');   // A494: the till's addresses and build
    const db = getLocalDb();
    const cfg = getDeviceConfig();
    const sync = getSyncStatus();
    // branch-wide: tech diagnostics. A tech looking at a node wants the latest
    // activity anywhere at the branch, not just this machine's.
    const lastOrder = (db.prepare(
      `SELECT created_at FROM orders ORDER BY created_at DESC LIMIT 1`,
    ).get() as any)?.created_at ?? null;
    return {
      device: {
        device_id: cfg?.device_id ?? null, device_name: cfg?.device_name ?? null,
        device_role: cfg?.device_role ?? 'till', branch_id: cfg?.branch_id ?? null,
        deploy_mode: cfg?.deploy_mode ?? null, server_url: cfg?.server_url ?? null,
        node_url: cfg?.node_url ?? null,
      },
      sync: { online: sync.online, pending: sync.pendingCount, failed: sync.failedCount, lastOrder, breakdown: sync.pendingBreakdown,
        live: liveStatus() },   // A531: each topic's last change applied, what waits, the push channel
      build: getBuildInfo(),
    };
  });

  // A178: a REAL reachability probe — reaches the configured server and reports
  // the round-trip, unlike the "ONLINE" badge which is only net.isOnline().
  handle('tech:testConnection', async () => {
    return testConnection();
  });

  // A178: tail the durable log so a tech can read it on the device without
  // hunting for %APPDATA%. Read-only; last N lines; never exposes tokens because
  // the log itself never records them.
  // A519: "Send logs to support" — the last 24 hours of this till's log, every secret removed (supportLogs.ts,
  // logRedact.ts), with a short header, to the cloud (POST /api/support/logs, under this till's own session); the admin
  // portal shows it on the client's page. A technician's session only (the log names staff and sales). Offline: the
  // Tech page offers "Save log to file" (tech:saveLog) instead.
  const supportText = (): string => {
    const cfg = getDeviceConfig();
    const db = getLocalDb();
    const sess = db.prepare(`SELECT business_id, business_name FROM session WHERE id=1`).get() as any;
    let branch: string | null = null;
    try { branch = (db.prepare(`SELECT name FROM branches WHERE id = ?`).get(cfg?.branch_id ?? '') as any)?.name ?? null; } catch { /* no table */ }
    const tech = getActiveSession();
    const header: SupportHeader = {
      business: sess?.business_name ?? null, businessId: sess?.business_id ?? null, branch, branchId: cfg?.branch_id ?? null,
      terminal: cfg?.terminal_code ?? null, deviceId: cfg?.device_id ?? null, deviceName: cfg?.device_name ?? null,
      role: cfg?.device_role ?? 'till', version: app.getVersion(),
      os: `${os.platform()} ${typeof (os as any).version === 'function' ? (os as any).version() : ''} ${os.release()} ${os.arch()}`.replace(/\s+/g, ' ').trim(),
      ramGb: Math.round(os.totalmem() / 1024 ** 3 * 10) / 10, freeGb: Math.round(os.freemem() / 1024 ** 3 * 10) / 10,
      startup: lastStartupLine(),
      sync: cfg?.node_url && !isNodeRole(cfg.device_role) ? syncSummary(channelHealth()) : [],
      tech: tech ? `${tech.techName} (${tech.techId})` : null, at: new Date().toISOString(),
    };
    return buildSupportText(header, readLogFiles(rolledPaths(getLogPath(), KEEP_FILES)),
      readLogFiles(rolledPaths(getAuthLogPath(), AUTH_KEEP_FILES)), Date.now()).text;
  };
  handle('tech:sendLogs', async () => {
    if (!getActiveSession()) throw new Error('Tech session required');
    const packed = packSupportText(supportText());
    let status: number | null = null; let body: any = null;
    try {
      const raw = getRawTechToken();
      const res = await tillFetch('/api/support/logs', { method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(raw ? { 'X-Tech-Token': raw } : {}) },
        body: JSON.stringify({ log_gz_b64: packed.b64, bytes: packed.bytes, trimmed: packed.trimmed,
          terminal_code: getDeviceConfig()?.terminal_code ?? null, app_version: app.getVersion() }) }, 30_000);
      status = res.status; body = await res.json().catch(() => null);
    } catch { status = null; }
    const v = sendVerdict(status, body);
    logLine('tech', v.ok ? `A519: log sent to support — reference ${v.reference}` : `A519: log not sent — ${v.message}`);
    return v;
  });
  handle('tech:saveLog', async () => {
    if (!getActiveSession()) throw new Error('Tech session required');
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const name = `zaptill-log-${getDeviceConfig()?.terminal_code ?? 'till'}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.txt`;
    const choice = await dialog.showSaveDialog(win!, { title: 'Save the log for support', defaultPath: name,
      filters: [{ name: 'Text', extensions: ['txt'] }] });
    if (choice.canceled || !choice.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(choice.filePath, supportText(), 'utf8');
    logLine('tech', `A519: log saved to a file for support`);
    return { ok: true, path: choice.filePath };
  });

  handle('tech:logTail', async (_event, arg?: { lines?: number }) => {
    if (!getActiveSession()) return { path: null, text: 'Tech session required.' };   // A494: the log names staff and sales
    const lines = Math.min(Math.max(arg?.lines ?? 200, 1), 2000);
    try {
      const p = getSyncStatus().logPath;
      if (!p || !fs.existsSync(p)) return { path: p ?? null, text: '' };
      const all = fs.readFileSync(p, 'utf8').split(/\r?\n/);
      return { path: p, text: all.slice(-lines).join('\n') };
    } catch (err: any) {
      return { path: null, text: `could not read log: ${err?.message ?? err}` };
    }
  });
}
