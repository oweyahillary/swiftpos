/**
 * serverPresenceCore.ts — Branch-server bind (migration 192): the PURE core of the branch-server presence check.
 *
 * This file imports NOTHING (no native plugins, no cloud client) so it bundles and runs in a test without a device, exactly
 * like shop/printRetry.ts. The classification (classify), the shared snapshot the banner + sell-gate read, and the
 * orchestration (runPresence) live here; shop/serverPresence.ts supplies the real IO (the LAN probe, the beacon scan, the
 * cloud report) and the monitor. See serverPresence.ts for the why.
 */

export type PresenceState = 'home' | 'away_no_server' | 'away_foreign';

/** Just the fields the presence logic needs from a ServerLink (shop/branchServer.ts) — kept local so this file imports nothing. */
export interface ServerLinkLike { url: string; cert: string }

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

// ── The orchestration (pure — all IO injected) ───────────────────────────────────────────────────────────────────────
export interface PresenceDeps {
  readLink: () => Promise<ServerLinkLike | null>;
  reachOwn: (link: ServerLinkLike) => Promise<boolean>;
  scan: (link: ServerLinkLike) => Promise<HeardServer[]>;
  rebind: (url: string) => Promise<void>;
  report: (state: PresenceState, seen: PresenceResult['seen']) => Promise<void>;
}

/** One presence check: classify, follow the server if it moved, update the snapshot, report to the cloud. Never throws. */
export async function runPresence(deps: PresenceDeps): Promise<PresenceState | null> {
  try {
    const link = await deps.readLink();
    if (!link) { set({ state: null, seen: null }); return null; }
    const ownReachable = await deps.reachOwn(link);
    const heard = ownReachable ? [] : await deps.scan(link);
    const r = classify({ bound: true, ownReachable, heard });
    if (r.rebindUrl) { try { await deps.rebind(r.rebindUrl); } catch { /* keep the old url */ } }

    const prev = snap.state;
    set({ state: r.state, seen: r.seen });
    // Report while away (keeps away_last_at fresh and sets away_since on the server), and once when it comes home (to clear
    // away_since). A steady 'home' says nothing new, so it is not re-sent every tick.
    if (r.state && r.state !== 'home') await deps.report(r.state, r.seen);
    else if (r.state === 'home' && prev !== 'home') await deps.report('home', null);
    return r.state;
  } catch { return snap.state; }
}
