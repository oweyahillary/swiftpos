#!/usr/bin/env node
/**
 * check-own-rows.mjs — every query on a replicated table must say whose rows it means.
 *
 * ── THE PROBLEM THIS EXISTS FOR ─────────────────────────────────────────────
 * A till acting as the branch node ingests its peers' orders, shifts, expenses,
 * floats and trading days into its OWN SQLite tables, so a manager can see the
 * whole branch from one screen. Those are the same tables that drive that till's
 * own cash control.
 *
 * So on the node, and only on the node, a query like
 *
 *     SELECT * FROM shifts WHERE status='open' ORDER BY opened_at DESC LIMIT 1
 *
 * stops meaning "my open drawer" and starts meaning "the newest open drawer
 * anywhere at this branch". getOpenShift is exactly that query, and the sell
 * gate is built on it: the node till would believe it has a drawer open that
 * belongs to a cashier at another terminal, and sell against it.
 *
 * There are 23 such sites across dayService, shiftService, ipcHandlers and
 * syncEngine. The failure is silent, appears only on one till in a branch, and
 * only once replication is switched on — which is to say it would be found by a
 * client and not by us.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 * A query touching a replicated table must do one of two things:
 *
 *   1. Scope to this terminal — `COALESCE(device_id,'') = COALESCE(?,'')`.
 *   2. Carry `-- branch-wide:` and a reason — it deliberately spans terminals,
 *      as the manager report and the branch roll-up must.
 *
 * The reason is the point. "Why does this one not filter?" should be answerable
 * from the line above it, not from a git blame and an afternoon.
 *
 * This is a lint, not a proof: it reads SQL as text and can be fooled. It is
 * aimed at the thing that actually happens — someone adds a twenty-fourth query
 * and does not know the rule exists.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'apps/desktop/src/main');

const REPLICATED = ['orders', 'shifts', 'expenses', 'float_transactions', 'business_days'];

/**
 * Files that are the node's branch-wide surface by definition. Every query in
 * them spans terminals on purpose, so requiring a marker on each would train
 * people to paste it without reading — which is worse than not asking.
 */
const BRANCH_WIDE_FILES = new Set([
  'nodeServer.ts',
  // The manager's consolidated view. Marking ten queries individually would
  // train people to paste the comment without reading it, which is worse than
  // asking once at the top of the file. The file carries the reason.
  'managerReports.ts',
]);

// "Mine": scoped to the terminal that created the row. COALESCE on both sides
// because rows predating the column carry NULL. dayService.getOpenDay() already
// used exactly this shape before replication existed — it is the house pattern,
// not a new one.
const OWN_FILTER =
  /COALESCE\s*\(\s*[\w.]*device_id\s*,\s*''\s*\)\s*=\s*COALESCE|[\w.]*device_id\s*=\s*\?/i;

// dailySalesReport builds its predicate with scopeClause(deviceId), so the
// scope is chosen at runtime rather than written literally. That is a scoping
// mechanism, not an omission — and it is the better pattern, since one query
// path serves both the branch and the single-till view.
const DYNAMIC_SCOPE = /\$\{\s*scopeClause\s*\(/;
// Accept the marker as either a SQL comment (inside the template literal) or a
// TypeScript one (above the call). Requiring `--` specifically pushed people to
// write it outside the string where `--` is a syntax error — which is exactly
// what happened while applying these.
const OPT_OUT = /(--|\/\/)\s*branch-wide:/i;

/**
 * Already unambiguous: a statement that targets a specific row by id needs no
 * ownership filter, because the id identifies exactly one row whoever owns it.
 * `SELECT * FROM shifts WHERE id=?` returns that shift or nothing; it can never
 * silently return a peer's when it meant this till's.
 *
 * The dangerous shape is the OPEN-ENDED one — status='open', ORDER BY ... LIMIT
 * 1, COUNT(*), SUM(total) — where the row set is chosen by the database and the
 * caller assumes it is local.
 */
const KEYED = /\b(id|order_id|shift_id|business_day_id|transfer_id)\s*=\s*\?/i;

if (!fs.existsSync(SRC)) {
  console.error(`refusing to pass: ${SRC} not found. Check the path.`);
  process.exit(2);
}

const files = fs.readdirSync(SRC).filter(f => f.endsWith('.ts'));
let checked = 0;
const problems = [];

for (const file of files) {
  if (BRANCH_WIDE_FILES.has(file)) continue;
  const text = fs.readFileSync(path.join(SRC, file), 'utf8');
  const lines = text.split('\n');

  for (const table of REPLICATED) {
    // FROM <table>, JOIN <table>, UPDATE <table>, DELETE FROM <table>.
    const re = new RegExp(`\\b(FROM|JOIN|UPDATE|INTO)\\s+${table}\\b`, 'gi');
    let m;
    while ((m = re.exec(text)) !== null) {
      // INSERT INTO is a write of a row this till is creating — ownership is set
      // by the writer, not asserted by a filter.
      const before = text.slice(Math.max(0, m.index - 24), m.index);
      if (/INSERT\s+$/i.test(before) || /INSERT\s+OR\s+\w+\s+$/i.test(before)) continue;

      const lineNo = text.slice(0, m.index).split('\n').length;
      // The statement usually spans several lines, and this codebase comments
      // heavily INSIDE its SQL — getConflictedShifts carries six lines of
      // explanation between FROM and WHERE. A narrow window reports those as
      // unscoped, and a check that cries wolf gets switched off. Read to the end
      // of the statement (the closing backtick) or 20 lines, whichever is first.
      const endIdx = text.indexOf('`)', m.index);
      const endLine = endIdx === -1 ? lineNo + 20
        : Math.min(lineNo + 20, text.slice(0, endIdx).split('\n').length + 1);
      const window = lines.slice(Math.max(0, lineNo - 6), endLine).join('\n');

      if (OWN_FILTER.test(window) || OPT_OUT.test(window) || KEYED.test(window)
          || DYNAMIC_SCOPE.test(window)) { checked++; continue; }

      problems.push({ file, lineNo, table, snippet: (lines[lineNo - 1] ?? '').trim().slice(0, 88) });
      checked++;
    }
  }
}

console.log(`check-own-rows: ${checked} queries on replicated tables across ${files.length} files.`);

// The check's own failure mode is matching nothing and declaring success.
if (checked < 10) {
  console.error(`\nrefusing to pass: only ${checked} queries found. These tables are queried far more than that, so the scan is broken.`);
  process.exit(2);
}

if (problems.length) {
  console.error(`\nFAIL — ${problems.length} quer(y/ies) do not say whose rows they mean:\n`);
  for (const p of problems) {
    console.error(`  ${p.file}:${p.lineNo}  (${p.table})`);
    console.error(`      ${p.snippet}`);
  }
  console.error(`
Add ONE of:

  •  AND COALESCE(device_id,'') = COALESCE(?,'')    -- this till's own rows
  •  // branch-wide: <why>   (or -- inside the SQL)   deliberately spans terminals

On a till acting as the branch node these tables hold every terminal's rows, so
an unscoped query silently returns another cashier's drawer. See the note on
device_id and branch replication in localDb.ts.
`);
  process.exit(1);
}

console.log('\nOK — every query on a replicated table declares its scope.');
