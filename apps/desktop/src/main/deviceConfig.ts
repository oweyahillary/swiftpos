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

import { getLocalDb } from './localDb';

export type DeployMode = 'cloud' | 'local';

export interface DeviceConfig {
  deploy_mode: DeployMode;
  server_url: string;
  branch_id: string | null;
  business_type: string | null;
  device_name: string | null;
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
    // Once configured, stays configured unless a factory reset clears the row.
    configured: patch.configured ?? current?.configured ?? false,
  };

  db.prepare(`
    INSERT INTO device_config
      (id, deploy_mode, server_url, branch_id, business_type, device_name, configured, created_at, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      deploy_mode=excluded.deploy_mode,
      server_url=excluded.server_url,
      branch_id=excluded.branch_id,
      business_type=excluded.business_type,
      device_name=excluded.device_name,
      configured=excluded.configured,
      updated_at=excluded.updated_at
  `).run(
    merged.deploy_mode,
    merged.server_url,
    merged.branch_id,
    merged.business_type,
    merged.device_name,
    merged.configured ? 1 : 0,
    current ? (db.prepare(`SELECT created_at FROM device_config WHERE id=1`).get() as any)?.created_at ?? now : now,
    now,
  );

  return merged;
}

// Factory reset — wipes the config so the device returns to the open install
// state. Phase 6 will gate this behind a tech token; for now it exists so a
// mis-typed server URL during testing can be recovered.
export function clearDeviceConfig(): void {
  const db = getLocalDb();
  db.prepare(`DELETE FROM device_config WHERE id=1`).run();
}
