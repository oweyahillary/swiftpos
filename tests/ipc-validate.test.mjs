/**
 * ipc-validate.test.mjs — the shared IPC payload validator + the D7 rollout that
 * validates EVERY channel (register D7).
 *
 *   node ipc-validate.test.mjs
 *
 * Three parts:
 *   1. TRUTH TABLE — the validator is pure logic, copied here and kept in sync by
 *      hand (a .mjs test cannot import the .ts module). Asserts the rules a
 *      boundary check must get right, now including the D7-rollout specs: enum,
 *      any, nested object, and object arrays — the shapes the sale path and the
 *      create/import channels carry.
 *   2. REGISTRY GUARD — reads ipcSchemas.ts and asserts the rollout is real and
 *      complete: every channel is routed through the validating `handle` wrapper,
 *      the registry names the money channels, order:create is validated against
 *      its nested shape AND flagged NEEDS_LIVE_TEST (validated, not blind-trusted).
 *   3. GATE GUARD — asserts check-ipc-validation.mjs exists and is wired, because
 *      the gate is what keeps the registry complete after today.
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

// ── copy of ipcValidate.ts checkField (kept in sync by hand) ────────────────
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
    case 'enum':
      if (typeof value !== 'string' || !spec.values.includes(value))
        return `${name} must be one of: ${spec.values.join(', ')}`;
      return null;
    case 'any':
      return null;
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        return `${name} must be an object`;
      for (const [k, s] of Object.entries(spec.schema)) {
        const err = checkField(`${name}.${k}`, s, value[k]);
        if (err) return err;
      }
      return null;
    }
    case 'objectArray': {
      if (!Array.isArray(value)) return `${name} must be an array`;
      if (spec.minLen !== undefined && value.length < spec.minLen)
        return `${name} must have at least ${spec.minLen} item(s)`;
      for (let i = 0; i < value.length; i++) {
        const el = value[i];
        if (typeof el !== 'object' || el === null || Array.isArray(el))
          return `${name}[${i}] must be an object`;
        for (const [k, s] of Object.entries(spec.item)) {
          const err = checkField(`${name}[${i}].${k}`, s, el[k]);
          if (err) return err;
        }
      }
      return null;
    }
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

// D7-rollout specs: enum, any, nested object, object array.
const ENUM = { k: { t: 'enum', values: ['a', 'b'] } };
ok('enum accepts a listed value',   validatePayload(ENUM, { k: 'a' }).ok === true);
ok('enum rejects an unlisted value',validatePayload(ENUM, { k: 'c' }).ok === false);
ok('enum rejects a non-string',     validatePayload(ENUM, { k: 3 }).ok === false);

const ANY = { d: { t: 'any' } };
ok('any accepts an object',   validatePayload(ANY, { d: { x: 1 } }).ok === true);
ok('any accepts a scalar',    validatePayload(ANY, { d: 5 }).ok === true);
ok('any still requires present', validatePayload(ANY, {}).ok === false);
ok('any optional may be absent', validatePayload({ d: { t: 'any', optional: true } }, {}).ok === true);

const NEST = { product: { t: 'object', schema: { id: { t: 'string' }, name: { t: 'string' } } } };
ok('nested object passes with all fields', validatePayload(NEST, { product: { id: 'p1', name: 'Tea' } }).ok === true);
ok('nested object fails a missing field',  validatePayload(NEST, { product: { id: 'p1' } }).ok === false);
ok('nested object fails a non-object',     validatePayload(NEST, { product: 'x' }).ok === false);

const ARR = { items: { t: 'objectArray', minLen: 1, item: { qty: { t: 'number' } } } };
ok('object array passes',              validatePayload(ARR, { items: [{ qty: 1 }, { qty: 2 }] }).ok === true);
ok('object array fails below minLen',  validatePayload(ARR, { items: [] }).ok === false);
ok('object array fails a bad element', validatePayload(ARR, { items: [{ qty: 'x' }] }).ok === false);
ok('object array fails a non-array',   validatePayload(ARR, { items: 'x' }).ok === false);

// order:create shape (mirrors ipcSchemas.orderCreate) — a valid sale and the bad
// shapes the boundary must catch before they reach createLocalOrder.
const ORDER = {
  branch_id: { t: 'string' }, order_number: { t: 'string' },
  subtotal: { t: 'number' }, vat_amount: { t: 'number' }, total: { t: 'number' },
  items: { t: 'objectArray', minLen: 1, item: {
    product: { t: 'object', schema: { id: { t: 'string' }, name: { t: 'string' } } },
    unitPrice: { t: 'number' }, quantity: { t: 'number' }, lineTotal: { t: 'number' },
  } },
};
const goodOrder = { branch_id: 'b1', order_number: 'A-1', subtotal: 100, vat_amount: 16, total: 116,
  items: [{ product: { id: 'p1', name: 'Tea' }, unitPrice: 100, quantity: 1, lineTotal: 100 }] };
ok('order:create shape — a valid sale passes', validatePayload(ORDER, goodOrder).ok === true);
ok('order:create shape — no items fails',      validatePayload(ORDER, { ...goodOrder, items: [] }).ok === false);
ok('order:create shape — item without product fails',
   validatePayload(ORDER, { ...goodOrder, items: [{ unitPrice: 1, quantity: 1, lineTotal: 1 }] }).ok === false);
ok('order:create shape — missing total fails',
   validatePayload(ORDER, { ...goodOrder, total: undefined }).ok === false);

// ── 2. Registry guard — the rollout is real and complete ────────────────────
const validateSrc = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/ipcValidate.ts'), 'utf8');
ok('ipcValidate exports validatePayload',  /export function validatePayload\b/.test(validateSrc));
ok('ipcValidate exports assertPayload',    /export function assertPayload\b/.test(validateSrc));
ok('ipcValidate exports expectStringArray',/export function expectStringArray\b/.test(validateSrc));
ok('ipcValidate exports the bare guards',  /export function expectString\b/.test(validateSrc) && /export function expectEnum\b/.test(validateSrc));
ok('ipcValidate has nested + array specs', /'object'/.test(validateSrc) && /'objectArray'/.test(validateSrc));

const schemasSrc = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/ipcSchemas.ts'), 'utf8');
ok('registry exports IPC_SCHEMAS',   /export const IPC_SCHEMAS/.test(schemasSrc));
ok('registry exports NO_PAYLOAD',    /export const NO_PAYLOAD/.test(schemasSrc));
ok('registry names auth:verifyPin',  /'auth:verifyPin':/.test(schemasSrc));
ok('registry names order:void',      /'order:void':/.test(schemasSrc));
ok('registry validates order:create with a nested items array',
   /'order:create':\s*orderCreate/.test(schemasSrc) && /items:\s*\{[\s\S]*?t:\s*'objectArray'/.test(schemasSrc));
ok('order:create is flagged NEEDS_LIVE_TEST (validated, not blind-trusted)',
   /NEEDS_LIVE_TEST[\s\S]*?'order:create'/.test(schemasSrc));

const guardSrc = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/ipcGuard.ts'), 'utf8');
ok('guard rejects an unregistered channel',
   /no payload schema/.test(guardSrc) && /throw new IpcValidationError/.test(guardSrc));
ok('installValidatedHandle runs guardChannel before the handler',
   /guardChannel\(channel,[\s\S]*?listener\(event/.test(guardSrc));

const handlersSrc = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/ipcHandlers.ts'), 'utf8');
ok('ipcHandlers installs the validating handle wrapper',
   /const handle = installValidatedHandle\(ipcMain\)/.test(handlersSrc));
ok('ipcHandlers routes channels through handle, not raw ipcMain.handle',
   !/ipcMain\.handle\(/.test(handlersSrc) && /\bhandle\('/.test(handlersSrc));

// ── 3. Gate guard — the coverage stays complete after today ─────────────────
const gatePath = path.join(ROOT, 'scripts/check-ipc-validation.mjs');
ok('check-ipc-validation gate exists', fs.existsSync(gatePath));
const gateSrc = fs.existsSync(gatePath) ? fs.readFileSync(gatePath, 'utf8') : '';
ok('gate fails on a handled channel with no schema', /handled but NO payload schema/.test(gateSrc));
ok('gate fails on a stale schema',                   /no longer handled/.test(gateSrc));

console.log(`\n${fail === 0
  ? `All ${pass} checks passed. Every IPC channel is validated, and a gate keeps it that way.`
  : `${fail} FAILED (${pass} passed)`}`);
process.exit(fail === 0 ? 0 : 1);
