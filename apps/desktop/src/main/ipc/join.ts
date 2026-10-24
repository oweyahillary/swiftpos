// IPC: joining the business (enrolment code, the branch server's join requests), the branch server's health
// (node:*), and the device session. Registered from ipcHandlers.ts (D10).
import { getMacAddressCached, identityHeaders } from '../machineFingerprint';
import { app } from 'electron';
import { isNodeRole, ensureNodeSecret } from '../deviceConfig';
import { assertPayload } from '../ipcValidate';
import { getLocalDb } from '../localDb';
import { logLine, authLog } from '../logFile';
import { readSessionTokens, writeSessionTokens, writeDeviceSecret } from '../tokenStore';
import { cloudFetch, nodeRefusal } from '../cloudGateway';   // A410: a till on a branch reaches the cloud only through its branch server
import { resetRenewalGate, configureSyncEngine, syncAll, replicateToNode } from '../syncEngine';
import { signedInCan } from '../tillAccess';
import { getCloudUrl, getDeviceConfig, saveDeviceConfig, isConfigured } from '../deviceConfig';
import { rearmNodeOutbox, rearmFailedNodeRows, rearmPeerQuarantine, retryPeerQuarantine, peerQuarantineSummary, nodeQueueDepth } from '../nodeIngest';
import { channelHealth, serverInfo, protocolVerdict, NODE_PROTOCOL } from '../nodeHealth';   // A501
import { distributionLag } from '../distributionLag';   // A534 (A23)
import { drawersStatus } from '../branchDrawers';   // A542
import { lastFollowLook } from '../nodeFollow';   // A501
import { setNodeDeviceToken, nodeDeviceToken, joinProofHeaders } from '../nodeClient';   // F7, A503
import { readServerCert, pinnedFetch, securityCode, setTillPin, tillPin, nodeTlsStatus, serverSecurityCode, forgetPinForRetrust } from '../lanTls';   // A489
import { refreshTechConfig, getActiveSession, logTechAction } from '../techService';
import { stopNodeServer } from '../nodeServer';
import { listenForServers } from '../serverBeacon';   // A427
import { pendingJoins, answerJoin } from '../serverJoin';   // A427
import os from 'os';
import { clearCatalogue, noteJoinCodes, type IpcShared } from './shared';

/** Joining the business, a branch server's join requests and its health, and the device session. */
export function registerJoinHandlers(ctx: IpcShared) {
  const { handle, tillFetch } = ctx;

  // ── Auth ────────────────────────────────────────────────

  // A till joins the business with a one-time code ZapTill issues in the admin portal (business id + code, redeemed
  // at /api/auth/enrol/redeem). A415 (owner, 2026-10-06: "never the owners session at all"): the session the cloud
  // hands back is the TILL's own — its device id, the business, the branch, no person. Nothing of the owner is kept on
  // the till: the session row names this till (user_id = its device id).
  //
  // `rejoin` (the technician console, "Rejoin this till"): the same till joins its business again with a fresh code —
  // after its sign-in was lost or the till was removed — and KEEPS everything on it: sales waiting to sync, shifts,
  // the menu, settings. Only a code for this till's own business and branch is accepted.
  const joinBusiness = async (businessId: string, code: string, rejoin: boolean) => {
    const cfg = getDeviceConfig();
    const db = getLocalDb();
    const current = db.prepare(`SELECT business_id FROM session WHERE id=1`).get() as { business_id?: string } | undefined;
    if (rejoin && current?.business_id && current.business_id !== businessId) {
      throw new Error('That business ID is not this POS\'s business. Rejoin keeps this POS\'s sales, so it only joins its own business.');
    }
    const res = await cloudFetch(`${getCloudUrl()}/api/auth/enrol/redeem`, {
      method: 'POST',
      // A477: which machine this is (MAC as A182; the MachineGuid and BIOS serial hashed) — the cloud binds the till's
      // key to it; a technician's rejoin records the machine it is done on.
      headers: { 'Content-Type': 'application/json', ...(await identityHeaders().catch(() => ({}))) },
      body: JSON.stringify({
        business_id: businessId,
        code,
        rejoin,
        // This till's stable device id: the cloud records THIS terminal (and, rejoining, recognises it).
        device_id:   cfg?.device_id ?? undefined,
        // A182: the machine's stable MAC, so if this box was enrolled before (a
        // reinstall) the server can hand back its previous terminal code/name.
        mac_address: getMacAddressCached() ?? undefined,
        // A273 follow-up: the till's code and the name typed at setup, so the web
        // POS's till picker shows THIS till's real name. Absent on a first enrolment before setup.
        terminal_code: getDeviceConfig()?.terminal_code ?? undefined,
        device_name:   getDeviceConfig()?.device_name ?? undefined,
        branch_id:     cfg?.branch_id ?? undefined,
      }),
    });

    const data = await res.json();
    if (!res.ok) { authLog(rejoin ? 'rejoin-refused' : 'join-refused', String(data?.code ?? `HTTP ${res.status}`)); throw new Error(data.error ?? (rejoin ? 'Rejoin failed' : 'Enrolment failed')); }

    if (!rejoin) clearCatalogue(db);
    db.prepare(`
      INSERT INTO session (id, token, refresh_token, user_id, business_id, business_name, currency, logged_in_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        token=excluded.token, refresh_token=excluded.refresh_token, user_id=excluded.user_id, business_id=excluded.business_id,
        business_name=excluded.business_name, currency=excluded.currency, logged_in_at=excluded.logged_in_at
    `).run(
      data.token,
      data.refreshToken ?? null,
      String(data.till?.device_id ?? cfg?.device_id ?? ''),
      data.business.id,
      data.business.name,
      data.business.currency ?? 'KES',
      new Date().toISOString(),
    );

    // D5: wrap the credentials at rest.
    writeSessionTokens({ token: data.token, refreshToken: data.refreshToken ?? '' });
    // A407: the device secret — the till's own way back in if its session is ever refused.
    if (typeof data.deviceSecret === 'string' && data.deviceSecret) writeDeviceSecret(data.deviceSecret);

    if (data.business?.type) saveDeviceConfig({ business_type: String(data.business.type) });

    // A182: if the server recognised this machine (same MAC as a prior install),
    // restore its previous terminal code + name so a reinstalled till comes back
    // as itself instead of a blank "new till" that gets re-named T1 and collides
    // (A181). Only fills gaps — never overwrites a code the operator has set here.
    if (data.restore && (data.restore.terminal_code || data.restore.device_label)) {
      const now = getDeviceConfig();
      const patch: Record<string, unknown> = {};
      if (data.restore.terminal_code && !now?.terminal_code) patch.terminal_code = String(data.restore.terminal_code);
      if (data.restore.device_label && !now?.device_name)   patch.device_name   = String(data.restore.device_label);
      if (Object.keys(patch).length) { saveDeviceConfig(patch); logLine('enrol', `restored identity from a prior install: ${JSON.stringify(patch)}`); }
    }

    configureSyncEngine(getCloudUrl(), data.token, data.refreshToken ?? '');
    // A477: a technician's action — the renewal gate opens at once (a refused session waits 15 min otherwise).
    resetRenewalGate(rejoin ? 'a technician rejoined this POS' : 'the POS joined its business');
    authLog(rejoin ? 'rejoin' : 'join', `business ${data.business?.id ?? businessId}${data.deviceSecret ? ', device secret kept' : ''}`);
    refreshTechConfig(data.token).catch(() => {});
    logLine('enrol', rejoin ? 'the technician rejoined this till to its business — everything on it kept' : 'joined the business');
    await syncAll().catch(console.error);

    return { business: data.business, branchId: data.branchId ?? null };
  };

  handle('auth:enrolDevice', async (_event, payload) => {
    const { business_id, code } = assertPayload<{ business_id: string; code: string }>(
      { business_id: { t: 'string', min: 1 }, code: { t: 'string', min: 1 } }, payload);
    // A490: a till already set up AND joined to its business joins again only from the technician console (as
    // auth:rejoin) — a first join clears the catalogue and replaces the till's session, so it is not anyone's button.
    const joined = !!(getLocalDb().prepare(`SELECT business_id FROM session WHERE id=1`).get() as { business_id?: string } | undefined)?.business_id;
    if (isConfigured() && joined && !getActiveSession()) throw new Error('This POS is already joined to its business. A technician rejoins it from the technician console.');
    return joinBusiness(String(business_id).trim(), String(code).trim(), false);
  });

  // A415: the technician rejoins this till to its business — only inside an open technician session (the tech console),
  // checked here in the main process, not just on the screen.
  handle('auth:rejoin', async (_event, payload) => {
    const { business_id, code } = assertPayload<{ business_id: string; code: string }>(
      { business_id: { t: 'string', min: 1 }, code: { t: 'string', min: 1 } }, payload);
    if (!getActiveSession()) throw new Error('Open the technician console first.');
    const out = await joinBusiness(String(business_id).trim(), String(code).trim(), true);
    logTechAction('till.rejoin', { business_id: String(business_id).trim(), branch_id: out.branchId });
    return out;
  });

  // ── A427: join a branch server found on the shop network (serverBeacon.ts / serverJoin.ts) ──────────────────────
  // The new till: listen for servers, ask one to join, then — once someone at the server allows it — take the
  // server's answer (cloud, business, branch, server address and access code, a one-time code) and enrol with it.
  // Terminal code and the rest of setup stay on the setup screen as before.
  handle('install:findServers', async () => listenForServers(6000));

  // A436: `rejoin` — a till already set up but signed out (the sign-in-code screen, EnrolPage) asks the same way and,
  // once allowed, joins its business again KEEPING everything on it (joinBusiness rejoin), its setup untouched.
  // A489: `cert` — the server's certificate, read before the join; the join and its answer (which carries the branch
  // access code and this till's device key) then go over TLS pinned to it, and it is pinned when the join succeeds.
  let joinAsk: { url: string; id: string; token: string; rejoin: boolean; cert: string | null } | null = null;
  const joinFetch = (url: string, init: any, cert: string | null) => (cert ? pinnedFetch(url, init, cert) : fetch(url, init));
  // A494: a till already set up AND joined to its business is moved to another (a first join replaces its session and
  // clears its menu) only by a technician — the same rule as auth:enrolDevice; its own rejoin (keeps everything) stays.
  const joinedHere = (): boolean => isConfigured()
    && !!(getLocalDb().prepare(`SELECT business_id FROM session WHERE id=1`).get() as { business_id?: string } | undefined)?.business_id;
  const ALREADY_JOINED = 'This POS is already joined to its business. A technician moves it from the technician console.';
  const sameCloud = (a: string, b: string) => String(a ?? '').trim().replace(/\/+$/, '').toLowerCase() === String(b ?? '').trim().replace(/\/+$/, '').toLowerCase();
  handle('install:requestJoin', async (_event, payload) => {
    const { url, rejoin } = assertPayload<{ url: string; rejoin?: boolean }>({ url: { t: 'string', min: 1 }, rejoin: { t: 'boolean', optional: true } }, payload);
    if (!/^http:\/\/(\d{1,3}\.){3}\d{1,3}:\d{1,5}$/.test(url)) throw new Error('That is not a branch server address.');
    // A494: this machine itself (or 0.0.0.0) is never a branch server for an installed till — only in development.
    if (app.isPackaged && /^http:\/\/(127\.|0\.)/.test(url)) throw new Error('That is not a branch server address.');
    if (!rejoin && joinedHere() && !getActiveSession()) throw new Error(ALREADY_JOINED);
    // A502: a former branch server becomes a till of another server only from the technician console (a technician's
    // session) — it stops serving once that server allows it. Never through itself.
    if (rejoin && isNodeRole(getDeviceConfig()?.device_role) && !getActiveSession()) throw new Error('This computer is the branch server — it joins another server from the technician console.');
    const deviceId = getDeviceConfig()?.device_id ?? saveDeviceConfig({ configured: false } as any).device_id;
    const { cert } = await readServerCert(url, 4000);   // null: a server on an older build — the join stays plain
    let res: Response;
    try {
      res = await joinFetch(`${url}/node/join`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...joinProofHeaders(deviceId, cert) },   // A503
        body: JSON.stringify({ device_id: deviceId, name: os.hostname() }), signal: AbortSignal.timeout(5000) }, cert);
    } catch { throw new Error('Could not reach that branch server. Check this POS is on the same network.'); }
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error ?? `The branch server refused (HTTP ${res.status}).`);
    joinAsk = { url, id: String(body.id), token: String(body.token), rejoin: !!rejoin, cert };
    const code = securityCode(cert);
    logLine('join', `asked the branch server at ${url} to join — ${code ? `encrypted, security code ${code}` : 'unencrypted (the server is on an older build)'}`);
    return { ok: true, name: os.hostname(), securityCode: code };
  });

  handle('install:joinStatus', async () => {
    if (!joinAsk) return { status: 'none' as const };
    const ask = joinAsk;
    let r: any;
    try {
      const res = await joinFetch(`${ask.url}/node/join/status?id=${encodeURIComponent(ask.id)}&token=${encodeURIComponent(ask.token)}`, { signal: AbortSignal.timeout(5000) }, ask.cert);
      r = await res.json();
    } catch { return { status: 'pending' as const }; }   // a blip — keep waiting
    if (r?.status === 'pending') return { status: 'pending' as const };
    joinAsk = null;
    if (r?.status !== 'approved' || !r.grant) {
      return { status: r?.status === 'denied' ? 'denied' as const : 'expired' as const };
    }
    const g = r.grant;
    noteJoinCodes(g);   // A519: the branch's codes in use, for the bind step's check
    // A494: checked again at the answer (a technician's session may have ended meanwhile), and a till already set up
    // takes a grant only for the cloud it is set up for — a server cannot point it at another cloud.
    if (!ask.rejoin && joinedHere() && !getActiveSession()) throw new Error(ALREADY_JOINED);
    if ((ask.rejoin || isConfigured()) && !sameCloud(String(g.cloud_url ?? ''), getCloudUrl())) {
      logLine('join', `A494: refused a join answer from ${ask.url} for another cloud (${String(g.cloud_url ?? '')})`);
      throw new Error('That branch server belongs to another cloud than this POS. Ask your technician.');
    }
    const port = Number(new URL(ask.url).port);
    if (ask.rejoin) {
      // Already set up: only the way to the server changes (saved first, so the rejoin goes through it — A410); put
      // back as it was if the cloud refuses (another branch's server, say).
      const before = getDeviceConfig();
      const pinBefore = tillPin();
      const keyBefore = nodeDeviceToken();   // A503: restored with the address if the rejoin fails
      // A502: a former branch server stepping down (technician console) stops serving before it joins the other one.
      const wasServer = isNodeRole(before?.device_role);
      if (wasServer) { stopNodeServer(); logTechAction('role.stepdown', { from: before?.device_role, node_url: ask.url }); }
      saveDeviceConfig({ node_url: ask.url, node_secret: String(g.node_secret), ...(wasServer ? { device_role: 'till' } : {}) } as any);
      setTillPin(ask.cert);   // A489: the server's certificate goes with its address (null: an older server — plain)
      if (g.device_token) setNodeDeviceToken(String(g.device_token));   // F7: this till's own key at the server
      // F2: a rejoin is a (possibly new) server — everything this till holds is offered to it again.
      if ((before?.node_url ?? null) !== ask.url || (before?.node_secret ?? null) !== String(g.node_secret)) {
        rearmNodeOutbox();
        logLine('node', `rejoined through ${ask.url}; every row is offered to the branch server again`);
      }
      try {
        const joined = await joinBusiness(String(g.business_id), String(g.code), true);
        logLine('join', `rejoined ${joined.business?.name ?? 'the business'} through the branch server at ${ask.url}`);
        return { status: 'joined' as const, business: joined.business, branchId: String(g.branch_id), branchName: g.branch_name ?? null,
          cloudUrl: String(g.cloud_url), nodeIp: new URL(ask.url).hostname, nodePort: port, nodeSecret: String(g.node_secret) };
      } catch (e) {
        saveDeviceConfig({ node_url: before?.node_url ?? null, node_secret: before?.node_secret ?? null,
          ...(wasServer ? { device_role: before?.device_role } : {}) } as any);   // A502: serves again from its next start
        setTillPin(pinBefore);
        if (keyBefore) setNodeDeviceToken(keyBefore);   // A503
        throw e;
      }
    }
    // Where the server is and how to reach it — saved BEFORE enrolling, so the enrolment goes through the server
    // (A410) and works even when this till has no internet of its own. Not marked configured: setup finishes on screen.
    saveDeviceConfig({ deploy_mode: 'cloud', server_url: String(g.cloud_url), branch_id: String(g.branch_id),
      device_role: 'till', node_url: ask.url, node_secret: String(g.node_secret), configured: false } as any);
    setTillPin(ask.cert);   // A489: from here every request to the server is TLS, pinned to this certificate
    if (g.device_token) setNodeDeviceToken(String(g.device_token));   // F7: this till's own key at the server
    const joined = await joinBusiness(String(g.business_id), String(g.code), false);
    logLine('join', `joined ${joined.business?.name ?? 'the business'} through the branch server at ${ask.url}`);
    return {
      status: 'joined' as const, business: joined.business, branchId: String(g.branch_id), branchName: g.branch_name ?? null,
      cloudUrl: String(g.cloud_url), nodeIp: new URL(ask.url).hostname, nodePort: port, nodeSecret: String(g.node_secret),
    };
  });

  // The server: who is waiting, and the answer. Allow fetches a one-time code from the cloud for this branch.
  handle('node:joinRequests', async () => (isNodeRole(getDeviceConfig()?.device_role)
    ? pendingJoins().map((r) => ({ ...r, securityCode: serverSecurityCode() })) : []));   // A489: compared with the till's screen

  // A489: this till's connection to its branch server (Tech page), or — on the server — its own security code.
  handle('node:tlsStatus', async () => (isNodeRole(getDeviceConfig()?.device_role)
    ? { state: 'server' as const, code: serverSecurityCode(), error: null }
    : nodeTlsStatus()));
  // A489: the server's certificate changed (it was reinstalled) — a person trusts it again. A technician, or a manager
  // who may change settings; the next 60 s tick pins whatever certificate the server now hands out.
  handle('node:tlsRetrust', async () => {
    if (!getActiveSession() && !signedInCan('settings.business')) throw new Error('Only a technician or someone who manages the business settings can do that.');
    const was = securityCode(tillPin());
    forgetPinForRetrust();   // A503: nothing goes plain until a certificate is pinned again
    logLine('node', `A489: the branch server's certificate (security code ${was ?? 'none'}) was forgotten by a person — the next one it hands out is trusted`);
    return { ok: true };
  });
  // A501: the till's conversation with its branch server, channel by channel (Tech page › Branch sync): when each last
  // worked, its last error in the server's words, failures in a row; what this till still owes the server and what it
  // holds back from other tills; the server's version and branch. Read-only. A technician, or a manager who may change
  // settings — like the security row beside it.
  handle('node:syncHealth', async () => {
    if (!getActiveSession() && !signedInCan('settings.business')) throw new Error('Only a technician or someone who manages the business settings can see that.');
    const cfg = getDeviceConfig();
    if (!cfg?.node_url || isNodeRole(cfg.device_role)) return { role: isNodeRole(cfg?.device_role) ? 'server' as const : 'none' as const };
    const info = serverInfo();
    return {
      role: 'till' as const,
      url: cfg.node_url,
      channels: channelHealth(),
      backlog: nodeQueueDepth(),
      quarantine: peerQuarantineSummary(),
      server: info,
      tillProtocol: NODE_PROTOCOL,
      ...protocolVerdict(info),
      branch: { till: cfg.branch_id ?? null, server: info?.branch_id ?? null,
        mismatch: !!(info?.branch_id && cfg.branch_id && info.branch_id !== cfg.branch_id) },
      refusal: nodeRefusal(),
      heard: lastFollowLook(),
    };
  });
  // A534 (register A23): on a branch server, how far its distribution to the cloud is behind — what waits by table, the
  // oldest, the last push the cloud took, and the runbook line. Read-only; the same gate as Branch sync above.
  handle('node:distribution', async () => {
    if (!getActiveSession() && !signedInCan('settings.business')) throw new Error('Only a technician or someone who manages the business settings can see that.');
    const cfg = getDeviceConfig();
    if (!isNodeRole(cfg?.device_role)) return { role: 'not_server' as const };
    return { role: 'server' as const, ...distributionLag(getLocalDb(), Date.now(), cfg?.device_id ?? null) };
  });
  // A542: on a branch server, its copy of the branch's drawers (A535) — the last poll, the drawers held, the tills that
  // asked in the last hour, the push line, the fallback. Read-only; the same gate as the distribution row above.
  handle('node:drawersStatus', async () => {
    if (!getActiveSession() && !signedInCan('settings.business')) throw new Error('Only a technician or someone who manages the business settings can see that.');
    if (!isNodeRole(getDeviceConfig()?.device_role)) return { role: 'not_server' as const };
    return { role: 'server' as const, status: drawersStatus() };
  });
  // A501: "Retry failed records" — the rows the server refused (after five tries) go to it again, and the rows held back
  // from other tills are tried again now. Same gate as the row above.
  handle('node:retryFailed', async () => {
    const tech = getActiveSession();
    if (!tech && !signedInCan('settings.business')) throw new Error('Only a technician or someone who manages the business settings can do that.');
    const requeued = rearmFailedNodeRows();
    const released = rearmPeerQuarantine();
    const applied = retryPeerQuarantine().applied;
    if (tech) logTechAction('node.retryFailed', { requeued, released, applied });
    logLine('node', `A501: retry failed records — ${requeued} record(s) offered to the branch server again, ${released} held-back record(s) from other tills tried again (${applied} applied)`);
    void replicateToNode();
    return { requeued, released, applied };
  });
  handle('node:answerJoin', async (_event, payload) => {
    const { id, allow } = assertPayload<{ id: string; allow: boolean }>({ id: { t: 'string', min: 1 }, allow: { t: 'boolean' } }, payload);
    if (!isNodeRole(getDeviceConfig()?.device_role)) throw new Error('Only the branch server answers join requests.');
    // A490: adding a till to the branch is devices.approve (the cloud's Tills and devices), or a technician.
    if (!getActiveSession() && !signedInCan('devices.approve')) throw new Error('Only someone who approves points of sale (or a technician) can answer a POS asking to join.');
    const out = await answerJoin(id, allow, async () => {
      let res: Response;
      try { res = await tillFetch('/api/pos/join-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); }
      catch { throw new Error('The server needs the internet to add a POS — check the connection and press Allow again.'); }
      const d: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d?.error ?? `The cloud refused (HTTP ${res.status}).`);
      const cfg = getDeviceConfig();
      return { cloud_url: getCloudUrl(), business_id: String(d.businessId), branch_id: String(d.branchId),
        branch_name: d.branchName ?? null, code: String(d.code), node_secret: cfg?.node_secret || ensureNodeSecret() };
    });
    logLine('join', `${allow ? 'allowed' : 'refused'} a till asking to join (${id})`);
    return out;
  });

  handle('auth:getSession', async () => {
    const db = getLocalDb();
    const session = db.prepare(`SELECT * FROM session WHERE id=1`).get() as any;
    if (!session) return null;

    // Re-hydrate sync engine in case app was restarted. Credentials are wrapped
    // at rest (D5), so they come from the store rather than off the row.
    const sessTok = readSessionTokens();
    configureSyncEngine(getCloudUrl(), sessTok.token, sessTok.refreshToken);

    // A415: the session row names this till, never a person. A till that joined before A415 still held the owner's id
    // here — replaced by the till's own on its next start.
    const deviceId = getDeviceConfig()?.device_id ?? '';
    if (deviceId && session.user_id !== deviceId) db.prepare(`UPDATE session SET user_id=? WHERE id=1`).run(deviceId);

    return {
      till: { device_id: deviceId || null },
      business: {
        id: session.business_id,
        name: session.business_name,
        currency: session.currency,
        // From device_config, where login and every sync persist it. This was
        // omitted, so a restart rebuilt the session without a type, modeFlags
        // defaulted to 'retail', and the manager screen silently dropped Item
        // Mix and the restaurant overview — which read as "the update removed
        // a feature" when it was any restart at all.
        type: getDeviceConfig()?.business_type ?? null,
      },
    };
  });
}
