// "Kijani Basket" minimart, Kahawa West: a FICTIONAL demo business (src/assets/demo-brands) for the shop till shots.
// Departments as top tabs, barcoded products with their photos (image_url: public/demo-products, licensed stock, credits
// in src/data/photo-credits.json), two items sold by weight (A577), and the brand's colour and logo (branding:get).
// Loaded after mock.js with EXTRA=shop.js; it overrides through window.__EXTRA, which mock.js answers first.
(() => {
  const D = window.__DATA; const BIZ = 'biz-2', BR = 'br-1', NAME = 'Kijani Basket', BRANCH = 'Kahawa West';
  const menus = [
    { id: 'm1', name: 'Groceries', sort_order: 1, active: true },
    { id: 'm2', name: 'Beverages', sort_order: 2, active: true },
    { id: 'm3', name: 'Household', sort_order: 3, active: true },
    { id: 'm4', name: 'Personal care', sort_order: 4, active: true },
  ];
  const cats = [
    { id: 'c1', name: 'Dairy and eggs', sort_order: 1, menu_id: 'm1' }, { id: 'c2', name: 'Bakery', sort_order: 2, menu_id: 'm1' },
    { id: 'c3', name: 'Butchery', sort_order: 3, menu_id: 'm1' }, { id: 'c4', name: 'Fresh produce', sort_order: 4, menu_id: 'm1' },
    { id: 'c5', name: 'Flour, rice and sugar', sort_order: 5, menu_id: 'm1' },
    { id: 'c6', name: 'Drinks', sort_order: 6, menu_id: 'm2' }, { id: 'c7', name: 'Snacks', sort_order: 7, menu_id: 'm2' },
    { id: 'c8', name: 'Soap', sort_order: 8, menu_id: 'm4' },
  ];
  let n = 0;
  const P = (name, price, cat, img, extra) => Object.assign({ id: 'sp' + (++n), name, price, base_price: price, selling_price: price, category_id: cat, status: 'active',
    description: null, track_stock: true, vat_rate: 16, sort_order: n, barcode: String(6161100000000 + n), image_url: `/demo-products/${img}.webp` }, extra || {});
  const W = { sold_by: 'weight', unit_label: 'kg', barcode: null };
  const products = [
    P('Fresh Milk 500ml', 65, 'c1', 'fresh-milk'), P('Milk 1L', 120, 'c1', 'milk-1l'), P('Eggs (tray of 30)', 450, 'c1', 'eggs'),
    P('White Bread 400g', 65, 'c2', 'white-bread'), P('Brown Bread 600g', 90, 'c2', 'brown-bread'),
    P('Beef (per kg)', 650, 'c3', 'beef', W), P('Tomatoes (per kg)', 120, 'c4', 'tomatoes', W), P('Sukuma Wiki (bunch)', 20, 'c4', 'sukuma-wiki'),
    P('Maize Flour 2kg', 185, 'c5', 'maize-flour'), P('Rice 1kg', 220, 'c5', 'rice'), P('Sugar 1kg', 160, 'c5', 'sugar'), P('Cooking Oil 1L', 340, 'c5', 'cooking-oil'),
    P('Soda 500ml', 80, 'c6', 'soda'), P('Water 1L', 70, 'c6', 'water'), P('Mango Juice 1L', 180, 'c6', 'juice'), P('Crisps 100g', 120, 'c7', 'crisps'),
    P('Bar Soap 800g', 210, 'c8', 'bar-soap'),
  ];
  const cfg = window.__F['config:get']();
  const who = () => ({ ...D.me(), staff: { id: 'u-kevin', name: 'Kevin' }, branchName: BRANCH });
  window.__EXTRA = {
    'config:get': () => ({ ...cfg, business_type: 'minimart', terminal_code: 'KW-T1' }),
    'auth:getSession': () => ({ till: { device_id: 'dev-1' }, business: { id: BIZ, name: NAME, currency: 'KES', type: 'minimart' }, business_id: BIZ, business_name: NAME, currency: 'KES' }),
    'auth:listBranches': () => [{ id: BR, name: BRANCH, desktop_licensed: true }],
    'auth:verifyPin': who,
    'auth:getStaffSession': who,
    'branding:get': () => ({ themeId: 'teal', accentHex: '#1F7A3E', logoPng: '/demo-brands/kijani-basket-mark.png', logoReceipt: null, receiptLogoEnabled: true }),
    'pos:init': () => ({ products, categories: cats, menus, branchId: BR, branchName: BRANCH, vatRate: 16, ctlRate: 0, maxDiscountPct: 20, comboItems: {}, kitchenCategories: [], receiptHeader: '', receiptFooter: '' }),
    'orders:nextBillNumber': () => 'KW-2318',
  };
})();
