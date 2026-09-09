/**
 * ipcGuard.ts — the one place a channel's payload meets its schema (register D7).
 *
 * `guardChannel(channel, payload)` looks the channel up in IPC_SCHEMAS and:
 *   - NO_PAYLOAD        → returns undefined (nothing to check).
 *   - a Bare descriptor → validates the single value; throws on mismatch.
 *   - a Schema          → validates the object bag; throws on mismatch.
 *   - not in registry   → THROWS. A handled channel with no registry entry is a
 *                         D7 regression, and `check-ipc-validation.mjs` fails the
 *                         build before it can ship — this runtime throw is the
 *                         backstop if one ever slips the gate.
 *
 * installValidatedHandle(ipcMain) returns a `handle(channel, fn)` that runs
 * guardChannel first, then the original handler with the (now-checked) payload.
 * ipcHandlers/printWorker call this `handle` instead of ipcMain.handle, so every
 * channel is validated with no per-handler boilerplate — and a new channel that
 * forgets its registry entry throws loudly instead of passing an unchecked
 * payload through.
 */
import {
  assertPayload, expectString, expectNumber, expectBoolean, expectEnum,
  expectStringArray, IpcValidationError, type Schema,
} from './ipcValidate';
import { IPC_SCHEMAS, NO_PAYLOAD, type Bare, type ChannelSpec } from './ipcSchemas';

function guardBare(b: Bare, payload: unknown): void {
  switch (b.kind) {
    case 'string':      expectString(payload, 'payload', b.min); return;
    case 'number':      expectNumber(payload, 'payload', b.int); return;
    case 'boolean':     expectBoolean(payload, 'payload'); return;
    case 'stringArray': {
      const r = expectStringArray(payload, 'payload');
      if (!r.ok) throw new IpcValidationError(r.error);
      return;
    }
    case 'enum':        expectEnum(payload, b.values, 'payload'); return;
    case 'nullableEnum':
      if (payload === null || payload === undefined) return;
      expectEnum(payload, b.values, 'payload'); return;
    case 'object':
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload))
        throw new IpcValidationError('payload must be an object');
      return;
    case 'objectArray':
      if (!Array.isArray(payload))
        throw new IpcValidationError('payload must be an array');
      if (b.minLen !== undefined && payload.length < b.minLen)
        throw new IpcValidationError(`payload must have at least ${b.minLen} item(s)`);
      for (let i = 0; i < payload.length; i++) {
        const el = payload[i];
        if (typeof el !== 'object' || el === null || Array.isArray(el))
          throw new IpcValidationError(`payload[${i}] must be an object`);
      }
      return;
  }
}

function isBare(spec: ChannelSpec): spec is Bare {
  return typeof spec === 'object' && spec !== null && 'kind' in spec;
}

/**
 * Validate a payload for one channel. Throws IpcValidationError on a bad shape
 * or an unregistered channel. Returns the payload (typed loosely) on success.
 */
export function guardChannel(channel: string, payload: unknown): unknown {
  const spec = IPC_SCHEMAS[channel];
  if (spec === undefined) {
    throw new IpcValidationError(
      `IPC channel '${channel}' has no payload schema (register D7). ` +
      `Add an entry to ipcSchemas.ts.`,
    );
  }
  if (spec === NO_PAYLOAD) return undefined;
  if (isBare(spec)) { guardBare(spec, payload); return payload; }
  // Schema (object bag). assertPayload throws IpcValidationError on mismatch.
  return assertPayload(spec as Schema, payload);
}

interface HandleHost {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

/**
 * Returns a drop-in replacement for ipcMain.handle that validates the payload
 * against the registry before the handler runs. The wrapper is generic over the
 * handler's own argument and return types, so each call site keeps its exact
 * signature (e.g. `(_e, { id }: { id: string })`) with no cast — it is a true
 * rename of ipcMain.handle. A rejected payload becomes a clean IpcValidationError
 * the renderer sees via its .catch, instead of an undefined-dereference deep in
 * the handler.
 */
export function installValidatedHandle(ipcMain: HandleHost) {
  return function handle<A extends unknown[], R>(
    channel: string,
    listener: (event: unknown, ...args: A) => R,
  ): void {
    ipcMain.handle(channel, (event: unknown, ...args: unknown[]) => {
      guardChannel(channel, args[0]);
      return listener(event, ...(args as A));
    });
  };
}
