// The till's IPC handlers as one text, for the checks and tests that read them as source.
//
// D10 (2026-10-21): apps/desktop/src/main/ipcHandlers.ts was one 4,500-line file. It is now the entry point, and the
// handlers live in apps/desktop/src/main/ipc/*.ts. A check that read ipcHandlers.ts alone would now see none of them —
// and pass for the wrong reason — so every reader goes through here: the entry point, then each module in the order
// the entry point imports it (the order its channels register in), then ipc/shared.ts, then any other ipc/*.ts (so a
// new module is never left out). Handlers before the shared helpers: a test that finds the FIRST match of a call made
// both by a handler and by a helper (the sign-in's verify-pin and the offline upgrade's) finds the handler's, as it did
// in the one file.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAIN = 'apps/desktop/src/main';
export const IPC_ENTRY = `${MAIN}/ipcHandlers.ts`;

/** The handler files, relative to the repo root, in reading order. */
export function ipcHandlerFiles() {
  const entry = fs.readFileSync(path.join(ROOT, IPC_ENTRY), 'utf8');
  const imported = [...entry.matchAll(/from '\.\/ipc\/([\w-]+)'/g)].map((m) => `${MAIN}/ipc/${m[1]}.ts`);
  const all = fs.readdirSync(path.join(ROOT, MAIN, 'ipc')).filter((f) => f.endsWith('.ts')).sort().map((f) => `${MAIN}/ipc/${f}`);
  const shared = `${MAIN}/ipc/shared.ts`;
  const order = [IPC_ENTRY, ...imported.filter((f) => f !== shared), shared];
  return [...order, ...all.filter((f) => !order.includes(f))];
}

/** Every handler file's text, joined in reading order. */
export function ipcHandlersSource() {
  return ipcHandlerFiles().map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
}
