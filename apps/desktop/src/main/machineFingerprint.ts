// machineFingerprint.ts — A182.
//
// A reset/reinstalled till generates a brand-new device_id, so the cloud sees a
// NEW device and the operator re-names it by hand — often reusing "T1", which
// collides with the old till's order numbers on the cloud (register A181). A MAC
// address survives a reinstall, so binding it lets the cloud hand a reinstalled
// machine its OLD terminal code and name back instead of a blank slate.
//
// The MAC is a HINT for identity restoration, never an auth credential. It is not
// perfectly stable (a swapped NIC, USB-tethering, MAC randomisation), so the
// server treats a match as "probably the same machine — offer its old name", and
// device_id remains the hard key for everything else.

import os from 'os';
import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';   // A512: the guid and serial are read once and kept

export interface Nic { mac: string; internal: boolean; family: string }

const ZERO = '00:00:00:00:00:00';
// Adapters that are not the physical machine: virtualisation, tunnels, containers.
const VIRTUAL = /^(veth|docker|br-|virbr|vmnet|vboxnet|tun|tap|utun|llw|awdl|zt|wg)/i;

/**
 * Deterministically pick ONE stable MAC from a set of interfaces. Pure so it can
 * be tested without real hardware. Prefers a real, non-internal, non-virtual
 * adapter; ties are broken by the lowest MAC string so the SAME machine always
 * yields the SAME choice across reboots and reinstalls (the whole point).
 */
export function selectStableMac(nics: Record<string, Nic[]>): string | null {
  const candidates: string[] = [];
  for (const [name, addrs] of Object.entries(nics || {})) {
    if (VIRTUAL.test(name)) continue;
    for (const a of addrs || []) {
      const mac = String(a?.mac || '').toLowerCase();
      if (!a || a.internal) continue;
      if (!mac || mac === ZERO) continue;
      if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)) continue;
      candidates.push(mac);
    }
  }
  if (!candidates.length) return null;
  candidates.sort();               // deterministic tie-break
  return candidates[0];
}

/** The machine's stable MAC, or null if none can be read. Never throws. */
export function getMacAddress(): string | null {
  try { return selectStableMac(os.networkInterfaces() as unknown as Record<string, Nic[]>); }
  catch { return null; }
}

// Cached — the MAC does not change while the app runs, and reading it per request
// (every sync, every push) would be wasteful. Read once, lazily.
let _cached: string | null | undefined;
export function getMacAddressCached(): string | null {
  if (_cached === undefined) _cached = getMacAddress();
  return _cached;
}

// ── A477: the machine behind the till's key ──────────────────────────────────
//
// Owner, 2026-10-14: the key bound to the machine (MAC + serial) "to confirm that this till is in the system". Two
// identifiers that survive everything short of a new machine: the Windows MachineGuid (set at Windows install) and the
// BIOS serial. They are sent on enrolment, renewal, the renewal's ack and the device grant (X-Device-Guid /
// X-Device-Serial), HASHED here with SHA-256 — the raw values never leave the till. The cloud keeps the first ones it
// sees and refuses the till's key from a machine where neither matches (DEVICE_MISMATCH; the session is not revoked).
//
// Read once per run, in the background, each with a short time limit: startup never waits for them, and a renewal that
// runs before they are read simply sends none (the cloud lets it through, as for a till from before A477).


export interface MachineIdentity { mac: string | null; machine_guid: string | null; serial: string | null }

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The MachineGuid out of `reg query HKLM\SOFTWARE\Microsoft\Cryptography /v MachineGuid`. Pure. */
export function parseMachineGuid(regOutput: string | null | undefined): string | null {
  const m = /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(String(regOutput ?? ''));
  const v = m ? m[1].trim().toLowerCase() : '';
  return GUID.test(v) && !/^0{8}-/.test(v) ? v : null;
}

// What board makers leave in the serial field when they did not set one — the same on thousands of machines, so useless.
const SERIAL_PLACEHOLDERS = new Set([
  'to be filled by o.e.m.', 'to be filled by oem', 'default string', 'system serial number', 'not specified', 'not applicable',
  'none', 'n/a', 'na', 'unknown', 'invalid', 'oem', 'o.e.m.', 'serial', 'chassis serial number', 'base board serial number',
  '123456789', '1234567890', 'xxxxxxxx', 'empty', 'null',
]);

/** A BIOS serial worth binding to, or null (placeholders, all zeros, too short). Pure. */
export function cleanSerial(raw: string | null | undefined): string | null {
  const v = String(raw ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (v.length < 3 || v.length > 128) return null;
  if (SERIAL_PLACEHOLDERS.has(v.toLowerCase())) return null;
  if (/^[0\s.\-_]+$/.test(v) || /^(.)\1+$/.test(v)) return null;   // 0000…, FFFFFFFF, ……
  return v;
}

/** SHA-256 (hex) of an identifier, normalised. What the cloud sees — never the raw value. Pure. */
export function hashIdentifier(v: string): string {
  return crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');
}

const IDENTITY_TIMEOUT_MS = 5_000;

function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: IDENTITY_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 }, (err, stdout) => {
        resolve(err ? null : String(stdout ?? ''));
      });
    } catch { resolve(null); }
  });
}

let _identity: MachineIdentity | null = null;
let _identityLoading: Promise<MachineIdentity> | null = null;

/**
 * A512: the machine guid and BIOS serial never change, but reading them meant a `reg` and a PowerShell at every start —
 * PowerShell alone is what put ZapTill at "High" startup impact in Task Manager. Read once, kept in `cacheFile` (the
 * till's data folder); later starts read the file. A file that cannot be read or holds neither is simply read again.
 */
function readIdentityCache(cacheFile: string | undefined): { machine_guid: string | null; serial: string | null } | null {
  if (!cacheFile) return null;
  try {
    const v = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    const g = typeof v?.machine_guid === 'string' ? v.machine_guid : null;
    const s = typeof v?.serial === 'string' ? v.serial : null;
    return g || s ? { machine_guid: g, serial: s } : null;
  } catch { return null; }
}

/** Read the machine's identity (once per run; later calls get the same answer). Never throws, never waits > ~5 s. */
export function loadMachineIdentity(platform: string = process.platform, cacheFile?: string): Promise<MachineIdentity> {
  if (_identity) return Promise.resolve(_identity);
  if (_identityLoading) return _identityLoading;
  _identityLoading = (async () => {
    const mac = getMacAddressCached();
    if (platform !== 'win32') return (_identity = { mac, machine_guid: null, serial: null });
    const kept = readIdentityCache(cacheFile);   // A512
    if (kept) return (_identity = { mac, ...kept });
    const [reg, bios] = await Promise.all([
      // /reg:64 — a 32-bit process would otherwise be shown the WOW6432Node view, which has no MachineGuid.
      run('reg', ['query', 'HKLM\SOFTWARE\Microsoft\Cryptography', '/v', 'MachineGuid', '/reg:64']),
      run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_BIOS).SerialNumber']),
    ]);
    _identity = { mac, machine_guid: parseMachineGuid(reg), serial: cleanSerial(bios) };
    if (cacheFile && (_identity.machine_guid || _identity.serial)) {   // A512: kept for the next start
      try { fs.writeFileSync(cacheFile, JSON.stringify({ machine_guid: _identity.machine_guid, serial: _identity.serial })); } catch { /* read again next time */ }
    }
    return _identity;
  })().catch(() => (_identity = { mac: getMacAddressCached(), machine_guid: null, serial: null }));
  return _identityLoading;
}

/** What has been read so far (nulls until loadMachineIdentity has finished). Starts the read if it has not begun. */
export function machineIdentity(): MachineIdentity {
  if (!_identity && !_identityLoading) void loadMachineIdentity();
  return _identity ?? { mac: getMacAddressCached(), machine_guid: null, serial: null };
}

/** The headers that tell the cloud which machine this is: the MAC as A182, the guid and serial hashed. Pure. */
export function identityHeadersFor(id: MachineIdentity): Record<string, string> {
  const h: Record<string, string> = {};
  if (id.mac) h['X-Device-Mac'] = id.mac;
  if (id.machine_guid) h['X-Device-Guid'] = hashIdentifier(id.machine_guid);
  if (id.serial) h['X-Device-Serial'] = hashIdentifier(id.serial);
  return h;
}

/** The identity headers, waiting (bounded) for the first read. */
export async function identityHeaders(): Promise<Record<string, string>> {
  return identityHeadersFor(await loadMachineIdentity());
}

/** Test seam: forget the read (or set it). */
export function _setMachineIdentity(id: MachineIdentity | null): void { _identity = id; _identityLoading = null; }
