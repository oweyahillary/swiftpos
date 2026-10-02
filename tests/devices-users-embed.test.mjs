/**
 * devices-users-embed.test.mjs — A199 (device lists 500 after migration 97).
 *
 * Migration 97 added user_devices.retired_by REFERENCES public.users(id) — a SECOND
 * foreign key from user_devices to users (the first is user_id). PostgREST cannot
 * resolve a bare `users(...)` embed when two relationships exist, so both device
 * lists — GET /api/devices (Devices tab) and GET /api/devices/fleet (Terminals) —
 * began returning 500 the moment 97 was applied. The fix disambiguates the embed to
 * the user_id relationship by its constraint name.
 *
 * Source-level; mutation-checkable. This pins the coupling so re-adding a bare
 * users() embed (or dropping the hint) fails loudly instead of 500-ing in prod.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const devices = fs.readFileSync(path.join(root, 'apps/server/src/routes/devices.ts'), 'utf8');
const mig97   = fs.readFileSync(path.join(root, 'migrations/97_user_devices_retire.sql'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n       ${e.message}`); }
};

ok('cause is present: migration 97 adds a second user_devices -> users FK', () => {
  assert.match(mig97, /retired_by uuid REFERENCES public\.users\(id\)/,
    'retired_by is the second FK that makes a bare users() embed ambiguous');
});

ok('no bare users() embed remains on any user_devices query', () => {
  // A bare "users (" (not "users!<fk>") in this file means an ambiguous embed → 500.
  const bare = devices.match(/\busers\s*\(/g) || [];
  assert.strictEqual(bare.length, 0,
    `found ${bare.length} bare users() embed(s); every one must be users!user_devices_user_id_fkey(...)`);
});

ok('both device lists disambiguate to the user_id relationship', () => {
  const hints = devices.match(/users!user_devices_user_id_fkey\s*\(/g) || [];
  assert.ok(hints.length >= 2,
    `expected the fleet AND the devices-list embeds to be disambiguated; found ${hints.length}`);
});

ok('the embed alias is unchanged so the mapping still reads d.users.name', () => {
  assert.match(devices, /user:\s*d\.users\?\.name/,
    'the hinted embed is still aliased users, so existing d.users?.name mapping holds');
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
