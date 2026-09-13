/**
 * A273 — the web POS adopts the covered till's device_id so its shift folds into
 * that till's drawer (Option B), instead of the shared web:<branch> session.
 *
 * SOURCE-ASSERTION guard (dashboard can't run headless here). The live two-surface
 * behaviour (till + web-as-that-till share one drawer; a web sale carries the
 * till's device_id) is a target confirm (rule 16). Mutation-checked (rules 10, 23).
 */
import assert from 'node:assert';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = p => fs.readFileSync(path.join(root, p), 'utf8');
const CTX  = 'apps/dashboard/src/context/POSAuthContext.tsx';
const MOD  = 'apps/dashboard/src/pages/pos/ShiftModal.tsx';
const HELP = 'apps/dashboard/src/lib/posTerminal.ts';
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log('PASS ' + n); } catch (e) { fail++; console.log('FAIL ' + n + '\n   ' + e.message); } };

ok('A273: posTerminal helper reads/writes the covered till in sessionStorage', () => {
  const h = r(HELP);
  assert.match(h, /export function getCoveredTerminal\(\)/);
  assert.match(h, /export function setCoveredTerminal\(/);
  assert.match(h, /sessionStorage\.(getItem|setItem|removeItem)/);
});

ok('A273: posApi injects x-device-id from the covered till on the MAIN request', () => {
  const s = r(CTX);
  assert.match(s, /import \{ getCoveredTerminal \} from '\.\.\/lib\/posTerminal'/);
  assert.match(s, /const covered = getCoveredTerminal\(\);\s*\n\s*if \(covered\?\.device_id\) headers\['x-device-id'\] = covered\.device_id;/);
});

ok('A273: the 401-retry request carries x-device-id too (identity not dropped on refresh)', () => {
  const s = r(CTX);
  // the spread form is unique to the retry headers block
  assert.match(s, /\.\.\.\(getCoveredTerminal\(\)\?\.device_id \? \{ 'x-device-id': getCoveredTerminal\(\)!\.device_id \} : \{\}\)/);
});

ok('A273: ShiftModal loads the branch tills for the picker', () => {
  const s = r(MOD);
  assert.match(s, /\/api\/shifts\/terminals\?branch_id=/);
  assert.match(s, /<select[\s\S]{0,200}selectedDeviceId/);
});

ok('A273: opening a shift adopts the till identity BEFORE the /open call', () => {
  const s = r(MOD);
  // setCoveredTerminal(till) must appear before the /api/shifts/open post in handleOpen
  const h = /const handleOpen = async[\s\S]*?\n  \};/.exec(s);
  assert.ok(h, 'handleOpen not found');
  const idxSet  = h[0].indexOf('setCoveredTerminal(till)');
  const idxOpen = h[0].indexOf("posApi.post<Shift>('/api/shifts/open'");
  assert.ok(idxSet > -1 && idxOpen > -1 && idxSet < idxOpen, 'identity must be set before /open');
});

ok('A273: an already-open till drawer is adopted (409 → /current), not errored', () => {
  const s = r(MOD);
  const h = /const handleOpen = async[\s\S]*?\n  \};/.exec(s)[0];
  assert.match(h, /const existing = await posApi\.get<Shift \| null>\('\/api\/shifts\/current'\)/);
  assert.match(h, /if \(existing\) \{ onShiftOpened\?\.\(existing\); return; \}/);
});

ok('A273: closing the drawer clears the covered-till identity', () => {
  const s = r(MOD);
  const h = /const handleClose = async[\s\S]*?\n  \};/.exec(s)[0];
  assert.match(h, /setCoveredTerminal\(null\)/);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
