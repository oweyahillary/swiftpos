-- =============================================================================
-- SwiftPOS — Branch Printers
-- =============================================================================
-- Stores printer profiles per branch.
-- Each printer has a type (receipt/kitchen/bar/expeditor/kot) and an optional
-- category filter so e.g. the kitchen printer only gets food items.
-- =============================================================================

CREATE TABLE IF NOT EXISTS branch_printers (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id         UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id           UUID NOT NULL REFERENCES branches(id)   ON DELETE CASCADE,

  name                VARCHAR(255) NOT NULL,        -- display name, e.g. "Kitchen Printer"
  printer_name        VARCHAR(255),                 -- OS / QZ printer name, e.g. "EPSON TM-T20III"
  type                VARCHAR(30)  NOT NULL DEFAULT 'receipt'
                        CHECK (type IN ('receipt','kitchen','bar','expeditor','kot')),

  paper_width         SMALLINT     NOT NULL DEFAULT 80
                        CHECK (paper_width IN (58, 80)),

  -- Category filter: empty array = print ALL items.
  -- Non-empty = only print items whose category_id is in this list.
  category_ids        UUID[]       NOT NULL DEFAULT '{}',

  -- Which printer produces the customer-facing receipt
  is_default_receipt  BOOLEAN      NOT NULL DEFAULT FALSE,

  -- QZ Tray / connection type preference
  -- 'qz'      = use QZ Tray (silent)
  -- 'browser' = window.print() fallback
  connection_type     VARCHAR(20)  NOT NULL DEFAULT 'browser'
                        CHECK (connection_type IN ('qz', 'browser')),

  enabled             BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_branch_printers_branch
  ON branch_printers(branch_id);
CREATE INDEX IF NOT EXISTS idx_branch_printers_business
  ON branch_printers(business_id);

-- RLS
ALTER TABLE branch_printers ENABLE ROW LEVEL SECURITY;

CREATE POLICY owner_all ON branch_printers
  FOR ALL USING (
    business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
  );

-- Seed permissions
INSERT INTO permissions (key, label, module) VALUES
  ('printers.view',   'View printers',   'Settings'),
  ('printers.manage', 'Manage printers', 'Settings')
ON CONFLICT (key) DO NOTHING;
