/**
 * businessTerms.ts — A573: the words each kind of business reads, and which food-service areas it sees. ONE file.
 *
 * Owner, 2026-10-22 (Magas Limited, a retail business, showed "Menus" under Catalogue — "Group your categories into menus —
 * Food, Soft drinks, Alcohol, Tea"): "the items in the navigation bar, strangley enough in retail businness their is a menu
 * item … please read all business menu and name items correctly ensure hotel references hav been removed everywere and
 * correct items replace them". ("Hotel" is Kenyan usage for an eatery: food-service words and features showing up for a
 * shop.)
 *
 * The grouping of categories (the `menus` table, A537; the top tabs on the POS, A566) is the SAME feature for every type —
 * only its name changes: a restaurant or café has Menus (Food, Soft drinks …), a shop, minimart or a petrol station's shop
 * has Departments (Groceries, Beverages …), a car park or any other business has Groups. Nothing in the database or the
 * API is renamed; this is wording and what is shown.
 *
 * Food-service areas (kitchen display, reservations, combo meals, ingredients, table turnover, tables and floor plan,
 * room charge) are shown to restaurants and cafés only — the dashboard already hid most of them (A133); this file is now
 * where that list lives. A business whose type is not known yet (still loading) reads the food words, as the dashboard
 * always did.
 *
 * Pure: no imports. Copied verbatim to the web dashboard, the till and (A575: analyticsTerms.ts builds on it) the cloud
 * (scripts/check-shared-sync.mjs).
 */

export const BUSINESS_TYPE_KEYS = ['restaurant', 'cafe', 'retail', 'minimart', 'parking', 'petrol_station', 'other'] as const;
export type BusinessTypeKey = (typeof BUSINESS_TYPE_KEYS)[number];

/** The types that run a kitchen and serve food (Kenya: "hotels"). */
export const FOOD_SERVICE_TYPES: readonly BusinessTypeKey[] = ['restaurant', 'cafe'];

/**
 * The business's type as one of BUSINESS_TYPE_KEYS: lower case, spaces as underscores ("Petrol Station" →
 * petrol_station). Blank (not known yet) → null; anything else unknown → 'other' (as the till's and the web POS's
 * deriveMode).
 */
export function businessTypeOf(raw: string | null | undefined): BusinessTypeKey | null {
  const t = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, '_');
  if (!t) return null;
  return (BUSINESS_TYPE_KEYS as readonly string[]).includes(t) ? (t as BusinessTypeKey) : 'other';
}

/** A restaurant or café — or a type not known yet (the food words, as the dashboard always showed while loading). */
export function isFoodService(raw: string | null | undefined): boolean {
  const t = businessTypeOf(raw);
  return t === null || FOOD_SERVICE_TYPES.includes(t);
}

export interface BusinessTerms {
  type: BusinessTypeKey | null;
  food: boolean;
  /** What a group of categories is called: "Menu" / "Department" / "Group" (and the plural). */
  menu: string;
  menus: string;
  /** Examples for the help text and the placeholder. */
  menuExamples: readonly string[];
  /** The icon in the "Icon (optional)" placeholder. */
  menuIcon: string;
  /** The panel tab for every group: "All menus" / "All departments" / "All groups". */
  allMenus: string;
  /** A category in no group: "No menu" / "No department" / "No group". */
  noMenu: string;
  /** The web dashboard's catalogue section in the sidebar: "Menu" / "Catalogue". */
  catalogueGroup: string;
  /** The till's and the manager portal's catalogue page: "Menu" / "Products". */
  catalogue: string;
  /** The web dashboard's stock section in the sidebar: "Inventory" / "Stock". */
  stockGroup: string;
  /** Settings › Business › the type's own setup tab. */
  setupLabel: string;
  /** The phone's cart → back to the item grid. */
  backToGrid: string;
  /** "<item> back on the menu" / "<item> back on sale" (an item switched on again). */
  backOnSale: string;
  /** The spreadsheet import: "menu" / "products" ("Import menu from a spreadsheet" / "Import products …"). */
  importWhat: string;
  product: string; products: string;
  category: string; categories: string;
  promotion: string; promotions: string;
  combo: string; combos: string;
  inventory: string;
}

const FOOD_WORDS = {
  product: 'Menu Item', products: 'Menu Items',
  category: 'Menu Section', categories: 'Menu Sections',
  promotion: 'Special', promotions: 'Specials',
  combo: 'Set Meal', combos: 'Set Meals',
  inventory: 'Bar & Packaged Stock',
};
const SHOP_WORDS = {
  product: 'Product', products: 'Products',
  category: 'Category', categories: 'Categories',
  promotion: 'Promotion', promotions: 'Promotions',
  combo: 'Combo', combos: 'Combos',
  inventory: 'Inventory',
};

/** What each type calls a group of categories, with examples a business of that type would recognise. */
const GROUPING: Record<BusinessTypeKey, { one: string; many: string; examples: readonly string[]; icon: string }> = {
  restaurant:     { one: 'Menu', many: 'Menus', examples: ['Food', 'Soft drinks', 'Alcohol', 'Tea'], icon: '🍔' },
  cafe:           { one: 'Menu', many: 'Menus', examples: ['Food', 'Soft drinks', 'Alcohol', 'Tea'], icon: '🍔' },
  retail:         { one: 'Department', many: 'Departments', examples: ['Groceries', 'Beverages', 'Household', 'Personal care'], icon: '🛒' },
  minimart:       { one: 'Department', many: 'Departments', examples: ['Groceries', 'Beverages', 'Household', 'Personal care'], icon: '🛒' },
  petrol_station: { one: 'Department', many: 'Departments', examples: ['Lubricants', 'Shop', 'Gas', 'Car wash'], icon: '🛒' },
  parking:        { one: 'Group', many: 'Groups', examples: ['Parking', 'Car wash', 'Permits'], icon: '🅿️' },
  other:          { one: 'Group', many: 'Groups', examples: ['Services', 'Products', 'Accessories'], icon: '🏷️' },
};

const SETUP: Record<BusinessTypeKey, string> = {
  restaurant: 'Restaurant setup',
  cafe: 'Café setup',
  retail: 'Retail setup',
  minimart: 'Minimart setup',
  parking: 'Parking setup',
  petrol_station: 'Petrol setup',
  other: 'Setup',
};

/** The words a business of this type reads (unknown yet → a restaurant's, as the dashboard always did). */
export function businessTerms(raw: string | null | undefined): BusinessTerms {
  const type = businessTypeOf(raw);
  const food = isFoodService(raw);
  const g = GROUPING[type ?? 'restaurant'];
  const lower = g.many.toLowerCase();
  return {
    type,
    food,
    menu: g.one,
    menus: g.many,
    menuExamples: g.examples,
    menuIcon: g.icon,
    allMenus: `All ${lower}`,
    noMenu: `No ${g.one.toLowerCase()}`,
    catalogueGroup: food ? 'Menu' : 'Catalogue',
    catalogue: food ? 'Menu' : 'Products',
    stockGroup: food ? 'Inventory' : 'Stock',
    setupLabel: type ? SETUP[type] : 'Setup',
    backToGrid: food ? 'Back to the menu' : 'Back to the items',
    backOnSale: food ? 'back on the menu' : 'back on sale',
    importWhat: food ? 'menu' : 'products',
    ...(food ? FOOD_WORDS : SHOP_WORDS),
  };
}

/** Which food-service areas a business sees. Every one is a restaurant's or a café's only. */
export interface FoodAreas {
  /** Kitchen display (KDS) — the sidebar entry and Settings › Devices and printers › Kitchen display. */
  kds: boolean;
  reservations: boolean;
  /** Combo meals (the web Combos page). */
  combos: boolean;
  /** Ingredients (raw materials used up when a dish sells). */
  ingredients: boolean;
  /** Table turnover — the owner's Finance › Table Turnover and the manager portal's Turnover. */
  tableTurnover: boolean;
  /** Tables, floor plan, service model and menu periods (Settings › Business › setup). */
  tables: boolean;
  /** "Post to room" on the web POS. */
  roomCharge: boolean;
  /** The POS options about orders sent to a kitchen (Eat now, pay later · Pay before kitchen). */
  kitchenOptions: boolean;
}

export function foodAreas(raw: string | null | undefined): FoodAreas {
  const on = isFoodService(raw);
  return { kds: on, reservations: on, combos: on, ingredients: on, tableTurnover: on, tables: on, roomCharge: on, kitchenOptions: on };
}

/**
 * The permission catalogue's words as a business of this type reads them on Settings › Roles and permissions.
 * shared/permissions.ts's labels and descriptions are frozen (migration 134 registers them word for word, and its test
 * reads them), so a shop's words are put in place at display time: only the entries that talk about a menu, a kitchen
 * or tables change; everything else is shown as the catalogue has it. Every type reads "POS", never "till" (A586).
 */
export function permissionWords(raw: string | null | undefined, key: string, label: string, description: string):
  { label: string; description: string } {
  // A595: a key that was split into parts now means only what is left of it — its words say so, for every type.
  const sw = SPLIT_PARENT_WORDS[key];
  if (sw) { label = sw.label; description = sw.description; }
  if (isFoodService(raw)) return { label: posWording(label), description: posWording(description) };
  const t = businessTerms(raw);
  const w = shopPermissionWords(t)[key];
  return { label: posWording(w?.label ?? label), description: posWording(w?.description ?? description) };
}

/**
 * A595 (docs/PERMISSIONS-AUDIT.md section 5.1): the words of each key that was split into parts (shared/permissions.ts
 * SPLITS) — what the parent still guards on its own, the parts listed under it. Display only: the catalogue's own words
 * are frozen by migration 134.
 */
const SPLIT_PARENT_WORDS: Record<string, { label: string; description: string }> = {
  'sales.discount': { label: 'Give typed discounts (up to the limit)', description: 'Type a discount amount or percentage on a sale, up to the discount limit of the business' },
  'shifts.confirm': { label: 'Confirm drawers and see the expected cash', description: 'Confirm the drawers of cashiers at the end of a shift and see the cash each drawer should hold' },
  'menu.edit': { label: 'Add and change the menu', description: 'Add and change products, categories, variants, choices, extras and combos' },
  'menu.costs': { label: 'See cost prices', description: 'Cost prices and margins wherever they appear (menu, deliveries, stock) - changing them is its own right' },
  'inventory.receive': { label: 'Receive deliveries', description: 'Receive deliveries from suppliers and see the suppliers and purchase orders' },
  'inventory.adjust': { label: 'Change stock figures by hand', description: 'Change a stock figure by hand, close batches and void wastage' },
  'payables.manage': { label: 'Record supplier bills and returns', description: 'Record what is owed to suppliers, their bills and returns, and void them' },
  'customers.view': { label: 'See customers (phone numbers masked)', description: 'Customer records, points and credit balances, with phone numbers and e-mails masked' },
  'customers.edit': { label: 'Add and edit customers', description: 'Add customers and change their details' },
  'customers.credit': { label: 'Approve sales on account', description: 'Approve a sale on account with their PIN, and see the credit accounts' },
  'expenses.manage': { label: 'Add back-office expenses', description: 'Record an expense in the back office (not paid from a drawer)' },
  'expenses.record': { label: 'Record drawer expenses', description: 'Record an expense paid from their drawer - a manager approves every one with their PIN' },
  'staff.view': { label: 'See staff', description: 'The staff list of their branch: names, roles, branches and status' },
  'staff.edit': { label: 'Add and edit staff, their branches and role', description: 'Add staff, give them a role and branches, and deactivate them - never with more rights than they hold themselves' },
  'parking.manage': { label: 'Open and close parking tickets', description: 'Open and close parking tickets and take payment' },
  'fuel.manage': { label: 'Pumps on and off', description: 'Set pumps active or idle, and see the pumps and tanks' },
  'settings.business': { label: 'Business profile, hours and receipt rules', description: 'The business profile, opening hours and receipt rules' },
  'settings.integrations': { label: 'QR ordering', description: 'QR ordering: customers order from their phone at the table or counter' },
  'devices.approve': { label: 'Approve and rename POS devices', description: 'Approve or refuse a new POS device and rename one' },
  'changes.approve': { label: 'Approve menu changes made on a POS', description: 'Approve or refuse menu changes made on a POS' },
};

/** The catalogue's group words (PERMISSION_GROUPS) for this type — see permissionWords. */
export function permissionGroupWords(raw: string | null | undefined, id: string, label: string, description: string):
  { label: string; description: string } {
  if (isFoodService(raw)) return { label: posWording(label), description: posWording(description) };
  const w = SHOP_GROUP_WORDS[id];
  return { label: posWording(w?.label ?? label), description: posWording(w?.description ?? description) };
}

/**
 * A586 — owner, 2026-10-23: "ensure we use the word POS or point of sale instead of till". The product's own words say
 * POS; what is frozen in the old words (shared/permissions.ts's catalogue and built-in roles, registered word for word by
 * migrations 134 and 142) or read back from the database is put right here, at display time. Safaricom's M-Pesa
 * "Buy Goods till number" is M-Pesa's own name and stays. Beside "web POS", a till reads "desktop POS"; a plural in a
 * sentence reads "points of sale"; a label ("Tills", "Tills and devices") reads "POS".
 */
export function posWording(text: string): string {
  if (!text || !/till/i.test(text)) return text;
  const kept: string[] = [];
  let t = text.replace(/buy[\s-]*goods(?:\s*till)?(?:\s*(?:no\.?|numbers?))?|m-?pesa\s+till(?:\s*(?:no\.?|numbers?))?|\bTILL\s*NO\b/gi,
    (m) => { kept.push(m); return `\u0000${kept.length - 1}\u0000`; });
  const desk = /web POS/i.test(t);
  t = t.replace(/(?<![\w$@\-/.])(Till|till|TILL)(s|S)?(?![\w\-/])/g, (m: string, w: string, plural: string | undefined, at: number, all: string) => {
    const cap = w[0] === 'T';
    if (w === w.toUpperCase()) return 'POS';
    if (desk) return cap ? 'Desktop POS' : 'desktop POS';
    if (!plural) return 'POS';
    const next = all.slice(at + m.length);
    if (cap) return /^ [a-z]/.test(next) && !/^ and\b/.test(next) ? 'Points of sale' : 'POS';
    return /&\s*$/.test(all.slice(0, at)) || /^['’]/.test(next) ? 'POS' : 'points of sale';
  });
  return t.replace(/\u0000(\d+)\u0000/g, (_m, k: string) => kept[Number(k)]);
}

const SHOP_GROUP_WORDS: Record<string, { label?: string; description?: string }> = {
  orders: { description: 'The orders and shifts pages' },
  menu: { label: 'Catalogue', description: 'Products, prices and offers' },
};

function shopPermissionWords(t: BusinessTerms): Record<string, { label?: string; description?: string }> {
  return {
    'orders.create': { description: 'Ring up sales, hold and recall bills and take payment' },
    'reports.items': { label: 'Item mix' },
    'reports.costs': { description: 'Cost prices, margins, net profit and profit and loss' },
    'reports.analytics': { description: 'The Analytics pages: trends, item performance, branch comparisons and recommendations (money leaks also need Voids, refunds and exceptions)' },   // A595
    'orders.view_all': { label: 'Orders and shifts pages', description: 'See every order of the branch and its shifts' },
    'products.view': { label: 'See the products', description: 'Read the products and their prices' },
    'menu.edit': { label: 'Add and change the products',
      description: `Add and change products, categories, ${t.menus.toLowerCase()}, variants, choices and combos` },
    // A595: the parts of the menu keys, in a shop's words.
    'menu.delete': { label: `Delete products, categories and ${t.menus.toLowerCase()}`,
      description: `Delete products, categories, ${t.menus.toLowerCase()}, variants, choices and combos` },
    'menu.bulk': { label: 'Bulk changes to the products' },
    'menu.costs_edit': { description: 'Change the cost price of products, one at a time or many at once' },
    'sales.approve_kitchen_void': { label: 'Approve removing items already sent to print',
      description: 'Approve with their PIN taking an item off an order after it was sent to a print station' },
    'menu.costs': { description: 'Cost prices and margins wherever they appear (products, deliveries, stock) - changing them is its own right' },
    'settings.pos': { description: 'How the points of sale work: delivery fee and rider, pay later, sign-in codes and loyalty' },
    'stations.manage': { description: 'Printers, print stations and what prints where' },
    'changes.approve': { label: 'Approve product changes made on a POS', description: 'Approve or refuse product changes made on a POS' },
  };
}
