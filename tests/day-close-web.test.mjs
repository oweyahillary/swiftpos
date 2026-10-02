/**
 * A275 — the manager Remote Day Close panel + the cloud migration. SOURCE-ASSERTION
 * guards (no browser / no Postgres on the bench, rule 16). Mutation-checked.
 */
import assert from 'node:assert';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = p => fs.readFileSync(path.join(root, p), 'utf8');
const UI  = 'apps/dashboard/src/pages/manager/RemoteDayClose.tsx';
const TAB = 'apps/dashboard/src/pages/manager/ManagerShiftTab.tsx';
const MIG = 'migrations/102_day_close_instructions.sql';
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log('PASS ' + n); } catch (e) { fail++; console.log('FAIL ' + n + '\n   ' + e.message); } };

ok('A275: the panel is gated on shifts.force_close | settings.manage', () => {
  const s = r(UI);
  assert.match(s, /hasPermission\('shifts\.force_close'\) \|\| hasPermission\('settings\.manage'\)/);
  assert.match(s, /if \(!allowed\) return null;/);
});

ok('A275: it queues a close with a real counted_cash (never estimates)', () => {
  const s = r(UI);
  assert.match(s, /posApi\.post\('\/api\/day-close\/instruct'/);
  assert.match(s, /counted_cash:\s+amount/);
  assert.match(s, /Enter the cash counted at the till/);
  // it must read open days, not close them client-side
  assert.match(s, /posApi\.get<\{ tills: TillDay\[\] \}>\('\/api\/day-close\/overview'\)/);
});

ok('A275: the panel is mounted in the manager shift tab', () => {
  const s = r(TAB);
  assert.match(s, /import RemoteDayClose from '\.\/RemoteDayClose'/);
  assert.match(s, /<RemoteDayClose currency=\{currency\} \/>/);
});

ok('A275: the migration creates the relay table + one-pending-per-till-per-day index', () => {
  const s = r(MIG);
  assert.match(s, /CREATE TABLE IF NOT EXISTS public\.day_close_instructions/);
  assert.match(s, /status\s+text NOT NULL DEFAULT 'pending'/);
  assert.match(s, /CREATE UNIQUE INDEX IF NOT EXISTS day_close_instructions_one_pending[\s\S]{0,160}WHERE status = 'pending'/);
  assert.match(s, /INSERT INTO public\.schema_migrations/); // self-registers
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
