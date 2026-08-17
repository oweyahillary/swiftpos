/**
 * day-gate-grace.test.mjs — the 24-hour grace decision (PHASE / A104). Models
 * checkDayGate's stale-day branch: keep the hard lock, but a continuous business
 * gets a grace window at rollover during which it keeps trading behind a reminder.
 *
 *   node tests/day-gate-grace.test.mjs
 */
import assert from 'node:assert';

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}`); } };

// Mirror of checkDayGate's decision. `staleDay` true = a prior day is unclosed.
function gate({ staleDay, continuous, inGraceWindow, hasShift }) {
  if (staleDay) {
    const inGrace = continuous && inGraceWindow;
    if (!inGrace) return { needsManager: true };               // hard lock
    // else fall through, carrying the grace reminder
    if (!hasShift) return { needsShift: true, staleGrace: true };
    return { canTrade: true, staleGrace: true };
  }
  if (!hasShift) return { needsShift: true };
  return { canTrade: true };
}

// Non-continuous: a stale day hard-locks immediately, whatever the time.
ok('stale + NOT continuous → hard lock (needsManager)',
   gate({ staleDay: true, continuous: false, inGraceWindow: true, hasShift: false }).needsManager === true);

// Continuous, inside grace: keep trading; a no-shift cashier gets the float modal.
ok('stale + continuous + in grace + no shift → float modal + grace banner',
   (() => { const g = gate({ staleDay: true, continuous: true, inGraceWindow: true, hasShift: false }); return g.needsShift === true && g.staleGrace === true && !g.needsManager; })());
ok('stale + continuous + in grace + shift open → canTrade + grace banner',
   (() => { const g = gate({ staleDay: true, continuous: true, inGraceWindow: true, hasShift: true }); return g.canTrade === true && g.staleGrace === true && !g.needsManager; })());

// Continuous but past the grace window: hard lock returns.
ok('stale + continuous + grace EXPIRED → hard lock',
   gate({ staleDay: true, continuous: true, inGraceWindow: false, hasShift: true }).needsManager === true);

// No stale day: ordinary behaviour, role-independent.
ok('no stale + no shift → float modal (no grace)',
   (() => { const g = gate({ staleDay: false, continuous: true, inGraceWindow: true, hasShift: false }); return g.needsShift === true && !g.staleGrace; })());
ok('no stale + shift open → canTrade',
   gate({ staleDay: false, continuous: false, inGraceWindow: false, hasShift: true }).canTrade === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
