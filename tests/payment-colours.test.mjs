/**
 * payment-colours.test.mjs — A344 (2026-09-27): each payment method has its own colour, on the payment buttons (till and
 * web POS) and beside the method name in orders, the shift panel, the manager's breakdowns and the POS reports.
 *
 * Owner: "we can make the payment method color full each with a color or something" — "Buttons + reports".
 *
 *   node tests/payment-colours.test.mjs
 *
 * RUNS the real palette (shared/paymentColours.ts) and proves it reads: every dot ≥ 3:1 (a graphic) on the till's dark
 * surfaces and the web POS's dark AND light surfaces; the normal label text ≥ 4.5:1 on each method's tinted button, in both
 * modes; methods distinct from each other; a custom tender always the same colour. The screens are pinned by source.
 *
 * MUTATIONS TO CONFIRM BITE:
 *   - a dot too pale (e.g. card #bcd0ff)                     → "every dot ≥ 3:1" fails (on white)
 *   - the tint too strong (alpha 0.6)                         → "label text ≥ 4.5:1 on every tinted button" fails
 *   - a selected button coloured by method (not the theme)    → "the SELECTED button keeps the theme" fails
 *   - the web copy edited on its own                          → "one palette" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.PAY_COLOURS_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, PAY_COLOURS_TS: '1' } });
  process.exitCode = r.status ?? 1;
} else {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  let pass = 0, fail = 0;
  const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
  const P = await import(pathToFileURL(path.join(ROOT, 'shared/paymentColours.ts')).href);

  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const lum = (c) => { const v = c.map((x) => x / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
  const cr = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const mix = (fg, bg, a) => fg.map((v, i) => Math.round(v * a + bg[i] * (1 - a)));
  const alphaOf = (code) => Number(P.methodTint(code).match(/,\s*([0-9.]+)\)$/)[1]);

  // Surfaces the dots and buttons sit on. Till (always dark): gray-900 panel, gray-800 button. Web POS: the same dark pair,
  // and in light mode white / the light surfaces (index.css light-colours: #ffffff, #f8fafc, #f1f5f9).
  const DARK = ['#111827', '#1f2937'];
  const LIGHT = ['#ffffff', '#f8fafc', '#f1f5f9'];
  // Label text on an unselected button: gray-300 on the dark POS; in light mode the light theme turns gray text to slate.
  const TEXT_DARK = '#d1d5db', TEXT_LIGHT = '#334155';
  const ALL = [...Object.keys(P.METHOD_COLOURS), 'bank_transfer', 'voucher', 'cheque'];

  ok('every dot ≥ 3:1 (a graphic) on every dark and light surface', () => {
    const bad = [];
    for (const m of ALL) for (const s of [...DARK, ...LIGHT]) {
      const r = cr(rgb(P.methodColour(m).dot), rgb(s)); if (r < 3) bad.push(`${m} on ${s}: ${r.toFixed(2)}`);
    }
    assert.deepEqual(bad, []);
  });
  ok('label text ≥ 4.5:1 on every tinted button — dark till / web, and web light mode', () => {
    const bad = [];
    for (const m of ALL) {
      const dot = rgb(P.methodColour(m).dot), a = alphaOf(m);
      for (const s of DARK) { const bg = mix(dot, rgb(s), a); const r = cr(rgb(TEXT_DARK), bg); if (r < 4.5) bad.push(`${m} dark ${s}: ${r.toFixed(2)}`); }
      for (const s of LIGHT) { const bg = mix(dot, rgb(s), a); const r = cr(rgb(TEXT_LIGHT), bg); if (r < 4.5) bad.push(`${m} light ${s}: ${r.toFixed(2)}`); }
    }
    assert.deepEqual(bad, []);
  });
  ok('the five built-in methods are five different colours', () => {
    const dots = Object.values(P.METHOD_COLOURS).map((c) => c.dot);
    assert.equal(new Set(dots).size, dots.length);
  });
  ok('a custom tender is always the same colour (stable, case-insensitive)', () => {
    assert.equal(P.methodColour('Bank_Transfer').dot, P.methodColour('bank_transfer').dot);
    assert.ok(P.CUSTOM_METHOD_COLOURS.some((c) => c.dot === P.methodColour('voucher').dot));
  });
  ok('one palette: the till\'s and the web\'s copies are byte-identical to shared/', () => {
    const canon = read('shared/paymentColours.ts');
    assert.equal(read('apps/desktop/src/shared/paymentColours.ts'), canon);
    assert.equal(read('apps/dashboard/src/lib/paymentColours.ts'), canon);
  });

  // ── Where it is used (source — React not run here) ──
  const tillPay = read('apps/desktop/src/renderer/components/PaymentModal.tsx');
  const webPay = read('apps/dashboard/src/pages/pos/PaymentModal.tsx');
  ok('the SELECTED button keeps the theme (action-*); only unselected ones take the method colour — till and web', () => {
    assert.match(tillPay, /style=\{leg\.method === m\.code \? undefined : \{ backgroundColor: methodTint\(m\.code\), borderColor: methodColour\(m\.code\)\.dot \}\}/);
    assert.match(webPay, /style=\{method === m \? undefined : \{ backgroundColor: methodTint\(m\), borderColor: methodColour\(m\)\.dot \}\}/);
    assert.match(webPay, /style=\{method === cm\.code \? undefined : \{ backgroundColor: methodTint\(cm\.code\), borderColor: methodColour\(cm\.code\)\.dot \}\}/);
    for (const src of [tillPay, webPay]) assert.match(src, /'bg-action-500\/10 border-action-500 text-action-400'/);
  });
  ok('the method dot beside the name: till POS orders, manager Orders / breakdowns / shift, shift panel; web order history and reports', () => {
    assert.match(read('apps/desktop/src/renderer/pages/POSPage.tsx'), /<MethodDot method=\{method\} \/>\{method\.replace/);
    const mp = read('apps/desktop/src/renderer/pages/ManagerPage.tsx');
    assert.equal((mp.match(/<MethodDot method=\{method\} \/>/g) || []).length, 4);
    assert.match(mp, /<MethodDot method=\{m\.method\} \/>/);
    assert.equal((mp.match(/background: methodColour\(method\)\.dot/g) || []).length, 3);
    assert.match(read('apps/desktop/src/renderer/pages/ShiftPanel.tsx'), /<Line key=\{m\.method\} dot=\{m\.method\}/);
    assert.equal((read('apps/dashboard/src/pages/pos/POSOrderHistoryTab.tsx').match(/<MethodDot method=/g) || []).length, 2);
    assert.match(read('apps/dashboard/src/pages/pos/POSReportsTab.tsx'), /background: methodColour\(method\)\.dot/);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}
