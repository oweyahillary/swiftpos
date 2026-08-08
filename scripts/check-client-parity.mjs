#!/usr/bin/env node
/**
 * check-client-parity.mjs — the gate that would have caught the pump_id bug.
 *
 * WHAT WENT WRONG THAT THIS EXISTS FOR
 * SwiftPOS has TWO clients posting to the same server routes: the Electron till
 * (apps/desktop) and the web POS (apps/dashboard). They are separate codebases
 * with separate payload builders and nothing compares them.
 *
 * So a fix lands on one and not the other, silently:
 *   - pump_id: wired end-to-end on desktop (POSPage -> syncEngine -> orders.ts).
 *     Never added to the web payload. Every web fuel sale writes pump_id=null,
 *     the exact-tank deduction never fires, and fuel reports read zero — the
 *     symptom the desktop fix was written to close.
 *   - table_id: sent by the web POS. The server destructures table_NUMBER.
 *     The field is accepted, ignored, and dropped on the floor.
 *
 * Neither is a type error (bodies are `any`), a schema error (the columns
 * exist), or a test failure (no test posts both payloads). It is a gap BETWEEN
 * two things that must agree, which is where every serious bug in this
 * codebase has lived.
 *
 * WHAT IT COMPARES
 *   For each API route both clients call:
 *     SERVER-READ    field names the handler destructures from req.body or
 *                    reaches via req.body?.x
 *     DESKTOP-SENT   keys in the object literal passed to that route
 *     WEB-SENT       same, from apps/dashboard
 *
 *   ASYMMETRY  a field the server reads that exactly one client sends.
 *   IGNORED    a field a client sends that the server never reads.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * It does not require the two clients to be identical — they legitimately
 * differ (the till sends device_id and an idempotency key; the web POS sends
 * neither). It fails only on ASYMMETRY, because that is the shape where the
 * server WANTS a field and one client silently omits it. IGNORED is printed as
 * information: a field nobody reads is usually dead weight, occasionally the
 * first half of a feature.
 *
 * Exceptions live in client-parity-exceptions.json, and each needs a reason.
 *
 * KNOWN LIMITATION
 * This is a static scan of object literals, not a type check. A payload built
 * by spreading a variable (`...payload`) is invisible to it. Where that
 * happens the route should be listed as an exception rather than trusted.
 *
 * Usage:  node scripts/check-client-parity.mjs [--verbose]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE    = path.dirname(fileURLToPath(import.meta.url));
const ROOT    = path.resolve(HERE, '..');
const VERBOSE = process.argv.includes('--verbose');

const EXC_PATH = path.join(HERE, 'client-parity-exceptions.json');
const exceptions = fs.existsSync(EXC_PATH)
  ? JSON.parse(fs.readFileSync(EXC_PATH, 'utf8'))
  : { routes: [], fields: [] };

// ── source collection ────────────────────────────────────────────────────────
function collect(dir) {
  const out = [];
  const base = path.join(ROOT, dir);
  if (!fs.existsSync(base)) return out;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name)) out.push(p);
    }
  };
  walk(base);
  return out;
}

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

/**
 * Extract the TOP-LEVEL keys of an object literal starting at `start`
 * (the index of its `{`). Brace-depth aware, so nested objects and arrays
 * contribute nothing, which is what we want: `items: [...]` is one key.
 */
function topLevelKeys(text, start) {
  const keys = [];
  let depth = 0, i = start, inStr = null;
  for (; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    // Comments FIRST. A `'` inside a line comment ("the fuel line's pump")
    // otherwise opens a string that swallows the rest of the object — which is
    // exactly what it did on the first run of this script, reporting `items`
    // and `payments` as missing from a payload that plainly sends both.
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      if (nl === -1) break;
      i = nl;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      if (close === -1) break;
      i = close + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{' || c === '[' || c === '(') { depth++; continue; }
    if (c === '}' || c === ']' || c === ')') { depth--; if (depth === 0) break; continue; }
    if (depth === 1 && /[A-Za-z_$]/.test(c)) {
      const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(text.slice(i));
      if (m) { keys.push(m[1]); i += m[0].length - 1; }
    }
    if (depth === 1 && c === '.' && text.slice(i, i + 3) === '...') {
      keys.push('…SPREAD');
    }
  }
  return { keys, end: i };
}

// ── 1. what the SERVER reads, per route ──────────────────────────────────────
const serverReads = new Map();   // "METHOD /path" -> Set(field)
const routeFiles  = collect('apps/server/src/routes');

for (const p of routeFiles) {
  const text   = fs.readFileSync(p, 'utf8');
  const mount  = '/api/' + path.basename(p, path.extname(p));
  const routeRe = /router\.(post|patch|put)\(\s*['"`]([^'"`]+)['"`]/g;
  const hits = [...text.matchAll(routeRe)]
    .map(m => ({ method: m[1].toUpperCase(), sub: m[2], idx: m.index }));

  for (let h = 0; h < hits.length; h++) {
    const { method, sub, idx } = hits[h];
    const end  = h + 1 < hits.length ? hits[h + 1].idx : text.length;
    const body = text.slice(idx, end);
    const key  = `${method} ${mount}${sub === '/' ? '' : sub}`;
    const set  = serverReads.get(key) ?? new Set();

    // const { a, b = 1, c } = req.body;
    for (const m of body.matchAll(/const\s*\{([\s\S]{0,900}?)\}\s*=\s*req\.body/g)) {
      for (const f of m[1].matchAll(/(?:^|,)\s*(?:\/\/[^\n]*\n\s*)*([A-Za-z_$][\w$]*)/g)) {
        set.add(f[1]);
      }
    }
    // req.body?.x  /  req.body.x
    for (const m of body.matchAll(/req\.body\??\.([A-Za-z_$][\w$]*)/g)) set.add(m[1]);

    serverReads.set(key, set);
  }
}

// ── 2. what each CLIENT sends, per route ─────────────────────────────────────
const CLIENTS = {
  desktop: collect('apps/desktop/src/renderer'),
  web:     collect('apps/dashboard/src'),
};

const clientSends = { desktop: new Map(), web: new Map() };   // route -> Set(field)
const clientSites = { desktop: new Map(), web: new Map() };
/** route -> where the payload is built indirectly. Skipped, and said out loud. */
const opaque = new Map();

// posApi.post('/api/orders', { ... })  |  posApi.patch(`/api/orders/${id}/pay`, { ... })
const CALL_RE =
  /\.(post|patch|put)\s*(?:<[^>]*>)?\s*\(\s*[`'"]([^`'"]+)[`'"]\s*,\s*\{/g;

/**
 * The same call where the body is NOT a literal — `posApi.post(url, buildPayload(x))`.
 *
 * This matters more than it looks. PaymentModal.tsx builds the web POS's real
 * order payload in a function and passes the result, so the literal scan above
 * never saw it — it found a DIFFERENT, smaller literal elsewhere in the app and
 * compared against that. The gate then reported discount_amount as missing from
 * the web client when PaymentModal sends it on the line above pump_id.
 *
 * A gate that points at the wrong file is worse than one that admits it cannot
 * see: the first costs a round of chasing a bug that is not there. So an
 * indirect body marks the route OPAQUE and the comparison is skipped with a
 * loud note, exactly like a spread.
 */
const INDIRECT_RE =
  /\.(post|patch|put)\s*(?:<[^>]*>)?\s*\(\s*[`'"]([^`'"]+)[`'"]\s*,\s*(?!\{)([A-Za-z_$][\w$]*\s*\()/g;

/**
 * Payload builders the scanner cannot reach by following a call.
 *
 * TWO CASES, ONE MAP.
 *
 * The till does not call the API from the renderer at all: it writes the
 * payload to the local queue and syncEngine POSTs the stored blob later, so
 * following the HTTP call lands on `body: row.payload` — opaque. The renderer's
 * posApi call IS the payload builder.
 *
 * The web POS builds its order body in a function and passes the result, so the
 * literal scan sees `posApi.post(url, buildOrderPayload(payments))` and nothing
 * useful. Without this entry the gate skips POST /api/orders entirely — the one
 * route it was written for.
 *
 * DECLARED, not inferred. If a new builder appears and is not listed here, the
 * route falls into the NOT COMPARED list rather than being silently half-
 * checked. That is the trade: a maintained map, in exchange for the gate never
 * being confidently wrong.
 */
const DECLARED_PAYLOAD_BUILDERS = {
  desktop: { 'posApi.order.create': 'POST /api/orders' },
  web:     { 'function buildOrderPayload': 'POST /api/orders' },
};

/**
 * Fields added to a payload AFTER the builder above has run.
 *
 * syncEngine.ts spreads the renderer's object and adds three of its own on the
 * way into the queue:
 *
 *     JSON.stringify({ ...orderPayload, payments, shift_id, device_id,
 *                      _localOrderId, idempotency_key, created_at })
 *
 * The renderer genuinely does not send shift_id or idempotency_key — main does,
 * because only main knows the open shift and the local order id. Without this
 * the gate reports both as missing from the till and sends someone looking for
 * a bug that was never there.
 *
 * Keep the source line in the comment so the next person can check it in one
 * grep rather than trusting this list.
 */
const POST_BUILDER_FIELDS = {
  desktop: {
    'POST /api/orders': ['shift_id', 'device_id', 'idempotency_key', 'created_at', 'payments'],
  },
  web: {},
};

const normalise = (raw) => {
  // `/api/orders/${id}/pay` -> POST /api/orders/:id/pay
  let s = raw.replace(/\$\{[^}]*\}/g, ':id').replace(/\/+$/, '');
  return s || '/';
};

for (const [client, fileList] of Object.entries(CLIENTS)) {
  for (const p of fileList) {
    const text = fs.readFileSync(p, 'utf8');
    const rel  = path.relative(ROOT, p);
    for (const m of text.matchAll(CALL_RE)) {
      const method = m[1].toUpperCase();
      const route  = `${method} ${normalise(m[2])}`;
      const braceAt = m.index + m[0].length - 1;
      const { keys } = topLevelKeys(text, braceAt);
      const set = clientSends[client].get(route) ?? new Set();
      keys.forEach(k => set.add(k));
      clientSends[client].set(route, set);
      const sites = clientSites[client].get(route) ?? [];
      sites.push(`${rel}:${lineOf(text, m.index)}`);
      clientSites[client].set(route, sites);
    }

    // Payload built by a function rather than written inline. Recorded, not
    // guessed at — see INDIRECT_RE.
    for (const m of text.matchAll(INDIRECT_RE)) {
      const route = `${m[1].toUpperCase()} ${normalise(m[2])}`;
      const at    = opaque.get(route) ?? [];
      at.push(`${client} ${rel}:${lineOf(text, m.index)}`);
      opaque.set(route, at);
    }

    // Declared payload builders — see DECLARED_PAYLOAD_BUILDERS.
    for (const [call, route] of Object.entries(DECLARED_PAYLOAD_BUILDERS[client] ?? {})) {
      // `function buildOrderPayload(args) { return { ... } }` — step past the
      // parameter list and the function's own brace to the returned literal.
      const isFn = call.startsWith('function ');
      const re = isFn
        ? new RegExp(call.replace(/\s+/g, '\\s+') + '\\s*\\([^)]*\\)\\s*\\{\\s*return\\s*\\{', 'g')
        : new RegExp(call.replace(/\./g, '\\.') + '\\s*\\(\\s*\\{', 'g');

      for (const m of text.matchAll(re)) {
        const braceAt = m.index + m[0].length - 1;
        const { keys } = topLevelKeys(text, braceAt);
        const set = clientSends[client].get(route) ?? new Set();
        keys.forEach(k => set.add(k));
        clientSends[client].set(route, set);
        const sites = clientSites[client].get(route) ?? [];
        sites.push(`${rel}:${lineOf(text, m.index)}`);
        clientSites[client].set(route, sites);
        // Covered by a declared builder, so no longer a blind spot.
        opaque.delete(route);
      }
    }
  }
}

// ── 3. compare ───────────────────────────────────────────────────────────────
const routeExcepted = (r) => (exceptions.routes ?? []).some(e => (e.route ?? e) === r);
const fieldExcepted = (r, f) => (exceptions.fields ?? []).some(
  e => (e.route === r || e.route === '*') && e.field === f);

const shared = [...clientSends.desktop.keys()]
  .filter(r => clientSends.web.has(r))
  .filter(r => !routeExcepted(r))
  .sort();

// Fold in what each client's transport layer adds after the builder runs.
for (const [client, byRoute] of Object.entries(POST_BUILDER_FIELDS)) {
  for (const [route, fields] of Object.entries(byRoute)) {
    const set = clientSends[client].get(route);
    if (set) fields.forEach(f => set.add(f));
  }
}

const asymmetries = [];
const ignored     = [];

for (const route of shared) {
  const d = clientSends.desktop.get(route);
  const w = clientSends.web.get(route);
  if (d.has('…SPREAD') || w.has('…SPREAD')) continue;   // invisible payload
  if (opaque.has(route)) continue;                      // built by a function — see below

  // Match the route against what the server declared. Server keys carry the
  // real path (":id"); client keys were normalised the same way.
  const srv = serverReads.get(route)
           ?? serverReads.get(route.replace(/:id/g, ':id'))
           ?? new Set();

  for (const f of srv) {
    if (fieldExcepted(route, f)) continue;
    const inD = d.has(f), inW = w.has(f);
    if (inD !== inW) {
      asymmetries.push({ route, field: f, sentBy: inD ? 'desktop' : 'web',
                         missing: inD ? 'web' : 'desktop' });
    }
  }
  for (const [client, set] of [['desktop', d], ['web', w]]) {
    for (const f of set) {
      if (f === '…SPREAD' || fieldExcepted(route, f)) continue;
      if (srv.size && !srv.has(f)) ignored.push({ route, field: f, client });
    }
  }
}

// ── report ───────────────────────────────────────────────────────────────────
console.log(`check-client-parity: ${serverReads.size} write routes on the server, ` +
            `${shared.length} called by BOTH clients.`);

if (VERBOSE) {
  console.log(`\nRoutes compared:`);
  for (const r of shared) console.log(`  ${r}`);
}

if (opaque.size) {
  console.log(`\nNOT COMPARED — payload is built by a function, not written inline.`);
  console.log(`This gate reads object literals only. These routes are its blind spot,`);
  console.log(`and it says so rather than comparing a partial picture and being wrong:`);
  for (const [route, sites] of opaque) {
    console.log(`  ${route}`);
    for (const s of sites) console.log(`     ${s}`);
  }
}

if (ignored.length) {
  console.log(`\nIGNORED — sent by a client, never read by the handler (informational):`);
  for (const i of ignored) {
    console.log(`  ${i.route}`);
    console.log(`     ${i.client} sends '${i.field}' — the handler does not destructure it.`);
  }
}

if (asymmetries.length) {
  console.error(`\nASYMMETRY — the server reads a field only ONE client sends:\n`);
  for (const a of asymmetries) {
    console.error(`  ${a.route}   field: ${a.field}`);
    console.error(`     sent by:  ${a.sentBy}  ${(clientSites[a.sentBy].get(a.route) ?? []).slice(0, 2).join(', ')}`);
    console.error(`     MISSING:  ${a.missing}  ${(clientSites[a.missing].get(a.route) ?? []).slice(0, 2).join(', ')}`);
    console.error(`     → every ${a.missing} request writes the default for '${a.field}'.\n`);
  }
  console.error(`If a client legitimately never has this field, add it to`);
  console.error(`scripts/client-parity-exceptions.json with a reason. Do not add it without one.`);
  process.exit(1);
}

console.log(`\nOK — both clients send every field the shared handlers read.`);
if (!VERBOSE) console.log(`   (--verbose lists the routes compared.)`);
