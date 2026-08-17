/**
 * ipcValidate.ts — a small, dependency-free payload validator for IPC handlers.
 *
 * Register D7: `check-ipc-parity` proves a channel is bridged AND handled, but
 * NOT that the two sides agree on the payload shape. 136 channels crossed the
 * preload boundary with nothing checking what actually arrived, so a renderer
 * that sent the wrong shape surfaced as an undefined-dereference deep inside a
 * handler — or worse, a silent wrong write — instead of a clean rejection at the
 * boundary. The server validates with zod; the desktop has no such dependency,
 * and adding one is a build-footprint decision of its own, so this covers the
 * shapes IPC actually carries — scalars, string arrays, optional fields — with
 * no dependency.
 *
 * Two idioms, so a handler can adopt whichever matches its existing contract
 * without changing its return type:
 *
 *   validatePayload(schema, payload)  -> { ok, value } | { ok:false, error }
 *       for handlers that already return an { ok, ... } result. Return the error
 *       object straight to the renderer.
 *
 *   assertPayload(schema, payload)    -> value   (throws IpcValidationError)
 *       for handlers that return a bare value and rely on the renderer's .catch.
 *       A malformed payload throws a clear, uniform error at the top of the
 *       handler instead of a TypeError three calls deep.
 *
 * Deliberately small. It is not zod: no unions, no nesting beyond one level, no
 * transforms. IPC payloads in this app are flat bags of scalars and arrays; a
 * validator that matched that exactly is easier to trust than one that does
 * more than the boundary needs.
 */

export type FieldSpec =
  | { t: 'string';  optional?: boolean; min?: number }
  | { t: 'number';  optional?: boolean; int?: boolean }
  | { t: 'boolean'; optional?: boolean }
  | { t: 'stringArray'; optional?: boolean };

export type Schema = Record<string, FieldSpec>;

export type ValidationResult<T> =
  | { ok: true;  value: T }
  | { ok: false; error: string };

export class IpcValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IpcValidationError';
  }
}

function checkField(name: string, spec: FieldSpec, value: unknown): string | null {
  const absent = value === undefined || value === null;
  if (absent) return spec.optional ? null : `${name} is required`;

  switch (spec.t) {
    case 'string':
      if (typeof value !== 'string') return `${name} must be a string`;
      if (spec.min !== undefined && value.length < spec.min)
        return `${name} must be at least ${spec.min} character(s)`;
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

/**
 * Validate a payload against a schema. Extra fields are allowed — the schema
 * names what a handler DEPENDS on, not the whole payload, so adding a field to a
 * caller never trips a validated handler that ignores it. Returns the payload
 * typed as T on success (a shallow copy is not made; the same object flows on).
 */
export function validatePayload<T = Record<string, unknown>>(
  schema: Schema,
  payload: unknown,
): ValidationResult<T> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, error: 'payload must be an object' };
  }
  const bag = payload as Record<string, unknown>;
  for (const [name, spec] of Object.entries(schema)) {
    const err = checkField(name, spec, bag[name]);
    if (err) return { ok: false, error: err };
  }
  return { ok: true, value: payload as T };
}

/** Throwing variant, for handlers that return a bare value. */
export function assertPayload<T = Record<string, unknown>>(
  schema: Schema,
  payload: unknown,
): T {
  const r = validatePayload<T>(schema, payload);
  if (!r.ok) throw new IpcValidationError(r.error);
  return r.value;
}

/**
 * A handful of channels take a bare value rather than an { ... } bag — e.g.
 * setKitchenExclusions(terms: string[]). This validates that shape directly, so
 * a malformed payload is a clean rejection at the boundary instead of a silent
 * coerce-to-empty (which is the "silent wrong write" D7 exists to stop).
 */
export function expectStringArray(payload: unknown, name = 'value'): ValidationResult<string[]> {
  const err = checkField(name, { t: 'stringArray' }, payload);
  return err ? { ok: false, error: err } : { ok: true, value: payload as string[] };
}
