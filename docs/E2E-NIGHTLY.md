# Nightly end-to-end run against DEV (A536, closes A189)

`.github/workflows/nightly-e2e.yml` runs the end-to-end suites every night at **23:30 UTC (02:30 Nairobi)**
and on demand. It is a separate workflow: it never blocks a push or a pull request. The run goes red when a
suite fails — that is the signal to look.

## What runs

| step | what | notes |
|---|---|---|
| 1 | **Production guard** — `node e2e/lib/prod-guard.mjs --health` | refuses production addresses (exit 3), then waits up to 3 min for the dev API's `/health` (Render sleeps) and refuses unless it says `env: development` |
| 2 | **API suites** — `node tests/runner.mjs` | auth, data, orders, reports, security, permissions, restaurant (stress and petrol are not run nightly) |
| 3 | **Staff seed** — `node e2e/seed/seed-staff-api.mjs` | API only, idempotent: the Waiter role and the manager / supervisor / cashier / waiter test staff (same as `seed:users`) |
| 4 | **Playwright** — `npx playwright test` in `e2e/` | owner, POS, manager, public specs; the HTML report and failure traces are uploaded as the artifact `playwright-report-<run id>` (14 days) |

The run's summary page shows each part's result and the API suites' failures.

## Set once (repository Settings → Secrets and variables → Actions)

**Secrets** (never in a file):

| name | what |
|---|---|
| `E2E_OWNER_EMAIL` | the owner login of the **test business on DEV** |
| `E2E_OWNER_PASSWORD` | its password — never a production login |

**Variables:**

| name | what |
|---|---|
| `E2E_API_URL` | the dev API; default `https://swiftpos-20c2.onrender.com` |
| `E2E_WEB_URL` | the **dev** dashboard on Vercel. Until it is set, Playwright is skipped with a warning (the API suites still run) |
| `E2E_ADMIN_URL` | the dev admin portal — only guarded today (no admin specs yet) |
| `E2E_EXTRA_PROD_HOSTS` | optional, comma-separated: more hosts the guard must refuse (e.g. a new production domain) |

## One-time setup on DEV

1. On the dev dashboard, sign up (or have the ZapTill admin create) a **dedicated test business**, type
   *restaurant*, one branch — e.g. "E2E Test Co". Do not use a real client's business: the suites create
   products, staff, shifts and paid orders in it every night.
2. In the **dev** admin portal, for that business: web access on (else sign-in answers `WEB_HOSTING_REQUIRED`)
   and *Sign-in codes* **off** (the suites cannot read an e-mailed code).
3. Make sure the dev dashboard (`E2E_WEB_URL`) is built against the **dev** API. If it calls a production host the
   specs fail — the test browser cannot resolve production hosts (see below).
4. Set the two secrets and `E2E_WEB_URL` above. The staff seed then creates the test staff on the first run;
   later runs reuse them. Their PINs (1111 / 2222 / 3333 / 4444) are the dev test business's, the same as
   `e2e/seed/seed-users.setup.ts`; override with `E2E_MANAGER_PIN` etc. if needed.

## Run it by hand

- GitHub: Actions → **Nightly E2E (dev)** → *Run workflow*. Choose the API suites (empty skips them) and whether
  to run Playwright.
- Locally, against dev:

  ```bash
  export E2E_API_URL=https://swiftpos-20c2.onrender.com E2E_WEB_URL=<dev dashboard>
  export E2E_OWNER_EMAIL=<test owner> E2E_OWNER_PASSWORD=<password>   # your shell only, never a file in the repo
  node e2e/lib/prod-guard.mjs --health
  node tests/runner.mjs
  cd e2e && npm ci && npx playwright install chromium
  node seed/seed-staff-api.mjs          # writes the staff logins to e2e/.env (gitignored)
  OWNER_EMAIL=$E2E_OWNER_EMAIL OWNER_PASSWORD=$E2E_OWNER_PASSWORD npx playwright test
  ```

## The production guard

`e2e/lib/prod-guard.mjs` — one guard, called by every entry point: `tests/runner.mjs`, both Playwright configs,
the staff seed and the workflow's first step. There is **no override**.

- **Refused addresses:** `zaptill.co.ke` and every host under it — production (`api.`, `app.`, `admin.`) and every
  client's own address — unless the label next to the domain is a dev/staging marker (`dev.zaptill.co.ke`,
  `dev-api.zaptill.co.ke`, `app.dev.zaptill.co.ke`, `staging.zaptill.co.ke`); the production Render hosts
  (`swiftpos-server`, `swiftpos-prod-mype`) and Vercel hosts (`swiftpos-dashboard`, `swiftpos-admin`,
  `swiftpos-admin-eta`); anything in `E2E_EXTRA_PROD_HOSTS`; an address that does not parse.
- **The API's own answer:** production's `/health` hides `env`; the guard refuses a `/health` with no `env` or
  `env: production`.
- **Inside the test browser:** Chromium starts with `--host-resolver-rules` mapping every production host (and
  `*.zaptill.co.ke` except an allowed dev host) to "not found", so a dashboard built with a production API address
  cannot sell into a live business.

Exit code **3** = refused by the guard. Covered by `tests/e2e-prod-guard-a536.test.mjs` (runs in CI with the other
offline suites).

## Not reported to the admin System page

The System page's ops events accept only `deploy_check` and `vuln_scan` (apps/server/src/routes/ops.ts); an e2e
kind would need a server change, so the result lives in the GitHub run (summary + artifact) for now.
