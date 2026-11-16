/**
 * serverPresence.ts — Branch-server bind (migration 192). Is this tablet's OWN branch server on the LAN right now, and has
 * the owner disabled this tablet?
 *
 * A Shop POS enrols to a BRANCH (tillSession.joinWithCode — the bind is branch-level) and, when that branch runs a server,
 * its sales consolidate through it on the LAN (branchGateway.ts). But that routing is a preference, not a lock: carried to
 * another branch the tablet silently falls back to its own cloud and keeps selling — the implementation fee for that branch
 * escaped, unseen, because the tablet still reports ITS OWN branch_id (so deviceBinding.checkDeviceBranch, which is about a
 * CLAIMED branch, passes). On a cadence (startPresenceMonitor) the tablet classifies whether its branch server is present
 * and reports it to the cloud (POST /api/pos/server-presence → FleetPage). Owner decision (keep-selling + kill-switch, not
 * auto-block): this is TELEMETRY ONLY — the tablet keeps selling regardless.
 *
 * The kill-switch (user_devices.disabled_at) is enforced server-side — every request from a disabled tablet is refused
 * 403 DEVICE_DISABLED — so it is instant and cannot be edited on the machine. This module also LEARNS it (a report that
 * comes back 403 DEVICE_DISABLED) so the tablet shows the right words (AwayNotice) and stops selling locally (offlineWrites).
 *
 * The pure classification, the shared snapshot and the orchestration live in serverPresenceCore.ts (import-free, so it is
 * tested without a device). This file is only the real IO (the LAN probe, the beacon scan, the cloud report) and the monitor.
 */
import { BranchServer } from '../native/plugins';
import { readServerLink, findServers, updateServerLinkUrl } from './branchServer';
import { CloudError, cloudPost } from '../cloud/client';
import { tillToken } from './tillSession';
import { runPresence, markDisabled, type PresenceDeps, type PresenceState, type PresenceResult, type ServerLinkLike, type HeardServer } from './serverPresenceCore';

// Re-export the pieces the Shop POS, the banner and the sell-gate read, so they import from one place.
export {
  PRESENCE_EVENT, presence, presenceState, isTabletDisabled, markDisabled, classify, runPresence, _resetPresence,
} from './serverPresenceCore';
export type { PresenceState, PresenceSnapshot, HeardServer, PresenceProbe, PresenceResult, PresenceDeps, ServerLinkLike } from './serverPresenceCore';

async function reachOwnReal(link: ServerLinkLike): Promise<boolean> {
  try {
    const r = await BranchServer.request({ url: `${link.url}/node/health`, method: 'GET', cert: link.cert, timeoutMs: 5000 });
    return r.status === 200;
  } catch { return false; }
}

async function scanReal(link: ServerLinkLike): Promise<HeardServer[]> {
  const found = await findServers(4000).catch(() => []);
  const heard: HeardServer[] = [];
  for (const s of found) {
    let certMatches = false;
    try { const c = await BranchServer.readCert({ url: s.url }); certMatches = !!c?.cert && c.cert === link.cert; }
    catch { certMatches = false; }
    heard.push({ url: s.url, business: s.business, server: s.server, certMatches });
  }
  return heard;
}

async function reportReal(state: PresenceState, seen: PresenceResult['seen']): Promise<void> {
  try {
    const { token } = await tillToken();
    await cloudPost('/pos/server-presence', { state, seen }, token);
  } catch (e) {
    if (e instanceof CloudError && e.code === 'DEVICE_DISABLED') { markDisabled(); return; }
    // Telemetry is best-effort; any other failure (offline, a transient 5xx, a token renewal) is ignored and retried next tick.
  }
}

/** One presence check with the real IO (or injected deps, for tests). Never throws. */
export async function checkPresence(deps: Partial<PresenceDeps> = {}): Promise<PresenceState | null> {
  return runPresence({
    readLink: deps.readLink ?? readServerLink,
    reachOwn: deps.reachOwn ?? reachOwnReal,
    scan: deps.scan ?? scanReal,
    rebind: deps.rebind ?? updateServerLinkUrl,
    report: deps.report ?? reportReal,
  });
}

// ── The monitor: a check on open, on reconnect, and on a cadence while the Shop POS is mounted ────────────────────────
const CHECK_MS = 30_000;
/** Start reporting presence while the Shop POS is mounted. Returns a stop function. A no-op per tick when not bound. */
export function startPresenceMonitor(isOnline: () => boolean, deps: Partial<PresenceDeps> = {}): () => void {
  let live = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async (): Promise<void> => {
    if (!live) return;
    if (isOnline()) await checkPresence(deps);
    if (!live) return;
    timer = setTimeout(() => { void tick(); }, CHECK_MS);
  };
  const back = (): void => { if (!live) return; clearTimeout(timer); void tick(); };
  try { window.addEventListener('online', back); } catch { /* no window in a test */ }
  void tick();
  return () => { live = false; clearTimeout(timer); try { window.removeEventListener('online', back); } catch { /* */ } };
}
