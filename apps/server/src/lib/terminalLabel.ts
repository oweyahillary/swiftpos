// terminalLabel.ts — what a till is CALLED in the cloud (user_devices.device_label).
//
// Pure (no Supabase import) so the rule runs in a test, like deviceRestore.ts.
//
// A273 follow-up (2026-09-26): the web POS lists a branch's tills by this label so
// a cashier can pick which till they are covering. Until now no till ever sent its
// name — every row fell back to the generic "SwiftPOS till" and the picker showed
// the same made-up name for every till. The till now sends the name typed at setup
// (`device_name`) on enrolment and on every cashier sign-in, and — owner decision
// 2026-09-26 — **the setup name always wins**: it overwrites the cloud label each
// time, including a rename made in Settings → Devices.

/** The labels the cloud invents when a till reports no name (0.6.37: "ZapTill till" — the first three). The web POS hides them. */
export const GENERIC_TERMINAL_LABELS = [
  'ZapTill till',
  'ZapTill till (branch server)',
  'ZapTill office server (view only)',
  // 0.6.37: the names given before the rename — tills already stored under them are still recognised (and hidden).
  'SwiftPOS till',
  'SwiftPOS till (branch server)',
  'SwiftPOS office server (view only)',
] as const;

/** A name as the till reported it, made safe to store: trimmed, spaces collapsed, ≤ 64 chars, '' → null. */
export function cleanLabel(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).replace(/\s+/g, ' ').trim().slice(0, 64);
  return s ? s : null;
}

/** The label a NEW row gets: the till's own name, else a generic one by role. */
export function labelFor(role: string | null, given?: unknown): string {
  const name = cleanLabel(given);
  if (name) return name;
  switch (role) {
    case 'office': return GENERIC_TERMINAL_LABELS[2];
    case 'node':   return GENERIC_TERMINAL_LABELS[1];
    default:       return GENERIC_TERMINAL_LABELS[0];
  }
}

/**
 * A343 (2026-09-27): the name of a branch's WEB till — the web POS's own register when a cashier starts their own shift on the
 * web instead of joining a till's. Owner: "this can be called branchname_web_till". Its drawer is the branch's existing
 * `web:<branchId>` session (lib/terminalKey.ts).
 */
export function webTillName(branchName: string | null | undefined): string {
  const b = cleanLabel(branchName ?? '');
  return b ? `${b} Web Till` : 'Web Till';
}
