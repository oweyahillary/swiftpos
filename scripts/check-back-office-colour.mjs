#!/usr/bin/env node
/**
 * check-back-office-colour.mjs — A329 step 3: no NEW raw green or blue in the back office.
 *
 * The back office (dashboard `src/` minus the web POS `pages/pos` and the shared `components`, which A328's
 * check-web-pos-green.mjs covers) was classified in docs/A329-back-office-colour-classification.md: every action,
 * the wordmark, the sign-in backdrop and the accents moved to the FIXED SwiftPOS teal (`swift-*`, never the client's
 * theme); what is left green or blue MEANS something — status, money, data colours, blue info. This ratchet keeps it
 * that way: per file, the count of raw green/blue may go down, never up. A new green or blue button fails CI and
 * names the file and lines.
 *
 * It matches every form the code uses (WORKING-METHOD §9): Tailwind classes with any prefix, hex and rgb(a) judged by
 * HUE (so slate greys are not "blue"), and named 'green' / 'blue' strings.
 *
 *   node scripts/check-back-office-colour.mjs              # the gate
 *   node scripts/check-back-office-colour.mjs --self-test  # proves planted green/blue buttons are caught in each form
 *   node scripts/check-back-office-colour.mjs --write      # rewrite the baseline (only after a reviewed LOWERING)
 *
 * Use swift-* for anything pressed, selected, linked or focused. Keep green/blue only for status, money, data or
 * info — record it in the classification document and raise that file's baseline in the same reviewed change.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'apps/dashboard/src');
const BASEFILE = path.join(ROOT, 'scripts/back-office-colour-baseline.json');
const EXCLUDE = ['pages/pos/', 'components/', 'layouts/', 'lib/themes.ts', 'lib/contrast.ts'];   // web POS + shared (A328) · the registry

const CLS = /(?<![\w-])(?:[a-z0-9-]+:)*(?:bg|text|border|border-[lrtbxy]|ring|ring-offset|from|to|via|outline|accent|fill|stroke|shadow|divide|decoration|caret|placeholder)-(?:green|emerald|lime|blue|sky|indigo)-[0-9]{2,3}(?:\/[0-9]+)?(?![\w-])/g;
const HEX = /#(?:[0-9a-f]{6}|[0-9a-f]{3})(?![0-9a-z])/gi;
const RGB = /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)[^)]*\)/gi;
const NAMED = /(['"`])(?:green|blue)\1/g;

function family(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const M = Math.max(r, g, b), m = Math.min(r, g, b), d = M - m, l = (M + m) / 2;
  if (!d) return null;
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = M === r ? ((g - b) / d) % 6 : M === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  if (h >= 75 && h <= 165 && s >= 0.25) return 'green';
  if (h >= 195 && h <= 250 && s >= 0.6) return 'blue';
  return null;
}

export function findColour(text) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    const add = (tok) => hits.push({ line: i + 1, tok, src: line.trim().slice(0, 110) });
    for (const m of line.matchAll(CLS)) add(m[0]);
    for (const m of line.matchAll(HEX)) {
      let h = m[0].slice(1); if (h.length === 3) h = [...h].map((x) => x + x).join('');
      if (family(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16))) add(m[0]);
    }
    for (const m of line.matchAll(RGB)) if (family(+m[1], +m[2], +m[3])) add(m[0]);
    for (const m of line.matchAll(NAMED)) add(m[0]);
  });
  return hits;
}

if (process.argv.includes('--self-test')) {
  const planted = findColour([
    `<button className="bg-green-500 hover:bg-green-400">Save</button>`,          // 2 classes
    `<button className="bg-blue-700 text-white">Add</button>`,                    // 1 class
    `<button style={{ background: '#16a34a' }}>Go</button>`,                      // hex green
    `<div style={{ background: 'rgba(59, 130, 246, 0.2)' }} />`,                  // rgba blue
    `<Badge color="green">x</Badge>`,                                              // named
  ].join('\n'));
  const teal = findColour(`<button className="bg-swift hover:bg-swift-light text-gray-950 border-swift-strong">Save</button> <div style={{ background: '#1e293b', color: '#0d9488' }} />`);
  const ok = planted.length === 6 && teal.length === 0;
  console.log(ok ? 'OK — self-test: green/blue in every form (class, hex, rgba, named) is found; swift-*, slate and the logo teal are not.'
                 : `FAIL — self-test: planted=${planted.length} (want 6) teal=${teal.length} (want 0)`);
  process.exitCode = ok ? 0 : 1;
} else {
  const counts = {};
  const perFileHits = {};
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(tsx?|jsx?|css)$/.test(e.name)) continue;
      const rel = path.relative(SRC, p).split(path.sep).join('/');
      if (EXCLUDE.some((x) => rel.startsWith(x))) continue;
      const hits = findColour(fs.readFileSync(p, 'utf8'));
      if (hits.length) { counts[rel] = hits.length; perFileHits[rel] = hits; }
    }
  })(SRC);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (process.argv.includes('--write')) {
    const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
    fs.writeFileSync(BASEFILE, JSON.stringify({ _: 'A329 step 3: raw green/blue LEFT in the back office — status, money, data colours and blue info only (docs/A329-back-office-colour-classification.md). Counts classes, hex/rgb(a) by hue and named strings. May go DOWN, never up.', files: sorted }, null, 1) + '\n');
    console.log(`baseline written: ${total} use(s) in ${Object.keys(counts).length} file(s)`);
  } else {
    const BASE = JSON.parse(fs.readFileSync(BASEFILE, 'utf8')).files;
    const over = Object.entries(counts).filter(([f, n]) => n > (BASE[f] ?? 0));
    console.log(`check-back-office-colour: ${total} raw green/blue use(s) in the back office (baseline ${Object.values(BASE).reduce((a, b) => a + b, 0)}).`);
    if (over.length) {
      console.log('\nNEW RAW GREEN/BLUE in the back office (A329) — its actions are SwiftPOS teal (swift-*):\n');
      for (const [f, n] of over) {
        console.log(`  ${f}: ${n} (baseline ${BASE[f] ?? 0})`);
        for (const h of perFileHits[f]) console.log(`     :${h.line}  ${h.tok}   ${h.src}`);
      }
      console.log('\nUse swift-* (pressed / selected / links / focus). If a new green or blue is genuinely a status, money,');
      console.log('data or info colour, record it in docs/A329-back-office-colour-classification.md and raise that file\'s baseline.');
      process.exitCode = 1;
    } else console.log('\nOK — no new raw green or blue; every back-office action is SwiftPOS teal.');
  }
}
