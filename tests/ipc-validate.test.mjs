/**
 * ipc-validate.test.mjs — the shared IPC payload validator (register D7).
 *
 *   node ipc-validate.test.mjs
 *
 * Two halves, like the D11 test:
 *   1. TRUTH TABLE — the validator is pure logic, copied here and kept in sync by
 *      hand (a .mjs test cannot import the .ts module), asserting the rules a
 *      boundary check must get right: required vs optional, type mismatches,
 *      string min length, integer numbers, string arrays, extra fields allowed,
 *      non-object payloads rejected, and assert-throws on bad input.
 *   2. SOURCE GUARD — reads apps/desktop/src/main/ipcValidate.ts and ipcHandlers.ts
 *      and asserts the real module exports the functions and that the reference
 *      channel (escpos:setKitchenExclusions) actually adopts the validator, so
 *      the mechanism cannot quietly disappear.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let pass = 0, fail = 0;
function ok(label, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}  ${detail}`); }
}

// ── copy of ipcValidate.ts (kept in sync by hand) ───────────────────────────
function checkField(name, spec, value) {
  const absent = value === undefined || value === null;
  if (absent) return spec.optional ? null : `${name} is required`;
  switch (spec.t) {
    case 'string':
      if (typeof value !== 'string') return `${name} must be a string`;
      if (spec.min !== undefined && value.length < spec.min) return `${name} too short`;
      return null;
    case 'number':
      if (typeof value !== 'number' || Number.isNaN(value)) return `${name} must be a number`;
      if (spec.int && !Number.isInteger(value)) return `${name} must be an integer`;
      return null;
    case 'boolean':
      if (typeof value !== 'boolean') return `${name} must be a boolean`;
      return null;
    case 'stringArray':
      if (!Array.isArray(value) || value.some(v => typeof v !== 'string'))
        return `${name} must be an array of strings`;
      return null;
  }
}
function validatePayload(schema, payload) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload))
    return { ok: false, error: 'payload must be an object' };
  for (const [name, spec] of Object.entries(schema)) {
    const err = checkField(name, spec, payload[name]);
    if (err) return { ok: false, error: err };
  }
  return { ok: true, value: payload };
}
function assertPayload(schema, payload) {
  const r = validatePayload(schema, payload);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}
function expectStringArray(payload, name = 'value') {
  const err = checkField(name, { t: 'stringArray' }, payload);
  return err ? { ok: false, error: err } : { ok: true, value: payload };
}

// ── 1. Truth table ──────────────────────────────────────────────────────────
const S = { pin: { t: 'string', min: 1 }, branch_id: { t: 'string' }, count: { t: 'number', int: true, optional: true } };

ok('valid object passes',            validatePayload(S, { pin: '1234', branch_id: 'b1' }).ok === true);
ok('missing required field fails',   validatePayload(S, { pin: '1234' }).ok === false);
ok('wrong type fails',               validatePayload(S, { pin: 1234, branch_id: 'b1' }).ok === false);
ok('empty string under min fails',   validatePayload(S, { pin: '', branch_id: 'b1' }).ok === false);
ok('optional absent is fine',        validatePayload(S, { pin: '1', branch_id: 'b1' }).ok === true);
ok('optional present but wrong fails',validatePayload(S, { pin: '1', branch_id: 'b1', count: 1.5 }).ok === false);
ok('extra fields are allowed',       validatePayload(S, { pin: '1', branch_id: 'b1', extra: 'x' }).ok === true);
ok('non-object payload rejected',    validatePayload(S, 'nope').ok === false);
ok('array payload rejected',         validatePayload(S, ['a']).ok === false);
ok('null payload rejected',          validatePayload(S, null).ok === false);

let threw = false;
try { assertPayload(S, {}); } catch { threw = true; }
ok('assertPayload throws on bad input', threw);
ok('assertPayload returns value on good input',
   assertPayload(S, { pin: '1', branch_id: 'b1' }).pin === '1');

ok('expectStringArray accepts string[]',      expectStringArray(['a', 'b']).ok === true);
ok('expectStringArray rejects a non-array',   expectStringArray('a').ok === false);
ok('expectStringArray rejects mixed array',   expectStringArray(['a', 1]).ok === false);
ok('expectStringArray accepts empty array',   expectStringArray([]).ok === true);

// ── 2. Source guard — the real module and its adoption ──────────────────────
const validateSrc = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/ipcValidate.ts'), 'utf8');
ok('ipcValidate exports validatePayload',  /export function validatePayload\b/.test(validateSrc));
ok('ipcValidate exports assertPayload',    /export function assertPayload\b/.test(validateSrc));
ok('ipcValidate exports expectStringArray',/export function expectStringArray\b/.test(validateSrc));

const handlersSrc = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/ipcHandlers.ts'), 'utf8');
ok('ipcHandlers imports the validator', /from '\.\/ipcValidate'/.test(handlersSrc));
ok('setKitchenExclusions adopts validation',
   /escpos:setKitchenExclusions'[\s\S]{0,300}expectStringArray\(/.test(handlersSrc));

// Rollout adoptions (D7): each channel validates its payload at the boundary.
const adopts = (channel) => {
  const body = (handlersSrc.split(`ipcMain.handle('${channel}'`)[1] ?? '').split('ipcMain.handle(')[0];
  return /assertPayload</.test(body);
};
ok('auth:verifyPin adopts validation',  adopts('auth:verifyPin'));
ok('order:void adopts validation',      adopts('order:void'));
ok('auth:enrolDevice adopts validation', adopts('auth:enrolDevice'));
// The primary sale path is intentionally NOT validated blind — flagged, not done.
ok('order:create is left unvalidated (deliberate, needs a live-tested schema)',
   !adopts('order:create'));

console.log(`\n${fail === 0
  ? `All ${pass} checks passed. The IPC boundary has a shared validator.`
  : `${fail} FAILED (${pass} passed)`}`);
process.exit(fail === 0 ? 0 : 1);
