/**
 * zkteco.ts — A599: attendance from a ZKTeco device on the shop network.
 *
 * Owner, 2026-10-27: attendance is premium; ZkTeco first, the model is the K90 Pro; the punches are PULLED by the
 * branch server (the device never talks to the cloud); fingerprints never leave the device — this client never reads
 * a template's contents (no CMD_USERTEMP_RRQ with the fingerprint function, no CMD_DB_RRQ). It only reads totals.
 *
 * What it is: a dependency-free client (node:net only) for ZKTeco's standalone protocol over TCP port 4370. Written
 * here from the protocol's behaviour (public descriptions of command numbers and record layouts) — NOT copied from
 * pyzk (GPL-2.0) or node-zklib. Nothing is wired yet: a later step calls it from the branch server, the Tech page and
 * sync.
 *
 * The wire:
 *   TCP frame   = 50 50 82 7d · u32 LE payload length · payload
 *   payload     = command u16 · checksum u16 · session id u16 · reply id u16 · data   (all little-endian)
 *   checksum    = 16-bit one's-complement of the one's-complement sum of the payload's LE words (checksum field 0,
 *                 an odd last byte counted as a word with a zero high byte).
 *   time        = seconds in a 31-day month, 12-month year, counted from 2000 — device LOCAL wall clock, no zone.
 *                 We hand back the wall-clock parts; the caller applies the branch's offset (Kenya: UTC+3, no DST).
 *   bulk reads  = CMD_DATA_WRRQ(1503) asks the device to prepare a buffer: either the data comes straight back in a
 *                 CMD_DATA, or an ACK_OK carries its size; then CMD_DATA_RDY(1504) reads it in chunks (each answered
 *                 PREPARE_DATA(1500) + one or more CMD_DATA(1501) + ACK_OK, or a single CMD_DATA), then FREE_DATA(1502).
 *                 The buffer starts with a u32 total size, then fixed-size records; the record size is total / count,
 *                 the count coming from CMD_GET_FREE_SIZES.
 *
 * Rules held here (not left to the caller):
 *   - every request has a timeout (default 5 s); a timeout CLOSES the connection (a late answer must never be read as
 *     the answer to the next request). Every failure is a ZkError with a code; nothing throws from a socket event.
 *   - users written are always privilege 0 (normal). Writing an admin, overwriting an admin's slot, or deleting an
 *     admin is refused (code FORBIDDEN) — the device's own admins are managed on the device.
 *   - the comm key is never logged and never put in an error message.
 *
 * VERIFIED ONLY AGAINST THE SIMULATOR (apps/desktop/test/zkteco-sim.mjs) — check on the real K90 Pro before relying on:
 *   - the comm-key transformation (makeCommKey) — the simulator uses the same reading of the protocol, so a shared
 *     misunderstanding would pass the test;
 *   - which user record the K90 Pro sends (28 or 72 bytes) and which punch record (8, 16 or 40 bytes);
 *   - the GET_FREE_SIZES layout (which u32 is users / fingers / records / capacities);
 *   - that CMD_USER_WRQ in the 72-byte form is accepted, keeps the user's fingerprints, and needs REFRESHDATA after;
 *   - the ACK_OK answer to CMD_DATA_WRRQ carrying the size at data[1..4]; the largest chunk the device accepts;
 *   - startEnroll (CMD_STARTENROLL) — model-dependent and UNTESTED on hardware;
 *   - "enrolled" per user is NOT available without reading templates (which we refuse): only the device's total
 *     fingerprint count is read (getFreeSizes().fingers).
 */
import net from 'net';

// ── Commands (protocol numbers) ──────────────────────────────────────────────────────────────────────────────────
export const CMD = {
  CONNECT: 1000,
  EXIT: 1001,
  ENABLEDEVICE: 1002,
  DISABLEDEVICE: 1003,
  AUTH: 1102,
  GET_VERSION: 1100,
  GET_TIME: 201,
  SET_TIME: 202,
  OPTIONS_RRQ: 11,
  USERTEMP_RRQ: 9,
  ATTLOG_RRQ: 13,
  USER_WRQ: 8,
  DELETE_USER: 18,
  REFRESHDATA: 1013,
  GET_FREE_SIZES: 50,
  STARTENROLL: 61,
  CANCELCAPTURE: 62,
  PREPARE_DATA: 1500,
  DATA: 1501,
  FREE_DATA: 1502,
  DATA_WRRQ: 1503,
  DATA_RDY: 1504,
  ACK_OK: 2000,
  ACK_ERROR: 2001,
  ACK_DATA: 2002,
  ACK_RETRY: 2003,
  ACK_REPEAT: 2004,
  ACK_UNAUTH: 2005,
} as const;

/** The function argument of CMD_DATA_WRRQ for a users read (the "user" table). */
const FCT_USER = 5;
const MAGIC = Buffer.from([0x50, 0x50, 0x82, 0x7d]);
const MAX_FRAME = 16 * 1024 * 1024;   // a sane ceiling; a K90 Pro holds ~100k punches ≈ 4 MB at 40 bytes

// ── Errors ───────────────────────────────────────────────────────────────────────────────────────────────────────
export type ZkErrorCode = 'TIMEOUT' | 'REFUSED' | 'UNAUTH' | 'PROTOCOL' | 'CLOSED' | 'FORBIDDEN';
export class ZkError extends Error {
  readonly code: ZkErrorCode;
  constructor(code: ZkErrorCode, message: string) {
    super(message);
    this.name = 'ZkError';
    this.code = code;
  }
}

// ── Framing ──────────────────────────────────────────────────────────────────────────────────────────────────────
/** One's-complement 16-bit checksum over the payload (with its checksum field already zero). */
export function checksum(payload: Buffer): number {
  let sum = 0;
  let i = 0;
  for (; i + 1 < payload.length; i += 2) {
    sum += payload[i] | (payload[i + 1] << 8);
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  if (i < payload.length) {
    sum += payload[i];
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  return ~sum & 0xffff;
}

/** A whole TCP frame for one command. */
export function encodePacket(command: number, sessionId: number, replyId: number, data: Buffer = Buffer.alloc(0)): Buffer {
  const payload = Buffer.alloc(8 + data.length);
  payload.writeUInt16LE(command, 0);
  payload.writeUInt16LE(0, 2);
  payload.writeUInt16LE(sessionId & 0xffff, 4);
  payload.writeUInt16LE(replyId & 0xffff, 6);
  data.copy(payload, 8);
  payload.writeUInt16LE(checksum(payload), 2);
  const head = Buffer.alloc(8);
  MAGIC.copy(head, 0);
  head.writeUInt32LE(payload.length, 4);
  return Buffer.concat([head, payload]);
}

export interface ZkFrame { command: number; checksum: number; sessionId: number; replyId: number; data: Buffer }

/** Pulls whole frames off a TCP byte stream. Throws ZkError PROTOCOL on bytes that are not this protocol. */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0);
  push(chunk: Buffer): ZkFrame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: ZkFrame[] = [];
    while (this.buf.length >= 8) {
      if (!this.buf.subarray(0, 4).equals(MAGIC)) throw new ZkError('PROTOCOL', 'not a ZKTeco frame (bad header)');
      const len = this.buf.readUInt32LE(4);
      if (len < 8 || len > MAX_FRAME) throw new ZkError('PROTOCOL', `bad frame length ${len}`);
      if (this.buf.length < 8 + len) break;
      const p = this.buf.subarray(8, 8 + len);
      out.push({
        command: p.readUInt16LE(0), checksum: p.readUInt16LE(2), sessionId: p.readUInt16LE(4), replyId: p.readUInt16LE(6),
        data: Buffer.from(p.subarray(8)),
      });
      this.buf = this.buf.subarray(8 + len);
    }
    return out;
  }
}

// ── Comm key ─────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * The 4 bytes CMD_AUTH carries: the key's 32 bits reversed, plus the session id, as LE bytes; XOR 'Z','K','S','O';
 * swap the two 16-bit halves; then XOR bytes 0,1,3 with `ticks` and put `ticks` itself in byte 2.
 * MUST BE CHECKED on the real device (the simulator shares this reading).
 */
export function makeCommKey(key: number, sessionId: number, ticks = 50): Buffer {
  const k = Math.trunc(Number(key)) >>> 0;
  let rev = 0;
  for (let i = 0; i < 32; i++) rev = ((rev << 1) | ((k >>> i) & 1)) >>> 0;
  const v = (rev + (sessionId & 0xffff)) >>> 0;
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v, 0);
  const x = [b[0] ^ 0x5a, b[1] ^ 0x4b, b[2] ^ 0x53, b[3] ^ 0x4f];   // 'Z' 'K' 'S' 'O'
  const s = [x[2], x[3], x[0], x[1]];                                // halves swapped
  const t = ticks & 0xff;
  return Buffer.from([s[0] ^ t, s[1] ^ t, t, s[3] ^ t]);
}

// ── Time ─────────────────────────────────────────────────────────────────────────────────────────────────────────
/** A device wall-clock time — no zone. month 1..12. */
export interface ZkWallTime { year: number; month: number; day: number; hour: number; minute: number; second: number }

export function encodeTime(w: ZkWallTime): number {
  return ((((w.year % 100) * 12 * 31 + (w.month - 1) * 31 + (w.day - 1)) * 24 + w.hour) * 60 + w.minute) * 60 + w.second;
}

export function decodeTime(t: number): ZkWallTime {
  let v = t >>> 0;
  const second = v % 60; v = Math.floor(v / 60);
  const minute = v % 60; v = Math.floor(v / 60);
  const hour = v % 24; v = Math.floor(v / 24);
  const day = (v % 31) + 1; v = Math.floor(v / 31);
  const month = (v % 12) + 1; v = Math.floor(v / 12);
  return { year: v + 2000, month, day, hour, minute, second };
}

const p2 = (n: number) => String(n).padStart(2, '0');
/** 'YYYY-MM-DDTHH:mm:ss' — the wall clock as written on the device. */
export function wallIso(w: ZkWallTime): string {
  return `${w.year}-${p2(w.month)}-${p2(w.day)}T${p2(w.hour)}:${p2(w.minute)}:${p2(w.second)}`;
}
/** The instant a wall-clock time stands for, at a fixed UTC offset in minutes (Kenya = +180). */
export function wallToDate(w: ZkWallTime, utcOffsetMinutes: number): Date {
  return new Date(Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - utcOffsetMinutes * 60_000);
}
/** The wall clock at a fixed UTC offset for an instant. */
export function dateToWall(d: Date, utcOffsetMinutes: number): ZkWallTime {
  const s = new Date(d.getTime() + utcOffsetMinutes * 60_000);
  return { year: s.getUTCFullYear(), month: s.getUTCMonth() + 1, day: s.getUTCDate(), hour: s.getUTCHours(), minute: s.getUTCMinutes(), second: s.getUTCSeconds() };
}

// ── Records ──────────────────────────────────────────────────────────────────────────────────────────────────────
export interface ZkUser {
  uid: number;           // the device's internal slot (1..65535)
  userId: string;        // the "user ID" a person types / sees on the device
  name: string;
  privilege: number;     // 0 = normal user; anything else is some kind of device admin
  hasPassword: boolean;
  card: number;
}
/** Internal: what a user write must keep that we never expose (the device password bytes, the group). */
interface UserRaw extends ZkUser { _password: Buffer; _group: Buffer; _groupNum: number; _tz: number }

export interface ZkPunch {
  uid: number;           // 0 when the device's record does not carry it and no user matched
  userId: string;
  wall: ZkWallTime;      // as the device wrote it — local wall clock
  wallIso: string;
  timestamp: Date;       // wall clock at the client's utcOffsetMinutes (default +180, Kenya)
  status: number;        // verify type (fingerprint, card, password …) — model-dependent meaning
  punch: number;         // 0 check-in, 1 check-out, 2 break-out, 3 break-in, 4 OT-in, 5 OT-out (as set on the device)
}

export interface ZkFreeSizes {
  users: number; fingers: number; records: number; cards: number;
  fingersCap: number; usersCap: number; recordsCap: number;
  fingersAvailable: number; usersAvailable: number; recordsAvailable: number;
}

const cstr = (b: Buffer) => { const z = b.indexOf(0); return (z < 0 ? b : b.subarray(0, z)).toString('utf8'); };

/** Fixed-length, NUL-padded field; cut at a whole UTF-8 character, always leaving room for one NUL. */
function fixed(s: string, len: number): Buffer {
  const out = Buffer.alloc(len);
  let used = 0;
  for (const ch of s) {
    const c = Buffer.from(ch, 'utf8');
    if (used + c.length > len - 1) break;
    c.copy(out, used); used += c.length;
  }
  return out;
}

export function parseUser(rec: Buffer): UserRaw {
  if (rec.length === 28) {
    // uid u16 · privilege u8 · password 5 · name 8 · card u32 · pad 1 · group u8 · timezone i16 · user id u32
    const password = Buffer.from(rec.subarray(3, 8));
    return {
      uid: rec.readUInt16LE(0), privilege: rec[2], name: cstr(rec.subarray(8, 16)), card: rec.readUInt32LE(16),
      userId: String(rec.readUInt32LE(24)), hasPassword: password[0] !== 0,
      _password: password, _group: Buffer.alloc(7), _groupNum: rec[21], _tz: rec.readInt16LE(22),
    };
  }
  if (rec.length === 72) {
    // uid u16 · privilege u8 · password 8 · name 24 · card u32 · pad 1 · group 7 · pad 1 · user id 24
    const password = Buffer.from(rec.subarray(3, 11));
    return {
      uid: rec.readUInt16LE(0), privilege: rec[2], name: cstr(rec.subarray(11, 35)), card: rec.readUInt32LE(35),
      userId: cstr(rec.subarray(48, 72)), hasPassword: password[0] !== 0,
      _password: password, _group: Buffer.from(rec.subarray(40, 47)), _groupNum: 0, _tz: 0,
    };
  }
  throw new ZkError('PROTOCOL', `unknown user record size ${rec.length}`);
}

function encodeUser72(u: UserRaw): Buffer {
  const b = Buffer.alloc(72);
  b.writeUInt16LE(u.uid, 0);
  b[2] = 0;                                   // always a normal user
  u._password.subarray(0, 8).copy(b, 3);
  fixed(u.name, 24).copy(b, 11);
  b.writeUInt32LE(u.card >>> 0, 35);
  u._group.subarray(0, 7).copy(b, 40);
  fixed(u.userId, 24).copy(b, 48);
  return b;
}

function encodeUser28(u: UserRaw): Buffer {
  const b = Buffer.alloc(28);
  b.writeUInt16LE(u.uid, 0);
  b[2] = 0;
  u._password.subarray(0, 5).copy(b, 3);
  fixed(u.name, 8).copy(b, 8);
  b.writeUInt32LE(u.card >>> 0, 16);
  b[21] = u._groupNum & 0xff;
  b.writeInt16LE(u._tz, 22);
  b.writeUInt32LE(Number(u.userId) >>> 0, 24);
  return b;
}

interface PunchRaw { uid: number | null; userId: string | null; time: number; status: number; punch: number }
export function parsePunch(rec: Buffer): PunchRaw {
  if (rec.length === 8) {
    // uid u16 · status u8 · time u32 · punch u8
    return { uid: rec.readUInt16LE(0), userId: null, status: rec[2], time: rec.readUInt32LE(3), punch: rec[7] };
  }
  if (rec.length === 16) {
    // user id u32 · time u32 · status u8 · punch u8 · reserved 2 · work code u32
    return { uid: null, userId: String(rec.readUInt32LE(0)), time: rec.readUInt32LE(4), status: rec[8], punch: rec[9] };
  }
  if (rec.length === 40) {
    // uid u16 · user id 24 · status u8 · time u32 · punch u8 · reserved 8
    return { uid: rec.readUInt16LE(0), userId: cstr(rec.subarray(2, 26)), status: rec[26], time: rec.readUInt32LE(27), punch: rec[31] };
  }
  throw new ZkError('PROTOCOL', `unknown punch record size ${rec.length}`);
}

/** Splits a bulk buffer (u32 total size, then records) into records of the size total/count. */
function splitRecords(buf: Buffer, count: number, sizes: number[], what: string): Buffer[] {
  if (buf.length < 4) return [];
  const total = Math.min(buf.readUInt32LE(0), buf.length - 4);
  const body = buf.subarray(4, 4 + total);
  if (total === 0) return [];
  let size = count > 0 && total % count === 0 ? total / count : 0;
  if (!sizes.includes(size)) {
    const fits = sizes.filter((s) => total % s === 0);
    if (fits.length !== 1) throw new ZkError('PROTOCOL', `cannot tell the ${what} record size (${total} bytes, count ${count})`);
    size = fits[0];
  }
  const out: Buffer[] = [];
  for (let o = 0; o + size <= body.length; o += size) out.push(body.subarray(o, o + size));
  return out;
}

// ── The client ───────────────────────────────────────────────────────────────────────────────────────────────────
export interface ZkOptions {
  host: string;
  port?: number;               // 4370
  commKey?: number;            // the device's "Comm Key" (0 = none). Never logged.
  timeoutMs?: number;          // per request, default 5000
  chunkSize?: number;          // bulk-read chunk, default 0xFFC0
  utcOffsetMinutes?: number;   // the branch's offset for ZkPunch.timestamp, default +180 (Kenya)
}

export class ZkClient {
  private readonly host: string;
  private readonly port: number;
  private readonly commKey: number;
  private readonly timeoutMs: number;
  private readonly chunkSize: number;
  private readonly offset: number;
  private socket: net.Socket | null = null;
  private reader = new FrameReader();
  private frames: ZkFrame[] = [];
  private waiter: { resolve: (f: ZkFrame) => void; reject: (e: ZkError) => void } | null = null;
  private closedWith: ZkError | null = null;
  private sessionId = 0;
  private replyId = 0;
  private busy: Promise<unknown> = Promise.resolve();
  /** Record size seen on the last users read (28 or 72) — a write uses the same form. */
  private userRecordSize: 28 | 72 | null = null;

  constructor(opts: ZkOptions) {
    this.host = opts.host;
    this.port = opts.port ?? 4370;
    this.commKey = opts.commKey ?? 0;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.chunkSize = Math.max(64, Math.min(opts.chunkSize ?? 0xffc0, 0xffc0));
    this.offset = opts.utcOffsetMinutes ?? 180;
  }

  get isOpen(): boolean { return !!this.socket && !this.closedWith; }

  // ── socket plumbing ──
  private fail(e: ZkError): void {
    if (!this.closedWith) this.closedWith = e;
    const w = this.waiter; this.waiter = null;
    if (w) w.reject(e);
    const s = this.socket;
    if (s) { s.removeAllListeners('data'); s.destroy(); }
  }

  private nextFrame(): Promise<ZkFrame> {
    const f = this.frames.shift();
    if (f) return Promise.resolve(f);
    if (this.closedWith) return Promise.reject(this.closedWith);
    return new Promise<ZkFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        this.fail(new ZkError('TIMEOUT', `the device did not answer within ${this.timeoutMs} ms`));
        reject(new ZkError('TIMEOUT', `the device did not answer within ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      this.waiter = {
        resolve: (fr) => { clearTimeout(timer); resolve(fr); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
    });
  }

  private send(command: number, data?: Buffer): void {
    if (!this.socket || this.closedWith) throw new ZkError('CLOSED', this.closedWith ? `not connected (${this.closedWith.message})` : 'not connected');
    this.replyId = (this.replyId + 1) & 0xffff;
    this.socket.write(encodePacket(command, this.sessionId, this.replyId, data));
  }

  private async request(command: number, data?: Buffer): Promise<ZkFrame> {
    this.send(command, data);
    return this.nextFrame();
  }

  private async requestOk(command: number, data?: Buffer, what = `command ${command}`): Promise<ZkFrame> {
    const f = await this.request(command, data);
    if (f.command === CMD.ACK_OK || f.command === CMD.ACK_DATA) return f;
    if (f.command === CMD.ACK_UNAUTH) throw new ZkError('UNAUTH', `${what}: the device wants the comm key`);
    throw new ZkError('PROTOCOL', `${what}: the device answered ${f.command}`);
  }

  /** One operation at a time on the connection. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.busy.then(fn, fn);
    this.busy = run.catch(() => undefined);
    return run;
  }

  // ── connection ──
  connect(): Promise<void> {
    return this.serial(async () => {
      if (this.socket && !this.closedWith) throw new ZkError('PROTOCOL', 'already connected');
      this.closedWith = null; this.frames = []; this.reader = new FrameReader(); this.sessionId = 0; this.replyId = 0;
      await new Promise<void>((resolve, reject) => {
        const s = net.createConnection({ host: this.host, port: this.port });
        this.socket = s;
        s.setNoDelay(true);
        let up = false;
        const timer = setTimeout(() => {
          const e = new ZkError('TIMEOUT', `no connection to ${this.host}:${this.port} within ${this.timeoutMs} ms`);
          this.fail(e); reject(e);
        }, this.timeoutMs);
        s.once('connect', () => { up = true; clearTimeout(timer); resolve(); });
        s.on('data', (chunk: Buffer) => {
          try {
            for (const f of this.reader.push(chunk)) {
              const w = this.waiter;
              if (w) { this.waiter = null; w.resolve(f); } else this.frames.push(f);
            }
          } catch (e) {
            this.fail(e instanceof ZkError ? e : new ZkError('PROTOCOL', String(e)));
          }
        });
        s.on('error', (err: NodeJS.ErrnoException) => {
          clearTimeout(timer);
          const refused = !up && (err.code === 'ECONNREFUSED' || err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH');
          const e = new ZkError(refused ? 'REFUSED' : 'CLOSED', refused ? `the device at ${this.host}:${this.port} refused the connection (${err.code})` : `connection error (${err.code ?? err.message})`);
          this.fail(e);
          if (!up) reject(e);
        });
        s.on('close', () => {
          clearTimeout(timer);
          const e = new ZkError('CLOSED', 'the device closed the connection');
          this.fail(e);
          if (!up) reject(e);
        });
      });
      try {
        const f = await this.request(CMD.CONNECT);
        this.sessionId = f.sessionId;
        if (f.command === CMD.ACK_UNAUTH) {
          const a = await this.request(CMD.AUTH, makeCommKey(this.commKey, this.sessionId));
          if (a.command !== CMD.ACK_OK) throw new ZkError('UNAUTH', 'the device refused the comm key');
        } else if (f.command !== CMD.ACK_OK) {
          throw new ZkError('PROTOCOL', `connect: the device answered ${f.command}`);
        }
      } catch (e) {
        this.destroy();
        throw e;
      }
    });
  }

  /** CMD_EXIT, then close. Never throws. */
  async disconnect(): Promise<void> {
    await this.serial(async () => {
      if (!this.socket) return;
      if (!this.closedWith) {
        try { await this.request(CMD.EXIT); } catch { /* closing anyway */ }
      }
      this.destroy();
    }).catch(() => undefined);
  }

  /** Close now, no goodbye. */
  destroy(): void {
    this.fail(new ZkError('CLOSED', 'closed by the client'));
    this.socket = null;
    this.frames = [];
  }

  // ── simple reads ──
  getFirmwareVersion(): Promise<string> {
    return this.serial(async () => cstr((await this.requestOk(CMD.GET_VERSION, undefined, 'firmware version')).data));
  }

  /** An option such as "~SerialNumber", "~Platform", "~DeviceName". '' when the device does not know it. */
  readOption(name: string): Promise<string> {
    return this.serial(async () => {
      const f = await this.requestOk(CMD.OPTIONS_RRQ, Buffer.from(`${name}\0`, 'utf8'), `option ${name}`);
      const s = cstr(f.data);
      const eq = s.indexOf('=');
      return eq < 0 ? '' : s.slice(eq + 1);
    });
  }

  getSerialNumber(): Promise<string> { return this.readOption('~SerialNumber'); }

  getTime(): Promise<ZkWallTime> {
    return this.serial(async () => {
      const f = await this.requestOk(CMD.GET_TIME, undefined, 'get time');
      if (f.data.length < 4) throw new ZkError('PROTOCOL', 'get time: short answer');
      return decodeTime(f.data.readUInt32LE(0));
    });
  }

  /** Sets the device's wall clock. Pass a Date to set it to that instant at the client's offset. */
  setTime(t: ZkWallTime | Date): Promise<void> {
    const w = t instanceof Date ? dateToWall(t, this.offset) : t;
    return this.serial(async () => {
      const b = Buffer.alloc(4); b.writeUInt32LE(encodeTime(w) >>> 0, 0);
      await this.requestOk(CMD.SET_TIME, b, 'set time');
    });
  }

  getFreeSizes(): Promise<ZkFreeSizes> { return this.serial(() => this.freeSizes()); }

  private async freeSizes(): Promise<ZkFreeSizes> {
    const f = await this.requestOk(CMD.GET_FREE_SIZES, undefined, 'free sizes');
    if (f.data.length < 80) throw new ZkError('PROTOCOL', `free sizes: short answer (${f.data.length} bytes)`);
    const i = (n: number) => f.data.readInt32LE(n * 4);
    return {
      users: i(4), fingers: i(6), records: i(8), cards: i(12),
      fingersCap: i(14), usersCap: i(15), recordsCap: i(16),
      fingersAvailable: i(17), usersAvailable: i(18), recordsAvailable: i(19),
    };
  }

  disableDevice(): Promise<void> { return this.serial(async () => { await this.requestOk(CMD.DISABLEDEVICE, undefined, 'disable'); }); }
  enableDevice(): Promise<void> { return this.serial(async () => { await this.requestOk(CMD.ENABLEDEVICE, undefined, 'enable'); }); }

  // ── bulk ──
  /** Collects one answer that may be a single CMD_DATA, or PREPARE_DATA + CMD_DATA… + ACK_OK. */
  private async collectData(first: ZkFrame, what: string): Promise<Buffer> {
    if (first.command === CMD.DATA) return first.data;
    if (first.command !== CMD.PREPARE_DATA) throw new ZkError('PROTOCOL', `${what}: the device answered ${first.command}`);
    if (first.data.length < 4) throw new ZkError('PROTOCOL', `${what}: PREPARE_DATA without a size`);
    const want = first.data.readUInt32LE(0);
    const parts: Buffer[] = [];
    let got = 0;
    while (got < want) {
      const f = await this.nextFrame();
      if (f.command !== CMD.DATA) throw new ZkError('PROTOCOL', `${what}: expected data, got ${f.command}`);
      parts.push(f.data); got += f.data.length;
    }
    const end = await this.nextFrame();
    if (end.command !== CMD.ACK_OK) throw new ZkError('PROTOCOL', `${what}: data not closed with ACK_OK (${end.command})`);
    if (got !== want) throw new ZkError('PROTOCOL', `${what}: ${got} bytes, ${want} announced`);
    return Buffer.concat(parts);
  }

  /** Reads a whole table through the device's buffer. */
  private async readBuffer(command: number, fct: number, what: string): Promise<Buffer> {
    const req = Buffer.alloc(11);
    req.writeInt8(1, 0); req.writeInt16LE(command, 1); req.writeInt32LE(fct, 3); req.writeInt32LE(0, 7);
    const f = await this.request(CMD.DATA_WRRQ, req);
    if (f.command === CMD.DATA) return f.data;
    if (f.command !== CMD.ACK_OK) throw new ZkError('PROTOCOL', `${what}: the device answered ${f.command}`);
    if (f.data.length < 5) throw new ZkError('PROTOCOL', `${what}: no buffer size`);
    const size = f.data.readUInt32LE(1);
    const parts: Buffer[] = [];
    try {
      for (let start = 0; start < size; start += this.chunkSize) {
        const len = Math.min(this.chunkSize, size - start);
        const rq = Buffer.alloc(8); rq.writeInt32LE(start, 0); rq.writeInt32LE(len, 4);
        const part = await this.collectData(await this.request(CMD.DATA_RDY, rq), what);
        if (part.length !== len) throw new ZkError('PROTOCOL', `${what}: chunk at ${start} is ${part.length} bytes, asked ${len}`);
        parts.push(part);
      }
    } finally {
      if (!this.closedWith) { try { await this.requestOk(CMD.FREE_DATA, undefined, 'free data'); } catch { /* the read's own error wins */ } }
    }
    return Buffer.concat(parts);
  }

  /** Runs reads with the device disabled (no punches land mid-read), enabling it again on every path. */
  private async whileDisabled<T>(fn: () => Promise<T>): Promise<T> {
    await this.requestOk(CMD.DISABLEDEVICE, undefined, 'disable');
    try { return await fn(); } finally {
      if (!this.closedWith) { try { await this.requestOk(CMD.ENABLEDEVICE, undefined, 'enable'); } catch { /* reported by the next call */ } }
    }
  }

  private async usersRaw(): Promise<UserRaw[]> {
    const sizes = await this.freeSizes();
    const buf = await this.readBuffer(CMD.USERTEMP_RRQ, FCT_USER, 'users');
    const recs = splitRecords(buf, sizes.users, [28, 72], 'user');
    if (recs.length) this.userRecordSize = recs[0].length as 28 | 72;
    return recs.map(parseUser);
  }

  readUsers(): Promise<ZkUser[]> {
    return this.serial(() => this.whileDisabled(async () => (await this.usersRaw()).map(publicUser)));
  }

  /** Every punch on the device. Users are read too when the record carries only one of uid / user id. */
  readAttendance(): Promise<ZkPunch[]> {
    return this.serial(() => this.whileDisabled(async () => {
      const sizes = await this.freeSizes();
      const buf = await this.readBuffer(CMD.ATTLOG_RRQ, 0, 'punches');
      const raws = splitRecords(buf, sizes.records, [8, 16, 40], 'punch').map(parsePunch);
      let users: UserRaw[] | null = null;
      if (raws.some((r) => r.uid === null || r.userId === null)) users = await this.usersRaw();
      const byUid = new Map(users?.map((u) => [u.uid, u]) ?? []);
      const byId = new Map(users?.map((u) => [u.userId, u]) ?? []);
      return raws.map((r) => {
        const wall = decodeTime(r.time);
        const uid = r.uid ?? byId.get(r.userId ?? '')?.uid ?? 0;
        const userId = r.userId ?? byUid.get(r.uid ?? -1)?.userId ?? String(r.uid ?? '');
        return { uid, userId, wall, wallIso: wallIso(wall), timestamp: wallToDate(wall, this.offset), status: r.status, punch: r.punch };
      });
    }));
  }

  // ── writes ──
  /**
   * Adds or updates a NORMAL user. `uid` omitted: an existing user with this userId keeps its slot, else the next free
   * slot. Admins are refused (privilege must be 0; an admin's slot or user id is never overwritten). Keeps the user's
   * device password, group and card unless a card is given. Returns the user as written.
   */
  writeUser(u: { userId: string; name: string; uid?: number; card?: number; privilege?: number }): Promise<ZkUser> {
    return this.serial(async () => {
      if ((u.privilege ?? 0) !== 0) throw new ZkError('FORBIDDEN', 'only normal users (privilege 0) are written; device admins are managed on the device');
      const userId = String(u.userId ?? '').trim();
      if (!userId) throw new ZkError('FORBIDDEN', 'a user id is required');
      const users = await this.whileDisabled(() => this.usersRaw());
      const same = users.find((x) => x.userId === userId);
      const uid = u.uid ?? same?.uid ?? (users.reduce((m, x) => Math.max(m, x.uid), 0) + 1);
      if (!Number.isInteger(uid) || uid < 1 || uid > 0xffff) throw new ZkError('FORBIDDEN', `uid ${uid} out of range`);
      const atSlot = users.find((x) => x.uid === uid);
      if ((atSlot && atSlot.privilege !== 0) || (same && same.privilege !== 0)) throw new ZkError('FORBIDDEN', 'that user is a device admin; it is not overwritten');
      if (same && same.uid !== uid) throw new ZkError('FORBIDDEN', `user id ${userId} is already on slot ${same.uid}`);
      const form = this.userRecordSize ?? 72;
      if (form === 28 && !/^\d{1,9}$/.test(userId)) throw new ZkError('FORBIDDEN', 'this device keeps numeric user ids only');
      const base = atSlot;
      const rec: UserRaw = {
        uid, userId, name: u.name ?? '', privilege: 0, card: u.card ?? base?.card ?? 0, hasPassword: !!base?.hasPassword,
        _password: base?._password ?? Buffer.alloc(8), _group: base?._group ?? Buffer.alloc(7),
        _groupNum: base?._groupNum ?? 1, _tz: base?._tz ?? 0,
      };
      await this.requestOk(CMD.USER_WRQ, form === 28 ? encodeUser28(rec) : encodeUser72(rec), 'write user');
      await this.requestOk(CMD.REFRESHDATA, undefined, 'refresh');
      return publicUser(rec);
    });
  }

  /** Deletes a normal user by slot. A device admin (or an unknown slot) is refused. */
  deleteUser(uid: number): Promise<void> {
    return this.serial(async () => {
      const users = await this.whileDisabled(() => this.usersRaw());
      const u = users.find((x) => x.uid === uid);
      if (!u) throw new ZkError('FORBIDDEN', `no user on slot ${uid}`);
      if (u.privilege !== 0) throw new ZkError('FORBIDDEN', 'that user is a device admin; it is not deleted from here');
      const b = Buffer.alloc(2); b.writeUInt16LE(uid, 0);
      await this.requestOk(CMD.DELETE_USER, b, 'delete user');
      await this.requestOk(CMD.REFRESHDATA, undefined, 'refresh');
    });
  }

  /**
   * MODEL-DEPENDENT, UNTESTED ON HARDWARE: asks the device to start fingerprint enrolment for a user (finger 0..9);
   * the person then puts the finger on the device. Resolves when the device accepts the request — not when the
   * finger is enrolled (watch getFreeSizes().fingers, or check on the device).
   */
  startEnroll(userId: string, finger = 0): Promise<void> {
    return this.serial(async () => {
      if (!Number.isInteger(finger) || finger < 0 || finger > 9) throw new ZkError('FORBIDDEN', 'finger must be 0..9');
      try { await this.request(CMD.CANCELCAPTURE); } catch (e) { if (this.closedWith) throw e; }
      const b = Buffer.alloc(26);
      fixed(userId, 24).copy(b, 0); b.writeInt8(finger, 24); b.writeInt8(1, 25);
      await this.requestOk(CMD.STARTENROLL, b, 'start enrolment');
    });
  }
}

function publicUser(u: UserRaw): ZkUser {
  return { uid: u.uid, userId: u.userId, name: u.name, privilege: u.privilege, hasPassword: u.hasPassword, card: u.card };
}

/** Connect, run, always disconnect. */
export async function withZk<T>(opts: ZkOptions, fn: (zk: ZkClient) => Promise<T>): Promise<T> {
  const zk = new ZkClient(opts);
  await zk.connect();
  try { return await fn(zk); } finally { await zk.disconnect(); }
}
