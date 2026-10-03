/**
 * till-name.test.mjs — A273 follow-up (2026-09-26): the web POS's till picker shows each till's REAL name.
 *
 * Before: no till ever sent its name or code to the cloud, so every till's user_devices row carried the
 * generic label "SwiftPOS till" and the picker listed the same made-up name for every till. Now the till
 * sends `terminal_code` + `device_name` (the name typed at setup) on enrolment and on every cashier
 * sign-in; the cloud writes the name on EVERY sign-in (owner: the setup name always wins); the picker
 * shows "T1 — Front Counter" and never the generic label.
 *
 *   node tests/till-name.test.mjs          (build apps/server first — section 1 runs its dist/)
 *
 * RUNS the shipped code where it can: section 1 calls the COMPILED registerDesktopTerminal with the
 * Supabase client's from() replaced by a recorder, so it sees the exact row the cloud would write;
 * section 2 runs the dashboard's tillName() and compares its generic list with the cloud's. Sections 3–4
 * pin source the tests cannot execute (Express routes; Electron main) — said so, per rule 9.
 *
 * MUTATIONS TO CONFIRM BITE:
 *   - drop `if (reportedLabel) patch.device_label = reportedLabel`      → "a sign-in writes the setup name" fails
 *   - write the label even when none is reported                        → "no name reported → the label is left alone" fails
 *   - tillName shows a generic label                                    → "never shows the generic label" fails
 *   - a generic label changed on one side only                          → "the web hides exactly the cloud's generic labels" fails
 *   - remove device_name from the verify-pin body                       → "the till sends its name on every sign-in" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.TILL_NAME_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, TILL_NAME_TS: '1' } });
  process.exitCode = r.status ?? 1;
} else {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  let pass = 0, fail = 0;
  const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

  // ── 1. The cloud: the REAL registerDesktopTerminal, database replaced by a recorder ──
  const dist = path.join(ROOT, 'apps/server/dist/lib');
  if (!fs.existsSync(path.join(dist, 'deviceRegistry.js'))) {
    console.log('\nCannot load apps/server/dist/lib/deviceRegistry.js — build the server first:\n  cd apps/server && npm run build\n');
    process.exitCode = 1;
  } else {
    process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';            // never contacted: from() is replaced below
    process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
    const require = createRequire(import.meta.url);
    const { supabase } = require(path.join(dist, 'supabase.js'));
    const { registerDesktopTerminal } = require(path.join(dist, 'deviceRegistry.js'));

    // A minimal PostgREST stand-in: lookup → `existing`; update/insert → recorded.
    let existing = null; const writes = [];
    supabase.from = (table) => {
      const q = { table, op: 'select', payload: null };
      const chain = {
        select() { return chain; }, eq() { return chain; }, is() { return chain; },
        update(p) { q.op = 'update'; q.payload = p; writes.push(q); return chain; },
        insert(p) { q.op = 'insert'; q.payload = p; writes.push(q); return chain; },
        maybeSingle() { return Promise.resolve(q.op === 'select' ? { data: existing, error: null } : { data: { id: 'new-row' }, error: null }); },
        then(res, rej) { return Promise.resolve({ data: [{ id: 'row' }], error: null }).then(res, rej); },
      };
      return chain;
    };
    const run = async (identity, row) => { existing = row; writes.length = 0; await registerDesktopTerminal('biz-1', 'user-1', { deviceId: 'dev-1', ...identity }); return writes.filter((w) => w.table === 'user_devices'); };

    await ok('a sign-in writes the setup name and code onto the EXISTING till row (the setup name always wins)', async () => {
      const w = await run({ terminalCode: 'T1', label: '  Front   Counter ' }, { id: 'row-1', status: 'approved' });
      const up = w.find((x) => x.op === 'update');
      assert.ok(up, 'no update written');
      assert.equal(up.payload.device_label, 'Front Counter');
      assert.equal(up.payload.terminal_code, 'T1');
    });
    await ok('no name reported (an older till build) → the label is left alone, never blanked', async () => {
      const w = await run({ terminalCode: 'T2' }, { id: 'row-2', status: 'approved' });
      const up = w.find((x) => x.op === 'update');
      assert.ok(up && !('device_label' in up.payload), JSON.stringify(up?.payload));
    });
    await ok('a NEW till row is created with its setup name, not "SwiftPOS till"', async () => {
      const w = await run({ terminalCode: 'T3', label: 'Bar' }, null);
      const ins = w.find((x) => x.op === 'insert');
      assert.ok(ins, 'no insert written');
      assert.equal(ins.payload.device_label, 'Bar');
    });
    await ok('a new till with no name still gets the generic label (unchanged behaviour)', async () => {
      const w = await run({}, null);
      assert.equal(w.find((x) => x.op === 'insert')?.payload.device_label, 'ZapTill till');   // 0.6.37: the product's name
    });
  }

  // ── 2. The web: the dashboard's real tillName(), and its generic list against the cloud's ──
  const web = await import(pathToFileURL(path.join(ROOT, 'apps/dashboard/src/lib/posTerminal.ts')).href);
  const cloud = await import(pathToFileURL(path.join(ROOT, 'apps/server/src/lib/terminalLabel.ts')).href);
  await ok('the web hides exactly the cloud\'s generic labels', () => {
    assert.deepEqual([...web.GENERIC_TERMINAL_LABELS], [...cloud.GENERIC_TERMINAL_LABELS]);
    for (const role of ['till', 'node', 'office', null]) assert.ok(web.GENERIC_TERMINAL_LABELS.includes(cloud.labelFor(role)), `labelFor(${role})`);
  });
  await ok('code + real name → "T1 — Front Counter"', () => {
    assert.equal(web.tillName({ device_id: 'dev-aaaa', terminal_code: 'T1', device_label: 'Front Counter' }), 'T1 — Front Counter');
  });
  await ok('never shows the generic label: "T2", not "T2 — SwiftPOS till"', () => {
    for (const g of cloud.GENERIC_TERMINAL_LABELS) assert.equal(web.tillName({ device_id: 'dev-bbbb', terminal_code: 'T2', device_label: g }), 'T2');
  });
  await ok('no code, real name → the name; neither → "Till" + the end of its id, so two tills never look alike', () => {
    assert.equal(web.tillName({ device_id: 'x', terminal_code: null, device_label: 'Bar' }), 'Bar');
    const a = web.tillName({ device_id: 'dev-1234', terminal_code: null, device_label: 'SwiftPOS till' });
    const b = web.tillName({ device_id: 'dev-9876', terminal_code: '', device_label: null });
    assert.equal(a, 'Till 1234'); assert.equal(b, 'Till 9876');
  });
  await ok('cleanLabel: trims, collapses spaces, caps at 64, empty → null', () => {
    assert.equal(cloud.cleanLabel('  a   b  '), 'a b');
    assert.equal(cloud.cleanLabel('x'.repeat(80)).length, 64);
    assert.equal(cloud.cleanLabel('   '), null); assert.equal(cloud.cleanLabel(undefined), null);
  });
  await ok('the picker renders tillName(), not the raw label', () => {
    const m = read('apps/dashboard/src/pages/pos/ShiftModal.tsx');
    assert.match(m, /\{tillName\(t\)\}/); assert.doesNotMatch(m, /t\.device_label \?\? t\.device_id/);
  });

  // ── 3. The cloud routes pass the name through (source pin — Express + DB not run here) ──
  await ok('both registration points (enrol/redeem and verify-pin) pass req.body.device_name as the label', () => {
    const a = read('apps/server/src/routes/auth.ts');
    assert.equal((a.match(/label:\s+req\.body\?\.device_name \?\? null,/g) || []).length, 2);
  });

  // ── 4. The till sends them (source pin — Electron main not run here) ──
  await ok('the till sends its name and code on enrolment AND on every sign-in', () => {
    const s = read('apps/desktop/src/main/ipcHandlers.ts');
    const at = s.indexOf('}/api/auth/enrol/redeem`');   // the fetch, not the file-header comment
    const enrol = s.slice(at, at + 1500);
    // A345 (0.6.15): the sign-in's body is built by verifyPinBody(), shared with the offline session's background upgrade.
    const at2 = s.indexOf("res = await ownerFetch('/api/auth/verify-pin'");   // the sign-in (the upgrade has its own call)
    const call = s.slice(at2, at2 + 300);
    assert.match(call, /body: verifyPinBody\(String\(pin\), branch_id\)/, 'the sign-in sends verifyPinBody');
    const pin = s.slice(s.indexOf('function verifyPinBody('), s.indexOf('function verifyPinBody(') + 1200);
    for (const [name, body] of [['enrol', enrol], ['verify-pin', pin]]) {
      assert.match(body, /terminal_code: getDeviceConfig\(\)\?\.terminal_code \?\? undefined,/, name);
      assert.match(body, /device_name: {3}getDeviceConfig\(\)\?\.device_name \?\? undefined,/, name);
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}
