// deviceRestore.ts — A182. Pure identity-restoration logic (no DB import), so it
// can be unit-tested in isolation. deviceRegistry.ts does the Supabase I/O and
// delegates the DECISION to pickPriorTerminal here.

export interface PriorTerminal {
  terminal_code: string | null;
  device_label:  string | null;
  device_id:     string;
  last_seen_at:  string | null;
}

export const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;

export function isMac(v: unknown): boolean {
  return typeof v === 'string' && MAC_RE.test(v.toLowerCase().trim());
}

/**
 * Choose which prior device's identity to offer a reinstalled machine. Rules:
 * only a DIFFERENT device_id (the same one is not a "reinstall"); it must have
 * something to restore (a code or a label); most recently seen wins. Null when
 * there is nothing to offer.
 */
export function pickPriorTerminal(rows: PriorTerminal[] | undefined, currentDeviceId: string): PriorTerminal | null {
  const others = (rows || [])
    .filter(r => r && r.device_id && r.device_id !== currentDeviceId)
    .filter(r => (r.terminal_code && String(r.terminal_code).trim()) || (r.device_label && String(r.device_label).trim()));
  if (!others.length) return null;
  others.sort((a, b) => String(b.last_seen_at ?? '').localeCompare(String(a.last_seen_at ?? '')));
  return others[0];
}
