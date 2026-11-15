/**
 * branchRefresh.ts — Till stage 3, Slice D (docs/SCOPE-TILL-STAGE-3.md, docs/BUILD-TILL-STAGE-3D.md).
 *
 * When this Shop POS has JOINED a branch server, its SESSION RENEWAL (A477: /auth/refresh, then /auth/refresh/ack) goes
 * THROUGH that server (POST /node/refresh[/ack], over the server's pinned TLS) instead of straight to the cloud, like
 * every other cloud call in Till stage 3. The server proxies the renewal to the cloud's /api/auth/refresh[/ack],
 * forwarding this POS's OWN X-Device-* headers (its id, its machine, a lost device secret) — but NEVER X-Device-Token,
 * which is the key for THIS server, not the cloud's (F7, apps/desktop nodeServer.ts). So the cloud still checks THIS POS's
 * machine, exactly as if the POS had called direct.
 *
 * Preference-with-fallback (A410): any status the CLOUD itself gave, forwarded by the server, is used as-is — a 200 with
 * new tokens, or a 401 with which the cloud refuses the renewal. Only a transport-like problem — the server did not answer
 * (null), is on a build with no such route (404), or told us it cannot reach the cloud (503) — returns {via:'fallback'},
 * and tillSession renews cloud-direct instead. Because a forwarded 401 is the cloud's own, tillSession's existing
 * 401 → device-secret sign-back-in (A407) still fires exactly as on the direct path.
 *
 * Imports branchServer ONLY. It does NOT import cloud/client or tillSession: tillSession receives refreshViaServer through
 * a SETTER (setServerRefresh), never a static import, so there is no cloud/client → … → tillSession → branchRefresh cycle.
 */
import { readServerLink, nodeRequest, type ServerLink, type NodeResponse } from './branchServer';

export type RefreshPath = '/node/refresh' | '/node/refresh/ack';

export type ServerRefreshResult =
  | { via: 'answer'; status: number; data: unknown }   // the cloud's own forwarded answer — use as-is (200 tokens, or a 401 refusal)
  | { via: 'fallback' };                                // no server / old build / server can't reach the cloud → renew cloud-direct

/**
 * Classify the branch server's /node/refresh[/ack] answer (PURE). `r` is null when the request threw or the server did not
 * answer. A 404 (a build without the route) and a 503 (the node told us it cannot reach the cloud) are transport-like →
 * fallback. Every other status is the cloud's own forwarded answer, used as-is (a 200 with new tokens, or a 401 refusal).
 */
export function readRefreshResult(r: NodeResponse | null): ServerRefreshResult {
  if (!r) return { via: 'fallback' };
  if (r.status === 404 || r.status === 503) return { via: 'fallback' };
  let data: unknown = {};
  try { data = r.body ? JSON.parse(r.body) : {}; } catch { data = {}; }
  return { via: 'answer', status: r.status, data };
}

/** Dependencies, injected so refreshViaServer is tested without a device. */
export interface BranchRefreshDeps {
  link?: () => Promise<ServerLink | null>;
  request?: (link: ServerLink, path: RefreshPath, body: string, headers: Record<string, string>) => Promise<NodeResponse | null>;
}

/**
 * Renew the POS's session through the joined branch server. No ServerLink → {via:'fallback'} (a lone cloud POS renews
 * direct, unchanged, and never pays a round trip). The branch access code (X-Node-Secret) is added by nodeRequest; we add
 * ONLY x-device-id — never x-device-token (F7: that proves this POS to THIS server; it is not the cloud's).
 */
export async function refreshViaServer(path: RefreshPath, refreshToken: string, deviceId: string,
  deps: BranchRefreshDeps = {}): Promise<ServerRefreshResult> {
  const getLink = deps.link ?? readServerLink;
  const link = await getLink();
  if (!link) return { via: 'fallback' };
  const body = JSON.stringify({ refreshToken });
  const headers = { 'x-device-id': deviceId };
  const send = deps.request ?? ((l: ServerLink, p: RefreshPath, b: string, h: Record<string, string>) => nodeRequest(l, 'POST', p, b, h));
  const r = await send(link, path, body, headers);
  return readRefreshResult(r);
}
