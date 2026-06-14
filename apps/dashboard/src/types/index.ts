export interface Business {
  id: string;
  name: string;
  type: string;
  currency: string;
  owner_id: string;
  status: string;
  address?: string | null;
  phone?: string | null;
  tax_pin?: string | null;
  vat_rate?: number;
}

export interface Category {
  id: string;
  business_id: string;
  name: string;
  color: string | null;
  icon: string | null;
  sort_order: number;
  status: 'active' | 'inactive';
  created_at: string;
}

export interface Product {
  id: string;
  business_id: string;
  category_id: string | null;
  name: string;
  description: string | null;
  base_price: number;
  image_url: string | null;
  has_variants: boolean;
  has_modifiers: boolean;
  track_stock: boolean;
  status: 'active' | 'inactive';
  created_at: string;
  // Minimart / barcode fields
  barcode?: string | null;
  plu_code?: string | null;
  sold_by?: 'each' | 'weight' | 'volume';
  // Petrol station fields
  is_fuel?: boolean;
  fuel_unit?: 'L' | 'gal' | null;
  // Inventory costing
  cost_price?: number | null;
  reorder_level?: number | null;
  // Joined relation
  categories?: Category | null;
}

export interface VariantOption {
  id: string;
  variant_group_id: string;
  name: string;
  price_adjustment: number;
  sort_order: number;
}

export interface VariantGroup {
  id: string;
  product_id: string;
  name: string;
  required: boolean;
  sort_order: number;
  variant_options: VariantOption[];
}

export interface ModifierOption {
  id: string;
  modifier_group_id: string;
  name: string;
  price: number;
  sort_order: number;
}

export interface ModifierGroup {
  id: string;
  product_id: string;
  name: string;
  min_select: number;
  max_select: number | null;
  sort_order: number;
  modifier_options: ModifierOption[];
}

// Selections made at the POS for a single cart item
export interface SelectedVariant {
  groupId: string;
  groupName: string;
  optionId: string;
  optionName: string;
  priceAdjustment: number;
}

export interface SelectedModifier {
  groupId: string;
  groupName: string;
  optionId: string;
  optionName: string;
  price: number;
}

/** Petrol station pump */
export interface Pump {
  id: string;
  business_id: string;
  branch_id: string | null;
  fuel_product_id: string | null;
  name: string;
  status: 'idle' | 'dispensing' | 'inactive' | 'error';
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/** Fuel storage tank */
export interface FuelTank {
  id: string;
  business_id: string;
  branch_id: string | null;
  fuel_product_id: string;
  name: string;
  capacity_litres: number;
  current_level: number;
  reorder_level: number;
  created_at: string;
  updated_at: string;
  products?: Pick<Product, 'id' | 'name' | 'base_price' | 'fuel_unit'>;
}

/** Parking bay session */
export interface ParkingSession {
  id: string;
  business_id: string;
  branch_id: string | null;
  bay_id: string;
  order_id: string | null;
  vehicle_plate: string | null;
  vehicle_type: string;
  rate_per_hour: number;
  started_at: string;
  ended_at: string | null;
  billed_hours: number | null;
  total_amount: number | null;
  status: 'open' | 'completed' | 'voided';
  created_at: string;
}

/** All order types the system supports */
export type OrderType =
  | 'retail'
  | 'dine_in'
  | 'takeaway'
  | 'delivery'
  | 'parking_session'
  | 'fuel_sale'
  | 'other';
