/**
 * attendanceSync.ts — A599: the branch server pulls punches from the branch's ZKTeco devices and sends them to the cloud.
 *
 * Owner, 2026-10-27/28: attendance is premium (the business's 'attendance' flag, set by ZapTill in the admin portal); the
 * punches come ONLY from the device; the branch server pulls them (the device never talks to the cloud); fingerprints
 * never leave the device. The device protocol is zkteco.ts; the cloud side is apps/server/src/routes/attendance.ts.
 *
 * What one run does (AttendanceJob.runOnce — every RUN_EVERY_MS on the branch server, or "Pull now" on the Tech page):
 *   0. NOTHING AT ALL (no cloud call, no device call) unless this PC is the branch server, the flag is on and the cloud is
 *      reachable. A cloud that answers ATTENDANCE_OFF (the flag turned off since the last pull), or an older cloud (404),
 *      is asked again only after OFF_WAIT_MS / OLD_CLOUD_WAIT_MS.
 *   1. GET /api/attendance/node/config — the branch's devices, its UTC offset and the actions waiting (write / delete a user).
 *   2. For each device, ONE AT A TIME, each in its own try/catch with its own time budget (DEVICE_BUDGET_MS; every device
 *      request also has its own timeout): connect; serial, model, firmware, the clock (drift in seconds); the users; the
 *      record count, and the punches only when the count moved; POST …/devices/:id/state (serial, model, firmware, drift,
 *      users — never an error then, which clears the last one). Then the device's waiting actions: write a user (the
 *      number + the name, ALWAYS a normal user — zkteco.ts refuses an admin, and a user record never carries a
 *      fingerprint), or delete one; each acked { ok } or { ok: false, error }. Then the new punches, ≤ 500 a call, their
 *      device wall-clock time made UTC with the config's utc_offset_minutes.
 *      A device that cannot be reached: POST state { error: '<short reason>' } and on to the next device; its actions stay
 *      waiting (not acked — an unreachable device must not use up an action's five tries).
 *   3. The high-water mark (per device, the KV store — maintenance_state on the PC): how many of the device's punches have
 *      been sent and the last one sent (user + time). The device's log only grows, so the next run sends from there; a log
 *      that no longer matches (cleared on the device, a different device) is sent again from the start — the cloud is
 *      idempotent (unique device serial + device user + time). The device's log is NEVER cleared from here.
 *   4. A punches call answered 409 DEVICE_SERIAL_UNKNOWN (the cloud has no serial for the device yet — its state call failed):
 *      the state is sent again, then the batch once more. 409 on the state call (another device of the business has this
 *      serial, or the device was swapped): no punches are sent for it — they would be filed under the wrong device.
 *
 * Nothing here imports Electron — attendanceDevice.ts wires the real cloud, flag, role and store in; the tests pass fakes.
 */
import { ZkClient, ZkError, wallToDate, wallIso, dateToWall, type ZkOptions, type ZkPunch, type ZkUser, type ZkWallTime } from './zkteco';

export const RUN_EVERY_MS = 3 * 60_000;
export const PUNCH_BATCH = 500;
export const DEVICE_BUDGET_MS = 120_000;
export const DEVICE_TIMEOUT_MS = 5_000;
export const OFF_WAIT_MS = 30 * 60_000;
export const OLD_CLOUD_WAIT_MS = 60 * 60_000;
export const DRIFT_WARN_S = 60;
const HWM_PREFIX = 'attendance_hwm:';

// ── what the cloud sends ──────────────────────────────────────────────────────────────────────────────────────────
export interface AttDevice { id: string; name: string; ip: string; port: number; comm_key: number; serial: string | null }
export interface AttAction { id: string; device_id: string; action: string; attendance_no: number | null; name: string | null; overwrite?: boolean }
export interface AttConfig { branch_id: string; utc_offset_minutes: number; devices: AttDevice[]; actions: AttAction[] }

/** What a cloud call gives back (a fetch Response fits). */
export interface CloudAnswer { status: number; ok: boolean; json(): Promise<any> }

export interface AttendanceDeps {
  isServer(): boolean;
  flagOn(): boolean;
  cloudReachable(): boolean;
  cloudGet(path: string): Promise<CloudAnswer>;
  cloudPost(path: string, body: unknown): Promise<CloudAnswer>;
  kvGet(key: string): string | null;
  kvSet(key: string, value: string): void;
  log(line: string): void;
  now?(): number;
  /** Per device request (zkteco.ts). */
  zkTimeoutMs?: number;
  /** A whole device's turn. */
  deviceBudgetMs?: number;
  /** Tests: a different device factory. */
  makeClient?(opts: ZkOptions): ZkClient;
}

/** The device's line on the Tech page. Never the comm key. */
export interface DeviceView {
  id: string; name: string; ip: string; port: number;
  serial: string | null; model: string | null; firmware: string | null;
  lastContactAt: string | null; lastError: string | null; lastErrorAt: string | null;
  driftS: number | null; usersOnDevice: number | null; punchesOnDevice: number | null;
  sentLastRun: number; lastSentAt: string | null;
}

export interface RunSummary {
  ran: boolean;
  skipped?: 'not_server' | 'flag_off' | 'offline' | 'cloud_off' | 'old_cloud' | 'busy';
  error?: string;
  devices: Array<{ id: string; ok: boolean; error?: string; sent: number; actionsDone: number; actionsFailed: number }>;
}

export interface AttendanceStatus {
  lastRunAt: string | null; lastRunOk: boolean | null; lastError: string | null;
  everyS: number; driftWarnS: number; waitUntil: string | null;
  utcOffsetMinutes: number | null;
  devices: DeviceView[];
}

export interface DeviceCheck {
  ok: boolean; error?: string;
  serial?: string; model?: string; firmware?: string;
  deviceTime?: string; pcTime?: string; driftS?: number;
}

interface Hwm { serial: string; count: number; last: string }

/** A short, plain reason for the Tech page and the cloud (state.error). Never the comm key (zkteco.ts never puts it in). */
export function shortError(e: unknown, dev?: { ip: string; port: number }): string {
  const where = dev ? `${dev.ip}:${dev.port}` : 'the device';
  if (e instanceof ZkError) {
    switch (e.code) {
      case 'TIMEOUT': return `No answer from the device at ${where} - check it is switched on and on the shop network.`;
      case 'REFUSED': return `The device at ${where} refused the connection - check the address and port.`;
      case 'UNAUTH': return 'The device asks for a different comm key - check the comm key on the web portal and on the device.';
      case 'CLOSED': return `The device at ${where} closed the connection (${e.message}).`.slice(0, 200);
      case 'FORBIDDEN': return e.message.slice(0, 200);
      default: return `The device at ${where} answered something unexpected (${e.message}).`.slice(0, 200);
    }
  }
  const m = (e as any)?.message ?? String(e);
  return String(m).slice(0, 200);
}

const punchKey = (p: { userId: string }, at: string) => `${p.userId}|${at}`;

export class AttendanceJob {
  private config: AttConfig | null = null;
  private views = new Map<string, DeviceView>();
  private running: Promise<RunSummary> | null = null;
  private lastRunAt = 0;
  private lastRunOk: boolean | null = null;
  private lastError: string | null = null;
  private waitUntil = 0;

  constructor(private readonly d: AttendanceDeps) {}

  private now(): number { return this.d.now ? this.d.now() : Date.now(); }

  /** May anything run at all? (No network call is made to find out.) */
  gate(): RunSummary['skipped'] | null {
    if (!this.d.isServer()) return 'not_server';
    if (!this.d.flagOn()) return 'flag_off';
    if (!this.d.cloudReachable()) return 'offline';
    return null;
  }

  /** The Tech page shows the section only then. */
  visible(): boolean {
    try { return this.d.isServer() && this.d.flagOn(); } catch { return false; }
  }

  /** Is a run due (the beat calls this)? */
  due(now = this.now()): boolean {
    return now >= this.waitUntil && now - this.lastRunAt >= RUN_EVERY_MS;
  }

  /** Single-flight: a "Pull now" during a beat's run waits for that run. */
  runOnce(why = 'the beat'): Promise<RunSummary> {
    if (this.running) return this.running;
    this.running = this.run(why).finally(() => { this.running = null; });
    return this.running;
  }

  private async run(why: string): Promise<RunSummary> {
    const g = this.gate();
    if (g) return { ran: false, skipped: g, devices: [] };
    const now = this.now();
    if (now < this.waitUntil && why === 'the beat') return { ran: false, skipped: 'cloud_off', devices: [] };
    this.lastRunAt = now;
    this.lastRunOk = false;
    const cfg = await this.fetchConfig();
    if (!('devices' in cfg)) {
      const r = cfg;
      if (r.error) this.lastError = r.error;
      return { ran: false, skipped: r.skipped, error: r.error, devices: [] };
    }
    const out: RunSummary = { ran: true, devices: [] };
    for (const dev of cfg.devices) {
      // one device's failure never stops the next
      try { out.devices.push(await this.doDevice(cfg, dev)); }
      catch (e) { out.devices.push({ id: dev.id, ok: false, error: shortError(e, dev), sent: 0, actionsDone: 0, actionsFailed: 0 }); }
    }
    const bad = out.devices.filter((x) => !x.ok);
    this.lastRunOk = bad.length === 0;
    this.lastError = bad.length ? `${bad.length} of ${out.devices.length} device(s) had a problem` : null;
    const sent = out.devices.reduce((s, x) => s + x.sent, 0);
    const acts = out.devices.reduce((s, x) => s + x.actionsDone + x.actionsFailed, 0);
    if (sent || acts || bad.length) {
      this.d.log(`A599: attendance (${why}) — ${out.devices.length} device(s), ${sent} punch(es) sent, ${acts} device change(s) made${bad.length ? `, ${bad.length} with a problem: ${bad.map((b) => b.error).join(' | ')}` : ''}`);
    }
    return out;
  }

  private async fetchConfig(): Promise<AttConfig | { skipped?: RunSummary['skipped']; error?: string }> {
    let res: CloudAnswer;
    try { res = await this.d.cloudGet('/api/attendance/node/config'); }
    catch (e: any) { return { error: `the cloud could not be reached (${e?.message ?? e})` }; }
    const body = await res.json().catch(() => null);
    if (res.status === 403 && body?.code === 'ATTENDANCE_OFF') {
      this.waitUntil = this.now() + OFF_WAIT_MS;
      this.config = null;
      this.d.log('A599: the cloud says attendance is off for this business — asked again in 30 minutes');
      return { skipped: 'cloud_off' };
    }
    if (res.status === 404) {
      this.waitUntil = this.now() + OLD_CLOUD_WAIT_MS;
      this.d.log('A599: the cloud does not take attendance from a branch server yet (an older cloud) — asked again in an hour');
      return { skipped: 'old_cloud' };
    }
    if (!res.ok || !body) return { error: `attendance config: HTTP ${res.status}${body?.code ? ` ${body.code}` : ''}` };
    this.waitUntil = 0;
    const offset = Number.isInteger(body.utc_offset_minutes) && Math.abs(body.utc_offset_minutes) <= 14 * 60 ? body.utc_offset_minutes : 180;
    const devices: AttDevice[] = (Array.isArray(body.devices) ? body.devices : [])
      .filter((x: any) => x && typeof x.id === 'string' && typeof x.ip === 'string' && x.ip.trim())
      .map((x: any) => ({
        id: x.id, name: typeof x.name === 'string' ? x.name : 'Attendance device', ip: x.ip.trim(),
        port: Number.isInteger(x.port) && x.port > 0 && x.port < 65536 ? x.port : 4370,
        comm_key: Number.isInteger(Number(x.comm_key)) && Number(x.comm_key) >= 0 ? Number(x.comm_key) : 0,
        serial: typeof x.serial === 'string' && x.serial ? x.serial : null,
      }));
    const actions: AttAction[] = (Array.isArray(body.actions) ? body.actions : [])
      .filter((a: any) => a && typeof a.id === 'string' && typeof a.device_id === 'string')
      .map((a: any) => ({ id: a.id, device_id: a.device_id, action: String(a.action ?? ''),
        attendance_no: Number.isInteger(a.attendance_no) ? a.attendance_no : null, name: typeof a.name === 'string' ? a.name : null,
        overwrite: a.overwrite === true }));
    const cfg: AttConfig = { branch_id: String(body.branch_id ?? ''), utc_offset_minutes: offset, devices, actions };
    this.config = cfg;
    // the Tech page's list follows the cloud's (a device removed on the web goes)
    const keep = new Map<string, DeviceView>();
    for (const dv of devices) {
      const had = this.views.get(dv.id);
      keep.set(dv.id, { ...(had ?? blankView(dv)), id: dv.id, name: dv.name, ip: dv.ip, port: dv.port, serial: had?.serial ?? dv.serial });
    }
    this.views = keep;
    return cfg;
  }

  private client(dev: AttDevice, offset: number): ZkClient {
    const opts: ZkOptions = { host: dev.ip, port: dev.port, commKey: dev.comm_key, timeoutMs: this.d.zkTimeoutMs ?? DEVICE_TIMEOUT_MS, utcOffsetMinutes: offset };
    return this.d.makeClient ? this.d.makeClient(opts) : new ZkClient(opts);
  }

  /** Runs fn on a connected client inside the device's time budget; always closes. */
  private async withDevice<T>(dev: AttDevice, offset: number, fn: (zk: ZkClient) => Promise<T>): Promise<T> {
    const zk = this.client(dev, offset);
    let timedOut = false;
    const budget = this.d.deviceBudgetMs ?? DEVICE_BUDGET_MS;
    const timer = setTimeout(() => { timedOut = true; zk.destroy(); }, budget);
    try {
      await zk.connect();
      return await fn(zk);
    } catch (e) {
      if (timedOut) throw new ZkError('TIMEOUT', `the device took longer than ${Math.round(budget / 1000)} s`);
      throw e;
    } finally {
      clearTimeout(timer);
      await zk.disconnect().catch(() => undefined);
    }
  }

  private view(dev: AttDevice): DeviceView {
    let v = this.views.get(dev.id);
    if (!v) { v = blankView(dev); this.views.set(dev.id, v); }
    return v;
  }

  private async postState(devId: string, body: Record<string, unknown>): Promise<{ status: number; code: string | null; error: string | null }> {
    try {
      const res = await this.d.cloudPost(`/api/attendance/node/devices/${encodeURIComponent(devId)}/state`, body);
      const b = await res.json().catch(() => null);
      return { status: res.status, code: b?.code ?? null, error: res.ok ? null : (b?.error ?? `HTTP ${res.status}`) };
    } catch (e: any) {
      return { status: 0, code: null, error: `the cloud could not be reached (${e?.message ?? e})` };
    }
  }

  private async doDevice(cfg: AttConfig, dev: AttDevice): Promise<RunSummary['devices'][number]> {
    const v = this.view(dev);
    const offset = cfg.utc_offset_minutes;
    const hwm = this.readHwm(dev.id);
    const result = { id: dev.id, ok: true as boolean, error: undefined as string | undefined, sent: 0, actionsDone: 0, actionsFailed: 0 };
    let read: { serial: string; model: string; firmware: string; drift: number; users: ZkUser[]; records: number; punches: ZkPunch[] | null };
    let state: Record<string, unknown>;
    const mine = cfg.actions.filter((a) => a.device_id === dev.id);
    const acks: Array<{ id: string; ok: boolean; error?: string }> = [];
    let stateAnswer: { status: number; code: string | null; error: string | null } = { status: 0, code: null, error: null };
    try {
      read = await this.withDevice(dev, offset, async (zk) => {
        const serial = (await zk.getSerialNumber()).trim();
        if (!serial) throw new ZkError('PROTOCOL', 'the device did not give its serial number');
        const firmware = await zk.getFirmwareVersion().catch(() => '');
        const model = await zk.readOption('~DeviceName').catch(() => '');
        const wall = await zk.getTime();
        const drift = Math.round((wallToDate(wall, offset).getTime() - this.now()) / 1000);
        const users = await zk.readUsers();
        const sizes = await zk.getFreeSizes();
        // the punches only when the device's count moved (a read holds the device for a moment — nobody can punch then)
        const same = hwm && hwm.serial === serial && hwm.count === sizes.records;
        const punches = same ? null : await zk.readAttendance();
        const records = punches ? punches.length : sizes.records;
        state = {
          serial, model: model || undefined, firmware: firmware || undefined, clock_drift_s: drift, error: null,
          users_on_device: users.length, punches_on_device: records, pulled_at: new Date(this.now()).toISOString(),
          users: users.map((u) => ({ device_user_id: u.userId, name: u.name, privilege: u.privilege, uid: u.uid })),
        };
        stateAnswer = await this.postState(dev.id, state);
        // the actions waiting for this device — only once the cloud knows it is this device
        if (stateAnswer.status !== 409) {
          for (const a of mine) acks.push(await this.runAction(zk, a, users));
        }
        return { serial, model, firmware, drift, users, records, punches };
      });
    } catch (e) {
      const msg = shortError(e, dev);
      v.lastError = msg; v.lastErrorAt = new Date(this.now()).toISOString(); v.sentLastRun = 0;
      await this.postState(dev.id, { error: msg });
      return { ...result, ok: false, error: msg };
    }
    v.lastContactAt = new Date(this.now()).toISOString();
    v.serial = read.serial; v.model = read.model || v.model; v.firmware = read.firmware || v.firmware;
    v.driftS = read.drift; v.usersOnDevice = read.users.length; v.punchesOnDevice = read.records;
    v.lastError = null; v.lastErrorAt = null;
    for (const k of acks) {
      if (k.ok) result.actionsDone++; else result.actionsFailed++;
      try { await this.d.cloudPost(`/api/attendance/node/actions/${encodeURIComponent(k.id)}/ack`, k.ok ? { ok: true } : { ok: false, error: k.error }); }
      catch { /* the action stays waiting; done again next run (writing the same user twice is harmless) */ }
    }
    if (stateAnswer.status === 409) {
      const msg = stateAnswer.error ?? 'The cloud refused this device\'s serial number.';
      v.lastError = msg.slice(0, 200); v.lastErrorAt = new Date(this.now()).toISOString(); v.sentLastRun = 0;
      return { ...result, ok: false, error: v.lastError };
    }
    if (read.punches) {
      const sent = await this.sendPunches(dev, offset, read.serial, read.punches, hwm, state!);
      result.sent = sent.sent;
      if (sent.error) { result.ok = false; result.error = sent.error; v.lastError = sent.error; v.lastErrorAt = new Date(this.now()).toISOString(); }
    }
    v.sentLastRun = result.sent;
    if (result.sent) v.lastSentAt = new Date(this.now()).toISOString();
    if (result.actionsFailed && result.ok) {
      const firstErr = acks.find((k) => !k.ok)?.error ?? 'a device change failed';
      v.lastError = `A change on the device failed: ${firstErr}`.slice(0, 200); v.lastErrorAt = new Date(this.now()).toISOString();
    }
    return result;
  }

  /** One waiting action on the device. Never throws (a dropped connection is reported as the action's error). */
  private async runAction(zk: ZkClient, a: AttAction, users: ZkUser[]): Promise<{ id: string; ok: boolean; error?: string }> {
    try {
      if (a.attendance_no === null || a.attendance_no < 1) return { id: a.id, ok: false, error: 'the action has no device number' };
      const userId = String(a.attendance_no);
      const held = users.find((x) => x.userId === userId);
      const name = (a.name ?? '').trim();
      if (a.action === 'write_user') {
        // A device bought before ZapTill keeps its own people under its own numbers (a real K40: 138 from 1). Unless the
        // cloud says this slot may be overwritten (the manager chose it, or it is already this person's), never write
        // over someone else — their fingerprints would become our person's punches.
        if (held && held.privilege !== 0) return { id: a.id, ok: false, error: `number ${userId} on the device is a device admin - never written from here` };
        if (held && !a.overwrite && held.name !== name) return { id: a.id, ok: false, error: `number ${userId} on the device is someone else (${held.name || 'no name'})`.slice(0, 120) };
        // always a normal user (privilege 0); zkteco.ts refuses to overwrite a device admin, and never sends a fingerprint
        await zk.writeUser({ userId, name, privilege: 0 });
        return { id: a.id, ok: true };
      }
      if (a.action === 'delete_user') {
        if (!held) return { id: a.id, ok: true };   // not on the device: already as asked
        // only the person named — whoever holds the number now, if someone else, stays
        if (a.name && held.name !== a.name) return { id: a.id, ok: true };
        await zk.deleteUser(held.uid);
        return { id: a.id, ok: true };
      }
      return { id: a.id, ok: false, error: `unknown action ${a.action}`.slice(0, 100) };
    } catch (e) {
      return { id: a.id, ok: false, error: shortError(e) };
    }
  }

  private readHwm(devId: string): Hwm | null {
    try {
      const raw = this.d.kvGet(HWM_PREFIX + devId);
      if (!raw) return null;
      const h = JSON.parse(raw);
      return h && typeof h.serial === 'string' && Number.isInteger(h.count) && h.count >= 0 && typeof h.last === 'string' ? h : null;
    } catch { return null; }
  }
  private writeHwm(devId: string, h: Hwm): void {
    try { this.d.kvSet(HWM_PREFIX + devId, JSON.stringify(h)); } catch { /* sent again next run; the cloud is idempotent */ }
  }

  private async sendPunches(dev: AttDevice, offset: number, serial: string, punches: ZkPunch[], hwm: Hwm | null, state: Record<string, unknown>): Promise<{ sent: number; error?: string }> {
    const at = punches.map((p) => wallToDate(p.wall, offset).toISOString());
    let start = 0;
    if (hwm && hwm.serial === serial && hwm.count > 0 && hwm.count <= punches.length && punchKey(punches[hwm.count - 1], at[hwm.count - 1]) === hwm.last) {
      start = hwm.count;
    } else if (hwm && hwm.count > 0) {
      this.d.log(`A599: device ${dev.name}: its punch log no longer matches what was sent (cleared on the device, or another device) — sending it again from the start (the cloud keeps no duplicates)`);
    }
    if (start === punches.length) {
      if (!hwm || hwm.serial !== serial || hwm.count !== punches.length) this.writeHwm(dev.id, { serial, count: punches.length, last: start ? punchKey(punches[start - 1], at[start - 1]) : '' });
      return { sent: 0 };
    }
    let sent = 0;
    for (let i = start; i < punches.length; i += PUNCH_BATCH) {
      const end = Math.min(i + PUNCH_BATCH, punches.length);
      const batch = punches.slice(i, end).map((p, k) => ({ device_user_id: p.userId, at: at[i + k], status: p.status, punch: p.punch, uid: p.uid }));
      let res = await this.postPunches(dev.id, batch);
      if (res.status === 409 && res.code === 'DEVICE_SERIAL_UNKNOWN') {
        // the cloud has no serial for this device yet (its state call did not land): report it, then once more
        const s = await this.postState(dev.id, state);
        if (s.status >= 200 && s.status < 300) res = await this.postPunches(dev.id, batch);
      }
      if (!res.ok) return { sent, error: `Punches not sent: ${res.error}`.slice(0, 200) };
      if (res.refused) this.d.log(`A599: device ${dev.name}: the cloud refused ${res.refused} punch(es) (${res.firstRefusal ?? 'see the device clock'})`);
      sent += batch.length;
      this.writeHwm(dev.id, { serial, count: end, last: punchKey(punches[end - 1], at[end - 1]) });
    }
    return { sent };
  }

  private async postPunches(devId: string, punches: unknown[]): Promise<{ ok: boolean; status: number; code: string | null; error: string | null; refused: number; firstRefusal: string | null }> {
    try {
      const res = await this.d.cloudPost('/api/attendance/node/punches', { device_id: devId, punches });
      const b = await res.json().catch(() => null);
      const refused = Array.isArray(b?.refused) ? b.refused : [];
      return { ok: res.ok, status: res.status, code: b?.code ?? null, error: res.ok ? null : (b?.error ?? `HTTP ${res.status}`), refused: refused.length, firstRefusal: refused[0]?.error ?? null };
    } catch (e: any) {
      return { ok: false, status: 0, code: null, error: `the cloud could not be reached (${e?.message ?? e})`, refused: 0, firstRefusal: null };
    }
  }

  // ── the Tech page ──
  status(): AttendanceStatus {
    return {
      lastRunAt: this.lastRunAt ? new Date(this.lastRunAt).toISOString() : null, lastRunOk: this.lastRunOk, lastError: this.lastError,
      everyS: RUN_EVERY_MS / 1000, driftWarnS: DRIFT_WARN_S,
      waitUntil: this.waitUntil > this.now() ? new Date(this.waitUntil).toISOString() : null,
      utcOffsetMinutes: this.config?.utc_offset_minutes ?? null,
      devices: [...this.views.values()].map((x) => ({ ...x })),
    };
  }

  /** The device as the last config named it (the config asked first when there is none yet). */
  private async deviceById(id: string): Promise<{ cfg: AttConfig; dev: AttDevice } | { error: string }> {
    const g = this.gate();
    if (g === 'not_server') return { error: 'Only the branch server talks to attendance devices.' };
    if (g === 'flag_off') return { error: 'Attendance is not turned on for this business.' };
    let cfg = this.config;
    if (!cfg || !cfg.devices.some((x) => x.id === id)) {
      if (g === 'offline') return { error: 'The cloud cannot be reached, so the device list is not known yet.' };
      const got = await this.fetchConfig();
      if (!('devices' in got)) return { error: got.error ?? (got.skipped === 'cloud_off' ? 'The cloud says attendance is off for this business.' : 'The device list could not be read from the cloud.') };
      cfg = got;
    }
    const dev = cfg.devices.find((x) => x.id === id);
    return dev ? { cfg, dev } : { error: 'That device is not one of this branch\'s attendance devices.' };
  }

  /** "Test connection": connect, serial, clock. Changes nothing. */
  async testDevice(id: string): Promise<DeviceCheck> {
    const f = await this.deviceById(id);
    if ('error' in f) return { ok: false, error: f.error };
    try {
      return await this.withDevice(f.dev, f.cfg.utc_offset_minutes, async (zk) => this.check(zk, f.cfg.utc_offset_minutes, f.dev));
    } catch (e) { return { ok: false, error: shortError(e, f.dev) }; }
  }

  /** "Set device time": the PC's clock, at the business's local time (the config's offset). Then read back. */
  async setDeviceTime(id: string): Promise<DeviceCheck> {
    const f = await this.deviceById(id);
    if ('error' in f) return { ok: false, error: f.error };
    const offset = f.cfg.utc_offset_minutes;
    try {
      const r = await this.withDevice(f.dev, offset, async (zk) => {
        await zk.setTime(dateToWall(new Date(this.now()), offset));
        return this.check(zk, offset, f.dev);
      });
      this.d.log(`A599: device ${f.dev.name}: its clock set from this PC (now ${r.driftS ?? '?'} s off)`);
      return r;
    } catch (e) { return { ok: false, error: shortError(e, f.dev) }; }
  }

  private async check(zk: ZkClient, offset: number, dev: AttDevice): Promise<DeviceCheck> {
    const serial = (await zk.getSerialNumber()).trim();
    const firmware = await zk.getFirmwareVersion().catch(() => '');
    const model = await zk.readOption('~DeviceName').catch(() => '');
    const wall: ZkWallTime = await zk.getTime();
    const nowMs = this.now();
    const driftS = Math.round((wallToDate(wall, offset).getTime() - nowMs) / 1000);
    const v = this.view(dev);
    v.serial = serial || v.serial; v.model = model || v.model; v.firmware = firmware || v.firmware; v.driftS = driftS;
    v.lastContactAt = new Date(nowMs).toISOString();
    return { ok: true, serial, model, firmware, deviceTime: wallIso(wall), pcTime: wallIso(dateToWall(new Date(nowMs), offset)), driftS };
  }
}

function blankView(dev: AttDevice): DeviceView {
  return {
    id: dev.id, name: dev.name, ip: dev.ip, port: dev.port, serial: dev.serial, model: null, firmware: null,
    lastContactAt: null, lastError: null, lastErrorAt: null, driftS: null, usersOnDevice: null, punchesOnDevice: null,
    sentLastRun: 0, lastSentAt: null,
  };
}
