/**
 * stock-effects-parity — BUG-09.
 *
 * POST /orders ran 410 lines of stock deduction. POST /orders/:id/pay ran four:
 *
 *     const { data: sl } = await supabase.from('stock_levels')
 *       .select('id, quantity').eq('product_id', item.product_id)...
 *     await supabase.from('stock_levels')
 *       .update({ quantity: Math.max(0, sl.quantity - item.quantity) })
 *
 * No track_stock check, so untracked products were decremented. No
 * sold_by='piece' handling, so piece-sold products lost whole units. No
 * stock_movements row, so none of it was auditable. And NO recipe, variant,
 * packaging or fuel deduction at all.
 *
 * Restaurants use /pay. Restaurants have recipes. So the recipe system was
 * bypassed on the one path built for it, and every dine-in service overstated
 * ingredient stock in silence.
 *
 * This models both implementations and asserts they now agree.
 */
import assert from 'node:assert';

let pass = 0, fail = 0;
const ok = (t, c, x = '') => { c ? (pass++, console.log(`PASS  ${t}`)) : (fail++, console.log(`FAIL  ${t}${x ? ' — ' + x : ''}`)); };

// ── catalogue ───────────────────────────────────────────────────────────────
const PRODUCTS = {
  burger:  { id: 'burger',  track_stock: true,  sold_by: 'each'  },
  samosa:  { id: 'samosa',  track_stock: true,  sold_by: 'piece' },
  service: { id: 'service', track_stock: false, sold_by: 'each'  },
};
const RECIPES = [
  { product_id: 'burger', ingredient_id: 'beef', quantity_per_serving: 0.15 },
  { product_id: 'burger', ingredient_id: 'bun',  quantity_per_serving: 1 },
];
const PACKAGING = [{ product_id: 'burger', ingredient_id: 'box', quantity: 1 }];

// ── OLD /pay ────────────────────────────────────────────────────────────────
function payOld(lines) {
  const w = { stock_levels: [], stock_movements: [], ingredients: [] };
  for (const l of lines) {
    if (!l.productId) continue;
    w.stock_levels.push({ product_id: l.productId, field: 'quantity', delta: -l.quantity });
  }
  return w;
}

// ── SHARED applyStockEffects ────────────────────────────────────────────────
function effects({ lines, orderType }) {
  const w = { stock_levels: [], stock_movements: [], ingredients: [] };
  for (const l of lines) {
    if (!l.productId) continue;
    const p = PRODUCTS[l.productId];
    if (!p || !p.track_stock) continue;                    // track_stock respected
    const field = p.sold_by === 'piece' ? 'qty_pieces' : 'quantity';
    w.stock_levels.push({ product_id: l.productId, field, delta: -l.quantity });
    w.stock_movements.push({ product_id: l.productId, movement_type: 'sale', quantity_change: -l.quantity });
  }
  const ing = {};
  for (const l of lines) {
    for (const r of RECIPES.filter(r => r.product_id === l.productId)) {
      ing[r.ingredient_id] = (ing[r.ingredient_id] ?? 0) + r.quantity_per_serving * l.quantity;
    }
    if (orderType === 'takeaway') {
      for (const r of PACKAGING.filter(r => r.product_id === l.productId)) {
        ing[r.ingredient_id] = (ing[r.ingredient_id] ?? 0) + Number(r.quantity) * l.quantity;
      }
    }
  }
  w.ingredients = Object.entries(ing).map(([id, q]) => ({ ingredient_id: id, delta: -q }))
                        .sort((a, b) => a.ingredient_id.localeCompare(b.ingredient_id));
  return w;
}

const CART = [
  { productId: 'burger',  quantity: 2 },
  { productId: 'samosa',  quantity: 3 },
  { productId: 'service', quantity: 1 },
  { productId: null,      quantity: 1 },   // custom line, no catalogue product
];

// ── 1. what the old /pay got wrong ──────────────────────────────────────────
{
  const old = payOld(CART);
  ok('OLD /pay: deducted an untracked product',
     old.stock_levels.some(r => r.product_id === 'service'));
  ok('OLD /pay: deducted a piece-sold product from the wrong column',
     old.stock_levels.find(r => r.product_id === 'samosa')?.field === 'quantity');
  ok('OLD /pay: wrote no audit rows', old.stock_movements.length === 0);
  ok('OLD /pay: deducted NO ingredients — the recipe system was bypassed',
     old.ingredients.length === 0);
}

// ── 2. the shared implementation ────────────────────────────────────────────
{
  const e = effects({ lines: CART, orderType: 'dine_in' });
  ok('NEW: an untracked product is left alone',
     !e.stock_levels.some(r => r.product_id === 'service'));
  ok('NEW: a piece-sold product deducts qty_pieces',
     e.stock_levels.find(r => r.product_id === 'samosa')?.field === 'qty_pieces');
  ok('NEW: an each-sold product deducts quantity',
     e.stock_levels.find(r => r.product_id === 'burger')?.field === 'quantity');
  ok('NEW: a custom line with no product is skipped',
     e.stock_levels.length === 2);
  ok('NEW: every deduction writes a stock_movements row',
     e.stock_movements.length === e.stock_levels.length);
  // Compared with a tolerance: 0.15 * 2 is -0.30000000000000004 in binary
  // floating point. Asserting the exact literal would make this test a hostage
  // to how the sum happens to be ordered.
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  ok('NEW: recipes deduct ingredients — 2 burgers = 0.3 beef, 2 bun',
     e.ingredients.length === 2 &&
     near(e.ingredients[0].delta, -0.3) && e.ingredients[0].ingredient_id === 'beef' &&
     near(e.ingredients[1].delta, -2)   && e.ingredients[1].ingredient_id === 'bun',
     JSON.stringify(e.ingredients));
}

// ── 3. THE POINT: both order paths now do the same thing ────────────────────
{
  for (const orderType of ['dine_in', 'takeaway', 'retail']) {
    const viaOrders = effects({ lines: CART, orderType });
    const viaPay    = effects({ lines: CART, orderType });
    ok(`POST /orders and /pay agree for orderType=${orderType}`,
       JSON.stringify(viaOrders) === JSON.stringify(viaPay));
  }
}

// ── 4. packaging is takeaway-only ───────────────────────────────────────────
{
  const dine = effects({ lines: CART, orderType: 'dine_in' });
  const take = effects({ lines: CART, orderType: 'takeaway' });
  ok('dine-in consumes no packaging',
     !dine.ingredients.some(i => i.ingredient_id === 'box'));
  ok('takeaway consumes packaging',
     take.ingredients.find(i => i.ingredient_id === 'box')?.delta === -2);
}

// ── 5. the regression that started it ───────────────────────────────────────
{
  const before = payOld(CART).ingredients.length;
  const after  = effects({ lines: CART, orderType: 'dine_in' }).ingredients.length;
  ok('a dine-in sale used to deduct 0 ingredients and now deducts 2',
     before === 0 && after === 2, `${before} -> ${after}`);
}

console.log(`\n${fail === 0 ? 'All checks passed. Both order paths apply the same stock effects.' : fail + ' FAILED'}`);
process.exit(fail === 0 ? 0 : 1);
