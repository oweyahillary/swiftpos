/**
 * branding-set.test.mjs — the A301 branding WRITE path.
 *
 * Two parts, best-evidence first:
 *   1. The REAL compiled dist/main/brandingGuard.js — the pure guard that actually enforces
 *      accent-hex / PNG-JPEG / 250 KB / SVG-reject. Runs on plain Node (no SQLite, no
 *      Electron), the same route contrast.test.mjs takes, so this pins the enforcement, not
 *      a copy of it (rule 24).
 *   2. UPSERT + merge semantics against a real SQLite :memory: db. Importing the real
 *      setBranding needs Electron (localDb imports `app`), so — exactly as heldOrders.test.mjs
 *      does — this MIRRORS setBranding's SQL against the real driver. check-table-usage guards
 *      that the table name stays in step with the real code.
 *
 * !! NOT YET RUN ON A BENCH !!  This file was authored without building dist/ or running under
 * Electron (delivered off-target). Before trusting it, the next session MUST, in apps/desktop:
 *     npx tsc -b tsconfig.main.json --force
 *     ELECTRON_RUN_AS_NODE=1 npx electron test/branding-set.test.mjs   (or: node test/branding-set.test.mjs)
 * and MUTATION-CHECK each guard below — reintroduce the defect, confirm the named assertion
 * goes red, restore it (rules 10, 23). A test that passes with the bug present is decoration.
 *
 * MUTATIONS TO CONFIRM BITE (each must turn exactly the named assertion red):
 *   - drop the SVG_DATA_URI reject in brandingGuard      -> "SVG logo rejected (svg-specific msg)"
 *     fails. NB: the input still THROWS via the raster allow-list (defence in depth), so the
 *     assertion matches the MESSAGE, not just that it threw — a bare throws() would not bite here
 *     (rule 24: a mutation check must measure the right thing, not merely notice a change).
 *   - drop the RASTER_DATA_URI check                     -> "non-raster data-URI rejected" fails
 *   - remove the > MAX_LOGO_BYTES throw                  -> "oversize logo rejected" fails
 *   - loosen the HEX regex (e.g. drop the anchors)       -> "junk accent rejected" fails
 *   - make base64Bytes ignore padding                    -> "base64Bytes counts padding" fails
 *   - change the merge to always overwrite (drop the     -> "accent-only write keeps logo" fails
 *     `=== undefined ? existing…` COALESCE in the mirror)
 */
import assert from 'assert';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main', 'brandingGuard.js');
if (!fs.existsSync(dist)) {
  console.error('dist/main/brandingGuard.js not built. In apps/desktop run:  npx tsc -b tsconfig.main.json --force');
  process.exit(1);
}
const { validateBrandingWrite, base64Bytes, MAX_LOGO_BYTES } = await import(pathToFileURL(dist).href);

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}`); } };
const throws = (label, fn) => { let t = false; try { fn(); } catch { t = true; } ok(label, t); };
// Throws AND the message matches — needed where two guards both reject the same input, so the
// bare "did it throw" cannot tell which branch fired (rule 24). Wrong message => fail.
const throwsMsg = (label, re, fn) => { let m = ''; try { fn(); } catch (e) { m = String(e && e.message); } ok(label, re.test(m)); };

// A real (tiny, transparent) 1x1 PNG data-URI — a legitimate raster logo, well under the cap.
const PNG_1x1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
// A data-URI whose base64 body decodes to > 250 KB, to trip the size cap.
const PNG_TOO_BIG = 'data:image/png;base64,' + 'A'.repeat(400_000);

// ── base64 size accounting ──────────────────────────────────────────────────
ok('base64Bytes counts padding', base64Bytes('data:image/png;base64,QUJD') === 3 // "ABC"
  && base64Bytes('data:image/png;base64,QUI=') === 2);                            // "AB"
ok('oversize sample really is over the cap', base64Bytes(PNG_TOO_BIG) > MAX_LOGO_BYTES);

// ── accent validation ───────────────────────────────────────────────────────
ok('6-digit hex accepted + lowercased', validateBrandingWrite({ accentHex: '#0D9488' }).accentHex === '#0d9488');
ok('3-digit hex accepted',              validateBrandingWrite({ accentHex: '#0af' }).accentHex === '#0af');
throws('junk accent rejected',          () => validateBrandingWrite({ accentHex: 'teal' }));
throws('short hex rejected',            () => validateBrandingWrite({ accentHex: '#12' }));
ok('null accent = clear (passes)',      validateBrandingWrite({ accentHex: null }).accentHex === null);
ok('omitted accent = undefined',        validateBrandingWrite({}).accentHex === undefined);

// ── logo validation ─────────────────────────────────────────────────────────
ok('valid small PNG accepted',          validateBrandingWrite({ logoPng: PNG_1x1 }).logoPng === PNG_1x1);
// Assert the SVG-SPECIFIC message: an SVG is also caught by the raster allow-list below, so a
// bare throws() would pass even with the SVG branch removed (defence in depth). Matching /svg/i
// pins the dedicated SVG reject and its "needs the sanitiser slice" message.
throwsMsg('SVG logo rejected (svg-specific msg)', /svg/i, () => validateBrandingWrite({ logoPng: 'data:image/svg+xml;base64,PHN2Zy8+' }));
throws('non-raster data-URI rejected',  () => validateBrandingWrite({ logoPng: 'data:text/html;base64,PGI+' }));
throws('bare (non-data-URI) rejected',  () => validateBrandingWrite({ logoPng: 'not-a-data-uri' }));
throws('oversize logo rejected',        () => validateBrandingWrite({ logoPng: PNG_TOO_BIG }));
ok('null logo = clear (passes)',        validateBrandingWrite({ logoPng: null }).logoPng === null);

// ── UPSERT + merge semantics (real driver, SQL mirrors setBranding) ──────────
let db = null;
try {
  const require = createRequire(import.meta.url);
  const Database = require('better-sqlite3');
  db = new Database(':memory:');
} catch {
  try { const { DatabaseSync } = await import('node:sqlite'); db = new DatabaseSync(':memory:'); }
  catch { console.log('\n(skip UPSERT section — no SQLite driver on this runtime; guard part above still ran)'); }
}
if (db) {
  db.exec(`CREATE TABLE IF NOT EXISTS branding (
    business_id TEXT PRIMARY KEY, accent_hex TEXT, logo_png TEXT, logo_receipt TEXT, synced_at TEXT);`);

  // Mirror of setBranding's read-merge-write. The REAL setBranding wraps this in a
  // db.transaction() for concurrency; here the statements run sequentially so the section
  // works on BOTH better-sqlite3 and the node:sqlite stand-in (which has no .transaction).
  // This section checks MERGE SEMANTICS (undefined=keep, null=clear, value=set), not the
  // transaction guarantee — that is a real-driver concern, exercised under Electron.
  const write = (businessId, w) => {
    const clean = validateBrandingWrite(w);
    const now = new Date().toISOString();
    const ex = db.prepare(`SELECT accent_hex, logo_png FROM branding WHERE business_id = ?`).get(businessId);
    const accent = clean.accentHex === undefined ? (ex?.accent_hex ?? null) : clean.accentHex;
    const logo   = clean.logoPng   === undefined ? (ex?.logo_png ?? null)   : clean.logoPng;
    db.prepare(`INSERT INTO branding (business_id, accent_hex, logo_png, synced_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(business_id) DO UPDATE SET
                  accent_hex = excluded.accent_hex, logo_png = excluded.logo_png, synced_at = excluded.synced_at`)
      .run(businessId, accent, logo, now);
    return { accentHex: accent, logoPng: logo };
  };
  const read = (businessId) => db.prepare(`SELECT accent_hex, logo_png FROM branding WHERE business_id = ?`).get(businessId);

  write('biz1', { accentHex: '#0d9488', logoPng: PNG_1x1 });
  ok('row upserted', (() => { const r = read('biz1'); return r.accent_hex === '#0d9488' && r.logo_png === PNG_1x1; })());

  write('biz1', { accentHex: '#e1251b' }); // accent only — logo must survive
  ok('accent-only write keeps logo', (() => { const r = read('biz1'); return r.accent_hex === '#e1251b' && r.logo_png === PNG_1x1; })());

  write('biz1', { logoPng: null }); // clear the logo, keep accent
  ok('null logo clears, accent kept', (() => { const r = read('biz1'); return r.logo_png === null && r.accent_hex === '#e1251b'; })());

  ok('single row per business', db.prepare(`SELECT COUNT(*) c FROM branding WHERE business_id = ?`).get('biz1').c === 1);
}


// ── A312: receipt-raster pixels + toggle through the REAL guard ────────────────────────────
console.log('\nA312 — logoRgba + receiptLogoEnabled');
const px = (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
ok('A312: valid pixels pass through untouched', (() => { const c = validateBrandingWrite({ logoRgba: px(384, 240) }); return c.logoRgba && c.logoRgba.width === 384 && c.logoRgba.data.length === 384 * 240 * 4; })());
throwsMsg('A312: too wide is refused at the door', /exceed 384x240/, () => validateBrandingWrite({ logoRgba: px(385, 10) }));
throwsMsg('A312: too tall is refused at the door', /exceed 384x240/, () => validateBrandingWrite({ logoRgba: px(10, 241) }));
throwsMsg('A312: data length must be w*h*4', /RGBA bytes/, () => validateBrandingWrite({ logoRgba: { width: 8, height: 1, data: new Uint8ClampedArray(31) } }));
throwsMsg('A312: non-integer dims refused', /bad dimensions/, () => validateBrandingWrite({ logoRgba: { width: 8.5, height: 1, data: new Uint8ClampedArray(34) } }));
ok('A312: undefined pixels = keep stored raster', validateBrandingWrite({ accentHex: '#0d9488' }).logoRgba === undefined);
ok('A312: clearing the logo ALSO clears the raster (null)', validateBrandingWrite({ logoPng: null }).logoRgba === null);
ok('A312: explicit pixels survive a logo clear (odd but explicit wins)', validateBrandingWrite({ logoPng: null, logoRgba: px(8, 1) }).logoRgba !== null);
ok('A312: toggle true/false pass', validateBrandingWrite({ receiptLogoEnabled: true }).receiptLogoEnabled === true && validateBrandingWrite({ receiptLogoEnabled: false }).receiptLogoEnabled === false);
throwsMsg('A312: toggle must be a boolean', /true or false/, () => validateBrandingWrite({ receiptLogoEnabled: 'yes' }));
ok('A312: toggle undefined = keep', validateBrandingWrite({}).receiptLogoEnabled === undefined);

// ── A312: the REAL setBranding INSERT + merge, extracted from localDb.ts and executed ──────
// setBranding itself needs better-sqlite3 under Electron's ABI (rule 9), so — as the A311 test
// does — the statement and the CREATE TABLE are lifted from source and run on node:sqlite. The
// merge logic (undefined keeps / null clears / value sets) is exercised by feeding the derived
// values the way setBranding computes them.
const ldbSrc = fs.readFileSync(path.join(here, '..', 'src', 'main', 'localDb.ts'), 'utf8');
const fnSrc = ldbSrc.slice(ldbSrc.indexOf('export function setBranding'));
const sqlM = /`(\s*INSERT INTO branding[\s\S]*?)`\s*,?\s*\)\.run\(([\s\S]*?)\);/.exec(fnSrc);
const createM = /CREATE TABLE IF NOT EXISTS branding \(([\s\S]*?)\);/.exec(ldbSrc);
ok('A312: found setBranding upsert + CREATE TABLE in source', !!sqlM && !!createM);
ok('A312: setBranding uses the shared thresholder, never its own', /monoRasterFromRGBA\(/.test(fnSrc) && /monoRasterToString\(/.test(fnSrc));
ok('A312: thresholding happens OUTSIDE the transaction', fnSrc.indexOf('monoRasterFromRGBA(') < fnSrc.indexOf('db.transaction('));
let sq = null;
try { ({ DatabaseSync: sq } = await import('node:sqlite')); } catch { console.log('  (node:sqlite unavailable — SQL execution skipped, source guards ran)'); }
if (sqlM && createM && sq) {
  const args = sqlM[2].split(',').length, qs = (sqlM[1].match(/\?/g) || []).length;
  ok(`A312: bind count matches placeholders (${args} args, ${qs} ?)`, args === qs);
  const d = new sq(':memory:');
  d.exec(`CREATE TABLE IF NOT EXISTS branding (${createM[1]});`);
  const st = d.prepare(sqlM[1]);
  const read = () => d.prepare(`SELECT * FROM branding WHERE business_id='B1'`).get();
  ok('A312: the real statement executes', (() => { try { st.run('B1', '#0d9488', 'png', 'mono1:8:1:AA==', 1, 'now'); return true; } catch (e) { console.log('      ' + e.message); return false; } })());
  ok('A312: raster + toggle stored', (() => { const r = read(); return r.logo_receipt === 'mono1:8:1:AA==' && r.receipt_logo_enabled === 1; })());
  st.run('B1', '#0d9488', 'png', 'mono1:8:1:AA==', 0, 'now2');
  ok('A312: toggle off keeps the raster (the client can re-enable without re-uploading)', (() => { const r = read(); return r.logo_receipt === 'mono1:8:1:AA==' && r.receipt_logo_enabled === 0; })());
  st.run('B1', null, null, null, 0, 'now3');
  ok('A312: clear wipes all four', (() => { const r = read(); return r.accent_hex === null && r.logo_png === null && r.logo_receipt === null && r.receipt_logo_enabled === 0; })());
  d.close();
}

// ── A312: the print path gates on the toggle AND the raster ────────────────────────────────
const ih = fs.readFileSync(path.join(here, '..', 'src', 'main', 'ipcHandlers.ts'), 'utf8');
ok('A312: print config passes logoRaster via resolveReceiptLogo()', /logoRaster:\s*resolveReceiptLogo\(\)/.test(ih));
const rr = /function resolveReceiptLogo\(\)[\s\S]*?\n\}/.exec(ih)?.[0] ?? '';
ok('A312: resolveReceiptLogo requires the toggle ON', /!b\.receiptLogoEnabled/.test(rr));
ok('A312: resolveReceiptLogo requires a raster', /!b\.logoReceipt/.test(rr));
ok('A312: resolveReceiptLogo decodes via shared/printing (malformed → nothing)', /monoRasterFromString\(b\.logoReceipt\)/.test(rr));
const sch = fs.readFileSync(path.join(here, '..', 'src', 'main', 'ipcSchemas.ts'), 'utf8');
ok('A312: branding:set schema admits logoRgba + boolean toggle', /'branding:set':[^\n]*logoRgba:\s*\{\s*t:\s*'any'/.test(sch) && /'branding:set':[^\n]*receiptLogoEnabled:\s*\{\s*t:\s*'boolean'/.test(sch));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
