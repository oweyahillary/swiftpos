/**
 * raster.test — A310: the mono raster and its journey to GS v 0 bytes.
 *
 * Money isn't at stake here; paper is. The failure modes this pins: a wrong
 * xL/xH (the printer eats the receipt as image data and prints garbage), a
 * transparent logo printing as a black box, a logo on a KITCHEN ticket, and a
 * stored raster the till can't parse crashing the print path instead of
 * printing no logo. Every assertion here is mutation-checked (rule 10/23).
 * Section 8 (A316) runs the string codec with globalThis.Buffer DELETED: restore
 * Buffer in raster.ts and the first four go red; drop the strip-and-repad and
 * the padding case goes red on its own; make decoding skip unknown characters
 * and the alphabet case goes red on its own.
 */
import {
  monoRasterFromRGBA, monoRasterToString, monoRasterFromString, monoRasterToAscii,
  bytesPerRow, renderTicket, toEscPos, toPreview, receiptPreset, kitchenPreset,
  RECEIPT_LOGO_MAX_WIDTH, PRINTER_MAX_DOTS,
} from '../src/index';
import { order, business } from './fixture';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}  ${detail}`); }
};

const rgba = (w: number, h: number, f: (x: number, y: number) => [number, number, number, number]) => {
  const a = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b, al] = f(x, y); const p = (y * w + x) * 4;
    a[p] = r; a[p + 1] = g; a[p + 2] = b; a[p + 3] = al;
  }
  return a;
};

console.log('\n1. Packing — MSB first, 1 = black, rows byte-padded');
{
  // 10 wide x 2 tall: row 0 = black,white,black,... ; row 1 = all white
  const r = monoRasterFromRGBA(rgba(10, 2, (x, y) => y === 0 && x % 2 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]), 10, 2);
  ok('width/height preserved under the cap', r.width === 10 && r.height === 2);
  ok('2 bytes per 10-px row', bytesPerRow(10) === 2 && r.bytes.length === 4);
  ok('row 0 packs to 0xAA 0x80 (bits 0,2,4,6,8 set)', r.bytes[0] === 0xaa && r.bytes[1] === 0x80, `${r.bytes[0].toString(16)} ${r.bytes[1].toString(16)}`);
  ok('row 1 is all zero', r.bytes[2] === 0 && r.bytes[3] === 0);
  ok('ascii view agrees', monoRasterToAscii(r)[0] === '# # # # # ' && monoRasterToAscii(r)[1] === '          ');
}

console.log('\n2. Transparency composites onto WHITE, not black');
{
  const r = monoRasterFromRGBA(rgba(8, 1, () => [0, 0, 0, 0]), 8, 1);        // fully transparent black
  ok('transparent pixels print white (0x00)', r.bytes[0] === 0x00, `${r.bytes[0]}`);
  const r2 = monoRasterFromRGBA(rgba(8, 1, () => [0, 0, 0, 255]), 8, 1);     // opaque black
  ok('opaque black prints black (0xFF)', r2.bytes[0] === 0xff);
}

console.log('\n3. Threshold — luminance strictly below prints black');
{
  const grey = (v: number) => monoRasterFromRGBA(rgba(8, 1, () => [v, v, v, 255]), 8, 1).bytes[0];
  ok('127 is black at default 128', grey(127) === 0xff);
  ok('128 is white at default 128', grey(128) === 0x00);
  const custom = monoRasterFromRGBA(rgba(8, 1, () => [200, 200, 200, 255]), 8, 1, { threshold: 220 }).bytes[0];
  ok('a higher threshold pulls light grey to black', custom === 0xff);
  // A black mark on a yellow field → the yellow field must go WHITE (lum 0.299*245+0.587*184+0.114*0 ≈ 181)
  const yellow = monoRasterFromRGBA(rgba(8, 1, () => [245, 184, 0, 255]), 8, 1).bytes[0];
  ok('a yellow field thresholds to white (black-on-yellow logo)', yellow === 0x00);
}

console.log('\n4. Downsample — shrink-not-crop to the 58 mm head');
{
  const r = monoRasterFromRGBA(rgba(768, 100, () => [0, 0, 0, 255]), 768, 100);
  ok('768 wide becomes 384', r.width === RECEIPT_LOGO_MAX_WIDTH, `${r.width}`);
  ok('height scales by the same factor (100 → 50)', r.height === 50, `${r.height}`);
  ok('bytes match the new geometry', r.bytes.length === bytesPerRow(384) * 50);
  const tall = monoRasterFromRGBA(rgba(100, 960, () => [0, 0, 0, 255]), 100, 960);
  ok('tall logos are capped by height, aspect kept (100x960 → 25x240)', tall.width === 25 && tall.height === 240, `${tall.width}x${tall.height}`);
  ok('bad RGBA length throws', (() => { try { monoRasterFromRGBA(new Uint8Array(3), 1, 1); return false; } catch { return true; } })());
}

console.log('\n5. String round-trip — the stored form on both sides');
{
  const r = monoRasterFromRGBA(rgba(12, 3, (x, y) => (x + y) % 3 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]), 12, 3);
  const s = monoRasterToString(r);
  ok('prefix + dims', s.startsWith('mono1:12:3:'), s.slice(0, 12));
  const back = monoRasterFromString(s);
  ok('round-trips exactly', !!back && back.width === 12 && back.height === 3 && Buffer.from(back.bytes).equals(Buffer.from(r.bytes)));
  ok('null/empty → null', monoRasterFromString(null) === null && monoRasterFromString('') === null);
  ok('wrong prefix → null', monoRasterFromString('png:1:1:AA==') === null);
  ok('length mismatch → null (a truncated column never reaches the printer)', monoRasterFromString('mono1:12:3:AA==') === null);
  ok('wider than any head → null', monoRasterFromString(`mono1:${PRINTER_MAX_DOTS + 8}:1:${Buffer.alloc(bytesPerRow(PRINTER_MAX_DOTS + 8)).toString('base64')}`) === null);
}

console.log('\n6. ESC/POS — GS v 0 with the right geometry, centred, receipt only');
{
  const r = monoRasterFromRGBA(rgba(20, 3, () => [0, 0, 0, 255]), 20, 3);   // 3 bytes/row, 3 rows = 9 data bytes
  const st = receiptPreset('r', 'Receipt', 80);
  const withLogo = toEscPos(renderTicket({ order, business: { ...business, logoRaster: r }, station: st }));
  const without = toEscPos(renderTicket({ order, business, station: st }));
  const i = withLogo.indexOf(Buffer.from([0x1d, 0x76, 0x30, 0x00]));
  ok('GS v 0 present with a logo', i > 0);
  ok('absent without one', without.indexOf(Buffer.from([0x1d, 0x76, 0x30, 0x00])) === -1);
  ok('xL xH = 3 bytes per row', withLogo[i + 4] === 3 && withLogo[i + 5] === 0, `${withLogo[i + 4]} ${withLogo[i + 5]}`);
  ok('yL yH = 3 rows', withLogo[i + 6] === 3 && withLogo[i + 7] === 0);
  const rows = withLogo.subarray(i + 8, i + 17);
  ok('9 data bytes follow: FF FF F0 per row (20 px, 4 padding bits stay WHITE)', rows.length === 9 && [0, 3, 6].every(o => rows[o] === 0xff && rows[o + 1] === 0xff && rows[o + 2] === 0xf0), Buffer.from(rows).toString('hex'));
  ok('centre alignment set before the image', withLogo.subarray(0, i).lastIndexOf(Buffer.from([0x1b, 0x61, 0x01])) >= 0);
  ok('the logo precedes the business name', i < withLogo.indexOf(Buffer.from(business.name.toUpperCase().slice(0, 6))) || i < withLogo.indexOf(Buffer.from(business.name.slice(0, 6))));
  ok('no-logo stream is byte-identical to a config without the field', without.equals(toEscPos(renderTicket({ order, business: { ...business, logoRaster: undefined }, station: st }))));
  // the byte budget: exactly header + data added, nothing else moved
  ok('with-logo adds exactly the GS v 0 header + data (+ any align switch)', withLogo.length - without.length === 8 + 9 || withLogo.length - without.length === 8 + 9 + 3, `${withLogo.length - without.length}`);

  const kt = toEscPos(renderTicket({ order, business: { ...business, logoRaster: r }, station: kitchenPreset('k', 'Kitchen', 80) }));
  ok('KITCHEN ticket never carries the logo', kt.indexOf(Buffer.from([0x1d, 0x76, 0x30, 0x00])) === -1);

  const bad = { width: 20, height: 3, bytes: new Uint8Array(5) };               // length mismatch
  const dropped = toEscPos(renderTicket({ order, business: { ...business, logoRaster: bad }, station: st }));
  ok('a malformed raster is DROPPED, not sent (stream == no-logo stream)', dropped.equals(without));
}

console.log('\n7. Text preview names the logo and its size');
{
  const r = monoRasterFromRGBA(rgba(20, 3, () => [0, 0, 0, 255]), 20, 3);
  const p = toPreview(renderTicket({ order, business: { ...business, logoRaster: r }, station: receiptPreset('r', 'Receipt', 80) }));
  ok('preview shows [logo 20x3]', /\[logo 20x3\]/.test(p));
}

console.log('\n8. The string codec needs no Buffer (A316 — the web runs this in a browser)');
{
  // The cloud's own acceptance test for the stored form (apps/server/src/routes/business.ts):
  // this regex, then the decoded length must be ceil(w/8)*h.
  const CLOUD = /^mono1:(\d+):(\d+):([A-Za-z0-9+/]+={0,2})$/;
  const cloudAccepts = (s: string) => {
    const m = CLOUD.exec(s); if (!m) return false;
    const w = Number(m[1]), h = Number(m[2]);
    return w <= 576 && h <= 1024 && Buffer.from(m[3], 'base64').length === bytesPerRow(w) * h;
  };
  const logo = monoRasterFromRGBA(rgba(20, 3, (x) => (x % 3 ? [0, 0, 0, 255] : [255, 255, 255, 255])), 20, 3);
  const withNode = monoRasterToString(logo);

  // Browser conditions: no Buffer at all while the codec runs. Restored before
  // anything else in this file needs it.
  const g = globalThis as { Buffer?: unknown };
  const saved = g.Buffer;
  let noBuf = '', back: ReturnType<typeof monoRasterFromString> = null, threw = '';
  try {
    delete g.Buffer;
    noBuf = monoRasterToString(logo);
    back = monoRasterFromString(noBuf);
  } catch (e) { threw = String(e); } finally { g.Buffer = saved; }

  ok('encodes with no Buffer in scope (no throw)', threw === '', threw);
  ok('the no-Buffer string is one the CLOUD accepts', cloudAccepts(noBuf),
    `${noBuf.slice(0, 40)} — the 2026-09-23 web save was rejected with exactly this check`);
  ok('identical to what the till (Node) stores — no format change on either side', noBuf === withNode);
  ok('decodes with no Buffer in scope, byte-for-byte', !!back && back.width === 20 && back.height === 3
    && Buffer.from(back.bytes).equals(Buffer.from(logo.bytes)));

  // Decode reads what the CLOUD stored, however it was padded (its regex allows 0-2 '=').
  const b64 = withNode.split(':')[3], bare = b64.replace(/=+$/, '');
  ok('unpadded and odd-padded values the cloud accepts still decode',
    [bare, bare + '=', bare + '=='].every(v => cloudAccepts(`mono1:20:3:${v}`)
      ? !!monoRasterFromString(`mono1:20:3:${v}`) : true));
  // INSERTED, not replaced: a decoder that skips the stray '*' would recover the
  // exact right length and pass the length check — the thing to catch.
  const stray = `mono1:20:3:${b64.slice(0, 4)}*${b64.slice(4)}`;
  ok('characters outside the cloud\'s alphabet are refused, not skipped',
    !cloudAccepts(stray) && monoRasterFromString(stray) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
