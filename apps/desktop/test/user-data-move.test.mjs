// 0.6.36 (A386) — the till keeps its data when the app is renamed SwiftPOS → ZapTill.
//
// Electron keeps a till's database, log, backups and the key to its saved sign-in (Chromium's "Local State") in a
// folder named after the app. Renaming the app points it at a new, empty folder; the REAL compiled
// dist/main/userDataMove.js moves the old one across — run here on real folders in a temp dir.
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/user-data-move.test.mjs
//
// MUTATIONS TO CONFIRM BITE:
//   - skip when the new folder merely EXISTS (not when it holds swiftpos.db) → "a log line got there first" fails
//   - the new folder's files win over the old                             → "the old Local State wins" fails
//   - delete the old folder after a COPY                                  → "a locked file: copied, the old folder kept" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const M = require(path.join(here, '..', 'dist', 'main', 'userDataMove.js'));
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zt-move-'));
const put = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const get = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const till = (dir) => { put(dir, 'swiftpos.db', 'SALES'); put(dir, 'Local State', 'OLD-KEY'); put(dir, 'swiftpos.log', 'old log\n'); put(dir, 'backups/2026-10-02.db', 'B'); };

console.log('0.6.36 — the data folder moves with the app name\n');

{ const root = fresh(); const oldDir = path.join(root, 'SwiftPOS'); const newDir = path.join(root, 'ZapTill'); till(oldDir);
  const r = M.moveTillData(newDir, M.oldFolderNames('ZapTill'));
  ok('first start: SwiftPOS is moved to ZapTill in one rename', r.moved && r.mode === 'rename', JSON.stringify(r));
  ok('…the database, the sign-in key, the log and the backups are all there', get(newDir, 'swiftpos.db') === 'SALES'
    && get(newDir, 'Local State') === 'OLD-KEY' && get(newDir, 'backups/2026-10-02.db') === 'B');
  ok('…and the old SwiftPOS folder is gone', !fs.existsSync(oldDir));
  const again = M.moveTillData(newDir, M.oldFolderNames('ZapTill'));
  ok('second start: nothing to do', !again.moved && again.reason === 'already-has-data'); }

{ const root = fresh(); const oldDir = path.join(root, 'SwiftPOS'); const newDir = path.join(root, 'ZapTill'); till(oldDir);
  put(newDir, 'swiftpos.log', 'new log line\n'); put(newDir, 'Local State', 'FRESH-KEY');
  const r = M.moveTillData(newDir, M.oldFolderNames('ZapTill'));
  ok('a log line got there first: still moved (merged)', r.moved && r.mode === 'merge', JSON.stringify(r));
  ok('…the old Local State wins (the saved sign-in still opens)', get(newDir, 'Local State') === 'OLD-KEY');
  ok('…the database arrived, the old folder is gone', get(newDir, 'swiftpos.db') === 'SALES' && !fs.existsSync(oldDir)); }

{ const root = fresh(); const newDir = path.join(root, 'ZapTill'); put(newDir, 'swiftpos.db', 'NEW-SALES');
  const oldDir = path.join(root, 'SwiftPOS'); till(oldDir);
  const r = M.moveTillData(newDir, M.oldFolderNames('ZapTill'));
  ok('ZapTill already has a till\'s database: never overwritten', !r.moved && get(newDir, 'swiftpos.db') === 'NEW-SALES'
    && fs.existsSync(path.join(oldDir, 'swiftpos.db'))); }

{ const root = fresh(); const newDir = path.join(root, 'ZapTill'); fs.mkdirSync(path.join(root, 'SwiftPOS'));
  put(path.join(root, 'SwiftPOS'), 'notes.txt', 'x');
  const r = M.moveTillData(newDir, M.oldFolderNames('ZapTill'));
  ok('a SwiftPOS folder with no database is left alone (not a till\'s)', !r.moved && r.reason === 'nothing-to-move'
    && fs.existsSync(path.join(root, 'SwiftPOS', 'notes.txt'))); }

{ const root = fresh(); const oldDir = path.join(root, 'desktop'); const newDir = path.join(root, 'ZapTill'); till(oldDir);
  const r = M.moveTillData(newDir, M.oldFolderNames('ZapTill'));
  ok('a till from before A284 (%APPDATA%\\desktop) comes straight to ZapTill', r.moved && get(newDir, 'swiftpos.db') === 'SALES'); }

{ const root = fresh(); till(path.join(root, 'SwiftPOS Dev')); till(path.join(root, 'SwiftPOS'));
  const r = M.moveTillData(path.join(root, 'ZapTill Dev'), M.oldFolderNames('ZapTill Dev'));
  ok('the DEV build takes only "SwiftPOS Dev" — never the shop\'s SwiftPOS folder', r.moved && r.from.endsWith('SwiftPOS Dev')
    && fs.existsSync(path.join(root, 'SwiftPOS', 'swiftpos.db'))); }

{ // a file that cannot be moved (Windows: locked) — simulated by making renames inside the merge fail once
  const root = fresh(); const oldDir = path.join(root, 'SwiftPOS'); const newDir = path.join(root, 'ZapTill'); till(oldDir);
  put(newDir, 'swiftpos.log', 'x');
  const realRename = fs.renameSync;
  fs.renameSync = (a, b) => { if (String(a).endsWith('swiftpos.db')) throw new Error('EBUSY'); return realRename(a, b); };
  let r; try { r = M.moveTillData(newDir, M.oldFolderNames('ZapTill')); } finally { fs.renameSync = realRename; }
  ok('a locked file: copied, the old folder kept (nothing lost)', r.moved && r.mode === 'copy'
    && get(newDir, 'swiftpos.db') === 'SALES' && fs.existsSync(path.join(oldDir, 'swiftpos.db')), JSON.stringify(r)); }

{ const src = fs.readFileSync(path.join(here, '..', 'src', 'main', 'index.ts'), 'utf8');
  const move = src.indexOf('\nmigrateUserDataFolder();'), lock = src.indexOf('app.requestSingleInstanceLock()');
  ok('the move runs at the top of startup, before the single-instance lock and \'ready\'', move > 0 && lock > move); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
