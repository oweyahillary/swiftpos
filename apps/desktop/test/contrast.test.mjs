/**
 * contrast.test.mjs — the A295 accent guard (shared/contrast.ts).
 *
 * Drives the REAL compiled dist/main/contrast.js. The module is pure (no SQLite,
 * no Electron, no DOM), so it runs on plain Node — the same route as
 * node-reference-bundle.test.mjs. This proves the MATHS and the accept/reject
 * decision; it does NOT prove the PinPage wiring or the branding read, which are
 * target-only (rule 16).
 *
 * WHAT THIS PINS — the ways a wrong guard corrupts a screen SILENTLY:
 *   - pickButtonText must choose by higher contrast. If it were hardwired to
 *     white, a yellow accent's Enter label (1.79:1) would be invisible; the
 *     Taste-yellow assertion below fails under that mutation.
 *   - resolveBranding must REJECT an illegible accent, not render it. If the
 *     legibility gate were dropped, a near-surface accent would paint an
 *     invisible divider; the fallback assertion fails under that mutation.
 *   - normalizeHex must reject junk (so a bad client value becomes fallback, not
 *     a thrown render). The invalid-hex assertion pins that.
 *
 * The mutation checks above were run on the bench (each mutation turns the suite
 * red) before this file was committed — rule 10: a test that passes with the bug
 * present is decoration.
 *
 * Run:  npx tsc -b tsconfig.main.json --force      (in apps/desktop)
 *       node test/contrast.test.mjs
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main', 'contrast.js');
if (!fs.existsSync(dist)) {
  console.error('dist/main/contrast.js not built. In apps/desktop run:  npx tsc -b tsconfig.main.json --force');
  process.exit(1);
}
const { contrastRatio, pickButtonText, resolveBranding, normalizeHex, DEFAULT_ACCENT, MIN_RATIO } =
  await import(pathToFileURL(dist).href);

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}`); } };
const near = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;

// current-theme surfaces the accent is measured against
const CARD = '#0d1424';   // lock-screen card (divider / active dot sit here)

// ── WCAG ratios (surface-independent, text-vs-accent) ───────────────────────
ok('yellow #F5B800 on black ~11.74', near(contrastRatio('#F5B800', '#000000'), 11.74));
ok('yellow #F5B800 on white ~1.79',  near(contrastRatio('#F5B800', '#ffffff'), 1.79));
ok('red    #E1251B on white ~4.69',  near(contrastRatio('#E1251B', '#ffffff'), 4.69));
ok('contrast is symmetric',          near(contrastRatio('#123456', '#abcdef'), contrastRatio('#abcdef', '#123456')));

// ── button-text decision (rule B) ───────────────────────────────────────────
ok('light accent -> BLACK button text', pickButtonText('#F5B800').text === '#000000');
ok('dark  accent -> WHITE button text', pickButtonText('#E1251B').text === '#ffffff');
ok('green default -> BLACK button text', pickButtonText(DEFAULT_ACCENT).text === '#000000');

// ── hex normalisation ───────────────────────────────────────────────────────
ok('3-digit hex expands',   normalizeHex('#0af') === '#00aaff');
ok('6-digit hex lowercased', normalizeHex('#F5B800') === '#f5b800');
ok('junk hex -> null',      normalizeHex('teal') === null && normalizeHex('#12') === null);

// ── resolveBranding: keep a legible accent ──────────────────────────────────
const kept = resolveBranding('#F5B800', CARD);
ok('legible accent kept',            kept.usedFallback === false && kept.accent === '#f5b800');
ok('kept accent picks black text',   kept.buttonText === '#000000');
ok('kept accent visible on card',    kept.accentOnSurface >= MIN_RATIO);

// ── resolveBranding: reject an illegible / missing / junk accent ─────────────
const invisible = resolveBranding('#141d2e', CARD);   // sits ~on the card -> < 3:1
ok('near-surface accent falls back', invisible.usedFallback === true && invisible.accent === DEFAULT_ACCENT);
ok('null accent falls back',         resolveBranding(null, CARD).usedFallback === true);
ok('junk accent falls back',         resolveBranding('not-a-colour', CARD).usedFallback === true);
ok('fallback is measured on card',   resolveBranding(null, CARD).accentOnSurface >= MIN_RATIO);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
