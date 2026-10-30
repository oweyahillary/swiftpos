/**
 * attendanceDevice.ts — A599: wires the attendance job (attendanceSync.ts) into the branch server.
 *
 *   who      ONLY the branch server (device role node / office) — a till never talks to an attendance device;
 *   when     ONLY while the business's 'attendance' flag is on (premium, set by ZapTill in the admin portal; heard on the
 *            catalogue pull as pos/init's attendanceDevice — deviceConfig.getAttendanceFlag) and the cloud is reachable;
 *            every RUN_EVERY_MS (3 minutes), the first a minute after start; "Pull now" on the Tech page at once;
 *   how      the cloud with the server's own session (syncEngine.liveCloudGet / liveCloudPost: renewed ahead of expiry and
 *            once on a 401), the high-water marks in maintenance_state (the PC's key/value table — no schema change).
 *
 * The flag off, or not the branch server: nothing runs and nothing is asked of the cloud or of any device.
 */
import { net } from 'electron';
import { getDeviceConfig, isNodeRole, getAttendanceFlag } from './deviceConfig';
import { getLocalDb } from './localDb';
import { logLine } from './logFile';
import { liveCloudGet, liveCloudPost } from './syncEngine';
import { cloudUnreachableNow } from './authTransport';
import { AttendanceJob, type AttendanceDeps } from './attendanceSync';

const TICK_MS = 30_000;
const FIRST_RUN_MS = 60_000;

export const attendanceDeps: AttendanceDeps = {
  isServer: () => isNodeRole(getDeviceConfig()?.device_role ?? null),
  flagOn: () => getAttendanceFlag(),
  cloudReachable: () => {
    try { return net.isOnline() && !cloudUnreachableNow(); } catch { return false; }
  },
  cloudGet: (p) => liveCloudGet(p),
  cloudPost: (p, body) => liveCloudPost(p, body),
  kvGet: (key) => {
    const row = getLocalDb().prepare(`SELECT value FROM maintenance_state WHERE key = ?`).get(key) as { value?: string } | undefined;
    return row?.value ?? null;
  },
  kvSet: (key, value) => {
    getLocalDb().prepare(`INSERT OR REPLACE INTO maintenance_state (key, value, updated_at) VALUES (?, ?, ?)`).run(key, value, new Date().toISOString());
  },
  log: (line) => logLine('attendance', line),
};

export const attendanceJob = new AttendanceJob(attendanceDeps);

let timer: NodeJS.Timeout | null = null;
let first: NodeJS.Timeout | null = null;

function beat(): void {
  try {
    if (attendanceJob.gate() !== null || !attendanceJob.due()) return;
  } catch { return; }
  void attendanceJob.runOnce('the beat').catch((e) => logLine('attendance', `A599: attendance run failed: ${e?.message ?? e}`));
}

export function startAttendanceDevices(): void {
  if (timer) return;
  first = setTimeout(beat, FIRST_RUN_MS);
  first.unref?.();
  timer = setInterval(beat, TICK_MS);
  timer.unref?.();
}

export function stopAttendanceDevices(): void {
  if (timer) clearInterval(timer);
  if (first) clearTimeout(first);
  timer = null; first = null;
}
