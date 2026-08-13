/**
 * register-status-parse.test.mjs — the register status parser reads the status
 * FIELD, not a word in the title (register D11 follow-up).
 *
 *   node register-status-parse.test.mjs
 *
 * Imports the real deriveStatus (no copy to drift) from scripts/lib. The bug it
 * guards: D11's title "…fails closed and kills the catalogue pull" was read as
 * CLOSED by a check that scanned the whole heading, so an open item vanished
 * from the counts. A title may contain "open"/"closed"/"struck"; only a leading
 * field states the status.
 */

import { deriveStatus } from '../scripts/lib/register-status.mjs';

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  if (got === want) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}  got ${got}, want ${want}`); }
};

// The regression: a status word inside the free-text title must NOT be read.
eq('title "fails closed" is OPEN (D11)',
   deriveStatus('P1 · `/api/pos/init` fails closed and kills the catalogue pull'), 'OPEN');
eq('title "cannot open the shop" is OPEN',
   deriveStatus('P1 · Failover cannot open the shop — the roster does not replicate'), 'OPEN');

// Normal statuses, in the status field.
eq('explicit OPEN',            deriveStatus('P0 · OPEN · A peer till locks out on day 15'), 'OPEN');
eq('CLOSED with a date',       deriveStatus('P1 · CLOSED 08-13 · the thing was fixed'), 'CLOSED');
eq('no status field is OPEN',  deriveStatus('P3 · Held orders are not visible across tills'), 'OPEN');
eq('OPEN with a parenthetical',deriveStatus('P1 · OPEN (blocked on the owner) · Mail undelivered'), 'OPEN');
eq('REOPENED is open again',   deriveStatus('P1 · REOPENED AND RE-FIXED 08-10 · Daily summaries'), 'OPEN');
eq('PARTLY CLOSED is CLOSED',  deriveStatus('P0 · PARTLY CLOSED 08-08 · Refresh rotation'), 'CLOSED');
eq('STRUCK is CLOSED',         deriveStatus('P0 · STRUCK · superseded finding'), 'CLOSED');
eq('NOTE is OPEN',             deriveStatus('P3 · NOTE · two suites run on node:sqlite'), 'OPEN');
eq('bold markers are ignored', deriveStatus('**P0** · **CLOSED 08-10** · minted the wrong surface'), 'CLOSED');

// A title beginning with a word that merely CONTAINS a status substring is safe:
// "Opening-hours" is not the word OPEN, so no boundary matches → still OPEN.
eq('"Opening-hours" title is OPEN',
   deriveStatus('P2 · Opening-hours report is off by an hour'), 'OPEN');

console.log(`\n${fail === 0
  ? `All ${pass} checks passed. Status comes from the field, not the title.`
  : `${fail} FAILED (${pass} passed)`}`);
process.exit(fail === 0 ? 0 : 1);
