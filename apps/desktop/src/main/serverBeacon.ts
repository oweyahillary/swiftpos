/**
 * serverBeacon.ts — A427: the branch server announces itself on the shop network; a new install listens.
 *
 * Owner, 2026-10-09: "the server to broadcast in the network and the till or any installation to listen, if none
 * exist the tech gets the screen to select". The branch server sends a small UDP broadcast every few seconds; a till
 * being installed listens for a few seconds and lists every server it heard. Nothing secret travels in the beacon —
 * only the server's port and its name. Joining still needs someone at the server to allow it (serverJoin.ts).
 *
 * Windows: the installer opens UDP 4199 inbound on the PRIVATE network profile (build/installer.nsh), the same rule
 * as the server's TCP 4100-4103. A shop network Windows calls "Public" blocks both.
 */
import dgram from 'dgram';
import os from 'os';

export const BEACON_PORT = 4199;
export const BEACON_MAGIC = 'ZAPTILL-SERVER/1';
export const BEACON_EVERY_MS = 3000;

export interface BeaconInfo { port: number; business: string | null; server: string | null }
export interface FoundServer { url: string; ip: string; port: number; business: string | null; server: string | null }

export function buildBeacon(info: BeaconInfo): Buffer {
  return Buffer.from(JSON.stringify({ magic: BEACON_MAGIC, port: info.port, business: info.business, server: info.server }), 'utf8');
}

/** A beacon heard from `ip`, or null for anything that is not one of ours. Never trusts a port outside 1-65535. */
export function parseBeacon(buf: Buffer, ip: string): FoundServer | null {
  if (!buf || buf.length > 2048) return null;
  let b: any;
  try { b = JSON.parse(buf.toString('utf8')); } catch { return null; }
  if (!b || b.magic !== BEACON_MAGIC) return null;
  const port = Number(b.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) return null;
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : null);
  return { url: `http://${ip}:${port}`, ip, port, business: text(b.business), server: text(b.server) };
}

/** Where to send: every IPv4 network's own broadcast address, plus the all-networks one. */
export function broadcastAddresses(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  const out = new Set<string>(['255.255.255.255']);
  for (const list of Object.values(ifaces)) {
    for (const i of list ?? []) {
      if (i.family !== 'IPv4' || i.internal || !i.netmask) continue;
      const a = i.address.split('.').map(Number), m = i.netmask.split('.').map(Number);
      if (a.length !== 4 || m.length !== 4) continue;
      out.add(a.map((o, k) => (o & m[k]) | (~m[k] & 255)).join('.'));
    }
  }
  return [...out];
}

let sender: dgram.Socket | null = null;
let timer: NodeJS.Timeout | null = null;

/** Start announcing. `info` is read each time, so a name or port that changes is announced as it is now. */
export function startBeacon(info: () => BeaconInfo | null): void {
  if (sender) return;
  try {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    s.on('error', (e) => { console.warn('[beacon] ', e.message); });
    s.bind(0, () => {
      try { s.setBroadcast(true); } catch { /* some adapters refuse; the directed addresses may still work */ }
      const send = () => {
        const i = info(); if (!i) return;
        const msg = buildBeacon(i);
        for (const addr of broadcastAddresses()) s.send(msg, BEACON_PORT, addr, () => { /* best effort */ });
      };
      send();
      timer = setInterval(send, BEACON_EVERY_MS);
      timer.unref();
    });
    s.unref();
    sender = s;
  } catch (e: any) { console.warn('[beacon] could not start:', e?.message ?? e); }
}

export function stopBeacon(): void {
  if (timer) { clearInterval(timer); timer = null; }
  if (sender) { try { sender.close(); } catch { /* already closed */ } sender = null; }
}

/** Listen for `ms` and return every server heard, one entry per address. Never throws — none heard is []. */
export function listenForServers(ms = 6000): Promise<FoundServer[]> {
  return new Promise((resolve) => {
    const found = new Map<string, FoundServer>();
    let s: dgram.Socket;
    try { s = dgram.createSocket({ type: 'udp4', reuseAddr: true }); } catch { resolve([]); return; }
    const done = () => { try { s.close(); } catch { /* closed */ } resolve([...found.values()]); };
    s.on('message', (buf, rinfo) => { const f = parseBeacon(buf, rinfo.address); if (f) found.set(f.url, f); });
    s.on('error', () => done());
    try { s.bind(BEACON_PORT, () => { setTimeout(done, ms); }); } catch { done(); }
  });
}
