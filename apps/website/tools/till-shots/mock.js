// Sample data for the till's screens, answered in place of Electron's main process. Scenario state lives on window.__S
// (set by the harness before load): { role: 'cashier'|'manager', shiftOpen, shiftClosedAwaiting, dayClosed }.
(() => {
  const S = Object.assign({ role: 'cashier', shiftOpen: false, awaiting: false, dayClosed: false }, window.__SCENARIO || {});
  window.__S = S;
  const now = Date.now();
  const iso = (minAgo) => new Date(now - minAgo * 60000).toISOString();
  const BR = 'br-1', BIZ = 'biz-1';
  const cashier = { staff: { id: 'u-wanjiru', name: 'Wanjiru' }, role: 'cashier', permissions: { 'pos.sell': true }, branchId: BR, branchName: 'Ngong Road' };
  const manager = { staff: { id: 'u-otieno', name: 'Achieng' }, role: 'manager', permissions: { '*': true }, branchId: BR, branchName: 'Ngong Road' };
  const me = () => (S.role === 'manager' ? manager : cashier);
  const cats = [{ id: 'c1', name: 'Grill', sort_order: 1 }, { id: 'c2', name: 'Mains', sort_order: 2 }, { id: 'c3', name: 'Sides', sort_order: 3 }, { id: 'c4', name: 'Drinks', sort_order: 4 }, { id: 'c5', name: 'Breakfast', sort_order: 5 }];
  // 2026-10-23: each dish carries its photo (the product's image_url, as the till shows it), from the website's licensed
  // stock tiles (public/demo-products, credits in src/data/photo-credits.json), served by serve.cjs.
  const IMG = { 'Nyama Choma 1kg': 'nyama-choma', 'Nyama Choma 500g': 'nyama-choma-500', 'Chicken Wings': 'chicken-wings', 'Quarter Chicken': 'quarter-chicken',
    'Half Chicken': 'half-chicken', 'Mbuzi Ribs': 'mbuzi-ribs', 'Samosa (2)': 'samosa', 'Mishkaki': 'mishkaki', 'Tilapia Whole': 'tilapia', 'Pilau': 'pilau',
    'Chicken Burger': 'chicken-burger', 'Beef Burger': 'beef-burger', 'Chips Masala': 'chips-masala', 'Kachumbari': 'kachumbari', 'Ugali': 'ugali',
    'Chapati': 'chapati', 'Passion Juice': 'passion-fruit', 'Soda 500ml': 'soda', 'Masala Tea': 'masala-tea', 'Water 500ml': 'water' };
  const P = (id, name, price, cat, desc) => ({ id, name, price, base_price: price, selling_price: price, category_id: cat, status: 'active', description: desc ?? null, categories: { name: 'menu' }, track_stock: false, vat_rate: 16, sort_order: 0,
    image_url: IMG[name] ? `/demo-products/${IMG[name]}.webp` : null });
  const products = [
    P('p1', 'Nyama Choma 1kg', 1450, 'c1'), P('p2', 'Nyama Choma 500g', 800, 'c1'), P('p3', 'Chicken Wings', 650, 'c1'), P('p4', 'Quarter Chicken', 650, 'c1'),
    P('p5', 'Half Chicken', 1150, 'c1'), P('p6', 'Mbuzi Ribs', 950, 'c1'), P('p7', 'Samosa (2)', 120, 'c1'), P('p8', 'Mishkaki', 300, 'c1'),
    P('p9', 'Tilapia Whole', 1500, 'c2'), P('p10', 'Pilau', 550, 'c2'), Object.assign(P('p11', 'Chicken Burger', 650, 'c2'), { has_variants: true }), P('p12', 'Beef Burger', 750, 'c2'),
    Object.assign(P('p13', 'Chips Masala', 300, 'c3'), { has_variants: true }), P('p14', 'Kachumbari', 150, 'c3'), P('p15', 'Ugali', 100, 'c3'), P('p16', 'Chapati', 50, 'c3'),
    P('p17', 'Passion Juice', 250, 'c4'), P('p18', 'Soda 500ml', 100, 'c4'), P('p19', 'Masala Tea', 120, 'c4'), P('p20', 'Water 500ml', 80, 'c4'),
  ];
  const shift = () => ({ id: 'sh-1', business_id: BIZ, branch_id: BR, cashier_id: 'u-wanjiru', cashier_name: 'Wanjiru', opened_by_name: 'Wanjiru',
    opened_at: iso(420), closed_at: S.awaiting ? iso(5) : null, status: S.awaiting ? 'closed' : 'open', opening_float: 2000, closing_float: S.awaiting ? 14350 : null,
    expected_cash: 14350, cash_variance: S.awaiting ? 0 : null, awaiting_confirmation: S.awaiting ? 1 : 0, device_id: 'dev-1' });
  const pay = (m, a) => ({ method: m, amount: a });
  const orders = [
    { id: 'o1', order_number: 'NG-0142', order_type: 'dine_in', status: 'completed', total: 1800, created_at: iso(6), cashier_id: 'u-wanjiru', cashier_name: 'Wanjiru', payments: [pay('mpesa', 1800)], sync_status: 'synced' },
    { id: 'o2', order_number: 'NG-0141', order_type: 'takeaway', status: 'completed', total: 650, created_at: iso(14), cashier_id: 'u-wanjiru', cashier_name: 'Wanjiru', payments: [pay('cash', 650)], sync_status: 'synced' },
    { id: 'o3', order_number: 'NG-0140', order_type: 'dine_in', status: 'completed', total: 2450, created_at: iso(48), cashier_id: 'u-brian', cashier_name: 'Otieno', payments: [pay('cash', 1450), pay('mpesa', 1000)], sync_status: 'synced' },
    { id: 'o4', order_number: 'NG-0139', order_type: 'delivery', delivery_person: 'Glovo', status: 'completed', total: 1150, created_at: iso(95), cashier_id: 'u-brian', cashier_name: 'Otieno', payments: [pay('glovo', 1150)], sync_status: 'synced' },
    { id: 'o5', order_number: 'NG-0138', order_type: 'takeaway', status: 'voided', total: 350, created_at: iso(130), cashier_id: 'u-wanjiru', cashier_name: 'Wanjiru', payments: [pay('cash', 350)], sync_status: 'synced' },
  ];
  const F = {
    'config:isConfigured': () => true,
    'config:get': () => ({ web_pos_enabled: true, deploy_mode: 'cloud', server_url: 'https://api.example.com', branch_id: BR, business_type: 'restaurant', device_name: 'Counter', device_id: 'dev-1', device_role: 'till', node_url: null, node_secret: null, terminal_code: 'NG-T1', vat_rate: 16, ctl_rate: 0, max_discount_pct: 20, receipt_header: null, receipt_footer: null, configured: true }),
    'config:identity': () => ({ deviceId: 'dev-1', terminalCode: 'NG-T1', deviceName: 'Counter' }),
    'auth:getSession': () => ({ till: { device_id: 'dev-1' }, business: { id: BIZ, name: 'Mama Lishe Grill', currency: 'KES', type: 'restaurant' }, business_id: BIZ, business_name: 'Mama Lishe Grill', currency: 'KES' }),
    'auth:listBranches': () => [{ id: BR, name: 'Ngong Road', desktop_licensed: true }],
    'auth:verifyPin': () => me(),
    'auth:clearStaffSession': () => true,
    // Mama Lishe Grill's own branding (a FICTIONAL demo brand, src/assets/demo-brands): its colour on the till, its logo.
    'branding:get': () => ({ themeId: 'teal', accentHex: '#E4572E', logoPng: '/demo-brands/mama-lishe-grill-mark.png', logoReceipt: null, receiptLogoEnabled: true }),
    'tech:checkReveal': () => false,
    'idle:setSurface': () => true,
    'node:joinRequests': () => [],
    'auth:getStaffSession': () => me(),
    'pos:notePicks': () => ['No onions', 'Extra hot', 'Well done'],
    'pos:features': () => ({}),
    'pos:stockCountFreeze': () => ({ ref: null, productIds: [] }),
    'pos:init': () => ({ products, categories: cats, branchId: BR, vatRate: 16, ctlRate: 0, maxDiscountPct: 20, comboItems: {}, kitchenCategories: [], receiptHeader: '', receiptFooter: '' }),
    'pos:paymentMethods': () => [],
    'pos:getVariants': () => [{ id: 'vg1', name: 'Spice', required: true, variant_options: [{ id: 'vo1', name: 'Normal', price_adjustment: 0 }, { id: 'vo2', name: 'Spicy', price_adjustment: 0 }] }],
    'pos:getModifiers': () => [],
    'orders:nextBillNumber': () => 'NG-1042',
    'pos:offers': () => ({ offers: [], branchId: BR }),
    'pos:paymentMethodsEnabled': () => ({ enabled: ['cash', 'mpesa', 'card'] }),
    'pos:getTables': () => [1,2,3,4,5,6,7,8].map((n) => ({ id: 't' + n, name: 'T' + n, capacity: 4, sort_order: n, status: n === 2 || n === 5 ? 'occupied' : 'free' })),
    'device:identity': () => ({ deviceId: 'dev-1', terminalCode: 'NG-T1', deviceName: 'Counter' }),
    'sync:trigger': () => ({ pulled: false, pushed: 0, errors: [] }),
    'sync:status': () => ({ online: true, pendingCount: 0, failedCount: 0, lastSyncedAt: iso(1) }),
    'kitchen:open': () => ({ all: [], shift: [] }),
    'shift:stale': () => null,
    'day:gate': () => (S.shiftOpen || S.role === 'manager' ? { canTrade: true } : { canTrade: false, needsShift: true }),
    'day:current': () => ({ id: 'day-1', business_date: new Date(now).toISOString().slice(0, 10), status: S.dayClosed ? 'closed' : 'open' }),
    'update:getStatus': () => ({ state: 'idle', version: null, percent: null }),
    'held:list': () => [],
    'expense:categories': () => [{ id: 'e1', name: 'Supplies' }, { id: 'e2', name: 'Transport' }],
    'shift:canConfirm': () => S.role === 'manager',
    'escpos:printShiftReport': () => ({ ok: true }),
    'manager:branchDay': () => branchDay(),
    'manager:topProducts': () => branchDay().topProducts,
    'manager:tableOccupancy': () => [],
    'manage:listStations': () => [],
    'shift:confirmView': () => ({ showCashier: true, declared: { cash: 14350, mpesa: 18400, card: 4200, glovo: 0 } }),
    'shift:remoteConfirmView': () => ({ showCashier: true, declared: { cash: 14350, mpesa: 18400, card: 4200, glovo: 0 } }),
    'shift:zreport': () => zreport(),
    'day:summary': () => ({ day: { id: 'day-1', business_date: new Date(now).toISOString().slice(0, 10) }, shifts: 1, unreconciledShifts: 0, expectedCash: 14350, countedCash: 14350, variance: 0 }),
    'day:isManager': () => S.role === 'manager',
    'day:conflicts': () => [],
    'shift:awaiting': () => [],
    'day:close': () => { S.dayClosed = true; return { ok: true, summary: { day: { id: 'day-1', business_date: new Date(now).toISOString().slice(0, 10) }, shifts: 1, unreconciledShifts: 0, expectedCash: 14350, countedCash: 14350, variance: 0 } }; },
    'pos:history': () => ({ scope: { staffId: me().staff.id, manager: S.role === 'manager', ownOnly: false, canReprint: S.role === 'manager', methods: [], showTotal: true }, orders }),
    'pos:reversalRules': () => ({ voidWindowMinutes: 30, offlineRefundMethods: ['cash'], offlineReverseWebSales: false, freeDeliveryAllowed: false, freeDeliveryOver: null }),
    'shift:close': () => { S.awaiting = true; S.shiftOpen = false; return zreport(); },
    'shift:closeRights': () => ({ allowed: true, ownerName: null }),
    'shift:current': () => (S.shiftOpen || S.awaiting ? zreport() : null),
  };
  function zreport() {
    const sh = shift();
    return {
      businessName: 'Mama Lishe Grill', currency: 'KES',
      shift: { ...sh, notes: null },
      byMethod: [{ method: 'cash', amount: 12350, orders: 21 }, { method: 'mpesa', amount: 18400, orders: 26 }, { method: 'card', amount: 4200, orders: 3 }],
      totals: { orderCount: 53, grossSales: 38400, refunds: 0, netSales: 38400, vat: 5296.55, ctl: 0, tips: 0, voidCount: 1, cashSales: 12350, floatIn: 0, floatOut: 0, expectedCash: 14350, expenses: 0 },
    };
  }
  window.__zreport = zreport;
  function shiftRows() {
    const st = S.confirmed ? 'confirmed' : S.awaiting ? 'awaiting' : 'open';
    return [
      { id: 'sh-1', device_id: 'dev-1', till: 'Counter', this_till: true, cashier: 'Wanjiru', opened_at: iso(882), closed_at: st === 'open' ? null : iso(5), state: st, force_closed: false,
        confirmed_by: st === 'confirmed' ? 'Achieng' : null, opening_float: 2000, orders: 108, sales: 41250,
        by_method: [{ method: 'cash', amount: 12350 }, { method: 'mpesa', amount: 18400 }, { method: 'card', amount: 4200 }],
        expected_cash: 14550, counted_cash: st === 'open' ? null : 14200, variance: st === 'open' ? null : -350, declare_codes: ['mpesa', 'card'] },
      { id: 'sh-2', device_id: 'dev-2', till: 'Bar', this_till: false, cashier: 'Otieno', opened_at: iso(400), closed_at: st === 'open' ? null : iso(9), state: st, force_closed: false, confirmed_by: null,
        opening_float: 1000, orders: 31, sales: 21650, by_method: [{ method: 'cash', amount: 9150 }, { method: 'mpesa', amount: 12500 }],
        expected_cash: 10150, counted_cash: st === 'open' ? null : 10150, variance: st === 'open' ? null : 0, declare_codes: ['mpesa'] },
    ];
  }
  function branchDay() {
    const pm = { mpesa: 33500, cash: 21650, card: 4900 };
    return { source: 'cloud', scopeLabel: 'Ngong Road — all tills', fallbackReason: null, localCoversBranch: false,
      summary: { totalRevenue: 60050, totalOrders: 84, avgOrderValue: 714.88, totalVat: 8282.76, paymentMethods: pm },
      paymentMethods: pm,
      hourly: [8,9,10,11,12,13,14,15].map((h, i) => ({ hour: h, revenue: [1200, 3400, 4100, 6900, 12800, 14600, 9800, 7250][i], orders: [2, 5, 6, 9, 17, 20, 14, 11][i] })),
      byTill: [{ device_id: 'dev-1', label: 'Counter', this_till: true, orders: 53, revenue: 38400 }, { device_id: 'dev-2', label: 'Bar', this_till: false, orders: 31, revenue: 21650 }],
      shifts: shiftRows(),
      topProducts: [{ name: 'Nyama Choma 1kg', qty: 11, revenue: 15950 }, { name: 'Chicken Wings', qty: 14, revenue: 9100 }, { name: 'Chips Masala', qty: 24, revenue: 7200 }, { name: 'Tilapia Whole', qty: 4, revenue: 6000 }, { name: 'Passion Juice', qty: 22, revenue: 5500 }],
    };
  }
  window.__branchDay = branchDay;
  window.__F = F; window.__DATA = { products, cats, orders, shift, me, iso, S };
  window.__unknown = new Set();
  window.__ipc = async (ch, ...args) => {
    const extra = window.__EXTRA && window.__EXTRA[ch];
    if (extra) return extra(...args);
    if (F[ch]) return F[ch](...args);
    window.__unknown.add(ch);
    return null;
  };
})();
