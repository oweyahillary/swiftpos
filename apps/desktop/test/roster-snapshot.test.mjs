/**
 * roster-snapshot.test.mjs — A20 (register A163). Proves rosterSnapshot, the
 * pure pack/unpack of the branch staff roster the node serves and a peer applies.
 * The failure mode here is a LOCKED-OUT SHOP: storeBranchStaff replaces wholesale,
 * so applying an empty/pinless snapshot would leave a peer able to authenticate no
 * one — the exact thing A20 exists to prevent. So the asserts target that guard,
 * and that only offline-usable (bcrypt) PINs cross.
 *
 * Drives the REAL compiled dist/main/rosterSnapshot.js — pure, no SQLite/Electron.
 * Does NOT prove the /node/roster endpoint, the safeStorage unwrap/rewrap, the
 * peer pull, or storeBranchStaff — those close on the live node+peer target (rule 16).
 *
 *   Run:  npx tsc -b tsconfig.main.json --force   (in apps/desktop)
 *         node test/roster-snapshot.test.mjs
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main', 'rosterSnapshot.js');
if (!fs.existsSync(dist)) {
  console.error('dist/main/rosterSnapshot.js not built. Run:  npx tsc -b tsconfig.main.json --force');
  process.exit(1);
}
const { buildRosterSnapshot, unpackRosterSnapshot, rosterVersion } = await import(pathToFileURL(dist).href);

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}`); } };

const BCRYPT = '$2b$10$abcdefghijklmnopqrstuv';
const BCRYPT2 = '$2b$10$ZZZZZZZZZZZZZZZZZZZZZZ';
const staff = (over = {}) => ({
  staff_id: 's1', name: 'Amina', role_name: 'cashier', permissions: { sell: true },
  pin_hash: BCRYPT, override_pin_hash: null, status: 'active', ...over,
});

// ── Node side: build ──
{
  const snap = buildRosterSnapshot('B1', [staff(), staff({ staff_id: 's2', name: 'Ben', pin_hash: BCRYPT2 })]);
  ok('build → source node + branch', snap.source === 'node' && snap.branch_id === 'B1');
  ok('build → both bcrypt staff kept', snap.roster.length === 2);
  ok('build → carries a version', typeof snap.roster_version === 'string' && snap.roster_version.length > 0);
}
{
  // A row with no bcrypt PIN can't authenticate offline — dropped on build.
  const snap = buildRosterSnapshot('B1', [staff(), staff({ staff_id: 's3', name: 'NoPin', pin_hash: null }), staff({ staff_id: 's4', name: 'Plain', pin_hash: '1234' })]);
  ok('build → drops staff with no bcrypt PIN', snap.roster.length === 1 && snap.roster[0].staff_id === 's1');
}
{
  const snap = buildRosterSnapshot('B1', [staff({ override_pin_hash: '9999' })]);
  ok('build → non-bcrypt override → null', snap.roster[0].override_pin_hash === null);
}

// ── Version: stable, and changes when a PIN changes ──
{
  const a = buildRosterSnapshot('B1', [staff()]).roster_version;
  const b = buildRosterSnapshot('B1', [staff()]).roster_version;
  ok('version stable for identical roster', a === b);
  const c = buildRosterSnapshot('B1', [staff({ pin_hash: BCRYPT2 })]).roster_version;
  ok('version changes when a PIN changes', a !== c);
}

// ── Peer side: apply decision — the lockout guard ──
{
  const snap = buildRosterSnapshot('B1', [staff()]);
  const d = unpackRosterSnapshot(snap);
  ok('valid snapshot → apply', d.apply === true && d.branchId === 'B1' && d.roster.length === 1);
}
{
  const d = unpackRosterSnapshot({ source: 'node', branch_id: 'B1', roster_version: 'x', roster: [] });
  ok('EMPTY roster → do NOT apply (never wipe → never lock out the shop)', d.apply === false);
}
{
  // All rows present but none has a usable bcrypt PIN → still a lockout if applied.
  const d = unpackRosterSnapshot({ source: 'node', branch_id: 'B1', roster_version: 'x',
    roster: [{ staff_id: 's1', name: 'X', pin_hash: null }, { staff_id: 's2', name: 'Y', pin_hash: '1234' }] });
  ok('all-pinless roster → do NOT apply', d.apply === false);
}
{
  ok('non-node object → do NOT apply', unpackRosterSnapshot({ roster: [staff()] }).apply === false);
  ok('missing branch_id → do NOT apply', unpackRosterSnapshot({ source: 'node', roster: [staff()] }).apply === false);
  ok('garbage → do NOT apply', unpackRosterSnapshot(null).apply === false);
}
{
  // A mixed snapshot applies, but only the usable staff cross.
  const d = unpackRosterSnapshot({ source: 'node', branch_id: 'B1', roster_version: 'x',
    roster: [staff(), { staff_id: 's9', name: 'Z', pin_hash: null }] });
  ok('mixed snapshot → apply, keeping only bcrypt staff', d.apply === true && d.roster.length === 1 && d.roster[0].staff_id === 's1');
}

// ── Round-trip: what the node builds, the peer applies ──
{
  const snap = buildRosterSnapshot('B1', [staff(), staff({ staff_id: 's2', name: 'Ben', pin_hash: BCRYPT2 })]);
  const d = unpackRosterSnapshot(snap);
  ok('round-trip: node build → peer apply, both staff, version carried',
     d.apply === true && d.roster.length === 2 && d.version === snap.roster_version);
  ok('round-trip: raw bcrypt survives for the peer to re-wrap', d.roster[0].pin_hash === BCRYPT);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
