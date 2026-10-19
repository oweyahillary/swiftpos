/**
 * compressJson.ts — A531: a JSON answer over 1 KB goes gzip-compressed to a client that accepts it.
 *
 * Measured after A528 (admin System page): /api/pos sent 5.0 MB in 36 minutes to about 4 tills — the whole menu (~300 KB,
 * the logo in base64 included) on every pull. JSON of a menu compresses about 5–10×. A till's fetch (Node's undici) asks
 * for gzip and unpacks it itself; the branch server's gateway passes the unpacked body on (nodeGateway.ts drops
 * Content-Encoding); a browser does the same.
 *
 * Why not the `compression` package: it streams (chunked), so the answer has no Content-Length — and A528's traffic
 * counter (lib/trafficStats.ts) reads the bytes from that header, so the System page would show 0 bytes for every
 * compressed answer. Here the body is already whole (res.json → res.send), so it is packed in one go (zlib, the standard
 * library — no new dependency) and sent with its real, compressed length. ETag and a 304 still work (express computes them
 * from the bytes sent).
 *
 * Never: an answer that is not JSON, one already encoded, a HEAD, a 204/304, anything streamed or redirected (they never
 * pass through res.send with a JSON body — the update downloads under /api/desktop-update/ are skipped by path as well).
 */
import zlib from 'zlib';
import type { Request, Response, NextFunction } from 'express';

export const COMPRESS_MIN_BYTES = 1024;
const SKIP_PATH = /^\/api\/desktop-update\//;

/** gzip / deflate / null for an Accept-Encoding header (q=0 means no). Pure. */
export function pickEncoding(accept: string | undefined | null): 'gzip' | 'deflate' | null {
  const parts = String(accept ?? '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  const ok = (name: string) => parts.some((p) => {
    const [n, ...params] = p.split(';').map((s) => s.trim());
    if (n !== name && n !== '*') return false;
    const q = params.find((x) => x.startsWith('q='));
    return !q || Number(q.slice(2)) > 0;
  });
  if (ok('gzip')) return 'gzip';
  if (ok('deflate')) return 'deflate';
  return null;
}

export function compressJson(req: Request, res: Response, next: NextFunction): void {
  const path = req.originalUrl || req.url || '';
  const enc = pickEncoding(req.headers['accept-encoding'] as string | undefined);
  if (!enc || req.method === 'HEAD' || SKIP_PATH.test(path)) { next(); return; }
  const send = res.send.bind(res);
  res.send = function compressedSend(body?: unknown): Response {
    try {
      const type = String(res.getHeader('Content-Type') ?? '');
      const sized = typeof body === 'string' ? Buffer.byteLength(body) : Buffer.isBuffer(body) ? body.length : 0;
      if ((typeof body === 'string' || Buffer.isBuffer(body)) && /json/i.test(type) && sized >= COMPRESS_MIN_BYTES
          && !res.getHeader('Content-Encoding') && res.statusCode !== 204 && res.statusCode !== 304) {
        const raw = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
        const packed = enc === 'gzip' ? zlib.gzipSync(raw, { level: 6 }) : zlib.deflateSync(raw, { level: 6 });
        res.setHeader('Content-Encoding', enc);
        res.append('Vary', 'Accept-Encoding');
        res.send = send;   // once
        return send(packed);
      }
    } catch { /* never fail an answer over compression: sent as it is */ }
    res.send = send;
    return send(body as never);
  } as Response['send'];
  next();
}
