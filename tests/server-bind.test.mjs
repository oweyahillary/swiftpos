/**
 * server-bind.test.mjs — Branch-server bind (migration 192): the tablet reports whether its own branch server is on the LAN
 * (apps/android/src/shop/serverPresence.ts), the owner sees it and can disable the tablet (the kill-switch,
 * apps/server/src/lib/deviceGrant.ts tillBlockReason + apps/server/src/routes/devices.ts).
 *
 *   node --no-warnings tests/server-bind.test.mjs
 *
 * WHY: a tablet carried to another, unpaid branch silently falls back to the cloud and keeps selling (the implementation
 * fee escaped). Now the tablet CLASSIFIES its branch-server presence and reports it, and tillBlockReason gains a 'disabled'
 * reason so the owner can pause a tablet (403 DEVICE_DISABLED). The classification and the block reason are pure.
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
 *   - classify returning 'away_foreign' when its own cert matches   → "own server at a new IP is home" fails
 *   - classify returning 'away_no_server' when a foreign server heard → "a foreign server is away_foreign" fails
 *   - tillBlockReason not checking disabled_at                       → "a disabled device is blocked as 'disabled'" fails
 *   - tillBlockReason putting disabled before retired               → "retired beats disabled" fails
 *   - checkPresence re-reporting a steady 'home'                    → "a steady home is not re-sent" fails
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${String(d).slice(0, 900)}`); fail++; } };

function requireFrom(dirs, name) {
  for (const d of dirs) { try { return createRequire(path.join(ROOT, d, 'package.json'))(name); } catch { /* next */ } }
  throw new Error(`cannot resolve ${name}`);
}
const esbuild = requireFrom(['apps/android', 'apps/dashboard', 'apps/server'], 'esbuild');

function bundle(tag, entryTs) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-`));
  fs.writeFileSync(path.join(tmp, 'entry.ts'), `export * from ${JSON.stringify(path.join(ROOT, entryTs))};\n`);
  esbuild.buildSync({
    entryPoints: [path.join(tmp, 'entry.ts')], bundle: true, format: 'cjs', platform: 'node',
    outfile: path.join(tmp, 'out.cjs'), resolveExtensions: ['.ts', '.tsx', '.js', '.json'], logLevel: 'silent',
    // The Android bundle reaches config.ts (Vite's import.meta.env) through the cloud client; node has no Vite, so give it an
    // empty env — serverPresence's pure logic (classify, the snapshot, the DI deps) never reads it.
    define: { 'import.meta.env': '{}' },
  });
  return createRequire(import.meta.url)(path.join(tmp, 'out.cjs'));
}

const P = bundle('bind-presence', 'apps/android/src/shop/serverPresenceCore.ts');
const D = bundle('bind-grant', 'apps/server/src/lib/deviceGrant.ts');

const run = async () => {
  console.log('\nclassify (pure)');
  {
    const link = { url: 'http://a', cert: 'C' };
    ok('not bound → null (a tablet with no branch server is untouched)',
      P.classify({ bound: false, ownReachable: false, heard: [] }).state === null);
    ok('own server reachable → home',
      P.classify({ bound: true, ownReachable: true, heard: [] }).state === 'home');
    {
      const r = P.classify({ bound: true, ownReachable: false, heard: [{ url: 'http://new', business: null, server: null, certMatches: true }] });
      ok('own server at a new IP is home (and names the new address to re-pin)', r.state === 'home' && r.rebindUrl === 'http://new');
    }
    {
      const r = P.classify({ bound: true, ownReachable: false, heard: [{ url: 'http://x', business: 'Other Ltd', server: 'Westlands', certMatches: false }] });
      ok('a foreign server is away_foreign (with what it saw)', r.state === 'away_foreign' && r.seen?.business === 'Other Ltd' && r.seen?.server === 'Westlands');
    }
    ok('nothing heard → away_no_server',
      P.classify({ bound: true, ownReachable: false, heard: [] }).state === 'away_no_server');
    void link;
  }

  console.log('\nrunPresence (DI — no device)');
  {
    const link = { url: 'http://a', cert: 'C' };
    const base = () => {
      const reports = []; const rebinds = [];
      return { reports, rebinds, deps: {
        readLink: async () => link,
        reachOwn: async () => false,
        scan: async () => [],
        rebind: async (u) => { rebinds.push(u); },
        report: async (state, seen) => { reports.push({ state, seen }); },
      } };
    };

    P._resetPresence();
    { // unbound
      const r = await P.runPresence({ readLink: async () => null, reachOwn: async () => false, scan: async () => [], rebind: async () => {}, report: async () => { throw new Error('should not report'); } });
      ok('unbound reports nothing and is null', r === null && P.presenceState() === null);
    }

    P._resetPresence();
    { // home, then steady home
      const t = base();
      await P.runPresence({ ...t.deps, reachOwn: async () => true, scan: async () => { throw new Error('no scan when reachable'); } });
      ok('reachable → home', P.presenceState() === 'home');
      ok('coming home is reported once (clears away_since server-side)', t.reports.length === 1 && t.reports[0].state === 'home');
      await P.runPresence({ ...t.deps, reachOwn: async () => true, scan: async () => [] });
      ok('a steady home is not re-sent', t.reports.length === 1);
    }

    P._resetPresence();
    { // away_no_server reports
      const t = base();
      await P.runPresence({ ...t.deps, reachOwn: async () => false, scan: async () => [] });
      ok('no server heard → away_no_server, reported', P.presenceState() === 'away_no_server' && t.reports.at(-1)?.state === 'away_no_server');
    }

    P._resetPresence();
    { // away_foreign reports with seen
      const t = base();
      await P.runPresence({ ...t.deps, reachOwn: async () => false, scan: async () => [{ url: 'http://x', business: 'B', server: 'S', certMatches: false }] });
      ok('foreign server → away_foreign, reported with what it saw', P.presenceState() === 'away_foreign' && t.reports.at(-1)?.seen?.server === 'S');
    }

    P._resetPresence();
    { // re-pin on a moved own server
      const t = base();
      await P.runPresence({ ...t.deps, reachOwn: async () => false, scan: async () => [{ url: 'http://moved', business: null, server: null, certMatches: true }] });
      ok('own server found at a new IP → home and re-pinned', P.presenceState() === 'home' && t.rebinds[0] === 'http://moved');
    }
  }

  console.log('\nkill-switch snapshot');
  {
    P._resetPresence();
    ok('a fresh tablet is not disabled', P.isTabletDisabled() === false);
    P.markDisabled();
    ok('markDisabled flips it', P.isTabletDisabled() === true);
    P._resetPresence();
    ok('reset clears it', P.isTabletDisabled() === false);
  }

  console.log('\ntillBlockReason (pure — the kill-switch reason)');
  {
    ok('no row → unknown', D.tillBlockReason(null) === 'unknown');
    ok('approved → null (may use its session)', D.tillBlockReason({ status: 'approved' }) === null);
    ok('pending → blocked', D.tillBlockReason({ status: 'pending' }) === 'blocked');
    ok('a disabled device is blocked as "disabled"', D.tillBlockReason({ status: 'approved', disabled_at: '2026-11-16T00:00:00Z' }) === 'disabled');
    ok('retired beats disabled', D.tillBlockReason({ retired_at: 'x', disabled_at: 'y' }) === 'retired');
    ok('disabled beats a merely-approved status', D.tillBlockReason({ status: 'approved', disabled_at: 'y' }) === 'disabled');
  }

  console.log('\nSource — the server + Android + dashboard wiring is in place');
  {
    const mig = read('migrations/192_user_devices_server_bind.sql');
    ok('migration 192 adds disabled_at + away_state', /ADD COLUMN IF NOT EXISTS disabled_at/.test(mig) && /ADD COLUMN IF NOT EXISTS away_state/.test(mig));
    ok('schema index carries the new columns', /"disabled_at"/.test(read('scripts/schema-index.json')) && /"away_state"/.test(read('scripts/schema-index.json')));
    ok('the presence core is import-free (so CI bundles it without Capacitor installed)', !/^import /m.test(read('apps/android/src/shop/serverPresenceCore.ts')));

    const mw = read('apps/server/src/middleware/auth.ts');
    ok('middleware 403s a disabled till as DEVICE_DISABLED', /tillBlock === 'disabled'[\s\S]*?DEVICE_DISABLED/.test(mw));

    const pos = read('apps/server/src/routes/pos.ts');
    ok('the presence endpoint exists and is till-only', /router\.post\('\/server-presence'/.test(pos) && /Only a POS can report its branch server/.test(pos));
    ok('presence sets away_since only on the transition into away', /was === null \|\| was === 'home'\) patch\.away_since = now/.test(pos));

    const dev = read('apps/server/src/routes/devices.ts');
    ok('disable + enable endpoints, owner-scoped', /router\.patch\('\/:id\/disable', requirePermission\('devices\.retire'\)/.test(dev) && /router\.patch\('\/:id\/enable', requirePermission\('devices\.retire'\)/.test(dev));
    ok('the fleet exposes disabled + awayState', /disabled:\s+!!d\.disabled_at/.test(dev) && /awayState:\s+d\.away_state/.test(dev));

    const wa = read('apps/server/src/lib/writeActivity.ts');
    ok('the presence heartbeat is not counted as a write', /pos\\\/server-presence\$/.test(wa));

    const ow = read('apps/android/src/shop/offlineWrites.ts');
    ok('a disabled tablet refuses writes before buffering', /deps\.isDisabled\?\.\(\)\) return disabledResponse\(\)/.test(ow));

    const shop = read('apps/android/src/screens/shop/ShopPos.tsx');
    ok('ShopPos starts the presence monitor and gates selling', /startPresenceMonitor\(\(\) => onlineRef\.current\)/.test(shop) && /isDisabled: \(\) => isTabletDisabled\(\)/.test(shop));
    ok('ShopPos mounts the away notice', /<AwayNotice branchName=/.test(shop));

    const fleet = read('apps/dashboard/src/pages/FleetPage.tsx');
    ok('FleetPage shows the away badge and a disable toggle', /Away from branch server/.test(fleet) && /setDisabled\(d\.id, !d\.disabled/.test(fleet));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
};
run();
