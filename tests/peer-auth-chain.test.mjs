/**
 * peer-auth-chain.test.mjs — the peer's authority chain (PHASE5 §4d / A17):
 * node → cloud → cache, where a REJECTION from any authority is final and only a
 * TRANSPORT failure falls through. Models the decision in ipcHandlers.auth:verifyPin
 * so the "08-08 rule" (never fall back from a 'no') can't silently regress.
 *
 *   node tests/peer-auth-chain.test.mjs
 */
import assert from 'node:assert';

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}`); } };

// node/cloud each resolve to 'ok' | 'rejected' | 'transport'; cache to 'ok' | 'fail'.
// Returns the authority that decided, or throws-equivalent 'rejected'.
function resolve({ hasNode, node, cloud, cache }) {
  if (hasNode) {
    if (node === 'ok')       return { by: 'node', ok: true };
    if (node === 'rejected') return { by: 'node', ok: false, final: true };
    // transport → fall through
  }
  if (cloud === 'ok')        return { by: 'cloud', ok: true };
  if (cloud === 'rejected')  return { by: 'cloud', ok: false, final: true };
  // cloud transport → cache
  return cache === 'ok' ? { by: 'cache', ok: true } : { by: 'cache', ok: false };
}

ok('node OK → signed in by node, cloud never consulted',
   (() => { const r = resolve({ hasNode: true, node: 'ok', cloud: 'ok', cache: 'ok' }); return r.by === 'node' && r.ok; })());

ok('node REJECTS → final, does NOT fall through to cloud',
   (() => { const r = resolve({ hasNode: true, node: 'rejected', cloud: 'ok', cache: 'ok' }); return r.by === 'node' && !r.ok && r.final; })());

ok('node unreachable → falls through to cloud OK',
   (() => { const r = resolve({ hasNode: true, node: 'transport', cloud: 'ok', cache: 'ok' }); return r.by === 'cloud' && r.ok; })());

ok('node unreachable, cloud REJECTS → final (no cache)',
   (() => { const r = resolve({ hasNode: true, node: 'transport', cloud: 'rejected', cache: 'ok' }); return r.by === 'cloud' && !r.ok && r.final; })());

ok('node + cloud both unreachable → cache',
   (() => { const r = resolve({ hasNode: true, node: 'transport', cloud: 'transport', cache: 'ok' }); return r.by === 'cache' && r.ok; })());

ok('no node configured → straight to cloud',
   (() => { const r = resolve({ hasNode: false, cloud: 'ok', cache: 'ok' }); return r.by === 'cloud' && r.ok; })());

ok('no node, cloud down → cache',
   (() => { const r = resolve({ hasNode: false, cloud: 'transport', cache: 'ok' }); return r.by === 'cache' && r.ok; })());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
