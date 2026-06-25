// Local SQLite database — offline-first POS terminal
import Database from 'better-sqlite3';
import path from 'path';
import { app } from 'electron';

const DB_PATH = path.join(app.getPath('userData'), 'swiftpos.db');
let _db: Database.Database | null = null;

export function getLocalDb(): Database.Database {
  if (_db) return _db;

  _db = new Database(DB_PATH);
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
  migrateColumns(db, 'orders', [
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
    // Desktop multi-till — which physical terminal created this order.
    ['device_id', 'TEXT'],
  ]);
  // Desktop multi-till identity + aggregation-node role on the device config.
  migrateColumns(db, 'device_config', [
    ['device_id', 'TEXT'],
    ['device_role', "TEXT NOT NULL DEFAULT 'till'"],
    ['node_url', 'TEXT'],
  ]);
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
  ]);
}

// Adds columns that don't yet exist on a table (SQLite has no ADD COLUMN IF NOT EXISTS).
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
