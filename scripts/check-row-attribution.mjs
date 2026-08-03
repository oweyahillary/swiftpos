#!/usr/bin/env node
/**
 * check-row-attribution.mjs — every INSERT into a replicated table must set device_id.
 *
 * ── THE BUG THIS EXISTS FOR ──────────────────────────────────────────────────
 * Schema 44 added device_id to `expenses` and `float_transactions` and scoped
 * every collection query on it:
 *
 *     WHERE sync_status='pending' AND COALESCE(device_id,'') = COALESCE(?,'')
 *
 * The INSERT sites were not updated to populate it. So every expense and every
 * drawer float written after that upgrade carried device_id NULL, which
 * COALESCEs to '' and matches nothing on any till that HAS a device_id.
 *
 * The result was not an error. It was expenses and float movements silently
 * ceasing to reach the server, and a shift's expected cash therefore wrong by
 * exactly the drawer movements nobody could see. Two tables, two lines, and
 * nothing anywhere would have said so.
 *
 * ── WHY THE OTHER GUARDS MISS IT ─────────────────────────────────────────────
 * check-own-rows reads SELECTs and asks whether they declare a scope; these did.
 * check-sql-binds asks whether placeholders have values; they did. tsc sees a
 * string. The scoped read and the unattributed write are individually correct
 * and only wrong together, which is the shape no single-statement check catches.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────
 * An INSERT into orders, shifts, expenses, float_transactions or business_days
 * must name device_id in its column list, or carry `-- no-device:` with a reason
 * (ingest paths bind the PEER's device, and say so).
 *
 * Deliberately narrow: it reads the column list only, and does not try to prove
 * the bound value is right. "The column is absent" cannot be a false positive.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'apps/desktop/src/main');
const REPLICATED = ['orders', 'shifts', 'expenses', 'float_transactions', 'business_days'];

const OPT_OUT = /(--|\/\/)\s*no-device:/i;

let checked = 0;
const problems = [];

const files = fs.existsSync(SRC)
  ? fs.readdirSync(SRC).filter(f => f.endsWith('.ts')).sort()
  : [];

for (const file of files) {
  const text = fs.readFileSync(path.join(SRC, file), 'utf8');
  const lines = text.split('\n');

  for (const table of REPLICATED) {
    const re = new RegExp(`INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\s+${table}\\b`, 'gi');
    let m;
    while ((m = re.exec(text)) !== null) {
      const lineNo = text.slice(0, m.index).split('\n').length;

      // The column list runs to the closing paren before VALUES. Read a generous
      // window: these lists wrap across four or five lines in this codebase.
      const after = text.slice(m.index, m.index + 900);
      const valuesAt = after.search(/\bVALUES\b|\bSELECT\b/i);
      const columnList = valuesAt > 0 ? after.slice(0, valuesAt) : after;

      // The opt-out may sit above the statement or inside the SQL.
      const window = lines.slice(Math.max(0, lineNo - 8), lineNo + 12).join('\n');

      checked++;
      if (/\bdevice_id\b/.test(columnList)) continue;
      if (OPT_OUT.test(window)) continue;

      problems.push({
        file, lineNo, table,
        snippet: (lines[lineNo - 1] ?? '').trim().slice(0, 88),
      });
    }
  }
}

console.log(`check-row-attribution: ${checked} INSERT(s) into replicated tables across ${files.length} files.`);

// This check's own failure mode is matching nothing and declaring success.
if (checked < 4) {
  console.error(`\nrefusing to pass: only ${checked} inserts found. These five tables are written in more places than that, so the scan is broken.`);
  process.exit(2);
}

if (problems.length) {
  console.error(`\nFAIL — ${problems.length} INSERT(s) do not attribute the row to a device:\n`);
  for (const p of problems) {
    console.error(`  ${p.file}:${p.lineNo}  (${p.table})`);
    console.error(`      ${p.snippet}`);
  }
  console.error(`
A row with device_id NULL does not match COALESCE(device_id,'') = COALESCE(own,'')
on any till that has been assigned one — so it is never collected by the push and
never leaves the terminal. Nothing reports it.

Add ONE of:

  •  device_id in the column list, bound to getDeviceConfig()?.device_id ?? null
  •  // no-device: <why>   — ingest paths that bind the PEER's device_id
`);
  process.exit(1);
}

console.log('\nOK — every INSERT into a replicated table attributes the row.');
