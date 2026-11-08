/**
 * branchServer.ts — the branch server on the shop network, for a Shop POS (Till stage 1, docs/ANDROID-APP-DESIGN.md §4.3,
 * §11). Owner, 2026-11-05: ZapTill recommends a dedicated branch server (backups, easier printing), but a tablet works
 * without one — "build both".
 *
 * JOINING THROUGH IT — the desktop's A427 flow as it is, done by a technician:
 *   1. listen for the server's beacon (UDP 4199) and list what was heard;
 *   2. read the server's certificate (public) and show its SECURITY CODE — the server's screen shows the same one (A489);
 *   3. POST /node/join over TLS pinned to that certificate; someone at the server presses Allow (nothing else opens it);
 *   4. collect the answer once (/node/join/status): one ordinary enrolment code for the branch, the branch access code and
 *      this POS's device key there;
 *   5. enrol with the code at THIS app's cloud (a grant naming another cloud is refused — the desktop's A494 check).
 * A server too old to have a certificate is not joined: nothing secret ever crosses the shop network in plain HTTP.
 *
 * PRINTING THROUGH IT: POST /node/print with the branch access code and the device key, like every /node/* call a POS
 * makes; the server prints with its own stations, printers and spool (apps/desktop nodePrintRelay.ts). Selling still goes
 * to the cloud directly in stage 1 — selling through the server is Till stage 3.
 */
import { API_URL } from '../config';
import { readSecret, saveSecret, removeSecret } from '../device/secrets';
import { BranchServer } from '../native/plugins';
import { joinWithCode, deviceId, type PosSession } from './tillSession';
import { sameCloud, serversHeard, serverPrintResult, type FoundServer } from './rules';

/** What the POS keeps about the server it joined through (Keystore: 'branch.server'). */
export interface ServerLink { url: string; cert: string; securityCode: string; name: string; nodeSecret: string; deviceToken: string }

export async function readServerLink(): Promise<ServerLink | null> {
  const raw = await readSecret('branch.server');
  if (!raw) return null;
  try { return JSON.parse(raw) as ServerLink; } catch { return null; }
}

export async function forgetServerLink(): Promise<void> { await removeSecret('branch.server'); }

/** Listen for a few seconds; [] when none answered (most clients today — the technician then enters the code). */
export async function findServers(ms = 6000): Promise<FoundServer[]> {
  try { return serversHeard((await BranchServer.listen({ ms })).heard); } catch { return []; }
}

export class JoinStopped extends Error {}

/** Step 2: the server's certificate and security code, or why it cannot be joined. */
export async function serverIdentity(s: FoundServer): Promise<{ cert: string; code: string }> {
  const r = await BranchServer.readCert({ url: s.url }).catch(() => null);
  if (!r) throw new JoinStopped(`The branch server at ${s.ip} did not answer. Check it is on, then search again.`);
  if (r.old || !r.cert || !r.code) throw new JoinStopped('That branch server must be updated before a tablet joins through it. Update it, or enter the enrolment code from ZapTill instead.');
  return { cert: r.cert, code: r.code };
}

async function pinned<T>(link: { url: string; cert: string }, method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T | null }> {
  const r = await BranchServer.request({ url: `${link.url}${path}`, method, cert: link.cert, headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  let parsed: T | null = null;
  try { parsed = r.body ? JSON.parse(r.body) as T : null; } catch { parsed = null; }
  return { status: r.status, body: parsed };
}

interface JoinGrant { cloud_url: string; business_id: string; branch_id: string; branch_name: string | null; code: string; node_secret: string; device_token?: string }

/** Steps 3-5. `onWaiting` is told once the request is waiting for Allow at the server. Throws JoinStopped with words. */
export async function joinThroughServer(s: FoundServer, id: { cert: string; code: string }, posName: string, appVersion: string,
  onWaiting: () => void, stillWanted: () => boolean): Promise<PosSession> {
  const link = { url: s.url, cert: id.cert };
  const ask = await pinned<{ id?: string; token?: string; error?: string }>(link, 'POST', '/node/join', { device_id: await deviceId(), name: posName })
    .catch(() => { throw new JoinStopped(`The branch server at ${s.ip} did not answer.`); });
  if (ask.status !== 202 || !ask.body?.id || !ask.body.token) throw new JoinStopped(ask.body?.error || 'The branch server refused the request.');
  onWaiting();
  const status = `/node/join/status?id=${encodeURIComponent(ask.body.id)}&token=${encodeURIComponent(ask.body.token)}`;
  const until = Date.now() + 10 * 60_000;   // a request lives 10 minutes at the server (serverJoin.ts JOIN_TTL_MS)
  while (Date.now() < until) {
    if (!stillWanted()) throw new JoinStopped('Joining was cancelled.');
    await new Promise((r) => setTimeout(r, 3000));
    const r = await pinned<{ status?: string; grant?: JoinGrant }>(link, 'GET', status).catch(() => null);
    const st = r?.body?.status;
    if (st === 'denied') throw new JoinStopped('The request was denied at the branch server.');
    if (st === 'unknown') throw new JoinStopped('The request ran out at the branch server. Search again and ask again.');
    if (st !== 'approved' || !r?.body?.grant) continue;
    return enrolFromGrant(r.body.grant, s, id, posName, appVersion);
  }
  throw new JoinStopped('Nobody pressed Allow at the branch server within 10 minutes. Search again and ask again.');
}

async function enrolFromGrant(g: JoinGrant, s: FoundServer, id: { cert: string; code: string }, posName: string, appVersion: string): Promise<PosSession> {
  if (!sameCloud(g.cloud_url, API_URL)) throw new JoinStopped('That branch server belongs to another ZapTill cloud. This POS was not joined.');
  const till = await joinWithCode({ businessId: g.business_id, code: g.code, posName, appVersion });
  await saveSecret('branch.server', JSON.stringify({
    url: s.url, cert: id.cert, securityCode: id.code, name: s.server || s.business || 'Branch server',
    nodeSecret: g.node_secret, deviceToken: g.device_token ?? '',
  } satisfies ServerLink));
  return till;
}

/**
 * Print one job through the branch server. null = no server joined, or it did not answer — the caller prints directly.
 * A server with another certificate is never sent the ticket (it is not the server this POS joined).
 */
export async function printThroughServer(job: string, order: Record<string, unknown>, onProblem: (words: string) => void) {
  const link = await readServerLink();
  if (!link) return null;
  try {
    const r = await pinned<{ ok?: boolean; skipped?: string[]; failed?: string[]; problem?: string | null }>(link, 'POST', '/node/print', { job, order }, {
      'X-Node-Secret': link.nodeSecret, 'x-device-id': await deviceId(), 'x-device-token': link.deviceToken,
    });
    const out = serverPrintResult(r.status, r.body);
    if (out.problem) onProblem(out.problem);
    // Not printed there at all (a server on a desktop version without /node/print, printing off there, this POS's key
    // refused, the server starting): the tablet prints directly instead. A 200 that names a station it could not print is
    // counted as it is — the stations that did print are never printed twice.
    if (r.status !== 200) return null;
    return out;
  } catch (e) {
    if ((e as { code?: string })?.code === 'IDENTITY_CHANGED') {
      onProblem("The branch server's identity changed — tickets print directly until a technician joins this POS to it again.");
    }
    return null;
  }
}
