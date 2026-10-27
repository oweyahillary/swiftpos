// Device configuration — the single runtime source of truth for this terminal.
//
// Before Phase 0a the server URL was a compile-time constant
// (process.env.VITE_SERVER_URL), so one build could only ever talk to one
// server. That made the online/offline distinction impossible: a "local"
// install and a "cloud" install needed different binaries.
//
// Now the URL (and the device's mode / bound branch / business type) live in a
// singleton row in SQLite, written once at first-run install and read at the
// point of use. One installer serves every client; the tech points it at the
// cloud API or a LAN server PC at install time.
//
// IMPORTANT: read the URL via getCloudUrl() at call time — never cache it in a
// module-level const. The config does not exist on first boot, and after the
// install screen writes it we want the new URL to take effect without a restart.

import crypto from 'crypto';
import { getLocalDb } from './localDb';
import { v4 as uuid } from 'uuid';
import { parsePosFeatures, type PosFeatures } from './posFeatures';
import { rulesFromWire, type ReversalRules } from '@zaptill/core/reversalRules';
import { cleanCutoff } from '@zaptill/core/businessDay';   // 0.6.34
import { supportContact, supportWire, type SupportContact } from '@zaptill/core/support';   // 0.6.35 (A384)
import { cleanHistoryMethods } from '@zaptill/core/cashierHistory';   // 0.6.37 (A387)
import { parseStockCountFreeze, freezeExpired, NO_FREEZE, type StockCountFreeze } from '@zaptill/core/stockCountFreeze';   // A394, A521
import { logLine } from './logFile';   // A521
import { cleanScaleSettings, scaleSettingsOrDefault, type ScaleSettings } from './scaleBarcode';   // A577

export type DeployMode = 'cloud' | 'local';

// A terminal is either a plain 'till' or the branch's 'node' (aggregation node):
// the one machine other tills push their orders to for branch-wide manager totals.
// A node is usually also a till. Every terminal sells fully standalone regardless.
export type DeviceRole = 'till' | 'node' | 'office';

/**
 * Phase 3: the roles that RUN the branch server. 'node' is a till that also
 * serves; 'office' is a server that cannot sell — no drawer, no shift, no
 * cash, safe unattended, and it will not consume an activation seat (the
 * server counts only role='till' — wired with activation codes). Every
 * behavioural question is one of two: "does this machine serve the branch?"
 * (isNodeRole) or "may this machine sell?" (canSell). Comparing against the
 * literal 'node' anywhere else is how office machines fall through cracks.
 */
export function isNodeRole(role: string | null | undefined): boolean {
  return role === 'node' || role === 'office';
}
export function canSell(role: string | null | undefined): boolean {
  return role !== 'office';
}

export interface DeviceConfig {
  deploy_mode: DeployMode;
  server_url: string;            // the enrolled CLOUD url (kept as server_url; read via getCloudUrl(), rule 21)
  branch_id: string | null;
  business_type: string | null;
  device_name: string | null;
  // Stable unique id for THIS physical terminal, generated once at first save.
  // Stamped onto every order so the node/cloud can attribute sales per till and
  // the tech audit trail can record which machine an action happened on.
  device_id: string | null;
  device_role: DeviceRole;
  // LAN URL of the branch's aggregation node that this till pushes to (e.g.
  // http://192.168.1.10:4000). Null on the node itself / single-till installs.
  node_url: string | null;
  // Shared secret for the branch LAN channel. Every /node/* request must carry
  // it in an X-Node-Secret header. Minted on the node at install and copied by
  // hand onto each peer till. Before this existed the node accepted order
  // injection, served the whole branch's sales report and handed out the live
  // tech token to anything on the same wifi.
  node_secret: string | null;
  // Short terminal identifier — 'T1', 'T2', 'T3'. Prefixes bill numbers so the
  // three tills at a branch cannot collide, and tells you at a glance which
  // machine rang a sale.
  terminal_code: string | null;
  // Business VAT percentage (e.g. 16). Null until the first catalogue sync.
  vat_rate: number | null;
  // Catering/Tourism Levy percentage. 0/null = not applicable.
  ctl_rate: number | null;
  max_discount_pct: number | null;
  // Free-text blocks printed above and below the receipt body. Multi-line.
  receipt_header: string | null;
  receipt_footer: string | null;
  /** 24-hour / continuous operation (A104). Per business, cached from init. */
  continuous_operation: boolean;
  /** 0.6.34: minutes after midnight the business day ends (0 = midnight), pulled with the catalogue. Written only by
   *  setBusinessDayCutoff() from the pull (shared/businessDay.ts). */
  business_day_cutoff: number;
  /** JSON array of names that must never reach a kitchen ticket — the CLOUD
   *  baseline, refreshed on every catalogue pull. */
  kitchen_exclusions: string | null;
  /** Per-terminal local override. NULL = follow the cloud baseline above;
   *  non-NULL = this terminal's own list, which wins and survives every sync. */
  kitchen_exclusions_override: string | null;
  /** A346: does the business have the web POS (web access active or in grace)? Pulled with the catalogue; null = the
   *  cloud has not said yet (an older cloud, or never synced) → treated as NO. Read-only here: written only by
   *  setWebPosEnabled() from the pull, never by saveDeviceConfig / config:save. */
  web_pos_enabled: boolean | null;
  /** A367: the owner's quick picks for order notes (a JSON array), pulled with the catalogue. NULL = not told yet →
   *  the defaults (shared/orderNotes.ts parseNotePicks). Written only by setOrderNotePicks() from the pull. */
  order_note_picks: string | null;
  /** 0.6.27: the per-client POS switches (a JSON object), pulled with the catalogue. NULL = not told yet → all off
   *  (shared/posFeatures.ts parsePosFeatures). Written only by setPosFeatures() from the pull. */
  pos_features: string | null;
  /** 0.6.30: the owner's void window and offline void/refund rules (a JSON object), pulled with the catalogue. NULL =
   *  not told yet → the defaults (shared/reversalRules.ts). Written only by setReversalRules() from the pull. */
  reversal_rules: string | null;
  /** 0.6.35 (A384): the shop's own tech (JSON {name, phone} or 'null' = none → SwiftPOS support), pulled with the
   *  catalogue. NULL = not told yet. Written only by setSupportContact() from the pull. */
  support_contact: string | null;
  /** 0.6.37 (A387): the payment methods a cashier's History shows (JSON list; [] = every method), pulled with the
   *  catalogue. NULL = not told yet (every method). Written only by setCashierHistoryMethods() from the pull or a
   *  manager's change on this till. */
  cashier_history_methods: string | null;
  /** A394: the items a stock count freezes at this branch (JSON {ref, productIds}), pulled with the catalogue. NULL =
   *  not told yet (nothing frozen). Written only by setStockCountFreeze() from the pull. */
  stock_count_freeze: string | null;
  /** A416: may a cashier closing a shift see their sales (1 / 0)? Pulled with the catalogue; NULL = not told = off.
   *  Written only by setCashierSeesShiftSales() from the pull. */
  cashier_sees_shift_sales: number | null;
  /** A418: may a cashier's History show the total of what is filtered (1 / 0)? Already combined with A416 by the cloud.
   *  NULL = not told = off. Written only by setCashierHistoryTotals() from the pull. */
  cashier_history_totals: number | null;
  /** A429: the payment methods this branch takes — a JSON list of codes. NULL = not told = the catalogue's defaults.
   *  Written only by setPaymentMethodsEnabled() from the pull (and a manager's save on this till). */
  payment_methods_enabled: string | null;
  configured: boolean;
}

// Fallback used only when no config row exists yet (e.g. dev, or the very first
// boot before the install screen runs). Keeps `npm run dev` working unchanged.
const FALLBACK_SERVER_URL = process.env.VITE_SERVER_URL ?? 'http://localhost:4000';

// Returns the saved config, or null if the device has never been configured.
export function getDeviceConfig(): DeviceConfig | null {
  const db = getLocalDb();
  const row = db.prepare(`SELECT * FROM device_config WHERE id=1`).get() as any;
  if (!row) return null;
  return {
    deploy_mode: (row.deploy_mode as DeployMode) ?? 'cloud',
    server_url: row.server_url ?? FALLBACK_SERVER_URL,
    branch_id: row.branch_id ?? null,
    business_type: row.business_type ?? null,
    device_name: row.device_name ?? null,
    device_id: row.device_id ?? null,
    device_role: (row.device_role as DeviceRole) ?? 'till',
    node_url: row.node_url ?? null,
    node_secret: row.node_secret ?? null,
    terminal_code: row.terminal_code ?? null,
    vat_rate: row.vat_rate ?? null,
    ctl_rate: row.ctl_rate ?? null,
    max_discount_pct: row.max_discount_pct ?? null,
    receipt_header: row.receipt_header ?? null,
    continuous_operation: row.continuous_operation === 1,
    business_day_cutoff: cleanCutoff(row.business_day_cutoff) ?? 0,
    receipt_footer: row.receipt_footer ?? null,
    kitchen_exclusions: row.kitchen_exclusions ?? null,
    kitchen_exclusions_override: row.kitchen_exclusions_override ?? null,
    web_pos_enabled: row.web_pos_enabled == null ? null : row.web_pos_enabled === 1,
    order_note_picks: row.order_note_picks ?? null,
    pos_features: row.pos_features ?? null,
    reversal_rules: row.reversal_rules ?? null,
    support_contact: row.support_contact ?? null,
    cashier_history_methods: row.cashier_history_methods ?? null,
    stock_count_freeze: row.stock_count_freeze ?? null,
    cashier_sees_shift_sales: row.cashier_sees_shift_sales ?? null,
    cashier_history_totals: row.cashier_history_totals ?? null,
    payment_methods_enabled: row.payment_methods_enabled ?? null,   // A429
    configured: row.configured === 1,
  };
}

// True once the install screen has written a config. App.tsx gates boot on this:
// no config -> install screen; config present -> normal login flow.
export function isConfigured(): boolean {
  const cfg = getDeviceConfig();
  return !!cfg?.configured;
}

// The runtime CLOUD url (rule 21: this returns the cloud, not a LAN 'server';
// the device_config.server_url column keeps its name). Falls back to env/localhost
// before install so dev and first-run still work.
export function getCloudUrl(): string {
  const cfg = getDeviceConfig();
  return cfg?.server_url || FALLBACK_SERVER_URL;
}

// Upsert the singleton config row. Partial updates are merged onto whatever is
// already there, so Phase B can later persist the bound branch with a single
// saveDeviceConfig({ branch_id }) without disturbing the rest.
export function saveDeviceConfig(patch: Partial<DeviceConfig>): DeviceConfig {
  const db = getLocalDb();
  const now = new Date().toISOString();
  const current = getDeviceConfig();

  const merged: DeviceConfig = {
    deploy_mode: patch.deploy_mode ?? current?.deploy_mode ?? 'cloud',
    server_url: patch.server_url ?? current?.server_url ?? FALLBACK_SERVER_URL,
    branch_id: patch.branch_id !== undefined ? patch.branch_id : (current?.branch_id ?? null),
    business_type: patch.business_type !== undefined ? patch.business_type : (current?.business_type ?? null),
    device_name: patch.device_name !== undefined ? patch.device_name : (current?.device_name ?? null),
    // device_id is generated ONCE and never changes. A factory reset (which clears
    // the row) mints a fresh one — correct, since that's effectively a new terminal.
    device_id: patch.device_id ?? current?.device_id ?? uuid(),
    device_role: patch.device_role ?? current?.device_role ?? 'till',
    node_url: patch.node_url !== undefined ? patch.node_url : (current?.node_url ?? null),
    node_secret: patch.node_secret !== undefined ? patch.node_secret : (current?.node_secret ?? null),
    terminal_code: patch.terminal_code !== undefined ? patch.terminal_code : (current?.terminal_code ?? null),
    vat_rate: patch.vat_rate !== undefined ? patch.vat_rate : (current?.vat_rate ?? null),
    ctl_rate: patch.ctl_rate !== undefined ? patch.ctl_rate : (current?.ctl_rate ?? null),
    max_discount_pct: patch.max_discount_pct !== undefined ? patch.max_discount_pct : (current?.max_discount_pct ?? null),
    receipt_header: patch.receipt_header !== undefined ? patch.receipt_header : (current?.receipt_header ?? null),
    receipt_footer: patch.receipt_footer !== undefined ? patch.receipt_footer : (current?.receipt_footer ?? null),
    continuous_operation: patch.continuous_operation !== undefined ? patch.continuous_operation : (current?.continuous_operation ?? false),
    // 0.6.34: never from the patch — only setBusinessDayCutoff() (the pull) writes it; the INSERT below leaves it alone.
    business_day_cutoff: current?.business_day_cutoff ?? 0,
    kitchen_exclusions: patch.kitchen_exclusions !== undefined ? patch.kitchen_exclusions : (current?.kitchen_exclusions ?? null),
    kitchen_exclusions_override: patch.kitchen_exclusions_override !== undefined ? patch.kitchen_exclusions_override : (current?.kitchen_exclusions_override ?? null),
    // A346: never from the patch — only setWebPosEnabled() (the cloud pull) writes it; the INSERT below leaves it alone.
    web_pos_enabled: current?.web_pos_enabled ?? null,
    // A367: never from the patch — only setOrderNotePicks() (the pull) writes it; the INSERT below leaves it alone.
    order_note_picks: current?.order_note_picks ?? null,
    // 0.6.27: never from the patch — only setPosFeatures() (the pull) writes it; the INSERT below leaves it alone.
    pos_features: current?.pos_features ?? null,
    // 0.6.30: never from the patch — only setReversalRules() (the pull) writes it; the INSERT below leaves it alone.
    reversal_rules: current?.reversal_rules ?? null,
    // 0.6.35: never from the patch — only setSupportContact() (the pull) writes it; the INSERT below leaves it alone.
    support_contact: current?.support_contact ?? null,
    // 0.6.37: never from the patch — only setCashierHistoryMethods() writes it; the INSERT below leaves it alone.
    cashier_history_methods: current?.cashier_history_methods ?? null,
    // A394: never from the patch — only setStockCountFreeze() (the pull) writes it; the INSERT below leaves it alone.
    stock_count_freeze: current?.stock_count_freeze ?? null,
    // A416: never from the patch — only setCashierSeesShiftSales() (the pull) writes it; the INSERT below leaves it alone.
    cashier_sees_shift_sales: current?.cashier_sees_shift_sales ?? null,
    // A418: never from the patch — only setCashierHistoryTotals() (the pull) writes it.
    cashier_history_totals: current?.cashier_history_totals ?? null,
    // A429: never from the patch — only setPaymentMethodsEnabled() writes it.
    payment_methods_enabled: current?.payment_methods_enabled ?? null,
    // Once configured, stays configured unless a factory reset clears the row.
    configured: patch.configured ?? current?.configured ?? false,
  };

  db.prepare(`
    INSERT INTO device_config
      (id, deploy_mode, server_url, branch_id, business_type, device_name, device_id, device_role, node_url, node_secret, terminal_code, vat_rate, ctl_rate, max_discount_pct, receipt_header, receipt_footer, continuous_operation, kitchen_exclusions, kitchen_exclusions_override, configured, created_at, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      deploy_mode=excluded.deploy_mode,
      server_url=excluded.server_url,
      branch_id=excluded.branch_id,
      business_type=excluded.business_type,
      device_name=excluded.device_name,
      device_id=excluded.device_id,
      device_role=excluded.device_role,
      node_url=excluded.node_url,
      node_secret=excluded.node_secret,
      terminal_code=excluded.terminal_code,
      vat_rate=excluded.vat_rate,
      ctl_rate=excluded.ctl_rate,
      max_discount_pct=excluded.max_discount_pct,
      receipt_header=excluded.receipt_header,
      receipt_footer=excluded.receipt_footer,
      continuous_operation=excluded.continuous_operation,
      kitchen_exclusions=excluded.kitchen_exclusions,
      kitchen_exclusions_override=excluded.kitchen_exclusions_override,
      configured=excluded.configured,
      updated_at=excluded.updated_at
  `).run(
    merged.deploy_mode,
    merged.server_url,
    merged.branch_id,
    merged.business_type,
    merged.device_name,
    merged.device_id,
    merged.device_role,
    merged.node_url,
    merged.node_secret,
    merged.terminal_code,
    merged.vat_rate,
    merged.ctl_rate,
    merged.max_discount_pct,
    merged.receipt_header,
    merged.receipt_footer,
    merged.continuous_operation ? 1 : 0,
    merged.kitchen_exclusions,
    merged.kitchen_exclusions_override,
    merged.configured ? 1 : 0,
    current ? (db.prepare(`SELECT created_at FROM device_config WHERE id=1`).get() as any)?.created_at ?? now : now,
    now,
  );

  return merged;
}

// ── Branch LAN secret ───────────────────────────────────────────────────────
// Read off the node's screen and typed into each till, so it avoids characters
// that are ambiguous in that workflow: no 0/O, no 1/I/L, no U. 16 characters
// from a 30-symbol alphabet is ~78 bits, far beyond what a LAN needs, and
// crypto.randomInt is rejection-sampled so there is no modulo bias.
const SECRET_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateNodeSecret(): string {
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += SECRET_ALPHABET[crypto.randomInt(0, SECRET_ALPHABET.length)];
    if (i % 4 === 3 && i < 15) out += '-';
  }
  return out;
}

// Returns this device's node secret, minting and persisting one if absent.
// Called by startNodeServer so an install upgraded from a build without this
// column comes up authenticated rather than open.
export function ensureNodeSecret(): string {
  const existing = getDeviceConfig()?.node_secret;
  if (existing) return existing;
  const secret = generateNodeSecret();
  saveDeviceConfig({ node_secret: secret });
  return secret;
}

// Factory reset — wipes the config so the device returns to the open install
// state. Phase 6 will gate this behind a tech token; for now it exists so a
// mis-typed server URL during testing can be recovered.
export function clearDeviceConfig(): void {
  const db = getLocalDb();
  db.prepare(`DELETE FROM device_config WHERE id=1`).run();
}

/**
 * A346: store what the cloud said about the web POS (catalogue pull, `webPosEnabled`). Its own write — the ONLY writer of
 * web_pos_enabled — so a renderer's config:save can never switch a paid web feature on. undefined = the cloud did not say
 * (an older cloud): leave the stored value alone.
 */
export function setWebPosEnabled(enabled: boolean | undefined): void {
  if (typeof enabled !== 'boolean') return;
  getLocalDb().prepare(`UPDATE device_config SET web_pos_enabled = ? WHERE id = 1`).run(enabled ? 1 : 0);
}

/**
 * 0.6.27: cache the per-client POS switches the admin portal sets. undefined/null = not said (older cloud or node) →
 * keep. The ONLY writer, so a renderer's config:save can never switch one on.
 */
export function setPosFeatures(features: Record<string, boolean> | null | undefined): void {
  if (!features || typeof features !== 'object') return;
  getLocalDb().prepare(`UPDATE device_config SET pos_features = ? WHERE id = 1`).run(JSON.stringify(parsePosFeatures(features)));
}

/** 0.6.27: the switches as the till last heard them (all off until told). */
export function getPosFeatures(): PosFeatures {
  return parsePosFeatures(getDeviceConfig()?.pos_features ?? null);
}

/**
 * 0.6.30: cache the owner's void window and offline void/refund rules. undefined/null = not said (older cloud or node)
 * → keep. The ONLY writer, so a renderer's config:save can never widen them.
 */
export function setReversalRules(rules: unknown): void {
  if (!rules || typeof rules !== 'object') return;
  getLocalDb().prepare(`UPDATE device_config SET reversal_rules = ? WHERE id = 1`).run(JSON.stringify(rulesFromWire(rules)));
}

/**
 * 0.6.34: cache when the business day ends (minutes after midnight). undefined/null = not said (older cloud or node) →
 * keep. The ONLY writer, so a renderer's config:save can never move it.
 */
export function setBusinessDayCutoff(minutes: unknown): void {
  if (minutes === undefined || minutes === null) return;
  const m = cleanCutoff(minutes);
  if (m === undefined) return;
  getLocalDb().prepare(`UPDATE device_config SET business_day_cutoff = ? WHERE id = 1`).run(m);
}

/**
 * 0.6.35 (A384): cache the shop's own tech (name + number) from the pull. undefined = not said (older cloud or node) →
 * keep; null = no tech (→ SwiftPOS support). The ONLY writer.
 */
export function setSupportContact(raw: unknown): void {
  if (raw === undefined) return;
  getLocalDb().prepare(`UPDATE device_config SET support_contact = ? WHERE id = 1`).run(JSON.stringify(supportWire(raw)));
}

/** 0.6.35 (A384): who this shop calls — its tech, or SwiftPOS support until told. Works offline. */
export function getSupportContact(): SupportContact {
  const raw = getDeviceConfig()?.support_contact;
  if (typeof raw !== 'string' || !raw) return supportContact(null);
  try { return supportContact(JSON.parse(raw)); } catch { return supportContact(null); }
}

/**
 * 0.6.37 (A387): cache the payment methods a cashier's History shows. undefined = not said (older cloud or node) →
 * keep; a list ([] = every method) is stored; anything else is ignored.
 */
export function setCashierHistoryMethods(raw: unknown): void {
  if (raw === undefined) return;
  const m = cleanHistoryMethods(raw);
  if (m === undefined) return;
  getLocalDb().prepare(`UPDATE device_config SET cashier_history_methods = ? WHERE id = 1`).run(JSON.stringify(m));
}

/** A416: cache whether a cashier sees their sales at close. undefined = not said (older cloud or node) → keep. */
export function setCashierSeesShiftSales(raw: unknown): void {
  if (typeof raw !== 'boolean') return;
  getLocalDb().prepare(`UPDATE device_config SET cashier_sees_shift_sales = ? WHERE id = 1`).run(raw ? 1 : 0);
}

/** A416: does a cashier closing a shift on this till see their sales? Off until told (the default). */
export function getCashierSeesShiftSales(): boolean {
  return getDeviceConfig()?.cashier_sees_shift_sales === 1;
}

/** A418: cache whether a cashier's History shows a total. undefined = not said (older cloud or node) → keep. */
export function setCashierHistoryTotals(raw: unknown): void {
  if (typeof raw !== 'boolean') return;
  getLocalDb().prepare(`UPDATE device_config SET cashier_history_totals = ? WHERE id = 1`).run(raw ? 1 : 0);
}

/**
 * A429: cache the payment methods this branch takes — a list of method codes. undefined / not a list = not said (an
 * older cloud or node) → keep. The codes are checked against the catalogue where they are used (the renderer); here
 * only their shape.
 */
export function setPaymentMethodsEnabled(raw: unknown): void {
  if (!Array.isArray(raw)) return;
  const codes = raw.map((c) => String(c).trim().toLowerCase()).filter((c) => /^[a-z0-9_]{1,40}$/.test(c));
  getLocalDb().prepare(`UPDATE device_config SET payment_methods_enabled = ? WHERE id = 1`).run(JSON.stringify(codes));
}

/** A429: the codes switched on, as stored — null until told (the renderer then uses the catalogue's defaults). */
export function getPaymentMethodsEnabled(): string[] | null {
  const raw = getDeviceConfig()?.payment_methods_enabled;
  if (typeof raw !== 'string') return null;
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.map(String) : null; } catch { return null; }
}

/** A418: does a cashier's History show the total? Only while A416 is on too (checked here as well). Off until told. */
export function getCashierHistoryTotals(): boolean {
  const c = getDeviceConfig();
  return c?.cashier_history_totals === 1 && c?.cashier_sees_shift_sales === 1;
}

/** 0.6.37 (A387): the methods a cashier's History shows on this till ([] = every method, also until told). */
export function getCashierHistoryMethods(): string[] {
  return cleanHistoryMethods(getDeviceConfig()?.cashier_history_methods ?? null) ?? [];
}

/** 0.6.34: when the business day ends on this till (0 = midnight until told). */
export function getBusinessDayCutoff(): number {
  return getDeviceConfig()?.business_day_cutoff ?? 0;
}

/** 0.6.30: the rules as the till last heard them (the defaults until told). */
export function getReversalRules(): ReversalRules {
  const raw = getDeviceConfig()?.reversal_rules;
  if (typeof raw !== 'string' || !raw) return rulesFromWire(null);
  try { return rulesFromWire(JSON.parse(raw)); } catch { return rulesFromWire(null); }
}

/** A367: cache the owner's quick picks for order notes. undefined/null = not said (older cloud or node) → keep. */
export function setOrderNotePicks(picks: string[] | null | undefined): void {
  if (!Array.isArray(picks)) return;
  getLocalDb().prepare(`UPDATE device_config SET order_note_picks = ? WHERE id = 1`).run(JSON.stringify(picks.map(String)));
}

/**
 * A577: cache the business's scale label layout (the cloud's `scaleBarcodes`, shared/scaleBarcode.ts). undefined = not
 * said (older cloud / node) → keep; a layout that does not clean (a newer cloud's shape) → keep. The ONLY writer.
 */
export function setScaleBarcodes(raw: unknown): void {
  if (raw === undefined || raw === null) return;
  const c = cleanScaleSettings(raw);
  if (!('settings' in c)) return;
  try { getLocalDb().prepare(`UPDATE device_config SET scale_barcodes = ? WHERE id = 1`).run(JSON.stringify(c.settings)); }
  catch { /* a database before local schema 77 */ }
}

/** A577: the scale label layout this till reads labels with (the default until told). */
export function getScaleSettings(): ScaleSettings {
  try {
    const r = getLocalDb().prepare(`SELECT scale_barcodes FROM device_config WHERE id = 1`).get() as { scale_barcodes?: string | null } | undefined;
    return scaleSettingsOrDefault(r?.scale_barcodes ?? null);
  } catch {
    return scaleSettingsOrDefault(null);
  }
}

/**
 * A394: cache the items a stock count freezes (the cloud's `stockCount`). undefined = not said (older cloud / node) →
 * keep; null = nothing frozen. The ONLY writer.
 */
export function setStockCountFreeze(raw: unknown, nowMs: number = Date.now()): void {
  if (raw === undefined) return;
  const f = parseStockCountFreeze(raw);
  // A521: when the cloud last confirmed the list — now, or (from a branch server's bundle) when the SERVER last heard it,
  // never later than now. A server offline for a day passes its old time on, and its tills lift the freeze with it.
  if (f.productIds.length) {
    const passed = f.heard_at ? Date.parse(f.heard_at) : NaN;
    f.heard_at = new Date(Number.isFinite(passed) ? Math.min(passed, nowMs) : nowMs).toISOString();
  }
  getLocalDb().prepare(`UPDATE device_config SET stock_count_freeze = ? WHERE id = 1`).run(JSON.stringify(f));
}

/** A521: the freeze ref already logged as lifted (one line per count, not one per tap). */
let _freezeLiftLogged: string | null = null;

/** A394: what this till must not sell right now (the last list heard — it stays in force offline).
 *  A521 (#7): for at most FREEZE_MAX_AGE_MS (12 h) without the cloud confirming it — then it lifts by itself, with a log
 *  line. A list cached before A521 (no heard_at) is stamped now: its 12 h start at this build's first read. */
export function getStockCountFreeze(nowMs: number = Date.now()): StockCountFreeze {
  const f = parseStockCountFreeze(getDeviceConfig()?.stock_count_freeze ?? null);
  if (!f.productIds.length) return f;
  if (!f.heard_at) {
    f.heard_at = new Date(nowMs).toISOString();
    try { getLocalDb().prepare(`UPDATE device_config SET stock_count_freeze = ? WHERE id = 1`).run(JSON.stringify(f)); } catch { /* read-only: judged next read */ }
    return f;
  }
  if (freezeExpired(f, nowMs)) {
    const key = `${f.ref ?? ''}|${f.heard_at}`;
    if (_freezeLiftLogged !== key) {
      _freezeLiftLogged = key;
      try {
        logLine('sale', `A521 stock-count freeze${f.ref ? ` ${f.ref}` : ''} (${f.productIds.length} item(s)) lifted on this till: not confirmed by the cloud since ${f.heard_at} (over 12 h) — they sell again until the cloud says otherwise`);
      } catch { /* no log here */ }
    }
    return NO_FREEZE;
  }
  return f;
}

/**
 * A446: a till whose staff only ever signed in through its branch server (or offline) never recorded its branch, so a
 * manager's change said "This till is not bound to a branch yet" and the menu was pulled for the business's main branch.
 * The branch its signed-in person works at is its branch: recorded once, at start and on that sign-in. Returns it.
 */
export function tillBranchId(): string | null {
  const cfg = getDeviceConfig();
  if (cfg?.branch_id) return cfg.branch_id;
  try {
    const s = getLocalDb().prepare(`SELECT branch_id FROM staff_session WHERE id = 1`).get() as { branch_id?: string | null } | undefined;
    if (s?.branch_id && cfg) { saveDeviceConfig({ branch_id: s.branch_id }); return s.branch_id; }
  } catch { /* no session table yet */ }
  return null;
}
