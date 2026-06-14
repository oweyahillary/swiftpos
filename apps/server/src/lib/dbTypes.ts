/**
 * dbTypes.ts — Lightweight DB row types for the server routes.
 *
 * These are NOT generated — they're hand-written to match the actual schema
 * and cover the shapes most frequently misused as `any`.
 *
 * Priority: order/payment rows (money authority), shift rows (cash reconciliation),
 * and report aggregation rows (finance reporting).
 *
 * When `supabase gen types typescript` is run, delete this file and import
 * from the generated types instead. The generated types are more complete and
 * stay in sync with migrations automatically.
 *
 * Run to generate:
 *   npx supabase gen types typescript --project-id <ref> > src/lib/generated.types.ts
 */

// ── Orders ────────────────────────────────────────────────────────────────────

export interface DbOrder {
  id:               string;
  business_id:      string;
  branch_id:        string | null;
  cashier_id:       string | null;
  shift_id:         string | null;
  customer_id:      string | null;
  order_number:     string;
  order_type:       string;
  status:           'pending' | 'completed' | 'voided';
  subtotal:         string; // Postgres numeric → string
  discount_amount:  string;
  total:            string;
  vat_amount:       string;
  tip_amount:       string;
  void_reason:      string | null;
  voided_at:        string | null;
  voided_by:        string | null;
  idempotency_key:  string | null;
  created_at:       string;
  updated_at:       string;
}

export interface DbOrderItem {
  id:           string;
  order_id:     string;
  product_id:   string | null;
  product_name: string;
  category_name:string | null;
  quantity:     string;
  unit_price:   string;
  subtotal:     string;
  course:       string | null;
  fire_status:  string | null;
}

export interface DbPayment {
  id:        string;
  order_id:  string;
  method:    string;
  amount:    string;
  status:    'pending' | 'completed' | 'failed';
  reference: string | null;
  created_at:string;
}

// ── Products ──────────────────────────────────────────────────────────────────

export interface DbProduct {
  id:          string;
  business_id: string;
  name:        string;
  base_price:  string;
  status:      'active' | 'inactive';
  has_variants:boolean;
  has_modifiers:boolean;
  is_fuel:     boolean;
}

export interface DbVariantGroup {
  id:         string;
  product_id: string;
  name:       string;
  required:   boolean;
  variant_options: DbVariantOption[];
}

export interface DbVariantOption {
  id:               string;
  variant_group_id: string;
  name:             string;
  price_adjustment: string;
}

export interface DbModifierGroup {
  id:         string;
  product_id: string;
  name:       string;
  modifier_options: DbModifierOption[];
}

export interface DbModifierOption {
  id:                string;
  modifier_group_id: string;
  name:              string;
  price:             string;
}

// ── Shifts & cash ─────────────────────────────────────────────────────────────

export interface DbShift {
  id:                    string;
  business_id:           string;
  branch_id:             string;
  cashier_id:            string;
  status:                'open' | 'closed';
  opening_float:         string;
  closing_float:         string | null;
  expected_cash:         string | null;
  cash_variance:         string | null;
  notes:                 string | null;
  denomination_breakdown:Record<string, number> | null;
  opened_at:             string;
  closed_at:             string | null;
}

export interface DbFloatTransaction {
  id:        string;
  shift_id:  string;
  type:      'float_in' | 'float_out';
  amount:    string;
  reason:    string | null;
  created_at:string;
}

// ── Customers / credit ────────────────────────────────────────────────────────

export interface DbCustomer {
  id:             string;
  business_id:    string;
  name:           string;
  phone:          string | null;
  email:          string | null;
  credit_limit:   string;
  credit_balance: string;
  loyalty_points: number;
}

// ── Report row shapes ─────────────────────────────────────────────────────────
// These match the SELECT shapes used in reports.ts

export interface OrderWithPayments extends DbOrder {
  payments:    DbPayment[];
  order_items: DbOrderItem[];
  branches?:   { name: string } | null;
  users?:      { name: string } | null;
}

export interface ReportOrderRow {
  id:              string;
  status:          string;
  order_type:      string;
  subtotal:        string;
  discount_amount: string;
  total:           string;
  vat_amount:      string;
  shift_id:        string | null;
  branch_id:       string | null;
  cashier_id:      string | null;
  created_at:      string;
  payments:        Array<{ method: string; amount: string; status: string }>;
  order_items:     Array<{ category_name: string | null; subtotal: string }>;
  branches?:       { name: string } | null;
}

// ── Request body shapes ───────────────────────────────────────────────────────

export interface OrderItemInput {
  product?: { id: string; name: string } | null;
  productId?: string;
  quantity:  number | string;
  unitPrice: number | string;
  lineTotal?: number | string;
  selectedVariants?: Array<{
    groupName:   string;
    optionName:  string;
    priceAdjustment?: number;
  }>;
  selectedModifiers?: Array<{
    groupName: string;
    optionName:string;
    price?:    number;
  }>;
  course?:      string | null;
  fire_status?: string | null;
  isFuel?:      boolean;
}

export interface PaymentLegInput {
  method:    string;
  amount:    number | string;
  tendered?: number | string;
  reference?: string;
}
