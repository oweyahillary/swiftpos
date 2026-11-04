/**
 * customerSlides.ts — A606: the owner's customer-screen slideshow, kept on this PC so it shows offline.
 *
 * The list (an ordered list of the owner's uploaded images and how many seconds each shows) comes with the catalogue pull
 * (pos/init `customerScreen`, the change log's 'setup' topic, or a branch server's bundle) and is stored in
 * maintenance_state 'customer_screen' — no local schema change. The images are fetched ONCE each and kept in
 * <userData>/customer-screen/, named by the SHA-256 of their address: a pull that brings the same list again fetches
 * nothing, a new image fetches only itself, and an image taken off the list is deleted. Only with the online licence
 * (the slideshow is premium): without it nothing is downloaded at all. A failed download is not tried again for an hour.
 * Each file must be a JPEG, PNG or WebP of at most MAX_SLIDE_BYTES, or it is refused and never stored.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { slidesFromWire, SLIDE_TYPES, MAX_SLIDE_BYTES, type CustomerScreenSlides } from '@zaptill/core/customerScreen';

export const SLIDES_KEY = 'customer_screen';
export const RETRY_MS = 60 * 60_000;

export interface SlideStore { read(): string | null; write(v: string | null): void }
export interface SlideFetch {
  (url: string): Promise<{ ok: boolean; status: number; type: string; length: number | null; body(): Promise<Buffer> }>;
}

export interface SyncResult { fetched: number; kept: number; removed: number; refused: number; skipped: boolean }

export const slideKey = (url: string): string => crypto.createHash('sha256').update(url).digest('hex').slice(0, 40);
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MIME: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

/** JPEG / PNG / WebP by its first bytes — the file is what it says, not only its header. */
export function sniffImage(b: Buffer): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

export function createSlideCache(deps: { dir: string; store: SlideStore; fetch: SlideFetch; now(): number; log(l: string): void }) {
  const failedAt = new Map<string, number>();
  let running: Promise<SyncResult> | null = null;

  const list = (): CustomerScreenSlides | null => { try { return slidesFromWire(deps.store.read()); } catch { return null; } };

  /** undefined = not said (an older cloud or server) → keep; null = none. */
  const setList = (v: unknown): boolean => {
    if (v === undefined) return false;
    const clean = v === null ? null : slidesFromWire(v);
    const next = clean ? JSON.stringify(clean) : null;
    const before = deps.store.read();
    if (before === next) return false;
    deps.store.write(next);
    return true;
  };

  const files = (): string[] => { try { return fs.readdirSync(deps.dir); } catch { return []; } };
  const fileFor = (key: string): string | null => files().find((f) => f.startsWith(key + '.') && !f.endsWith('.part')) ?? null;

  /** Bring the cache in line with the list: fetch what is missing (once), delete what left the list. */
  const sync = (licensed: boolean): Promise<SyncResult> => {
    if (running) return running;
    running = (async (): Promise<SyncResult> => {
      const out: SyncResult = { fetched: 0, kept: 0, removed: 0, refused: 0, skipped: false };
      const l = list();
      const wanted = new Set((l?.slides ?? []).map((s) => slideKey(s.url)));
      // Images that left the list (or the whole list gone) — deleted, whatever the licence says.
      for (const f of files()) {
        if (f.endsWith('.part') || !wanted.has(f.split('.')[0])) { try { fs.unlinkSync(path.join(deps.dir, f)); out.removed++; } catch { /* in use */ } }
      }
      if (!licensed || !l) { out.skipped = true; return out; }
      for (const s of l.slides) {
        const key = slideKey(s.url);
        if (fileFor(key)) { out.kept++; continue; }
        const failed = failedAt.get(key);
        if (failed && deps.now() - failed < RETRY_MS) continue;
        try {
          const r = await deps.fetch(s.url);
          const type = String(r.type ?? '').split(';')[0].trim().toLowerCase();
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          if (!SLIDE_TYPES.includes(type)) throw new Error(`not an image (${type || 'no type'})`);
          if (r.length !== null && r.length > MAX_SLIDE_BYTES) throw new Error(`too large (${r.length} bytes)`);
          const body = await r.body();
          if (body.length > MAX_SLIDE_BYTES) throw new Error(`too large (${body.length} bytes)`);
          const real = sniffImage(body);
          if (!real) throw new Error('not a JPEG, PNG or WebP file');
          fs.mkdirSync(deps.dir, { recursive: true });
          const target = path.join(deps.dir, `${key}.${EXT[real]}`);
          fs.writeFileSync(target + '.part', body);
          fs.renameSync(target + '.part', target);
          failedAt.delete(key);
          out.fetched++;
        } catch (e) {
          failedAt.set(key, deps.now());
          out.refused++;
          deps.log(`customer screen image not kept (${(e as Error)?.message ?? e}) — tried again in an hour`);
        }
      }
      if (out.fetched) deps.log(`customer screen: ${out.fetched} image(s) kept for the slideshow`);
      return out;
    })().finally(() => { running = null; });
    return running;
  };

  /** The slideshow as the screen asks for it: the images this PC holds, in the owner's order (keys only). */
  const shown = (): { keys: string[]; seconds: number } | null => {
    const l = list();
    if (!l) return null;
    return { keys: l.slides.map((s) => slideKey(s.url)).filter((k) => !!fileFor(k)), seconds: l.seconds };
  };

  /** One image as a data URL (read from this PC — never the network), or null. */
  const image = (key: string): string | null => {
    if (!/^[0-9a-f]{40}$/.test(String(key))) return null;
    const f = fileFor(key);
    if (!f) return null;
    const mime = MIME[f.split('.').pop() ?? ''];
    if (!mime) return null;
    try { return `data:${mime};base64,${fs.readFileSync(path.join(deps.dir, f)).toString('base64')}`; } catch { return null; }
  };

  return { list, setList, sync, shown, image };
}

export type SlideCache = ReturnType<typeof createSlideCache>;
