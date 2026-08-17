# SwiftPOS — runbook

> **⚠ STALENESS WARNING — added 2026-08-10.**
> **Section 1 below is out of date and must not be followed as written.** It
> describes running migrations 41 and 42. The repository is at **74**. It was
> written when 41 was the next migration and has not been revised since.
>
> **Do not infer from this document what is applied in production.** Nobody has
> recorded that here, and `schema_migrations` cannot answer it either — only
> **22 of 68** migration files record themselves, and 68 and 72 are applied in
> production while absent from this repo entirely (register A4). Ask the
> database, then check the answer against the file.
>
> What IS current and safe to rely on: `npm run test:migrations` runs every
> `scripts/test-migration*.mjs` against a real Postgres (PGlite) and is in CI —
> **7 files, 110 assertions.** Run it before applying anything anywhere.
>
> Section 0 below was added 2026-08-10 and IS current.

---

# 0. FIELD INCIDENTS — read before touching a machine

These are the actions that are irreversible if taken in the wrong order. Each one
exists because the register recorded a consequence, and a register entry is not
where somebody looks at nine at night with a dead node.

## 0.1 A node has failed and you are replacing it

**DO NOT WIPE OR RE-IMAGE THE FAILED NODE UNTIL ITS `swiftpos.db` HAS BEEN READ.**

Promotion cannot recover rows the dead node ORIGINATED but never distributed —
its own sales live only on its disk, and nothing anywhere measures how far behind
distribution had got. That lag *is* the recovery point (register A23).

1. Take a copy of `%APPDATA%\SwiftPOS\swiftpos.db` off the failed machine **first**.
2. Only then promote a peer or image the replacement.
3. Take `%APPDATA%\SwiftPOS\swiftpos.log` too — it is the first place to look
   when a till "isn't syncing" and it holds no secrets by design.

## 0.2 A terminal has gone missing or been stolen

**ROTATE THE PINs OF EVERY CASHIER WHO SIGNED IN ON THAT TERMINAL.**

A till caches a bcrypt PIN hash for each cashier who signed in on it while online
(`staff_pin_cache`). It is wrapped with DPAPI, which defeats a copied `.db`, a
stolen backup and a pulled disk — but **not** code running as the app user on
that machine. A till that auto-logs into Windows gives whoever powers it on
exactly the access the app has, and a 4–6 digit PIN over bcrypt is a small space.

What is NOT at risk, by design: `override_pin_hash` is never cached, so voids,
discounts past the floor and refunds on other terminals are not exposed.

The cache expires 14 days after the last server contact, which bounds the window
but does not close it today (register A20; A17 for why that TTL is also the wrong
bound for a branch-node deployment).

Also: revoke the terminal in the dashboard — Settings → Devices. Registration
never re-approves a rejected row, so a revoked till stays revoked even if someone
signs in on it again.

## 0.3 Before ANY till trades on 0.5.27 or later

**Tick the thermal checkbox** on the Printers screen. With it unticked, **nothing
prints** — no kitchen ticket, no dispatch slip, no receipt. The HTML fallback was
removed in 0.5.27 (register D8), so OFF no longer means "print the old way"; it
means print nothing. The label says so in amber since A42; it previously
reassured.

---

# 1. SCHEMAS TO RUN ON SUPABASE

## Now — migration 41

```bash
psql "$DATABASE_URL" -f migrations/41_business_days_and_shift_attribution.sql
```

Purely additive: creates `business_days`, adds eight `shifts` columns, widens the
status CHECK, backfills. **Nothing in it can reject a write**, so it is safe on
live with old tills still connected.

## After the new build is on every till — migration 42

```bash
psql "$DATABASE_URL" -f migrations/42_one_open_shift_per_cashier.sql
```

Adds the one-open-shift-per-cashier index. Watch for:

```
NOTICE: migration 42: demoted N duplicate open shift(s) to closed_unreconciled
```

If N > 0, those are drawers nobody ever counted. They will show as unreconciled
in your first day-close summaries. Review them; do not just clear them.

## Dry run first (no real data touched)

```bash
npm i --no-save @electric-sql/pglite
node scripts/test-migrations-41-42.mjs      # 26 assertions
```

## Why the split

`/api/sync/push` used to batch-upsert shifts, so one rejected row failed the
whole call — shifts, floats and expenses — and the sync engine retried forever.
42's index can reject a row. That is now fixed (per-row upsert, rejections
returned inside a 200), but **only in this build**. Hence the order.

## THAT IS ALL. Two files. Nothing else.

---

# 2. HOW TO UPDATE THE DESKTOP POS

The till's schema lives **in the app binary**, not in Supabase. Sync moves DATA
only — it never touches structure. `localDb.ts` runs at every boot:
`CREATE TABLE IF NOT EXISTS` for new tables, `migrateColumns` for new columns.
Idempotent, additive, automatic.

**So updating the till schema = installing a new build.** There is no
`electron-updater` configured, so it is manual, per terminal.

## Build

```bash
cd /c/swiftpos/pos/apps/desktop
npm version 0.2.1 --no-git-tag-version
npx tsc -p tsconfig.json \
  && npx tsc -p tsconfig.main.json \
  && npx vite build \
  && rm -rf release \
  && npm run pack:portable \
  && npm run pack:installer
```

Installers land in `apps/desktop/release/`.

## Roll out

1. Redeploy the server FIRST — `routes/sync.ts` and `routes/shifts.ts` changed.
2. Run migration 41 on Supabase.
3. Install the new `.exe` on **each of the three tills**. Nothing else to do —
   the schema migrates itself on first launch.
4. Confirm each till shows `v0.2.1` in the POS top bar.
5. Only then run migration 42.

## Which tills are behind — you no longer have to remember

Every till now sends `X-Schema-Version` on sync. The server compares it against
two thresholds:

- **REQUIRED (42)** — a till below this is WARNED. It keeps trading and syncing;
  the message appears in its sync status. Blocking a working till to enforce
  tidiness is how a shop loses a lunch rush.
- **HARD_MIN (41)** — below this the payloads are genuinely incompatible, and the
  push returns 426 with a plain "install the current build" message instead of an
  opaque column error mid-service.

Both constants are at the top of `apps/server/src/routes/sync.ts`. Raise HARD_MIN
only when a change actually breaks old payloads — raising it for convenience
turns a deploy into a fleet-wide outage.

## Adding a column, from now on

1. Add it to the migration (Postgres) AND to `localDb.ts`'s `migrateColumns`.
2. Bump `LOCAL_SCHEMA_VERSION` in `localDb.ts`.
3. Bump `REQUIRED_DESKTOP_SCHEMA` in `routes/sync.ts`.
4. Push. CI's `schema-parity` step fails if you forgot either side.

**The one rule that keeps Postgres safely ahead of the tills:** never add a
NOT NULL column without a default to a table the till PUSHES. That rejects every
push from every terminal that has not been updated. The parity check fails the
build on exactly this, so you cannot do it by accident.

---

# 3. WHAT I DECIDED NOT TO BUILD, AND WHY

A schema generator — one manifest emitting both the Postgres migration and the
SQLite schema. It is the correct long-term answer and I will build it when you
are not mid-deployment. It changes how every schema is authored, and landing that
while a till is under test trades a real risk for a theoretical one.

The parity check already prevents drift reaching the repo, which is most of the
value at a fraction of the risk. Revisit after the tills are stable.

PGlite (real Postgres on the terminal, so both sides run the same `.sql`) stays
off the table until the data layer is async. `better-sqlite3` is synchronous
across hundreds of call sites including `db.transaction()` blocks. That is a
rewrite, not a migration.

---

# 4. STILL OPEN

- **Reports** — date filters and CSV download. Your original second ask.
  `managerReports.ts` still hard-codes `todayRange()`. Not started.
- Dashboard force-close UI — endpoint exists, nothing calls it, so a cashier
  whose terminal died cannot be released.
- `terminals` table — needed before the online POS can enforce trading days.
- `clearDeviceConfig()` ungated — a factory reset now bypasses the day gate.
- Real gaps the parity check surfaced: `orders.pump_id` (your own audit script
  cites this as why fuel reports read zero), `orders.table_number`, `covers`,
  `source`, `shifts.denomination_breakdown` — all in Postgres, none on the till.

# 5. PRINTER SETTINGS ON EACH TILL

Not code. Set these in Windows printer properties:

- Cutter Select: currently `Report[No Cut]` — why tickets come out as one strip
- Feed Paper After Job End: currently `None`
- Printing Density: currently `default` — set it darkest
- Paper width in SwiftPOS: set to **Auto** (or 80mm). It was on 58mm, which is
  the 26mm blank strip and the truncated cashier name.

And tick the **Kitchen** box on the `3PC Chicken` category — it is the only item
on any of these lists that loses food.

# 6. HEALTH MONITORING & KEEP-WARM (free-tier hosting)

Two free-tier idle timers can take prod down with no error in the logs:

- **Render** web service spins down after ~15 min with no inbound traffic → ~50s
  cold start on the next request.
- **Supabase** free project **PAUSES** after ~7 days with no database activity →
  tills cannot sync until someone un-pauses it in the Supabase dashboard.

## Endpoints

- `GET /health` — liveness + a real DB round-trip. Returns **200** while the DB is
  reachable (status `degraded` with a `missing` list if schema has drifted, but
  still 200); **503** only when the DB is unreachable. This is the keep-warm target.
- `GET /health/schema` — strict. **503** when migrations this build expects are not
  applied. A deploy-drift alarm, NOT a liveness check.

## UptimeRobot monitors

1. **Keep-warm / liveness** — HTTP(s), URL `…/health`, interval **5 min**, timeout
   **≥ 60s** (a cold Render start takes ~50s; a shorter timeout false-alarms on
   wake). Alert on 503 (= DB down). Counts toward uptime.
2. **Schema-drift alarm** — HTTP(s), URL `…/health/schema`, interval 15–30 min,
   timeout ≥ 60s. A 503 here means "migrations not applied — run the prod
   migration", not "site down". **Exclude this monitor from your uptime %/SLA**, or
   a bad deploy reads as an outage.

## Supabase keep-warm — the important caveat

`/health` keeps Supabase warm ONLY while the ping reaches the DB **through** Render.
That chain is fragile on free tier: a cold or hour-capped Render instance can drop
the ping before it touches Postgres — which is how a project can still pause despite
an UptimeRobot monitor (a sister app paused at ~day 15 this way). So Supabase warmth
is covered two ways:

- **Live stores**: trading tills sync constantly → Supabase never idles. No action.
- **Dormant deployments** (dev, a not-yet-trading store): `.github/workflows/
  supabase-keepalive.yml` touches Supabase **directly** every 3 days, independent of
  Render. Needs repo secrets `SUPABASE_URL` and `SUPABASE_ANON_KEY`. Wake it now any
  time via Actions → "Supabase keep-alive" → Run workflow.

## The real fix if cold-starts/pauses ever hurt operations

These are free-tier behaviours, not bugs. **Render paid** (no spin-down) and
**Supabase Pro** (no auto-pause) remove them entirely. For a store actually trading
on this, that is the correct answer — not more aggressive pinging. A free Supabase
project left paused long enough can eventually be deleted, so Pro also protects the
data, not just the uptime.
