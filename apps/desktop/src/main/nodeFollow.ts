/**
 * nodeFollow.ts — A501: a till follows ITS OWN branch server to a new address, by itself — never another server.
 *
 * Owner, 2026-10-15 ("fix it once and for all"): a branch server whose address changed — the router handed it another IP
 * (DHCP), or 4100 was taken one morning and it bound 4101–4103 (nodeServer's port fallback) — left every till of the
 * branch talking to nobody until a technician typed the new address into each one. The server already announces itself
 * on the shop network (serverBeacon.ts, for "Find my server"); since A501 the announcement carries its certificate's
 * security code. When the till's server stops answering, the till listens for a few seconds; a server announcing the
 * SAME security code at another address is then PROVEN before anything changes:
 *   - its certificate is read and compared byte for byte with the one this till pinned (a code is 48 bits — the
 *     certificate itself is the proof), and
 *   - an encrypted /node/health, pinned to that certificate, must answer — and name the same server device id this till
 *     last saw (when it saw one).
 * Only then is node_url changed, and the outbox is NOT re-armed (the server holds what it held). A till that has not
 * pinned its server (an older server, plain HTTP) does not follow by itself: the beacon is all it would have, and that is
 * not proof — the Tech page says where the server was heard, for a person to confirm.
 */
import { getDeviceConfig, saveDeviceConfig, isNodeRole } from './deviceConfig';
import { tillPin, securityCode, readServerCert, certDer, pinnedFetch } from './lanTls';
import { listenForServers, type FoundServer } from './serverBeacon';
import { nodeHeaders } from './nodeClient';
import { adoptNodeTarget, nodeTargetKey } from './nodeIngest';
import { channelState, serverInfo, noteServerInfo } from './nodeHealth';
import { logLine } from './logFile';

/** How long the server must have been silent before the till looks for it elsewhere (failed health checks in a row). */
export const FOLLOW_AFTER_FAILURES = 2;
/** At most one look every two minutes — listening holds the beacon port for a few seconds. */
export const FOLLOW_EVERY_MS = 2 * 60_000;
const LISTEN_MS = 4000;

let lastLookAt = 0;
let lastHeard: { url: string; at: string; proven: boolean } | null = null;

const norm = (u: string | null | undefined) => String(u ?? '').replace(/\/+$/, '').toLowerCase();
const sameCert = (a: string | null, b: string | null) => {
  const x = certDer(a), y = certDer(b);
  return !!x && !!y && x.equals(y);
};

export interface FollowDeps {
  listen?: (ms: number) => Promise<FoundServer[]>;
  now?: number;
  force?: boolean;
}

/**
 * One look, when it is due: the server has failed its last health checks, this till pins it, and two minutes passed
 * since the last look. Returns what happened. Never throws.
 */
export async function followMovedServer(deps: FollowDeps = {}): Promise<{ outcome: 'followed' | 'not_heard' | 'not_due' | 'not_pinned' | 'none'; url?: string }> {
  try {
    const cfg = getDeviceConfig();
    if (!cfg?.node_url || isNodeRole(cfg.device_role)) return { outcome: 'none' };
    const now = deps.now ?? Date.now();
    if (!deps.force) {
      if (channelState('health').failures < FOLLOW_AFTER_FAILURES) return { outcome: 'not_due' };
      if (now - lastLookAt < FOLLOW_EVERY_MS) return { outcome: 'not_due' };
    }
    lastLookAt = now;
    const pin = tillPin();
    const code = securityCode(pin);
    const heard = await (deps.listen ?? listenForServers)(LISTEN_MS);
    const current = norm(cfg.node_url);
    const candidates = heard.filter((f) => norm(f.url) !== current && (!code || !f.fp || f.fp === code));
    if (!pin || !code) {
      // Not pinned: a beacon is not proof. Say where a server was heard (the Tech page shows it), change nothing.
      const any = candidates[0];
      if (any && norm(lastHeard?.url) !== norm(any.url)) logLine('node', `A501: a branch server was heard at ${any.url} while this till's (${cfg.node_url}) does not answer — this till's connection is not encrypted, so it does not follow by itself; if it is this branch's server, join it from the Tech page (Find my server)`);   // A503 (A502: no typed address)
      lastHeard = any ? { url: any.url, at: new Date(now).toISOString(), proven: false } : lastHeard;
      return { outcome: 'not_pinned' };
    }
    const knownDevice = serverInfo()?.device_id ?? null;
    for (const f of candidates.filter((c) => c.fp === code)) {
      // The certificate itself, byte for byte — the code only picked the candidate.
      const got = await readServerCert(f.url, 3000);
      if (!sameCert(got.cert, pin)) continue;
      try {
        const res = await pinnedFetch(`${f.url}/node/health`, { headers: nodeHeaders(), signal: AbortSignal.timeout(4000) }, pin);
        if (!res.ok) { await res.body?.cancel().catch(() => {}); continue; }
        const body: any = await res.json().catch(() => null);
        if (knownDevice && body?.device_id && body.device_id !== knownDevice) continue;   // the same certificate on another machine: never followed
        const before = cfg.node_url;
        saveDeviceConfig({ node_url: f.url });
        adoptNodeTarget(nodeTargetKey(f.url, cfg.node_secret));   // the same server — nothing is offered again
        noteServerInfo(body, now);
        lastHeard = { url: f.url, at: new Date(now).toISOString(), proven: true };
        logLine('node', `A501: the branch server moved from ${before} to ${f.url} — the same server (security code ${code}, proven over its encrypted connection); this till follows it`);
        return { outcome: 'followed', url: f.url };
      } catch { continue; }
    }
    return { outcome: 'not_heard' };
  } catch (e: any) {
    logLine('node', `A501: looking for the branch server at a new address failed: ${e?.message ?? e}`);
    return { outcome: 'none' };
  }
}

/** For the Tech page: where the server was last heard by a look (and whether this till followed it there). */
export function lastFollowLook(): { url: string; at: string; proven: boolean } | null { return lastHeard; }

/** Tests only. */
export function _resetFollow(): void { lastLookAt = 0; lastHeard = null; }
