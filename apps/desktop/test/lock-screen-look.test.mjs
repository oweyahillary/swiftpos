// A479 (owner, 2026-10-14, a screenshot of "Till locked": "this screen what can we do with it? looks off").
// The logo was pressed against the top and the last line cut off (the curtain could not scroll in a short window), a
// double-tap highlighted a key's digit in blue (selectable text), ⌫ wiped the whole PIN, OK showed nothing while it
// checked, and a wrong PIN was only a line of red text. Pins the fixes (the PIN check itself is A446, unchanged).
//
//   node test/lock-screen-look.test.mjs
//
// MUTATION TO CONFIRM BITE: make ⌫ clear the PIN (setPin('')) → "⌫ takes back one digit" fails.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'src', 'renderer', 'components', 'LockCurtain.tsx'), 'utf8');
const css = fs.readFileSync(path.join(here, '..', 'src', 'renderer', 'index.css'), 'utf8');
const tw = fs.readFileSync(path.join(here, '..', 'tailwind.config.js'), 'utf8');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}`); fail++; } };

ok('it scrolls in a short window and centres when it fits — nothing cut off at the top or the bottom',
  src.includes('className="fixed inset-0 z-[9999] bg-gray-950 flex flex-col overflow-y-auto select-none') && src.includes('className="m-auto w-full max-w-sm px-6 py-8 text-center"'));
ok('nothing on it can be selected (no blue highlight on a double-tapped key)', /overflow-y-auto select-none/.test(src));
ok('⌫ takes back one digit (it wiped the whole PIN)',
  src.includes("const backspace = () => { setError(null); setPin(p => p.slice(0, -1)); };") && src.includes('data-testid="lock-backspace" onClick={backspace}'));
ok('an empty place is a ring, an entered digit a filled dot that bumps in',
  src.includes("i < pin.length ? 'bg-brand-400 animate-bump' : 'border-2 border-gray-700'"));
ok('a wrong PIN shakes the dots (re-keyed so each wrong try shakes again) and says why',
  src.includes("key={error ? `e-${error}` : 'ok'} data-testid=\"lock-dots\"") && src.includes("${error ? 'animate-shake' : ''}")
  && /shake: \{ '0%, 100%': \{ translate: '0 0' \}/.test(tw) && tw.includes("shake: 'shake 180ms ease-in-out',"));
ok('…and holds still under reduced motion', /\.animate-bump, \.animate-shake,/.test(css));
ok('OK shows a busy ring and "Checking…" while the PIN is checked',
  src.includes('{busy ? <><span className="btn-spinner" aria-hidden />Checking…</> : \'OK\'}'));
ok('the time and the day are shown', src.includes('data-testid="lock-clock"') && src.includes("hour12: false"));
ok('the keys press (A470)', src.includes("const key = 'press h-14 rounded-xl"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
