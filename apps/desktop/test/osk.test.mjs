/**
 * osk.test.mjs — A417 part 2: ZapTill's own on-screen keyboard on every till (owner, 2026-10-09: "make the keypad appear
 * something like the image attached without covering the text box where a value is being keyed in"; "all tills").
 *
 *   node test/osk.test.mjs
 *
 * RUNS the real src/renderer/lib/osk.ts (which fields, which layout, where it docks, what a key does), then pins the
 * component and its mount (React is not run here).
 *
 * MUTATIONS TO CONFIRM BITE: oskDock always 'bottom' → "a low field: the keyboard goes on top" fails; oskServes taking an
 * inputMode "none" field → "the lock screen's hidden PIN is left alone" fails; backspace at the start removing a character
 * → its check fails; the keyboard opening on a mouse click → "a finger or pen opens it" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.OSK_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, OSK_TS: '1' } });
  process.exit(r.status ?? 1);
}
const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(DESKTOP, p), 'utf8').replace(/\r\n/g, '\n');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n       ${e.message}`); } };

const O = await import(pathToFileURL(path.join(DESKTOP, 'src/renderer/lib/osk.ts')).href);
const el = (tagName, attrs = {}, props = {}) => ({ tagName, type: props.type, readOnly: !!props.readOnly, disabled: !!props.disabled,
  getAttribute: (n) => (n in attrs ? attrs[n] : null) });

console.log('\nWhich fields, which keys\n');
ok('text, number, search, email, phone and PIN fields and notes boxes', () => {
  for (const t of ['text', 'number', 'search', 'email', 'tel', 'password']) assert.ok(O.oskServes(el('INPUT', {}, { type: t })), t);
  assert.ok(O.oskServes(el('TEXTAREA')));
});
ok("not a checkbox, a read-only or disabled field, or one marked data-osk=\"off\"", () => {
  assert.ok(!O.oskServes(el('INPUT', {}, { type: 'checkbox' })));
  assert.ok(!O.oskServes(el('INPUT', {}, { type: 'text', readOnly: true })));
  assert.ok(!O.oskServes(el('INPUT', {}, { type: 'text', disabled: true })));
  assert.ok(!O.oskServes(el('INPUT', { 'data-osk': 'off' }, { type: 'text' })));
});
ok("the lock screen's hidden PIN is left alone (it asks for no keyboard: inputMode \"none\")", () => {
  assert.ok(!O.oskServes(el('INPUT', { inputmode: 'none' }, { type: 'password' })));
});
ok('numbers for an amount, a quantity, a phone or a PIN; letters otherwise', () => {
  assert.equal(O.oskLayout(el('INPUT', {}, { type: 'number' })), 'numeric');
  assert.equal(O.oskLayout(el('INPUT', { inputmode: 'decimal' }, { type: 'text' })), 'numeric');
  assert.equal(O.oskLayout(el('INPUT', { inputmode: 'numeric' }, { type: 'password' })), 'numeric');
  assert.equal(O.oskLayout(el('INPUT', {}, { type: 'text' })), 'text');
});

console.log('\nNever over the field\n');
const H = 800, K = O.oskHeight(H);
ok('a field high up: the keyboard docks at the bottom, below it', () => assert.equal(O.oskDock({ top: 200, bottom: 240 }, H, K), 'bottom'));
ok('a low field: the keyboard goes on top, above it', () => assert.equal(O.oskDock({ top: 640, bottom: 680 }, H, K), 'top'));
ok('either way the field is clear of the keyboard', () => {
  for (let top = 0; top <= H - 40; top += 20) {
    const f = { top, bottom: top + 40 };
    const side = O.oskDock(f, H, K);
    if (side === 'bottom') assert.ok(f.bottom <= H - K, `field ${top} under a bottom keyboard`);
    else assert.ok(f.top >= K, `field ${top} under a top keyboard`);
  }
});
ok('its height: about two fifths of the screen, 220–320 px', () => {
  assert.equal(O.oskHeight(600), 252); assert.equal(O.oskHeight(1080), 320); assert.equal(O.oskHeight(400), 220);
});

console.log('\nWhat a key does\n');
ok('a character goes in at the caret, replacing a selection', () => {
  assert.deepEqual(O.oskApply('1200', 2, 2, { kind: 'char', ch: '5' }), { value: '12500', caret: 3 });
  assert.deepEqual(O.oskApply('abcdef', 1, 4, { kind: 'char', ch: 'X' }), { value: 'aXef', caret: 2 });
});
ok('backspace takes the character before the caret, or the selection; nothing at the start', () => {
  assert.deepEqual(O.oskApply('1200', 2, 2, { kind: 'backspace' }), { value: '100', caret: 1 });
  assert.deepEqual(O.oskApply('abcdef', 1, 4, { kind: 'backspace' }), { value: 'aef', caret: 1 });
  assert.deepEqual(O.oskApply('abc', 0, 0, { kind: 'backspace' }), { value: 'abc', caret: 0 });
});
ok('a number field (no caret): typing goes on the end, backspace takes the last', () => {
  assert.deepEqual(O.oskApply('15', null, null, { kind: 'char', ch: '0' }), { value: '150', caret: 3 });
  assert.deepEqual(O.oskApply('150', null, null, { kind: 'backspace' }), { value: '15', caret: 2 });
});
ok('like the Windows keyboard in the owner\'s picture: a number row, q–p, a–l, z–m', () => {
  assert.deepEqual(O.TEXT_ROWS.map((r) => r[0]), ['1', 'q', 'a', 'z']);
});

console.log('\nThe component\n');
const c = read('src/renderer/components/OnScreenKeyboard.tsx');
ok('a finger or pen opens it — a mouse click or a physical keyboard does not', () => {
  assert.match(c, /if \(lastPointer\.current !== 'touch' && lastPointer\.current !== 'pen'\) return;/);
  assert.match(c, /if \(!oskServes\(el\)\) return;/);
});
ok("Windows' keyboard stays shut while it is open, and the field's own setting comes back", () => {
  assert.match(c, /el\.setAttribute\('inputmode', 'none'\);/);
  assert.match(c, /if \(was\) el\.setAttribute\('inputmode', was\); else el\.removeAttribute\('inputmode'\);/);
});
ok('it docks by oskDock; keys type through the field\'s own setter (React sees typing) and never take focus', () => {
  assert.match(c, /setDock\(oskDock\(rect, window\.innerHeight, height\)\);/);
  assert.match(c, /Object\.getOwnPropertyDescriptor\(proto, 'value'\)\?\.set\?\.call\(el, value\);\s*el\.dispatchEvent\(new Event\('input', \{ bubbles: true \}\)\);/);
  assert.match(c, /<button type="button" tabIndex=\{-1\}[^>]*onPointerDown=\{keep\}/);
});
ok('on every till, every screen (mounted at the root)', () => {
  assert.match(read('src/renderer/App.tsx'), /return \(<><AppScreens \/><JoinPrompt \/><OnScreenKeyboard \/><\/>\);/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
