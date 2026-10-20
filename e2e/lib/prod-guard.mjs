// A536 — the end-to-end suites never touch PRODUCTION.
//
// The API suites (tests/runner.mjs) create products, staff, orders and shifts and hammer endpoints; the Playwright
// specs make real paid sales. Pointed at production they would write into live businesses. Every entry point (the
// runner, both Playwright configs, the API staff seed, the nightly workflow) calls this guard BEFORE its first request,
// and it fails loudly: a thrown Error in code, exit code 3 from the command line.
//
// Two layers:
//   1. The address. Refused: zaptill.co.ke and every host under it (production and every client's own address), unless
//      it is a dev/staging host (dev.zaptill.co.ke, dev-x.zaptill.co.ke, staging.zaptill.co.ke, anything.dev.zaptill.co.ke);
//      the known production Render/Vercel hosts; anything listed in E2E_EXTRA_PROD_HOSTS (comma-separated).
//   2. The API's own answer. Production's /health leaves out `env` (no fingerprinting); a dev server says
//      "development". assertHealthNotProduction refuses when env is missing or "production".
//
// Command line (the workflow's first step):
//   node e2e/lib/prod-guard.mjs            checks E2E_API_URL, E2E_WEB_URL, E2E_ADMIN_URL, PLAYWRIGHT_BASE_URL, API_BASE_URL
//   node e2e/lib/prod-guard.mjs --health   also asks E2E_API_URL (or API_BASE_URL) /health, waiting up to E2E_HEALTH_WAIT_S
//                                          seconds (default 180 — a sleeping Render service takes about a minute to wake)
//   node e2e/lib/prod-guard.mjs --check <url> [<url> …]   just those addresses

import { fileURLToPath } from 'node:url';

/** The production hosts by name. Lower case, exact match. */
export const PROD_HOSTS = Object.freeze([
  'zaptill.co.ke',
  'api.zaptill.co.ke',
  'app.zaptill.co.ke',
  'admin.zaptill.co.ke',
  'www.zaptill.co.ke',
  'swiftpos-server.onrender.com',     // production API (Render, older name)
  'swiftpos-prod-mype.onrender.com',  // production API (Render, from main)
  'swiftpos-dashboard.vercel.app',    // production dashboard (Vercel)
  'swiftpos-admin.vercel.app',        // production admin portal (Vercel)
  'swiftpos-admin-eta.vercel.app',    // production admin portal (Vercel)
]);

const PROD_DOMAIN = 'zaptill.co.ke';
// Under zaptill.co.ke only these count as non-production: the label right before the domain is dev/staging (optionally
// dev-something), e.g. dev.zaptill.co.ke, dev-api.zaptill.co.ke, app.dev.zaptill.co.ke. Every other label is a client.
const DEV_LABEL = /^(dev|staging)(-[a-z0-9-]+)?$/;

function extraProdHosts(env) {
  return String(env.E2E_EXTRA_PROD_HOSTS || '')
    .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
}

/**
 * Why `url` is a production address, or null when it is not. An address that does not parse is refused too —
 * a typo must not slip through as "not production".
 */
export function prodReason(url, env = process.env) {
  let host;
  try { host = new URL(String(url)).hostname.toLowerCase().replace(/\.$/, ''); }
  catch { return `"${url}" is not a valid address`; }
  if (!host) return `"${url}" has no host`;
  if (PROD_HOSTS.includes(host)) return `${host} is a production host`;
  if (extraProdHosts(env).includes(host)) return `${host} is listed in E2E_EXTRA_PROD_HOSTS`;
  if (host === PROD_DOMAIN) return `${host} is the production domain`;
  if (host.endsWith('.' + PROD_DOMAIN)) {
    const labels = host.slice(0, -(PROD_DOMAIN.length + 1)).split('.');
    const nearest = labels[labels.length - 1];
    if (!DEV_LABEL.test(nearest)) return `${host} is under ${PROD_DOMAIN} with no dev/staging marker (production or a client's address)`;
  }
  return null;
}

/**
 * Throws when any of the named addresses is production. `targets` is { NAME: url }; empty values are skipped (a
 * suite that does not need that address).
 */
export function assertNotProduction(targets, env = process.env) {
  const bad = [];
  for (const [name, url] of Object.entries(targets)) {
    if (url == null || String(url).trim() === '') continue;
    const why = prodReason(url, env);
    if (why) bad.push(`${name}=${url} — ${why}`);
  }
  if (bad.length) {
    const msg =
      `\n${'!'.repeat(72)}\n` +
      `A536 PRODUCTION GUARD: refusing to run the end-to-end suites.\n` +
      bad.map((b) => `  - ${b}`).join('\n') + '\n' +
      `These suites create staff, products and real paid orders. Point them at the DEV environment\n` +
      `(see docs/E2E-NIGHTLY.md). There is no override.\n` +
      `${'!'.repeat(72)}\n`;
    const err = new Error(msg);
    err.code = 'E2E_PROD_GUARD';
    throw err;
  }
}

/** The addresses every entry point reads, by variable name. */
export function targetsFromEnv(env = process.env) {
  return {
    E2E_API_URL:         env.E2E_API_URL,
    E2E_WEB_URL:         env.E2E_WEB_URL,
    E2E_ADMIN_URL:       env.E2E_ADMIN_URL,
    PLAYWRIGHT_BASE_URL: env.PLAYWRIGHT_BASE_URL,
    API_BASE_URL:        env.API_BASE_URL,
  };
}

/**
 * The second layer: the API says what it is. Production omits `env` from /health; refuse unless it says something
 * other than production. Waits (retrying every 10 s) up to waitS seconds for a sleeping service to answer.
 * Returns the parsed /health body.
 */
export async function assertHealthNotProduction(apiUrl, { waitS = 180, log = console.log, fetchImpl = fetch } = {}) {
  assertNotProduction({ API: apiUrl });
  const url = `${String(apiUrl).replace(/\/+$/, '')}/health`;
  const deadline = Date.now() + waitS * 1000;
  let last = 'no answer';
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
      const text = await r.text();
      let body = null;
      try { body = JSON.parse(text); } catch { /* an error page */ }
      if (r.ok && body && body.status) {
        if (!body.env || String(body.env).toLowerCase() === 'production') {
          const err = new Error(
            `\nA536 PRODUCTION GUARD: ${url} answered without a non-production "env" (env=${body.env ?? 'missing'}).\n` +
            `Production hides env; only a dev/staging API may be tested. Refusing.\n`);
          err.code = 'E2E_PROD_GUARD';
          throw err;
        }
        log(`A536: ${url} is up — env=${body.env}, status=${body.status}, commit=${body.commit ?? '?'}`);
        return body;
      }
      last = `HTTP ${r.status}${body ? '' : ' (not JSON — still waking?)'}`;
    } catch (e) {
      if (e && e.code === 'E2E_PROD_GUARD') throw e;
      last = e?.message || String(e);
    }
    if (Date.now() >= deadline) throw new Error(`A536: ${url} did not answer within ${waitS} s (last: ${last})`);
    log(`A536: waiting for ${url} (attempt ${attempt}: ${last})`);
    await new Promise((res) => setTimeout(res, 10_000));
  }
}

/**
 * Chromium --host-resolver-rules that make every production host unresolvable inside the Playwright browser, so even
 * a dev dashboard built with a production API address cannot reach it (the specs then fail loudly instead of selling
 * into a live business). `allow` lists hosts that passed the guard (a dev.zaptill.co.ke target) and must stay reachable.
 */
export function chromiumBlockProdArgs(allow = [], env = process.env) {
  const rules = [...PROD_HOSTS, ...extraProdHosts(env), `*.${PROD_DOMAIN}`].map((h) => `MAP ${h} ~NOTFOUND`);
  for (const a of allow) {
    try { const h = new URL(a).hostname.toLowerCase(); if (h.endsWith(PROD_DOMAIN)) rules.push(`EXCLUDE ${h}`); } catch { /* skipped */ }
  }
  return [`--host-resolver-rules=${rules.join(', ')}`];
}

// ── Command line ────────────────────────────────────────────────────────────────────────────────────────────────────
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  try {
    if (argv[0] === '--check') {
      const list = argv.slice(1);
      if (!list.length) throw new Error('--check needs at least one address');
      assertNotProduction(Object.fromEntries(list.map((u, i) => [`arg${i + 1}`, u])));
      console.log(`A536: not production — ${list.join(', ')}`);
    } else {
      const t = targetsFromEnv();
      assertNotProduction(t);
      const set = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`);
      console.log(`A536: not production — ${set.length ? set.join(', ') : '(no addresses set)'}`);
      if (argv.includes('--health')) {
        const api = t.E2E_API_URL || t.API_BASE_URL;
        if (!api) throw new Error('--health needs E2E_API_URL (or API_BASE_URL)');
        await assertHealthNotProduction(api, { waitS: Number(process.env.E2E_HEALTH_WAIT_S || 180) });
      }
    }
  } catch (e) {
    console.error(e.message);
    process.exit(e.code === 'E2E_PROD_GUARD' ? 3 : 1);
  }
}
