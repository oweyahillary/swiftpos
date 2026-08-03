#!/usr/bin/env node
/**
 * check-sql-binds.mjs — do the ? placeholders match the values bound to them?
 *
 * better-sqlite3 throws at RUNTIME on a mismatch:
 *
 *     Too few parameter values were provided
 *     Too many parameter values were provided
 *
 * TypeScript cannot see it — `.all()` and `.all(a, b)` are both valid calls on a
 * Statement — so a scoped query with a forgotten argument type-checks perfectly
 * and then kills the cash push the first time it runs.
 *
 * That is not hypothetical. Adding the branch-replication device scope to four
 * collection queries in syncEngine added a `?` to each and no argument to any of
 * them, and every one of those queries is on the path that pushes shifts,
 * floats, expenses and trading days to the server.
 *
 * This is a lint, not a parser, and it is deliberately narrow: it reports only
 * the case where a statement has placeholders and binds NOTHING. That cannot be
 * a false positive, and it is exactly the shape the scoping work introduced.
 *
 * It does not try to compare counts in general. Argument lists span lines in ways
 * a regex reads badly, and this codebase comments inside its SQL, where an
 * ordinary apostrophe ("this till's drawer") unbalances naive quote-stripping and
 * throws the count off. A check that cries wolf gets switched off, and then it
 * protects nothing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['apps/desktop/src/main'];

let inspected = 0, skipped = 0;
const problems = [];

/** Split a call's arguments on top-level commas only. */
function splitArgs(src) {
  const out = [];
  let depth = 0, cur = '', inStr = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) { cur += c; if (c === inStr && src[i - 1] !== '\\') inStr = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; cur += c; continue; }
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

for (const dir of DIRS) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) continue;

  for (const file of fs.readdirSync(abs).filter(f => f.endsWith('.ts'))) {
    const text = fs.readFileSync(path.join(abs, file), 'utf8');

    // db.prepare(`...`).all(args) / .get(args) / .run(args)
    // No `;` between the prepare and its call: a statement boundary means these
    // are two separate expressions, and matching across one produced a phantom
    // mismatch by pairing one query's SQL with another's arguments.
    // (?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)* — comments are allowed between
    // prepare( and the SQL. getOpenShift() hid behind exactly that: a comment
    // before its template kept the whole site out of the scan, and its missing
    // bind shipped to a till. Not skipped — invisible.
    // The terminator includes \? so `.get() ?? null` matches; it did not before,
    // which was the same site's second hiding place.
    const re = /\.prepare\(\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*`([^`]*)`\s*,?\s*\)\s*\.\s*(all|get|run|pluck|iterate)\s*\(([^;]*?)\)\s*(?:as|;|\)|\.|\?)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const [, sql, method, rawArgs] = m;
      const lineNo = text.slice(0, m.index).split('\n').length;

      // Interpolated SQL — the placeholder count is not knowable statically.
      if (sql.includes('${')) { skipped++; continue; }

      // Named parameters are bound as one object; counting positionally is wrong.
      if (/[:@$]\w+/.test(sql.replace(/'[^']*'/g, ''))) { skipped++; continue; }

      // Spread or a bare identifier could be any length.
      if (/\.\.\./.test(rawArgs)) { skipped++; continue; }

      const placeholders = (sql.replace(/'[^']*'/g, '').match(/\?/g) ?? []).length;
      const args = splitArgs(rawArgs);

      // A single object argument is a named-parameter binding.
      if (args.length === 1 && /^\{/.test(args[0])) { skipped++; continue; }

      inspected++;

      // ── DELIBERATELY NARROW ──────────────────────────────────────────────
      // Only the unambiguous case: placeholders present, NOTHING bound. That is
      // the bug class this exists for, and it cannot be a false positive —
      // empty is empty regardless of how the call is formatted.
      //
      // A general count comparison is not reliable here and pretending otherwise
      // would be worse than not checking. Two reasons: argument lists span lines
      // in ways a regex reads badly, and this codebase comments INSIDE its SQL,
      // where an ordinary apostrophe ("this till's drawer") unbalances any naive
      // quote-stripping and throws the placeholder count off. A check that cries
      // wolf gets switched off, and then it protects nothing.
      if (placeholders > 0 && args.length === 0) {
        problems.push({
          file, lineNo, method, placeholders, args: args.length,
          snippet: sql.trim().replace(/\s+/g, ' ').slice(0, 74),
        });
      }
    }
  }
}

console.log(`check-sql-binds: ${inspected} statements checked, ${skipped} skipped (dynamic or named).`);

if (inspected < 20) {
  console.error(`\nrefusing to pass: only ${inspected} statements inspected. The scan is broken.`);
  process.exit(2);
}

if (problems.length) {
  console.error(`\nFAIL — ${problems.length} statement(s) bind the wrong number of values:\n`);
  for (const p of problems) {
    console.error(`  ${p.file}:${p.lineNo}  .${p.method}() — ${p.placeholders} placeholder(s), ${p.args} argument(s)`);
    console.error(`      ${p.snippet}`);
  }
  console.error(`
better-sqlite3 throws on this at runtime, and TypeScript cannot see it. Bind one
value per ?, in order.
`);
  process.exit(1);
}

console.log('\nOK — no statement has placeholders with nothing bound to them.');
