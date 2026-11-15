/**
 * branchPin.ts — Till stage 3, Slice C (docs/SCOPE-TILL-STAGE-3.md, docs/BUILD-TILL-STAGE-3C.md).
 *
 * A person's PIN sign-in at a Shop POS that JOINED a branch server is checked by that server first, over its pinned TLS
 * (POST /node/verify-pin — apps/desktop nodeServer.ts, verdict from branchStaff.verifyPinAtNodeAsync). The branch
 * server's roster is the LAN authority: it is kept fresh on every catalogue pull and by relayed staff changes, so it is a
 * better answer than this tablet's own cached bcrypt verifiers — AND it works with no internet at either end, purely over
 * the shop LAN.
 *
 * Preference-with-fallback (owner, 2026-11-12) and the server's own rule (F7, nodeServer.ts): a 'no' from the server is
 * FINAL — a bad or ambiguous PIN (401) must NOT be re-tried against another authority. Anything else the server says — it
 * cannot prove which POS is asking or cannot read its roster (503), a throttle (429), a build with no such route (404), or
 * no answer at all — is transport-like: the caller falls back to the cloud (/auth/verify-pin, shop/pinSignIn.ts), then to
 * the Till-stage-2 offline bcrypt check (shop/offlinePin.ts).
 *
 * No JWT is minted here: the verified person's writes go under this POS's OWN till token (routed through the same server
 * by Slice A/B), carrying their cashier_id — exactly as the online path does. So the session this returns is tokenless,
 * like the Stage-2 offline session, but it is a CONFIRMED identity (the LAN authority said yes), not a provisional one
 * awaiting a reconnect upgrade.
 *
 * No native change (Slice A already had BranchServer.request return headers); it does NOT import cloud/client (that would
 * close the import cycle the build sheet warns of). The pure decision (readPinVerdict) is split out so it is tested
 * without a device.
 */
import { cashierSessionFrom } from './rules';
import { readServerLink, nodeRequest, type ServerLink, type NodeResponse } from './branchServer';
import { deviceId } from './tillSession';
import type { CashierSession } from './offlinePin';

/** Enough of the POS session to build a cashier session (what cashierSessionFrom reads). */
type Till = { branchId: string; branchName: string; businessType: string; currency: string };

/** The node's /node/verify-pin success payload (branchStaff.verifyPinAtNodeAsync): identity + permissions, no token. */
interface NodeStaff { staffId: string; name: string; roleName?: string | null; permissions?: Record<string, boolean> }

export type PinVerdict =
  | { outcome: 'session'; session: CashierSession }   // the server verified the PIN — use this person (till token carries writes)
  | { outcome: 'refused'; words: string }             // 401: a bad/ambiguous PIN — FINAL, do not fall back
  | { outcome: 'fallback' };                          // 503/429/404/no-answer/no-link: try the cloud, then the offline check

/**
 * Classify the branch server's /node/verify-pin answer (PURE). `r` is null when the request threw or the server did not
 * answer. Only a 401 is a final 'no'; every other non-200 is transport-like and falls back.
 */
export function readPinVerdict(r: NodeResponse | null, till: Till): PinVerdict {
  if (!r) return { outcome: 'fallback' };                         // no answer → cloud, then offline
  if (r.status === 200) {
    let body: { ok?: boolean; staff?: NodeStaff } | null = null;
    try { body = r.body ? JSON.parse(r.body) as { ok?: boolean; staff?: NodeStaff } : null; } catch { body = null; }
    const s = body?.ok ? body.staff : undefined;
    if (s && s.staffId && s.name) {
      const session = cashierSessionFrom(
        { staff: { id: s.staffId, name: s.name, role: s.roleName ?? null }, permissions: s.permissions ?? {} },
        till,
      );
      return { outcome: 'session', session };
    }
    return { outcome: 'fallback' };                                // a 200 we cannot use — be safe, fall back
  }
  if (r.status === 401) {                                          // bad or ambiguous PIN — the LAN authority said no
    let words = 'That PIN is not right.';
    try { const b = r.body ? JSON.parse(r.body) as { error?: string } : null; if (b?.error) words = String(b.error); } catch { /* keep the default */ }
    return { outcome: 'refused', words };
  }
  return { outcome: 'fallback' };                                  // 503 (can't prove us / no roster), 429, 404, 403, …
}

/** Dependencies, injected so verifyPinAtServer is tested without a device. */
export interface BranchPinDeps {
  link?: () => Promise<ServerLink | null>;
  request?: (link: ServerLink, body: string, headers: Record<string, string>) => Promise<NodeResponse | null>;
  device?: () => Promise<string>;
}

/**
 * Ask the joined branch server to verify this PIN. No ServerLink → {outcome:'fallback'} (a lone cloud POS is unchanged and
 * never pays a network round trip). The branch access code (X-Node-Secret) is added by nodeRequest; this POS proves which
 * it is with its device headers, as every /node/* call does.
 */
export async function verifyPinAtServer(pin: string, till: Till, deps: BranchPinDeps = {}): Promise<PinVerdict> {
  const getLink = deps.link ?? readServerLink;
  const link = await getLink();
  if (!link) return { outcome: 'fallback' };
  const getDevice = deps.device ?? deviceId;
  const headers = { 'x-device-id': await getDevice(), 'x-device-token': link.deviceToken };
  const body = JSON.stringify({ branch_id: till.branchId, pin });
  const send = deps.request ?? ((l: ServerLink, b: string, h: Record<string, string>) => nodeRequest(l, 'POST', '/node/verify-pin', b, h));
  const r = await send(link, body, headers);
  return readPinVerdict(r, till);
}
