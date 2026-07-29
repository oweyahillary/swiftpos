#!/usr/bin/env node
/**
 * check-supabase-catch.mjs — ban `.catch()` on a Supabase/PostgREST builder.
 *
 * WHY THIS EXISTS
 *   `supabase.from(...)...` returns a PostgrestFilterBuilder, which is a
 *   *thenable*, not a Promise. It has no `.catch` method. Calling it throws
 *   `TypeError: ... .catch is not a function` at runtime — and because these
 *   calls are almost always fire-and-forget error handlers, the throw happens
 *   on the unhappy path where nobody is watching.
 *
 *   `.then(...)` on a builder returns a PromiseLike, which also has no `.catch`,
 *   so chaining `.then().catch()` fails the same way.
 *
 *   This has been fixed and has regressed repeatedly: typecheck-ratchet.mjs's
 *   own header records six occurrences being fixed, and eight more were found
 *   afterwards across auth.ts, devices.ts, fueltanks.ts (x2), qr.ts, tech.ts and
 *   orders.ts. Manual sweeps clearly do not hold. This does.
 *
 * THE CORRECT FORMS
 *   const { error } = await supabase.from('t').insert({...});
 *   if (error) console.error('...', error);
 *
 *   supabase.from('t').update({...}).then(() => {}, err => console.error(err));
 *
 *   await Promise.resolve(supabase.from('t').select()).catch(...)   // if you must
 *
 * USAGE
 *   node scripts/check-supabase-catch.mjs          # exits 1 on any hit
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SCAN = [
  join(ROOT, 'apps', 'server', 'src'),
  join(ROOT, 'apps', 'desktop', 'src'),
];

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    if (e === 'node_modules' || e === 'dist') continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

// A supabase chain, then any amount of chaining, then .catch(
// Deliberately conservative: we only flag a .catch() that is reachable from a
// `supabase.from(` / `.rpc(` / `authClient.` chain within the same statement.
const CHAIN = /\b(?:supabase|authClient|sb)\s*\.\s*(?:from|rpc|storage)\s*\([\s\S]*?\.catch\s*\(/g;

let findings = 0;

for (const file of SCAN.flatMap(d => walk(d))) {
  const src = readFileSync(file, 'utf8');
  // Split on `;` so a chain cannot bleed into an unrelated later statement.
  let offset = 0;
  for (const stmt of src.split(';')) {
    CHAIN.lastIndex = 0;
    if (CHAIN.test(stmt)) {
      const line = src.slice(0, offset).split('\n').length;
      console.error(`  ${relative(ROOT, file)}:${line}  .catch() on a Supabase builder`);
      findings++;
    }
    offset += stmt.length + 1;
  }
}

console.error('');
if (findings) {
  console.error(`FAIL — ${findings} .catch() call(s) on a Supabase builder.`);
  console.error('These throw TypeError at runtime. Use `const { error } = await ...`');
  console.error('or the two-argument .then(onOk, onErr) form instead.');
  process.exit(1);
}
console.log('OK — no .catch() on a Supabase builder.');
