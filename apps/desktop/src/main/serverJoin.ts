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

export const JOIN_TTL_MS = 10 * 60_000;
export const MAX_PENDING = 5;
const requests = new Map<string, JoinRequest>();

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, '').trim().slice(0, max) : '');

function sweep(now: number): void {
  for (const [id, r] of requests) if (now - r.at > JOIN_TTL_MS) requests.delete(id);
}

/** A till asks. Refused when the queue is full; a second ask from the same address replaces the first. */
export function createJoinRequest(body: any, ip: string, now: number = Date.now()):
  { ok: true; id: string; token: string } | { ok: false; status: number; error: string } {
  sweep(now);
  const device_id = clean(body?.device_id, 64);
  const name = clean(body?.name, 60) || 'New till';
  if (!device_id) return { ok: false, status: 400, error: 'device_id required' };
  for (const [id, r] of requests) if (r.ip === ip && r.status === 'pending') requests.delete(id);
  if ([...requests.values()].filter((r) => r.status === 'pending').length >= MAX_PENDING) {
    return { ok: false, status: 429, error: 'Too many tills are waiting to join — answer them on the server first.' };
  }
  const id = crypto.randomBytes(8).toString('hex');
  const token = crypto.randomBytes(24).toString('hex');
  requests.set(id, { id, token, device_id, name, ip, at: now, status: 'pending' });
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
  { status: Status | 'unknown'; grant?: JoinGrant } {
  sweep(now);
  const r = requests.get(String(id));
  if (!r || typeof token !== 'string' || token.length !== r.token.length
      || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(r.token))) return { status: 'unknown' };
  if (r.status === 'approved') { requests.delete(r.id); return { status: 'approved', grant: r.grant }; }
  if (r.status === 'denied') { requests.delete(r.id); return { status: 'denied' }; }
  return { status: 'pending' };
}

/**
 * The person at the server answers. On Allow, `issue` fetches the grant (the cloud's join code); if that fails the
 * request stays pending and the error goes back to the screen, so they can try again.
 */
export async function answerJoin(id: string, allow: boolean, issue: () => Promise<JoinGrant>): Promise<{ ok: true }> {
  const r = requests.get(String(id));
  if (!r || r.status !== 'pending') throw new Error('That request is no longer waiting — ask the till to search again.');
  if (!allow) { r.status = 'denied'; return { ok: true }; }
  r.grant = await issue();
  r.status = 'approved';
  return { ok: true };
}

/** Tests only. */
export function _resetJoins(): void { requests.clear(); }
