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
// IMPORTANT: read the URL via getServerUrl() at call time — never cache it in a
// module-level const. The config does not exist on first boot, and after the
// install screen writes it we want the new URL to take effect without a restart.

import crypto from 'crypto';
import { getLocalDb } from './localDb';
import { v4 as uuid } from 'uuid';

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
  server_url: string;
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
  /** JSON array of names that must never reach a kitchen ticket — the CLOUD
   *  baseline, refreshed on every catalogue pull. */
  kitchen_exclusions: string | null;
  /** Per-terminal local override. NULL = follow the cloud baseline above;
   *  non-NULL = this terminal's own list, which wins and survives every sync. */
  kitchen_exclusions_override: string | null;
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
    receipt_footer: row.receipt_footer ?? null,
    kitchen_exclusions: row.kitchen_exclusions ?? null,
    kitchen_exclusions_override: row.kitchen_exclusions_override ?? null,
    configured: row.configured === 1,
  };
}

// True once the install screen has written a config. App.tsx gates boot on this:
// no config -> install screen; config present -> normal login flow.
export function isConfigured(): boolean {
  const cfg = getDeviceConfig();
  return !!cfg?.configured;
}

// The runtime server URL. Falls back to env/localhost before install so dev and
// first-run still work.
export function getServerUrl(): string {
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
    kitchen_exclusions: patch.kitchen_exclusions !== undefined ? patch.kitchen_exclusions : (current?.kitchen_exclusions ?? null),
    kitchen_exclusions_override: patch.kitchen_exclusions_override !== undefined ? patch.kitchen_exclusions_override : (current?.kitchen_exclusions_override ?? null),
    // Once configured, stays configured unless a factory reset clears the row.
    configured: patch.configured ?? current?.configured ?? false,
  };

  db.prepare(`
    INSERT INTO device_config
      (id, deploy_mode, server_url, branch_id, business_type, device_name, device_id, device_role, node_url, node_secret, terminal_code, vat_rate, ctl_rate, max_discount_pct, receipt_header, receipt_footer, kitchen_exclusions, kitchen_exclusions_override, configured, created_at, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
