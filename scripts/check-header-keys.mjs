#!/usr/bin/env node
/**
 * check-header-keys.mjs — one header, one key.
 *
 * WHY
 * ---
 * `syncEngine.pushAuthHeaders()` declared BOTH `'x-device-id'` and
 * `'X-Device-Id'` in a single object literal. HTTP header names are
 * case-insensitive; JavaScript object keys are not. So `fetch` emitted the
 * header twice and every server-side reader received the values JOINED WITH A
 * COMMA. Observed in production 2026-08-09:
 *
 *   [fleet] no user_devices row for device
 *     24dbc289-ee7f-42b6-8fed-6e089095b719, 24dbc289-ee7f-42b6-8fed-6e
 *
 * The trailing copy is truncated because the reader then sliced the joined
 * string. Four consumers were affected — fleet telemetry (where
 * `WHERE device_id = ?` could never match), `orders.device_id`,
 * `shifts.device_id`, and the terminal key behind migration 63's
 * one-open-drawer-per-terminal unique index. Register **A38**.
 *
 * It is invisible by inspection: both keys look correct, they are far apart in
 * the literal, and TypeScript is content because they are distinct strings.
 *
 * WHAT IT CHECKS
 * --------------
 * No object literal declares two string keys that collide when lowercased,
 * anywhere a request is built. Header-ish names only (containing a hyphen, or a
 * known header), so ordinary data objects with `Id` and `id` are not flagged.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const SCAN = [
  'apps/desktop/src/main',
  'apps/desktop/src/renderer',
  'apps/server/src',
  'apps/dashboard/src',
  'shared',
];

/** Known single-word header names that carry no hyphen. */
const BARE_HEADERS = new Set(['authorization', 'accept', 'cookie', 'host', 'origin', 'referer']);

function isHeaderish(key) {
  return key.includes('-') || BARE_HEADERS.has(key.toLowerCase());
}

function* files(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) yield* files(rel);
    else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) yield rel;
  }
}

const findings = [];
let literals = 0;

for (const rel of [...SCAN].flatMap(d => [...files(d)])) {
  const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');

  // Blank out `${...}` interpolations FIRST, preserving length so reported line
  // numbers stay true. Without this the literal-matching below silently skips
  // any headers bag containing `Bearer ${token}` — which is every one that
  // matters. The first version of this gate did exactly that and passed its own
  // mutation test by scanning 23 literals and missing the only relevant one.
  const src = raw.replace(/\$\{[^{}]*\}/g, m => ' '.repeat(m.length));

  // Object literals, non-greedy, no nested braces — enough for a headers bag.
  for (const m of src.matchAll(/\{[^{}]*\}/g)) {
    const body = m[0];
    const keys = [...body.matchAll(/['"]([A-Za-z][A-Za-z0-9-]*)['"]\s*:/g)].map(k => k[1]);
    const headerKeys = keys.filter(isHeaderish);
    if (headerKeys.length < 2) continue;
    literals++;

    const seen = new Map();
    for (const k of headerKeys) {
      const lower = k.toLowerCase();
      if (seen.has(lower) && seen.get(lower) !== k) {
        const line = raw.slice(0, m.index).split('\n').length;
        findings.push({ rel, line, a: seen.get(lower), b: k });
      } else if (seen.has(lower)) {
        const line = raw.slice(0, m.index).split('\n').length;
        findings.push({ rel, line, a: k, b: k });
      }
      seen.set(lower, k);
    }
  }
}

console.log(`check-header-keys: ${literals} header literal(s) scanned.\n`);

if (findings.length) {
  console.error('THE SAME HEADER DECLARED TWICE:\n');
  for (const f of findings) {
    console.error(`  ${f.rel}:${f.line}`);
    console.error(`      '${f.a}' and '${f.b}' differ only in case`);
  }
  console.error(
    '\nHTTP header names are case-insensitive but object keys are not, so fetch\n' +
    'sends BOTH and the server receives them comma-joined. Declare it once.\n' +
    'See register A38.\n');
  process.exit(1);
}

console.log('OK — no object literal declares one header under two spellings.');
