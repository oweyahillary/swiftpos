/**
 * backfill-logos.test.mjs — the pure per-row decision in scripts/backfill-logos-to-cloudinary.mjs: who gets uploaded to
 * Cloudinary, who is skipped. The IO (Cloudinary POST, DB writes) is exercised by the owner's DRY RUN against prod, not
 * here; this guards the decision so a re-run never re-uploads a migrated business or an unexpected value.
 *
 *   node tests/backfill-logos.test.mjs
 *
 * MUTATIONS TO CONFIRM BITE:
 *   - planForRow uploading when logo_url is already set  → "a business already on a URL is skipped" fails
 *   - planForRow uploading a non-data-URI logo_png       → "a non-raster logo_png is skipped" fails
 */
import { planForRow } from '../scripts/backfill-logos-to-cloudinary.mjs';

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}  ${detail}`); } };

const PNG = 'data:image/png;base64,' + 'A'.repeat(4000);   // ~3 KB decoded
const JPG = 'data:image/jpeg;base64,AAAA';

ok('a base64 png with no URL → upload', planForRow({ logo_png: PNG, logo_url: null }).action === 'upload');
ok('a base64 jpeg with no URL → upload', planForRow({ logo_png: JPG, logo_url: null }).action === 'upload');
ok('upload reports an approximate KB size', planForRow({ logo_png: PNG, logo_url: null }).kb === Math.round((PNG.length * 0.75) / 1024));

ok('a business already on a URL is skipped (idempotent re-run)', planForRow({ logo_png: PNG, logo_url: 'https://res.cloudinary.com/x/logo.png' }).action === 'skip-has-url');
ok('a blank/whitespace URL does NOT count as migrated', planForRow({ logo_png: PNG, logo_url: '   ' }).action === 'upload');

ok('a null logo_png is skipped', planForRow({ logo_png: null, logo_url: null }).action === 'skip-bad-format');
ok('a non-raster logo_png is skipped (already a URL string, or junk)', planForRow({ logo_png: 'https://x/y.png', logo_url: null }).action === 'skip-bad-format');
ok('an svg data-URI is skipped (not png/jpeg)', planForRow({ logo_png: 'data:image/svg+xml;base64,AAAA', logo_url: null }).action === 'skip-bad-format');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
