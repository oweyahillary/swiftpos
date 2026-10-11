/**
 * help-images.test.mjs — A422 part 2 (owner, 2026-10-09: "detailed help even with screenshots"; 2026-10-10: "you can
 * capture them, proceed"). The step-by-step guides show a picture of the real screen beside the steps that need one, on
 * the till (shipped inside it, so Help works offline) and on the web's /help.
 *
 *   node test/help-images.test.mjs
 *
 * RUNS the real shared/helpTopics.ts; checks every picture it names is a real JPEG in BOTH apps' public/help-img/ (the
 * till's copy is packaged: vite copies public/ into dist/renderer, electron-builder packs dist/**), and pins both screens.
 *
 * MUTATIONS TO CONFIRM BITE: a guide naming a picture that is not there → "every picture named exists" fails; an images
 * list longer than its steps → "one per step" fails; the till loading pictures from the web (http) → "offline" fails;
 * the printed card showing pictures → its pin fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.HELP_IMG_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, HELP_IMG_TS: '1' } });
  process.exit(r.status ?? 1);
}
const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(DESKTOP, p), 'utf8').replace(/\r\n/g, '\n');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n       ${e.message}`); } };

const H = await import(pathToFileURL(path.join(DESKTOP, 'src/shared/helpTopics.ts')).href);
const named = H.HOW_TO.flatMap((t) => (t.images ?? []).filter(Boolean));

console.log('\nThe pictures');
ok('every guide has pictures', () => {
  for (const t of H.HOW_TO) assert.ok((t.images ?? []).some(Boolean), t.id);
});
ok('one per step at most, in step order', () => {
  for (const t of H.HOW_TO) assert.ok(!t.images || t.images.length === t.steps.length, `${t.id}: ${t.images?.length} pictures, ${t.steps.length} steps`);
});
ok('every picture named exists — a real JPEG — in the till and on the web', () => {
  assert.ok(named.length >= 12, `${named.length} pictures`);
  for (const f of named) {
    for (const dir of ['public/help-img', '../dashboard/public/help-img']) {
      const p = path.join(DESKTOP, dir, f);
      assert.ok(fs.existsSync(p), `${dir}/${f} missing`);
      const b = fs.readFileSync(p);
      assert.ok(b[0] === 0xff && b[1] === 0xd8 && b.length > 1000, `${dir}/${f} is not a JPEG`);
      assert.ok(b.length < 250_000, `${dir}/${f} is ${b.length} bytes — keep the install small`);
    }
  }
});
ok('the till and the web have the same pictures', () => {
  for (const f of named) assert.ok(fs.readFileSync(path.join(DESKTOP, 'public/help-img', f)).equals(fs.readFileSync(path.join(DESKTOP, '../dashboard/public/help-img', f))), f);
});
ok('the till\'s pictures are packed with it (vite copies public/, the installer packs dist/)', () => {
  assert.match(read('electron-builder.config.js'), /'dist\/\*\*\/\*'/);
  assert.ok(!/publicDir:\s*false/.test(read('vite.config.ts')));
});

console.log('\nThe screens');
const till = read('src/renderer/components/HelpScreen.tsx');
const web = read('../dashboard/src/pages/HelpPage.tsx');
ok('offline on the till: pictures from inside the app, never from the web', () => {
  assert.ok(till.includes('src={`./help-img/${img}`}'));
  assert.ok(!/src=\{`https?:/.test(till));
  assert.ok(web.includes('src={`/help-img/${img}`}'));
});
ok('each step shows its picture; a tap shows it full size', () => {
  for (const s of [till, web]) {
    assert.ok(s.includes('const img = (t as { images?: Array<string | null> }).images?.[i];'));
    assert.ok(s.includes('onClick={() => setZoom(img)}') && s.includes('data-testid="help-img-zoom"'));
  }
});
ok('the printed A4 card stays text only', () => {
  for (const s of [till, web]) assert.ok(s.includes('<ol>{t.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>'));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
