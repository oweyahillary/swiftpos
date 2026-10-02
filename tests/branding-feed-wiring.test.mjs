/**
 * branding-feed-wiring.test.mjs — A302: the tech-gated branding FEED is actually wired.
 *
 *   node tests/branding-feed-wiring.test.mjs
 *
 * The feed is UI (an accent picker + a logo upload inside TechPage) whose real proof is a
 * human looking at the lock screen — that's target-only (rule 16). This guards every piece
 * that IS checkable in source, so the feed can't silently rot into a dead panel:
 *   - BrandingEditor calls posApi.branding.set (the A301 write path)
 *   - it takes the businessId from the owner session (the branding row's PK)
 *   - the logo goes through prepareRasterLogo (raster shrink; SVG rejected there)
 *   - every write is audited via posApi.tech.logAction
 *   - the logo <input> accepts PNG/JPEG only
 *   - Save is guarded on a known businessId
 *   - accent legibility is previewed with the same resolveBranding guard the lock screen uses
 *   - TechPage mounts <BrandingEditor/>
 *
 * MUTATIONS TO CONFIRM BITE (each turns exactly the named assertion red):
 *   - drop the posApi.branding.set call            -> "calls branding.set" fails
 *   - hardcode businessId instead of the session   -> "reads businessId from the session" fails
 *   - remove the prepareRasterLogo call            -> "logo goes through prepareRasterLogo" fails
 *   - remove the tech.logAction calls              -> "writes are audited" fails
 *   - widen accept to image/*                       -> "logo input is PNG/JPEG only" fails
 *   - remove <BrandingEditor/> from TechPage        -> "TechPage mounts BrandingEditor" fails
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}  ${detail}`); }
};

const be = r('apps/desktop/src/renderer/pages/BrandingEditor.tsx');
const tech = r('apps/desktop/src/renderer/pages/TechPage.tsx');

ok('calls branding.set (the A301 write path)',
   /posApi\.branding\.set\(/.test(be),
   'BrandingEditor must call posApi.branding.set');

ok('reads businessId from the session (row PK), not hardcoded',
   /getSession\(\)/.test(be) && /business\??\.id/.test(be) && /businessId/.test(be),
   'businessId must come from posApi.auth.getSession().business.id');

ok('logo goes through prepareRasterLogo',
   /prepareRasterLogo\(/.test(be) && /import\s*\{[^}]*prepareRasterLogo/.test(be),
   'the picked file must be shrunk/validated by prepareRasterLogo');

ok('writes are audited via tech.logAction',
   /posApi\.tech\.logAction\(\s*['"]tech\.branding\.set/.test(be)
     && /posApi\.tech\.logAction\(\s*['"]tech\.branding\.clear/.test(be),
   'both set and clear must audit');

ok('logo input is PNG/JPEG only (no image/*, no SVG)',
   /accept=["']image\/png,image\/jpeg["']/.test(be) && !/image\/\*/.test(be) && !/svg/i.test(be.match(/accept=["'][^"']*["']/)?.[0] ?? ''),
   'the file input must accept only image/png,image/jpeg');

ok('Save is guarded on a known businessId',
   /!businessId/.test(be),
   'Save must be disabled / refuse when businessId is null');

ok('accent legibility previewed with resolveBranding',
   /resolveBranding\(/.test(be) && /import\s*\{[^}]*resolveBranding/.test(be),
   'the editor should preview legibility with the same guard the lock screen uses');

ok('TechPage imports and mounts BrandingEditor',
   /import\s+BrandingEditor\s+from\s+['"]\.\/BrandingEditor['"]/.test(tech)
     && /<BrandingEditor\s*\/>/.test(tech),
   'TechPage must render <BrandingEditor/>');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
