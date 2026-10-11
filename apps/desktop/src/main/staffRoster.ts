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
import { unpackRosterSnapshot } from './rosterSnapshot';
import { logLine } from './logFile';

export interface RosterDeps {
  /** GET a cloud path with this till's sign-in (through the branch server on a till behind one). */
  cloudGet: (path: string) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;
  /** The branch server's copy (a till behind one), or null. */
  nodeSnapshot: () => Promise<any | null>;
  store: (branchId: string, roster: BranchStaffRow[]) => void;
  /** After a CLOUD list only: drop saved sign-ins no longer on it (removed, or PIN changed). */
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
  try {
    const snap = await d.nodeSnapshot();
    if (snap) {
      const dec = unpackRosterSnapshot(snap);
      if (dec.apply) {
        d.store(dec.branchId, dec.roster as unknown as BranchStaffRow[]);
        const changed = dec.roster.length !== lastCount;
        lastCount = dec.roster.length; lastAt = new Date().toISOString();
        if (changed) d.log?.(`staff list from the branch server: ${dec.roster.length} (${why}; cloud: ${cloudError})`);
        return { source: 'node', changed, count: dec.roster.length };
      }
    }
  } catch { /* keep the list this till holds */ }
  return { source: 'none', changed: false, count: null, error: cloudError };
}

/** When this till last refreshed its staff list, and how many it holds (for the Tech page and the log). */
export function rosterState(): { at: string | null; count: number | null; version: string } {
  return { at: lastAt, count: lastCount < 0 ? null : lastCount, version };
}

/** Test seam. */
export function _resetRoster(): void { version = ''; lastCount = -1; lastAt = null; inFlight = null; again = null; }

// ── The real wiring (main process) ───────────────────────────────────────────

let realDeps: RosterDeps | null = null;
/** syncEngine hands in its signed-in cloud GET (it owns the tokens, the refresh and the gateway). */
export function configureStaffRoster(cloudGet: RosterDeps['cloudGet']): void {
  realDeps = {
    cloudGet,
    nodeSnapshot: () => (hasNode() ? fetchRosterFromNode() : Promise.resolve(null)),
    store: storeBranchStaff,
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
    await fetch(`${base}/node/roster/refresh`, { method: 'POST', headers: nodeHeaders(), signal: AbortSignal.timeout(4000) });
  } catch { /* the server pulls on its own within 10 s */ }
}

let timer: NodeJS.Timeout | null = null;
/** Every 10 s on a branch server, 20 s on any other till; once now. */
export function startStaffRosterTimer(): void {
  if (timer) return;
  const every = isNodeRole(getDeviceConfig()?.device_role ?? null) ? 10_000 : 20_000;
  void refreshStaffRosterNow('start');
  timer = setInterval(() => { void refreshStaffRosterNow('timer'); }, every);
}
