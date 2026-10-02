#!/usr/bin/env node
/**
 * check-ipc-validation — every IPC channel handled in main has a payload schema
 * in ipcSchemas.ts, and every schema names a channel that still exists (register
 * D7).
 *
 * check-ipc-parity already proves a channel is bridged AND handled. It does NOT
 * prove the two sides agree on the PAYLOAD — 149 channels crossed the boundary
 * with nothing checking the shape, so a renderer sending the wrong thing became
 * an undefined-dereference deep in a handler, or a silent wrong write. D7 closed
 * that by routing every `handle(...)` through a validator fed from a central
 * registry (ipcSchemas.ts).
 *
 * This gate is what keeps it closed. Without it, "we validated the 149 today"
 * rots the moment someone adds channel 150 and forgets its schema — the new
 * channel would pass an unchecked payload and the fix would silently regress.
 * With it, a handled channel that is missing from the registry FAILS the build:
 *
 *   FAIL — handled but no schema:   a payload crosses the boundary unchecked.
 *   FAIL — schema but not handled:  a stale registry entry (the channel was
 *                                   removed or renamed); delete or fix it, so
 *                                   the registry can't drift into fiction.
 *
 * Channels registered with `ipcMain.on` (synchronous, e.g. app:version) are NOT
 * `handle` channels and are intentionally out of scope — they carry no invoke
 * payload the validator governs. They are listed in SYNC_EXEMPT so a reviewer
 * can see the exemption is deliberate, not an oversight.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Handlers live in more than one module (same set check-ipc-parity reads).
const HANDLER_FILES = [
  'apps/desktop/src/main/ipcHandlers.ts',
  'apps/desktop/src/main/print/printWorker.ts',
];
const REGISTRY_FILE = 'apps/desktop/src/main/ipcSchemas.ts';

// Sync channels registered with ipcMain.on — no invoke payload to validate.
const SYNC_EXEMPT = new Set(['app:version']);

const handlerSrc = HANDLER_FILES
  .map(f => fs.readFileSync(path.join(ROOT, f), 'utf8'))
  .join('\n');
const registrySrc = fs.readFileSync(path.join(ROOT, REGISTRY_FILE), 'utf8');

// Handled channels: the D7 wiring routes every handler through a local `handle(`
// wrapper (installValidatedHandle). Also accept a raw ipcMain.handle( in case a
// future handler is added without the wrapper — that is itself a finding, caught
// below because such a channel would still need a schema.
const handled = new Set(
  [...handlerSrc.matchAll(/(?:ipcMain\.)?\bhandle\(\s*'([^']+)'/g)].map(m => m[1]),
);

// Registered channels: top-level string keys of IPC_SCHEMAS. The registry is a
// flat object literal of 'chan:name': spec, so quoted keys at the start of a
// line are the channels. Reusable fragment consts (idPatch, rangeArg) are not
// quoted keys, so they are not matched.
const registered = new Set(
  [...registrySrc.matchAll(/^\s*'([a-zA-Z]+:[a-zA-Z]+)'\s*:/gm)].map(m => m[1]),
);

const missingSchema = [...handled]
  .filter(c => !SYNC_EXEMPT.has(c) && !registered.has(c))
  .sort();
const staleSchema = [...registered]
  .filter(c => !handled.has(c))
  .sort();

console.log(
  `check-ipc-validation: ${handled.size} handled channel(s), ` +
  `${registered.size} with a schema, ${SYNC_EXEMPT.size} sync-exempt.`,
);

if (missingSchema.length) {
  console.error('\nFAIL — handled but NO payload schema (unchecked at the boundary):');
  for (const c of missingSchema) console.error(`  ${c}`);
  console.error('  Add each to IPC_SCHEMAS in apps/desktop/src/main/ipcSchemas.ts');
  console.error('  (NO_PAYLOAD if the handler takes no second argument).');
}
if (staleSchema.length) {
  console.error('\nFAIL — schema for a channel that is no longer handled (stale entry):');
  for (const c of staleSchema) console.error(`  ${c}`);
  console.error('  Remove or rename it in ipcSchemas.ts so the registry matches reality.');
}

if (missingSchema.length || staleSchema.length) process.exit(1);
console.log('OK — every handled IPC channel has a payload schema, and none is stale.');
