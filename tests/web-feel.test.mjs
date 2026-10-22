/**
 * web-feel.test.mjs — A469: the web apps answer every tap.
 *
 * Owner, 2026-10-13: "look and feel, response animations".
 *
 * Pins the shipped motion (React is not run): the Tailwind keyframes and utilities exist, use the individual
 * `scale` / `translate` properties (so they never replace an element's own transform) and are switched off under
 * prefers-reduced-motion; a pressed button sinks except where the element moves itself (the drawer, the Toast, the POS
 * cart bar); dialogs fade and pop in, the phone's cart sheet slides up, the Toast slides in; on the web POS a product
 * tile presses, its in-cart badge bumps when the quantity changes, a new cart line is tinted, and the buttons that
 * wait on a request show a spinner.
 *
 *   node tests/web-feel.test.mjs
 *
 * MUTATIONS TO CONFIRM BITE: drop `:not([class*="translate"])` from the global :active rule → "the press skips
 * elements that move themselves" fails; drop `key={cartQty}` from the POS tile badge → "the badge bumps" fails;
 * remove the reduced-motion block → "reduced motion" fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log(`PASS  ${n}`); } else { fail++; console.log(`FAIL  ${n}  ${d}`); } };

const D = 'apps/dashboard/';
const tw = read(D + 'tailwind.config.js');
const css = read(D + 'src/index.css');
const C = (f) => read(D + 'src/components/' + f);
const P = (f) => read(D + 'src/pages/pos/' + f);
const pos = P('CashierScreen.tsx');
const mini = P('MinimartPOS.tsx');

// ── the utilities ──
const kf = tw.slice(tw.indexOf('keyframes: {'), tw.indexOf('animation: {'));
const an = tw.slice(tw.indexOf('animation: {'), tw.indexOf('fontFamily'));
for (const name of ['fade-in', 'pop-in', 'slide-up', 'slide-down', 'slide-in-right', 'bump', 'line-in']) {
  ok(`keyframes and animate-${name} exist`, new RegExp(`'?${name}'?:\\s*\\{`).test(kf) && new RegExp(`'?${name}'?:\\s*'${name} \\d+ms`).test(an));
}
ok('every animation is short (≤ 200 ms; the colour-only line tint excepted)',
  [...an.matchAll(/'([a-z-]+) (\d+)ms/g)].every(([, n, ms]) => n === 'line-in' || Number(ms) <= 200));
ok('the keyframes never set `transform` (they compose with the element\'s own)', !/transform/.test(kf) && /scale: '0\.96'/.test(kf) && /translate: '0 24px'/.test(kf));
ok('.press sinks a tile or stepper', /\.press:not\(:disabled\):active \{ scale: 0\.97; \}/.test(css));

// ── reduced motion ──
const rm = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
ok('reduced motion: entrances become a fade, the bump and every press go',
  css.includes('@media (prefers-reduced-motion: reduce)')
  && /\.animate-pop-in, \.animate-slide-up, \.animate-slide-down, \.animate-slide-in-right \{ animation-name: rm-fade-in !important; \}/.test(rm)
  && /\.animate-bump \{ animation: none !important; \}/.test(rm)
  && /button:active, \[role="button"\]:active, \.press:active \{ scale: none !important; \}/.test(rm)
  && /@keyframes rm-fade-in \{ from \{ opacity: 0; \}/.test(css));

// ── the global press ──
const press = css.slice(css.indexOf('button:not([class*="translate"])'), css.indexOf('scale: 0.98;'));
ok('a pressed button sinks', /scale: 0\.98;/.test(css) && press.length > 0);
ok('the press skips elements that move themselves (translate/scale class, inline transform), disabled, opted out',
  ['button', '\\[role="button"\\]'].every(sel => new RegExp(`${sel}:not\\(\\[class\\*="translate"\\]\\):not\\(\\[class\\*="scale"\\]\\):not\\(\\[style\\*="transform"\\]\\)[^{]*:not\\(\\.no-press\\)[^{]*:active`).test(press))
  && /button:not[^{]*:not\(:disabled\)[^{]*:active/.test(press));
ok('buttons ease their colour and press over 120 ms', /opacity 0\.12s ease,\s*transform 0\.12s ease,\s*scale 0\.12s ease;/.test(css));
const layout = C('DashboardLayout.tsx');
ok('the owner\'s drawer moves by translate classes (so the press leaves it alone)', /-translate-x-full/.test(layout) && /translate-x-0/.test(layout));
ok('the POS cart bar moves by inline transform (so the press leaves it alone)', /data-testid="pos-cart-bar"[\s\S]{0,600}transform: cartFlash \? 'scale\(1\.03\)'/.test(pos));
ok('one teal focus ring; the web POS uses its action colour',
  /button:focus-visible[^{]*\{\s*outline: 2px solid rgb\(var\(--swift\)/.test(css) && /\[data-pos-theme\] button:focus-visible[^{]*\{\s*outline-color: rgb\(var\(--act-fill/.test(css));

// ── dialogs, sheet, toast ──
ok('ConfirmModal: the backdrop fades, the panel pops', /z-\[9999\] p-4 animate-fade-in/.test(C('ConfirmModal.tsx')) && /space-y-4 animate-pop-in/.test(C('ConfirmModal.tsx')));
ok('CountedCloseModal fades and pops', /animate-fade-in" data-testid="counted-close"/.test(C('CountedCloseModal.tsx')) && /overflow-y-auto animate-pop-in/.test(C('CountedCloseModal.tsx')));
ok('ShiftConfirmations\' dialog fades and pops', /p-4 animate-fade-in/.test(C('ShiftConfirmations.tsx')) && /overflow-y-auto animate-pop-in/.test(C('ShiftConfirmations.tsx')));
ok('the Toast slides in (not the dead tailwindcss-animate classes)', /animate-slide-down/.test(C('Toast.tsx')) && !/slide-in-from-top/.test(C('Toast.tsx')));
const overlays = (pos.match(/<div style=\{s\.overlay\}/g) || []).length;
ok('every web POS dialog backdrop fades in', overlays > 0 && (pos.match(/<div style=\{s\.overlay\} className="animate-fade-in">/g) || []).length === overlays, `${overlays}`);
ok('every web POS dialog panel pops in',
  !/<div style=\{s\.modal\}>/.test(pos) && !/<div style=\{\{\s*\.\.\.s\.modal/.test(pos) && (pos.match(/animate-pop-in/g) || []).length >= 10);
ok('the payment dialog fades and pops; its receipt and M-Pesa screens pop', (P('PaymentModal.tsx').match(/animate-pop-in/g) || []).length === 3 && /py-6 animate-fade-in/.test(P('PaymentModal.tsx')));
for (const f of ['ShiftModal.tsx', 'MinimartPOS.tsx', 'ParkingPOS.tsx', 'PetrolPOS.tsx', 'NoteModal.tsx', 'KitchenVoidModal.tsx', 'ZReportModal.tsx', 'PrinterSettingsModal.tsx']) {
  const t = P(f);
  ok(`${f}: its dialogs fade and pop`, /animate-fade-in/.test(t) && /animate-pop-in/.test(t) && !/<div style=\{s\.overlay\}/.test(t));
}
ok('the phone\'s cart sheet slides up (only on a phone)', /data-testid="pos-cart" className=\{isPhone \? 'animate-slide-up' : undefined\}/.test(pos));
ok('the cart bar rises in', /data-testid="pos-cart-bar" className="animate-slide-up"/.test(pos));

// ── the web POS answers a tap ──
const tile = pos.slice(pos.indexOf('data-testid="product-card"'), pos.indexOf('data-testid="product-card"') + 1200);   // A563: + the sold-out badge
ok('a product tile presses', /className="press"/.test(tile));
ok('the tile\'s in-cart badge bumps when its quantity changes (the key remounts it)',
  /<span key=\{cartQty\} data-testid="cart-badge" className="animate-bump" style=\{s\.cartBadge\}>\{cartQty\}<\/span>/.test(tile));
ok('a new cart line arrives tinted', /cart\.map\(\(item, index\) => \(\s*<div key=\{index\} className="animate-line-in"/.test(pos)
  && /'line-in':\s*\{ from: \{ 'box-shadow': 'inset 0 0 0 100vmax rgb\(var\(--act-fill/.test(kf));
ok('quantity − / + press', /<button className="press" style=\{s\.qtyBtn\} onClick=\{\(\) => changeQty\(index, -1\)\}>/.test(pos)
  && /<button className="press" style=\{s\.qtyBtn\} onClick=\{\(\) => updateQty\(index, 1\)\}>/.test(pos));
ok('minimart: the tile presses, its badge bumps, a new line is tinted, the steppers press',
  /key=\{product\.id\}\s*className="press"/.test(mini) && /<span key=\{inCart\.quantity\} data-testid="cart-badge" className="animate-bump"/.test(mini)
  && /<div key=\{item\.product\.id\} className="animate-line-in" style=\{s\.cartRow\}>/.test(mini) && (mini.match(/className="press"\s*style=\{s\.qtyBtn\}/g) || []).length === 2);

// ── waiting is shown ──
ok('the spinner is a CSS class in the current text colour', /\.spin-dot \{[^}]*border: 2px solid currentColor;[^}]*animation: spin-dot/.test(css));
const SPIN = /\{(\w+) && <span className="spin-dot" aria-hidden \/>\}/;
ok('Payment: confirm and M-Pesa show a spinner while placing; the credit account loads with one',
  /\{placing && <span className="spin-dot" aria-hidden \/>\}\s*\{placing\s*\? 'Processing…'/.test(P('PaymentModal.tsx'))
  && /\{placing && <span className="spin-dot" aria-hidden \/>\}\s*\{placing \? 'Creating order…'/.test(P('PaymentModal.tsx'))
  && /<span className="spin-dot" aria-hidden \/>Loading credit account…/.test(P('PaymentModal.tsx')));
ok('Shift: every primary action shows a spinner while it waits', (P('ShiftModal.tsx').match(/\{loading && <span className="spin-dot" aria-hidden \/>\}/g) || []).length === 5);
for (const [f, txt] of [['ConfirmModal.tsx', 'Working…'], ['CountedCloseModal.tsx', 'Closing…'], ['ShiftConfirmations.tsx', 'Confirming…'], ['DownloadExcelButton.tsx', 'Preparing…']]) {
  const t = C(f);
  ok(`${f}: a spinner beside "${txt}"`, SPIN.test(t) && new RegExp(`\\? '${txt}'`).test(t));
}
ok('the POS still opens on its skeleton, not "Loading…"', /if \(loading\) return <POSLoadingSkeleton \/>;/.test(pos));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
