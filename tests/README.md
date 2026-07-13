# SwiftPOS System Test Suite

Vigorous integration + security + stress tests hitting your live server.
No mocks. No stubs. Real HTTP requests against real endpoints.

## Prerequisites

- Server running: `pnpm --filter server dev` (or deployed URL)
- Owner account credentials
- Node 18+ (uses native `fetch`)
- `autocannon` for stress tests: `npm install -g autocannon`

## Quick start

```bash
# All suites except stress (takes ~30 seconds)
node tests/runner.mjs \
  --email owner@yourbusiness.com \
  --password YourPassword123

# With stress testing (takes ~90 seconds)
node tests/runner.mjs \
  --email owner@yourbusiness.com \
  --password YourPassword123 \
  --stress

# Against production
node tests/runner.mjs \
  --url https://your-server.railway.app \
  --email owner@yourbusiness.com \
  --password YourPassword123

# Specific suites only
node tests/runner.mjs \
  --email owner@yourbusiness.com \
  --password YourPassword123 \
  --suite security,permissions

# Verbose (show passing tests too)
node tests/runner.mjs \
  --email owner@yourbusiness.com \
  --password YourPassword123 \
  --verbose

# Stop on first failure
node tests/runner.mjs \
  --email owner@yourbusiness.com \
  --password YourPassword123 \
  --bail
```

## Test suites

### `auth` — Authentication & token security
- Owner login, bad credentials → 401
- Token verification, tampered token → 401
- Algorithm:none JWT bypass attempt
- Refresh token rotation (old token revoked after use)
- Replay attack detection → 401 TOKEN_REPLAYED
- Real server-side logout (POST /api/auth/logout)
- POS PIN login validation
- Security headers (helmet: X-Content-Type-Options, X-Frame-Options, no X-Powered-By)

### `data` — Data entry & CRUD
- Branches: list, read, business isolation
- Categories: create, list, duplicate handling
- Products: CRUD, invalid price handling, barcode lookup
- Staff: list, roles, permissions
- Discounts: create, percentage > 100 rejected
- Expenses: categories, expense creation
- Inventory: listing
- Suppliers: create, list
- Promotions: create, list
- Business settings: read, write

### `orders` — Order processing
- POS init endpoint
- Shift lifecycle: open → duplicate rejected → float-in → close
- Denomination breakdown validation
- Cash shift reconciliation maths (expectedCash = float + cash − out)
- Order creation with cash, split payment (cash + M-Pesa), discount
- VAT maths end-to-end (16%, extracted from inclusive price)
- Idempotency key deduplication
- Missing fields validation (empty items, no payment)
- Void: missing reason → 400, void → 200, double void → 400
- Shift close: variance note required, denomination mismatch → 400

### `reports` — Reporting & maths invariants
- Sales report (today, week range, branch filter)
- Revenue invariant: netRevenue = totalRevenue − totalVat
- VAT invariant: category VAT sums to total VAT (single source of truth)
- Products, staff performance, EOD, master DSR
- Tax report with CTL calculation
- Voids report, hourly breakdown
- Inventory report
- Shifts report
- Edge cases: future dates → 0 orders, missing date params
- Export endpoints require auth

### `security` — Security hardening
- **IDOR prevention**: fake UUIDs → 404, never 200 with other tenant's data
- **Auth bypass**: null byte, empty bearer, Basic auth, algorithm:none JWT
- **Token forgery**: hand-crafted owner token → 401 (wrong signature)
- **SQL injection**: `'; DROP TABLE orders; --` in name fields
- **XSS**: `<script>` in category names (stored safely, not executed)
- **Oversized payloads**: 2MB JSON → 413/400 (server limit: 1MB)
- **Path traversal**: `../../etc/passwd` → not 200
- **Sensitive data**: `pin_hash` never in staff list, supervisor PIN masked as `****`
- **Rate limiting**: rapid login attempts
- **CORS**: unknown origin blocked, known origin allowed

### `permissions` — RBAC enforcement
- Owner full access to all endpoints
- Surface restrictions: reports require web surface
- `requirePermission` blocks staff without the right key
- Branch scoping: cross-branch access blocked
- Role escalation prevention: can't assign owner role via API
- Cross-business isolation: other tenant's resources → 404
- All protected routes require auth → 401 without token
- Device registration API
- permissions_version: owners skip check, no false PERMISSIONS_CHANGED

### `stress` — Load & concurrency
- Health endpoint: ≥100 req/s, p99 < 200ms
- Auth endpoint (JWT verify): ≥20 req/s, p99 < 2s
- Orders GET: ≥5 req/s, p99 < 5s
- Reports GET: ≥2 req/s
- 10 concurrent order creates: all succeed, no duplicate order numbers
- Falls back to basic concurrency tests if autocannon not installed

## Exit codes
- `0` — all tests passed
- `1` — one or more tests failed

## Adding tests

Each suite is a plain `.mjs` file in `tests/suites/`.
Export an async `run()` function. Import helpers from `../runner.mjs`.

```js
import { group, ok, okish, GET, POST, state } from '../runner.mjs';

export async function run() {
  group('MY FEATURE — Description');
  
  const res = await GET('/api/my-endpoint', state.ownerToken);
  ok('Returns 200', res.status === 200);
  ok('Has expected field', !!res.data?.myField, `got ${JSON.stringify(res.data)}`);
  
  okish('Optional feature present', !!res.data?.optionalField,
    'not configured — skip if not needed');
}
```

Register it in `runner.mjs`:
```js
await runSuite('myfeature', './suites/myfeature.mjs');
```
And add it to `--suite` default.
