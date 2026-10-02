#!/usr/bin/env node
/**
 * check-reference-names.mjs — A322: SwiftPOS is general-purpose. The businesses whose logos, menus and receipts
 * were used as development references must never reappear in anything that ships or that tests feed to the
 * printer: the technician test print once printed one of them on EVERY client's printer (business name, till
 * number), and a till placeholder suggested its social handle.
 *
 *   node scripts/check-reference-names.mjs            # exit 1 on any hit, listing file:line
 *   node scripts/check-reference-names.mjs --self-test  # proves the scanner catches a planted hit
 *
 * THIS FILE IS THE ONE PLACE the names are listed (owner ruling 2026-09-24). Scanned: shipped source, sample data,
 * tests, scripts. NOT scanned: docs/ (dated history stays as written, and new docs are checked by review),
 * migrations/ (applied to production — never edited), node_modules, build output.
 * A person's name is deliberately NOT listed here — writing it into a new file would spread it further.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = path.relative(ROOT, fileURLToPath(import.meta.url)).split(path.sep).join('/');

// The reference businesses and their identifiers. Case-insensitive.
const PATTERNS = [
  /taste[\s_-]?town/i,
  /kudo/i,
  /\b3423273\b/,          // a reference business's Buy Goods till number (was on the sample ticket)
];

// Roots scanned (relative to the repo root) and what is skipped inside them.
const ROOTS = ['apps', 'shared', 'scripts', 'tests'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-electron', 'test-dist', 'release', 'build', 'coverage', '.vite', 'out-tsc']);
const EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.html', '.css', '.txt', '.csv', '.md', '.sql', '.go', '.yml', '.yaml']);
// Files allowed to contain a name ON PURPOSE, each with the reason. Keep this list short.
const ALLOW = new Map([
  [SELF, 'this gate lists the names it forbids'],
  ['tests/menu-template.test.mjs', 'asserts the upload template does NOT carry a client name'],
]);

function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.github') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* walk(p); }
    else if (EXTS.has(path.extname(e.name).toLowerCase()) || /\.bin$/.test(e.name)) yield p;
  }
}

export function scan(files, read = (f) => readFileSync(f)) {
  const hits = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    if (ALLOW.has(rel)) continue;
    const buf = read(f);
    // Printer byte streams are latin1; everything else utf8.
    const text = /\.bin$/.test(f) ? buf.toString('latin1') : buf.toString('utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      for (const re of PATTERNS) if (re.test(line)) { hits.push(`${rel}:${i + 1}  ${line.trim().slice(0, 110)}`); break; }
    });
  }
  return hits;
}

if (process.argv.includes('--self-test')) {
  // A planted hit in an in-memory file must be caught; a clean one must not.
  const fake = path.join(ROOT, 'apps', 'x', 'src', 'planted.ts');
  const caught = scan([fake], () => Buffer.from("const name = 'Taste Town';\n"));
  const clean  = scan([fake], () => Buffer.from("const name = 'Your Business';\n"));
  const ok = caught.length === 1 && clean.length === 0;
  console.log(ok ? 'OK — self-test: a planted name is caught, neutral text passes.' : `FAIL — self-test: caught=${caught.length} clean=${clean.length}`);
  process.exit(ok ? 0 : 1);
}

const files = [];
for (const r of ROOTS) { const abs = path.join(ROOT, r); try { if (statSync(abs).isDirectory()) files.push(...walk(abs)); } catch {} }
const hits = scan(files);
console.log(`check-reference-names: ${files.length} file(s) scanned under ${ROOTS.join(', ')}.`);
if (hits.length) {
  console.log('\nREFERENCE BUSINESS NAMES FOUND (A322 — SwiftPOS is general-purpose):\n');
  for (const h of hits) console.log('  ' + h);
  console.log('\nUse neutral sample data ("Your Business", generic items). If a file must name one ON PURPOSE,');
  console.log('add it to ALLOW in this script with the reason.');
  process.exit(1);
}
console.log('\nOK — no reference business names in shipped source, sample data, tests or scripts.');
