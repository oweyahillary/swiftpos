// "Kifaru Fuel & Mart", Thika Road: a FICTIONAL demo petrol station (src/assets/demo-brands) for the pumps shots: five
// pumps, three grades, the forecourt shop's items with their photos (public/demo-products, licensed stock), and the
// brand's colour and logo (branding:get). Loaded after mock.js with EXTRA=petrol.js.
(() => {
  const D = window.__DATA; const BIZ = 'biz-3', BR = 'br-1', NAME = 'Kifaru Fuel & Mart', BRANCH = 'Thika Road';
  let n = 0;
  const P = (name, price, cat, img, extra) => Object.assign({ id: 'fp' + (++n), name, price, base_price: price, selling_price: price, category_id: cat, status: 'active',
    description: null, track_stock: true, vat_rate: 16, sort_order: n, barcode: String(6161200000000 + n), image_url: img ? `/demo-products/${img}.webp` : null }, extra || {});
  const F = { is_fuel: true, barcode: null, unit_label: 'L' };
  const cats = [{ id: 'g1', name: 'Fuel', sort_order: 0 }, { id: 'g2', name: 'Lubricants', sort_order: 1 }, { id: 'g3', name: 'Shop', sort_order: 2 }, { id: 'g4', name: 'Gas', sort_order: 3 }];
  const products = [
    P('Super Petrol', 184.5, 'g1', null, F), P('Diesel', 171.6, 'g1', null, F), P('Kerosene', 155.2, 'g1', null, F),
    P('Engine Oil 1L', 850, 'g2', 'engine-oil'), P('Engine Oil 4L', 3100, 'g2', 'engine-oil'), P('Coolant 1L', 450, 'g2', 'coolant'),
    P('Water 1L', 70, 'g3', 'water'), P('Soda 500ml', 80, 'g3', 'soda'), P('Crisps 100g', 120, 'g3', 'crisps'),
    P('Gas Refill 6kg', 1250, 'g4', 'gas-refill'), P('Gas Refill 13kg', 2950, 'g4', 'gas-refill'),
  ];
  const pump = (i, fuel) => ({ id: 'pm' + i, name: 'Pump ' + i, status: 'idle', sort_order: i, fuel_product_id: fuel.id, fuel_product_name: fuel.name, price_per_litre: fuel.price });
  const pumps = [pump(1, products[0]), pump(2, products[0]), pump(3, products[1]), pump(4, products[1]), pump(5, products[2])];
  const cfg = window.__F['config:get']();
  const who = () => ({ ...D.me(), staff: { id: 'u-brian', name: 'Brian' }, branchName: BRANCH });
  window.__EXTRA = {
    'config:get': () => ({ ...cfg, business_type: 'petrol_station', terminal_code: 'TR-T1' }),
    'auth:getSession': () => ({ till: { device_id: 'dev-1' }, business: { id: BIZ, name: NAME, currency: 'KES', type: 'petrol_station' }, business_id: BIZ, business_name: NAME, currency: 'KES' }),
    'auth:listBranches': () => [{ id: BR, name: BRANCH, desktop_licensed: true }],
    'auth:verifyPin': who,
    'auth:getStaffSession': who,
    'branding:get': () => ({ themeId: 'ocean', accentHex: '#D99A00', logoPng: '/demo-brands/kifaru-fuel-mark.png', logoReceipt: null, receiptLogoEnabled: true }),
    'pos:init': () => ({ products, categories: cats, menus: [], branchId: BR, branchName: BRANCH, vatRate: 16, ctlRate: 0, maxDiscountPct: 20, comboItems: {}, kitchenCategories: [], receiptHeader: '', receiptFooter: '' }),
    'pos:getPumps': () => pumps,
    'orders:nextBillNumber': () => 'TR-0871',
  };
})();
