#!/usr/bin/env node
/**
 * check-insert-business-id.mjs — A409: every cloud insert/upsert into a table whose business_id is NOT NULL says
 * business_id.
 *
 * Owner, 2026-10-05: station categories would not save ("Not saved: Something went wrong") on the till AND the web.
 * Migration 103 made category_stations.business_id NOT NULL; routes/stations.ts never sent it, so every save was refused
 * by the database and answered as a 500. Nothing caught it: the drift check proves the columns a route NAMES exist, not
 * that it names the ones the table REQUIRES.
 *
 * For each `.from('<table>') … .insert(` / `.upsert(` in apps/server/src where scripts/schema-index.json has
 * `business_id … NOT NULL`, business_id must appear:
 *   - in the argument itself (`{ business_id: … }`, `rows.map(r => ({ …, business_id }))`), or
 *   - where a variable passed is built (its declaration or `.push(` within the 120 lines above), or
 *   - in a `// business_id: <why>` comment on one of the 3 lines above the call (a row built elsewhere).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/schema-index.json'), 'utf8'));
const required = new Set(Object.entries(index)
  .filter(([, cols]) => cols && typeof cols === 'object' && /NOT NULL/.test(String(cols.business_id ?? '')))
  .map(([t]) => t));

const files = [];
const walk = (d) => {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.ts')) files.push(p);
  }
};
walk(path.join(ROOT, 'apps/server/src'));

/** The text of the call's argument list, from just after `(` to its matching `)`. */
function argText(s, start) {
  let i = start, depth = 1;
  while (i < s.length && depth) { if (s[i] === '(') depth++; else if (s[i] === ')') depth--; i++; }
  return s.slice(start, i - 1);
}

/** Does a variable named in the argument get built with business_id in the lines above? */
function builtWithBusinessId(above, name) {
  const lines = above.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    const builds = new RegExp(`\\b(const|let|var)\\s+${name}\\b|\\b${name}\\s*=[^=]|\\b${name}\\.push\\(`).test(l);
    if (builds && KEY.test(lines.slice(i, i + 12).join('\n'))) return true;
  }
  return false;
}

/** business_id as a row KEY (`business_id: x`, shorthand `{ business_id }`) — not a quoted filter like .eq('business_id', …). */
const KEY = /(^|[{,\s])business_id\s*[:,}\n]/;

const problems = [];
let checked = 0;
for (const file of files) {
  const s = fs.readFileSync(file, 'utf8');
  const re = /\.from\(\s*'([a-z_]+)'\s*\)([^;]{0,200}?)\.(insert|upsert)\(/g;
  let m;
  while ((m = re.exec(s))) {
    const table = m[1];
    if (!required.has(table) || /\.from\(/.test(m[2])) continue;
    checked++;
    const arg = argText(s, re.lastIndex);
    if (KEY.test(arg)) continue;
    const callLine = s.slice(0, m.index).split('\n').length;
    const lines = s.split('\n');
    if (lines.slice(Math.max(0, callLine - 4), callLine).some((l) => /\/\/\s*business_id:/.test(l))) continue;
    const above = lines.slice(Math.max(0, callLine - 120), callLine).join('\n');
    const names = [...new Set((arg.match(/\b[a-zA-Z_$][\w$]*\b/g) ?? []).filter((n) => !/^(onConflict|ignoreDuplicates|true|false|null|map|select)$/.test(n)))];
    // A row built inline by .map() must say business_id itself — a variable it maps over says nothing about the row.
    if (!/\.map\(/.test(arg) && names.some((n) => builtWithBusinessId(above, n))) continue;
    problems.push(`${path.relative(ROOT, file)}:${callLine}  ${table} (business_id NOT NULL) ← ${arg.replace(/\s+/g, ' ').slice(0, 90)}`);
  }
}

if (problems.length) {
  console.log(`FAIL — ${problems.length} insert(s) into a table that requires business_id do not say it:\n`);
  for (const p of problems) console.log(`  ${p}`);
  console.log('\nAdd business_id to the row, or a `// business_id: <why>` comment above the call when the row is built elsewhere.');
  process.exit(1);
}
console.log(`OK — ${checked} insert(s)/upsert(s) into ${required.size} business-scoped tables all carry business_id.`);
