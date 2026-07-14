import { useBusiness } from '../context/BusinessContext';

// Vertical-aware wording so the UI speaks the right dialect per business type:
// a restaurant/café sees "Menu Items / Menu Sections / Set Meals", while a
// minimart/retail business sees "Products / Categories / Combos". Keep this the
// single source of truth for these words — nav labels, page titles and buttons
// all read from here so they never drift apart.

const FOOD_VERTICALS = ['restaurant', 'cafe'];

export type TermKey =
  | 'product'  | 'products'
  | 'category' | 'categories'
  | 'promotion'| 'promotions'
  | 'combo'    | 'combos'
  | 'inventory';

const FOOD_TERMS: Record<TermKey, string> = {
  product:   'Menu Item',    products:   'Menu Items',
  category:  'Menu Section', categories: 'Menu Sections',
  promotion: 'Special',      promotions: 'Specials',
  combo:     'Set Meal',     combos:     'Set Meals',
  inventory: 'Bar & Packaged Stock',
};

const RETAIL_TERMS: Record<TermKey, string> = {
  product:   'Product',    products:   'Products',
  category:  'Category',   categories: 'Categories',
  promotion: 'Promotion',  promotions: 'Promotions',
  combo:     'Combo',      combos:     'Combos',
  inventory: 'Inventory',
};

export interface Terminology {
  isFood: boolean;
  /** Title-case term, e.g. term('products') -> "Menu Items" */
  term: (key: TermKey) => string;
  /** Lower-case term, handy for inline sentences/placeholders. */
  lower: (key: TermKey) => string;
}

export function useTerm(): Terminology {
  const { business } = useBusiness();
  // Unknown type (still loading) defaults to food wording, matching the nav.
  const isFood = !business?.type || FOOD_VERTICALS.includes(business.type);
  const table = isFood ? FOOD_TERMS : RETAIL_TERMS;
  const term = (key: TermKey) => table[key];
  const lower = (key: TermKey) => table[key].toLowerCase();
  return { isFood, term, lower };
}
