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

  // Mirror of setBranding's read-merge-write (undefined = keep, null = clear, value = set).
  const write = (businessId, w) => {
    const clean = validateBrandingWrite(w);
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      const ex = db.prepare(`SELECT accent_hex, logo_png FROM branding WHERE business_id = ?`).get(businessId);
      const accent = clean.accentHex === undefined ? (ex?.accent_hex ?? null) : clean.accentHex;
      const logo   = clean.logoPng   === undefined ? (ex?.logo_png ?? null)   : clean.logoPng;
      db.prepare(`INSERT INTO branding (business_id, accent_hex, logo_png, synced_at)
                  VALUES (?, ?, ?, ?)
                  ON CONFLICT(business_id) DO UPDATE SET
                    accent_hex = excluded.accent_hex, logo_png = excluded.logo_png, synced_at = excluded.synced_at`)
        .run(businessId, accent, logo, now);
      return { accentHex: accent, logoPng: logo };
    });
    return tx();
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
