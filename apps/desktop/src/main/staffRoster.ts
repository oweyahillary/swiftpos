/**
 * staffRoster.ts — A446: every till keeps its own copy of its branch's staff list (names, roles, permissions, bcrypt
 * PIN hashes — wrapped with safeStorage, branchStaff.ts), refreshed every few seconds and AT ONCE when staff change.
 *
 * Owner, 2026-10-11: "the till should save cashiers pin instant when created on the local server or the cloud server no
 * delay — right now its 20 min and i am still getting an error; each till should keep a local copy of all staff pin
 * related to that branch". Before: only the branch server held the list, refreshed after a menu pull; a till behind it
 * asked the server, and the server's "no" was final — a new cashier (or a changed PIN) was "not recognised" until the
 * server's list caught up, and a server the cloud had not bound to a branch never got the list at all.
 *
 * Now:
 *   - Every till asks the cloud for its branch's list (GET /api/pos/branch-staff?v=<the version it holds>): the branch
 *     server every 10 s, any other till every 20 s; "unchanged" costs nothing to store. A till behind a branch server goes
 *     through it (A410); if the cloud cannot be reached it takes the server's copy instead (/node/roster).
 *   - A staff member created or changed on this till → this till pulls at once and tells its branch server to pull at
 *     once (POST /node/roster/refresh), so the branch has it within seconds.
 *   - The PIN check (ipcHandlers auth:verifyPin) asks the cloud whenever it can be reached, whatever the server or this
 *     copy say; the copy decides only offline — and a PIN this copy does not know triggers a pull.
 * Never wipes the list on an empty or failed answer (a till must not lock its own staff out).
 */
import { getDeviceConfig, isNodeRole } from './deviceConfig';
import { storeBranchStaff, pruneSavedSignIns, type BranchStaffRow } from './branchStaff';
import { fetchRosterFromNode, hasNode, nodeUrl, nodeHeaders } from './nodeClient';
import { lanFetch } from './lanTls';   // A489
import { unpackRosterSnapshot } from './rosterSnapshot';
import { logLine } from './logFile';

export interface RosterDeps {
  /** GET a cloud path with this till's sign-in (through the branch server on a till behind one). */
  cloudGet: (path: string) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;
  /** The branch server's copy (a till behind one), or null. */
  nodeSnapshot: () => Promise<any | null>;
  store: (branchId: string, roster: BranchStaffRow[]) => void;
  /** After a list (the cloud's, or A496: the server's): drop saved sign-ins no longer on it (removed, inactive, or PIN changed). */
  prune?: (branchId: string, roster: BranchStaffRow[]) => void;
  log?: (line: string) => void;
}

let version = '';
let lastCount = -1;
let lastAt: string | null = null;
let inFlight: Promise<RosterPull> | null = null;

export interface RosterPull { source: 'cloud' | 'node' | 'none'; changed: boolean; count: number | null; error?: string }

/** One pull: the cloud first, the branch server's copy when the cloud cannot be reached. Single-flight. Never throws. */
export function pullStaffRoster(d: RosterDeps, why = 'timer'): Promise<RosterPull> {
  // A pull asked for while one is running gets ONE more pull after it: the running one may have read the cloud before
  // the change that prompted this ask (a cashier created a moment ago), and joining it would keep the old list.
  if (inFlight) {
    if (!again) again = inFlight.then(() => { again = null; return pullStaffRoster(d, why); });
    return again;
  }
  inFlight = doPull(d, why).finally(() => { inFlight = null; });
  return inFlight;
}
let again: Promise<RosterPull> | null = null;

async function doPull(d: RosterDeps, why: string): Promise<RosterPull> {
  let cloudError = '';
  // A531: a till behind a branch server whose changes come from it (liveSync 'peer') asks the SERVER's copy first — it
  // never asks the cloud for the roster while the server answers (owner: "only the server does the communication to cloud").
  if (live.preferNode()) {
    const fromNode = await nodePull(d, why, 'change-triggered');
    if (fromNode) return fromNode;
  }
  try {
    const res = await d.cloudGet(`/api/pos/branch-staff${version ? `?v=${encodeURIComponent(version)}` : ''}`);
    if (res.ok) {
      const body = await res.json();
      if (body?.unchanged) { lastAt = new Date().toISOString(); return { source: 'cloud', changed: false, count: lastCount }; }
      const staff = Array.isArray(body?.staff) ? body.staff as BranchStaffRow[] : null;
      const branchId = String(body?.branch_id ?? '');
      if (staff && branchId && staff.length) {
        d.store(branchId, staff);
        d.prune?.(branchId, staff);
        const changed = staff.length !== lastCount || version !== String(body.version ?? '');
        version = String(body.version ?? '');
        if (changed) d.log?.(`staff list from the cloud: ${staff.length} (${why})`);
        lastCount = staff.length; lastAt = new Date().toISOString();
        return { source: 'cloud', changed, count: staff.length };
      }
      cloudError = 'the cloud sent no staff';
    } else {
      const body = await res.json().catch(() => ({}));
      cloudError = `HTTP ${res.status}${body?.error ? ` — ${body.error}` : ''}`;
    }
  } catch (e: any) {
    cloudError = e?.message ?? 'unreachable';
  }
  // The cloud could not say: the branch server's copy (a till behind one).
  return (await nodePull(d, why, `cloud: ${cloudError}`)) ?? { source: 'none', changed: false, count: null, error: cloudError };
}

/** The branch server's copy, stored when it is a list (null: none, or not a list). */
async function nodePull(d: RosterDeps, why: string, note: string): Promise<RosterPull | null> {
  try {
    const snap = await d.nodeSnapshot();
    if (snap) {
      const dec = unpackRosterSnapshot(snap);
      if (dec.apply) {
        d.store(dec.branchId, dec.roster as unknown as BranchStaffRow[]);
        // A496: saved sign-ins follow the server's list too (a person removed, deactivated or with a new PIN there) —
        // only the cloud's list pruned them, so a till that never reached the cloud kept them for ever.
        d.prune?.(dec.branchId, dec.roster as unknown as BranchStaffRow[]);
        const changed = dec.roster.length !== lastCount;
        lastCount = dec.roster.length; lastAt = new Date().toISOString();
        if (changed) d.log?.(`staff list from the branch server: ${dec.roster.length} (${why}; ${note})`);
        return { source: 'node', changed, count: dec.roster.length };
      }
    }
  } catch { /* keep the list this till holds */ }
  return null;
}

// ── A531: change-triggered sync (liveSync.ts) ────────────────────────────────────────────────────────────────────────
/** With a change log a staff change arrives as its own row — the timer re-reads the whole list only every 30 minutes. */
export const ROSTER_SAFETY_MS = 30 * 60_000;
const live = { quiet: () => false, preferNode: () => false };
let lastTimerPull = 0;
/** liveSync hands in: is change-triggered sync on (quiet), and does this till take its changes from a branch server. */
export function setRosterLive(h: { quiet: () => boolean; preferNode: () => boolean } | null): void {
  live.quiet = h?.quiet ?? (() => false);
  live.preferNode = h?.preferNode ?? (() => false);
}
/** The timer's beat: every beat as before, or (change-triggered) every ROSTER_SAFETY_MS. Exported for the tests. */
export function rosterBeatDue(now = Date.now()): boolean {
  let quiet = false;
  try { quiet = live.quiet(); } catch { quiet = false; }
  if (quiet && lastTimerPull && now - lastTimerPull < ROSTER_SAFETY_MS) return false;
  lastTimerPull = now;
  return true;
}

/** When this till last refreshed its staff list, and how many it holds (for the Tech page and the log). */
export function rosterState(): { at: string | null; count: number | null; version: string } {
  return { at: lastAt, count: lastCount < 0 ? null : lastCount, version };
}

/** Test seam. */
export function _resetRoster(): void { version = ''; lastCount = -1; lastAt = null; inFlight = null; again = null; lastTimerPull = 0; }

// ── The real wiring (main process) ───────────────────────────────────────────

let realDeps: RosterDeps | null = null;
/** syncEngine hands in its signed-in cloud GET (it owns the tokens, the refresh and the gateway). */
export function configureStaffRoster(cloudGet: RosterDeps['cloudGet']): void {
  realDeps = {
    cloudGet,
    nodeSnapshot: () => (hasNode() ? fetchRosterFromNode() : Promise.resolve(null)),
    // A448: a cashier added or a PIN set on this till that the cloud has not taken yet stays over the list just stored —
    // storeBranchStaff lays them back itself now (P3), on every path that stores a list.
    store: (b, r) => { storeBranchStaff(b, r); },
    prune: (b, r) => { pruneSavedSignIns(b, r); },
    log: (line) => logLine('staff', line),
  };
}

/** Pull now (a staff change here, a PIN this till did not know, start-up). Safe to call any time. */
export function refreshStaffRosterNow(why: string): Promise<RosterPull> {
  if (!realDeps) return Promise.resolve({ source: 'none', changed: false, count: null, error: 'not configured' });
  return pullStaffRoster(realDeps, why);
}

/** A staff change on this till: pull now, and tell the branch server to pull now (so its other tills have it). */
export async function staffChangedHere(): Promise<void> {
  await refreshStaffRosterNow('staff changed on this till');
  const base = hasNode() ? nodeUrl() : null;
  if (!base) return;
  try {
    await lanFetch(`${base}/node/roster/refresh`, { method: 'POST', headers: nodeHeaders(), signal: AbortSignal.timeout(4000) });
  } catch { /* the server pulls on its own within 10 s */ }
}

let timer: NodeJS.Timeout | null = null;
/** Every 10 s on a branch server, 20 s on any other till; once now (A513: not when the start-up sequence just pulled it). */
export function startStaffRosterTimer(pullNow = true): void {
  if (timer) return;
  const every = isNodeRole(getDeviceConfig()?.device_role ?? null) ? 10_000 : 20_000;
  if (pullNow) void refreshStaffRosterNow('start');
  timer = setInterval(() => { if (rosterBeatDue()) void refreshStaffRosterNow('timer'); }, every);
}
