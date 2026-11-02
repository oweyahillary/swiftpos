// A599 — a fake ZKTeco K90 Pro for zkteco.test.mjs: a node:net server speaking the standalone TCP protocol (port 4370
// on a real device). In-process, no dependencies. Written separately from src/main/zkteco.ts (its own framing,
// checksum, time and comm-key code) so the test is two readings of the protocol meeting, not one talking to itself —
// except the comm-key transformation, which both take from the same protocol description (check on the real device).
//
// Seeded with users and punches; supports the comm key, chunked bulk reads (the client asks in chunks; each chunk is
// further split into several CMD_DATA frames of `frameSize` bytes), time get/set, user write/delete, refresh, and
// faults: { dropAfterChunks: n } closes the connection after n chunk answers; { silentOn: Set(cmd) } never answers
// those commands; { garbage: true } answers anything with bytes that are not the protocol.
import net from 'node:net';

export const C = {
  CONNECT: 1000, EXIT: 1001, ENABLE: 1002, DISABLE: 1003, AUTH: 1102, VERSION: 1100, GET_TIME: 201, SET_TIME: 202,
  OPTIONS: 11, USERTEMP: 9, ATTLOG: 13, USER_WRQ: 8, DELETE_USER: 18, REFRESH: 1013, FREE_SIZES: 50,
  STARTENROLL: 61, CANCELCAPTURE: 62, PREPARE_DATA: 1500, DATA: 1501, FREE_DATA: 1502, DATA_WRRQ: 1503, DATA_RDY: 1504,
  OK: 2000, ERROR: 2001, UNAUTH: 2005,
};

/** One's-complement sum of LE 16-bit words, complemented. Written out longhand on purpose. */
export function simChecksum(bytes) {
  let s = 0;
  for (let i = 0; i < bytes.length; i += 2) {
    const w = bytes[i] + (i + 1 < bytes.length ? bytes[i + 1] * 256 : 0);
    s += w;
    while (s > 0xffff) s = (s % 0x10000) + Math.floor(s / 0x10000);
  }
  return 0xffff - s;
}

export function simFrame(cmd, session, reply, data = Buffer.alloc(0)) {
  const p = Buffer.alloc(8 + data.length);
  p.writeUInt16LE(cmd, 0); p.writeUInt16LE(session, 4); p.writeUInt16LE(reply, 6); data.copy(p, 8);
  p.writeUInt16LE(simChecksum(p), 2);
  const h = Buffer.from([0x50, 0x50, 0x82, 0x7d, 0, 0, 0, 0]);
  h.writeUInt32LE(p.length, 4);
  return Buffer.concat([h, p]);
}

export function simEncodeTime(y, mo, d, h, mi, s) {
  return ((y - 2000) * 372 + (mo - 1) * 31 + (d - 1)) * 86400 + h * 3600 + mi * 60 + s;
}

export function simCommKey(key, session, ticks = 50) {
  let rev = 0n;
  const k = BigInt(key);
  for (let i = 0n; i < 32n; i++) rev = (rev << 1n) | ((k >> i) & 1n);
  const v = Number((rev + BigInt(session)) & 0xffffffffn);
  const b = [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
  const z = [b[0] ^ 90, b[1] ^ 75, b[2] ^ 83, b[3] ^ 79];
  const sw = [z[2], z[3], z[0], z[1]];
  return Buffer.from([sw[0] ^ ticks, sw[1] ^ ticks, ticks, sw[3] ^ ticks]);
}

const str = (s, n) => { const b = Buffer.alloc(n); Buffer.from(s, 'utf8').copy(b, 0, 0, n - 1); return b; };
const cut = (b) => { const z = b.indexOf(0); return (z < 0 ? b : b.subarray(0, z)).toString('utf8'); };

/**
 * @param {object} o
 *   users: [{ uid, userId, name, privilege=0, password='', card=0 }]
 *   punches: [{ uid, userId, t: [y,mo,d,h,mi,s], status=1, punch=0 }]
 *   userFormat: 28 | 72, punchFormat: 8 | 16 | 40, commKey: number, frameSize, directMax, fingers
 */
export function startSim(o = {}) {
  const st = {
    users: (o.users ?? []).map((u) => ({ privilege: 0, password: '', card: 0, group: '1', ...u })),
    punches: o.punches ?? [],
    userFormat: o.userFormat ?? 72,
    punchFormat: o.punchFormat ?? 40,
    commKey: o.commKey ?? 0,
    frameSize: o.frameSize ?? 1024,
    directMax: o.directMax ?? 0,      // a buffer up to this size comes back in one CMD_DATA, no chunks
    fingers: o.fingers ?? 0,
    time: o.time ?? simEncodeTime(2026, 10, 27, 8, 0, 0),
    serial: o.serial ?? 'K90P-SIM-0001',
    faults: o.faults ?? {},
    log: [],                          // [cmd, data hex] every command received
    authsSeen: [],                    // raw AUTH payloads (the test checks the key itself is never sent in clear)
    disabled: 0,
    sockets: new Set(),
    chunkReads: 0,
    freed: 0,
  };

  const userRec = (u) => {
    if (st.userFormat === 28) {
      const b = Buffer.alloc(28);
      b.writeUInt16LE(u.uid, 0); b[2] = u.privilege; str(u.password, 5).copy(b, 3); str(u.name, 8).copy(b, 8);
      b.writeUInt32LE(u.card, 16); b[21] = 1; b.writeUInt32LE(Number(u.userId), 24);
      return b;
    }
    const b = Buffer.alloc(72);
    b.writeUInt16LE(u.uid, 0); b[2] = u.privilege; str(u.password, 8).copy(b, 3); str(u.name, 24).copy(b, 11);
    b.writeUInt32LE(u.card, 35); str(u.group, 7).copy(b, 40); str(u.userId, 24).copy(b, 48);
    return b;
  };
  const punchRec = (p) => {
    const t = simEncodeTime(...p.t);
    if (st.punchFormat === 8) {
      const b = Buffer.alloc(8); b.writeUInt16LE(p.uid, 0); b[2] = p.status ?? 1; b.writeUInt32LE(t, 3); b[7] = p.punch ?? 0; return b;
    }
    if (st.punchFormat === 16) {
      const b = Buffer.alloc(16); b.writeUInt32LE(Number(p.userId), 0); b.writeUInt32LE(t, 4); b[8] = p.status ?? 1; b[9] = p.punch ?? 0; return b;
    }
    const b = Buffer.alloc(40);
    b.writeUInt16LE(p.uid, 0); str(p.userId, 24).copy(b, 2); b[26] = p.status ?? 1; b.writeUInt32LE(t, 27); b[31] = p.punch ?? 0;
    return b;
  };
  const table = (cmd) => {
    const recs = cmd === C.USERTEMP ? st.users.map(userRec) : st.punches.map(punchRec);
    const body = Buffer.concat(recs);
    const head = Buffer.alloc(4); head.writeUInt32LE(body.length, 0);
    return Buffer.concat([head, body]);
  };

  const server = net.createServer((sock) => {
    st.sockets.add(sock);
    sock.on('close', () => st.sockets.delete(sock));
    sock.on('error', () => {});
    let buf = Buffer.alloc(0);
    let session = 0, authed = false, prepared = null, chunks = 0;
    const send = (cmd, reply, data) => { if (!sock.destroyed) sock.write(simFrame(cmd, session, reply, data)); };
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 8) {
        const len = buf.readUInt32LE(4);
        if (buf.length < 8 + len) return;
        const p = buf.subarray(8, 8 + len);
        buf = buf.subarray(8 + len);
        const cmd = p.readUInt16LE(0), sum = p.readUInt16LE(2), reply = p.readUInt16LE(6), data = Buffer.from(p.subarray(8));
        const zeroed = Buffer.from(p); zeroed.writeUInt16LE(0, 2);
        st.log.push([cmd, data.toString('hex')]);
        if (simChecksum(zeroed) !== sum) { send(C.ERROR, reply); continue; }   // a real device's behaviour here is unknown
        if (st.faults.garbage) { sock.write(Buffer.from('HTTP/1.1 400 Bad Request\r\n\r\n')); continue; }
        if (st.faults.silentOn?.has(cmd)) continue;
        if (cmd === C.CONNECT) {
          session = 0x4000 + Math.floor(Math.random() * 0x3000);
          authed = st.commKey === 0;
          send(authed ? C.OK : C.UNAUTH, reply); continue;
        }
        if (cmd === C.AUTH) {
          st.authsSeen.push(Buffer.from(data));
          authed = data.equals(simCommKey(st.commKey, session));
          send(authed ? C.OK : C.UNAUTH, reply); continue;
        }
        if (!authed) { send(C.UNAUTH, reply); continue; }
        switch (cmd) {
          case C.EXIT: send(C.OK, reply); sock.end(); break;
          case C.DISABLE: st.disabled++; send(C.OK, reply); break;
          case C.ENABLE: st.disabled--; send(C.OK, reply); break;
          case C.VERSION: send(C.OK, reply, Buffer.from('Ver 6.60 Sep 27 2019\0')); break;
          case C.OPTIONS: {
            const name = cut(data);
            const val = name === '~SerialNumber' ? st.serial : name === '~DeviceName' ? 'K90 Pro' : null;
            send(C.OK, reply, Buffer.from(val === null ? '\0' : `${name}=${val}\0`)); break;
          }
          case C.GET_TIME: { const b = Buffer.alloc(4); b.writeUInt32LE(st.time, 0); send(C.OK, reply, b); break; }
          case C.SET_TIME: st.time = data.readUInt32LE(0); send(C.OK, reply); break;
          case C.FREE_SIZES: {
            const b = Buffer.alloc(92);
            const put = (i, v) => b.writeInt32LE(v, i * 4);
            put(4, st.users.length); put(6, st.fingers); put(8, st.punches.length); put(12, 0);
            put(14, 3000); put(15, 3000); put(16, 100000);
            put(17, 3000 - st.fingers); put(18, 3000 - st.users.length); put(19, 100000 - st.punches.length);
            send(C.OK, reply, b); break;
          }
          case C.DATA_WRRQ: {
            const which = data.readInt16LE(1);
            prepared = table(which); chunks = 0;
            if (prepared.length <= st.directMax) { send(C.DATA, reply, prepared); prepared = null; break; }
            const b = Buffer.alloc(9); b.writeUInt32LE(prepared.length, 1); send(C.OK, reply, b); break;
          }
          case C.DATA_RDY: {
            if (!prepared) { send(C.ERROR, reply); break; }
            const start = data.readInt32LE(0), size = data.readInt32LE(4);
            if (st.faults.dropAfterChunks !== undefined && chunks >= st.faults.dropAfterChunks) {
              const half = simFrame(C.PREPARE_DATA, session, reply, Buffer.alloc(4));
              sock.write(half.subarray(0, 10));     // a torn frame, then gone
              sock.destroy(); return;
            }
            chunks++; st.chunkReads++;
            const part = prepared.subarray(start, start + size);
            const sz = Buffer.alloc(4); sz.writeUInt32LE(part.length, 0);
            send(C.PREPARE_DATA, reply, sz);
            for (let o2 = 0; o2 < part.length; o2 += st.frameSize) send(C.DATA, reply, part.subarray(o2, o2 + st.frameSize));
            send(C.OK, reply); break;
          }
          case C.FREE_DATA: prepared = null; st.freed++; send(C.OK, reply); break;
          case C.USER_WRQ: {
            let u;
            if (data.length === 72) {
              u = { uid: data.readUInt16LE(0), privilege: data[2], password: cut(data.subarray(3, 11)), name: cut(data.subarray(11, 35)),
                card: data.readUInt32LE(35), group: cut(data.subarray(40, 47)), userId: cut(data.subarray(48, 72)) };
            } else if (data.length === 28) {
              u = { uid: data.readUInt16LE(0), privilege: data[2], password: cut(data.subarray(3, 8)), name: cut(data.subarray(8, 16)),
                card: data.readUInt32LE(16), group: '1', userId: String(data.readUInt32LE(24)) };
            } else { send(C.ERROR, reply); break; }
            const i = st.users.findIndex((x) => x.uid === u.uid);
            if (i >= 0) st.users[i] = u; else st.users.push(u);
            send(C.OK, reply); break;
          }
          case C.DELETE_USER: {
            const uid = data.readUInt16LE(0);
            st.users = st.users.filter((x) => x.uid !== uid);
            send(C.OK, reply); break;
          }
          case C.REFRESH: case C.CANCELCAPTURE: case C.STARTENROLL: send(C.OK, reply); break;
          default: send(C.ERROR, reply);
        }
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        state: st,
        close: () => new Promise((r) => { for (const s of st.sockets) s.destroy(); server.close(() => r()); }),
      });
    });
  });
}
