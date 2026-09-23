/**
 * branding-web-contrast.test.mjs — A319: the web Branding page judges an accent exactly as the till does.
 *
 *   node tests/branding-web-contrast.test.mjs
 *
 * Tester 2026-09-23 (VERIFY-BRANDING-PHASE1 A5): the web page rejected #F5B800 — "tills will fall back to the
 * default" — but the till ACCEPTS it with black Enter text (11.74:1). The page had its own maths: it demanded WHITE
 * button text and measured #0f172a, while the till (PinPage) measures #0d1424 and picks black OR white.
 * Now the page uses apps/dashboard/src/lib/contrast.ts, a byte-identical copy of shared/contrast.ts
 * (check-shared-sync), against the till's surface. This file proves the wiring AND runs the rule.
 *
 * MUTATIONS TO CONFIRM BITE:
 *   - restore the page's own isLegible/ratio                → "no local contrast maths" fails
 *   - change the page's LOCK_SURFACE back to #0f172a        → "measures the till's lock surface" fails
 *   - require white text (tip rule) in the page's verdict  → "#F5B800 is accepted…" fails (via the source pins)
 *   - add an illegible colour to PALETTE                   → "every palette colour is one the till accepts" fails
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Node >= 23.6 runs .ts natively; older Node needs the flag. Re-run self rather than skip.
const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.A319_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, A319_TS: '1' } });
  process.exit(r.status ?? 1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (l, c, d = '') => { if (c) { pass++; console.log(`PASS  ${l}`); } else { fail++; console.log(`FAIL  ${l}  ${d}`); } };

const tab = r('apps/dashboard/src/pages/settings/BrandingTab.tsx');
const surfaceOf = (src) => /const LOCK_SURFACE = '(#[0-9a-fA-F]{6})'/.exec(src)?.[1];
const web = surfaceOf(tab), pin = surfaceOf(r('apps/desktop/src/renderer/pages/PinPage.tsx')),
  editor = surfaceOf(r('apps/desktop/src/renderer/pages/BrandingEditor.tsx'));

// ── Wiring ──
ok('the page imports the shared rule from lib/contrast', /import \{[^}]*resolveBranding[^}]*\} from '\.\.\/\.\.\/lib\/contrast'/.test(tab));
ok('the page\'s verdict IS resolveBranding (no fallback ⇒ legible), and nothing else',
  /const brand = resolveBranding\(accentHex\.trim\(\) \|\| null, LOCK_SURFACE\);/.test(tab)
  && /const legible = accentHex\.trim\(\) === '' \|\| !brand\.usedFallback;/.test(tab)
  && /const shownAccent = brand\.accent;/.test(tab));
ok('the preview\'s Enter text comes from the same rule', /pickButtonText\(accent\)\.text/.test(tab));
ok('no local contrast maths left on the page', !/function (isLegible|ratio|lum)\b/.test(tab));
ok('the page measures the till\'s lock surface (== PinPage == desktop BrandingEditor)', !!web && web === pin && web === editor,
  `web ${web} · PinPage ${pin} · BrandingEditor ${editor}`);

// ── The rule itself, run from the dashboard's own copy ──
const C = await import(pathToFileURL(path.join(ROOT, 'apps/dashboard/src/lib/contrast.ts')).href);
const judge = (hex) => C.resolveBranding(hex, web);
{
  const b = judge('#F5B800');
  ok('#F5B800 (tester\'s A5) is accepted — the till keeps it, so the page must too', !b.usedFallback, JSON.stringify(b));
  ok('…with BLACK Enter text, as the till draws it', b.buttonText === '#000000');
}
const palette = [...tab.matchAll(/hex:\s*'(#[0-9a-fA-F]{6})'/g)].map((m) => m[1]);
ok('found the page\'s palette (8 colours)', palette.length === 8, String(palette.length));
const rejected = palette.filter((h) => judge(h).usedFallback);
ok('every palette colour is one the till accepts (the page never offers a colour it would refuse)', rejected.length === 0, rejected.join(' '));
ok('a genuinely illegible accent still falls back (dark slate on the dark card)', judge('#1e293b').usedFallback === true);
ok('an empty accent means the default, not a warning', judge(null).accent === C.DEFAULT_ACCENT);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
