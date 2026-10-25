/**
 * updateShare.ts — A443: the branch server fetches an approved update ONCE and the branch's tills take it from the server.
 *
 * Owner, 2026-10-11: "can we do it this way a server pulls the update and shares it with the tills?" Since A410 a till
 * behind a branch server downloaded the installer THROUGH the server, live, under the gateway's 60-second limit — a
 * 205 MB installer on a shop line never finished, and every till started again from nothing an hour later.
 *
 * Now:
 *   - The server, on its own approval check (autoUpdate.ts), fetches the approved version's latest.yml and installer from
 *     the cloud into `<userData>/update-share/<version>/` — resuming a broken download where it stopped — and checks the
 *     installer against the sha512 and size in latest.yml before it is shared.
 *   - A till's request for that version's files (its usual feed, `/node/cloud/api/desktop-update/v/<v>/…`) is answered
 *     from the server's copy over the LAN. Nothing changes on the till, so tills already in the field take part.
 *   - Not ready yet → 503 (the till's updater logs it and asks again on its next check) and the server starts fetching.
 *     It never falls through to the live pass-through for the installer.
 *   - The server updates itself from the same copy (autoUpdate.ts routes its own feed through its own gateway).
 *   - Only the version the cloud approved: the server's fetch goes through the cloud's approval check, and a till's
 *     latest.yml is served only for the version the server holds. Every request is behind the branch access code.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type http from 'http';
import { GATEWAY_MARK } from './cloudGateway';
import { app } from 'electron';

/** Where the server keeps the shared copy. */
export function shareDir(): string { return path.join(app.getPath('userData'), 'update-share'); }

// A till asked for a version that is not ready: the update check (autoUpdate.ts) listens and fetches what is approved.
let wantedHook: ((version: string) => void) | null = null;
export function onShareWanted(cb: (version: string) => void): void { wantedHook = cb; }
export function shareWanted(version: string): void { try { wantedHook?.(version); } catch { /* never stops an answer */ } }

const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const SHARE_PATH = /^\/node\/cloud\/api\/desktop-update\/v\/([^/]+)\/([^/?]+)$/;

export interface LatestInfo { version: string; file: string; sha512: string; size: number }

/** latest.yml as electron-builder writes it → the installer it names. Pure. Null when it is not one. */
export function parseLatestYml(text: string): LatestInfo | null {
  const s = String(text ?? '');
  const version = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(s)?.[1] ?? '';
  const file = /^path:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(s)?.[1] ?? '';
  const sha512 = /^sha512:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(s)?.[1] ?? '';
  // The size sits on the files[] entry for that installer.
  const size = Number(/^\s+size:\s*(\d+)\s*$/m.exec(s)?.[1] ?? NaN);
  if (!VERSION_RE.test(version) || !FILE_RE.test(file) || !sha512 || !Number.isFinite(size) || size <= 0) return null;
  return { version, file, sha512, size };
}

/** A till's request for an update file through the gateway → the version and file it asks for. Pure. */
export function shareRequest(rawUrl: string): { version: string; file: string } | null {
  const m = SHARE_PATH.exec(String(rawUrl ?? '').split('?')[0]);
  if (!m) return null;
  const version = decodeURIComponent(m[1]), file = decodeURIComponent(m[2]);
  return VERSION_RE.test(version) && FILE_RE.test(file) ? { version, file } : null;
}

function readReady(dir: string, version: string): LatestInfo | null {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(dir, version, 'ready.json'), 'utf8')) as LatestInfo;
    if (info?.version !== version) return null;
    const st = fs.statSync(path.join(dir, version, info.file));
    return st.size === info.size ? info : null;
  } catch { return null; }
}

/** The version the server holds ready to share, or null. */
export function readyVersion(dir: string, version: string): LatestInfo | null {
  return VERSION_RE.test(version) ? readReady(dir, version) : null;
}

export interface ShareDeps {
  fetch: typeof fetch;
  dir: string;
  cloudUrl: () => string | null;
  token: () => string | null;
  refresh: () => Promise<boolean>;
  log?: (line: string) => void;
  /** No bytes for this long → the download is cut and resumed on the next attempt. */
  idleMs?: number;
}

async function sha512Of(file: string): Promise<string> {
  const h = crypto.createHash('sha512');
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve()).on('error', reject);
  });
  return h.digest('base64');
}

/** One authorised GET to the cloud's feed (a 401 refreshes the token once). */
async function feedGet(d: ShareDeps, url: string, extra: Record<string, string>, signal: AbortSignal): Promise<Response> {
  const go = (tok: string) => d.fetch(url, { headers: { Authorization: `Bearer ${tok}`, ...extra }, redirect: 'follow', signal } as RequestInit);
  let tok = d.token();
  if (!tok) throw new Error('not signed in to the cloud');
  let res = await go(tok);
  if (res.status === 401 && await d.refresh().catch(() => false) && (tok = d.token())) res = await go(tok);
  return res;
}

const busy = new Set<string>();

// ── A496: how the server's fetch of each version is going — told to its tills, shown on its screen ─────────────────
export interface ShareProgress {
  version: string; state: 'fetching' | 'failed' | 'ready'; failures: number; error: string | null;
  bytes: number; size: number | null; since: string; at: string;
}
const progress = new Map<string, ShareProgress>();
/** After this many failed fetches in a row of one version, the server passes its tills' requests for it on live. */
export const SHARE_STUCK_FAILURES = 3;
function track(version: string, patch: Partial<ShareProgress>): void {
  const now = new Date().toISOString();
  const p = progress.get(version) ?? { version, state: 'fetching' as const, failures: 0, error: null, bytes: 0, size: null, since: now, at: now };
  progress.set(version, { ...p, ...patch, at: now });
  if (progress.size > 5) progress.delete([...progress.keys()][0]);
}
/** The server's fetch of `version` (or the latest one tried), or null when it never tried. */
export function shareProgress(version?: string | null): ShareProgress | null {
  if (version) return progress.get(version) ?? null;
  const all = [...progress.values()];
  return all.length ? all[all.length - 1] : null;
}
/** The server could not fetch `version` (SHARE_STUCK_FAILURES in a row) and is not fetching it now. */
export function shareStuck(version: string): boolean {
  const p = progress.get(version);
  return !!p && !busy.has(version) && p.state === 'failed' && p.failures >= SHARE_STUCK_FAILURES;
}
/** Is a fetch of `version` running now? */
export function shareFetching(version: string): boolean { return busy.has(version); }

// A496: the version the cloud last approved for this business, as the server's own check heard it (undefined: not asked
// yet). A copy of any other version is never offered to the tills — after a roll-back, or once the business is on hold.
let approvedNow: string | null | undefined;
export function noteApprovedForShare(v: string | null): void { approvedNow = v && VERSION_RE.test(v) ? v : null; }
/** The version the server offers its tills: the approved one when it holds it (before its first check: its newest copy). */
export function offeredVersion(dir: string): string | null {
  if (approvedNow === undefined) return latestReady(dir);
  return approvedNow && readReady(dir, approvedNow) ? approvedNow : null;
}
/** Test seam. */
export function _resetShareState(): void { progress.clear(); busy.clear(); approvedNow = undefined; }

/**
 * Fetch `version` into the share folder: latest.yml, then the installer — resumed from the part already on disk — then
 * checked. 'ready' when it can be shared; 'busy' when a fetch for it is already running; 'failed' otherwise (tried again
 * on the next call). Never throws. Older versions are removed once this one is ready.
 */
export async function prepareShare(version: string, d: ShareDeps): Promise<'ready' | 'busy' | 'failed'> {
  if (!VERSION_RE.test(version)) return 'failed';
  if (readReady(d.dir, version)) { if (progress.get(version)?.state !== 'ready') track(version, { state: 'ready', failures: 0, error: null }); return 'ready'; }
  if (busy.has(version)) return 'busy';
  const cloud = String(d.cloudUrl() ?? '').replace(/\/+$/, '');
  if (!cloud) { track(version, { state: 'failed', failures: (progress.get(version)?.failures ?? 0) + 1, error: 'no cloud address' }); return 'failed'; }
  busy.add(version);
  track(version, { state: 'fetching' });
  let outcome: 'ready' | 'failed' = 'failed';
  let why: string | null = null;
  const vdir = path.join(d.dir, version);
  const feed = `${cloud}/api/desktop-update/v/${version}/`;
  const ac = new AbortController();
  const idleMs = d.idleMs ?? 60_000;
  let idle: NodeJS.Timeout | null = null;
  const poke = () => { if (idle) clearTimeout(idle); idle = setTimeout(() => ac.abort(), idleMs); };
  try {
    fs.mkdirSync(vdir, { recursive: true });
    poke();
    const ymlRes = await feedGet(d, `${feed}latest.yml`, {}, ac.signal);
    if (!ymlRes.ok) { why = `latest.yml: HTTP ${ymlRes.status}`; d.log?.(`update share: latest.yml for ${version} — HTTP ${ymlRes.status}`); return 'failed'; }
    const ymlText = await ymlRes.text();
    const info = parseLatestYml(ymlText);
    if (!info || info.version !== version) { why = 'latest.yml does not describe it'; d.log?.(`update share: latest.yml for ${version} does not describe it`); return 'failed'; }
    track(version, { size: info.size });
    fs.writeFileSync(path.join(vdir, 'latest.yml'), ymlText);

    const part = path.join(vdir, `${info.file}.part`);
    let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
    if (have > info.size) { fs.rmSync(part, { force: true }); have = 0; }
    if (have < info.size) {
      poke();
      const res = await feedGet(d, `${feed}${encodeURIComponent(info.file)}`, have ? { Range: `bytes=${have}-` } : {}, ac.signal);
      if (!(res.status === 206 || res.status === 200) || !res.body) { why = `${info.file}: HTTP ${res.status}`; d.log?.(`update share: ${info.file} — HTTP ${res.status}`); return 'failed'; }
      if (res.status === 200 && have) { have = 0; }                 // the far end ignored the Range: start the part again
      const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
      try {
        const reader = (res.body as any).getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          poke();
          have += value.length;
          track(version, { bytes: have });
          if (!out.write(Buffer.from(value))) await new Promise<void>((r) => out.once('drain', () => r()));
        }
      } finally {
        await new Promise<void>((r) => out.end(() => r()));
      }
    }
    const got = fs.statSync(part).size;
    if (got !== info.size) { why = `${got} of ${info.size} bytes`; d.log?.(`update share: ${info.file} has ${got} of ${info.size} bytes — resumes next time`); return 'failed'; }
    if (await sha512Of(part) !== info.sha512) {
      fs.rmSync(part, { force: true });
      why = 'the download did not match its sha512';
      d.log?.(`update share: ${info.file} did not match its sha512 — discarded`);
      return 'failed';
    }
    fs.renameSync(part, path.join(vdir, info.file));
    fs.writeFileSync(path.join(vdir, 'ready.json'), JSON.stringify(info));
    for (const other of fs.readdirSync(d.dir)) {
      if (other !== version) { try { fs.rmSync(path.join(d.dir, other), { recursive: true, force: true }); } catch { /* next time */ } }
    }
    d.log?.(`update share: ${version} ready for the branch's points of sale`);
    outcome = 'ready';
    return 'ready';
  } catch (e: any) {
    why = e?.name === 'AbortError' ? 'no data for a while' : String(e?.message ?? e);
    d.log?.(`update share: ${version} interrupted (${e?.name === 'AbortError' ? 'no data for a while' : e?.message ?? e}) — resumes next time`);
    return 'failed';
  } finally {
    if (idle) clearTimeout(idle);
    busy.delete(version);
    track(version, outcome === 'ready' ? { state: 'ready', failures: 0, error: null }
      : { state: 'failed', failures: (progress.get(version)?.failures ?? 0) + 1, error: why });
  }
}

/**
 * The branch server's answer to a till's update request, from its shared copy. True when answered here; false when the
 * request is not one this serves (anything but GET/HEAD of a version's latest.yml or installer) and the gateway should
 * forward it as before. `wanted` is told the version a till asked for that is not ready, so the server fetches it.
 */
export function serveSharedUpdate(req: http.IncomingMessage, res: http.ServerResponse, dir: string,
  wanted: (version: string) => void): boolean {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return false;
  const ask = shareRequest(req.url ?? '');
  if (!ask) return false;
  if (ask.file.endsWith('.blockmap')) return false;                // small; the cloud answers it as before
  const info = readReady(dir, ask.version);
  if (!info || (ask.file !== 'latest.yml' && ask.file !== info.file)) {
    // A496: the server could not fetch this version (SHARE_STUCK_FAILURES in a row), or a till that has waited long
    // enough asks for it live (X-Update-Live) while no fetch is running — passed on to the cloud through the gateway
    // (which cuts only on silence since A443) instead of "not ready" for ever.
    const liveAsked = String(req.headers['x-update-live'] ?? '') === '1';
    if (!info && !busy.has(ask.version) && (shareStuck(ask.version) || liveAsked)) {
      wanted(ask.version);
      return false;
    }
    wanted(ask.version);
    const body = JSON.stringify({ error: 'The branch server is still fetching this update. The POS will ask again shortly.' });
    res.writeHead(503, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Retry-After': '600', [GATEWAY_MARK]: '1' });
    res.end(body);
    return true;
  }
  const file = path.join(dir, ask.version, ask.file);
  const size = fs.statSync(file).size;
  res.writeHead(200, {
    'Content-Type': ask.file === 'latest.yml' ? 'text/yaml' : 'application/octet-stream',
    'Content-Length': String(size), [GATEWAY_MARK]: '1', 'X-Update-Share': '1',
  });
  if (method === 'HEAD') { res.end(); return true; }
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  return true;
}

// ── A443: the server tells its tills, and knows what each runs ──────────────────
// Owner, 2026-10-11: "make the server update tills like hey here is the new version please ensure all of us are having
// it; if the till is off and comes online it can request from the server, or the server asks which version it's running".
// Every till behind the server asks it every 2 minutes (and when it starts or comes back online): "I run 1.0.5 — is
// there a newer one?" (GET /node/update/ready). The server answers with the version it holds ready and remembers each
// till's version, so the server's screen lists which tills are up to date. A till told of a newer version checks with
// the cloud at once (approval) and downloads it from the server — instead of waiting for its hourly check.

const compare = (a: string, b: string) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  return 0;
};

/** The newest version the server holds ready to share, or null. */
export function latestReady(dir: string): string | null {
  let best: string | null = null;
  try {
    for (const v of fs.readdirSync(dir)) {
      if (VERSION_RE.test(v) && readReady(dir, v) && (!best || compare(v, best) > 0)) best = v;
    }
  } catch { /* no folder yet */ }
  return best;
}

export interface TillVersion { deviceId: string; name: string | null; version: string; seenAt: string }
const tills = new Map<string, TillVersion>();

/** A till said which version it runs (its regular question to the server). */
export function noteTillVersion(deviceId: string, name: string | null, version: string, now = new Date()): void {
  if (!deviceId || !VERSION_RE.test(version)) return;
  tills.set(deviceId, { deviceId, name: name?.trim() || null, version, seenAt: now.toISOString() });
}

/** Every till that has asked, newest first, with whether it runs `target` (the server's ready version or its own). */
export function tillVersions(target: string | null): Array<TillVersion & { current: boolean }> {
  return [...tills.values()]
    .sort((a, b) => b.seenAt.localeCompare(a.seenAt))
    .map((t) => ({ ...t, current: !target || compare(t.version, target) >= 0 }));
}

/** The server's answer to a till's question (pure): the version to have, and whether this till should fetch it now. */
export function readyAnswer(ready: string | null, tillVersion: string): { version: string | null; newer: boolean } {
  return { version: ready, newer: !!ready && VERSION_RE.test(tillVersion) && compare(ready, tillVersion) > 0 };
}

/** Test seam: forget every till. */
export function _resetTills(): void { tills.clear(); }
