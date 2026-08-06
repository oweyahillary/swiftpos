#!/usr/bin/env node
/**
 * refresh-schema-index.mjs — pull both drift snapshots straight from the
 * database. No SQL editor, no copy-paste, no result.json.
 *
 *     node scripts/refresh-schema-index.mjs
 *
 * Writes:
 *     scripts/schema-index.json      tables and column types
 *     scripts/functions-index.json   function signatures
 *
 * WHY THIS EXISTS
 * The old workflow was: open build-schema-index.sql, paste it into the Supabase
 * dashboard, run it, copy a JSON blob out of a result cell, save it to a file,
 * then run a second script. Twice — once for tables, once for functions.
 *
 * That is why schema-index.json went stale. A gate that depends on somebody
 * remembering a six-step chore starts passing against an old picture the moment
 * they forget, and a stale snapshot does not fail loudly — it agrees with
 * whatever it was last told. check-schema-drift.mjs exists to catch what people
 * miss; making it depend on a manual chore put the same failure back underneath
 * it one layer down.
 *
 * REQUIRES migration 70 (schema_snapshot / functions_snapshot) and the same
 * SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY the server already uses. Nothing new
 * to configure.
 *
 * Reads apps/server/.env by default; override with SUPABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY in the environment, which is how CI should do it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── credentials ─────────────────────────────────────────────────────────────
function loadEnv() {
  let url = process.env.SUPABASE_URL;
  let key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) return { url, key, from: 'environment' };

  const envFile = path.join(ROOT, 'apps/server/.env');
  if (!fs.existsSync(envFile)) return { url, key, from: 'environment (apps/server/.env not found)' };

  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const v = m[2].replace(/^["']|["']$/g, '').trim();
    if (m[1] === 'SUPABASE_URL' && !url) url = v;
    if (m[1] === 'SUPABASE_SERVICE_ROLE_KEY' && !key) key = v;
  }
  return { url, key, from: 'apps/server/.env' };
}

const { url, key, from } = loadEnv();
if (!url || !key) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  console.error(`Looked in: ${from}`);
  console.error('Set them in the environment, or make sure apps/server/.env has both.');
  process.exit(1);
}

// ── fetch one snapshot ──────────────────────────────────────────────────────
async function snapshot(fn) {
  const res = await fetch(`${url.replace(/\/$/, '')}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  const body = await res.text();
  if (!res.ok) {
    // PGRST202 here almost always means migration 70 has not been applied.
    if (body.includes('PGRST202') || /Could not find the function/i.test(body)) {
      throw new Error(
        `${fn}() is not in the database.\n` +
        `  Run migrations/70_schema_snapshot_rpcs.sql in the Supabase SQL editor first.\n` +
        `  (That is the ONE manual step, and only once.)`,
      );
    }
    throw new Error(`${fn}() failed — HTTP ${res.status}\n  ${body.slice(0, 300)}`);
  }
  // The RPC returns text; PostgREST hands it back as a JSON string.
  let payload = body.trim();
  if (payload.startsWith('"')) payload = JSON.parse(payload);
  const parsed = JSON.parse(payload);
  if (!parsed || typeof parsed !== 'object') throw new Error(`${fn}() returned something that is not an object`);
  return parsed;
}

// ── write, reporting what actually changed ──────────────────────────────────
function write(relPath, next, label) {
  const abs = path.join(ROOT, relPath);
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { /* first run */ }

  fs.writeFileSync(abs, JSON.stringify(next, null, 1) + '\n');

  const before = new Set(Object.keys(prev ?? {}));
  const after  = new Set(Object.keys(next));
  const added   = [...after].filter(k => !before.has(k)).sort();
  const removed = [...before].filter(k => !after.has(k)).sort();
  const changed = [...after].filter(k => before.has(k) &&
    JSON.stringify(prev[k]) !== JSON.stringify(next[k])).sort();

  console.log(`  ${relPath}  —  ${after.size} ${label}`);
  if (!prev)          console.log(`      created`);
  if (added.length)   console.log(`      + ${added.length} new: ${added.slice(0, 8).join(', ')}${added.length > 8 ? ' …' : ''}`);
  if (removed.length) console.log(`      - ${removed.length} gone: ${removed.slice(0, 8).join(', ')}${removed.length > 8 ? ' …' : ''}`);
  if (changed.length) console.log(`      ~ ${changed.length} changed: ${changed.slice(0, 8).join(', ')}${changed.length > 8 ? ' …' : ''}`);
  if (prev && !added.length && !removed.length && !changed.length) console.log(`      unchanged`);
  return added.length + removed.length + changed.length;
}

// ── main ────────────────────────────────────────────────────────────────────
console.log(`refresh-schema-index: reading ${url.replace(/^https?:\/\//, '').split('.')[0]}… (credentials from ${from})\n`);
try {
  const [tables, functions] = await Promise.all([
    snapshot('schema_snapshot'),
    snapshot('functions_snapshot'),
  ]);
  const n = write('scripts/schema-index.json',    tables,    'tables')
          + write('scripts/functions-index.json', functions, 'functions');
  console.log(n
    ? `\nSnapshots refreshed. Now run:  node scripts/check-schema-drift.mjs`
    : `\nSnapshots already current. Now run:  node scripts/check-schema-drift.mjs`);
} catch (e) {
  console.error(`\nFAILED — ${e.message}`);
  process.exit(1);
}
