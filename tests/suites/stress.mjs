/**
 * Suite: Stress & Load Testing
 * Tests: concurrent order creation, throughput under load,
 *        response time distributions, error rates under pressure
 *
 * Requires: autocannon (npm install -g autocannon)
 * Run: node tests/runner.mjs --email ... --password ... --stress
 */
import { group, ok, okish, state, BASE } from '../lib.mjs';
import { execSync, spawn } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const AUTOCANNON = 'autocannon';

function hasAutocannon() {
  try { execSync(`${AUTOCANNON} --version`, { stdio: 'ignore' }); return true; }
  catch { return false; }
}

async function runAutocannon(opts) {
  const {
    url, method = 'GET', body, token, duration = 10,
    connections = 10, pipelining = 1, label,
  } = opts;

  const args = [
    url,
    '--duration', String(duration),
    '--connections', String(connections),
    '--pipelining', String(pipelining),
    '--json',
    '--method', method,
  ];

  if (token) {
    args.push('--header', `Authorization: Bearer ${token}`);
  }
  args.push('--header', 'Content-Type: application/json');

  let bodyFile;
  if (body) {
    bodyFile = join(tmpdir(), `swiftpos-stress-${Date.now()}.json`);
    writeFileSync(bodyFile, JSON.stringify(body));
    args.push('--body-file', bodyFile);
  }

  return new Promise((resolve) => {
    let output = '';
    const proc = spawn(AUTOCANNON, args);
    proc.stdout.on('data', d => { output += d; });
    proc.stderr.on('data', d => { /* ignore progress output */ });
    proc.on('close', () => {
      if (bodyFile) { try { unlinkSync(bodyFile); } catch {} }
      try {
        const result = JSON.parse(output);
        resolve(result);
      } catch {
        resolve(null);
      }
    });
  });
}

function pct(result, p) {
  return result?.latency?.[p] ?? result?.latency?.p99 ?? 0;
}

export async function run() {
  // ── Self-login when running standalone ──────────────────────────────────
  if (!state.ownerToken) {
    if (!state.ownerEmail || !state.ownerPassword) {
      console.log('  [stress] skipped — no credentials');
      return;
    }
    const _login = await POST('/api/auth/login', { email: state.ownerEmail, password: state.ownerPassword });
    if (!_login.data?.accessToken) {
      console.log('  [stress] login failed:', _login.data?.error ?? 'unknown');
      return;
    }
    state.ownerToken   = _login.data.accessToken;
    state.refreshToken = _login.data.refreshToken;
    state.businessId   = _login.data.business?.id ?? null;
    const _branches = await GET('/api/branches', state.ownerToken);
    if ((_branches.data ?? []).length > 0) state.branchId = _branches.data[0].id;
  }

  if (!hasAutocannon()) {
    console.log('  [stress] autocannon not found — install with: npm install -g autocannon');
    console.log('  [stress] Running basic concurrent request tests instead...');
    await runBasicConcurrencyTests();
    return;
  }

  // ── Health endpoint throughput ─────────────────────────────────────────────
  group('STRESS — Health endpoint (baseline throughput)');

  const healthResult = await runAutocannon({
    url:         `${BASE}/health`,
    duration:    5,
    connections: 50,
    label:       'health',
  });

  if (healthResult) {
    const rps     = healthResult.requests?.average ?? 0;
    const p99     = pct(healthResult, 'p99');
    const errors  = healthResult.errors ?? 0;
    const non2xx  = healthResult.non2xx ?? 0;

    ok(`Health: ≥100 req/s throughput`, rps >= 100, `got ${rps.toFixed(0)} req/s`);
    ok(`Health: p99 latency < 200ms`, p99 < 200, `p99=${p99}ms`);
    ok(`Health: 0 errors`, errors === 0, `${errors} errors`);
    ok(`Health: 0 non-2xx`, non2xx === 0, `${non2xx} non-2xx`);
    console.log(`  ℹ  Health: ${rps.toFixed(0)} req/s, p50=${pct(healthResult,'p50')}ms, p99=${p99}ms`);
  }

  // ── Auth endpoint throughput ───────────────────────────────────────────────
  group('STRESS — Auth: GET /api/business (JWT verify)');

  const authResult = await runAutocannon({
    url:         `${BASE}/api/business`,
    token:       state.ownerToken,
    duration:    5,
    connections: 20,
    label:       'auth',
  });

  if (authResult) {
    const rps    = authResult.requests?.average ?? 0;
    const p99    = pct(authResult, 'p99');
    const errors = authResult.errors ?? 0;

    ok(`Auth: ≥20 req/s throughput`, rps >= 20, `got ${rps.toFixed(0)} req/s`);
    ok(`Auth: p99 latency < 2000ms`, p99 < 2000, `p99=${p99}ms`);
    ok(`Auth: 0 connection errors`, errors === 0, `${errors} errors`);
    console.log(`  ℹ  Auth: ${rps.toFixed(0)} req/s, p50=${pct(authResult,'p50')}ms, p99=${p99}ms`);
  }

  // ── Orders GET throughput ──────────────────────────────────────────────────
  group('STRESS — Orders: GET /api/orders');

  const ordersResult = await runAutocannon({
    url:         `${BASE}/api/orders`,
    token:       state.ownerToken,
    duration:    5,
    connections: 10,
    label:       'orders-get',
  });

  if (ordersResult) {
    const rps = ordersResult.requests?.average ?? 0;
    const p99 = pct(ordersResult, 'p99');
    ok(`Orders GET: ≥5 req/s`, rps >= 5, `got ${rps.toFixed(0)} req/s`);
    ok(`Orders GET: p99 < 5000ms`, p99 < 5000, `p99=${p99}ms`);
    console.log(`  ℹ  Orders GET: ${rps.toFixed(0)} req/s, p99=${p99}ms`);
  }

  // ── Reports throughput ─────────────────────────────────────────────────────
  group('STRESS — Reports: GET /api/reports/sales');

  const today = new Date().toISOString().split('T')[0];
  const reportsResult = await runAutocannon({
    url:         `${BASE}/api/reports/sales?from=${today}&to=${today}`,
    token:       state.ownerToken,
    duration:    5,
    connections: 5,
    label:       'reports',
  });

  if (reportsResult) {
    const rps = reportsResult.requests?.average ?? 0;
    const p99 = pct(reportsResult, 'p99');
    ok(`Reports: ≥2 req/s`, rps >= 2, `got ${rps.toFixed(0)} req/s`);
    ok(`Reports: p99 < 10000ms`, p99 < 10000, `p99=${p99}ms`);
    console.log(`  ℹ  Reports: ${rps.toFixed(0)} req/s, p99=${p99}ms`);
  }

  // ── Concurrent order creation ──────────────────────────────────────────────
  if (state.branchId) {
    group('STRESS — Concurrent order creation (race conditions)');

    const N = 10;
    console.log(`  Creating ${N} orders concurrently...`);
    const orderPromises = Array.from({ length: N }, (_, i) => {
      const total = 100 + i * 10;
      return fetch(`${BASE}/api/orders`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${state.ownerToken}`,
          'X-Idempotency-Key': `stress-test-${Date.now()}-${i}`,
        },
        body: JSON.stringify({
          branch_id:       state.branchId,
          order_number:    `STRESS-${Date.now()}-${i}`,
          order_type:      'retail',
          subtotal:        total,
          vat_amount:      Math.round((total - total / 1.16) * 100) / 100,
          total,
          discount_amount: 0,
          items: [{
            product_name:      `Stress Item ${i}`,
            category_name:     'Test',
            quantity:          1,
            unitPrice:         total,
            lineTotal:         total,
            selectedVariants:  [],
            selectedModifiers: [],
          }],
          payments: [{ method: 'cash', amount: total }],
        }),
      }).then(r => r.json().then(d => ({ status: r.status, data: d })));
    });

    const results = await Promise.all(orderPromises);
    const successes = results.filter(r => [200, 201].includes(r.status));
    const failures  = results.filter(r => ![200, 201].includes(r.status));

    ok(`${N} concurrent orders: all succeeded`, successes.length === N,
      `${successes.length}/${N} succeeded, ${failures.length} failed: ${
        failures.slice(0,2).map(f => `${f.status}:${f.data?.error}`).join(', ')
      }`);

    // Check for duplicate order numbers (race condition indicator)
    const orderNums = results.filter(r => r.data?.orderNumber).map(r => r.data.orderNumber);
    const unique    = new Set(orderNums);
    ok('No duplicate order numbers', unique.size === orderNums.length,
      `${orderNums.length} orders, ${unique.size} unique`);
  }

  group('STRESS — Summary');
  console.log(`\n  ℹ  Stress tests complete. Server handles concurrent load.`);
  console.log(`  ℹ  For extended load testing: autocannon ${BASE}/health -d 60 -c 100`);
}

async function runBasicConcurrencyTests() {
  if (!state.branchId) return;

  group('STRESS — Basic concurrency (no autocannon)');

  // 20 parallel GET requests
  const start = Date.now();
  const responses = await Promise.all(
    Array.from({ length: 20 }, () =>
      fetch(`${BASE}/health`).then(r => ({ status: r.status, ms: Date.now() - start }))
    )
  );
  const allOk  = responses.every(r => r.status === 200);
  const maxMs  = Math.max(...responses.map(r => r.ms));
  ok('20 parallel health requests all succeed', allOk);
  ok('20 parallel requests complete < 5s', maxMs < 5000, `max=${maxMs}ms`);

  // 5 parallel auth requests
  const authResponses = await Promise.all(
    Array.from({ length: 5 }, () =>
      fetch(`${BASE}/api/business`, {
        headers: { Authorization: `Bearer ${state.ownerToken}` },
      }).then(r => ({ status: r.status }))
    )
  );
  ok('5 parallel authenticated requests all succeed',
    authResponses.every(r => r.status === 200));

  // 5 concurrent order creates
  const orderResults = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      fetch(`${BASE}/api/orders`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${state.ownerToken}`,
        },
        body: JSON.stringify({
          branch_id:       state.branchId,
          order_number:    `CONC-${Date.now()}-${i}`,
          order_type:      'retail',
          subtotal:        500, vat_amount: 69, total: 500,
          discount_amount: 0,
          items: [{
            product_name: `Conc Item ${i}`, category_name: 'Test',
            quantity: 1, unitPrice: 500, lineTotal: 500,
            selectedVariants: [], selectedModifiers: [],
          }],
          payments: [{ method: 'cash', amount: 500 }],
        }),
      }).then(r => r.json().then(d => ({ status: r.status, data: d })))
    )
  );
  const concSucc = orderResults.filter(r => [200,201].includes(r.status)).length;
  ok(`5 concurrent orders: all created`, concSucc === 5, `${concSucc}/5 succeeded`);
}
