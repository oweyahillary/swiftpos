/**
 * help-howto.test.mjs — A422 part 1 (owner, 2026-10-09: "Build a detailed help … especially for simple tasks like opening,
 * closing day, manager confirming shift and closing day etc, well detailed"). Step-by-step guides on the till's Help and
 * the web's /help, above the approved "What to do when" list (left as it was). Screenshots are part 2.
 *
 *   node test/help-howto.test.mjs
 *
 * RUNS the real shared/helpTopics.ts; pins both screens. MUTATIONS TO CONFIRM BITE: a guide dropped → "every task the
 * owner named" fails; a guide's words not matching the screen (e.g. the close-day button) → its check fails; HOW_TO no
 * longer shown on the web → its pin fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.HELP_HOWTO_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, HELP_HOWTO_TS: '1' } });
  process.exit(r.status ?? 1);
}
const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(DESKTOP, p), 'utf8').replace(/\r\n/g, '\n');
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`); } };

const T = await import(pathToFileURL(path.join(DESKTOP, '..', '..', 'packages/core/src/helpTopics.ts')).href);
const ids = T.HOW_TO.map((t) => t.id);
ok('every task the owner named: open a shift, close a shift, confirm a shift, close the day (and void / refund)',
  ['howto-open-shift', 'howto-close-shift', 'howto-confirm-shift', 'howto-close-day', 'howto-void-refund'].every((i) => ids.includes(i)));
ok('each is real steps (at least four)', T.HOW_TO.every((t) => t.steps.length >= 4 && t.steps.every((s) => s.trim().length > 10)));
ok('the approved "What to do when" list is unchanged (nine topics)', T.HELP_TOPICS.length === 9);

// The guides use the words on the screens — the labels they name must exist there.
const step = (id) => T.HOW_TO.find((t) => t.id === id).steps.join(' ');
const words = [
  ['howto-open-shift', '"Start selling"', 'src/renderer/components/OpenDrawerModal.tsx', "'Start selling'"],
  ['howto-open-shift', '"Not you? Sign out"', 'src/renderer/components/OpenDrawerModal.tsx', 'Not you? Sign out'],
  ['howto-close-shift', '"Counted cash in drawer"', 'src/renderer/pages/ShiftPanel.tsx', 'Counted cash in drawer'],
  ['howto-close-day', '"Count verified — close the day"', 'src/renderer/pages/DayCloseTab.tsx', "'Count verified — close the day'"],
  ['howto-close-day', '"Cash you counted"', 'src/renderer/pages/DayCloseTab.tsx', 'Cash you counted'],
  ['howto-confirm-shift', '"Shift report — today"', 'src/renderer/pages/ManagerPage.tsx', 'Shift report — today'],
];
for (const [id, said, file, onScreen] of words) {
  ok(`${id}: ${said} is on the screen`, step(id).includes(said) && read(file).includes(onScreen));
}

ok('both Help screens show the guides above "What to do when"',
  /\[\.\.\.HOW_TO, \{ id: '__what', title: '', steps: \[\] \}, \.\.\.HELP_TOPICS\]/.test(read('src/renderer/components/HelpScreen.tsx'))
  && /\[\.\.\.HOW_TO, \{ id: '__what', title: '', steps: \[\] \}, \.\.\.HELP_TOPICS\]/.test(read('../dashboard/src/pages/HelpPage.tsx')));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
