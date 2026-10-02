/**
 * autoupdate-wiring.test.mjs — D3: the auto-update pipeline is actually WIRED,
 * not a dormant scaffold.
 *
 *   node autoupdate-wiring.test.mjs
 *
 * The scaffold sat un-wired for weeks because wiring it needs pieces the bench
 * can't run (electron-updater dep, a publish feed). This guards every piece that
 * IS checkable in source, so D3 can't silently regress back to a hand-installed
 * .exe per till:
 *   - electron-updater is a real dependency (not just imported)
 *   - autoUpdate.ts is no longer excluded from the main build
 *   - index.ts imports AND calls initAutoUpdate()
 *   - the prod flavour has a publish target; the dev flavour publishes nowhere
 *   - dev builds are skipped at runtime (isPackaged + the "dev" flavour name)
 *   - a tag-triggered release workflow exists (closes A1)
 * Behaviour that needs a real Windows till + a published feed (the end-to-end
 * update loop) is verified by the owner, not here (rule 16).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
function ok(label, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}  ${detail}`); }
}

const pkg   = JSON.parse(r('apps/desktop/package.json'));
const tscfg = r('apps/desktop/tsconfig.main.json');
const index = r('apps/desktop/src/main/index.ts');
const au    = r('apps/desktop/src/main/autoUpdate.ts');
const ebcfg = r('apps/desktop/electron-builder.config.js');

ok('electron-updater is a real dependency',
   !!(pkg.dependencies && pkg.dependencies['electron-updater']),
   'add electron-updater to apps/desktop dependencies');

ok('autoUpdate.ts is NOT excluded from the main build',
   !/autoUpdate\.ts/.test(tscfg),
   'remove the tsconfig.main.json exclude so it type-checks + builds');

ok('index.ts imports initAutoUpdate', /import \{ initAutoUpdate \} from '\.\/autoUpdate'/.test(index));
ok('index.ts calls initAutoUpdate() at startup', /initAutoUpdate\(\)/.test(index));
ok('the call is guarded so a failed init never stops the till',
   /try \{ initAutoUpdate\(\); \} catch/.test(index));

ok('prod flavour publishes to a GitHub Releases feed',
   /provider: 'github'/.test(ebcfg) && /owner: 'oweyahillary'/.test(ebcfg));
ok('dev flavour publishes NOWHERE (feed is prod-only)',
   /publish: dev \? null :/.test(ebcfg));

ok('dev is skipped at runtime — not packaged AND not the dev flavour',
   /if \(!app\.isPackaged\) return;/.test(au) && /getName\(\)\.toLowerCase\(\)\.includes\('dev'\)/.test(au));
ok('update installs on quit, never mid-service',
   /autoInstallOnAppQuit = true/.test(au));
ok('an update error is swallowed (till keeps trading)',
   /autoUpdater\.on\('error'/.test(au));

const wf = fs.existsSync(path.join(ROOT, '.github/workflows/release.yml'))
  ? r('.github/workflows/release.yml') : '';
ok('a tag-triggered release workflow exists (closes A1)',
   /tags:/.test(wf) && /--publish always/.test(wf));
ok('release workflow builds the PROD flavour',
   /SWIFTPOS_ENV: prod/.test(wf));

console.log(`\n${fail === 0 ? `All ${pass} checks passed. Auto-update is wired.` : `${fail} FAILED (${pass} passed)`}`);
process.exit(fail === 0 ? 0 : 1);
