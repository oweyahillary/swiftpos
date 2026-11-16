/**
 * serverPresence.ts — Branch-server bind (migration 192). Is this tablet's OWN branch server on the LAN right now, and has
 * the owner disabled this tablet?
 *
 * A Shop POS enrols to a BRANCH (tillSession.joinWithCode — the bind is branch-level) and, when that branch runs a server,
 * its sales consolidate through it on the LAN (branchGateway.ts). But that routing is a preference, not a lock: carried to
 * another branch the tablet silently falls back to its own cloud and keeps selling — the implementation fee for that branch
 * escaped, unseen, because the tablet still reports ITS OWN branch_id (so deviceBinding.checkDeviceBranch, which is about a
 * CLAIMED branch, passes). This module turns that silent fallback into something the owner sees: on a cadence
 * (startPresenceMonitor) the tablet classifies whether its branch server is present and reports it to the cloud
 * (POST /api/pos/server-presence → FleetPage). Owner decision (keep-selling + kill-switch, not auto-block): this is
 * TELEMETRY ONLY — the tablet keeps selling regardless.
 *
 * The kill-switch (user_devices.disabled_at) is enforced server-side — every request from a disabled tablet is refused
 * 403 DEVICE_DISABLED — so it is instant and cannot be edited on the machine. This module also LEARNS it (a report that
 * comes back 403 DEVICE_DISABLED) so the tablet shows the right words (AwayNotice) and stops selling locally (offlineWrites).
 *
 * The classification is pure (classify) and the IO is injected (PresenceDeps), so it is tested without a device.
 */
import { BranchServer } from '../native/plugins';
import { readServerLink, findServers, updateServerLinkUrl, type ServerLink } from './branchServer';
import { CloudError, cloudPost } from '../cloud/client';
import { tillToken } from './tillSession';

export type PresenceState = 'home' | 'away_no_server' | 'away_foreign';

/** A server heard on the LAN beacon, with whether its certificate is THIS tablet's bound server. */
export interface HeardServer { url: string; business: string | null; server: string | null; certMatches: boolean }

export interface PresenceProbe { bound: boolean; ownReachable: boolean; heard: HeardServer[] }
export interface PresenceResult {
  state: PresenceState | null;
  seen: { business: string | null; server: string | null } | null;
  rebindUrl: string | null;
}

/**
 * Classify presence from a probe (pure).
 *   not bound to a server      → null (no away concept — a tablet with no branch server joined is untouched)
 *   own server reachable        → home
 *   own server heard elsewhere  → home, and rebindUrl names its new address (DHCP moved it on the same LAN)
 *   only other servers heard    → away_foreign (sitting at a branch that is not this tablet's)
 *   nothing heard               → away_no_server
 */
export function classify(p: PresenceProbe): PresenceResult {
  if (!p.bound) return { state: null, seen: null, rebindUrl: null };
  if (p.ownReachable) return { state: 'home', seen: null, rebindUrl: null };
  const mine = p.heard.find((h) => h.certMatches);
  if (mine) return { state: 'home', seen: null, rebindUrl: mine.url };
  if (p.heard.length > 0) {
    const h = p.heard[0];
    return { state: 'away_foreign', seen: { business: h.business, server: h.server }, rebindUrl: null };
  }
  return { state: 'away_no_server', seen: null, rebindUrl: null };
}

// ── The snapshot the banner + the sell-gate read ─────────────────────────────────────────────────────────────────────
export interface PresenceSnapshot {
  state: PresenceState | null;
  disabled: boolean;
  seen: { business: string | null; server: string | null } | null;
  at: number;
}
export const PRESENCE_EVENT = 'zaptill:server-presence';
let snap: PresenceSnapshot = { state: null, disabled: false, seen: null, at: 0 };

export function presence(): PresenceSnapshot { return snap; }
export function presenceState(): PresenceState | null { return snap.state; }
/** Branch-server bind: has the owner disabled this tablet? Read by the sell-gate (offlineWrites) and the banner (AwayNotice). */
export function isTabletDisabled(): boolean { return snap.disabled; }

function emit(): void {
  try { window.dispatchEvent(new CustomEvent<PresenceSnapshot>(PRESENCE_EVENT, { detail: snap })); } catch { /* no window in a test */ }
}
function set(next: Partial<PresenceSnapshot>): void {
  const merged: PresenceSnapshot = { ...snap, ...next, at: Date.now() };
  const same = merged.state === snap.state && merged.disabled === snap.disabled
    && (merged.seen?.business ?? null) === (snap.seen?.business ?? null)
    && (merged.seen?.server ?? null) === (snap.seen?.server ?? null);
  snap = merged;
  if (!same) emit();
}
/** The server refused a request with DEVICE_DISABLED — learn it at once (the hard block is already server-side). */
export function markDisabled(): void { if (!snap.disabled) set({ disabled: true }); }
/** Tests. */
export function _resetPresence(): void { snap = { state: null, disabled: false, seen: null, at: 0 }; }

// ── The IO, injected so checkPresence is tested without a device ──────────────────────────────────────────────────────
export interface PresenceDeps {
  readLink?: () => Promise<ServerLink | null>;
  reachOwn?: (link: ServerLink) => Promise<boolean>;
  scan?: (link: ServerLink) => Promise<HeardServer[]>;
  rebind?: (url: string) => Promise<void>;
  report?: (state: PresenceState, seen: PresenceResult['seen']) => Promise<void>;
}

async function reachOwnReal(link: ServerLink): Promise<boolean> {
  try {
    const r = await BranchServer.request({ url: `${link.url}/node/health`, method: 'GET', cert: link.cert, timeoutMs: 5000 });
    return r.status === 200;
  } catch { return false; }
}

async function scanReal(link: ServerLink): Promise<HeardServer[]> {
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

/** One presence check: classify, follow the server if it moved, update the snapshot, report to the cloud. Never throws. */
export async function checkPresence(deps: PresenceDeps = {}): Promise<PresenceState | null> {
  const readLink = deps.readLink ?? readServerLink;
  try {
    const link = await readLink();
    if (!link) { set({ state: null, seen: null }); return null; }
    const ownReachable = await (deps.reachOwn ?? reachOwnReal)(link);
    const heard = ownReachable ? [] : await (deps.scan ?? scanReal)(link);
    const r = classify({ bound: true, ownReachable, heard });
    if (r.rebindUrl) { try { await (deps.rebind ?? updateServerLinkUrl)(r.rebindUrl); } catch { /* keep the old url */ } }

    const prev = snap.state;
    set({ state: r.state, seen: r.seen });
    const report = deps.report ?? reportReal;
    // Report while away (keeps away_last_at fresh and sets away_since on the server), and once when it comes home (to clear
    // away_since). A steady 'home' says nothing new, so it is not re-sent every tick.
    if (r.state && r.state !== 'home') await report(r.state, r.seen);
    else if (r.state === 'home' && prev !== 'home') await report('home', null);
    return r.state;
  } catch { return snap.state; }
}

// ── The monitor: a check on open, on reconnect, and on a cadence while the Shop POS is mounted ────────────────────────
const CHECK_MS = 30_000;
/** Start reporting presence while the Shop POS is mounted. Returns a stop function. A no-op per tick when not bound. */
export function startPresenceMonitor(isOnline: () => boolean, deps: PresenceDeps = {}): () => void {
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
