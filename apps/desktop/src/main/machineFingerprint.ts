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
