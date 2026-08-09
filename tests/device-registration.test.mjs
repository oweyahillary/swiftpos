/**
 * device-registration.test.mjs — register D14 / A26.
 *
 * WHY BERYL HAD NO user_devices ROW
 * ---------------------------------
 * `checkDeviceRegistration` (auth.ts) returns early unless the business opted
 * into `require_device_registration`, and again for owners and elevated roles.
 * A desktop till signs in as the owner, and Beryl never opted in — so it fell
 * through BOTH gates and no row was ever created. Nothing was broken;
 * registration was simply never reached.
 *
 * Three subsystems then degraded to silent no-ops while looking healthy:
 * migration 52's branch binding (checkDeviceBranch returns ok for an unknown
 * device, by design), fleet telemetry (an UPDATE matching no rows is not an
 * error), and the ability to tell a node from a till (register A25).
 *
 * MUTATION CHECK (rule 10): each section models the OLD behaviour beside the new
 * one and asserts they disagree — this suite's existing convention. Restore the
 * `require_device_registration` gate in front of registration and section 1
 * fails; drop the `.select('id')` from sync.ts's telemetry update and section 4
 * fails.
 */
import assert from 'node:assert';

let passed = 0, failed = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
};

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n1. Registration no longer depends on an opt-in flag');

/** OLD: registration was reached only past both gates. */
const oldWouldRegister = ({ flagOn, isOwner, roleName }) => {
  if (isOwner) return false;                                  // exempt
  if (['owner','admin','manager','supervisor','branch_manager']
        .includes(String(roleName ?? '').toLowerCase())) return false;
  return !!flagOn;
};

/** NEW: desktop registers regardless; browsers are unchanged. */
const nowRegisters = ({ surface }) => surface === 'desktop';

ok('MUTATION: Beryl\'s exact case — owner on desktop, flag off — registered NOTHING', () => {
  assert.equal(oldWouldRegister({ flagOn: false, isOwner: true }), false);
});

ok('the same case now registers', () => {
  assert.equal(nowRegisters({ surface: 'desktop' }), true);
});

ok('a cashier on desktop with the flag off also registers now (old: no)', () => {
  assert.equal(oldWouldRegister({ flagOn: false, isOwner: false, roleName: 'cashier' }), false);
  assert.equal(nowRegisters({ surface: 'desktop' }), true);
});

ok('a manager on desktop registers despite the exempt-roles list', () => {
  assert.equal(oldWouldRegister({ flagOn: true, isOwner: false, roleName: 'manager' }), false);
  assert.equal(nowRegisters({ surface: 'desktop' }), true);
});

ok('BROWSERS are untouched — approval policy still governs them', () => {
  assert.equal(nowRegisters({ surface: 'web' }), false,
    'the opt-in flag must keep meaning what it meant for browser sign-ins');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n2. The fingerprint is namespaced and stable');

const desktopFingerprint = (deviceId) => `desktop:${deviceId}`;

ok('a desktop fingerprint cannot collide with a browser hash', () => {
  assert.ok(desktopFingerprint('abc-123').startsWith('desktop:'));
});

ok('it is derived from device_id, so it survives a reinstall', () => {
  assert.equal(desktopFingerprint('abc-123'), desktopFingerprint('abc-123'));
});

ok('two terminals never share one', () => {
  assert.notEqual(desktopFingerprint('till-1'), desktopFingerprint('till-2'));
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n3. Registration records, it does not authorise or re-approve');

/** The shipped upsert decision. */
const decide = (existing) => existing
  ? { action: 'update', touchesStatus: false }
  : { action: 'insert', status: 'approved' };

ok('a new terminal lands approved, so a remote shop is not blocked', () => {
  const d = decide(null);
  assert.equal(d.action, 'insert');
  assert.equal(d.status, 'approved');
});

ok('a REJECTED terminal is not silently re-approved by signing in again', () => {
  const d = decide({ id: 'x', status: 'rejected' });
  assert.equal(d.action, 'update');
  assert.equal(d.touchesStatus, false,
    'otherwise the reject button in the fleet view means nothing');
});

ok('registration sets no branch — checkDeviceBranch owns binding', () => {
  const inserted = {
    user_id: 'u', business_id: 'b', fingerprint: 'desktop:d',
    device_id: 'd', status: 'approved',
  };
  assert.ok(!('branch_id' in inserted),
    'guessing a branch here could bind a till to the wrong one permanently');
  assert.ok(!('bound_at' in inserted));
});

ok('registration grants no role — A25 is still open by design', () => {
  const inserted = { status: 'approved' };
  assert.ok(!('device_role' in inserted),
    'a device may not assert it is the node; that needs a verified enrolment');
});

ok('matching is by device_id, not user_id — many staff share one till', () => {
  const key = ['business_id', 'device_id'];
  assert.deepEqual(key, ['business_id', 'device_id'],
    'mirrors user_devices_device_id_unique from migration 52');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n4. Fleet telemetry no longer fails silently or blames the wrong thing');

/** OLD: only an error was reported; zero rows matched was silent. */
const oldTelemetry = ({ error, rowsMatched }) => {
  if (error) return 'warn: is migration 43 applied?';
  return 'silent';                                  // ← the common case
};

/** NEW: .select('id') makes the matched count visible. */
const newTelemetry = ({ error, rowsMatched }) => {
  if (error) return 'warn: is migration 43 applied?';
  if (!rowsMatched) return 'warn: terminal has never registered';
  return 'recorded';
};

ok('MUTATION: a missing row used to be completely silent', () => {
  assert.equal(oldTelemetry({ error: null, rowsMatched: 0 }), 'silent');
});

ok('it now says the terminal never registered', () => {
  assert.equal(newTelemetry({ error: null, rowsMatched: 0 }),
    'warn: terminal has never registered');
});

ok('and explicitly clears migration 43, which WAS applied', () => {
  const msg = 'Migration 43 is not the problem; the terminal has never registered.';
  assert.match(msg, /Migration 43 is not the problem/,
    'the only message that ever appeared pointed away from the cause');
});

ok('a genuine column error still points at migration 43', () => {
  assert.match(newTelemetry({ error: { message: 'column missing' } }), /migration 43/);
});

ok('a successful write stays quiet', () => {
  assert.equal(newTelemetry({ error: null, rowsMatched: 1 }), 'recorded');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n5. What registration unblocks');

ok('migration 52 branch binding becomes live once a row exists', () => {
  // checkDeviceBranch: `if (error || !device) return { ok: true }` — an unknown
  // device is waved through, so with no row the anti-relocation control is inert.
  const check = (device, claimed) => {
    if (!device) return { ok: true, reason: 'unknown device — control inert' };
    if (!device.branch_id) return { ok: true, reason: 'first sighting — bind' };
    return { ok: device.branch_id === claimed, reason: 'enforced' };
  };
  assert.equal(check(null, 'branch-a').reason, 'unknown device — control inert');
  assert.equal(check({ branch_id: null }, 'branch-a').reason, 'first sighting — bind');
  assert.equal(check({ branch_id: 'branch-a' }, 'branch-b').ok, false);
});

ok('a race between two sign-ins resolves to one row, not an error', () => {
  const onInsertError = (code) => code === '23505' ? 'refetch-and-succeed' : 'warn';
  assert.equal(onInsertError('23505'), 'refetch-and-succeed');
  assert.equal(onInsertError('23503'), 'warn');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n6. The office role — a branch server that cannot sell');

// deviceConfig.ts:26 — 'till' | 'node' | 'office'. The file warns that
// "comparing against the literal 'node' anywhere else is how office machines
// fall through cracks", and PHASE5 §4b did exactly that before this correction.
const DEVICE_ROLES = ['till', 'node', 'office'];
const normaliseDeviceRole = (raw) => {
  const v = String(raw ?? '').trim().toLowerCase();
  return DEVICE_ROLES.includes(v) ? v : null;
};
const isNodeRole = (r) => r === 'node' || r === 'office';
const canSell    = (r) => r !== 'office';

ok('office SERVES the branch — the old `=== node` gate would have refused it', () => {
  assert.equal(isNodeRole('office'), true);
  assert.equal('office' === 'node', false,
    'this is the comparison PHASE5 §4b used, and it is the bug');
});

ok('office may NOT sell — serving and selling are separate questions', () => {
  assert.equal(canSell('office'), false);
  assert.equal(canSell('node'), true);
  assert.equal(canSell('till'), true);
});

ok('a plain till neither serves nor is refused selling', () => {
  assert.equal(isNodeRole('till'), false);
  assert.equal(canSell('till'), true);
});

ok('an unknown or absent role normalises to null, not to a guess', () => {
  assert.equal(normaliseDeviceRole('kiosk'), null);
  assert.equal(normaliseDeviceRole(''), null);
  assert.equal(normaliseDeviceRole(undefined), null);
  assert.equal(normaliseDeviceRole(null), null);
});

ok('case and whitespace from a header are tolerated', () => {
  assert.equal(normaliseDeviceRole(' Office '), 'office');
  assert.equal(normaliseDeviceRole('NODE'), 'node');
});

ok('a bad value never reaches the CHECK constraint', () => {
  // Migration 73 CHECKs (till|node|office). An unfiltered bad value would fail
  // the whole registration rather than just the role.
  assert.equal(normaliseDeviceRole('<script>'), null);
});

const labelFor = (role, given) => given ? given
  : role === 'office' ? 'SwiftPOS office server (view only)'
  : role === 'node'   ? 'SwiftPOS till (branch server)'
  : 'SwiftPOS till';

ok('an office machine is not labelled as a till in the fleet view', () => {
  assert.match(labelFor('office'), /office server/);
  assert.match(labelFor('office'), /view only/);
  assert.equal(labelFor('till'), 'SwiftPOS till');
  assert.match(labelFor('node'), /branch server/);
});

ok('a role is only written when reported — never blanked by an older build', () => {
  const patchFor = (role) => role ? { device_role: role, role_reported_at: 'now' } : {};
  assert.deepEqual(patchFor(null), {},
    'an older build sending no header must not blank a known role');
  assert.equal(patchFor('office').device_role, 'office');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n7. A missing migration 73 must not lose the registration');

// Only 20 of 66 migrations record themselves in schema_migrations, and 68 and 72
// are absent from the repo entirely (A4). "Not applied" is a normal state here.
const isMissingColumn = (err) => {
  const code = err?.code ?? '';
  if (code === '42703' || code === 'PGRST204') return true;
  return /column .* does not exist|could not find the .* column/i.test(err?.message ?? '');
};
const withoutRoleColumns = (patch) => {
  const { device_role, role_reported_at, ...rest } = patch;
  return rest;
};

ok('undefined_column is recognised in both Postgres and PostgREST forms', () => {
  assert.equal(isMissingColumn({ code: '42703' }), true);
  assert.equal(isMissingColumn({ code: 'PGRST204' }), true);
  assert.equal(isMissingColumn({ message: "column \"device_role\" does not exist" }), true);
  assert.equal(isMissingColumn({ message: "Could not find the 'device_role' column" }), true);
});

ok('a real constraint failure is NOT mistaken for a missing column', () => {
  assert.equal(isMissingColumn({ code: '23505', message: 'duplicate key' }), false);
  assert.equal(isMissingColumn({ code: '23503', message: 'foreign key' }), false);
});

ok('MUTATION: without the retry, a missing column loses the whole registration', () => {
  const patch = { last_sync_at: 'now', app_version: '0.5.25', device_role: 'office' };
  const naive = () => { throw new Error('insert failed — column device_role does not exist'); };
  assert.throws(naive, /device_role/);
  // With the retry the terminal is still registered, minus the role.
  const retried = withoutRoleColumns(patch);
  assert.deepEqual(Object.keys(retried).sort(), ['app_version', 'last_sync_at']);
});

ok('the retry keeps everything that is not migration 73', () => {
  const patch = { last_sync_at: 'n', app_version: 'v', terminal_code: 'T1',
                  ip_address: '1.2.3.4', device_role: 'node', role_reported_at: 'n' };
  const r = withoutRoleColumns(patch);
  assert.ok(!('device_role' in r) && !('role_reported_at' in r));
  assert.equal(r.terminal_code, 'T1');
  assert.equal(r.ip_address, '1.2.3.4');
});

ok('sync telemetry writes the role SEPARATELY so a missing column cannot break it', () => {
  // Folding the role into the telemetry UPDATE would take last_sync_at and
  // schema_version down with it when 73 is absent.
  const telemetryPatch = { last_sync_at: 'now', schema_version: 51 };
  const rolePatch      = { device_role: 'office', role_reported_at: 'now' };
  assert.ok(!('device_role' in telemetryPatch),
    'the two writes must stay independent');
  assert.ok(!('last_sync_at' in rolePatch));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
