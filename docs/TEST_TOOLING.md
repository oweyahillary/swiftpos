# SwiftPOS — Test Tooling & Setup Guide

**Version:** 1.0  
**Date:** August 2026  
**Companion to:** `TEST_PLAN.md`  
**Stack:** Node 24 · TypeScript · Express · React 18 · Vite 6 · Supabase  

---

## Overview

This document maps every section of the Master Test Plan to a concrete tool, explains why that tool was chosen for this stack, and provides the exact setup and example code to get running. No tool requires a paid plan for the coverage we need.

---

## Tool Stack at a Glance

| Test Type | Tool | Applies To (TEST_PLAN sections) |
|---|---|---|
| Unit & integration | **Vitest** | 5, 6, 9, 10, 11, 12, 13, 21 |
| API / route testing | **Supertest** | 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 22 |
| E2E / browser | **Playwright** | 7, 8, 9, 10, 19, 24 |
| Manual API exploration | **Hoppscotch** | All sections (dev workflow) |
| Load & stress | **k6** | 20 |
| Security / vulnerability scan | **OWASP ZAP (CLI)** | 18 |
| M-Pesa callback simulation | **ngrok + custom script** | 15 |
| CI pipeline | **GitHub Actions** | All |

All are free and open source. None require an account except ngrok (free tier is sufficient).

---

## 1. Vitest — Unit & Integration Testing

### Why Vitest

The dashboard already runs on Vite 6. Vitest shares the same config pipeline, so TypeScript, path aliases, and env variables work identically to the app itself — no extra transform layer. It is also Jest-compatible, so any Jest snippet you find online works without changes.

### Installation

```bash
# In apps/server
cd apps/server
npm install -D vitest @vitest/coverage-v8

# In apps/dashboard
cd apps/dashboard
npm install -D vitest @vitest/coverage-v8 @testing-library/react @testing-library/jest-dom jsdom
```

### Configuration — Server

Create `apps/server/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./src/tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/tests/**', 'src/index.ts'],
    },
  },
});
```

Create `apps/server/src/tests/setup.ts`:

```ts
// Load test env before anything else
import 'dotenv/config';
import { beforeAll, afterAll } from 'vitest';

// Global test timeout — auth tests can be slow due to bcrypt
beforeAll(() => {}, 30_000);

// Silence console.log during tests unless DEBUG=true
if (!process.env.DEBUG) {
  global.console.log = () => {};
}
```

### Configuration — Dashboard

Create `apps/dashboard/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/tests/setup.ts'],
  },
});
```

Create `apps/dashboard/src/tests/setup.ts`:

```ts
import '@testing-library/jest-dom';
```

### Add Scripts to package.json

```json
// apps/server/package.json
"scripts": {
  "test": "vitest run",
  "test:watch": "vitest",
  "test:coverage": "vitest run --coverage"
}

// apps/dashboard/package.json — same scripts
```

### Example: Testing a Utility Function (Discount Cap)

The `capDiscount()` function in `src/lib/discountPolicy.ts` is a pure function — test it directly without spinning up a server.

```ts
// apps/server/src/tests/unit/discountPolicy.test.ts
import { describe, it, expect } from 'vitest';
import { capDiscount, MAX_DISCOUNT_PCT } from '../../lib/discountPolicy';

describe('capDiscount', () => {
  it('allows a discount within the cap', () => {
    // 5% of KES 1000 = KES 50 — under the 10% cap
    expect(capDiscount(50, 1000)).toBe(50);
  });

  it('clamps a discount that exceeds MAX_DISCOUNT_PCT', () => {
    // 20% of KES 1000 = KES 200 — capped at 10% = KES 100
    expect(capDiscount(200, 1000)).toBe(100);
  });

  it('clamps a discount that exceeds the order subtotal', () => {
    // Cannot discount more than the order is worth
    expect(capDiscount(600, 500)).toBe(500 * (MAX_DISCOUNT_PCT / 100));
  });

  it('returns 0 for a negative requested discount', () => {
    expect(capDiscount(-50, 1000)).toBe(0);
  });

  it('handles floating point correctly', () => {
    // KES 33.33 × 3 edge case — must not produce drift
    const result = capDiscount(9.999, 99.99);
    expect(result).toBe(Math.round(result * 100) / 100);
  });
});
```

### Example: Testing the Loyalty Tier Helper

```ts
// apps/server/src/tests/unit/loyalty.test.ts
import { describe, it, expect } from 'vitest';
import { getTier } from '../../routes/loyalty';

describe('getTier', () => {
  it('returns Bronze for 0 points', () => {
    const tier = getTier(0);
    expect(tier.name).toBe('Bronze');
    expect(tier.multiplier).toBe(1.0);
    expect(tier.next).toBe(1000);
  });

  it('returns Silver at exactly 1000 points', () => {
    const tier = getTier(1000);
    expect(tier.name).toBe('Silver');
    expect(tier.multiplier).toBe(1.5);
    expect(tier.next).toBe(5000);
  });

  it('returns Gold at exactly 5000 points', () => {
    const tier = getTier(5000);
    expect(tier.name).toBe('Gold');
    expect(tier.multiplier).toBe(2.0);
    expect(tier.next).toBeNull();
  });

  it('returns Gold for points above 5000', () => {
    expect(getTier(99999).name).toBe('Gold');
  });
});
```

---

## 2. Supertest — API Route Testing

### Why Supertest

Supertest wraps your Express `app` object directly — no server needs to be running, no ports are bound. Tests call the same route handlers production uses, with full middleware execution. Combined with Vitest, this covers the entire TEST_PLAN sections on auth, RBAC, orders, shifts, expenses, and reports.

### Installation

```bash
# In apps/server
npm install -D supertest @types/supertest
```

### App Factory Pattern

For Supertest to work cleanly, the Express `app` must be exported separately from the `listen()` call. Currently `index.ts` mixes both. Create `apps/server/src/app.ts`:

```ts
// apps/server/src/app.ts
import 'dotenv/config';
import './lib/envGuard';
import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import apiRoutes from './routes';

// ... (move all middleware + route setup here, same as index.ts)
// Do NOT call app.listen() here

export { app };
```

Then in `index.ts`:

```ts
import { app } from './app';
import { startDailySummaryJob } from './jobs/dailySummary';
// ...

const PORT = process.env.PORT ?? 4000;
app.listen(PORT, () => { /* startup logs */ });
startDailySummaryJob();
```

### Shared Test Helpers

Create `apps/server/src/tests/helpers.ts`:

```ts
import supertest from 'supertest';
import { app } from '../app';
import jwt from 'jsonwebtoken';

export const api = supertest(app);

const JWT_SECRET = process.env.JWT_SECRET!;

/** Mint a test token for a given role/permission set */
export function makeToken(overrides: {
  userId?: string;
  businessId?: string;
  branchId?: string | null;
  isOwner?: boolean;
  permissionKeys?: string[];
  surface?: string;
  permissionsVersion?: number;
} = {}) {
  return jwt.sign(
    {
      userId:             overrides.userId             ?? 'test-user-001',
      businessId:         overrides.businessId         ?? 'test-biz-001',
      branchId:           overrides.branchId           ?? null,
      isOwner:            overrides.isOwner            ?? false,
      permissionKeys:     overrides.permissionKeys     ?? [],
      surface:            overrides.surface            ?? 'web',
      sessionId:          'test-session-001',
      permissionsVersion: overrides.permissionsVersion ?? 1,
    },
    JWT_SECRET,
    { expiresIn: '15m', algorithm: 'HS256' }
  );
}

export const ownerToken    = makeToken({ isOwner: true, permissionKeys: ['*'] });
export const cashierToken  = makeToken({ permissionKeys: ['pos.sell', 'orders.view'] });
export const reporterToken = makeToken({ permissionKeys: ['reports.view'] });
export const noPermToken   = makeToken({ permissionKeys: [] });
```

### Example: AUTH Tests (TEST_PLAN Section 5)

```ts
// apps/server/src/tests/routes/auth.test.ts
import { describe, it, expect } from 'vitest';
import { api } from '../helpers';

describe('POST /api/auth/login', () => {
  it('AUTH-002 — wrong password returns 401 without revealing email existence', async () => {
    const res = await api
      .post('/api/auth/login')
      .send({ email: 'owner@test.com', password: 'wrongpassword' });

    expect(res.status).toBe(401);
    // Error message must not say "wrong password" vs "email not found"
    expect(res.body.error).not.toMatch(/password/i);
    expect(res.body.error).not.toMatch(/not found/i);
  });

  it('AUTH-005 — empty body returns 400', async () => {
    const res = await api.post('/api/auth/login').send({});
    expect(res.status).toBe(400);
  });

  it('AUTH-006 — SQL injection in email field does not cause 500', async () => {
    const res = await api
      .post('/api/auth/login')
      .send({ email: "' OR '1'='1", password: 'anything' });

    expect(res.status).toBeLessThan(500);
    expect(res.body).not.toHaveProperty('stack');
  });

  it('AUTH-024 — token signed with wrong secret returns 401', async () => {
    const fakeToken = require('jsonwebtoken').sign(
      { userId: 'hacker', businessId: 'biz', isOwner: true },
      'wrong-secret'
    );

    const res = await api
      .get('/api/products')
      .set('Authorization', `Bearer ${fakeToken}`);

    expect(res.status).toBe(401);
  });

  it('AUTH-025 — alg:none token is rejected', async () => {
    // Manually construct a token with alg:none
    const header  = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ userId: 'x', isOwner: true })).toString('base64url');
    const noneToken = `${header}.${payload}.`;

    const res = await api
      .get('/api/products')
      .set('Authorization', `Bearer ${noneToken}`);

    expect(res.status).toBe(401);
  });
});
```

### Example: RBAC Tests (TEST_PLAN Section 6)

```ts
// apps/server/src/tests/routes/rbac.test.ts
import { describe, it, expect } from 'vitest';
import { api, ownerToken, cashierToken, noPermToken, makeToken } from '../helpers';

describe('RBAC — permission enforcement', () => {
  it('RBAC-001 — cashier without reports.view is blocked', async () => {
    const res = await api
      .get('/api/reports/daily')
      .set('Authorization', `Bearer ${cashierToken}`);

    expect(res.status).toBe(403);
  });

  it('RBAC-004 — owner with wildcard reaches any route', async () => {
    const res = await api
      .get('/api/reports/daily')
      .set('Authorization', `Bearer ${ownerToken}`);

    // 200 (or at most 400 for missing params — never 401/403)
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it('RBAC-002 — cashier without expenses.manage cannot POST expense', async () => {
    const viewOnlyToken = makeToken({ permissionKeys: ['expenses.view'] });

    const res = await api
      .post('/api/expenses')
      .set('Authorization', `Bearer ${viewOnlyToken}`)
      .send({ category_id: 'cat-001', amount: 500, description: 'Test' });

    expect(res.status).toBe(403);
  });

  it('RBAC-030 — desktop token blocked from web-only report endpoint', async () => {
    const desktopToken = makeToken({
      permissionKeys: ['reports.view'],
      surface: 'desktop',
    });

    const res = await api
      .get('/api/reports/daily')
      .set('Authorization', `Bearer ${desktopToken}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WEB_SURFACE_REQUIRED');
  });
});
```

### Example: Security Tests (TEST_PLAN Section 18)

```ts
// apps/server/src/tests/security/injection.test.ts
import { describe, it, expect } from 'vitest';
import { api, ownerToken } from '../helpers';

describe('Injection & payload abuse', () => {
  it('SEC-003 — prototype pollution via body does not grant isOwner', async () => {
    const res = await api
      .post('/api/auth/login')
      .send({ '__proto__': { isOwner: true }, email: 'x', password: 'y' });

    // Must not succeed as an owner
    expect(res.status).not.toBe(200);
  });

  it('SEC-011 — /health does not expose version in production mode', async () => {
    // Simulate production by checking what the response contains
    // In a real prod test, NODE_ENV=production would be set
    const res = await api.get('/health');
    expect(res.status).toBeLessThanOrEqual(503); // 200 or 503 (db down in test)
    // version field should only appear when NOT in production
    if (process.env.NODE_ENV === 'production') {
      expect(res.body).not.toHaveProperty('version');
      expect(res.body).not.toHaveProperty('env');
    }
  });

  it('SEC-012 — 500 errors do not leak stack traces', async () => {
    // Hit a route with a payload designed to trigger an error
    const res = await api
      .post('/api/orders')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ items: null }); // malformed

    if (res.status >= 500) {
      expect(res.body).not.toHaveProperty('stack');
      expect(res.body.error).toBe('Internal server error');
    }
  });

  it('SEC-026 — payload over 1MB returns 413', async () => {
    const bigPayload = { data: 'x'.repeat(1_100_000) };

    const res = await api
      .post('/api/orders')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(bigPayload);

    expect(res.status).toBe(413);
  });
});
```

### Running Supertest + Vitest

```bash
cd apps/server
npm test                   # run once
npm run test:watch         # watch mode during development
npm run test:coverage      # with coverage report
```

---

## 3. Playwright — End-to-End Testing

### Why Playwright

Playwright drives a real browser (Chromium, Firefox, WebKit). For SwiftPOS this means testing the full login → order → receipt → EOD flow exactly as a cashier experiences it. It also has first-class support for Electron, which covers the desktop app when that is built.

### Installation

```bash
# At the repo root or in apps/dashboard
npm install -D @playwright/test
npx playwright install chromium  # install only chromium to keep CI lean
```

### Configuration

Create `playwright.config.ts` at the repo root:

```ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : 4,

  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],

  // Start both server and dashboard before running tests
  webServer: [
    {
      command: 'cd apps/server && npm run dev',
      url: 'http://localhost:4000/health',
      reuseExistingServer: !process.env.CI,
      timeout: 15_000,
    },
    {
      command: 'cd apps/dashboard && npm run dev',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 15_000,
    },
  ],
});
```

### Page Object Model

Create `e2e/pages/LoginPage.ts`:

```ts
import { type Page } from '@playwright/test';

export class LoginPage {
  constructor(private page: Page) {}

  async goto() {
    await this.page.goto('/login');
  }

  async loginAsOwner(email: string, password: string) {
    await this.page.fill('[data-testid="email"]', email);
    await this.page.fill('[data-testid="password"]', password);
    await this.page.click('[data-testid="login-btn"]');
    await this.page.waitForURL('/dashboard');
  }

  errorMessage() {
    return this.page.locator('[data-testid="login-error"]');
  }
}
```

Create `e2e/pages/POSPage.ts`:

```ts
import { type Page } from '@playwright/test';

export class POSPage {
  constructor(private page: Page) {}

  async goto() {
    await this.page.goto('/pos');
  }

  async addProductByName(name: string) {
    await this.page.click(`[data-product-name="${name}"]`);
  }

  async completeCashPayment(amount: number) {
    await this.page.click('[data-testid="pay-btn"]');
    await this.page.fill('[data-testid="cash-amount"]', String(amount));
    await this.page.click('[data-testid="confirm-payment"]');
  }

  orderTotal() {
    return this.page.locator('[data-testid="order-total"]');
  }

  successBanner() {
    return this.page.locator('[data-testid="order-success"]');
  }
}
```

### Example: Full Order Flow E2E Test (TEST_PLAN Section 7 + 24)

```ts
// e2e/order-flow.spec.ts
import { test, expect } from '@playwright/test';
import { LoginPage } from './pages/LoginPage';
import { POSPage }   from './pages/POSPage';

test.describe('Order flow', () => {
  test('ORD-001 — cashier can complete a cash order', async ({ page }) => {
    const loginPage = new LoginPage(page);
    const posPage   = new POSPage(page);

    await loginPage.goto();
    await loginPage.loginAsOwner(
      process.env.TEST_OWNER_EMAIL!,
      process.env.TEST_OWNER_PASSWORD!
    );

    await posPage.goto();
    await posPage.addProductByName('Chai');
    await expect(posPage.orderTotal()).not.toHaveText('KES 0.00');

    await posPage.completeCashPayment(50);
    await expect(posPage.successBanner()).toBeVisible();
  });

  test('DSC-004 — 100% manual discount is clamped to 10%', async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.loginAsOwner(
      process.env.TEST_OWNER_EMAIL!,
      process.env.TEST_OWNER_PASSWORD!
    );

    // Add a product and apply a discount
    await page.goto('/pos');
    await page.click('[data-product-name="Chai"]');
    await page.click('[data-testid="apply-discount"]');
    await page.fill('[data-testid="discount-percent"]', '100');
    await page.click('[data-testid="confirm-discount"]');

    // Order total should reflect 10% cap, not 100%
    const total = await page.locator('[data-testid="order-total"]').textContent();
    const original = await page.locator('[data-testid="order-subtotal"]').textContent();

    // Extract numbers and compare
    const totalNum    = parseFloat(total!.replace(/[^\d.]/g, ''));
    const originalNum = parseFloat(original!.replace(/[^\d.]/g, ''));
    expect(totalNum).toBeCloseTo(originalNum * 0.9, 1); // 10% discount applied
  });
});
```

### Running Playwright

```bash
npx playwright test                     # headless
npx playwright test --headed            # see the browser
npx playwright test --ui                # interactive UI mode (great for debugging)
npx playwright show-report              # view HTML report after a run
```

---

## 4. Hoppscotch — Manual API Exploration

### Why Hoppscotch

Hoppscotch is a free, open-source Postman alternative that runs in the browser or as a desktop app. Use it during development to manually probe routes, test edge cases interactively, and share collections with a team. It supports REST, and can be self-hosted.

### Setup

No installation needed for the web version. Go to [hoppscotch.io](https://hoppscotch.io).

For a self-hosted version (recommended — keeps your API calls private):

```bash
# Using Docker
docker run -p 3170:3170 hoppscotch/hoppscotch:latest
# Access at http://localhost:3170
```

### SwiftPOS Collection Structure (recommended layout)

Organise your Hoppscotch workspace to mirror the route tree:

```
SwiftPOS API
├── 🔐 Auth
│   ├── POST login (owner)
│   ├── POST pos-login (cashier PIN)
│   ├── POST refresh
│   └── POST logout
├── 📦 Orders
│   ├── POST create order (cash)
│   ├── POST create order (M-Pesa)
│   └── POST refund
├── 🕐 Shifts
│   ├── GET current
│   ├── POST open
│   └── POST close
├── 💸 Expenses
│   ├── GET categories
│   ├── POST category
│   └── POST expense
├── 📊 Reports
│   ├── GET daily DSR
│   ├── GET Z-report
│   └── GET export (Excel)
└── 🔧 Admin
    ├── POST admin login
    └── GET fleet stats
```

### Environment Variables in Hoppscotch

Set these in the Hoppscotch environment panel:

| Variable | Value |
|---|---|
| `BASE_URL` | `http://localhost:4000/api` |
| `OWNER_TOKEN` | (paste after login) |
| `CASHIER_TOKEN` | (paste after POS login) |
| `ADMIN_TOKEN` | (paste after admin login) |
| `TEST_BUSINESS_ID` | your dev business UUID |
| `TEST_BRANCH_ID` | your dev branch UUID |

Use `{{OWNER_TOKEN}}` in the Authorization header across all requests so rotating the token updates every request at once.

---

## 5. k6 — Load & Stress Testing

### Why k6

k6 scripts in JavaScript, produces beautiful terminal output, and exports results to Grafana or InfluxDB — which integrates directly with your existing Prometheus/Grafana home lab stack.

### Installation

```bash
# Ubuntu / Debian
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
  | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6

# macOS
brew install k6

# Docker (no install)
docker run --rm -i grafana/k6 run - < script.js
```

### Test Script — Order Submission Load Test (TEST_PLAN PERF-001)

Create `load-tests/order-load.js`:

```js
import http   from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const orderLatency  = new Trend('order_latency');
const orderFailRate = new Rate('order_fail_rate');

export const options = {
  scenarios: {
    // PERF-001: 30 concurrent cashiers (restaurant peak)
    restaurant_peak: {
      executor: 'constant-vus',
      vus: 30,
      duration: '2m',
    },
    // PERF-002: Stress ramp — watch for rate limiter
    stress_ramp: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 50  },
        { duration: '1m',  target: 200 },
        { duration: '30s', target: 0   },
      ],
      startTime: '3m', // run after restaurant_peak
    },
  },
  thresholds: {
    order_latency:  ['p(95)<400', 'p(99)<800'],
    order_fail_rate: ['rate<0.01'], // less than 1% failure
    http_req_failed: ['rate<0.01'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:4000/api';
const TOKEN    = __ENV.OWNER_TOKEN;

export default function () {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${TOKEN}`,
    'x-device-id': `load-test-device-${__VU}`,  // unique per virtual user
  };

  const orderPayload = JSON.stringify({
    branch_id: __ENV.BRANCH_ID,
    items: [
      {
        product_id: __ENV.PRODUCT_ID,
        quantity: 1,
        unit_price: 100,
        total_price: 100,
      },
    ],
    subtotal: 100,
    discount: 0,
    total: 100,
    payment_legs: [{ method: 'cash', amount: 100 }],
  });

  const start = Date.now();
  const res   = http.post(`${BASE_URL}/orders`, orderPayload, { headers });
  orderLatency.add(Date.now() - start);

  const ok = check(res, {
    'order created (201)':   r => r.status === 201,
    'has order id':          r => r.json('id') !== undefined,
    'no stack trace in body': r => !r.body.includes('at '),
  });

  if (!ok) orderFailRate.add(1);

  sleep(Math.random() * 2); // simulate cashier think time
}
```

### Running Load Tests

```bash
# Basic run
k6 run \
  -e BASE_URL=http://localhost:4000/api \
  -e OWNER_TOKEN="your-token-here" \
  -e BRANCH_ID="your-branch-uuid" \
  -e PRODUCT_ID="your-product-uuid" \
  load-tests/order-load.js

# Stream results to your local Prometheus/Grafana stack
k6 run \
  --out experimental-prometheus-rw \
  load-tests/order-load.js
```

### Test Script — Rate Limiter Verification (TEST_PLAN SEC-020, SEC-022)

```js
// load-tests/rate-limit.js
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  vus: 1,
  iterations: 35,  // auth limiter fires at 30
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:4000/api';

export default function () {
  const res = http.post(`${BASE_URL}/auth/login`, JSON.stringify({
    email: 'brute@test.com',
    password: 'wrongpassword',
  }), { headers: { 'Content-Type': 'application/json' } });

  const iter = __ITER + 1;
  if (iter <= 30) {
    check(res, { [`attempt ${iter} — 401`]: r => r.status === 401 });
  } else {
    check(res, { [`attempt ${iter} — 429 (rate limited)`]: r => r.status === 429 });
  }
}
```

---

## 6. OWASP ZAP — Automated Security Scanning

### Why ZAP

OWASP ZAP is the industry-standard open-source security scanner. It probes your running API for SQL injection, XSS, broken authentication, information disclosure, and dozens of other OWASP Top 10 vulnerabilities. The CLI mode runs cleanly in CI.

### Installation

```bash
# Docker (simplest — no Java setup)
docker pull ghcr.io/zaproxy/zaproxy:stable
```

### Run a Baseline Scan

```bash
# With your server running on localhost:4000
docker run --rm \
  --network host \
  -v $(pwd)/zap-reports:/zap/wrk/:rw \
  ghcr.io/zaproxy/zaproxy:stable \
  zap-baseline.py \
    -t http://localhost:4000 \
    -r zap-baseline-report.html \
    -I  # do not fail on warnings, only on alerts
```

### Run a Full API Scan (uses OpenAPI spec)

If you generate an OpenAPI spec for SwiftPOS routes:

```bash
docker run --rm \
  --network host \
  -v $(pwd)/zap-reports:/zap/wrk/:rw \
  ghcr.io/zaproxy/zaproxy:stable \
  zap-api-scan.py \
    -t http://localhost:4000/api/openapi.json \
    -f openapi \
    -r zap-api-report.html
```

ZAP will specifically look for:
- Unauthenticated endpoint access (TEST_PLAN SEC-017)
- Information disclosure in error messages (SEC-011, SEC-012, SEC-013)
- Missing security headers (helmet should handle this)
- Injection points on query parameters and request bodies

---

## 7. M-Pesa Callback Simulation

For testing M-Pesa callback handling (TEST_PLAN Section 15) without waiting for Safaricom's sandbox, use a local script to POST the expected Daraja payload.

### Setup ngrok

```bash
# Install ngrok (free tier)
npm install -g ngrok
ngrok http 4000
# Note your public URL: https://xxxx.ngrok.io
```

Set in `.env`:

```env
MPESA_CALLBACK_BASE_URL=https://xxxx.ngrok.io
MPESA_ENVIRONMENT=sandbox
```

### Callback Simulation Script

Create `scripts/simulate-mpesa-callback.mjs`:

```js
// Simulates a successful Daraja STK Push callback
// Usage: node scripts/simulate-mpesa-callback.mjs [checkoutRequestId] [amount]

const checkoutRequestId = process.argv[2] || 'ws_CO_TEST_001';
const amount            = Number(process.argv[3]) || 100;

const payload = {
  Body: {
    stkCallback: {
      MerchantRequestID: 'test-merchant-001',
      CheckoutRequestID: checkoutRequestId,
      ResultCode: 0,       // 0 = success
      ResultDesc: 'The service request is processed successfully.',
      CallbackMetadata: {
        Item: [
          { Name: 'Amount',              Value: amount },
          { Name: 'MpesaReceiptNumber',  Value: 'NLJ7RT61SV' },
          { Name: 'TransactionDate',     Value: 20240101120000 },
          { Name: 'PhoneNumber',         Value: 254708374149 },
        ],
      },
    },
  },
};

const res = await fetch('http://localhost:4000/api/mpesa/callback', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});

console.log('Status:', res.status);
console.log('Body:', await res.json());
```

```bash
# Simulate success callback
node scripts/simulate-mpesa-callback.mjs ws_CO_TEST_001 150

# Simulate failure (ResultCode != 0)
# Edit the script: ResultCode: 1032 (user cancelled)
```

---

## 8. GitHub Actions — CI Pipeline

### Why CI

Every push to `main` and every pull request must run the full test suite automatically. A deploy without passing tests must be blocked.

### Pipeline Configuration

Create `.github/workflows/test.yml`:

```yaml
name: Test Suite

on:
  push:
    branches: [main, dev]
  pull_request:
    branches: [main]

jobs:
  unit-and-integration:
    name: Vitest + Supertest
    runs-on: ubuntu-latest

    env:
      NODE_ENV: test
      JWT_SECRET: ${{ secrets.TEST_JWT_SECRET }}
      SUPABASE_URL: ${{ secrets.TEST_SUPABASE_URL }}
      SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.TEST_SUPABASE_SERVICE_ROLE_KEY }}
      SUPABASE_JWT_SECRET: ${{ secrets.TEST_SUPABASE_JWT_SECRET }}

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: 'npm'
          cache-dependency-path: |
            apps/server/package-lock.json
            apps/dashboard/package-lock.json

      - name: Install server deps
        run: cd apps/server && npm ci

      - name: Run server tests
        run: cd apps/server && npm run test:coverage

      - name: Install dashboard deps
        run: cd apps/dashboard && npm ci

      - name: Run dashboard tests
        run: cd apps/dashboard && npm test

      - name: Upload coverage
        uses: actions/upload-artifact@v4
        with:
          name: coverage-report
          path: apps/server/coverage/

  e2e:
    name: Playwright E2E
    runs-on: ubuntu-latest
    needs: unit-and-integration  # only run E2E if unit tests pass

    env:
      TEST_OWNER_EMAIL: ${{ secrets.TEST_OWNER_EMAIL }}
      TEST_OWNER_PASSWORD: ${{ secrets.TEST_OWNER_PASSWORD }}

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '24'

      - run: npm ci && cd apps/server && npm ci && cd ../dashboard && npm ci

      - name: Install Playwright browsers
        run: npx playwright install --with-deps chromium

      - name: Run E2E tests
        run: npx playwright test

      - name: Upload Playwright report
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: playwright-report/

  security-scan:
    name: OWASP ZAP Baseline
    runs-on: ubuntu-latest
    needs: unit-and-integration

    steps:
      - uses: actions/checkout@v4

      - name: Start server
        run: cd apps/server && npm ci && npm run dev &
        env:
          JWT_SECRET: ${{ secrets.TEST_JWT_SECRET }}
          SUPABASE_URL: ${{ secrets.TEST_SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.TEST_SUPABASE_SERVICE_ROLE_KEY }}

      - name: Wait for server
        run: npx wait-on http://localhost:4000/health --timeout 30000

      - name: ZAP Baseline Scan
        uses: zaproxy/action-baseline@v0.12.0
        with:
          target: 'http://localhost:4000'
          fail_action: false  # warn only; graduate to true when baseline is clean
```

### GitHub Secrets to Configure

| Secret | Description |
|---|---|
| `TEST_JWT_SECRET` | A test-only JWT secret (not your production secret) |
| `TEST_SUPABASE_URL` | Dev Supabase URL |
| `TEST_SUPABASE_SERVICE_ROLE_KEY` | Dev Supabase service role key |
| `TEST_SUPABASE_JWT_SECRET` | Dev Supabase JWT secret |
| `TEST_OWNER_EMAIL` | Test business owner email |
| `TEST_OWNER_PASSWORD` | Test business owner password |

---

## 9. Recommended File Structure

Add this test folder layout to the existing monorepo:

```
swiftpos/
├── apps/
│   ├── server/
│   │   └── src/
│   │       └── tests/
│   │           ├── setup.ts
│   │           ├── helpers.ts
│   │           ├── unit/
│   │           │   ├── discountPolicy.test.ts
│   │           │   ├── loyalty.test.ts
│   │           │   ├── orderTax.test.ts
│   │           │   └── dateRange.test.ts
│   │           ├── routes/
│   │           │   ├── auth.test.ts
│   │           │   ├── rbac.test.ts
│   │           │   ├── orders.test.ts
│   │           │   ├── shifts.test.ts
│   │           │   ├── expenses.test.ts
│   │           │   ├── reports.test.ts
│   │           │   ├── loyalty.test.ts
│   │           │   ├── credit.test.ts
│   │           │   └── mpesa.test.ts
│   │           └── security/
│   │               ├── injection.test.ts
│   │               ├── tenancy.test.ts
│   │               └── ratelimit.test.ts
│   └── dashboard/
│       └── src/
│           └── tests/
│               ├── setup.ts
│               └── components/
│                   ├── LoginForm.test.tsx
│                   └── OrderSummary.test.tsx
├── e2e/
│   ├── pages/
│   │   ├── LoginPage.ts
│   │   └── POSPage.ts
│   ├── order-flow.spec.ts
│   ├── shift-management.spec.ts
│   └── security.spec.ts
├── load-tests/
│   ├── order-load.js
│   └── rate-limit.js
├── scripts/
│   └── simulate-mpesa-callback.mjs
└── .github/
    └── workflows/
        └── test.yml
```

---

## 10. Quick Reference — Running Tests

| What | Command |
|---|---|
| Server unit + integration tests | `cd apps/server && npm test` |
| Server tests with coverage | `cd apps/server && npm run test:coverage` |
| Dashboard component tests | `cd apps/dashboard && npm test` |
| E2E (headless) | `npx playwright test` |
| E2E (headed, debug) | `npx playwright test --headed` |
| E2E interactive UI | `npx playwright test --ui` |
| Load test (restaurant peak) | `k6 run load-tests/order-load.js` |
| Rate limiter check | `k6 run load-tests/rate-limit.js` |
| Security baseline scan | `docker run ... zap-baseline.py ...` |
| Simulate M-Pesa success callback | `node scripts/simulate-mpesa-callback.mjs` |
| Manual API exploration | Open hoppscotch.io |

---

*This tooling guide should be read alongside `TEST_PLAN.md`. The plan defines what to test; this document defines how. Update this file whenever a new route group is added — add the corresponding Supertest file to `src/tests/routes/` and reference the relevant TEST_PLAN section IDs in the test descriptions.*
