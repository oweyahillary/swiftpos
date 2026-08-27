// Local SQLite database — offline-first POS terminal
import Database from 'better-sqlite3';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { app } from 'electron';

// Resolved lazily, NOT at import time.
//
// app.getPath('userData') was being read while this module loaded, and imports
// hoist — so nothing could run before it. That made it impossible to relocate
// the folder on startup, because the path was already fixed by the time any
// migration code could execute. Deferring it to first use costs nothing and
// leaves that window open.
export function getDbPath(): string {
  return path.join(app.getPath('userData'), 'swiftpos.db');
}

let _db: Database.Database | null = null;

/** Closes the handle so the file can be deleted. Used only by device:reset. */
export function closeLocalDb(): void {
  try { _db?.close(); } catch { /* already closed */ }
  _db = null;
}

export function getLocalDb(): Database.Database {
  if (_db) return _db;

  _db = new Database(getDbPath());
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  initSchema(_db);
  return _db;
}

function initSchema(db: Database.Database) {
  db.exec(`
    -- ── Auth / session ──────────────────────────────────────
    CREATE TABLE IF NOT EXISTS session (
      id          INTEGER PRIMARY KEY CHECK (id = 1),
      token       TEXT NOT NULL,
      refresh_token TEXT,
      user_id     TEXT NOT NULL,
      business_id TEXT NOT NULL,
      business_name TEXT NOT NULL,
      currency    TEXT NOT NULL DEFAULT 'KES',
      logged_in_at TEXT NOT NULL
    );

    -- ── Device configuration ───────────────────────────────
    -- Singleton row written once at first-run install (see deviceConfig.ts).
    -- Holds the runtime server URL, deploy mode, bound branch and business type.
    -- Its presence (configured=1) is what App.tsx uses to decide install vs login.
    CREATE TABLE IF NOT EXISTS device_config (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      deploy_mode   TEXT NOT NULL DEFAULT 'cloud',
      server_url    TEXT NOT NULL,
      branch_id     TEXT,
      business_type TEXT,
      device_name   TEXT,
      device_id     TEXT,
      device_role   TEXT NOT NULL DEFAULT 'till',
      node_url      TEXT,
      configured    INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );

    -- ── Offline sign-in cache ────────────────────────────────────────────────
    --
    -- One row per staff member who has signed in ON THIS TERMINAL while online,
    -- so a line fault does not stop the floor starting a shift. See pinCache.ts
    -- for what is deliberately NOT here: no override_pin_hash, no legacy hash
    -- format, and nothing at all when safeStorage cannot wrap it.
    --
    -- pin_hash_enc is safeStorage-wrapped (DPAPI on Windows), base64. It is
    -- machine+user bound, so a copied .db is useless on another machine.
    CREATE TABLE IF NOT EXISTS staff_pin_cache (
      staff_id     TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      role_name    TEXT,
      branch_id    TEXT NOT NULL,
      permissions  TEXT NOT NULL DEFAULT '{}',
      pin_hash_enc TEXT NOT NULL,
      cached_at    TEXT NOT NULL
    );

    -- Branch NODE roster (PHASE5 §4a / A17). Node-only: the whole branch's active
    -- staff, pulled from GET /api/pos/branch-staff, so the node can authenticate
    -- a peer's cashier offline (POST /node/verify-pin). Hashes wrapped with
    -- safeStorage, exactly like staff_pin_cache. Unlike that cache there is NO
    -- cached_at / TTL — a node is the branch's authority and its roster is valid
    -- until replaced (§4e). Replaced wholesale on each pull so a deactivated
    -- staff member disappears here too.
    CREATE TABLE IF NOT EXISTS branch_staff (
      staff_id              TEXT PRIMARY KEY,
      name                  TEXT NOT NULL,
      role_name             TEXT,
      branch_id             TEXT NOT NULL,
      permissions           TEXT NOT NULL DEFAULT '{}',
      pin_hash_enc          TEXT NOT NULL,
      override_pin_hash_enc  TEXT,
      status                TEXT NOT NULL DEFAULT 'active',
      updated_at            TEXT
    );

    -- ── Held orders (restaurant tabs) ────────────────────────────────────────
    --
    -- These are OPEN TABLES. Until 2026-08-08 they lived in the renderer's
    -- localStorage as a single JSON blob, read through a swallowing catch that
    -- returned an empty list. A truncated write — a power cut mid-persist, which
    -- a restaurant till on unprotected mains meets eventually — made the parse
    -- throw and the app report ZERO open tables. The food is already cooked and
    -- the KOTs are on the pass; there is no bill for any of it, and no error.
    --
    -- One row per tab, so a corrupt row costs one table rather than all of them,
    -- and better-sqlite3's synchronous writes land or don't — no half-written
    -- blob. Still deliberately LOCAL-ONLY and out of sync_queue: a held order
    -- has no payment, so it is not yet an order. It joins the queue when charged.
    --
    -- The cart column stays JSON: it carries per-line kotSent flags and nested
    -- variant and modifier selections; normalising it would buy nothing — nothing
    -- queries inside a held cart.
    --
    -- NOT cleared by clearCatalogue(). Logging out mid-service must not bin the
    -- floor's open tables; the same reasoning that keeps orders and sync_queue.
    CREATE TABLE IF NOT EXISTS held_orders (
      id              TEXT PRIMARY KEY,
      order_number    TEXT NOT NULL,
      label           TEXT NOT NULL,
      order_type      TEXT NOT NULL,
      table_number    TEXT NOT NULL DEFAULT '',
      delivery_person TEXT,
      cart            TEXT NOT NULL,
      held_at         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_held_orders_held_at ON held_orders(held_at);

    -- ── Active staff (PIN login) — singleton, layered on top of owner session ─
    CREATE TABLE IF NOT EXISTS staff_session (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      staff_id      TEXT NOT NULL,
      staff_name    TEXT NOT NULL,
      role_name     TEXT,
      branch_id     TEXT NOT NULL,
      branch_name   TEXT,
      permissions   TEXT NOT NULL DEFAULT '{}',
      token         TEXT NOT NULL,
      refresh_token TEXT,
      logged_in_at  TEXT NOT NULL
    );

    -- ── Catalogue (synced down, remote wins) ────────────────
    CREATE TABLE IF NOT EXISTS categories (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      color       TEXT,
      icon        TEXT,
      sort_order  INTEGER DEFAULT 0,
      status      TEXT DEFAULT 'active',
      synced_at   TEXT
    );

    CREATE TABLE IF NOT EXISTS products (
      id            TEXT PRIMARY KEY,
      category_id   TEXT,
      name          TEXT NOT NULL,
      description   TEXT,
      base_price    REAL NOT NULL DEFAULT 0,
      image_url     TEXT,
      has_variants  INTEGER DEFAULT 0,
      has_modifiers INTEGER DEFAULT 0,
      track_stock   INTEGER DEFAULT 1,
      status        TEXT DEFAULT 'active',
      synced_at     TEXT
    );

    -- Monotonic counters, currently just the bill sequence. Kept in its own
    -- table rather than device_config so the increment is one small atomic
    -- transaction with no read-modify-write race between windows. Deliberately
    -- NOT using UPDATE...RETURNING, which needs SQLite 3.35+ and would fail at
    -- runtime on a till rather than at build time.
    CREATE TABLE IF NOT EXISTS counters (
      name  TEXT PRIMARY KEY,
      value INTEGER NOT NULL DEFAULT 0
    );

    -- Combo component definitions, refreshed by each catalogue pull. A combo is
    -- sold as ONE cart line; these rows exist so the dispatcher and kitchen
    -- tickets can expand it. is_kitchen is denormalised from the component's
    -- own category so ticket printing never needs a join while offline.
    CREATE TABLE IF NOT EXISTS combo_items (
      combo_id    TEXT NOT NULL,
      product_id  TEXT NOT NULL,
      name        TEXT NOT NULL,
      quantity    INTEGER NOT NULL DEFAULT 1,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      is_kitchen  INTEGER NOT NULL DEFAULT 0,
      synced_at   TEXT,
      PRIMARY KEY (combo_id, product_id)
    );

    CREATE TABLE IF NOT EXISTS variant_groups (
      id          TEXT PRIMARY KEY,
      product_id  TEXT NOT NULL,
      name        TEXT NOT NULL,
      required    INTEGER DEFAULT 0,
      sort_order  INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS variant_options (
      id                TEXT PRIMARY KEY,
      variant_group_id  TEXT NOT NULL,
      name              TEXT NOT NULL,
      price_adjustment  REAL DEFAULT 0,
      sort_order        INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS modifier_groups (
      id          TEXT PRIMARY KEY,
      product_id  TEXT NOT NULL,
      name        TEXT NOT NULL,
      min_select  INTEGER DEFAULT 0,
      max_select  INTEGER,
      sort_order  INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS modifier_options (
      id                 TEXT PRIMARY KEY,
      modifier_group_id  TEXT NOT NULL,
      name               TEXT NOT NULL,
      price              REAL DEFAULT 0,
      sort_order         INTEGER DEFAULT 0
    );

    -- ── Branches ────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS branches (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      is_main     INTEGER DEFAULT 0
    );

    -- ── Dining tables (synced down, remote wins) ────────────
    -- Reference data for the restaurant table map. slot_type also covers
    -- parking bays ('parking_bay') for when that mode ports over.
    CREATE TABLE IF NOT EXISTS tables (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      capacity    INTEGER DEFAULT 4,
      sort_order  INTEGER DEFAULT 0,
      slot_type   TEXT DEFAULT 'dining',
      pos_x       REAL,
      pos_y       REAL,
      zone        TEXT,
      shape       TEXT,
      synced_at   TEXT
    );

    -- Fuel pumps (petrol stations). Synced down, remote wins. The fuel product
    -- (name + price/litre) is resolved by joining fuel_product_id -> products,
    -- so pumps carry no price of their own.
    CREATE TABLE IF NOT EXISTS pumps (
      id              TEXT PRIMARY KEY,
      branch_id       TEXT,
      fuel_product_id TEXT,
      name            TEXT NOT NULL,
      status          TEXT DEFAULT 'idle',
      sort_order      INTEGER DEFAULT 0,
      synced_at       TEXT
    );

    CREATE TABLE IF NOT EXISTS stock_levels (
      product_id  TEXT NOT NULL,
      branch_id   TEXT NOT NULL,
      quantity    INTEGER NOT NULL DEFAULT 0,
      low_stock_threshold INTEGER NOT NULL DEFAULT 5,
      synced_at   TEXT,
      PRIMARY KEY (product_id, branch_id)
    );

    CREATE TABLE IF NOT EXISTS stock_movements (
      id              TEXT PRIMARY KEY,
      product_id      TEXT NOT NULL,
      branch_id       TEXT NOT NULL,
      movement_type   TEXT NOT NULL,
      quantity_change INTEGER NOT NULL,
      quantity_after  INTEGER NOT NULL,
      notes           TEXT,
      created_at      TEXT NOT NULL
    );

    -- ── Orders (written locally, synced up) ─────────────────
    CREATE TABLE IF NOT EXISTS orders (
      id            TEXT PRIMARY KEY,
      business_id   TEXT NOT NULL,
      branch_id     TEXT NOT NULL,
      order_number  TEXT NOT NULL UNIQUE,
      order_type    TEXT DEFAULT 'retail',
      status        TEXT DEFAULT 'completed',
      subtotal      REAL NOT NULL,
      vat_amount    REAL NOT NULL,
      discount_amount REAL DEFAULT 0,
      total         REAL NOT NULL,
      created_at    TEXT NOT NULL,
      device_id     TEXT,
      sync_status   TEXT DEFAULT 'pending'
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id            TEXT PRIMARY KEY,
      order_id      TEXT NOT NULL,
      product_id    TEXT NOT NULL,
      product_name  TEXT NOT NULL,
      category_name TEXT,
      unit_price    REAL NOT NULL,
      quantity      INTEGER NOT NULL,
      subtotal      REAL NOT NULL
    );

    -- Custom payment methods (A96), cached from /api/pos/init so they appear as
    -- tender options offline. Built-in Cash/M-Pesa/Card are not stored here.
    -- Replaced wholesale on each pull. Local mirror only, never pushed.
    CREATE TABLE IF NOT EXISTS payment_methods (
      code       TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    -- Local-only (never synced). The exact order payload that printed, kept so
    -- any recent order can be reprinted byte-identically from Order History
    -- (register A94) — replayed through the same queueThermal path as the
    -- original, marked "Duplicate Print". Pruned to the last 200 per boot.
    CREATE TABLE IF NOT EXISTS receipt_payloads (
      order_id   TEXT PRIMARY KEY,
      payload    TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS order_item_variants (
      id                   TEXT PRIMARY KEY,
      order_item_id        TEXT NOT NULL,
      variant_group_name   TEXT NOT NULL,
      variant_option_name  TEXT NOT NULL,
      price_adjustment     REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS order_item_modifiers (
      id                    TEXT PRIMARY KEY,
      order_item_id         TEXT NOT NULL,
      modifier_group_name   TEXT NOT NULL,
      modifier_option_name  TEXT NOT NULL,
      price                 REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS payments (
      id              TEXT PRIMARY KEY,
      order_id        TEXT NOT NULL,
      method          TEXT NOT NULL,
      amount          REAL NOT NULL,
      amount_tendered REAL NOT NULL,
      change_given    REAL DEFAULT 0,
      reference       TEXT,
      status          TEXT DEFAULT 'completed',
      created_at      TEXT NOT NULL,
      sync_status     TEXT DEFAULT 'pending'
    );

    -- ── Sync queue ──────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS sync_queue (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id    TEXT NOT NULL UNIQUE,
      payload     TEXT NOT NULL,
      attempts    INTEGER DEFAULT 0,
      last_error  TEXT,
      created_at  TEXT NOT NULL,
      status      TEXT DEFAULT 'pending'
    );

    -- ── Customer credit ledger (offline) ────────────────────
    CREATE TABLE IF NOT EXISTS customer_credit_transactions (
      id            TEXT PRIMARY KEY,
      customer_id   TEXT NOT NULL,
      branch_id     TEXT,
      order_id      TEXT,
      type          TEXT NOT NULL,
      amount        REAL NOT NULL,
      created_at    TEXT NOT NULL,
      sync_status   TEXT DEFAULT 'pending'
    );

    -- ════════════════════════════════════════════════════════
    -- Phase B — attribution + offline operational reporting
    -- See syncEngine.ts SYNC_DIRECTION for the per-table sync direction.
    -- ════════════════════════════════════════════════════════

    -- Staff reference data. PULL-DOWN, remote wins — never edited on the till.
    -- Gives offline shift/EOD reports real cashier names, not just ids.
    CREATE TABLE IF NOT EXISTS users (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      role_name   TEXT,
      status      TEXT DEFAULT 'active',
      synced_at   TEXT
    );

    -- Cash-up shifts. PUSH-UP, local origin — opened/closed at the till offline,
    -- then synced to the server (which has /api/shifts/open|close|float).
    CREATE TABLE IF NOT EXISTS shifts (
      id              TEXT PRIMARY KEY,
      business_id     TEXT NOT NULL,
      branch_id       TEXT NOT NULL,
      cashier_id      TEXT NOT NULL,
      opened_at       TEXT NOT NULL,
      closed_at       TEXT,
      status          TEXT NOT NULL DEFAULT 'open',
      opening_float   REAL NOT NULL DEFAULT 0,
      closing_float   REAL,
      expected_cash   REAL,
      cash_variance   REAL,
      notes           TEXT,
      created_at      TEXT NOT NULL,
      sync_status     TEXT NOT NULL DEFAULT 'pending'
    );

    -- ── Print stations ────────────────────────────────────────────────────────
    -- Mirrors public.print_stations / category_stations (migration 44). PULL-DOWN:
    -- defined once in the manager screen and pulled by every till, so three
    -- terminals cannot disagree about where an order prints.
    --
    -- Replaces categories.is_kitchen as the routing authority. That boolean is why
    -- 3PC Chicken never reached the kitchen: routing was one tick box on the
    -- category, nobody had ticked it, and nothing said so.
    --
    -- The PRINTER is deliberately not here. A station is a business idea ("Grill");
    -- which physical printer serves it is a property of THIS terminal, so that
    -- binding lives in the local printer settings keyed on station_id.
    CREATE TABLE IF NOT EXISTS print_stations (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      -- kitchen = prepared items only; dispatch = everything, for packing;
      -- receipt = the customer copy, item names and not itemised.
      kind        TEXT NOT NULL DEFAULT 'kitchen',
      sort_order  INTEGER NOT NULL DEFAULT 0,
      active      INTEGER NOT NULL DEFAULT 1,
      synced_at   TEXT
    );

    CREATE TABLE IF NOT EXISTS category_stations (
      category_id TEXT NOT NULL,
      station_id  TEXT NOT NULL,
      PRIMARY KEY (category_id, station_id)
    );

    CREATE INDEX IF NOT EXISTS category_stations_station_idx ON category_stations (station_id);

    -- ── Trading days, per till ────────────────────────────────────────────────
    -- Mirrors public.business_days (migration 41). One row per TILL per trading
    -- date. Opens implicitly when the first cashier opens a drawer that date;
    -- closes only when a MANAGER counts the cash.
    --
    -- Local origin, PUSH-UP. This table is the authority while offline: the till
    -- must be able to refuse a sale at 6am with no network, so the gate cannot
    -- live on the server.
    CREATE TABLE IF NOT EXISTS business_days (
      id            TEXT PRIMARY KEY,
      business_id   TEXT NOT NULL,
      branch_id     TEXT NOT NULL,
      device_id     TEXT,
      terminal_code TEXT,
      -- LOCAL calendar date at this till, 'YYYY-MM-DD'. Taken from the machine's
      -- own clock, not derived from a timestamp: the terminal is physically in
      -- the shop, so it is the authority on which trading day a sale belongs to.
      business_date TEXT NOT NULL,
      opened_at     TEXT NOT NULL,
      opened_by     TEXT,
      closed_at     TEXT,
      closed_by     TEXT,           -- MUST be a manager
      status        TEXT NOT NULL DEFAULT 'open',
      -- The manager's independent count at day close. This is the SECOND count:
      -- each cashier already counted their own drawer blind at their own close.
      counted_cash  REAL,
      expected_cash REAL,
      cash_variance REAL,
      notes         TEXT,
      created_at    TEXT NOT NULL,
      sync_status   TEXT NOT NULL DEFAULT 'pending'
    );

    -- One day row per till per date.
    CREATE UNIQUE INDEX IF NOT EXISTS business_days_till_date
      ON business_days (branch_id, COALESCE(device_id, ''), business_date);

    -- The rule itself, in the database rather than only in code: a till may have
    -- ONE open day at a time. So "you cannot start a new day until yesterday's
    -- is closed" survives a bug in the calling code.
    CREATE UNIQUE INDEX IF NOT EXISTS business_days_one_open_per_till
      ON business_days (branch_id, COALESCE(device_id, ''))
      WHERE status = 'open';

    CREATE INDEX IF NOT EXISTS business_days_date_idx ON business_days (business_date DESC);

    -- Float in/out movements within a shift. PUSH-UP, local origin.
    CREATE TABLE IF NOT EXISTS float_transactions (
      id          TEXT PRIMARY KEY,
      shift_id    TEXT NOT NULL,
      branch_id   TEXT NOT NULL,
      cashier_id  TEXT NOT NULL,
      type        TEXT NOT NULL,          -- 'float_in' | 'float_out'
      amount      REAL NOT NULL,
      reason      TEXT,
      created_at  TEXT NOT NULL,
      sync_status TEXT NOT NULL DEFAULT 'pending'
    );

    -- Petty-cash / operating expenses recorded at the till. PUSH-UP, local origin.
    CREATE TABLE IF NOT EXISTS expenses (
      id                  TEXT PRIMARY KEY,
      business_id         TEXT NOT NULL,
      branch_id           TEXT NOT NULL,
      expense_category_id TEXT,
      description         TEXT NOT NULL,
      amount              REAL NOT NULL,
      paid_by             TEXT,
      expense_date        TEXT NOT NULL,
      shift_id            TEXT,
      created_at          TEXT NOT NULL,
      sync_status         TEXT NOT NULL DEFAULT 'pending'
    );

    -- Branch price overrides set by the manager on THIS device (the branch
    -- authority). LOCAL ORIGIN — the manager owns the branch's prices offline.
    -- Kept in its own table (not just products.branch_price) for two reasons:
    --   1. Durability: pullCatalogue overwrites products.branch_price from the
    --      server; this table lets us re-apply unsynced local edits afterwards
    --      so a manager's offline price change is never clobbered by a sync.
    --   2. Up-sync (step 6): synced=0 rows are exactly what flows up to the
    --      cloud, carrying who/when for newest-wins. price NULL = "cleared,
    --      revert to base_price" (and delete the cloud override on up-sync).
    CREATE TABLE IF NOT EXISTS local_price_edits (
      product_id  TEXT PRIMARY KEY,
      price       REAL,                    -- NULL = cleared (revert to base_price)
      updated_at  TEXT NOT NULL,
      updated_by  TEXT NOT NULL DEFAULT 'pc',
      synced      INTEGER NOT NULL DEFAULT 0
    );
  `);

  // ── Additive migrations for existing installs ──────────────────────────────
  // CREATE TABLE IF NOT EXISTS won't add columns to an already-created table, so
  // bring older local DBs up to date. Each guarded so it's safe to run every boot.
  migrateColumns(db, 'session', [
    ['refresh_token', 'TEXT'],
  ]);

  // Register D5 - credentials wrapped at rest (safeStorage/DPAPI). The plaintext
  // columns above are KEPT and still read as a fallback: an install that predates
  // this, or a machine where wrapping is unavailable, must keep working. See
  // main/tokenStore.ts for why plaintext is never cleared until the wrapped value
  // has been read back in the same write.
  migrateColumns(db, 'session', [
    ['token_enc',         'TEXT'],
    ['refresh_token_enc', 'TEXT'],
  ]);
  migrateColumns(db, 'staff_session', [
    ['token_enc',         'TEXT'],
    ['refresh_token_enc', 'TEXT'],
  ]);

  // How a shift was closed. 'counted' means a human counted the drawer;
  // 'forced' means a manager ended it without a count. Kept distinct forever so
  // an unverified close can never be mistaken for a verified one in any report.
  //
  // The rest mirror migration 41. device_id/terminal_code matter because a branch
  // runs three tills and, without them, three drawers reach the server
  // distinguishable only by cashier — so one person covering two tills in a day
  // produces a reconciliation nobody can attribute.
  //
  // drawer_label is free text on purpose. Sites move physical drawers between
  // terminals and we get no say in it, so cash is never inferred from where a
  // drawer sits: opening_float is counted at open, closing_float at close, and
  // each shift stands alone. The label only records WHICH drawer, which is the
  // first question anyone asks when a variance appears.
  migrateColumns(db, 'shifts', [
    ['closed_by', 'TEXT'],
    ['close_method', 'TEXT'],
    ['business_day_id', 'TEXT'],
    ['business_date', 'TEXT'],
    ['device_id', 'TEXT'],
    ['terminal_code', 'TEXT'],
    ['drawer_label', 'TEXT'],
    ['opened_by', 'TEXT'],
  ]);

  // Records what this install has applied. Two jobs: it makes a terminal's
  // schema reportable, and it lets one-off backfills be skipped once done —
  // without it every backfill re-runs on every boot, which is tolerable while
  // they are all `WHERE x IS NULL` but not once one does real work.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      id          INTEGER PRIMARY KEY CHECK (id = 1),
      version     INTEGER NOT NULL,
      applied_at  TEXT NOT NULL
    );
  `);

  // Backfill business_date on shifts written before the column existed, from the
  // local opened_at. SQLite stores these as ISO strings, so the date is the first
  // ten characters — and because opened_at was written by THIS machine in local
  // time, no timezone conversion is needed or wanted here.
  db.exec(`
    UPDATE shifts
       SET business_date = substr(opened_at, 1, 10)
     -- own: the comment above is the reason — opened_at was written by THIS
     -- machine in local time. That stops being true for ingested peer rows, so
     -- rewriting theirs would apply this till's timezone to another's clock.
     WHERE business_date IS NULL AND opened_at IS NOT NULL
       AND COALESCE(device_id,'') = COALESCE((SELECT device_id FROM device_config WHERE id=1),'')
  `);

  db.prepare(`
    INSERT INTO schema_version (id, version, applied_at) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET version=excluded.version, applied_at=excluded.applied_at
  `).run(LOCAL_SCHEMA_VERSION, new Date().toISOString());

  // A179: repair expenses minted before the id-generation fix. A prefixed id
  // (exp_…) is not a valid UUID, so the cloud rejects it (22P02); batched with
  // shifts/days/floats, one such row blocks ALL of them from syncing. These rows
  // never synced (the push always 500'd) and nothing references expenses.id, so
  // regenerating to a UUID is safe and lets the record — and its batch-mates —
  // finally push. Idempotent: after the fix there are no non-UUID ids to match.
  try {
    const bad = db.prepare(
      `SELECT id FROM expenses WHERE sync_status='pending' AND id NOT GLOB '*-*-*-*-*'`
    ).all() as { id: string }[];
    if (bad.length) {
      const fix = db.prepare(`UPDATE expenses SET id=? WHERE id=?`);
      for (const r of bad) fix.run(randomUUID(), r.id);
      console.log(`[localDb] A179: regenerated ${bad.length} non-UUID expense id(s) so the sync batch can push`);
    }
  } catch (e) { /* non-fatal — never block startup on a repair */ }

  migrateColumns(db, 'orders', [
    // Diners on the bill, for Average Per Cover. Postgres has had this since the
    // baseline (DEFAULT 1 NOT NULL); the till never did, so APC could not be
    // computed offline and the parity check flagged it. Defaults to 1 so a
    // non-dine-in sale still divides sensibly and existing rows stay valid.
    ['covers', 'INTEGER DEFAULT 1'],
    ['tip_amount', 'REAL DEFAULT 0'],
    ['customer_id', 'TEXT'],
    ['customer_name', 'TEXT'],
    ['customer_phone', 'TEXT'],
    ['idempotency_key', 'TEXT'],
    // Phase B — cashier/shift attribution + void support for offline reports.
    ['cashier_id', 'TEXT'],
    ['shift_id', 'TEXT'],
    ['void_reason', 'TEXT'],
    ['voided_at', 'TEXT'],
    ['voided_by', 'TEXT'],
    // Refunds (migration 37). The order stays 'completed' — the sale happened —
    // so these columns, not the status, are what a report keys on. Held locally
    // so the Z-report is right on a till that has not synced.
    ['refunded_at', 'TEXT'],
    ['refunded_amount', 'REAL DEFAULT 0'],
    ['refund_reason', 'TEXT'],
    // Desktop multi-till — which physical terminal created this order.
    ['device_id', 'TEXT'],
  ]);
  // Desktop multi-till identity + aggregation-node role on the device config.
  migrateColumns(db, 'orders', [
    // Rider name on a delivery. Local copy so the branch/manager views can show
    // it without a round trip; the cloud payload carries it independently.
    ['delivery_person', 'TEXT'],
    // Catering/Tourism Levy charged on this sale. The cloud payload always
    // carried it, but there was no local column, so the till's own Z-report and
    // the node's branch report showed VAT alone — the tax on the customer's
    // paper did not reconcile with the tax in the till's own reports.
    ['ctl_amount', 'REAL DEFAULT 0'],
  ]);

  migrateColumns(db, 'categories', [
    // Drives kitchen ticket routing — see migrations/34_kitchen_categories.sql
    ['is_kitchen', 'INTEGER DEFAULT 0'],
  ]);

  // ── Branch replication: which terminal created this row? ──────────────────
  // orders, shifts and business_days already carry device_id. expenses and
  // float_transactions did not, which is the only reason a separate ownership
  // marker looked necessary — it is not. device_id already means exactly the
  // right thing, dayService.getOpenDay() already scopes on it correctly, and
  // Postgres carries it on the same rows, so parity improves rather than
  // diverging.
  //
  // This matters because a till acting as the branch node ingests its peers'
  // cash records into these same tables, so a manager can see the whole branch
  // in one place. Without a scope predicate, getOpenShift() —
  //     SELECT * FROM shifts WHERE status='open' ORDER BY opened_at DESC LIMIT 1
  // — stops meaning "my open drawer" and starts meaning "the newest open drawer
  // anywhere at this branch". The sell gate is built on that query.
  //
  // "Mine" is COALESCE(device_id,'') = COALESCE(?,''), not device_id = ?: rows
  // written before the column existed carry NULL, and on a till that has never
  // been given a device_id both sides are '' and it still matches. Peer rows
  // always carry theirs, so they never do.
  //
  // scripts/check-own-rows.mjs fails CI on any query that neither scopes nor
  // declares itself branch-wide. There are 35 such sites; remembering them is
  // not a strategy.
  migrateColumns(db, 'expenses',           [['device_id', 'TEXT']]);
  migrateColumns(db, 'float_transactions', [['device_id', 'TEXT']]);

  // ── Branch replication, v45: sequence, outbox, cursors ────────────────────
  //
  // `seq` is a per-device monotonic counter, assigned by the device that CREATES
  // the row and never rewritten by anyone who ingests it. Together with
  // device_id it is a total order per terminal: "everything device X has made up
  // to N". That is the whole addressing scheme Phase 2's pull replication needs
  // (`GET /node/since?device=X&after=N`), and it costs one integer now against
  // another visit to three terminals later.
  //
  // NOT globally unique and deliberately not a timestamp. Two tills will both
  // hold seq 41 for different rows, and (device_id, seq) is what identifies one.
  // A clock can go backwards — it is one right-click on Windows — and a counter
  // that goes backwards silently un-replicates rows a peer has already seen.
  migrateColumns(db, 'orders',             [['seq', 'INTEGER']]);
  migrateColumns(db, 'shifts',             [['seq', 'INTEGER']]);
  migrateColumns(db, 'expenses',           [['seq', 'INTEGER']]);
  migrateColumns(db, 'float_transactions', [['seq', 'INTEGER']]);
  migrateColumns(db, 'business_days',      [['seq', 'INTEGER']]);

  // orders.pump_id exists in Postgres and never existed here, so every offline
  // fuel sale lost its pump attribution — which is why fuel reports read zero.
  // Riding along with this bump rather than triggering a second till rebuild.
  migrateColumns(db, 'orders', [['pump_id', 'TEXT']]);

  // Retire 'node_ack'.
  //
  // It meant "the branch node has this order but the cloud may not", and it
  // existed because one sync_status column was being asked to describe two
  // destinations. The node is now a separate destination with its own queue, so
  // sync_status describes the cloud and nothing else.
  //
  // Back to 'pending', not 'synced': the cloud genuinely may not have these. A
  // till upgrading from a build that used node_ack has orders whose only proof
  // of delivery was a node that is no longer an uplink, and the push is
  // idempotent on the order id — so re-offering costs one request per order and
  // assuming delivery costs a day's sales.
  // branch-wide: a one-time schema migration over whatever this database holds,
  // run before device_config is necessarily readable. Scoping it would leave any
  // row it missed stranded in a status no code path will ever select again —
  // which for an order means a sale that never reaches the cloud and never
  // appears in any queue a person can see.
  db.exec(`UPDATE orders SET sync_status='pending' WHERE sync_status='node_ack'`);

  // Attribute the rows written between v44 and v45.
  //
  // v44 added device_id to these two tables and scoped every collection query on
  // it, but their INSERT sites were not updated to populate it. A NULL-attributed
  // row does not match COALESCE(device_id,'') = COALESCE(own,'') on any till that
  // has a device_id — so from the moment a till ran v44, its expenses and its
  // drawer floats stopped being collected by the push entirely. Silent, and on
  // the cash path: expected cash would be wrong by exactly the floats nobody
  // could see.
  //
  // branch-wide: every NULL-attributed row in these tables predates the node, so
  // there is no peer row here to mis-claim — no build that could ingest one has
  // ever shipped. Scoping this would be scoping on the column it exists to fill.
  db.exec(`
    UPDATE expenses SET device_id = (SELECT device_id FROM device_config WHERE id=1)
     WHERE device_id IS NULL;
    -- branch-wide: same one-time attribution backfill as the statement above.
    UPDATE float_transactions SET device_id = (SELECT device_id FROM device_config WHERE id=1)
     WHERE device_id IS NULL;
  `);

  db.exec(`
    -- The till's outbox TO the branch node. Deliberately a separate table from
    -- sync_queue, not a column on it.
    --
    -- The node and the cloud are two independent destinations. One sync_status
    -- column cannot hold two opinions, and the attempt to make it — marking a
    -- node-acked order 'synced' — is what made a peer till close its shift
    -- against a server that did not have the sales and report a cash variance
    -- that did not exist. Separate state per destination is the fix; 'node_ack'
    -- was the workaround.
    --
    -- One queue for all five replicated types. table_name says which, row_id is
    -- the row's own UUID, so a retry always resolves to the same record and
    -- ingest can stay idempotent on id.
    CREATE TABLE IF NOT EXISTS node_queue (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name  TEXT NOT NULL,
      row_id      TEXT NOT NULL,
      payload     TEXT NOT NULL,
      attempts    INTEGER DEFAULT 0,
      last_error  TEXT,
      created_at  TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending',
      UNIQUE (table_name, row_id)
    );
    CREATE INDEX IF NOT EXISTS node_queue_pending_idx
      ON node_queue (status, created_at);

    -- Per-device high-water marks. On a node: the last seq ingested from each
    -- peer, which is what makes ingest resumable rather than re-offering a
    -- peer's whole history after any outage. In Phase 2 this becomes the pull
    -- cursor unchanged — the same number means the same thing in both models,
    -- which is why it goes in now.
    CREATE TABLE IF NOT EXISTS peer_cursors (
      device_id   TEXT NOT NULL,
      table_name  TEXT NOT NULL,
      last_seq    INTEGER NOT NULL DEFAULT 0,
      updated_at  TEXT NOT NULL,
      PRIMARY KEY (device_id, table_name)
    );

    -- ── Central day close (Phase 4) — node side ─────────────────────────────
    -- Instructions the node holds for its peers. PULL, never push: peers run no
    -- server, so the node cannot reach out — a peer collects its instructions
    -- on a short poll and acks the outcome. An instruction stays collectable
    -- until it is ACKED, not merely delivered: a peer that crashes between
    -- collecting and executing must be re-offered, and the executor is
    -- idempotent (a day already closed acks success, it does not close twice).
    CREATE TABLE IF NOT EXISTS node_instructions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id   TEXT NOT NULL,             -- target peer
      kind        TEXT NOT NULL,             -- 'close_day'
      payload     TEXT NOT NULL,             -- JSON
      created_by  TEXT,                      -- manager staff_id on the node
      created_at  TEXT NOT NULL,
      delivered_at TEXT,
      status      TEXT NOT NULL DEFAULT 'pending',  -- pending | acked | failed
      ack         TEXT,                      -- JSON from the peer
      acked_at    TEXT
    );
    CREATE INDEX IF NOT EXISTS node_instructions_pending_idx
      ON node_instructions (device_id, status);

    -- What each peer last said about itself, piggybacked on its instruction
    -- poll. Exists because the node's replicated COPIES of peer shifts and days
    -- go stale after close (append-only; updates are not re-offered until
    -- Phase 2 events) — so the close screen must never read cash state from
    -- replicas. Staleness is shown, not hidden: the screen prints last_seen.
    -- Phase 2a: the distribution queries walk (device_id, seq) per replicated
    -- table — a peer catching up after a day off must not table-scan the
    -- node's orders on every pull.
    CREATE INDEX IF NOT EXISTS idx_orders_device_seq          ON orders (device_id, seq);
    CREATE INDEX IF NOT EXISTS idx_shifts_device_seq          ON shifts (device_id, seq);
    CREATE INDEX IF NOT EXISTS idx_float_tx_device_seq        ON float_transactions (device_id, seq);
    CREATE INDEX IF NOT EXISTS idx_expenses_device_seq        ON expenses (device_id, seq);
    CREATE INDEX IF NOT EXISTS idx_business_days_device_seq   ON business_days (device_id, seq);

    -- Phase 2b: mutations as events. A close or a void is a FACT that
    -- happened on one device, so it replicates like every other fact — an
    -- append-only row — instead of an UPDATE that replicas never see. applied
    -- is local bookkeeping (0 = target not yet mutated here, 1 = done,
    -- -1 = refused: the event named a row its origin does not own) and is
    -- deliberately NOT replicated, same as sync_status.
    CREATE TABLE IF NOT EXISTS events (
      id           TEXT PRIMARY KEY,
      business_id  TEXT,
      branch_id    TEXT,
      device_id    TEXT,
      seq          INTEGER,
      kind         TEXT NOT NULL,        -- shift_closed | day_closed | order_voided
      target_table TEXT NOT NULL,
      target_id    TEXT NOT NULL,
      payload      TEXT NOT NULL,        -- JSON column:value, applied through a per-kind whitelist
      created_at   TEXT NOT NULL,
      applied      INTEGER NOT NULL DEFAULT 0,
      sync_status  TEXT DEFAULT 'pending'
    );
    CREATE INDEX IF NOT EXISTS idx_events_device_seq ON events (device_id, seq);
    CREATE INDEX IF NOT EXISTS idx_events_unapplied  ON events (applied);

    -- Phase 2c: maintenance bookkeeping — prune timestamps, snapshot results,
    -- and the two knobs (retention days, snapshot count). A key/value table
    -- instead of device_config columns: device_config's save path lists its
    -- columns explicitly and every addition churns it.
    CREATE TABLE IF NOT EXISTS maintenance_state (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS node_peer_state (
      device_id   TEXT PRIMARY KEY,
      state       TEXT NOT NULL,             -- JSON: business_date, day open?, open drawers…
      updated_at  TEXT NOT NULL
    );

    -- The local counter behind seq. A single row per table rather than
    -- MAX(seq)+1 over the data: on a node those tables hold peers' rows too, and
    -- MAX over the mixed set would hand this device a number derived from
    -- somebody else's counter.
    CREATE TABLE IF NOT EXISTS device_seq (
      table_name  TEXT PRIMARY KEY,
      next_seq    INTEGER NOT NULL DEFAULT 1
    );

    -- The outbound mirror of peer_cursors: how far this till has offered its own
    -- rows to the node. Without it, node_queue would have to be kept forever —
    -- pruning a delivered row would make the next scan re-enqueue it, and a
    -- till that has traded for a year would rescan a year of orders every pass.
    --
    -- Separate from peer_cursors rather than keyed by this device's own id in
    -- that table. The two answer different questions ("what have I taken FROM X"
    -- versus "what have I given TO the node"), and one table answering both is
    -- how somebody eventually reads the wrong one.
    CREATE TABLE IF NOT EXISTS outbox_cursors (
      table_name  TEXT PRIMARY KEY,
      last_seq    INTEGER NOT NULL DEFAULT 0,
      updated_at  TEXT NOT NULL
    );
  `);

  // Partial indexes on the two hot "mine" predicates. On the node these tables
  // hold several terminals' rows, so status alone stops being selective.
  db.exec(`
    CREATE INDEX IF NOT EXISTS shifts_own_open_idx
      ON shifts (device_id, status, opened_at);
    CREATE INDEX IF NOT EXISTS business_days_own_idx
      ON business_days (device_id, status, business_date);
    -- (device_id, seq) is the replication address; every "what has X made since
    -- N" question reads exactly this shape.
    CREATE INDEX IF NOT EXISTS orders_replication_idx
      ON orders (device_id, seq);
    CREATE INDEX IF NOT EXISTS shifts_replication_idx
      ON shifts (device_id, seq);
    CREATE INDEX IF NOT EXISTS business_days_replication_idx
      ON business_days (device_id, seq);
  `);

  migrateColumns(db, 'device_config', [
    ['device_id', 'TEXT'],
    ['device_role', "TEXT NOT NULL DEFAULT 'till'"],
    ['node_url', 'TEXT'],
    // Shared secret for the branch LAN channel (X-Node-Secret). Nullable so
    // existing installs migrate cleanly; the node mints one on first start.
    ['node_secret', 'TEXT'],
    // Short terminal identifier ('T1', 'T2'...). Prefixes every bill number so
    // three tills in one branch cannot mint the same one.
    ['terminal_code', 'TEXT'],
    // Business VAT rate, refreshed from /api/pos/init on every catalogue pull.
    // The till used to hardcode 16, which computed the wrong tax for any
    // business on a different rate and printed it on the customer's receipt.
    ['vat_rate', 'REAL'],
    // Catering/Tourism Levy percentage, same refresh path as vat_rate.
    ['ctl_rate', 'REAL'],
    // Discount ceiling the server enforces on write, same refresh path again.
    // Cached so an offline till clamps to the real policy rather than guessing.
    ['max_discount_pct', 'REAL'],
    // Owner-authored receipt text, refreshed by each catalogue pull. Cached
    // locally so an offline till still prints the right address and footer.
    ['receipt_header', 'TEXT'],
    ['receipt_footer', 'TEXT'],
    // 24-hour / continuous operation (A104): 1 = never hard-lock on rollover,
    // just a grace banner. Per business, cached from init on every pull.
    ['continuous_operation', 'INTEGER'],
    // Thermal (ESC/POS) printing on THIS terminal.
    //
    // DEFAULTS ON as of 0.5.27. It defaulted OFF while the HTML path was the
    // fallback — "a till that prints nothing during service is worse than one
    // that prints slowly", and that was right at the time. The HTML sale path is
    // now gone (thermal ran a full service on 2026-08-10, dispatch slips
    // included), so OFF no longer means "print the old way" — it means print
    // NOTHING. The old default is now the dangerous one.
    //
    // A new column on an existing install takes this default too, so a till
    // upgrading straight from an HTML build lands ON. Tills that were switched
    // on during the trial already hold 1; the backfill below covers any that
    // were explicitly set to 0. See main/escposBridge.ts.
    ['escpos_enabled', 'INTEGER NOT NULL DEFAULT 1'],
    // JSON array of names that must never reach a kitchen ticket. Owner-stated,
    // pulled with the catalogue, cached so an offline till still honours it.
    // This is the CLOUD BASELINE (business-wide, dashboard-edited).
    ['kitchen_exclusions', 'TEXT'],
    // Per-terminal local override. NULL = follow the cloud baseline above;
    // non-NULL (a JSON array, possibly empty) = this terminal's own list, which
    // WINS over the baseline and is never overwritten by a catalogue pull. This
    // is how a local edit is "final" while the cloud default keeps updating.
    ['kitchen_exclusions_override', 'TEXT'],
  ]);

  // 0.5.27 one-time backfill. Changing a column DEFAULT does not touch rows that
  // already exist, so a till that ran the trial with thermal OFF would keep 0 —
  // and with the HTML sale path removed it would print nothing at all. Guarded
  // by a marker row so a manager who deliberately switches it off later is not
  // overridden on the next boot.
  try {
    const done = db.prepare(
      `SELECT value FROM maintenance_state WHERE key = 'escpos_default_on_0527'`).get() as
      { value?: string } | undefined;
    if (!done) {
      db.prepare(`UPDATE device_config SET escpos_enabled = 1 WHERE escpos_enabled = 0`).run();
      db.prepare(
        `INSERT OR REPLACE INTO maintenance_state (key, value, updated_at)
         VALUES ('escpos_default_on_0527', 'applied', ?)`
      ).run(new Date().toISOString());
    }
  } catch {
    // maintenance_state absent on a build predating schema 49. The column
    // default covers new installs; this is belt and braces, never a reason to
    // fail startup.
  }
  migrateColumns(db, 'order_items', [
    ['course', 'TEXT'],
    ["fire_status", "TEXT DEFAULT 'fired'"],
  ]);
  migrateColumns(db, 'products', [
    ['barcode', 'TEXT'],
    ['plu',     'TEXT'],
    ['is_fuel', 'INTEGER DEFAULT 0'],
    // Per-branch price override for the branch this till is bound to (nullable).
    // Effective price = branch_price ?? base_price. See BRANCH_AUTHORITY_AND_SYNC_DESIGN.md §6.
    ['branch_price', 'REAL'],
    // Kitchen routing override (migration 38). NULL = follow the category,
    // which is why it is nullable INTEGER rather than a 0/1 default: "nobody
    // has said" and "explicitly not kitchen" are different answers.
    ['is_kitchen', 'INTEGER'],
  ]);
}

// Adds columns that don't yet exist on a table (SQLite has no ADD COLUMN IF NOT EXISTS).
/**
 * The local schema generation this build ships.
 *
 * Bumped whenever localDb.ts gains a table or column. Reported to the server on
 * every sync so a terminal running an old build is VISIBLE rather than
 * discovered when its push starts failing at 06:00 — the till updates by
 * installing an .exe by hand, so some terminal is always behind.
 *
 * Numbered to track the Postgres migration it pairs with: 42 = the schema after
 * migrations 41 and 42. 43 adds orders.covers locally — Postgres already had it,
 * so there is no migration 43; the number moves because a till on 42 cannot send
 * covers and its reports will read APC as unavailable.
 */
// 44: device_id on expenses and float_transactions, so all five replicated
// tables can be scoped to the terminal that created them. Additive and
// nullable, but REQUIRED_DESKTOP_SCHEMA moves with it: a 43 till acting as the
// branch NODE would ingest peer rows it cannot tell apart from its own.
//
// 45: branch replication. `seq` on the five replicated tables (per-device
// monotonic, assigned at creation, never rewritten on ingest), node_queue as
// the till's outbox to the branch node, peer_cursors as the per-peer high-water
// mark, device_seq as the counter behind seq. Plus orders.pump_id, which
// Postgres has always had and this schema never did — riding along rather than
// causing a second rebuild.
//
// 44 and 45 will in practice ship in the same installer, since no till was ever
// built from 44. REQUIRED_DESKTOP_SCHEMA must reach 45 in that same release: a
// node on 44 would ingest peer rows with no seq, and every one of them would be
// invisible to the cursor that decides what still needs replicating.
// 52 adds device_config.kitchen_exclusions_override — a per-terminal local
// override that wins over the synced cloud baseline. Additive and idempotent
// like every column here; an older till converges by running migrateColumns.
export const LOCAL_SCHEMA_VERSION = 52;

/** What this install has actually applied, for support and for skipping backfills. */
export function getLocalSchemaVersion(): number {
  try {
    const row = getLocalDb().prepare(
      `SELECT version FROM schema_version WHERE id=1`).get() as { version: number } | undefined;
    return row?.version ?? 0;
  } catch {
    return 0;   // table predates this mechanism
  }
}

function migrateColumns(db: Database.Database, table: string, cols: [string, string][]) {
  const existing = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map(c => c.name)
  );
  for (const [name, def] of cols) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
    }
  }
}
