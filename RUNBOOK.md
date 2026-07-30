# SwiftPOS — runbook

Unzip over the repo root. Delete `scripts/test-migration-41.mjs` if you still
have it (renamed to `test-migrations-41-42.mjs`).

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
