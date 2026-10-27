# ZapTill on one VPS — migration plan (off Supabase, Render and Vercel)

Plan only, 2026-10-26, branch `shared-components`. No application code is changed by this document. Companion documents: `docs/OWN-AUTH-PLAN.md` (ZapTill's own sign-in, replacing Supabase Auth) and `docs/PLATFORM-MOVE-OVERVIEW.md` (the two-page version for the owner).

This plan moves the cloud API, the database, the web dashboard (with the web POS) and the admin portal onto one virtual server that ZapTill rents, in two steps that can be undone: first the dev environment (which is also where the shared-components branch gets tested), then production on a quiet night. The public website stays on Cloudflare Pages. Every hostname the tills, M-Pesa and the clients use today stays the same.

## 1. Why, goals and non-goals

**The owner's words (2026-10-26):** "25 USD per month is expensive, I'd rather get a VPS worth KES 2,500 or less and host everything there." "While we are doing the shared components work think of implementing auth on our own, it's a project also, we can do the two in one go; I can buy a VPS; we test this shared component from there for now; I don't like this pressure that Supabase is giving us."

**The numbers behind it:**

| Limit | Plan allowance | Used | What happens |
|---|---|---|---|
| Supabase egress (Free plan) | 5 GB a month | over 5 GB last cycle | Supabase warned of restriction from **20 Nov 2026** |
| Supabase log ingestion | 1 GB a month | near 1 GB | one log line per PostgREST request (A528) |
| Render included bandwidth (Hobby workspace) | 5 GB a month | production was suspended on 2026-10-19 at 6.29 GB (A528) | 5 GB of it was the server's own requests to Supabase |
| Supabase Pro (to lift the limits) | USD 25 a month + compute above Micro | — | the cost the owner does not want |

Most of that traffic is the API talking to its own database across the internet. On one server the API and Postgres talk over a local network, which costs nothing and is not metered.

**Goals**

1. One server at **≤ KES 2,500 a month**, everything included, sized for production and the dev environment side by side.
2. No metered egress between the API and the database; no log-ingestion quota.
3. ZapTill's own sign-in (see `docs/OWN-AUTH-PLAN.md`) so no third party holds the owners' accounts.
4. **No change for the people using ZapTill:** the same addresses (`api.`, `app.`, `admin.`, every client address `*.zaptill.co.ke`), the same passwords, no till update, no new M-Pesa registration.
5. Better backups than today: nightly (not weekly), encrypted, in the owner's own Cloudflare R2 bucket, plus the provider's server backups.
6. The shared-components branch is tested on the new dev environment first (the owner: "we test this shared component from there for now").

**Non-goals**

- No feature changes and no behaviour changes in the apps while moving (same rule as the shared-components branch).
- No rewrite of the API's ~1,600 database queries before the move (section 5 explains why PostgREST is kept).
- The website (`zaptill.co.ke`, `www.`) stays on Cloudflare Pages. Product photos stay on Cloudinary.
- No Kubernetes, no second server, no managed database. High availability (two servers) is out of scope; section 9 states what one server means for recovery time.
- No Android or desktop release is needed for the move.

## 2. Provider shortlist and recommendation

Prices checked on 2026-10-26 on the providers' own pages where they could be read (Hetzner, Contabo), otherwise from price trackers (marked). Conversion at about **KES 150 per euro** and **KES 129 per US dollar**; check on the day of ordering. The budget of KES 2,500 is about EUR 16.7 or USD 19.4.

| Provider and plan | vCPU / RAM / disk | Traffic | Price a month | Region and latency to Nairobi | Backups / snapshots | Notes |
|---|---|---|---|---|---|---|
| **Hetzner Cloud CX33** (cost-optimised, x86) | 4 / 8 GB / 80 GB NVMe | 20 TB, then EUR 1 per TB | **EUR 8.99** incl. IPv4 (≈ KES 1,350) | Nuremberg, Falkenstein or Helsinki; about 150–190 ms round trip | daily server backups, 7 kept: +20% (≈ EUR 1.80); snapshots EUR 0.0143 per GB | Shown "currently unavailable" on 2026-10-26 (stock comes and goes). Best tooling (firewall, API, console, rescue), good support, clear billing. |
| Hetzner Cloud CAX21 (Arm) | 4 / 8 GB / 80 GB | 20 TB | EUR 10.99 (≈ KES 1,650) | Nuremberg / Falkenstein / Helsinki | as above | Same as CX33 on Arm. Every image this plan uses exists for Arm (postgres, postgrest, caddy, node 24); `bcrypt` builds on Arm. Also shown unavailable that day. |
| Hetzner Cloud CPX32 (regular performance) | 4 / 8 GB / 160 GB | 20 TB | EUR 35.99 | Nuremberg / Helsinki | as above | Over budget. Listed for comparison only. |
| **Contabo Cloud VPS 6** | 6 / 12 GB / 100 GB NVMe | "unlimited" (fair use), 300 Mbit/s port | EUR 7.50 monthly, EUR 6.00 on a 24-month term (≈ KES 900–1,125) | EU (Germany), UK; similar latency | 2 snapshots included; Auto Backup is a paid add-on | Most RAM for the money. Shared CPUs are known to be oversold; slower support; the monthly term may carry a setup fee. |
| Contabo Cloud VPS 4 | 4 / 8 GB / 100 GB SSD | fair use, 200 Mbit/s | EUR 5.50 (EUR 4.40 on 24 months) | as above | 1 snapshot | Cheapest 4 / 8 GB found. |
| OVHcloud VPS-2 (2026 range, tracker) | 6 / 12 GB / 100 GB | unmetered | about EUR 10–12 after the 2026 price rise | France, Germany, UK | paid daily backup option | Reliable, but prices rose 40–67% in 2026 and the plan names changed; check on the day. |
| Truehost Kenya, Cloud Business (Truehost's own 2026 article) | 4 / 8 GB / 200 GB | not stated | **KES 4,480** on a 3-year term | Nairobi data centre: 5–20 ms | not stated | Over budget for 4 / 8 GB. Kenya-hosted plans start at KES 1,400 for 1 vCPU / 1 GB. |
| HostAfrica (took over Sasahost, Dec 2023), Kenya C4 (tracker) | 2 / 4 GB | fair use | about KES 3,200 | Kenya | not stated | Over budget and half the minimum spec. Sasahost's own VPS plans are discontinued. |
| Lineserve, Nairobi (tracker) | 4 / 8 GB | — | about KES 8,330 | Nairobi | — | Far over budget. |

**Latency in practice.** ZapTill's tills sell offline and sync in the background, and the dashboards load once and then call the API. 150–190 ms to Europe is what the cloud has today if Render and Supabase run in a European region (check: Render › service › Settings › Region; Supabase › Project Settings › General › Region). Being in the same data centre as the database matters far more than the distance to Nairobi: today every API request makes several round trips to Supabase across the internet; on the VPS those take under a millisecond. Kenyan hosts would cut 150 ms off each request but cost two to three times the budget for half the machine, with weaker snapshot and firewall tooling.

**Recommendation: Hetzner Cloud CX33 in Nuremberg or Falkenstein, with Hetzner backups turned on** — about EUR 10.79 a month (≈ KES 1,620), and up to 16% more (≈ KES 1,880) if VAT on imported digital services is charged. If CX33 is out of stock on the day, take **CAX21** (Arm, EUR 10.99 + backups ≈ KES 1,980) or try Helsinki. Second choice if Hetzner refuses the account (it sometimes asks for ID for a new customer): **Contabo Cloud VPS 6** on a 12-month term.

**Minimum spec and why: 4 vCPU, 8 GB RAM, 80 GB NVMe, one IPv4.** The memory budget on one server for production and dev together:

| Service | RAM (planned limit) |
|---|---:|
| Postgres, production (`shared_buffers` 1.5 GB) | 2.5 GB |
| Postgres, dev | 0.75 GB |
| ZapTill API, production (Node 24, one process — the push channel needs one instance, `WEB_CONCURRENCY=1`) | 0.6 GB |
| ZapTill API, dev | 0.4 GB |
| PostgREST × 2 | 0.15 GB |
| Caddy (HTTPS, static files) | 0.1 GB |
| Ubuntu, Docker, the backup run (pg_dump + gpg) | 0.8 GB |
| **Total** | **≈ 5.3 GB of 8 GB** |

The rest is headroom for growth and for the page cache. 4 vCPUs let a backup, a report export and the morning rush run together. Builds run on GitHub Actions, never on the server. The database is small (the backup guide's example: 48 MB compressed), so 80 GB of disk holds the databases, 14 days of local dumps, logs and Docker images with room to spare.

## 3. Target architecture on one server

Ubuntu 24.04 LTS, Docker Engine with the Compose plugin. Everything runs as containers from one `docker-compose.yml` kept in the repository (`deploy/vps/`, to be written in week 0), with secrets outside the repository.

| Container | Image | Listens on | Purpose |
|---|---|---|---|
| `caddy` | `caddy:2` built with the `caddy-dns/cloudflare` module (a two-line Dockerfile, `xcaddy build --with github.com/caddy-dns/cloudflare`) | **80, 443 — the only published ports** | HTTPS for every hostname (Let's Encrypt), wildcard certificates by DNS-01 through Cloudflare, the static dashboard and admin portal, reverse proxy to the APIs, maintenance page |
| `pg-prod` | `postgres:17` (see below) | internal network only | production database (own volume) |
| `pg-dev` | `postgres:17` | internal network only | dev database (own volume; a dev mistake cannot touch production) |
| `rest-prod`, `rest-dev` | `postgrest/postgrest` pinned to the major Supabase runs (check Supabase › Settings › API; v12 or v13) | internal only | the same REST layer the API uses today (section 5) |
| `api-prod`, `api-dev` | `ghcr.io/<owner>/zaptill-api:<git sha>` built by GitHub Actions from the repository root | internal only (port 4000) | `apps/server`, unchanged |
| (fallback only) `gotrue-prod` | `supabase/auth`, pinned | internal only | only if own auth is not ready by the cut-over (section 10) |

**Postgres version.** The repository does not pin Supabase's version: `00_baseline.sql` was checked against a local PostgreSQL 16, and the A589 backup workflow says "Supabase: PostgreSQL 15 or 17" and installs the 17 client. Supabase › Project Settings › Infrastructure shows the real one. Use **Postgres 17** on the VPS either way: a dump from 15 or 17 restores into 17. If production is on 15, the move is also the upgrade, rehearsed on dev first.

**Hostnames** (Cloudflare DNS, records "DNS only" — grey cloud — at first; see the M-Pesa note in section 8):

| Hostname | Today | On the VPS |
|---|---|---|
| `api.zaptill.co.ke` | Render (production API) | Caddy → `api-prod` |
| `app.zaptill.co.ke` | Vercel (dashboard + web POS) | Caddy, static files of `apps/dashboard` (SPA fallback to `index.html`) |
| `admin.zaptill.co.ke` | Vercel (admin portal) | Caddy, static files of `apps/admin` |
| `*.zaptill.co.ke` (client addresses, A378) | Vercel | Caddy, the dashboard's files (one wildcard certificate) |
| `zaptill.co.ke`, `www.` | Cloudflare Pages (website) | unchanged — explicit records win over the wildcard |
| `dev-api.zaptill.co.ke` | — (dev API is `swiftpos-20c2.onrender.com`) | Caddy → `api-dev` |
| `app.dev.zaptill.co.ke`, `admin.dev.zaptill.co.ke`, `*.dev.zaptill.co.ke` | Vercel dev projects | Caddy, dev builds; second wildcard certificate; dev `TENANT_ROOT_DOMAIN=dev.zaptill.co.ke` |

The dev names follow the end-to-end guard's rule (`docs/E2E-NIGHTLY.md`: a host is allowed when the label next to the domain is `dev`), and `dev` is already a reserved client address in `shared/tenantHost.ts`, so no client can take it.

The static sites get the same headers as `vercel.json` today (`X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`, one-year immutable cache on `/assets/*`).

**This also settles the shared-components hosting change.** `docs/SHARED-COMPONENTS-PLAN.md` section 4 needs Render's root directory changed because Render cannot see `packages/core` from `apps/server`. The VPS image is built from the repository root, so `packages/core` is simply there; on the VPS that blocker disappears.

**File storage (replacing Supabase Storage).** Only one bucket is used: `business-assets`, for the logo uploaded on the legacy onboarding page (`apps/dashboard/src/pages/OnboardingPage.tsx`; the receipt and branding logos are already in the database, product photos on Cloudinary). Plan: copy the bucket's files to the server's disk (`/srv/zaptill/files/business-assets/`), serve them read-only through Caddy at `https://api.zaptill.co.ke/files/business-assets/…`, rewrite the stored URLs with one `UPDATE` (the Supabase public-URL prefix `/storage/v1/object/public/business-assets/` to the new prefix), and include the folder in the nightly backup to R2. New uploads go through the API (see `docs/OWN-AUTH-PLAN.md` § dashboard changes). R2-only storage is the alternative if files ever grow large; today they do not.

**Scheduled jobs.** The API's own jobs (`node-cron`: daily summary, low stock, watchdog, owner alerts, cloud-plan reminders, monthly pack, eTIMS retry) run inside `api-prod` exactly as on Render. Host jobs are systemd timers: the nightly backup, the restore check, the health check, certificate and disk checks (section 7).

**Logs.** Docker's `json-file` driver with `max-size: 10m`, `max-file: 5` per container (≈ 50 MB cap each); journald capped at 500 MB (`SystemMaxUse=500M`). PostgREST at `log-level: warn`. No log-ingestion quota exists any more. The admin portal keeps reading the API's own ops events and log requests as today.

**Monitoring.**

- The A589 outside check (`uptime-check.yml`, every 10 minutes, `PROD_URL` and `APP_URL`) keeps working unchanged because the hostnames do not change.
- The API's watchdog (A383) keeps telling the admin about tills not syncing, M-Pesa without an answer, error bursts.
- New: `zaptill-health` (systemd timer, every 5 minutes) checks disk use above 80%, memory, every container healthy, the newest backup younger than 26 hours, certificates more than 14 days from expiry, and sends problems through the same alert script the backups use (`scripts/ops/notify-admin.sh` on dev: email and Telegram).
- Hetzner's console graphs (CPU, disk, network) for the weekly look. A metrics stack (node exporter, Prometheus, Grafana) is not worth its memory at this size; reconsider when there is a second server.

**Hardening.**

- SSH: keys only (`PasswordAuthentication no`), `PermitRootLogin no`, one sudo user for the owner and one for ZapTill's technician; a separate `deploy` user whose key may run only the deploy command (a forced command in `authorized_keys`).
- Firewall twice: the Hetzner Cloud Firewall (free, in front of the server) and `ufw` on the server, both allowing only 22, 80 and 443. **Docker bypasses `ufw` for published ports**, so no container except Caddy publishes a port; Postgres and PostgREST are reachable only on the internal Docker network.
- `fail2ban` for SSH; `unattended-upgrades` for security updates, with any needed reboot at 04:30 on Sunday (the quietest hour).
- Time sync (`systemd-timesyncd`), 2 GB swap file, `vm.swappiness=10`.
- Postgres: no port on the host, `scram-sha-256` passwords, a separate login role per service.

**Secrets.** One file per environment, `/etc/zaptill/prod.env` and `/etc/zaptill/dev.env`, owned by root, mode 600, read by Compose (`env_file`). Never in git, never in an image, never printed by a script. A copy lives in the owner's password manager. The values that **must be carried over unchanged** from Render, or every till and browser has to sign in again or encrypted settings stop opening: `JWT_SECRET`, `ADMIN_JWT_SECRET`, `TECH_SIGNING_PRIVATE_KEY`, `TECH_SIGNING_PUBLIC_KEY`, `APP_ENCRYPTION_KEY`, `OTP_PEPPER` (if set; it falls back to `JWT_SECRET`), `OPS_INGEST_TOKEN`, the M-Pesa, mail (`RESEND_API_KEY`, `NOTIFY_FROM_EMAIL`), Telegram, GitHub-releases and eTIMS values. Changed: `SUPABASE_URL` (now the internal REST gateway), `SUPABASE_SERVICE_ROLE_KEY` (a token we sign for PostgREST's `service_role`), `SUPABASE_ANON_KEY` and `SUPABASE_JWT_SECRET` (gone after own auth). New: `RENDER_GIT_COMMIT` is set from the image's build so `/health` and `verify-prod-deploy.yml` keep reporting the commit with no code change (renaming it is a later tidy-up).

**Deploys.** A new workflow builds the API image (repository root as the build context) and the two static sites, pushes the image to GitHub's container registry and the static files over SSH, then runs the deploy command on the server (`docker compose pull && up -d`, a health wait, and automatic return to the previous image if `/health` fails). Pushes to `dev` (and, during the test period, to `shared-components`) deploy the dev environment; `main` deploys production behind the existing `production` environment's required reviewer. Images carry no secrets (the repository is public).

**Migrations.** `db-migrate-prod.yml` keeps its reviewer gate, but instead of connecting to the Supabase pooler from GitHub (which would need Postgres open to the internet), it runs `scripts/migrate.mjs --plan`, `migrate.mjs` and `verify-db-schema.mjs` **on the server** over the deploy SSH key. Postgres stays closed to the internet.

**Other workflows.** `supabase-keepalive.yml` is retired after the cut-over. `nightly-backup.yml` (GitHub) is replaced by the server's own nightly timer and kept for manual runs. `nightly-e2e.yml` points `E2E_API_URL` at `https://dev-api.zaptill.co.ke`. `uptime-check.yml`, `release.yml`, `security-scan.yml` and `ci.yml` are unchanged.

## 4. Two options: self-hosted Supabase, or plain Postgres with ZapTill's own sign-in

**(A) Self-host the Supabase stack** (Supabase's `docker-compose`: Postgres, Kong, GoTrue, PostgREST, Realtime, Storage, imgproxy, postgres-meta, Studio, Logflare analytics, Vector).

- Fewest code changes: the server and the dashboard keep using `supabase-js` against a new URL, and Realtime and Storage keep working.
- Memory: Supabase documents the self-hosted stack at 4 GB minimum and 8 GB recommended — for **one** environment. Production and dev would need about 12–16 GB. Analytics alone (Logflare + Vector) wants about 1 GB.
- About 12 containers per environment to patch, each a moving part with its own upgrade notes, and Kong and Studio exposed or carefully firewalled.
- The owners' accounts stay in GoTrue, which the owner wants to move away from.

**(B) Plain Postgres + PostgREST + ZapTill's own sign-in** (the owner's preference).

- Four small services per environment (Postgres, PostgREST, the API; Caddy shared): about 5.3 GB for both environments.
- What B removes: GoTrue (Supabase Auth), Kong, Realtime, Storage, Studio, analytics, `supabase-keepalive.yml`, the anon key in the dashboard, and the dashboard's direct connection to the database (today the browser holds an anon key and a Supabase session that can query PostgREST directly; on B, PostgREST is not reachable from the internet at all).
- What B keeps: PostgREST, internally, so the server's queries do not change (section 5).

**Recommendation: B.** It fits the budget with room to spare, it is what the owner asked for, and it is also the smaller attack surface. The cost is the own-auth project (`docs/OWN-AUTH-PLAN.md`), which is mostly a credential store: ZapTill already issues its own tokens.

### The code inventory (counted in the worktree on 2026-10-26)

**Server (`apps/server/src`, 60,915 lines):**

| What | Count | Where |
|---|---:|---|
| `.from('<table>')` — PostgREST table calls | **1,614** | 140 files |
| `.rpc(...)` — Postgres functions | **47** calls to **17** functions | `adjust_product_stock` (9), `adjust_ingredient_stock` (9), `apply_credit_transaction` (6), `increment_customer_spend` (3), the sync functions (`sync_changes_since`, `sync_changes_heads`, `sync_changes_heads_by_branch`, `prune_sync_changes`, `sync_stock_ready`), `create_order_atomic`, and others |
| Operations | select 1,326 · insert 223 · update 288 · upsert 34 · delete 126 | |
| Selects that embed related tables (PostgREST resource embedding, e.g. `roles ( id, name, role_permissions ( permissions ( key ) ) )`) | **≈ 92** | sign-in, staff, reports, sync |
| `count: 'exact'` | 43 | lists and pagers |
| Filters | `.eq` 2,135 · `.in` 208 · `.order` 197 · `.limit` 148 · `.gte` 91 · `.is` 75 · `.lte` 64 · `.not` 28 · `.ilike` 24 · `.neq` 19 · `.range` 18 · `.or` 17 (PostgREST filter strings) · `.gt` 12 · `.lt` 9; `.maybeSingle` 360, `.single` 282 | |
| Supabase Auth calls | **23** real call sites in 11 files: `auth.admin.getUserById` 12, `auth.admin.updateUserById` 4, `auth.admin.createUser` 2, `auth.signInWithPassword` 2, `auth.admin.generateLink` 1, `auth.admin.inviteUserByEmail` 1, `auth.getUser` 1 | `routes/auth.ts`, `lib/passwordReset.ts`, `routes/staff.ts`, `routes/admin.ts`, `routes/onboarding.ts`, `lib/ownerBusiness.ts`, five jobs |
| Storage / Realtime | 0 / 0 (the client is created with a `ws` transport, never used) | |

**Web dashboard and web POS (`apps/dashboard/src`):** 7 files import Supabase — Auth: `getSession` 2, `signInWithPassword` 2, `signOut` 2, `onAuthStateChange` 1, `signUp` 1; Storage: 1 upload + 1 public URL (`business-assets`); Realtime: 1 channel (`OverviewPage.tsx`, new completed orders for the live counters; a 60-second polling fallback already exists). No table queries.

**Admin portal (`apps/admin/src`):** none (two mentions are in a comment). **Desktop POS (`apps/desktop/src`):** none — the tills talk only to the ZapTill API.

### The data layer: keep PostgREST, in phases

Replacing PostgREST means re-implementing, for 1,614 calls, the filters, the 92 embedded selects (which need foreign-key-aware JSON sub-queries), the 17 `.or()` filter strings, `upsert` with `onConflict`, `count: 'exact'`, the `{ data, error }` shape, and the error codes the code checks for (`PGRST116` for "no row", `23505`, `23503`). Two ways:

- A compatible query builder over `node-postgres` (`pg`) with the same method names: about 2–3 weeks to write and prove, plus a slow review of every embedded select. Any difference in behaviour shows up as a wrong number on a till.
- Rewriting the calls as SQL: months of work across the whole server, touching every route the shared-components branch also touches.

PostgREST itself costs about 50–80 MB of memory, is stable, and on the VPS runs next to Postgres, so the "egress" it caused is gone. Therefore:

1. **Phase 1 — Postgres + PostgREST on the VPS, minimal code change.** The server keeps `supabase-js` for data: `SUPABASE_URL` points at the internal gateway (`http://rest-prod-gw/` — a Caddy route that strips `/rest/v1` and forwards to `rest-prod:3000`), and `SUPABASE_SERVICE_ROLE_KEY` is a long-lived token we sign with PostgREST's secret for the `service_role` role. PostgREST settings matched to Supabase's: `db-schemas=public`, `db-anon-role=anon`, `db-max-rows=1000` (the server's `pgQuery.ts` pages around Supabase's row cap; keep it the same), `db-pool=15`. The URL-length chunking in `pgQuery.ts` stays (it is right for any proxy).
2. **Phase 2 — ZapTill's own sign-in** (`docs/OWN-AUTH-PLAN.md`): the 23 server Auth calls and the dashboard's Supabase usage are replaced. After this no part of ZapTill talks to Supabase.
3. **Phase 3 (optional, later) — replace PostgREST** only where it pays: hot paths that need a real transaction across tables (most already are `rpc` functions). There is no deadline for phase 3, and possibly no need for it.

## 5. Row-level security

**What exists.** 149 `CREATE POLICY` statements in 20 migration files (94 in `00_baseline.sql`, more created in loops by `29_enable_rls_all_tables.sql`); RLS is enabled on every table (162 `ENABLE ROW LEVEL SECURITY` statements). **Every tenant policy uses `auth.uid()`** — 165 references in 19 files — and all have one shape: `business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())` (or the parent-table version, or `owner_id = auth.uid()` on `businesses`). There are **no** `auth.jwt()` or `auth.role()` uses. Grants: 22 to `authenticated`, 38 to `service_role`. Platform tables (sessions, tokens, admin, secrets) have RLS on and no policy at all: only the service role reaches them.

**What they protect today.** The API uses the service role, which bypasses RLS, so tenant isolation for every till, cashier, manager, partner and owner request is enforced **in the API** (`requireAuth`, `rbac.ts`, `branchScope`, `businessId` on every query, checked by `scripts/check-insert-business-id.mjs`, `check-own-rows.mjs`, `check-rls-coverage.mjs`). RLS matters only for the browser's direct Supabase session: the owner's live counters (Realtime) and the onboarding logo upload. A partner's Supabase session matches no policy (they are not `owner_id`), so the live counters already never worked for partners — an argument for moving them to the API anyway.

**On the VPS.**

- Before the restore, the database gets the pieces the policies reference: the roles `anon`, `authenticated` (both `NOLOGIN`), `service_role` (`NOLOGIN BYPASSRLS`), `authenticator` (`LOGIN NOINHERIT`, granted the three — PostgREST connects as it); schema `auth` with a compatible `auth.uid()`: `coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid` — the same definition Supabase uses, which reads the claims PostgREST sets from a verified token. With that, all 149 policies restore and behave as today.
- With own auth (phase 2), browsers no longer touch the database and PostgREST is not reachable from the internet. RLS stays switched on as **defence in depth**: if a future change ever lets a request reach PostgREST without the service key, it sees nothing of other businesses.
- Optional phase 4 (not part of this move): let the API query with a non-bypass role and per-request claims (`business_id`, `branch_ids`), with a helper `auth.business_id()` and policies rewritten from "owner of the business" to "the token's business". That turns RLS into a second, independent tenant check for staff and tills as well. It touches every policy and every server query's key, so it is its own project, started with the most sensitive tables (payments, customers, credit).

## 6. Data migration

All dumps are made **by the owner** (or a technician he names) from his own machine or the VPS; nobody else connects to Supabase. The scripts are written in week 0 and tried on dev first.

**What moves, and how**

| Data | How | Notes |
|---|---|---|
| `public` schema (every table, function, trigger, policy, sequence) | `pg_dump --format=custom --schema=public --no-owner --no-privileges` with the Postgres 17 client, then `pg_restore` into the prepared database | Sequences restore with their current values (`setval` is part of the dump). Grants are re-applied by a script (the 60 known grants), not copied from Supabase's role set. |
| Extensions | created before the restore: schema `extensions` with `uuid-ossp` (63 schema references to `extensions.uuid_generate_v4`, 15 more to `uuid_generate_v4`) and `pgcrypto` (Supabase's default). `gen_random_uuid()` (70 uses) is built in. | No `pg_cron` (one comment only), no `pg_net`, no Vault, no `pg_trgm`/`citext` in the migrations. Supabase's own extensions (`pg_graphql`, `pg_stat_statements`, `supabase_vault`) are not copied. |
| Realtime publication | not needed | `95_kitchen_tickets_realtime.sql` already checks `IF EXISTS … supabase_realtime`, so re-running migrations is safe. |
| Sign-in accounts (`auth.users`) | a separate export of only the needed columns: `id, email, encrypted_password, email_confirmed_at, created_at, updated_at, last_sign_in_at, banned_until, deleted_at, raw_app_meta_data` → loaded into ZapTill's own `accounts` table (ids kept) | Details and the password-hash check: `docs/OWN-AUTH-PLAN.md` § 4. The file holds password hashes: treat it as a secret, copy it only over SSH, delete it after loading. |
| References to `auth.users` | three foreign keys in the baseline (`businesses.owner_id`, `orders.voided_by` — repointed to `users` by migration 96 — and `stock_movements.created_by`) | Restore order: a stub `auth.users (id uuid primary key)` filled with the exported ids first, so the dump's foreign keys restore; then a VPS-only migration repoints them to `accounts(id)` and drops the stub. |
| `auth.sessions`, `auth.refresh_tokens`, `auth.identities`, MFA tables | not moved | ZapTill's own sessions are in `public.refresh_tokens` (migration 13) and move with `public`; ZapTill's second step (A391) is its own (`login_otp…` tables). A browser's Supabase session ends at the cut-over and is not needed any more. |
| Storage objects (`business-assets`) | download with the Supabase CLI or the S3-compatible endpoint, copy to `/srv/zaptill/files/`, rewrite URLs | First count them: `select count(*) from storage.objects where bucket_id = 'business-assets';` |
| `schema_migrations` / `schema_migration_runs` | in `public`, they move | `scripts/migrate.mjs` sees the VPS database as up to date. |

**Checks after every restore (dev rehearsal and production):** `node scripts/verify-db-schema.mjs` against the VPS database; row counts of every table compared with the source (a script prints both sides); the newest `orders.created_at`, `sync_changes` head and the highest sequence values compared; one test sign-in, one till sync, one report.

**Egress note.** Each full dump reads the whole database out of Supabase once. The dev dump, the production rehearsal and the final production dump are three dumps: well inside even a nearly used egress budget for a database of this size, but check the size first (`select pg_size_pretty(pg_database_size(current_database()));`).

## 7. Cut-over

**Stage 1 — dev on the VPS (weeks 0–2).**

1. Build the server: hardening, Docker, Caddy with both wildcard certificates, `pg-dev`, `rest-dev`, `api-dev`.
2. Restore the **dev** Supabase database into `pg-dev`; load the dev accounts.
3. Deploy `api-dev` from the `shared-components` branch; the dev dashboard and admin portal to `app.dev.` / `admin.dev.`. Dev runs **with Supabase Auth still in use for passwords** (`AUTH_PROVIDER=supabase`, the dev project's Auth over the internet — tiny traffic) until own auth is built, then switches to `AUTH_PROVIDER=zaptill` (`docs/OWN-AUTH-PLAN.md` § 7).
4. Point the test till (T1) at `https://dev-api.zaptill.co.ke` (Tech page › server address) and the dev M-Pesa sandbox callback at the new dev address.
5. Run CI's full step set and the nightly end-to-end run against the VPS dev (`E2E_API_URL`).
6. A week of real use (week 2) by the owner and the technician: sales on T1, the web POS, the dashboard, a partner sign-in, a password reset, a day close, a backup and a restore drill.

**Stage 2 — production rehearsal (week 2, Tuesday).** Dump production, restore it into a scratch database on the VPS, time every step, run the checks in section 6, and throw the copy away. The time measured sets the freeze window (expected well under 30 minutes for a database of this size).

**Stage 3 — production cut-over (one quiet night, 02:00–03:00 EAT, Sunday into Monday).**

1. **The day before:** lower the TTL of `api.`, `app.`, `admin.` and `*.` to 60 seconds in Cloudflare; announce a 30-minute maintenance window to clients that trade at night (restaurants, petrol stations); confirm no till is configured with an old Render address (see below); production secrets placed in `/etc/zaptill/prod.env`.
2. **Freeze writes.** Render's production service is switched to answer `503` with `Retry-After` for everything except `/health` (an environment switch or a one-line maintenance service; decided in week 0). Tills keep selling offline: every till write is an idempotent upsert by id and the till retries any 5xx (`routes/sync.ts`; A581 chose 503 for exactly this — "so every till version keeps the record queued"). **The web POS cannot sell during the window** (it needs the cloud), and **M-Pesa callbacks that arrive during the window are not processed** — so the window is short, at night, and the watchdog's "M-Pesa with no answer" list is checked afterwards.
3. Final dump of production, restore into `pg-prod`, load accounts, run the checks.
4. Start `api-prod` with the carried-over secrets; test it directly on the VPS (Caddy route by IP with the right Host header): `/health`, an owner sign-in, a till token renewal, a till push.
5. **Switch DNS:** `api.`, `app.`, `admin.` and `*.` to the VPS IPv4 (and IPv6). With a 60-second TTL most clients move within minutes.
6. Verify: the A589 outside check is green, a till on each live client syncs its queued sales (watch `sync_changes` and the watchdog), an STK push completes on a real phone, an owner and a partner sign in, the admin portal opens, a report exports, an email arrives.
7. Leave Render's production service in maintenance mode (answering 503) for 72 hours, so a stale DNS cache can only queue, never write to the old database.

**M-Pesa.** The callback address is built from `MPESA_CALLBACK_BASE_URL` (`https://api.zaptill.co.ke`); the hostname does not change, so nothing is re-registered with Safaricom. Callbacks are inbound: Safaricom calls our address, so our new IP does not need whitelisting with them. Our own allowlist of Safaricom's callback addresses (`MPESA_ALLOWED_IPS`, default list in `routes/mpesa.ts`) depends on seeing the caller's real IP: Express trusts one proxy hop in production (`app.set('trust proxy', 1)`), and Caddy is exactly one hop, so `api.zaptill.co.ke` must stay **"DNS only" in Cloudflare** (not proxied — a proxied record adds a second hop and every callback would look like Cloudflare). Before the cut-over, check whether any client's C2B registration or any Daraja product uses an `onrender.com` address or an IP whitelist (B2C); those need updating with Safaricom.

**The desktop POS needs no update** as long as it uses `https://api.zaptill.co.ke`. Its cloud address is saved at install time (the installer suggests `https://api.zaptill.co.ke`, `apps/desktop/src/renderer/pages/InstallPage.tsx`); there is no certificate pinning for the cloud — the pinning in `apps/desktop/src/main/lanTls.ts` (A489) and the branch-server hardening (A496) are for the shop network only, so a new Let's Encrypt certificate is accepted like any other. **Check before the cut-over:** any till installed before A385 (2026-10-03) may still have `swiftpos-server.onrender.com` saved. Those must be re-pointed on their Tech page before Render is switched off (or the Render service kept as a forwarding proxy until they are). The same check for the web dashboard builds: Vercel's `VITE_API_URL` today, the VPS build's value tomorrow.

**Rollback.**

- **Before step 5 (DNS):** nothing has changed for anyone — take Render out of maintenance mode. Supabase is untouched.
- **After the switch, within 72 hours:** the VPS is now the source of truth, and Supabase is missing what was written since. Rollback = freeze the VPS (503), dump `public` from the VPS, restore it into Supabase over the old schema (`pg_restore --clean --schema=public`; writing into Supabase is ingress, not egress), switch DNS back, take Render out of maintenance mode. Rehearsed once on dev in week 2. Accounts created on the VPS in between are added back to Supabase Auth by a script, or reset by email code.
- **After 72 hours:** no rollback to Supabase; problems are fixed forward. Supabase and Render stay paid-off-but-intact for 30 days (a Free project only pauses), then are deleted.

## 8. Backups on the VPS

The A589 design stays (dump, check with `pg_restore --list`, encrypt with the owner's passphrase, decrypt-and-compare, upload to his R2 bucket, 30 daily and 12 monthly copies, a status file and an ops event for the admin portal, an alert on failure). What changes:

- **Nightly at 00:00 EAT, from the server itself** (systemd timer running `scripts/backup/nightly-backup.sh` with the dump taken from `pg-prod` over the internal network). A dump inside the server costs nothing; upload to R2 is free; R2 includes 10 GB a month of storage free and charges nothing to download. The A591 reason for weekly backups (Supabase egress) no longer exists.
- The files folder (`/srv/zaptill/files`) is backed up with it.
- **Hetzner backups** of the whole server: daily, 7 kept (+20% of the server price). A second, independent copy, good for "the server is broken", not a replacement for the encrypted dumps (they live in the same Hetzner account).
- A **weekly snapshot** before any upgrade of Docker images or Postgres (EUR 0.0143 per GB a month; deleted after a week).
- **Restore drill, monthly:** the newest R2 dump restored into a scratch database on `pg-dev`, `verify-db-schema.mjs` and row counts, result recorded on the admin portal's System page.
- Later, if wanted: continuous WAL archiving to R2 with WAL-G, which brings the recovery point from 24 hours to about 5 minutes for ~50 MB of extra memory.

| | Target |
|---|---|
| **RPO** (data that can be lost) | up to 24 hours from the cloud backup alone (the newest Hetzner backup is also at most 24 hours old). Sales made on tills since then are still on the tills, but a till does not resend what the cloud already acknowledged — so 24 hours is the honest figure until WAL archiving is added (then ~5 minutes). |
| **RTO** (time to be back) | about 30 minutes from a Hetzner backup onto a new server; about 2–3 hours from an R2 dump onto a brand-new server with the runbook (`deploy/vps/RUNBOOK`, written in week 1). During that time tills keep selling offline and queue. |

## 9. Costs, and what the owner takes on

**Monthly cost, before and after** (USD 1 ≈ KES 129; check the current Render plan and the dev service's plan in the Render dashboard).

| Item | Today | To stay where we are (needed now) | On the VPS |
|---|---|---|---|
| API hosting | Render Starter, production: USD 7; dev service: USD 0–7 | the same, plus bandwidth overage at USD 0.15 per GB above 5 GB | included |
| Database + sign-in | Supabase Free: USD 0 (restricted from 20 Nov) | Supabase Pro USD 25 + compute above Micro (USD 0–35) | included |
| Dashboard + admin portal | Vercel Hobby: USD 0 (Hobby is for non-commercial use; a commercial product should be on Pro, USD 20 per member) | Vercel Pro USD 20 | included |
| Server | — | — | Hetzner CX33 EUR 8.99 + backups EUR 1.80 ≈ **KES 1,620** (≈ KES 1,880 with 16% VAT) |
| Backups | R2 (free tier) | R2 (free tier) | R2 (free tier, nightly) |
| DNS, website | Cloudflare free, Pages free | the same | the same |
| Domain `zaptill.co.ke` | yearly, unchanged | unchanged | unchanged |
| **Total a month** | **≈ KES 900–1,800** (but production was suspended once and Supabase is about to restrict) | **≈ KES 6,700–12,100** | **≈ KES 1,620–1,880** |

**What the owner (or a technician he names) takes on.** Render, Vercel and Supabase did these for us; on a VPS somebody does them:

- Security updates (automatic, with the Sunday 04:30 reboot) and checking that they ran.
- Docker image updates once a month (Postgres minor releases, PostgREST, Caddy, Node), after a snapshot.
- Disk, memory and backup alerts (sent automatically; somebody must read them).
- Renewing nothing by hand: Caddy renews certificates; the Cloudflare token must stay valid.
- A yearly Postgres major upgrade (rehearsed on dev).

**Weekly 15-minute checklist (Monday morning)**

- [ ] Admin portal › System: last backup OK and less than a day old; no open "Production down" issue on GitHub.
- [ ] Hetzner console: CPU and disk graphs normal; Hetzner backups listed for the last 7 days.
- [ ] On the server: `zaptill status` (to be written: containers healthy, disk %, memory, certificate expiry dates, pending security updates, last reboot).
- [ ] Any alert email or Telegram message from the week has an answer.
- [ ] First Monday of the month: the restore drill result is green; pull and roll out image updates on dev, then production a day later.

## 10. Timeline, checkpoints and risks

Combined with the shared-components branch: the branch's step 2 (pure logic into `packages/core`) continues in parallel and is deployed to the VPS dev environment, which becomes its test bed (the Render root-directory change in `docs/SHARED-COMPONENTS-PLAN.md` § 4 is then only needed if the branch reaches Render's dev before the move).

**The date that matters: Supabase threatens restriction from 20 November 2026 — 25 days from today.** The plan reaches production on the night of **Sunday 15 → Monday 16 November**, five days ahead of it, with two fallbacks. That is tight: the dev period of use is about one week instead of two, which is why the GoTrue fallback below exists.

| Week | Work | Checkpoint (go / no-go) |
|---|---|---|
| 0 (Mon 26 Oct – Sun 1 Nov) | Owner: orders the server, makes the Cloudflare API token, answers the decisions in section 11. Hardening, Docker, Caddy with both wildcards; `deploy/vps/` compose and scripts. Own auth: tables and import script (`docs/OWN-AUTH-PLAN.md` § 7, steps 1–2). | Server reachable by SSH key only; an outside port scan shows only 22, 80, 443. |
| 1 (2 – 8 Nov) | Dev database restored; `api-dev` from `shared-components`; dev dashboards on `app.dev.`/`admin.dev.`; T1 on dev. Own auth server side behind the flag, dashboard without `supabase-js`, partner links, admin flows, tests; `AUTH_PROVIDER=zaptill` on dev by Friday. Backups, health timer, deploy workflow, migrations over SSH. GoTrue fallback tried on dev once. | CI full step set green against VPS dev; restore checks equal; every auth test green; a password reset, a partner invite and a forced change done by hand; a backup restored. |
| 2 (9 – 15 Nov) | Use of dev on the VPS by the owner and the technician all week. Production rehearsal (dump → scratch restore, timed) on Tuesday; rollback rehearsal on dev on Wednesday; till address check across clients; go / no-go on Friday 13; **production cut-over Sunday 15 → Monday 16 Nov, 02:00 EAT**. | Rehearsal checks equal; freeze window measured; no open defect from the week of use; owner's go. |
| 3 (16 – 22 Nov) | 72-hour watch; Render in maintenance mode; Supabase kept intact. | No rollback needed after 72 hours. |
| 4–8 | Shared-components step 2 batches on the VPS dev; WAL archiving (optional); cancel Render, Vercel, Supabase after 30 days. | — |

**Fallbacks if the deadline is close:** (1) cut over on the planned night **with the GoTrue container** instead of own auth (zero code change: `SUPABASE_URL` also routes `/auth/v1` to it, with the restored `auth` schema) and switch to own auth on the VPS a week later; (2) if the move itself slips past 20 November, upgrade Supabase to Pro for one month (USD 25) rather than rush the cut-over.

**Risk register**

| # | Risk | Likelihood / impact | Mitigation |
|---|---|---|---|
| R1 | Hetzner CX33 out of stock or account verification delays the order | medium / medium | CAX21, Helsinki, or Contabo VPS 6; order this week |
| R2 | One server is a single point of failure (hardware, provider outage) | low / high | tills sell offline; Hetzner backups (RTO ~30 min); R2 dumps + runbook (RTO 2–3 h); WAL archiving later |
| R3 | A behaviour difference between Supabase's PostgREST and the self-hosted one (version, max rows, URL limits, error codes) | medium / high | pin the same major; `db-max-rows=1000`; full CI and the HTTP tests against VPS dev; a week of use on T1 |
| R4 | Password hashes not carried over cleanly (format, missing hashes) | low / high | hash-format check on dev first (`docs/OWN-AUTH-PLAN.md` § 4); reset-by-code fallback; GoTrue fallback |
| R5 | A till still configured with an `onrender.com` address | medium / medium | address check per till before the cut-over; keep Render answering until re-pointed |
| R6 | M-Pesa callbacks lost in the freeze window, or refused because of a proxy hop | low / medium | short night window; `api.` DNS only; watchdog's unanswered list checked after; STK test on a real phone |
| R7 | Docker-published ports bypass `ufw`, exposing Postgres | low / critical | no published ports except Caddy; Hetzner Cloud Firewall as a second layer; an outside port scan in week 0 |
| R8 | Disk fills (logs, dumps, images) | medium / high | log caps, 14-day local dump retention, `docker image prune` monthly, 80% alert |
| R9 | Secrets lost with the server | low / critical | `/etc/zaptill/*.env` copied to the owner's password manager; R2 passphrase kept there too |
| R10 | Owner's operational load (patching, alerts) is not done | medium / medium | automatic updates, alerts to email and Telegram, the 15-minute weekly checklist, a named technician |
| R11 | Rollback after the switch loses data written in between | low / high | rollback = reverse dump/restore, rehearsed on dev; 72-hour window only |
| R12 | The shared-components branch and the move are tested together, so a fault is harder to place | medium / medium | production moves from `dev`'s code, not the branch; the branch is only on the VPS dev environment until it merges by its own rules |
| R13 | Kenya Data Protection Act: client data hosted abroad | low / low | unchanged from today (Supabase and Render are abroad too); Hetzner provides a GDPR data-processing agreement; note it in the client terms |

## 11. Decisions needed from the owner

1. **Provider:** Hetzner CX33 (recommended), CAX21 if out of stock, or Contabo VPS 6.
2. **Cut-over night:** Sun 15 → Mon 16 Nov (recommended, before the 20 Nov restriction); and whether the GoTrue fallback is acceptable on that night if own auth is not ready.
3. **Dashboards on the VPS or on Cloudflare Pages.** The plan puts them on the VPS ("host everything there"). Cloudflare Pages is free, allows commercial use and would keep the dashboards up when the server is down (though they cannot do much without the API). Recommendation: VPS, for one place to look after.
4. **Backup schedule:** nightly at 00:00 EAT (now free), and whether to add WAL archiving (5-minute recovery point) in month 2.
5. **Who looks after the server** week to week, and who else gets SSH access.
6. **Supabase Pro for one month** as the safety net if the move slips past 20 November.
