import { z } from 'zod';

// ── Shared primitives ─────────────────────────────────────────────────────────

const uuid = z.string().uuid('Must be a valid UUID');
const nonEmptyString = z.string().min(1, 'Cannot be empty');

// ── Auth ──────────────────────────────────────────────────────────────────────

export const LoginSchema = z.object({
  email: z.string().email('Must be a valid email'),
  password: z.string().min(1, 'Password is required'),
  business_id: uuid.optional(),
});

// ── Orders ────────────────────────────────────────────────────────────────────

const OrderItemSchema = z.object({
  product: z.object({
    id: uuid,
    name: nonEmptyString,
    categories: z.object({ name: z.string() }).nullable().optional(),
  }),
  unitPrice: z.number().nonnegative(),
  quantity: z.number().int().positive(),
  lineTotal: z.number().nonnegative(),
  selectedVariants: z.array(z.object({
    groupName: nonEmptyString,
    optionName: nonEmptyString,
    priceAdjustment: z.number(),
  })).optional().default([]),
  selectedModifiers: z.array(z.object({
    groupName: nonEmptyString,
    optionName: nonEmptyString,
    price: z.number().nonnegative(),
  })).optional().default([]),
});

const PaymentSchema = z.object({
  method: z.enum(['cash', 'card', 'mpesa', 'loyalty', 'split', 'other']),
  amount: z.number().nonnegative(),
  amount_tendered: z.number().nonnegative().optional(),
  change_given: z.number().nonnegative().optional().default(0),
  reference: z.string().optional().nullable(),
});

export const CreateOrderSchema = z.object({
  branch_id: uuid,
  order_number: nonEmptyString,
  order_type: z.enum(['retail', 'dine_in', 'takeaway', 'delivery']).default('retail'),
  subtotal: z.number().nonnegative(),
  vat_amount: z.number().nonnegative(),
  total: z.number().nonnegative(),
  items: z.array(OrderItemSchema).min(1, 'Order must have at least one item'),
  payment: PaymentSchema,
  // Loyalty (all optional)
  customer_id: uuid.optional().nullable(),
  customer_name: z.string().optional().nullable(),
  customer_phone: z.string().optional().nullable(),
  points_redeemed: z.number().int().nonnegative().default(0),
  discount_amount: z.number().nonnegative().default(0),
  discount_id: uuid.optional().nullable(),
  shift_id: uuid.optional().nullable(),
  table_id: uuid.optional().nullable(),
});

// ── Products ──────────────────────────────────────────────────────────────────

export const CreateProductSchema = z.object({
  name: nonEmptyString.max(120),
  description: z.string().max(500).optional(),
  base_price: z.number().nonnegative(),
  category_id: uuid.optional().nullable(),
  image_url: z.string().url().optional().nullable(),
  track_stock: z.boolean().default(true),
  has_variants: z.boolean().default(false),
  has_modifiers: z.boolean().default(false),
});

export const UpdateProductSchema = CreateProductSchema.partial().extend({
  status: z.enum(['active', 'inactive']).optional(),
});

// ── Categories ────────────────────────────────────────────────────────────────

export const CreateCategorySchema = z.object({
  name: nonEmptyString.max(80),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Must be a hex colour e.g. #22c55e').optional(),
  icon: z.string().optional(),
  sort_order: z.number().int().nonnegative().default(0),
});

// ── Branches ──────────────────────────────────────────────────────────────────

export const CreateBranchSchema = z.object({
  name: nonEmptyString.max(100),
  address: z.string().optional(),
  phone: z.string().optional(),
});

export const UpdateBranchSchema = CreateBranchSchema.partial().extend({
  status: z.enum(['active', 'inactive']).optional(),
});

// ── Staff ─────────────────────────────────────────────────────────────────────

export const CreateStaffSchema = z.object({
  name: nonEmptyString.max(100),
  email: z.string().email().optional().nullable(),
  phone: z.string().optional().nullable(),
  role_id: uuid,
  pin: z.string().regex(/^\d{4,6}$/, 'PIN must be 4–6 digits'),
  branch_ids: z.array(uuid).optional().default([]),
  // Per-user manager-override PIN. 4–6 digits to set; '' to clear (revoke
  // override authority); omit to leave unchanged. Validated again in the handler.
  override_pin: z.string().optional().nullable(),
  // Per-user permission overrides relative to the role defaults.
  overrides: z.array(z.object({ permission_id: uuid, granted: z.boolean() })).optional(),
  hourly_rate: z.union([z.number(), z.string(), z.null()]).optional(),
});

export const UpdateStaffSchema = CreateStaffSchema.partial().extend({
  status: z.enum(['active', 'inactive']).optional(),
});

// ── Shifts ────────────────────────────────────────────────────────────────────

export const OpenShiftSchema = z.object({
  branch_id: uuid,
  opening_float: z.number().nonnegative(),
});

export const CloseShiftSchema = z.object({
  closing_float: z.number().nonnegative(),
  notes: z.string().nullable().optional(),
  // Optional note×count map captured by the denomination counter, e.g.
  // { "1000": 3, "500": 5 }. When present, the server verifies it sums to
  // closing_float. Keys are denomination values as strings.
  denomination_breakdown: z.record(z.string(), z.number().nonnegative()).optional(),
});

// ── Discounts ─────────────────────────────────────────────────────────────────

export const CreateDiscountSchema = z.object({
  name: nonEmptyString.max(80),
  type: z.enum(['percentage', 'fixed']),
  value: z.number().positive(),
  applies_to: z.string().optional().default('order'),
  promo_code: z.string().optional().nullable(),
  min_order_value: z.number().nonnegative().optional().default(0),
  max_uses: z.number().int().positive().optional().nullable(),
  expires_at: z.string().datetime().optional().nullable(),
});

// ── Expenses ──────────────────────────────────────────────────────────────────

export const CreateExpenseSchema = z.object({
  branch_id: uuid,
  category: nonEmptyString.max(60),
  description: z.string().optional(),
  amount: z.number().positive(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD'),
  receipt_url: z.string().url().optional().nullable(),
});
