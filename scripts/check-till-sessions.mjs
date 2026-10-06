#!/usr/bin/env node
/**
 * check-till-sessions.mjs — A407: nothing may sign a till out by accident.
 *
 * Owner, 2026-10-05 (a till on the PIN screen with "Please sign in again."): "how do we prevent this from ever
 * happening". A till used to sign in AS the owner, so a revoke written as "this user's sessions" signed out the business's
 * tills too — it happened twice (verify-pin on the owner's own PIN; A402's password reset). A415: a till's own session
 * names no person now; this check stays so a broad revoke is never written again without saying why it is safe.
 *
 * Every place in apps/server/src that revokes refresh tokens (`.from('refresh_tokens')` … `revoked_at`) must either
 *   - name ONE token or ONE session (.eq('id' / .in('id' / .eq('jti' / .eq('session_id'), or
 *   - go through lib/tillSessions.ts (revokeBrowserSessions — never a till), or
 *   - carry a `// till-safe: <why>` comment in the 6 lines above.
 * Anything else fails CI.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'apps/server/src');
const files = [];
const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) {
  const p = path.join(d, f.name);
  if (f.isDirectory()) walk(p); else if (/\.ts$/.test(f.name)) files.push(p);
} };
walk(SRC);

const bad = [];
let checked = 0;
for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes("from('refresh_tokens')")) continue;
    // the statement: from here to the line ending it (a ';'), at most 10 lines
    let j = i, stmt = '';
    for (; j < Math.min(lines.length, i + 10); j++) { stmt += lines[j] + '\n'; if (/;\s*(\/\/.*)?$/.test(lines[j])) break; }
    if (!/\.update\(\s*\{[^}]*revoked_at/.test(stmt)) continue;
    checked++;
    const narrow = /\.(eq|in)\('id'|\.eq\('jti'|\.eq\('session_id'/.test(stmt);
    const above = lines.slice(Math.max(0, i - 6), i + 1).join('\n');
    const safe = /\/\/ till-safe:/.test(above);
    if (!narrow && !safe) bad.push(`${path.relative(ROOT, f)}:${i + 1}\n      ${stmt.trim().split('\n').slice(0, 4).join('\n      ')}`);
  }
}

console.log(`check-till-sessions: ${checked} session revokes in apps/server/src.`);
if (bad.length) {
  console.log(`\nFAIL — ${bad.length} revoke(s) could sign out a till:\n`);
  for (const b of bad) console.log(`  ${b}\n`);
  console.log('Revoke one token or session by id, use revokeBrowserSessions (lib/tillSessions.ts), or say why it is safe');
  console.log('with a `// till-safe: <why>` comment just above.');
  process.exit(1);
}
console.log('OK — no revoke can sign out a till by accident.');
