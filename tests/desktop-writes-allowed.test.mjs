/**
 * desktop-writes-allowed.test.mjs — audit 2026-10-14: before TERMINAL_WRITE_ENFORCE=true can be switched on, every cloud
 * write the till makes must be allowed by lib/terminalWrites.ts for the token it is sent with — the till's own
 * (tillFetch / cloudFetch / syncFetch / fetch with the device token) or a person's PIN sign-in (manageFetch).
 *
 * tests/terminal-write-guard.test.mjs scans the literal calls. This one closes what that scan cannot see:
 *   • a manageFetch whose path or method is a ternary (Offers: `id ? '/api/offers/x' : '/api/offers', id ? 'PATCH' : 'POST'`)
 *     — BOTH branches must be allowed;
 *   • a manageFetch call the scan cannot read at all is a failure here, not a silent skip — a new manager-screen write
 *     written in a shape nobody parses would otherwise reach the field un-checked;
 *   • src/shared as well as src/main.
 *
 *   node tests/desktop-writes-allowed.test.mjs
 *
 * MUTATIONS TO CONFIRM BITE: remove /api/offers from MANAGER_WRITES → "every manager-screen write…" fails; remove
 * /api/branch-prices/sync from TILL_WRITES → "every till write…" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log(`PASS  ${name}`); } catch (e) { fail++; console.log(`FAIL  ${name}\n       ${e.message}`); } };
const T = await import(pathToFileURL(path.join(root, 'apps/server/src/lib/terminalWrites.ts')).href);
const denied = (m, p, pin) => T.terminalWriteDenied('desktop', m, p, pin);
const concrete = (p) => p.replace(/\$\{(?:[^{}]|\{[^}]*\})*\}/g, 'x').split('?')[0];

const files = [];
// D10: + src/main/ipc (the IPC handlers). Shared-components batch E: the desktop's src/shared moved into packages/core and
// packages/ui.
for (const d of ['apps/desktop/src/main', 'apps/desktop/src/main/ipc', 'packages/core/src', 'packages/ui/src']) {
  const abs = path.join(root, d);
  if (!fs.existsSync(abs)) continue;
  for (const f of fs.readdirSync(abs).filter((f) => /\.tsx?$/.test(f))) files.push({ at: `${d}/${f}`, text: fs.readFileSync(path.join(abs, f), 'utf8') });
}

// ── manageFetch: a person's PIN sign-in ───────────────────────────────────────
const STR = String.raw`(?:'[^']*'|\x60(?:[^\x60\\]|\\.)*\x60)`;              // '…' or `…`
const ARG = String.raw`(?:[^,()?]+\?\s*${STR}\s*:\s*${STR}|${STR})`;         // a string, or cond ? string : string
const CALL = new RegExp(String.raw`manageFetch\(\s*(${ARG})\s*,\s*(${ARG})`, 'g');
const strings = (arg) => [...arg.matchAll(new RegExp(STR, 'g'))].map((m) => m[0].slice(1, -1));
const manager = [], unread = [];
for (const { at, text } of files) {
  const code = text.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  const seen = new Set();
  for (const m of code.matchAll(CALL)) {
    seen.add(m.index);
    const paths = strings(m[1]).filter((p) => p.startsWith('/api/'));
    const methods = strings(m[2]).map((s) => s.toUpperCase());
    for (const p of paths) for (const meth of methods) if (meth !== 'GET') manager.push({ at, method: meth, path: concrete(p) });
  }
  for (const m of code.matchAll(/manageFetch\(/g)) {
    if (seen.has(m.index)) continue;
    const before = code.slice(Math.max(0, m.index - 20), m.index);
    if (/function\s+$/.test(before) || /function\s+manageFetch\($/.test(code.slice(Math.max(0, m.index - 30), m.index + 12))) continue;   // the definition
    unread.push(`${at}: ${code.slice(m.index, m.index + 90).replace(/\s+/g, ' ')}`);
  }
}

// ── the till's own writes: a fetch helper with a method in its options ────────
const till = [];
for (const { at, text } of files) {
  const lines = text.split('\n');
  lines.forEach((ln, i) => {
    if (/^\s*(\/\/|\*)/.test(ln) || /manageFetch\(/.test(ln)) return;
    for (const m of ln.matchAll(/[\x60'](?:\$\{[^}]*\})?(\/api\/[^\x60'\s]*)[\x60']/g)) {
      const win = (/fetch\(/i.test(ln) ? lines.slice(i, i + 4) : lines.slice(i, i + 30)).join('\n');
      const wm = /method:\s*'(POST|PUT|PATCH|DELETE)'/.exec(win);
      if (wm) till.push({ at: `${at}:${i + 1}`, method: wm[1], path: concrete(m[1]) });
    }
  });
}

ok(`every manageFetch call is read (${manager.length} manager-screen writes)`, () => {
  assert.deepEqual(unread, [], 'a manageFetch the scan cannot read — give it a literal (or ternary) path and method');
  assert.ok(manager.some((w) => w.path === '/api/offers' && w.method === 'POST') && manager.some((w) => w.path === '/api/offers/x' && w.method === 'PATCH'),
    'the ternary Offers save is read as both of its writes');
});
ok('every manager-screen write is allowed for a PIN sign-in — and for the device token, none is', () => {
  assert.deepEqual(manager.filter((w) => denied(w.method, w.path, true)).map((w) => `${w.method} ${w.path} (${w.at})`), []);
  assert.deepEqual(manager.filter((w) => !denied(w.method, w.path, false)).map((w) => `${w.method} ${w.path} (${w.at})`), []);
});
ok(`every till write is allowed for the till's own session (${till.length} found)`, () => {
  assert.ok(till.some((w) => w.path === '/api/branch-prices/sync'), 'the scan lost the price push');
  assert.ok(till.some((w) => w.path === '/api/changes'), 'the scan lost the changes push');
  assert.deepEqual(till.filter((w) => denied(w.method, w.path, false)).map((w) => `${w.method} ${w.path} (${w.at})`), []);
});

console.log(`\n${pass} passed, ${fail} failed`);
assert.strictEqual(fail, 0, 'desktop writes allowed');
