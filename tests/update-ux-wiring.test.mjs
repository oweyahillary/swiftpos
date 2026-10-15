/**
 * update-ux-wiring.test.mjs — A306: the auto-update UX is actually wired.
 *
 *   node tests/update-ux-wiring.test.mjs
 *
 * The visible behaviour (banner, installer progress) is target-only (rule 16). This guards the
 * source wiring so it can't silently regress to the old silent-vanish:
 *   - autoUpdate broadcasts status AND still installs on quit (never mid-service)
 *   - installUpdateNow uses quitAndInstall(false, true) — visible progress + relaunch
 *   - the two invoke channels are handled, bridged, and have schemas
 *   - the banner shows on 'downloaded', gates restart behind a manager PIN, and re-surfaces
 *   - App mounts the banner
 *
 * MUTATIONS TO CONFIRM BITE:
 *   - drop quitAndInstall(false,true) → "install-now shows visible progress" fails
 *   - remove the shifts.close_day check from update:installWithPin → "restart gated behind a PIN that may close the day" fails
 *   - unmount <UpdateBanner/> from App → "App mounts UpdateBanner" fails
 *   - stop broadcasting update:status → "autoUpdate broadcasts status" fails
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}  ${detail}`); } };

const au    = r('apps/desktop/src/main/autoUpdate.ts');
const ih    = r('apps/desktop/src/main/ipcHandlers.ts');
const pre   = r('apps/desktop/src/main/preload.ts');
const sch   = r('apps/desktop/src/main/ipcSchemas.ts');
const banner= r('apps/desktop/src/renderer/pages/UpdateBanner.tsx');
const app   = r('apps/desktop/src/renderer/App.tsx');

ok('autoUpdate broadcasts status (update:status push)', /webContents\.send\('update:status'/.test(au));
ok('autoUpdate still installs on quit (never mid-service)', /autoInstallOnAppQuit\s*=\s*true/.test(au));
ok('install-now shows visible progress + relaunch', /quitAndInstall\(\s*false\s*,\s*true\s*\)/.test(au));
ok('install-now is a no-op unless downloaded', /state\s*!==\s*'downloaded'/.test(au));

ok('handlers: update:getStatus + update:installNow', /handle\('update:getStatus'/.test(ih) && /handle\('update:installNow'/.test(ih));
ok('preload bridges getStatus/installNow/onStatus', /getStatus:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('update:getStatus'/.test(pre)
  && /installNow:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('update:installNow'/.test(pre)
  && /ipcRenderer\.on\('update:status'/.test(pre));
ok('onStatus returns an unsubscribe', /removeListener\('update:status'/.test(pre));
ok('schemas: both update channels present', /'update:getStatus'/.test(sch) && /'update:installNow'/.test(sch));

// 2026-09-22 hardening: the gate must exist in MAIN, not only in the banner. The handler body
// must consult the gate BEFORE installUpdateNow() — a renderer-only gate is bypassable.
// A490: "a manager" is the permission shifts.close_day (dayService mayCloseDay), not a role's name.
{
  const m = /handle\('update:installNow',\s*async\s*\(\)\s*=>\s*\{([\s\S]*?)\n\s*\}\);/.exec(ih);
  // Strip comments first: the handler's own comment names the gate, and an index into prose
  // would pass with the call anywhere (or nowhere) — the A171 / rule-24 class.
  const body = (m ? m[1] : '').replace(/\/\/[^\n]*/g, '');
  const gate = body.indexOf('mayCloseDay()'), install = body.indexOf('installUpdateNow()');
  ok('main: update:installNow refuses unless mayCloseDay() (shifts.close_day)', gate >= 0 && /manager_required/.test(body)
    && /export function mayCloseDay\(\): boolean \{\s*return signedInCan\('shifts\.close_day'\);/.test(r('apps/desktop/src/main/dayService.ts')));
  ok('main: the gate runs BEFORE installUpdateNow()', gate >= 0 && install > gate);
  // A490: the banner's own path — the PIN's holder is identified (never signed in) and must hold shifts.close_day, in MAIN,
  // before installUpdateNow().
  const w = /handle\('update:installWithPin',\s*async\s*\(_e, payload\)\s*=>\s*\{([\s\S]*?)\n\s*\}\);/.exec(ih);
  const wb = (w ? w[1] : '').replace(/\/\/[^\n]*/g, '');
  const wgate = wb.indexOf("personCan(who, 'shifts.close_day')"), winstall = wb.indexOf('installUpdateNow()');
  ok('main: update:installWithPin refuses a PIN that may not close the day, BEFORE installUpdateNow()',
    wgate >= 0 && winstall > wgate && /reason: 'not_allowed'/.test(wb) && /identifyPerson\(/.test(wb) && !/persistCloudSignIn|signInLocal/.test(wb));
  ok('banner surfaces a main-side refusal', /if \(!r\.ok\) \{ setMsg\(r\.message \?\? /.test(banner));
}

ok('banner shows on downloaded', /state\s*===\s*'downloaded'/.test(banner));
// A490: gated behind a PIN checked in main (update:installWithPin) — never auth.verifyPin, which signed the PIN's holder
// in over the person at the till, and never a role-name list (the owner was refused by it).
ok('restart gated behind a PIN that may close the day', /posApi\.update\.installWithPin\(pin\.trim\(\)\)/.test(banner)
  && !/verifyPin\(/.test(banner) && !/MANAGER_ROLES/.test(banner) && /disabled=\{busy \|\| !pin\.trim\(\)\}/.test(banner));
ok('restart calls install', /posApi\.update\.installWithPin\(/.test(banner)
  && /installWithPin:\s*\(pin: string\)\s*=>\s*ipcRenderer\.invoke\('update:installWithPin', \{ pin \}\)/.test(pre)
  && /'update:installWithPin':\s*\{ pin: \{ t: 'string', min: 1 \} \}/.test(sch));
ok('gentle reminder re-surfaces a dismissal', /REMIND_AFTER_MS/.test(banner) && /setDismissed\(false\)/.test(banner));

ok('App imports and mounts UpdateBanner', /import\s+UpdateBanner\s+from\s+['"]\.\/pages\/UpdateBanner['"]/.test(app)
  && /<UpdateBanner\b/.test(app));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
