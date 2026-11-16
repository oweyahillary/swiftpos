/**
 * android-owner-reports.test.mjs — Owner stage A: the Android owner/manager phone mode opens the dashboard itself (reports,
 * overview, analytics), loaded from the dashboard not copied, with the REAL Supabase client for owner sign-in (the Shop POS
 * keeps the stub). Pins the wiring across the dashboard entry, the vite map, the module declaration and the mode screens.
 *
 *   node --no-warnings tests/android-owner-reports.test.mjs
 *
 * MUTATIONS TO CONFIRM BITE:
 *   - the owner entry stops rendering the dashboard App          → "the owner entry mounts the dashboard App" fails
 *   - vite keeps the Supabase STUB for the owner bundle          → "the owner bundle uses the REAL Supabase client" fails
 *   - App.tsx stops routing owner-phone to OwnerPhone            → "owner-phone mode opens the dashboard" fails
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${String(d).slice(0, 300)}`); fail++; } };

const run = () => {
  console.log('\nOwner reports mode — the dashboard on the owner phone (dev-api)');

  const entry = read('apps/dashboard/src/ownerPhone/OwnerPhoneScreens.tsx');
  ok('the owner entry mounts the dashboard App under ThemeProvider', /import App from '\.\.\/App'/.test(entry) && /export function OwnerDashboard/.test(entry) && /<App \/>/.test(entry));

  const vite = read('apps/android/vite.config.ts');
  ok("vite maps '@zaptill/dashboard-owner' to the owner entry", /source === '@zaptill\/dashboard-owner'\) return OWNER_ENTRY/.test(vite) && /ownerPhone\/OwnerPhoneScreens\.tsx/.test(vite));
  ok('the owner bundle uses the REAL Supabase client (not the stub)', /SUPABASE_CLIENT \? SUPABASE_REAL/.test(vite) && /supabaseReal\.ts/.test(vite));

  const real = read('apps/android/src/shop/supabaseReal.ts');
  ok('the real client is keyed from VITE_SUPABASE_* with a safe fallback', /VITE_SUPABASE_URL/.test(real) && /VITE_SUPABASE_ANON_KEY/.test(real) && /placeholder/.test(real) && /createClient/.test(real));

  const app = read('apps/android/src/App.tsx');
  ok('owner-phone mode opens the dashboard (OwnerPhone)', /state\.mode === 'owner-phone'\) return <OwnerPhone /.test(app) && /import OwnerPhone from '\.\/screens\/OwnerPhone'/.test(app));

  const screen = read('apps/android/src/screens/OwnerPhone.tsx');
  ok('OwnerPhone lazy-loads the owner dashboard', /import\('@zaptill\/dashboard-owner'\)/.test(screen) && /OwnerDashboard/.test(screen));

  ok("env.d.ts declares the '@zaptill/dashboard-owner' module", /declare module '@zaptill\/dashboard-owner'/.test(read('apps/android/src/env.d.ts')));
  ok('@supabase/supabase-js is an Android dependency', /"@supabase\/supabase-js"/.test(read('apps/android/package.json')));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
};
run();
