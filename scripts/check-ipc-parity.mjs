#!/usr/bin/env node
/**
 * check-ipc-parity — every preload channel has a handler, every handler is
 * reachable from preload. Both directions, because both failed silently:
 *
 *   - The stations feature shipped with UI, types, SIX handlers, local
 *     mirrors, pull sync, server routes, and a Postgres migration — and no
 *     preload bridge. The screen crashed on first use with
 *     "$.manage.createStation is not a function", and the kitchen could not
 *     be routed. tsc cannot see this: the renderer types promise methods the
 *     bridge never exposes.
 *   - Four variant-option handlers sat unreachable the same way, a crash
 *     waiting in the variants editor.
 *
 * A handler nobody can invoke is dead weight or a missing bridge; an invoke
 * nobody handles is a runtime crash. Either way, FAIL.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pre = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/preload.ts'), 'utf8');
const ih  = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/ipcHandlers.ts'), 'utf8');

const invoked = new Set([...pre.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(m => m[1]));
const handled = new Set([...ih.matchAll(/ipcMain\.handle\('([^']+)'/g)].map(m => m[1]));

const noHandler = [...invoked].filter(c => !handled.has(c)).sort();
const noBridge  = [...handled].filter(c => !invoked.has(c)).sort();

console.log(`check-ipc-parity: ${invoked.size} channels bridged, ${handled.size} handled.`);
if (noHandler.length) {
  console.error('\nFAIL — invoked in preload but NO handler (runtime crash):');
  for (const c of noHandler) console.error(`  ${c}`);
}
if (noBridge.length) {
  console.error('\nFAIL — handled in main but UNREACHABLE from preload (dead feature):');
  for (const c of noBridge) console.error(`  ${c}`);
}
if (noHandler.length || noBridge.length) process.exit(1);
console.log('OK — every channel is bridged and handled.');
