/**
 * tillGates.ts — audit 2026-10-14: who may do three things in the till's MAIN process that only the screen used to check.
 *
 *   • a branch price (manager:setBranchPrice / clearBranchPrice) — products.manage, as the cloud's /api/branch-prices
 *     route requires, or a manager by the till's own rule (dayService isManager);
 *   • a forced shift close (shift:forceClose) — shifts.force_close or settings.manage (or '*', or the owner / admin);
 *   • config:save — the bag the install screen writes. Before the till is configured it is the install flow and may write
 *     the till's identity (nobody can be signed in yet). Once configured, the identity (cloud address, branch, role,
 *     branch server address and code, terminal code) changes only with a technician console open — the Tech page has its
 *     own handlers that do so — and the money settings (VAT, levy, the discount ceiling, receipt text, 24-hour trading,
 *     kitchen exclusions) only for a person holding settings.manage. The till's id never comes from the screen.
 *
 * A gate that only exists in the renderer is a suggestion: any code that reaches the bridge calls the handler directly.
 * Pure (no database, no electron), so test/till-gates.test.mjs runs these exact rules.
 */

/** Does the signed-in person (role name + staff_session.permissions JSON) hold any of `keys`? The owner/admin always do. */
export function personHolds(roleName: string | null | undefined, permissionsJson: string | null | undefined, keys: string[]): boolean {
  if (['owner', 'admin'].includes(String(roleName ?? '').trim().toLowerCase())) return true;
  let p: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(permissionsJson || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) p = parsed as Record<string, unknown>;
  } catch { /* malformed permissions grant nothing */ }
  return p['*'] === true || keys.some((k) => p[k] === true);
}

export const FORCE_CLOSE_KEYS = ['shifts.force_close', 'settings.manage'];
export const BRANCH_PRICE_KEYS = ['products.manage'];

/** The till's identity — written by the install flow, and afterwards only from the technician console. */
export const CONFIG_IDENTITY_KEYS = ['deploy_mode', 'server_url', 'branch_id', 'device_role', 'node_url', 'node_secret',
  'terminal_code', 'configured', 'device_name', 'business_type'] as const;
/** The business's settings on this till — only a settings.manage holder (normally the cloud's pull writes them). */
export const CONFIG_SETTINGS_KEYS = ['vat_rate', 'ctl_rate', 'max_discount_pct', 'receipt_header', 'receipt_footer',
  'continuous_operation', 'kitchen_exclusions', 'kitchen_exclusions_override'] as const;

export interface ConfigSaveContext {
  /** device_config.configured — false during the first-run install. */
  configured: boolean;
  /** A technician console session is open (techService getActiveSession). */
  techSession: boolean;
  /** The signed-in person holds settings.manage (or '*', or is the owner / admin). */
  settingsManager: boolean;
}

/** Why this config:save patch is refused, or null when it may be written. Keys left undefined are not a change. */
export function configSaveRefusal(patch: Record<string, unknown> | null | undefined, ctx: ConfigSaveContext): string | null {
  const keys = Object.keys(patch ?? {}).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
  for (const k of keys) {
    if ((CONFIG_IDENTITY_KEYS as readonly string[]).includes(k)) {
      if (!ctx.configured || ctx.techSession) continue;
      return 'This till’s set-up changes only from the technician console.';
    }
    if ((CONFIG_SETTINGS_KEYS as readonly string[]).includes(k)) {
      if (ctx.settingsManager) continue;
      return 'Only someone who manages the business settings can change that.';
    }
    // device_id (the till's identity, minted once) and every read-only key the cloud's pull owns: never from the screen.
    return `That setting (${k}) cannot be changed here.`;
  }
  return null;
}
