/**
 * tillGates.ts — audit 2026-10-14: who may do three things in the till's MAIN process that only the screen used to check.
 *
 *   • a branch price (manager:setBranchPrice / clearBranchPrice) — A490: menu.prices (tillAccess signedInCan);
 *   • a forced shift close (shift:forceClose) — A490: shifts.force_close;
 *   • config:save — the bag the install screen writes. Before the till is configured it is the install flow and may write
 *     the till's identity (nobody can be signed in yet). Once configured, the identity (cloud address, branch, role,
 *     branch server address and code, terminal code) changes only with a technician console open — the Tech page has its
 *     own handlers that do so — and the money settings (VAT, levy, the discount ceiling, receipt text, 24-hour trading,
 *     kitchen exclusions) only for a person holding the key that sets each (A490: CONFIG_SETTING_KEY). The till's id
 *     never comes from the screen.
 *
 * A gate that only exists in the renderer is a suggestion: any code that reaches the bridge calls the handler directly.
 * Pure (no database, no electron), so test/till-gates.test.mjs runs these exact rules.
 */

// A490: who holds a key is tillAccess.ts (personKeys / signedInCan) — the till's ONE rule. personHolds, FORCE_CLOSE_KEYS
// and BRANCH_PRICE_KEYS (broad keys and an owner/admin role-name bypass) are gone: shift:forceClose asks
// shifts.force_close, a branch price menu.prices.

/** The till's identity — written by the install flow, and afterwards only from the technician console. */
export const CONFIG_IDENTITY_KEYS = ['deploy_mode', 'server_url', 'branch_id', 'device_role', 'node_url', 'node_secret',
  'terminal_code', 'configured', 'device_name', 'business_type'] as const;
/** The business's settings on this till (normally the cloud's pull writes them) — each by the fine key that sets it
 *  (A490): the money and trading rules settings.business, the receipt text receipt.manage, the kitchen exclusions
 *  stations.manage. */
export const CONFIG_SETTING_KEY: Readonly<Record<string, string>> = {
  vat_rate: 'settings.business', ctl_rate: 'settings.business', max_discount_pct: 'settings.business',
  continuous_operation: 'settings.business',
  receipt_header: 'receipt.manage', receipt_footer: 'receipt.manage',
  kitchen_exclusions: 'stations.manage', kitchen_exclusions_override: 'stations.manage',
};
export const CONFIG_SETTINGS_KEYS = Object.keys(CONFIG_SETTING_KEY) as readonly string[];

export interface ConfigSaveContext {
  /** device_config.configured — false during the first-run install. */
  configured: boolean;
  /** A technician console session is open (techService getActiveSession). */
  techSession: boolean;
  /** A490: does the signed-in person hold this fine key (tillAccess signedInCan)? Nobody signed in → false. */
  holds: (key: string) => boolean;
}

/** Why this config:save patch is refused, or null when it may be written. Keys left undefined are not a change. */
export function configSaveRefusal(patch: Record<string, unknown> | null | undefined, ctx: ConfigSaveContext): string | null {
  const keys = Object.keys(patch ?? {}).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
  for (const k of keys) {
    if ((CONFIG_IDENTITY_KEYS as readonly string[]).includes(k)) {
      if (!ctx.configured || ctx.techSession) continue;
      return 'This till’s set-up changes only from the technician console.';
    }
    const need = CONFIG_SETTING_KEY[k];
    if (need) {
      if (ctx.holds(need)) continue;
      return need === 'receipt.manage' ? 'Only someone who may change the receipt text can change that.'
        : need === 'stations.manage' ? 'Only someone who sets up printers and print stations can change that.'
        : 'Only someone who manages the business settings can change that.';
    }
    // device_id (the till's identity, minted once) and every read-only key the cloud's pull owns: never from the screen.
    return `That setting (${k}) cannot be changed here.`;
  }
  return null;
}
