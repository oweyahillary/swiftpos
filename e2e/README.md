# SwiftPOS — E2E UI tests (Playwright)

Browser tests for the dashboard web app across its three surfaces (owner
`/dashboard`, POS `/pos`, manager `/manager`) plus public routes. Complements the
API/integration suite in `../tests` — this layer catches the render/wiring bugs a
real browser sees (the "stale build" class of issue), and it already caught a real
dine-in bug (see below).

## Quick start

```bash
cd e2e
npm install
npm run install:browsers        # one-time Chromium download
cp .env.example .env            # set OWNER_EMAIL / OWNER_PASSWORD
npm run seed:users              # creates test staff + writes their PINs to .env
npm test                        # run everything
```

**Prerequisites:** the dashboard (`http://localhost:5173`) and API
(`http://localhost:4000`) running — your normal dev setup — or a deployed target
via `PLAYWRIGHT_BASE_URL`. The API base can be overridden with `API_BASE_URL`
(default `http://localhost:4000`), used by the seed script.

## What's covered (10 tests + 1 skipped)

**Auth (all three surfaces)**
- Owner login → `/dashboard`, session reused across specs via `storageState`.
- Cashier PIN login → `/pos/cashier`.
- Custom Waiter-role PIN login → `/pos/cashier`.
- Manager PIN login → `/manager`.

**POS sales & regressions**
- Variant product → cash checkout completes (the old 100%-blocker).
- Dine-in table auto-clears after payment (**caught a real bug — now fixed**).
- Expired POS session returns to the PIN lock (security hardening).
- Print Bill does not freeze the cashier.

**Owner reporting**
- Cockpit "Revenue today" increases after a same-day sale (verifies the EAT
  business-day / timezone fix, end to end across two browser sessions).

**Public (skipped)**
- KDS board renders — written for the FIXED behaviour, `test.skip`'d until the KDS
  page routes its request through the authenticated api client (it currently 401s).
  To enable: remove `.skip` in `specs/public/kds.spec.ts` and set `KDS_BRANCH_ID`.

## How it's built

- **Owner** logs in once (setup project) → session saved to `playwright/.auth/` and
  reused. **POS/manager/custom** log in per-test with a PIN (`lib/pos-login.ts`).
- **Shared POS flow** in `lib/pos-flow.ts`: open shift → open a dine-in table →
  add a variant product → sell for cash. These encode the real pre-conditions a
  sale passes through (shift float, table selection, covers).
- **Seeding** (`npm run seed:users`): logs in as owner, creates manager /
  supervisor / cashier and a custom **Waiter** role (limited to taking orders) with
  known PINs, and writes the credentials into `.env`. Idempotent.
- **Credentials** come from `.env` (gitignored). Nothing is hard-coded.

## Selector hooks in app source (intentional — do not remove)

The POS screens use inline styles with no stable handles, so a few non-behavioural
`data-testid` / `data-*` attributes were added to `CashierScreen.tsx` and
`PaymentModal.tsx`: `product-card` (+`data-has-variants`), `variant-option`
(+`data-group`), `charge-button`, `payment-confirm`, and `table-tile`
(+`data-status`, +`data-name`). Prefer text/role selectors; add a testid only where
inline styles leave no stable handle.

## Commands

```bash
npm test                # all surfaces
npm run test:owner      # owner only
npm run test:pos        # POS specs
npm run test:manager    # manager only
npm run test:headed     # watch it drive the browser
npm run report          # open the HTML report
npm run seed:users      # (re)create test staff
```

## Notes

- `playwright/.auth/` and `.env` are gitignored (live tokens/secrets).
- POS specs **self-skip** until `seed:users` has populated the PINs.
- Each sale spec creates a **real paid order** in the test branch — expected; they
  accumulate. Use a dedicated test branch if you want isolation.
- Multi-branch businesses: `lib/pos-flow.ts` assumes a single branch that
  auto-resolves after PIN entry; a branch picker would need an extra click.
- Table occupancy is **local React state** (`openOrders`) — not server-backed, so
  it doesn't survive a reload or sync across devices.
