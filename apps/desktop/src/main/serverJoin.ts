/**
 * serverJoin.ts — A427: a till asks the branch server to join; someone at the server allows it or not.
 *
 * Owner, 2026-10-09: "it should only ask if i allow it to join the server or not". A till being installed sends a join
 * request to the server it heard (serverBeacon.ts). The server shows "<name> (<address>) wants to join" with Allow and
 * Deny. On Allow the server asks the cloud for one ordinary enrolment code for its branch (POST /api/pos/join-code) and
 * keeps the answer for that till: the cloud address, the business and branch, the code, and this server's access
 * code. The till collects it once, with the private token it got when it asked, and enrols itself.
 *
 * Kept in memory: a request lives 10 minutes, at most 5 wait at once, one per address; a server restart forgets them.
 * P3 (2026-10-14): the person at the server is told of a request at most once a minute per address and at most
 * MAX_NOTICES_PER_MINUTE times a minute in all — asking again and again from one machine replaced its request
 * silently but raised a fresh Windows notification (and brought the window forward) every time.
 * F7: an allowed till's grant carries its own device key (nodeServer issues it; `device_id` says for whom).
 */
import crypto from 'crypto';

export interface JoinGrant {
  cloud_url: string; business_id: string; branch_id: string; branch_name: string | null;
  code: string; node_secret: string;
}
type Status = 'pending' | 'approved' | 'denied';
interface JoinRequest {
  id: string; token: string; device_id: string; name: string; ip: string; at: number;
  status: Status; grant?: JoinGrant;
}

// ── A503: a till already joined here may ask again — when it proves it is that till ───────────────────────────────────
// A496 refused a join from any device holding a key here, "until the server forgets it". Scenario audit, 2026-10-15:
// that broke (1) the A436 rejoin of a signed-out till through its OWN server (the sign-in-code screen's "Join through the
// branch server" — it holds a key, it keeps polling, so "Forget this till" is never even offered: a dead end), and (2) a
// new till whose grant answer was lost on the way (or whose enrolment failed after it): the key was recorded, the till
// never got it, and every later ask was 409 — with the till on no list to forget it from. Now a keyed device may ask
// again when either
//   - its key here was issued by a join and has never been used (the till never received it), or
//   - the request carries X-Join-Proof: an HMAC over (device id, THIS server's security code) keyed by the hash of the
//     key it holds. The key itself never leaves the till, and a proof made for another server (a different certificate)
//     is worthless here. The person at the server still presses Allow; the grant then replaces the key.
// Anything else stays refused (409), as A496 meant: a stranger naming a working till's id cannot ask to replace its key.
export const JOIN_PROOF_HEADER = 'x-join-proof';
/** The proof, from the key's SHA-256 (hex) — the form the server keeps. Pure. */
export function joinProofFromHash(keyHashHex: string, deviceId: string, serverCode: string | null): string {
  return crypto.createHmac('sha256', String(keyHashHex)).update(`zaptill-join|${String(deviceId)}|${serverCode ?? ''}`).digest('hex');
}
/** The proof a till makes from the key it holds. Pure. */
export function joinProofFor(token: string, deviceId: string, serverCode: string | null): string {
  return joinProofFromHash(crypto.createHash('sha256').update(String(token), 'utf8').digest('hex'), deviceId, serverCode);
}

export const JOIN_TTL_MS = 10 * 60_000;
export const MAX_PENDING = 5;
export const MAX_NOTICES_PER_MINUTE = 3;
const requests = new Map<string, JoinRequest>();
/** When each address last raised a notice, and every notice in the last minute. */
const noticedAt = new Map<string, number>();
let notices: number[] = [];

/** P3: may this request raise a notice at the server? Once a minute per address; a few a minute in all. */
function mayNotify(ip: string, now: number): boolean {
  notices = notices.filter((t) => now - t < 60_000);
  if (now - (noticedAt.get(ip) ?? -Infinity) < 60_000) return false;
  if (notices.length >= MAX_NOTICES_PER_MINUTE) return false;
  noticedAt.set(ip, now);
  notices.push(now);
  if (noticedAt.size > 200) for (const [k, t] of noticedAt) if (now - t >= 60_000) noticedAt.delete(k);
  return true;
}

/** A436: told of every new request, so the server can bring its window forward and raise a Windows notification —
 *  in server mode the window is usually hidden in the tray, and an unseen request runs out. Kept free of Electron. */
type JoinListener = (r: { name: string; ip: string }) => void;
let joinListener: JoinListener | null = null;
export function onJoinAsked(fn: JoinListener | null): void { joinListener = fn; }

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, '').trim().slice(0, max) : '');

function sweep(now: number): void {
  for (const [id, r] of requests) if (now - r.at > JOIN_TTL_MS) requests.delete(id);
}

/**
 * A till asks. Refused when the queue is full; a second ask from the same address replaces the first.
 * A496: one request per device too (a second ask for the same device, from anywhere, replaces the first); an allowed
 * request not collected yet still counts toward the cap; and a device that already holds a key on this server is
 * refused until the person at the server forgets it (a join would silently replace a working till's key).
 */
export function createJoinRequest(body: any, ip: string, now: number = Date.now(), opts: { holdsKey?: (deviceId: string) => boolean } = {}):
  { ok: true; id: string; token: string } | { ok: false; status: number; error: string } {
  sweep(now);
  const device_id = clean(body?.device_id, 64);
  const name = clean(body?.name, 60) || 'New POS';
  if (!device_id) return { ok: false, status: 400, error: 'device_id required' };
  if (opts.holdsKey?.(device_id)) {
    // A521: the button is "Revoke this till" now (it was "Forget this till"; "Hide from Close Branch" keeps the key).
    return { ok: false, status: 409, error: 'This POS is already joined to this branch server. To join it again, revoke it at the server first (Close Branch → Show points of sale → Revoke this POS), then join it from here.' };
  }
  for (const [id, r] of requests) if ((r.ip === ip || r.device_id === device_id) && r.status === 'pending') requests.delete(id);
  if ([...requests.values()].filter((r) => r.status !== 'denied').length >= MAX_PENDING) {
    return { ok: false, status: 429, error: 'Too many points of sale are waiting to join — answer them on the server first.' };
  }
  const id = crypto.randomBytes(8).toString('hex');
  const token = crypto.randomBytes(24).toString('hex');
  requests.set(id, { id, token, device_id, name, ip, at: now, status: 'pending' });
  // The request is listed either way (the screen shows it); only the pop-up is capped.
  if (mayNotify(ip, now)) { try { joinListener?.({ name, ip }); } catch { /* a notice failing never refuses the till */ } }
  return { ok: true, id, token };
}

/** What the server's screen shows. */
export function pendingJoins(now: number = Date.now()): Array<{ id: string; name: string; ip: string; at: string }> {
  sweep(now);
  return [...requests.values()].filter((r) => r.status === 'pending')
    .map((r) => ({ id: r.id, name: r.name, ip: r.ip, at: new Date(r.at).toISOString() }));
}

/** The till polls. The grant goes out ONCE, to the holder of the request's token, and the request is then gone. */
export function readJoin(id: string, token: string, now: number = Date.now()):
  { status: Status | 'unknown'; grant?: JoinGrant; device_id?: string } {
  sweep(now);
  const r = requests.get(String(id));
  if (!r || typeof token !== 'string' || token.length !== r.token.length
      || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(r.token))) return { status: 'unknown' };
  // device_id: which till the grant is for (nodeServer issues its device key; it is not sent on as is).
  if (r.status === 'approved') { requests.delete(r.id); return { status: 'approved', grant: r.grant, device_id: r.device_id }; }
  if (r.status === 'denied') { requests.delete(r.id); return { status: 'denied' }; }
  return { status: 'pending' };
}

/**
 * The person at the server answers. On Allow, `issue` fetches the grant (the cloud's join code); if that fails the
 * request stays pending and the error goes back to the screen, so they can try again.
 */
export async function answerJoin(id: string, allow: boolean, issue: () => Promise<JoinGrant>): Promise<{ ok: true }> {
  const r = requests.get(String(id));
  if (!r || r.status !== 'pending') throw new Error('That request is no longer waiting — ask the POS to search again.');
  if (!allow) { r.status = 'denied'; return { ok: true }; }
  r.grant = await issue();
  r.status = 'approved';
  return { ok: true };
}

/** Tests only. */
export function _resetJoins(): void { requests.clear(); noticedAt.clear(); notices = []; }
