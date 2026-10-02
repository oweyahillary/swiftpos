#!/usr/bin/env node
/**
 * check-web-pos-green.mjs — A328 (client branding Phase 2, slice 4b-1): no NEW raw green in the web POS + shared components.
 *
 * The till's 222 green classes were classified (docs/A326-till-green-classification.md): 154 became the themeable
 * `action-*` / `brand-*` colours; 68 stay green because they MEAN something — status (paid, saved, online), money,
 * the SwiftPOS wordmark. This ratchet keeps it that way: per file, the count of raw green classes may go down, never
 * up. A new green button (or a reverted `action-*`) fails CI and names the file and lines.
 *
 *   node scripts/check-till-green.mjs              # the gate
 *   node scripts/check-till-green.mjs --self-test  # proves a planted green button is caught
 *
 * Use `action-*` for anything pressed, selected or linked; `brand-*` for the lock curtain. Keep `green-*` only for a
 * status, money or the wordmark — and then (after review) lower the baseline, never raise it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER = path.join(ROOT, 'apps/dashboard/src');
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/web-pos-green-baseline.json'), 'utf8'));
const BASELINE = CFG.files;
const SCOPE = CFG.scope;   // back-office pages are out of scope until 4b-2
// Tailwind green classes (A328 part 1) PLUS raw inline colours — hex / rgb(a) greens and blues and Tailwind blue classes
// (A328 part 2: the web POS colours with inline styles, which a class-only pattern could not see).
const RX = /\b[a-z:-]*(?:bg|text|border|ring|from|to|via|outline|accent|fill|stroke|shadow|divide|decoration|caret)-(?:green|emerald)-[0-9]{2,3}(?:\/[0-9]+)?\b|#(?:22c55e|16a34a|4ade80|10b981|059669|15803d|86efac|34d399|3b82f6|2563eb|60a5fa|1d4ed8)\b|rgba?\(\s*(?:34,\s*197,\s*94|22,\s*163,\s*74|74,\s*222,\s*128|16,\s*185,\s*129|59,\s*130,\s*246|37,\s*99,\s*235)\s*,[^)]*\)|\b[a-z:-]*(?:bg|text|border|ring)-blue-[0-9]{3}(?:\/[0-9]+)?\b/gi;

export function findGreen(text) {
  const hits = [];
  text.split('\n').forEach((line, i) => { for (const m of line.matchAll(RX)) hits.push({ line: i + 1, cls: m[0], src: line.trim().slice(0, 110) }); });
  return hits;
}

if (process.argv.includes('--self-test')) {
  const planted = findGreen(`<button className="bg-green-500 hover:bg-green-400">Charge</button> <button style={{ background: '#3b82f6' }}>Add</button>`);
  const themed = findGreen(`<button className="bg-action-500 hover:bg-action-400">Charge</button> <button style={{ background: 'rgb(var(--act-strong, 59 130 246))' }}>Add</button>`);
  const ok = planted.length === 3 && themed.length === 0;   // two classes + one inline hex
  console.log(ok ? 'OK — self-test: a raw green button is found; an action-* button is not.' : `FAIL — self-test: planted=${planted.length} themed=${themed.length}`);
  process.exit(ok ? 0 : 1);
}

const over = [];
let total = 0;
for (const d of SCOPE) (function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!/\.(tsx?|jsx?)$/.test(e.name)) continue;
    const rel = path.relative(RENDERER, p).split(path.sep).join('/');
    const hits = findGreen(fs.readFileSync(p, 'utf8'));
    total += hits.length;
    const allowed = BASELINE[rel] ?? 0;
    if (hits.length > allowed) over.push({ rel, allowed, hits });
  }
})(path.join(RENDERER, d));

console.log(`check-web-pos-green: ${total} raw green class(es) in the web POS + shared components (baseline ${Object.values(BASELINE).reduce((a, b) => a + b, 0)}).`);
if (over.length) {
  console.log('\nNEW RAW GREEN in the web POS / shared components (A328) — green is reserved for status, money and the SwiftPOS wordmark:\n');
  for (const o of over) {
    console.log(`  ${o.rel}: ${o.hits.length} (baseline ${o.allowed})`);
    for (const h of o.hits) console.log(`     :${h.line}  ${h.cls}   ${h.src}`);
  }
  console.log('\nUse action-* (pressed / selected / links / active nav). If a new green is genuinely a status,');
  console.log('record it in docs/A328-web-pos-green-classification.md and raise that file\'s baseline in the same reviewed change.');
  process.exit(1);
}
console.log('\nOK — no new raw green; every action in the web POS and shared components takes the theme.');
