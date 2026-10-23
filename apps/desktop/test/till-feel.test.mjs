// A470 (owner, 2026-10-13: "look and feel, response animations, speed") — the till answers every tap: a press you can
// see, a count that bumps, a new order line that lights up, dialogs that fade and pop in, notices that slide in, a busy
// ring while a payment or a shift close is in flight. All of it short (100–180 ms, the line tint fades over 900) and
// all of it off under prefers-reduced-motion. And the POS grid does less work per render (measured: 5,000 products,
// 30 lines — the filter 2.5 ms and the per-tile cart scans 3.7 ms on EVERY render, now only when they change).
// Pins the parts so a later edit cannot quietly drop them.
//
//   node test/till-feel.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const require = createRequire(import.meta.url);
const tw = require(path.join(root, 'tailwind.config.js'));
const css = read('src/renderer/index.css');
const pos = read('src/renderer/pages/POSPage.tsx');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}`); fail++; } };

// ── the motion vocabulary (tailwind.config.js) ────────────────────────────────────────────────────────────────────────
const kf = tw.theme?.extend?.keyframes ?? {};
const an = tw.theme?.extend?.animation ?? {};
const MOTION = ['fade-in', 'pop-in', 'slide-up', 'slide-in-right', 'bump'];
ok('keyframes fade-in, pop-in (scale .96 → 1 + fade), slide-up, slide-in-right, bump and the line tint exist',
  [...MOTION, 'line-in'].every((k) => kf[k] && an[k])
  && kf['pop-in'].from.scale === '.96' && kf['pop-in'].from.opacity === '0' && kf['pop-in'].to.scale === '1'
  && kf['slide-in-right'].from.translate === '16px 0' && kf['slide-up'].from.translate === '0 8px');
const ms = (k) => Number((an[k].match(/(\d+)ms/) ?? [])[1]);
ok('…fast: every entrance / bump runs 100–180 ms, and none waits or repeats',
  MOTION.every((k) => ms(k) >= 100 && ms(k) <= 180) && Object.values(an).every((v) => !/infinite|\d+ms\s+\d+ms/.test(v)));
ok('…they move on the individual translate / scale properties, never `transform` (a toast keeps its -translate-x-1/2)',
  !JSON.stringify(kf).includes('transform'));
ok('…and hold nothing after they end (no fill-mode both / forwards)', Object.values(an).every((v) => !/\b(both|forwards)\b/.test(v)));
ok('…the line tint is the theme\'s action colour (a theme token, not raw green)',
  JSON.stringify(kf['line-in']).includes('rgb(var(--action-500) / .18)'));
const pressSrc = read('tailwind.config.js');
ok('a `press` utility: active:scale-[.97] on the scale property, not when disabled, off under reduced motion',
  pressSrc.includes("'.press:not(:disabled):active': { scale: '.97' }")
  && /'@media \(prefers-reduced-motion: reduce\)': \{\s*'\.press': \{ transition: 'none' \},\s*'\.press:not\(:disabled\):active': \{ scale: 'none' \},/.test(pressSrc));

// ── global (index.css) ────────────────────────────────────────────────────────────────────────────────────────────────
const base = (css.match(/@layer base \{([\s\S]*?)\n\}/) ?? [])[1] ?? '';
ok('buttons ease colour / opacity / scale (120 ms) — in @layer base, so a button\'s own transition-* class still wins',
  /button \{\s*transition-property: color, background-color, border-color, opacity, box-shadow, scale;\s*transition-duration: 120ms;/.test(base));
ok('the global press: scale .97 while :active, never on a disabled button',
  /button:not\(:disabled\)[^{]*:active \{\s*scale: \.97;\s*\}/.test(base));
ok('…NOT on a button that moves itself: a scale- or translate- class, or an inline transform',
  base.includes("button:not(:disabled):not([class*='scale-']):not([class*='translate-']):not([style*='transform']):active"));
const reduced = (css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/) ?? [])[1] ?? '';
ok('prefers-reduced-motion: every entrance / bump / tint and the busy ring stop; no press dip, no button easing',
  ['fade-in', 'pop-in', 'slide-up', 'slide-in-right', 'bump', 'line-in'].every((k) => reduced.includes(`.animate-${k}`))
  && reduced.includes('.btn-spinner') && /animation: none !important;/.test(reduced)
  && /button:active \{ scale: none !important; \}/.test(reduced) && /button \{ transition-duration: 0ms; \}/.test(reduced));
ok('the busy ring: the button\'s own text colour, its own spin (rotate), beside the busy text',
  /\.btn-spinner \{[\s\S]*?border: 2px solid currentColor; border-right-color: transparent;[\s\S]*?animation: btn-spin 700ms linear infinite;/.test(css)
  && css.includes('@keyframes btn-spin { to { rotate: 360deg; } }'));

// ── the POS: tiles, badge, cart lines ─────────────────────────────────────────────────────────────────────────────────
const tile = (pos.match(/const ProductTile = memo\(function ProductTile\([\s\S]*?\n\}\);/) ?? [])[0] ?? '';
ok('a product tile presses visibly (scale .97 + a deeper border, quicker on the way down)',
  /active:scale-\[0\.97\] active:duration-75 active:border-action-500/.test(tile));
ok('…the hover lift only with a real pointer (a touch screen\'s sticky :hover does not leave a tile enlarged)',
  tile.includes('[@media(hover:hover)]:hover:scale-[1.02]') && !/[ `]hover:scale-\[1\.02\]/.test(tile));
ok('the tile\'s count badge bumps on every change (keyed on the count, so the animation replays)',
  /<span key=\{cartCount\} data-testid="tile-count"\s+className="[^"]*animate-bump">/.test(tile));
ok('a new order line arrives with a brief tint — keyed on its line id, so the lines already there do not replay',
  /<div key=\{item\.lineId \?\? index\} data-testid="cart-line" className="[^"]*animate-line-in">/.test(pos) && !/<div key=\{index\} className="space-y-1">/.test(pos));
ok('…and its quantity bumps when it changes', /<span key=\{item\.quantity\} className="[^"]*animate-bump">\{item\.quantity\}<\/span>/.test(pos));
ok('the after-payment screen pops in', /className="[^"]*animate-pop-in" data-testid="payment-success"/.test(pos));
ok('notices slide in: the frozen-item and closed-elsewhere notices and the retry line from the right, the sync notice up',
  /shadow-xl animate-slide-in-right">\s*\{frozenNote\}/.test(pos) && /text-red-100 animate-slide-in-right">\s*<span>\{closedElsewhere\}/.test(pos)
  && /truncate animate-slide-in-right" title=\{retryMsg\}/.test(pos) && /max-w-\[90vw\] border animate-slide-up \$\{/.test(pos));

// ── dialogs fade + pop in ─────────────────────────────────────────────────────────────────────────────────────────────
const MODALS = ['components/PaymentModal.tsx', 'components/VariantModal.tsx', 'pages/ShiftPanel.tsx', 'components/OpenDrawerModal.tsx',
  'components/ConfirmShiftModal.tsx', 'components/KitchenVoidModal.tsx', 'components/VoidModal.tsx', 'components/NoteModal.tsx',
  'components/HeldOrdersModal.tsx', 'components/OrderDetailPanel.tsx', 'components/PrinterSettingsModal.tsx', 'components/PumpsView.tsx',
  'components/JoinPrompt.tsx', 'pages/PinPage.tsx', 'pages/BranchCloseTab.tsx', 'pages/POSPage.tsx'];
const unanimated = MODALS.filter((rel) => {
  const s = read(`src/renderer/${rel}`);
  const overlays = s.match(/className="fixed inset-0 [^"]*bg-black\/[^"]*"/g) ?? [];
  return overlays.length === 0 || overlays.some((o) => !o.includes('animate-fade-in'))
    || (s.match(/animate-pop-in/g) ?? []).length < overlays.length;
});
ok(`every dialog (payment, variants / modifiers, shift, drawer, confirm, voids, notes, held, PIN, product info, history …) fades its backdrop and pops its panel${unanimated.length ? ` — not: ${unanimated.join(', ')}` : ''}`,
  unanimated.length === 0);

// ── waiting is shown: a busy ring beside the existing busy text (the text itself unchanged) ───────────────────────────
const BUSY = [
  ['components/PaymentModal.tsx', "{placing && <span className=\"btn-spinner\" aria-hidden=\"true\" />}{placing ? 'Processing…' : `Charge ${fmt(amountDue)}`}"],
  ['pages/ShiftPanel.tsx', "{busy && <span className=\"btn-spinner\" aria-hidden=\"true\" />}{busy ? 'Opening…' : 'Open shift'}"],
  ['pages/ShiftPanel.tsx', "{busy && <span className=\"btn-spinner\" aria-hidden=\"true\" />}{busy ? 'Closing…' : blind ? 'Close shift' : 'Close shift & print Z-report'}"],
  ['components/OpenDrawerModal.tsx', "{busy && <span className=\"btn-spinner\" aria-hidden=\"true\" />}{busy ? 'Opening…' : 'Start selling'}"],
  ['components/VoidModal.tsx', "{loading && <span className=\"btn-spinner\" aria-hidden=\"true\" />}{loading\n              ? (isRefund ? 'Refunding…' : 'Voiding…')"],
  ['components/KitchenVoidModal.tsx', "{busy && <span className=\"btn-spinner\" aria-hidden=\"true\" />}{busy ? 'Voiding…' : `Void ${money(total)}`}"],
  ['components/ConfirmShiftModal.tsx', "{busy && <span className=\"btn-spinner\" aria-hidden=\"true\" />}{busy ? 'Confirming…' : 'Confirm shift'}"],
];
const noRing = BUSY.filter(([rel, s]) => !read(`src/renderer/${rel}`).includes(s)).map(([rel]) => rel);
ok(`Pay, open / close shift, start selling, void / refund, kitchen void and confirm shift spin while in flight${noRing.length ? ` — not: ${noRing.join(', ')}` : ''}`,
  noRing.length === 0);

// ── speed (measured; see the header) ──────────────────────────────────────────────────────────────────────────────────
ok('speed: the grid\'s list is memoised on what it depends on (catalogue, category, search, petrol, the day), not rebuilt each render',
  /const filtered = useMemo\(\(\) => products\.filter\(p => \{/.test(pos)
  && pos.includes('}), [products, activeCategory, activeMenu, menuFilterScope, search, flags.isPetrol, gridDay, stockView, hours]);')   // A537: + the menu; A563: + the stock view (set only when it changed); A578: + the menu hours (a new view only when the clock crosses a change); A580: + the chosen menu (Later peeks into it)
  && pos.includes('const gridDay = offerClock.toDateString();'));
ok('speed: each product\'s count on the order is one Map built per cart change — no per-tile scan of the cart',
  /const cartCounts = useMemo\(\(\) => \{\s*const m = new Map<string, number>\(\);\s*for \(const i of cart\) m\.set\(i\.product\.id, \(m\.get\(i\.product\.id\) \?\? 0\) \+ \(i\.measureUnit \? 1 : i\.quantity\)\);[^\n]*\s*return m;\s*\}, \[cart\]\);/.test(pos)
  && !/cart\.some\(i => i\.product\.id === product\.id\)/.test(pos) && !/cart\.filter\(i => i\.product\.id === product\.id\)/.test(pos)
  && pos.includes('cartCount={cartCounts.get(product.id) ?? 0}'));
ok('speed: tiles are memoised with one stable tap handler (the current handleTap through a ref), so a tap redraws one tile',
  tile.length > 0 && pos.includes('const handleTapRef = useRef(handleTap);') && pos.includes('handleTapRef.current = handleTap;')
  && pos.includes('const tapTile = useCallback((product: any) => handleTapRef.current(product), []);')
  && /onTap=\{tapTile\} setInfoProduct=\{setInfoProduct\}\s+soldOut=\{showsSoldOut\(stockView\.mode, stockView, product\.id\)\}\s+later=\{hours\.later\.size > 0 && itemAsleep\(product, hours\) !== null\}\s+onCheckBranches=\{mayCheckBranches \? checkBranchesFor : undefined\} \/>/.test(pos)   // A563: + sold out (a boolean: memo holds); A566: + the long press (a stable callback or nothing); A580: + later (a boolean)
  && pos.includes('const checkBranchesFor = useCallback((product: any) => setBranchCheck(String(product?.name ?? \'\')), []);')
  && !/onClick=\{\(\) => handleTap\(product\)\}/.test(pos));
ok('speed: tile pictures load lazily and decode off the main thread',
  /<img src=\{product\.image_url\} alt=\{product\.name\} loading="lazy" decoding="async"/.test(tile));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
