/**
 * close-day-now.test.mjs — A405: the till's day-lock banner gets a way out.
 *
 * Owner, 2026-10-05 (screenshot): "This till cannot sell yet — Trading day 2026-10-03 was never closed on this till"
 * with only the words "Manager → Close Day". A manager signed in now gets "Close day now", which opens Manager on the
 * Close Day tab; a cashier is told who can clear it (a manager's PIN here, or the web's remote close).
 *
 * MUTATIONS TO CONFIRM BITE: the button opening Manager on Overview (no tab) → "opens on Close Day" fails; the button
 * shown to a cashier (no onOpenManager) → "a cashier is told who can" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const pos = read('apps/desktop/src/renderer/pages/POSPage.tsx');
const app = read('apps/desktop/src/renderer/App.tsx');
const mgr = read('apps/desktop/src/renderer/pages/ManagerPage.tsx');
ok('a manager signed in: "Close day now" on the red lock and the amber reminder → Manager › Close Day', () => {
  // A490: "a manager" is someone who may close the day (shifts.close_day) — App passes canCloseDay; the button opens Manager.
  assert.match(pos, /\{onOpenManager && canCloseDay \? \(\s*<button onClick=\{\(\) => onOpenManager\('dayclose'\)\} data-testid="close-day-now"/);
  assert.match(pos, /\{onOpenManager && canCloseDay\s*\? <button onClick=\{\(\) => onOpenManager\('dayclose'\)\}[^>]*>Close day now<\/button>/);
  assert.match(app, /canCloseDay=\{can\(staff, 'shifts\.close_day'\)\}/);
});
ok('opens on Close Day (App passes the tab; Manager starts on it when this manager may see it)', () => {
  assert.match(app, /onOpenManager=\{hasManagerRights\(staff\) \? \(tab\?: 'dayclose'\) => \{ setManagerTab\(tab \?\? null\); setState\('manager'\); \} : undefined\}/);
  assert.match(app, /initialTab=\{managerTab \?\? undefined\}/);
  // A490: firstTab — the tab asked for when this person has it (Close Day needs shifts.close_day), else their first page.
  assert.match(mgr, /useState<TabKey>\(\(\) => firstTab\(nav, initialTab\) \?\? 'overview'\)/);
  assert.match(read('apps/desktop/src/renderer/lib/managerNav.ts'), /export function firstTab\(nav: NavGroup\[\], wanted\?: TabKey \| null\): TabKey \| null \{\s*if \(wanted && groupOf\(nav, wanted\)\) return wanted;/);
});
ok('a cashier is told who can clear it', () => {
  assert.match(pos, /A manager signs in with their PIN and closes it here — or closes it from the web \(Manager › Close day\)\./);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
