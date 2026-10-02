#!/usr/bin/env node
/**
 * check-till-green.mjs — A326 (client branding Phase 2, slice 3): no NEW raw green on the till.
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
const RENDERER = path.join(ROOT, 'apps/desktop/src/renderer');
const BASELINE = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/till-green-baseline.json'), 'utf8')).files;
const RX = /\b[a-z:-]*(?:bg|text|border|ring|from|to|via|outline|accent|fill|stroke|shadow|divide|decoration|caret)-(?:green|emerald)-[0-9]{2,3}(?:\/[0-9]+)?\b/g;

export function findGreen(text) {
  const hits = [];
  text.split('\n').forEach((line, i) => { for (const m of line.matchAll(RX)) hits.push({ line: i + 1, cls: m[0], src: line.trim().slice(0, 110) }); });
  return hits;
}

if (process.argv.includes('--self-test')) {
  const planted = findGreen(`<button className="bg-green-500 hover:bg-green-400">Charge</button>`);
  const themed = findGreen(`<button className="bg-action-500 hover:bg-action-400">Charge</button>`);
  const ok = planted.length === 2 && themed.length === 0;
  console.log(ok ? 'OK — self-test: a raw green button is found; an action-* button is not.' : `FAIL — self-test: planted=${planted.length} themed=${themed.length}`);
  process.exit(ok ? 0 : 1);
}

const over = [];
let total = 0;
(function walk(dir) {
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
})(RENDERER);

console.log(`check-till-green: ${total} raw green class(es) on the till (baseline ${Object.values(BASELINE).reduce((a, b) => a + b, 0)}).`);
if (over.length) {
  console.log('\nNEW RAW GREEN on the till (A326) — green is reserved for status, money and the SwiftPOS wordmark:\n');
  for (const o of over) {
    console.log(`  ${o.rel}: ${o.hits.length} (baseline ${o.allowed})`);
    for (const h of o.hits) console.log(`     :${h.line}  ${h.cls}   ${h.src}`);
  }
  console.log('\nUse action-* (pressed / selected / links) or brand-* (lock curtain). If a new green is genuinely a status,');
  console.log('record it in docs/A326-till-green-classification.md and raise that file\'s baseline in the same reviewed change.');
  process.exit(1);
}
console.log('\nOK — no new raw green; every action on the till takes the theme.');
