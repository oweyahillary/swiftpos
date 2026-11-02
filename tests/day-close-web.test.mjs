/**
 * A275 — the manager Remote Day Close panel (retired with the web manager portal, A608) + the cloud migration. SOURCE-ASSERTION
 * guards (no browser / no Postgres on the bench, rule 16). Mutation-checked.
 */
import assert from 'node:assert';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = p => fs.readFileSync(path.join(root, p), 'utf8');
const MIG = 'migrations/102_day_close_instructions.sql';
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log('PASS ' + n); } catch (e) { fail++; console.log('FAIL ' + n + '\n   ' + e.message); } };

// A608 (2026-10-29): the web manager portal is retired — its checks are gone; 
// the Remote Day Close panel (RemoteDayClose.tsx, mounted in ManagerShiftTab.tsx) is gone. The owner/manager day
// close on the web is Tills & days (components/TillsAndDays.tsx). The cloud migration below still holds.

ok('A275: the migration creates the relay table + one-pending-per-till-per-day index', () => {
  const s = r(MIG);
  assert.match(s, /CREATE TABLE IF NOT EXISTS public\.day_close_instructions/);
  assert.match(s, /status\s+text NOT NULL DEFAULT 'pending'/);
  assert.match(s, /CREATE UNIQUE INDEX IF NOT EXISTS day_close_instructions_one_pending[\s\S]{0,160}WHERE status = 'pending'/);
  assert.match(s, /INSERT INTO public\.schema_migrations/); // self-registers
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
